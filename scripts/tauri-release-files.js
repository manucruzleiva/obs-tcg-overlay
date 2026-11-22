// After "tauri build": puts the release files in dist/ with the names OTO always used, and writes the two update feeds.
//   dist/OTO-Setup-<version>.exe       the installer
//   dist/OTO-<version>-portable.exe    one OTO.exe that carries Node and the server and unpacks them once (no updates)
//   dist/latest.json                   the feed of the Tauri updater (needs the .sig the build makes with the updater key)
//   dist/latest.yml                    the feed of electron-updater: Electron installs of OTO find this release and install it,
//                                      and the Tauri installer then removes the Electron app (src-tauri/windows/hooks.nsh)
// Usage, after "tauri build":
//   node scripts/tauri-release-files.js payload   zips node.exe and the server into src-tauri/target/portable-payload.zip,
//                                                 for the portable build (cargo feature "portable", OTO_PAYLOAD=that zip,
//                                                 CARGO_TARGET_DIR=src-tauri/target-portable)
//   node scripts/tauri-release-files.js           then puts the release files in dist/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const { version, repository } = require(path.join(root, 'package.json'));
const repo = repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1];
const release = path.join(root, 'src-tauri', 'target', 'release');
const dist = path.join(root, 'dist');

function releaseFiles({ version, repo, setup, signature, releaseDate = new Date().toISOString() }) {
  const name = `OTO-Setup-${version}.exe`;
  const sha512 = crypto.createHash('sha512').update(setup).digest('base64');
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${setup.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n');
  const json = signature === undefined ? null : {
    version,
    pub_date: releaseDate,
    platforms: { 'windows-x86_64': { signature, url: `https://github.com/${repo}/releases/download/v${version}/${name}` } }
  };
  return { name, yml, json };
}

if (require.main === module && process.argv[2] === 'payload') {
  // Windows' tar writes a zip when the name ends in .zip
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', path.join(root, 'src-tauri', 'target', 'portable-payload.zip'), '-C', release, 'node.exe', 'server'], { stdio: 'inherit' });
} else if (require.main === module) {
  const nsis = path.join(release, 'bundle', 'nsis');
  const setupFile = fs.readdirSync(nsis).find((f) => f.endsWith('-setup.exe'));
  if (!setupFile) throw new Error(`No installer in ${nsis}`);
  const setup = fs.readFileSync(path.join(nsis, setupFile));
  const sigFile = path.join(nsis, `${setupFile}.sig`);
  const signature = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8').trim() : undefined;
  const files = releaseFiles({ version, repo, setup, signature });

  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, files.name), setup);
  fs.writeFileSync(path.join(dist, 'latest.yml'), files.yml);
  if (files.json) fs.writeFileSync(path.join(dist, 'latest.json'), `${JSON.stringify(files.json, null, 2)}\n`);
  else console.warn('No updater signature (.sig): the build had no updater key, so latest.json was not written');

  fs.copyFileSync(path.join(root, 'src-tauri', 'target-portable', 'release', 'OTO.exe'), path.join(dist, `OTO-${version}-portable.exe`));
  console.log(fs.readdirSync(dist).join('\n'));
}

module.exports = { releaseFiles };
