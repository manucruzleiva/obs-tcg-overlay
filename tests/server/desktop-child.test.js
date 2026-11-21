// The handshake with the Tauri desktop app (src-tauri): an OTO_READY line once listening, and "quit" on stdin saves and exits
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, wait } = require('../support/harness');

test('the server says it is ready and saves the database on "quit"', { timeout: 30000 }, async () => {
  const srv = await startServer({ label: 'desktop-child', env: { OTO_DESKTOP_CHILD: '1', HOST: '0.0.0.0' }, stdin: 'pipe' });
  try {
    let line;
    while (!(line = srv.logs().split('\n').find((l) => l.startsWith('OTO_READY ')))) await wait(50);
    const ready = JSON.parse(line.slice('OTO_READY '.length));
    assert.ok(Array.isArray(ready.lan));
    for (const link of ready.lan) assert.match(link.control, new RegExp(`:${srv.port}/control$`));

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
