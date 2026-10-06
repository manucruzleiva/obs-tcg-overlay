/**
 * The assets folder: the logo, the app icon and the energy icons are where the app and the build expect them.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ROOT } = require('../support/harness');
const GAME = require('../../public/js/game-data');
const THEME = require('../../public/js/theme-options');
const pkg = require('../../package.json');

const ASSETS = path.join(ROOT, 'assets');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngSize = (buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

// The kind of picture a file is, from what it starts with, and how big it is (PNG, JPEG or WebP)
function pictureOf(buffer) {
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { type: 'png', ...pngSize(buffer) };
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    // JPEG: the size is in the first "start of frame" segment
    for (let at = 2; at + 9 < buffer.length;) {
      if (buffer[at] !== 0xff) { at++; continue; }
      const marker = buffer[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', width: buffer.readUInt16BE(at + 7), height: buffer.readUInt16BE(at + 5) };
      at += 2 + buffer.readUInt16BE(at + 2);
    }
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buffer.subarray(12, 16).toString('latin1');
    if (kind === 'VP8 ') return { type: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const bits = buffer.readUInt32LE(21); return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { type: 'webp', width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  return null;
}

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

  it('has an icon for the status conditions, as the files of the folder say', () => {
    const files = fs.readdirSync(path.join(ASSETS, 'status')).sort();
    for (const file of files) {
      const buffer = fs.readFileSync(path.join(ASSETS, 'status', file));
      assert.deepEqual(buffer.subarray(0, 8), PNG_SIGNATURE, `${file} is a PNG`);
      const { width, height } = pngSize(buffer);
      // they show in a square box (contained): a picture that is nearly square is fine, and a hundred kilobytes is not a worry
      assert.ok(Math.abs(width - height) / Math.max(width, height) < 0.06, `${file} is nearly square (${width} x ${height})`);
      assert.ok(buffer.length < 150 * 1024, `${file} is small enough (${buffer.length} bytes)`);
    }
    // every status points at a picture in that folder, and the ones that are there are the ones that are used
    const used = GAME.STATUS_CONDITIONS.map((condition) => path.basename(condition.icon));
    for (const condition of GAME.STATUS_CONDITIONS) assert.match(condition.icon, /^\/assets\/status\/[a-z]+\.png$/, condition.key);
    for (const file of files) assert.ok(used.includes(file), `${file} is the icon of a status`);
    assert.equal(new Set(used).size, used.length, 'one picture each');
    assert.deepEqual(files, used.sort(), 'all six are there');
    // a status whose picture is missing (the folder can be deleted) is drawn as a colored disc with a letter, so it needs both
    for (const condition of GAME.STATUS_CONDITIONS) assert.ok(condition.glyph && condition.color && condition.ink, `${condition.key} can be drawn without its picture`);
  });

  it('may hold the prize card backs (English, Japanese, a Poké Ball) as a PNG, a JPG or a WebP: only those names, each a small picture of a card', () => {
    const named = THEME.PRIZE_STYLES.filter((style) => style.picture).map((style) => style.key);
    assert.deepEqual(named, ['english', 'japanese', 'pokeball']);
    assert.deepEqual(THEME.PRIZE_PICTURE_TYPES, ['png', 'webp', 'jpg', 'jpeg']);
    for (const style of THEME.PRIZE_STYLES.filter((item) => item.picture)) assert.match(style.help, new RegExp(`^assets/cardbacks/${style.key} `), 'the editor says where the file goes');
    const folder = path.join(ASSETS, 'cardbacks');
    const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((file) => file !== 'README.md').sort() : [];
    const found = {};
    for (const file of files) {
      const { name, ext } = { name: path.parse(file).name, ext: path.parse(file).ext.slice(1) };
      assert.ok(named.includes(name) && THEME.PRIZE_PICTURE_TYPES.includes(ext), `${file} is a card back (${named.join(', ')}, as ${THEME.PRIZE_PICTURE_TYPES.join(', ')})`);
      assert.equal(found[name], undefined, `only one picture for ${name}`);
      const buffer = fs.readFileSync(path.join(folder, file));
      const picture = pictureOf(buffer);
      assert.ok(picture, `${file} is a picture`);
      assert.equal(picture.type, ext === 'jpg' ? 'jpeg' : ext, `${file} is what its name says`);
      // they are printed on a card (5 wide for 7 tall), covering it: roughly that shape, and small enough to load with the overlay
      assert.ok(Math.abs(picture.width / picture.height - 5 / 7) < 0.1, `${file} has the shape of a card (${picture.width} x ${picture.height})`);
      assert.ok(picture.width >= 100, `${file} is big enough to look sharp (${picture.width} wide)`);
      assert.ok(buffer.length < 400 * 1024, `${file} is small enough (${buffer.length} bytes)`);
      found[name] = file;
    }
  });

  it('tells the overlay and the control panel where each icon is served from', () => {
    for (const type of GAME.ENERGY_TYPES) assert.equal(type.icon, `/assets/energy/${type.key}.png`);
    assert.equal(new Set(GAME.ENERGY_TYPES.map((type) => type.icon)).size, GAME.ENERGY_TYPES.length);
  });

  it('is packaged into the app and used for the app icon, but the README pictures are not', () => {
    const files = pkg.build.files;
    for (const entry of ['assets/logo.ico', 'assets/logo.gif', 'assets/energy/**/*', 'assets/status/**/*', 'assets/fonts/**/*', 'assets/cardbacks/**/*', 'assets/markers/**/*']) assert.ok(files.includes(entry), entry);
    assert.ok(!files.some((entry) => entry.includes('screenshots')), 'screenshots stay out of the installer');
    assert.ok(!files.includes('logo.ico') && !files.includes('logo.gif'), 'no entry for the old place');
    assert.equal(pkg.build.win.icon, 'assets/logo.ico');
    for (const association of pkg.build.fileAssociations) assert.equal(association.icon, 'assets/logo.ico');
    for (const entry of [pkg.build.win.icon, ...pkg.build.fileAssociations.map((a) => a.icon)]) assert.ok(fs.existsSync(path.join(ROOT, entry)), entry);
  });

  it('has the font that draws country flags, where the stylesheet asks for it (Windows draws none of its own)', () => {
    const font = fs.readFileSync(path.join(ASSETS, 'fonts', 'TwemojiCountryFlags.woff2'));
    assert.equal(font.subarray(0, 4).toString('latin1'), 'wOF2', 'a WOFF2 font');
    assert.ok(font.length < 100 * 1024, 'small enough to load with the page');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'tokens.css'), 'utf8');
    assert.match(css, /font-family: "Twemoji Country Flags";/);
    assert.match(css, /url\("\/assets\/fonts\/TwemojiCountryFlags\.woff2"\)/);
    // only the characters of flags are drawn with it, so putting it first in a list of fonts changes nothing else
    assert.match(css, /unicode-range: U\+1F1E6-1F1FF,/);
    assert.equal(fs.readdirSync(path.join(ASSETS, 'fonts')).length, 1, 'nothing else in that folder');
  });

  it('names its rights in the notice', () => {
    const notice = fs.readFileSync(path.join(ROOT, 'NOTICE.md'), 'utf8');
    assert.match(notice, /assets\/energy/);
    assert.match(notice, /not covered by the MIT license/);
    assert.match(fs.readFileSync(path.join(ASSETS, 'README.md'), 'utf8'), /not part of that license/);
    // the flags are Twemoji artwork, which asks for credit
    assert.match(notice, /Twemoji/);
    assert.match(notice, /CC BY 4\.0|CC-BY 4\.0|CC-BY-4\.0/);
    assert.match(notice, /assets\/fonts/);
  });
});

describe('icons that are not in the folder', () => {
  let server;
  let folder;
  before(async () => {
    // an assets folder with one status icon and no energy icons at all (the folders can be deleted)
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    folder = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'assets-missing-'));
    fs.mkdirSync(path.join(folder, 'status'));
    fs.copyFileSync(path.join(ASSETS, 'status', 'asleep.png'), path.join(folder, 'status', 'asleep.png'));
    server = await startServer({ label: 'assets-missing', env: { OTO_ASSETS_DIR: folder } });
  });
  after(async () => {
    if (server) await server.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const get = (route) => fetch(`${server.base}${route}`);

  it('answers 204, "nothing here", for an icon it knows by name, so the pages draw a disc without an error showing in the browser', async () => {
    const here = await get('/assets/status/asleep.png');
    assert.equal(here.status, 200, 'the one that is there');
    for (const route of ['/assets/status/burned.png', '/assets/status/confused.png', '/assets/cardbacks/english', '/assets/cardbacks/japanese', '/assets/cardbacks/pokeball', ...GAME.ENERGY_TYPES.map((type) => type.icon)]) {
      const response = await get(route);
      assert.equal(response.status, 204, route);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  });

  it('is a 404 for any name it does not know, and for the folder itself', async () => {
    for (const route of ['/assets/status/none.png', '/assets/status/burned.gif', '/assets/energy/none.png', '/assets/energy/', '/assets/status/', '/assets/cardbacks/spanish', '/assets/cardbacks/english.png', '/assets/cardbacks/english.jpg', '/assets/cardbacks/', '/assets/cardbacks']) {
      assert.equal((await get(route)).status, 404, route);
    }
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

  it('serves every status icon that is there, and answers "nothing here" (204, not an error) for one that is known but has no file yet', async () => {
    for (const condition of GAME.STATUS_CONDITIONS) {
      const response = await get(condition.icon);
      const file = path.join(ASSETS, 'status', path.basename(condition.icon));
      if (!fs.existsSync(file)) {
        // the pages draw a disc with a letter for it; a 404 would put an error in the browser's console and a warning in the log on every load
        assert.equal(response.status, 204, `${condition.icon} is not there yet`);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
        continue;
      }
      assert.equal(response.status, 200, condition.icon);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(file));
    }
  });

  it('serves a prize card back that is there, as the kind of picture it is, and answers "nothing here" for one that is not (the overlay draws its own then)', async () => {
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
    for (const style of THEME.PRIZE_STYLES.filter((item) => item.picture)) {
      const response = await get(`/assets/cardbacks/${style.key}`);
      const ext = THEME.PRIZE_PICTURE_TYPES.find((type) => fs.existsSync(path.join(ASSETS, 'cardbacks', `${style.key}.${type}`)));
      if (!ext) {
        assert.equal(response.status, 204, `${style.key} is not there yet`);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
        continue;
      }
      assert.equal(response.status, 200, style.key);
      assert.equal(response.headers.get('content-type'), types[ext], style.key);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(ASSETS, 'cardbacks', `${style.key}.${ext}`)));
    }
  });

  it('serves the flag font as a font', async () => {
    const response = await get('/assets/fonts/TwemojiCountryFlags.woff2');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'font/woff2');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(ASSETS, 'fonts', 'TwemojiCountryFlags.woff2')));
    assert.match(response.headers.get('content-security-policy'), /font-src 'self'/, 'the page is allowed to load it');
  });

  it('answers 204 only for the icons it knows by name: any other file that is not there is a 404', async () => {
    for (const route of ['/assets/status/none.png', '/assets/status/confused.jpg', '/assets/energy/none.png', '/assets/energy/fire.gif', '/assets/status/.png']) {
      assert.equal((await get(route)).status, 404, route);
    }
    // an energy icon that is known but missing is 204 too: the folder can be deleted, and the overlay draws colored discs
    assert.ok(GAME.ENERGY_TYPES.every((type) => /^\/assets\/energy\/[a-z]+\.png$/.test(type.icon)));
  });

  it('serves nothing else from the folder, and no folder listing', async () => {
    for (const route of ['/assets/energy/none.png', '/assets/energy/', '/assets/energy', '/assets/status/', '/assets/status', '/assets/status/../logo.gif', '/assets/logo.gif', '/assets/README.md', '/assets/screenshots/overlay.png', '/assets/energy/../logo.gif', '/assets/energy/%2e%2e/logo.gif', '/assets/fonts/', '/assets/fonts', '/assets/fonts/none.woff2', '/assets/fonts/../logo.gif', '/assets/cardbacks/', '/assets/cardbacks', '/assets/cardbacks/../logo.gif', '/assets/cardbacks/%2e%2e/logo.gif', '/assets/cardbacks/%2e%2e%2flogo', '/assets/cardbacks/README.md', '/assets/cardbacks/english.jpg', '/assets/cardbacks/japanese.webp', '/assets/cardbacks/english.png']) {
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

describe('the pictures of the GX attack and the VSTAR Power', () => {
  let server;
  let empty;
  let own;

  before(async () => {
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    server = await startServer({ label: 'assets-markers' });
    // a folder with no markers at all, and one with a picture of the maintainer's own for the GX
    empty = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'markers-empty-'));
    own = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'markers-own-'));
    fs.mkdirSync(path.join(own, 'markers'));
    fs.copyFileSync(path.join(ASSETS, 'status', 'asleep.png'), path.join(own, 'markers', 'gx.png'));
    fs.copyFileSync(path.join(ASSETS, 'markers', 'vstar.svg'), path.join(own, 'markers', 'vstar.svg'));
  });
  after(async () => {
    if (server) await server.stop();
    for (const folder of [empty, own]) fs.rmSync(folder, { recursive: true, force: true });
  });

  it('come with OTO as drawings, which are SVG pictures with no script in them', () => {
    for (const name of ['gx', 'vstar']) {
      const text = fs.readFileSync(path.join(ASSETS, 'markers', `${name}.svg`), 'utf8');
      assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.doesNotMatch(text, /<script|onload|onclick|href=/i, name);
    }
  });

  it('are served by name, as the kind of picture they are', async () => {
    for (const name of ['gx', 'vstar']) {
      const response = await fetch(`${server.base}/assets/markers/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), 'image/svg+xml', name);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(ASSETS, 'markers', `${name}.svg`)));
    }
  });

  it('are a 404 for any other name or kind of name', async () => {
    for (const route of ['/assets/markers/other', '/assets/markers/gx.svg', '/assets/markers/gx.png', '/assets/markers/', '/assets/markers', '/assets/markers/../logo.gif', '/assets/markers/%2e%2e/logo.gif', '/assets/markers/GX']) {
      assert.equal((await fetch(`${server.base}${route}`)).status, 404, route);
    }
  });

  it('are taken from a picture of the maintainer\'s own when there is one, and answer "nothing here" when there is none', async () => {
    const withOwn = await startServer({ label: 'assets-markers-own', env: { OTO_ASSETS_DIR: own } });
    const without = await startServer({ label: 'assets-markers-none', env: { OTO_ASSETS_DIR: empty } });
    try {
      const gx = await fetch(`${withOwn.base}/assets/markers/gx`);
      assert.equal(gx.status, 200);
      assert.equal(gx.headers.get('content-type'), 'image/png', 'a PNG beside the drawing is the one that shows');
      assert.deepEqual(Buffer.from(await gx.arrayBuffer()), fs.readFileSync(path.join(own, 'markers', 'gx.png')));
      assert.equal((await fetch(`${withOwn.base}/assets/markers/vstar`)).headers.get('content-type'), 'image/svg+xml');
      for (const name of ['gx', 'vstar']) {
        const none = await fetch(`${without.base}/assets/markers/${name}`);
        assert.equal(none.status, 204, name);
        assert.equal((await none.arrayBuffer()).byteLength, 0);
      }
    } finally {
      await Promise.all([withOwn.stop(), without.stop()]);
    }
  });
});
