/**
 * The installer hooks (src-tauri/windows/hooks.nsh) cannot be run here (they would change this computer), so what must never go wrong is
 * checked in the text: only OTO's own two folders are ever deleted, only when it was asked for, never in an update, and moving off the
 * Electron app never deletes what OTO saved.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../support/harness');

const script = fs.readFileSync(path.join(ROOT, 'src-tauri', 'windows', 'hooks.nsh'), 'utf8');
const code = script.split(/\r?\n/).filter((line) => !line.trim().startsWith(';'));
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));

describe('the installer hooks', () => {
  it('are the hooks of the Tauri installer, which installs for the current user', () => {
    assert.equal(conf.bundle.windows.nsis.installerHooks, 'windows/hooks.nsh');
    assert.equal(conf.bundle.windows.nsis.installMode, 'currentUser');
    for (const hook of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_PREUNINSTALL', 'NSIS_HOOK_POSTUNINSTALL']) assert.ok(code.some((line) => line.trim() === `!macro ${hook}`), hook);
  });

  it('deletes only two folders, OTO\'s data in AppData and the downloads of the updater, and nowhere else', () => {
    const deletions = code.filter((line) => /\bRMDir\s+\/r\b/i.test(line)).map((line) => line.trim());
    assert.deepEqual(deletions, ['RMDir /r "$APPDATA\\obs-tcg-overlay"', 'RMDir /r "$LOCALAPPDATA\\obs-tcg-overlay-updater"']);
    assert.ok(!code.some((line) => /\bDelete\b.*\*/.test(line)), 'nothing deletes files by a wildcard');
  });

  it('deletes them only in the uninstaller, when asked (the checkbox or --destroy), and never in an update', () => {
    const post = script.slice(script.indexOf('!macro NSIS_HOOK_POSTUNINSTALL'));
    const guard = post.indexOf('${AndIf} $UpdateMode <> 1');
    assert.ok(guard !== -1 && guard < post.indexOf('RMDir /r'), 'an update never deletes');
    assert.ok(post.includes('$DeleteAppDataCheckboxState') && post.includes('"--destroy"'));
    assert.equal(script.indexOf('RMDir /r'), script.indexOf('RMDir /r', script.indexOf('!macro NSIS_HOOK_POSTUNINSTALL')), 'no deletion before the uninstaller hook');
  });

  it('removes the Electron app silently (which keeps the data) before it makes its own shortcuts, and closes OTO politely first', () => {
    const removal = code.find((line) => line.includes('Uninstall OTO.exe') && line.includes('ExecWait'));
    assert.match(removal, /\/S\b/);
    assert.doesNotMatch(removal, /--destroy/);
    const pre = script.slice(script.indexOf('!macro NSIS_HOOK_PREINSTALL'), script.indexOf('!macroend', script.indexOf('!macro NSIS_HOOK_PREINSTALL')));
    assert.ok(pre.includes('OTO_REMOVE_ELECTRON_APP') && pre.includes('OTO_CLOSE_APP'));
    assert.ok(code.some((line) => line.includes('--quit')), 'asks OTO to save and quit');
  });
});
