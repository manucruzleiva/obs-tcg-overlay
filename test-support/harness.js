/**
 * Test harness: boots the real server with a throwaway database and gives tests socket clients
 * that remember what they were sent.
 *
 * Lives outside test/ because Node's test runner would execute every file inside it.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, '.local', 'test');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A route function can answer with something other than 200: return respond(500, body, { 'Retry-After': '1' })
const respond = (status, body = {}, headers = {}) => ({ __response: true, status, body, headers });

// A stand-in for the card API. `routes` maps a path prefix to a JSON body or a function (url) => body.
// It records every request URL (`requests`) and its headers (`headers`).
async function startMockCardApi(routes = {}) {
  const requests = [];
  const headers = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    headers.push(req.headers);
    const match = Object.keys(routes).find((prefix) => req.url.startsWith(prefix));
    if (!match) {
      res.statusCode = 404;
      return res.end('{}');
    }
    const answer = typeof routes[match] === 'function' ? routes[match](req.url) : routes[match];
    res.setHeader('Content-Type', 'application/json');
    if (answer && answer.__response) {
      res.statusCode = answer.status;
      for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
      return res.end(JSON.stringify(answer.body));
    }
    res.end(JSON.stringify(answer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    headers,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
}

class Client {
  constructor(base, { clientId, name, role = 'control', cookie } = {}) {
    this.seq = 0;
    this.state = null;
    this.events = {};
    this.watchers = new Set();

    this.socket = io(base, {
      transports: ['websocket'],
      auth: { role, clientId, name },
      extraHeaders: cookie ? { cookie } : undefined,
      reconnection: false
    });

    for (const event of [
      'state:full', 'state:update', 'action:applied', 'action:rejected', 'announce', 'presence', 'activity',
      'activity:history', 'you', 'draft:state', 'draft:sent', 'draft:conflicts', 'theme:changed',
      'sfx', 'sounds:changed', 'catalog:progress'
    ]) {
      this.socket.on(event, (data) => this.record(event, data));
    }
  }

  record(event, data) {
    (this.events[event] ||= []).push(data);
    if (event === 'state:full' || event === 'state:update') this.state = data;
    for (const watcher of [...this.watchers]) {
      if (watcher.event === event && watcher.predicate(data)) watcher.handler(data);
    }
  }

  // Call handler for each matching event until the returned function is called
  watch(event, predicate, handler) {
    const watcher = { event, predicate, handler };
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  // Resolves with the next matching event (register this BEFORE doing what causes it)
  expect(event, predicate = () => true, ms = 3000) {
    return new Promise((resolve, reject) => {
      const stop = this.watch(event, predicate, (data) => {
        stop();
        clearTimeout(timer);
        resolve(data);
      });
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`timed out waiting for "${event}"`));
      }, ms);
    });
  }

  async ready() {
    if (this.state) return this;
    await this.expect('state:full');
    return this;
  }

  get revision() {
    return this.state.revision;
  }

  // Wait for the server's answer to the action with this sequence number: applied, or rejected
  answerTo(seq, ms = 3000) {
    return new Promise((resolve, reject) => {
      const stops = [];
      const finish = (value) => {
        stops.forEach((stop) => stop());
        clearTimeout(timer);
        resolve(value);
      };
      stops.push(this.watch('action:applied', (a) => a.seq === seq, (applied) => finish({ ok: true, applied, state: this.state })));
      stops.push(this.watch('action:rejected', (r) => r.seq === seq, (rejected) => finish({ ok: false, rejected })));
      const timer = setTimeout(() => {
        stops.forEach((stop) => stop());
        reject(new Error(`no answer to action #${seq}`));
      }, ms);
    });
  }

  // Send an action the way the control panel does (with the revision it last saw and a sequence number)
  // and report the answer: { ok: true, state } or { ok: false, rejected }.
  async act(event, payload, { baseRevision = this.revision, seq = ++this.seq } = {}) {
    const answer = this.answerTo(seq);
    this.socket.emit(event, { ...payload, meta: { baseRevision, seq } });
    return answer;
  }

  // Send an action into this producer's draft; resolves with the draft as the server now has it
  async draftAct(event, payload) {
    const seq = ++this.seq;
    const answer = Promise.race([
      this.expect('draft:state', (d) => d.ack === seq).then((draft) => ({ ok: true, draft })),
      this.answerTo(seq).then((result) => (result.ok ? new Promise(() => {}) : result))
    ]);
    this.socket.emit(event, { ...payload, meta: { draft: true, baseRevision: this.revision, seq } });
    return answer;
  }

  // Emit something that is not expected to produce a response
  emit(event, payload) {
    this.socket.emit(event, payload);
  }

  last(event) {
    const list = this.events[event] || [];
    return list[list.length - 1];
  }

  close() {
    this.socket.close();
  }
}

// `prepare(dir)` runs before the server starts, to put files in its data folder (a design from an older version, say)
async function startServer({ env = {}, label = 'srv', prepare } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, `${label}-`));
  if (prepare) prepare(dir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: path.join(dir, 'overlay.sqlite'),
      LOG_DIR: path.join(dir, 'logs'),
      // Never reach the real card API from a test (a refused connection fails fast)
      POKEMONTCG_API_URL: 'http://127.0.0.1:9',
      OTO_PASSWORD: '',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}):\n${logs}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${logs}`);
    await wait(100);
  }

  const clients = [];
  return {
    base,
    port,
    dir,
    logs: () => logs,

    // Open a socket client; `await client.ready()` before using it
    client(options) {
      const client = new Client(base, options);
      clients.push(client);
      return client;
    },

    async stop() {
      for (const client of clients) client.close();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

// A stand-in for the card image host: serves a tiny PNG for /<set>/<file>, and records what was asked.
// `behave(url)` may return respond(...) to answer differently (a 404, a wrong content type).
async function startMockImageHost(behave = () => null) {
  const requests = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const special = behave(req.url);
    if (special && special.__response) {
      res.statusCode = special.status;
      for (const [name, value] of Object.entries(special.headers)) res.setHeader(name, value);
      return res.end(special.body);
    }
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    png,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
}

module.exports = { startServer, startMockCardApi, startMockImageHost, respond, wait, ROOT };
