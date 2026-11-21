// The handshake with the Tauri desktop app (src-tauri): an OTO_READY line once listening, the password set from the tray,
// and "quit" on stdin saves and exits
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, wait } = require('../support/harness');

const lineOf = async (srv, kind, after = 0) => {
  let line;
  while (!(line = srv.logs().slice(after).split('\n').find((l) => l.startsWith(`OTO_${kind} `)))) await wait(50);
  return JSON.parse(line.slice(`OTO_${kind} `.length));
};

test('the server says it is ready, sets the password it is sent, and saves the database on "quit"', { timeout: 30000 }, async () => {
  const srv = await startServer({ label: 'desktop-child', env: { OTO_DESKTOP_CHILD: '1', HOST: '0.0.0.0' }, stdin: 'pipe' });
  try {
    const ready = await lineOf(srv, 'READY');
    assert.ok(Array.isArray(ready.lan));
    assert.deepStrictEqual(ready.password, { enabled: false, source: null });
    for (const link of ready.lan) assert.match(link.control, new RegExp(`:${srv.port}/control$`));

    let seen = srv.logs().length;
    srv.child.stdin.write(`${JSON.stringify({ password: 'a secret' })}\n`);
    assert.deepStrictEqual(await lineOf(srv, 'PASSWORD', seen), { enabled: true, source: 'stored', error: null });
    assert.strictEqual((await fetch(`${srv.base}/api/network`)).status, 401, 'the control panel now asks for it');
    seen = srv.logs().length;
    srv.child.stdin.write(`${JSON.stringify({ password: '' })}\n`);
    assert.strictEqual((await lineOf(srv, 'PASSWORD', seen)).enabled, false);

    const dbPath = path.join(srv.dir, 'overlay.sqlite');
    fs.rmSync(dbPath, { force: true });
    const exited = new Promise((resolve) => srv.child.once('exit', resolve));
    srv.child.stdin.write('quit\n');
    assert.strictEqual(await exited, 0);
    assert.ok(fs.existsSync(dbPath), 'the database was saved on quit');
  } finally {
    await srv.stop();
  }
});
