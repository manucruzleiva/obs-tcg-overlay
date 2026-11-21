// The update feeds the release writes next to the Tauri installer (scripts/tauri-release-files.js)
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { releaseFiles } = require('../../scripts/tauri-release-files');

test('latest.yml lets electron-updater install the Tauri installer, latest.json points the Tauri updater at it', () => {
  const setup = Buffer.from('an installer');
  const sha512 = crypto.createHash('sha512').update(setup).digest('base64');
  const files = releaseFiles({ version: '2.0.0', repo: 'owner/repo', setup, signature: 'sig', releaseDate: '2026-11-21T00:00:00.000Z' });
  assert.strictEqual(files.name, 'OTO-Setup-2.0.0.exe');
  assert.strictEqual(files.yml, `version: 2.0.0\nfiles:\n  - url: OTO-Setup-2.0.0.exe\n    sha512: ${sha512}\n    size: 12\npath: OTO-Setup-2.0.0.exe\nsha512: ${sha512}\nreleaseDate: '2026-11-21T00:00:00.000Z'\n`);
  assert.deepStrictEqual(files.json.platforms['windows-x86_64'], { signature: 'sig', url: 'https://github.com/owner/repo/releases/download/v2.0.0/OTO-Setup-2.0.0.exe' });
  assert.strictEqual(releaseFiles({ version: '2.0.0', repo: 'owner/repo', setup }).json, null, 'no feed without the updater signature');
});
