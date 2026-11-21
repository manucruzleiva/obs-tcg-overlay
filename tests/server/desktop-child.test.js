// The handshake with the Tauri desktop app (src-tauri): an OTO_READY line once listening, and "quit" on stdin saves and exits
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the server says it is ready and saves the database on "quit"', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oto-desktop-child-'));
  const dbPath = path.join(dir, 'overlay.sqlite');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
    env: { ...process.env, OTO_DESKTOP_CHILD: '1', PORT: String(port), LOG_DIR: dir, DB_PATH: dbPath, OTO_DEFAULT_DESIGN: '0' },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  try {
    const ready = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const line = out.split('\n').find((l) => l.startsWith('OTO_READY '));
        if (line) resolve(JSON.parse(line.slice('OTO_READY '.length)));
      });
      child.on('exit', (code) => reject(new Error(`exited early (${code})`)));
    });
    assert.ok(Array.isArray(ready.lan));
    for (const link of ready.lan) assert.match(link.control, new RegExp(`:${port}/control$`));

    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.stdin.write('quit\n');
    assert.strictEqual(await exited, 0);
    assert.ok(fs.existsSync(dbPath), 'the database was saved');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
