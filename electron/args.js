/**
 * What OTO reads from its command line. Kept apart from main.js so it can be tested without Electron.
 *
 * `argv` is a process.argv: the program first, then what was typed or double-clicked.
 */

const RELAUNCHED = '--relaunched';

// OTO.exe --quit asks a running copy to save everything and quit (the installer does this)
const wantsQuit = (argv) => argv.slice(1).includes('--quit');

// The .oto file named on a command line (a double-click in the file manager starts "OTO.exe file.oto")
const packageIn = (argv) => argv.slice(1).find((arg) => !arg.startsWith('-') && /\.oto$/i.test(arg));

// What a restarted copy is started with: the same command line, except that a .oto file already dealt with
// is not offered again, plus a note that it is a restart
const relaunchArgs = (argv) => [...argv.slice(1).filter((arg) => arg !== RELAUNCHED && !/\.oto$/i.test(arg)), RELAUNCHED];

const isRestart = (argv) => argv.includes(RELAUNCHED);

module.exports = { RELAUNCHED, wantsQuit, packageIn, relaunchArgs, isRestart };
