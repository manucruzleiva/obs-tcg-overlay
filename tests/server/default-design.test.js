/**
 * Championship Blue as OTO's default look: the design that comes with the app (assets/designs/championship-blue) is put in once, on the
 * overlay when no design is, with its control settings on a fresh install only; and the example to download is the same design.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ROOT } = require('../support/harness');
const { readZip } = require('../../src/services/zip');
const { installDefaultDesign, bundledPackage, VERSION, SETTING } = require('../../src/services/default-design');

const ASSETS = path.join(ROOT, 'assets');
const FOLDER = path.join(ASSETS, 'designs', 'championship-blue');

describe('the default design', () => {
  describe('on a fresh install', () => {
    let server;
    before(async () => { server = await startServer({ label: 'default-design', env: { OTO_DEFAULT_DESIGN: '1' } }); });
    after(async () => { if (server) await server.stop(); });
    const get = async (route) => (await fetch(`${server.base}${route}`)).json();

    it('is installed and on the overlay', async () => {
      const designs = await get('/api/themes');
      assert.equal(designs.active, 'Championship Blue');
      const onAir = await get('/api/theme');
      assert.equal(onAir.name, 'Championship Blue');
      assert.match(onAir.theme.css, /\.prize-flag/, 'with its style sheet');
    });

    it('brings its control settings: the bench attacks, the turn highlight, the design animations, and no toast banners', async () => {
      const { settings } = await get('/api/state');
      assert.deepEqual([settings.display.activeAttacks, settings.display.benchAttacks, settings.display.turnIndicator, settings.display.moments, settings.display.toasts], [true, true, true, true, false]);
    });

    it('leaves the classic look one click away', async () => {
      const res = await fetch(`${server.base}/api/theme/active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) });
      assert.equal(res.ok, true);
      assert.equal((await get('/api/theme')).name, null);
    });
  });

  // The rules, without a server: a stand-in for the database, the designs and the packages
  describe('once for each version of it', () => {
    const fakes = ({ settings = {}, onAir = null } = {}) => {
      const store = { ...settings };
      const installs = [];
      return {
        installs,
        store,
        db: { getSetting: (key, fallback) => (key in store ? store[key] : fallback), setSetting: (key, value) => { store[key] = value; } },
        themes: { activeName: () => onAir },
        packages: { install: (buffer, options) => { installs.push(options); return { design: { name: 'Championship Blue' }, activated: options.activate, controlsApplied: options.controls }; } }
      };
    };

    it('puts it on the overlay with its control settings on a fresh install', () => {
      const f = fakes();
      installDefaultDesign({ ...f, assetsDir: ASSETS, fresh: true });
      assert.deepEqual(f.installs, [{ design: true, controls: true, activate: true, replace: true }]);
      assert.equal(f.store[SETTING].version, VERSION);
    });

    it('keeps the settings of an install that was in use, and the design that is on air', () => {
      const f = fakes({ onAir: 'Store League' });
      installDefaultDesign({ ...f, assetsDir: ASSETS, fresh: false });
      assert.deepEqual(f.installs, [{ design: true, controls: false, activate: false, replace: true }]);
    });

    it('puts it on the overlay of an install that was in use with the classic look, once', () => {
      const f = fakes();
      installDefaultDesign({ ...f, assetsDir: ASSETS, fresh: false });
      installDefaultDesign({ ...f, assetsDir: ASSETS, fresh: false });
      assert.deepEqual(f.installs, [{ design: true, controls: false, activate: true, replace: true }], 'the producer who goes back to the classic look stays there');
    });

    it('comes again when OTO ships a newer version of it', () => {
      const f = fakes({ settings: { [SETTING]: { version: VERSION - 1 } }, onAir: 'Championship Blue' });
      installDefaultDesign({ ...f, assetsDir: ASSETS, fresh: false });
      assert.equal(f.installs.length, 1);
      const g = fakes({ settings: { [SETTING]: { version: VERSION } } });
      assert.deepEqual(installDefaultDesign({ ...g, assetsDir: ASSETS, fresh: false }), { skipped: 'already installed' });
      assert.equal(g.installs.length, 0);
    });

    it('does nothing when the app was shipped without it', () => {
      const f = fakes();
      assert.deepEqual(installDefaultDesign({ ...f, assetsDir: path.join(ROOT, 'tests'), fresh: true }), { skipped: 'not shipped' });
      assert.equal(f.installs.length, 0);
    });
  });

  it('is the design of the example to download (npm run pack:example makes it again)', () => {
    const files = (buffer) => Object.fromEntries([...readZip(buffer)].map(([name, data]) => [name, data.toString('base64')]));
    const example = files(fs.readFileSync(path.join(ROOT, 'docs', 'examples', 'championship-blue.oto')));
    assert.deepEqual(example, files(bundledPackage(ASSETS)));
    assert.ok(Object.keys(example).includes('styles.css') && Object.keys(example).includes('controls.json'));
    assert.ok(fs.existsSync(path.join(FOLDER, 'images', 'backgroundImage.svg')));
  });

  it('has pictures that are whole SVG documents: each tag that opens is closed (a broken one is not drawn at all)', () => {
    for (const name of fs.readdirSync(path.join(FOLDER, 'images')).filter((one) => one.endsWith('.svg'))) {
      const open = [];
      const text = fs.readFileSync(path.join(FOLDER, 'images', name), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
      for (const [, closing, tag, selfClosing] of text.matchAll(/<(\/?)([A-Za-z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/g)) {
        if (selfClosing) continue;
        if (!closing) open.push(tag);
        else assert.equal(open.pop(), tag, `${name}: </${tag}> closes another tag`);
      }
      assert.deepEqual(open, [], `${name}: left open`);
    }
  });
});
