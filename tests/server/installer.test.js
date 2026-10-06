/**
 * The installer script (installer/installer.nsh) cannot be run here (it would change this computer), so what must never go wrong is checked in the
 * text: Destroy deletes OTO's own folders and nothing else, only when it was asked for, and an update never deletes anything.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../support/harness');

const script = fs.readFileSync(path.join(ROOT, 'installer', 'installer.nsh'), 'utf8');
const lines = script.split(/\r?\n/);
const code = lines.filter((line) => !line.trim().startsWith(';'));

describe('the installer script', () => {
  it('has a page for an existing installation with Repair, Reinstall from scratch, Uninstall and Destroy', () => {
    for (const label of ['Repair', 'Reinstall from scratch', 'Uninstall', 'Destroy']) {
      assert.ok(code.some((line) => line.includes(`CreateRadioButton`) && line.includes(`"${label}"`)), label);
    }
    assert.ok(code.some((line) => line.includes('Var OtoDestroy')));
  });

  it('deletes only two folders, OTO\'s data in AppData and the downloads of the updater, and nowhere else', () => {
    const deletions = code.filter((line) => /\bRMDir\s+\/r\b/i.test(line)).map((line) => line.trim());
    assert.deepEqual(deletions, ['RMDir /r "$0\\obs-tcg-overlay"', 'RMDir /r "$0\\obs-tcg-overlay-updater"']);
    // each one is of a folder named inside an environment variable that is read just above it, never of the folder of the program or a drive
    assert.ok(code.some((line) => line.trim() === 'ReadEnvStr $0 APPDATA'));
    assert.ok(code.some((line) => line.trim() === 'ReadEnvStr $0 LOCALAPPDATA'));
    // nothing deletes files by a wildcard
    assert.equal(code.filter((line) => /\bDelete\b.*\*/.test(line)).length, 0);
  });

  it('is only done by a function that exists for the installer and for the uninstaller, and is only called after being asked for', () => {
    assert.match(script, /Function un\.OtoDestroyData/);
    assert.match(script, /Function OtoDestroyData/);
    const calls = code.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => /^Call (un\.)?OtoDestroyData$/.test(line));
    assert.equal(calls.length, 3, 'the Destroy choice (twice, it also covers a missing uninstaller) and the uninstaller');
  });

  it('asks before the Destroy choice does anything, with No as the answer it starts with', () => {
    const asks = code.filter((line) => line.includes('MessageBox') && line.includes('Destroy OTO?'));
    assert.equal(asks.length, 1);
    assert.match(asks[0], /MB_YESNO\|MB_ICONEXCLAMATION\|MB_DEFBUTTON2/);
    assert.match(asks[0], /This cannot be undone/);
  });

  it('has an uninstaller that deletes with --destroy, asks (and starts with No) when a person runs it, and never in an update or a silent run', () => {
    const start = code.findIndex((line) => line.includes('!macro customUnInstall'));
    const end = code.findIndex((line, index) => index > start && line.includes('!macroend'));
    const body = code.slice(start, end).join('\n');
    assert.match(body, /\$\{GetOptions\} \$R8 "--destroy"/);
    assert.match(body, /\$\{ElseIfNot\} \$\{Silent\}/, 'a silent run never asks and never deletes');
    assert.match(body, /\$\{IfNot\} \$\{isUpdated\}/, 'and neither does an update');
    assert.match(body, /MB_YESNO\|MB_ICONQUESTION\|MB_DEFBUTTON2/);
    assert.match(body, /IDNO oto_keep_data/);
  });

  it('still closes OTO the polite way before it removes anything, and still moves the data aside for a fresh start instead of deleting it', () => {
    assert.match(script, /--quit/);
    assert.match(script, /Rename "\$0\\data" "\$1"/);
    assert.doesNotMatch(code.join('\n'), /RMDir \/r "\$0\\data"/);
  });
});
