/**
 * Telling OTO apart from another program that answers on the same port.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { checkPort } = require('../src/services/port-check');
const { startServer } = require('../test-support/harness');

// A stand-in program that answers whatever it is told to, on a port of its own
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) }));
  });
}

describe('the port check', () => {
  const open = [];
  after(async () => { for (const entry of open) await entry.close(); });
  const stand = async (handler) => { const entry = await listen(handler); open.push(entry); return entry; };

  it('is happy when the answer is this very server', async () => {
    const us = await stand((req, res) => res.end(JSON.stringify({ status: 'ok', instance: 'abc123' })));
    assert.deepEqual(await checkPort({ port: us.port, host: '0.0.0.0', instanceId: 'abc123' }), { ok: true });
  });

  it('notices another OTO, or any program that answers health with something else', async () => {
    const other = await stand((req, res) => res.end(JSON.stringify({ status: 'ok', instance: 'someone-else' })));
    const old = await stand((req, res) => res.end(JSON.stringify({ status: 'ok' })));
    const page = await stand((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>hello</html>'); });
    for (const program of [other, old, page]) {
      const result = await checkPort({ port: program.port, host: '127.0.0.1', instanceId: 'abc123' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'other');
      assert.match(result.message, new RegExp(`port ${program.port}`));
      assert.match(result.message, /Close that program, or start OTO on another port/);
    }
  });

  it('says nothing about who owns the port when nobody answers', async () => {
    const result = await checkPort({ port: 9, host: '127.0.0.1', instanceId: 'abc123', timeoutMs: 800 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreachable');
  });

  it('asks the loopback address when the server listens on every interface, and its own address otherwise', async () => {
    const asked = [];
    const record = async (url) => { asked.push(url); return { json: async () => ({ status: 'ok', instance: 'x' }) }; };
    await checkPort({ port: 6767, host: '0.0.0.0', instanceId: 'x', fetchImpl: record });
    await checkPort({ port: 6767, host: '::', instanceId: 'x', fetchImpl: record });
    await checkPort({ port: 6767, host: undefined, instanceId: 'x', fetchImpl: record });
    await checkPort({ port: 6767, host: '192.168.1.20', instanceId: 'x', fetchImpl: record });
    assert.deepEqual(asked, ['http://127.0.0.1:6767/api/health', 'http://127.0.0.1:6767/api/health', 'http://127.0.0.1:6767/api/health', 'http://192.168.1.20:6767/api/health']);
  });
});

describe('the real server', () => {
  let server;
  before(async () => { server = await startServer({ label: 'portcheck' }); });
  after(async () => { if (server) await server.stop(); });

  it('answers health with an id that is its own, and the same id every time', async () => {
    const first = await (await fetch(`${server.base}/api/health`)).json();
    const second = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(first.status, 'ok');
    assert.match(first.instance, /^[0-9a-f]{16}$/);
    assert.equal(first.instance, second.instance);
  });

  it('passes the check against itself', async () => {
    const { instance } = await (await fetch(`${server.base}/api/health`)).json();
    assert.deepEqual(await checkPort({ port: server.port, host: '127.0.0.1', instanceId: instance }), { ok: true });
    assert.equal((await checkPort({ port: server.port, host: '127.0.0.1', instanceId: 'not-this-one' })).reason, 'other');
  });

  it('does not log a port warning when nothing is in the way', () => {
    assert.doesNotMatch(server.logs(), /Port check/);
  });
});
