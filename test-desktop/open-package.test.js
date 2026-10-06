/**
 * The desktop app, for real: a .oto file given on the command line (which is what a double-click in
 * the file manager does) opens OTO and offers to install it, whether OTO was closed or already running.
 * Run with: npm run test:desktop
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { createZip } = require('../src/services/zip');
const S = require('../test-support/samples');
const { ROOT, wait } = require('../test-support/harness');

let electronPath = null;
try { electronPath = require('electron'); } catch { /* not installed */ }
const skip = typeof electronPath === 'string' && fs.existsSync(electronPath) ? false : 'the Electron binary is not installed (run npm install without --ignore-scripts)';

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

const designPackage = (name, accent) => createZip([
  { name: 'design.json', data: Buffer.from(JSON.stringify({ name, author: 'Mina', colors: { '--accent': accent } })) },
  { name: 'images/logoImage.png', data: S.PNG },
  { name: 'controls.json', data: Buffer.from(JSON.stringify({ settings: { toastSeconds: 7 } })) }
]);

describe('desktop app', { skip }, () => {
  let dir;
  let port;
  let env;
  let app;
  let window;

  const api = async (route) => (await fetch(`http://127.0.0.1:${port}${route}`)).json();

  before(async () => {
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'desktop-'));
    port = await freePort();
    // The shell that runs the tests may have ELECTRON_RUN_AS_NODE set (VS Code does): Electron would then start as plain Node
    env = { ...process.env, OTO_DATA_DIR: path.join(dir, 'data'), OTO_PORT: String(port), OBS_TCG_DISABLE_UPDATES: '1', OTO_TEST_HOOKS: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
  });

  after(async () => {
    if (app) await app.close().catch(() => {});
    // a copy that restarted itself (the reset does) is not the one Playwright holds: ask it to quit too,
    // so a failing run leaves nothing behind. With nothing running this ends at once.
    await new Promise((resolve) => spawn(electronPath, [path.join(ROOT, 'electron', 'main.js'), '--quit'], { env, stdio: 'ignore' }).once('exit', resolve));
    await wait(1500);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  });

  it('starts with a .oto file and offers to install it', async () => {
    const file = path.join(dir, 'neon-night.oto');
    fs.writeFileSync(file, designPackage('Neon Night', '#ff00aa'));

    app = await _electron.launch({ executablePath: electronPath, args: [path.join(ROOT, 'electron', 'main.js'), file], env });
    window = await app.firstWindow();
    const dialog = window.locator('.modal[aria-label="Install \\"Neon Night\\""]');
    await dialog.waitFor({ timeout: 30000 });
    assert.match(await dialog.textContent(), /by Mina/);

    await dialog.locator('button', { hasText: 'Install' }).click();
    await window.locator('.toast-success', { hasText: 'Installed' }).waitFor();

    const themes = await api('/api/themes');
    assert.deepEqual(themes, { active: 'Neon Night', names: ['Neon Night'] });
    assert.equal((await api('/api/state')).settings.toastSeconds, 7);
  });

  it('opens a second .oto file in the copy that is already running', async () => {
    const file = path.join(dir, 'arena.oto');
    fs.writeFileSync(file, designPackage('Arena', '#00ccff'));

    // what a double-click does: starts another copy, which hands the file to the first and quits
    const second = spawn(electronPath, [path.join(ROOT, 'electron', 'main.js'), file], { env, stdio: 'ignore' });
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 20000);
      second.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    assert.equal(exited, true, 'the second copy quit by itself');

    const dialog = window.locator('.modal[aria-label="Install \\"Arena\\""]');
    await dialog.waitFor({ timeout: 15000 });
    await dialog.locator('button', { hasText: 'Install' }).click();
    await window.locator('.toast-success', { hasText: 'Installed "Arena"' }).waitFor();
    assert.deepEqual((await api('/api/themes')).names, ['Arena', 'Neon Night']);
  });

  it('says so when the file is not a package', async () => {
    const file = path.join(dir, 'broken.oto');
    fs.writeFileSync(file, 'this is not a package, only some words');
    const second = spawn(electronPath, [path.join(ROOT, 'electron', 'main.js'), file], { env, stdio: 'ignore' });
    await new Promise((resolve) => second.once('exit', resolve));
    await window.locator('.toast-error', { hasText: 'not a package file' }).waitFor({ timeout: 15000 });
    assert.deepEqual((await api('/api/themes')).names, ['Arena', 'Neon Night']);
  });

  it('keeps working while it tells you a file could not be opened', async () => {
    // a file that is not there: the app shows a message, and must not stop serving the overlay while it does
    const second = spawn(electronPath, [path.join(ROOT, 'electron', 'main.js'), path.join(dir, 'not-there.oto')], { env, stdio: 'ignore' });
    await new Promise((resolve) => second.once('exit', resolve));
    await wait(1500);
    const answer = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
    assert.equal(answer.status, 200, 'the service still answers');
    assert.equal((await api('/api/state')).trainerA.prizes.count, 6, 'and the game is still there');
  });

  it('lets the host set, change and remove the control panel password from the tray menu', async () => {
    const entries = () => app.evaluate(() => globalThis.otoMain.buildTrayMenu().items.find((item) => item.label === 'Control panel password').submenu.items.map((item) => ({ label: item.label, enabled: item.enabled })));
    const status = async () => (await api('/api/auth/status'));
    assert.deepEqual(await entries(), [
      { label: 'No password: anyone who opens the link can produce', enabled: false },
      { label: 'Set a password…', enabled: true },
      { label: 'Remove the password…', enabled: false }
    ]);
    assert.equal((await status()).required, false);

    // the small window asks twice, and says when they are not the same
    const opened = app.waitForEvent('window');
    await app.evaluate(() => globalThis.otoMain.openPasswordWindow());
    const small = await opened;
    await small.waitForSelector('#password');
    await small.fill('#password', 'let-me-in');
    await small.fill('#repeat', 'something else');
    await small.click('#save');
    await small.waitForFunction(() => document.getElementById('error').textContent.includes('not the same'));
    assert.equal((await status()).required, false, 'nothing was saved');
    await small.fill('#repeat', 'let-me-in');
    const closed = small.waitForEvent('close');
    await small.click('#save');
    await closed;
    assert.equal((await status()).required, true);
    assert.deepEqual((await entries()).map((entry) => [entry.label, entry.enabled]), [['A password is set', false], ['Change the password…', true], ['Remove the password…', true]]);

    // the control panel asks for it now (the page of the app is sent to the sign-in page)
    const refused = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(refused.status, 401, 'the API asks for it');
    await window.waitForSelector('input[type="password"]', { timeout: 15000 });

    // Escape leaves the small window and changes nothing
    const again = app.waitForEvent('window');
    await app.evaluate(() => globalThis.otoMain.openPasswordWindow());
    const second = await again;
    await second.waitForSelector('#password');
    const gone = second.waitForEvent('close');
    await second.keyboard.press('Escape').catch(() => {}); // (the window is gone before the key press is over)
    await gone;
    assert.equal((await status()).required, true);

    // removed from the menu, the control panel is open again
    assert.equal(await app.evaluate(() => globalThis.otoMain.removeControlPassword()), true);
    assert.equal((await status()).required, false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 200);
    await window.waitForSelector('.trainer-panel.side-a', { timeout: 20000 });
  });

  // what the installer does before it replaces the files
  const main = path.join(ROOT, 'electron', 'main.js');
  // ask, then wait until the service has really gone (a copy that started by itself has no handle to close)
  const stopCopy = async () => {
    await asksToQuit();
    for (let tries = 0; tries < 60; tries++) {
      try { await fetch(`http://127.0.0.1:${port}/api/health`); } catch { await wait(1000); return; }
      await wait(500);
    }
  };
  const asksToQuit = () => new Promise((resolve) => {
    const child = spawn(electronPath, [main, '--quit'], { env, stdio: 'ignore' });
    child.once('exit', resolve);
  });

  it('is asked to quit by "OTO --quit", saves the match first, and has it back on the next start', async () => {
    const changed = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toastSeconds: 9 }) });
    assert.equal(changed.status, 200);

    const closed = new Promise((resolve) => app.process().once('exit', resolve));
    await asksToQuit();
    const exitedBy = await Promise.race([closed.then(() => 'exited'), wait(20000).then(() => 'still running')]);
    assert.equal(exitedBy, 'exited', 'the running copy quit when asked');
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`), 'and the service stopped');

    // the autosave runs every 30 seconds, so the 9 can only be here if quitting saved it
    app = await _electron.launch({ executablePath: electronPath, args: [main], env });
    window = await app.firstWindow();
    await window.waitForSelector('.trainer-panel.side-a');
    assert.equal((await api('/api/state')).settings.toastSeconds, 9);
  });

  it('does not start up just to be told to quit when nothing is running', async () => {
    const closed = new Promise((resolve) => app.process().once('exit', resolve));
    await asksToQuit();
    await closed;
    await wait(500);

    const started = Date.now();
    await asksToQuit();
    assert.ok(Date.now() - started < 15000, 'it ended by itself');
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`), 'and started nothing');
    app = null;
  });

  it('has no File, Edit, View or Window menu bar, and F5 and Ctrl+R still reload the page', async () => {
    app = await _electron.launch({ executablePath: electronPath, args: [path.join(ROOT, 'electron', 'main.js')], env });
    try {
      window = await app.firstWindow();
      await window.waitForSelector('.trainer-panel.side-a');
      if (process.platform !== 'darwin') {
        assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()), null, 'no application menu');
        assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isMenuBarVisible())), false, 'and no menu bar in the window');
      }
      // the keys are looked at by the app before the page sees them: press them there. A marker on the page says whether it was loaded again.
      for (const input of [{ type: 'keyDown', key: 'F5' }, { type: 'keyDown', key: 'r', control: true }]) {
        await window.evaluate(() => { window.__notReloaded = true; });
        await app.evaluate(({ BrowserWindow }, pressed) => {
          const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
          win.webContents.emit('before-input-event', { preventDefault() {} }, pressed);
        }, input);
        await window.waitForFunction(() => window.__notReloaded === undefined, null, { timeout: 15000 });
        await window.waitForSelector('.trainer-panel.side-a');
      }
      // other keys are left alone
      await window.evaluate(() => { window.__notReloaded = true; });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'a' }));
      await wait(800);
      assert.equal(await window.evaluate(() => window.__notReloaded), true);
    } finally {
      await app.close().catch(() => {});
      app = null;
      await wait(1500);
    }
  });

  it('backs everything up and starts fresh instead of deleting it', async () => {
    app = await _electron.launch({ executablePath: electronPath, args: [main], env });
    window = await app.firstWindow();
    await window.waitForSelector('.trainer-panel.side-a');
    assert.deepEqual((await api('/api/themes')).names, ['Arena', 'Neon Night']);

    // answer the question as the person would ("Back up and start fresh"), and run what the tray menu runs
    await app.evaluate(({ dialog }, mainPath) => {
      dialog.showMessageBox = async () => ({ response: 0 });
      // the module is already loaded: this hands back the same one the app is running
      (typeof require === 'function' ? require : process.mainModule.require)(mainPath).backUpAndReset();
    }, main);
    // the old copy has gone, and a new one starts with nothing in it
    let fresh = null;
    for (let tries = 0; tries < 80 && !fresh; tries++) {
      await wait(500);
      try { const themes = await api('/api/themes'); if (themes.names.length === 0) fresh = themes; } catch { /* still starting */ }
    }
    assert.ok(fresh, 'OTO came back with empty data');
    assert.equal((await api('/api/state')).settings.toastSeconds, 2, 'the settings are back to the defaults too');

    // OTO_DATA_DIR is the app's own folder; inside it, "data" holds the match, designs and so on
    const userData = path.join(dir, 'data');
    const saved = path.join(userData, 'data-backup');
    assert.ok(fs.existsSync(path.join(saved, 'themes', 'arena', 'design.json')), 'the designs are in the backup folder');
    assert.ok(fs.existsSync(path.join(saved, 'themes', 'neon-night', 'images', 'logoImage.png')), 'with their pictures');
    assert.ok(fs.existsSync(path.join(saved, 'overlay.sqlite')), 'and so is the database');
    assert.equal(fs.existsSync(path.join(userData, 'data', 'themes', 'arena')), false, 'the fresh data has no designs');

    await stopCopy(); // the copy that started by itself
  });
});
