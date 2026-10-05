/**
 * The assets folder: the logo, the app icon and the energy icons are where the app and the build expect them.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ROOT } = require('../test-support/harness');
const GAME = require('../public/js/game-data');
const pkg = require('../package.json');

const ASSETS = path.join(ROOT, 'assets');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngSize = (buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

describe('the assets folder', () => {
  it('keeps the logo, the app icon and the README pictures together', () => {
    for (const file of ['logo.gif', 'logo.ico', 'README.md']) assert.ok(fs.existsSync(path.join(ASSETS, file)), file);
    assert.ok(fs.readdirSync(path.join(ASSETS, 'screenshots')).length >= 4, 'the pictures in the README');
    for (const old of ['logo.gif', 'logo.ico']) assert.equal(fs.existsSync(path.join(ROOT, old)), false, `${old} used to be at the project root`);
    assert.equal(fs.existsSync(path.join(ROOT, 'docs', 'images')), false, 'the screenshots moved to assets/screenshots');
  });

  it('has an icon for every energy type, and nothing else in that folder', () => {
    const files = fs.readdirSync(path.join(ASSETS, 'energy')).sort();
    assert.deepEqual(files, GAME.ENERGY_KEYS.map((key) => `${key}.png`).sort());
    for (const file of files) {
      const buffer = fs.readFileSync(path.join(ASSETS, 'energy', file));
      assert.deepEqual(buffer.subarray(0, 8), PNG_SIGNATURE, `${file} is a PNG`);
      assert.deepEqual(pngSize(buffer), { width: 30, height: 30 }, `${file} is 30 x 30`);
      assert.ok(buffer.length < 20 * 1024, `${file} is small`);
    }
  });

  it('tells the overlay and the control panel where each icon is served from', () => {
    for (const type of GAME.ENERGY_TYPES) assert.equal(type.icon, `/assets/energy/${type.key}.png`);
    assert.equal(new Set(GAME.ENERGY_TYPES.map((type) => type.icon)).size, GAME.ENERGY_TYPES.length);
  });

  it('is packaged into the app and used for the app icon, but the README pictures are not', () => {
    const files = pkg.build.files;
    for (const entry of ['assets/logo.ico', 'assets/logo.gif', 'assets/energy/**/*']) assert.ok(files.includes(entry), entry);
    assert.ok(!files.some((entry) => entry.includes('screenshots')), 'screenshots stay out of the installer');
    assert.ok(!files.includes('logo.ico') && !files.includes('logo.gif'), 'no entry for the old place');
    assert.equal(pkg.build.win.icon, 'assets/logo.ico');
    for (const association of pkg.build.fileAssociations) assert.equal(association.icon, 'assets/logo.ico');
    for (const entry of [pkg.build.win.icon, ...pkg.build.fileAssociations.map((a) => a.icon)]) assert.ok(fs.existsSync(path.join(ROOT, entry)), entry);
  });

  it('names its rights in the notice', () => {
    const notice = fs.readFileSync(path.join(ROOT, 'NOTICE.md'), 'utf8');
    assert.match(notice, /assets\/energy/);
    assert.match(notice, /not covered by the MIT license/);
    assert.match(fs.readFileSync(path.join(ASSETS, 'README.md'), 'utf8'), /not part of that license/);
  });
});

describe('serving the assets', () => {
  let server;
  before(async () => { server = await startServer({ label: 'assets' }); });
  after(async () => { if (server) await server.stop(); });
  const get = (route) => fetch(`${server.base}${route}`);

  it('serves the logo and the tab icon, also under the name browsers ask for', async () => {
    const gif = await get('/logo.gif');
    assert.equal(gif.status, 200);
    assert.equal(gif.headers.get('content-type'), 'image/gif');
    assert.deepEqual(Buffer.from(await gif.arrayBuffer()), fs.readFileSync(path.join(ASSETS, 'logo.gif')));

    for (const route of ['/logo.ico', '/favicon.ico']) {
      const icon = await get(route);
      assert.equal(icon.status, 200, route);
      assert.match(icon.headers.get('content-type'), /icon/, route);
      assert.deepEqual(Buffer.from(await icon.arrayBuffer()), fs.readFileSync(path.join(ASSETS, 'logo.ico')));
    }
  });

  it('serves every energy icon', async () => {
    for (const type of GAME.ENERGY_TYPES) {
      const response = await get(type.icon);
      assert.equal(response.status, 200, type.icon);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(ASSETS, 'energy', `${type.key}.png`)));
    }
  });

  it('serves nothing else from the folder, and no folder listing', async () => {
    for (const route of ['/assets/energy/none.png', '/assets/energy/', '/assets/energy', '/assets/logo.gif', '/assets/README.md', '/assets/screenshots/overlay.png', '/assets/energy/../logo.gif', '/assets/energy/%2e%2e/logo.gif']) {
      const response = await get(route);
      assert.equal(response.status, 404, route);
    }
  });

  it('shows the icon in the tab of every page', async () => {
    for (const route of ['/control', '/overlay']) {
      const html = await (await get(route)).text();
      assert.match(html, /<link rel="icon" type="image\/x-icon" href="\/logo\.ico">/, route);
    }
    // the sign-in page is only reachable when a password is set, so read its file
    assert.match(fs.readFileSync(path.join(ROOT, 'public', 'login', 'index.html'), 'utf8'), /<link rel="icon" type="image\/x-icon" href="\/logo\.ico">/);
  });
});
