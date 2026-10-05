const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RELAUNCHED, wantsQuit, packageIn, relaunchArgs, isRestart } = require('../electron/args');

// A command line as the desktop app sees it: the program, then what was typed or double-clicked
const line = (...args) => ['C:\\Program Files\\OTO\\OTO.exe', ...args];

describe('the desktop app command line', () => {
  it('finds a .oto file that was opened with the app', () => {
    assert.equal(packageIn(line('C:\\Users\\me\\Neon Night.oto')), 'C:\\Users\\me\\Neon Night.oto');
    assert.equal(packageIn(line('--user-data-dir=x', 'D:\\shared\\show.OTO')), 'D:\\shared\\show.OTO', 'any capitals');
    assert.equal(packageIn(line()), undefined);
  });

  it('is not fooled by other arguments', () => {
    for (const arg of ['--quit', '--relaunched', '--oto', 'photo', 'neon.otox', 'neon.oto.exe', 'xoto', '-neon.oto', '--file=a.oto']) {
      assert.equal(packageIn(line(arg)), undefined, arg);
    }
    assert.equal(packageIn(['C:\\something.oto']), undefined, 'the first item is the program, not a file to open');
  });

  it('knows when it is only being asked to quit', () => {
    assert.equal(wantsQuit(line('--quit')), true);
    assert.equal(wantsQuit(line('x.oto', '--quit')), true);
    assert.equal(wantsQuit(line()), false);
    assert.equal(wantsQuit(line('--quiet', 'quit')), false);
    assert.equal(wantsQuit(['--quit']), false, 'the first item is the program');
  });

  it('starts a restarted copy with the same command line, without a file it already dealt with', () => {
    assert.deepEqual(relaunchArgs(line()), [RELAUNCHED]);
    assert.deepEqual(relaunchArgs(line('--user-data-dir=x', 'neon.oto', '--other')), ['--user-data-dir=x', '--other', RELAUNCHED]);
    assert.deepEqual(relaunchArgs(line('a.oto', 'B.OTO')), [RELAUNCHED]);
  });

  it('does not pile up restart notes when it restarts again', () => {
    const once = relaunchArgs(line('x'));
    const twice = relaunchArgs(line(...once));
    assert.deepEqual(twice, ['x', RELAUNCHED]);
    assert.equal(isRestart(line(...once)), true);
    assert.equal(isRestart(line('x')), false);
  });
});
