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

// The same files the Electron build ships (package.json "build.files"), minus electron/
const files = require(path.join(root, 'package.json')).build.files.filter((f) => !f.startsWith('electron/'));
const tops = [...new Set(files.map((f) => f.split('/')[0]))];

fs.rmSync(server, { recursive: true, force: true });
fs.mkdirSync(server, { recursive: true });
for (const top of [...tops, 'package-lock.json']) {
  const from = path.join(root, top);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(server, top), { recursive: true });
}
// assets/screenshots and the like are not shipped by the Electron build either
for (const extra of ['assets/screenshots', 'assets/README.md']) fs.rmSync(path.join(server, extra), { recursive: true, force: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: server, stdio: 'inherit', shell: process.platform === 'win32' });

const target = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)[1].trim();
fs.mkdirSync(binaries, { recursive: true });
const ext = process.platform === 'win32' ? '.exe' : '';
fs.copyFileSync(process.execPath, path.join(binaries, `node-${target}${ext}`));
console.log(`Staged the server in ${server} and Node ${process.version} as binaries/node-${target}${ext}`);
