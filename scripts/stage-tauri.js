// Prepares src-tauri/ for "tauri build": copies the OTO server (with only its production packages) into
// src-tauri/server and this Node into src-tauri/binaries/node-<target>, which the Tauri app runs as its sidecar.
// Usage: node scripts/stage-tauri.js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const tauri = path.join(root, 'src-tauri');
const server = path.join(tauri, 'server');
const binaries = path.join(tauri, 'binaries');

// What the app ships next to the server (the Electron build shipped the same)
const shipped = [
  'src', 'public', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'NOTICE.md',
  'assets/logo.ico', 'assets/logo.gif', 'assets/energy', 'assets/status', 'assets/fonts', 'assets/cardbacks', 'assets/markers', 'assets/designs'
];

if (require.main === module) {
  fs.rmSync(server, { recursive: true, force: true });
  for (const entry of shipped) fs.cpSync(path.join(root, entry), path.join(server, entry), { recursive: true });

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: server, stdio: 'inherit', shell: process.platform === 'win32' });

  // sql.js ships ~30 MB of builds; the server loads only sql-asm.js (src/db/database.js)
  const sqlDist = path.join(server, 'node_modules', 'sql.js', 'dist');
  for (const file of fs.readdirSync(sqlDist)) if (file !== 'sql-asm.js') fs.rmSync(path.join(sqlDist, file));

  const target = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)[1].trim();
  fs.mkdirSync(binaries, { recursive: true });
  const ext = process.platform === 'win32' ? '.exe' : '';
  fs.copyFileSync(process.execPath, path.join(binaries, `node-${target}${ext}`));
  console.log(`Staged the server in ${server} and Node ${process.version} as binaries/node-${target}${ext}`);
}

module.exports = { shipped };
