/**
 * .oto packages: what goes in, what is taken out, and what is never allowed through.
 * (Through the server: designs-server.test.js.)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PackageService, PackageError, pack, unpack, pickSharedSettings, describeControls, FORMAT, VERSION, MAX_PACKAGE_BYTES } = require('../src/services/package');
const { createZip, readZip, ZipError } = require('../src/services/zip');
const { ThemeStore, ThemeError } = require('../src/services/themes');
const { SoundStore } = require('../src/services/sounds');
const DISPLAY = require('../public/js/display-options');
const SOUND = require('../public/js/sound-options');
const S = require('../test-support/samples');
const { ROOT } = require('../test-support/harness');

const text = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const zip = (entries) => createZip(Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : text(data) })));
const refuses = (fn, pattern, type = PackageError) => assert.throws(fn, (error) => error instanceof type && pattern.test(error.message), String(pattern));

// The settings of a fresh game, as far as packages are concerned
const DEFAULTS = {
  apiProvider: 'pokemontcg', apiKey: '', preferLowestRarity: true, autoScale: true, overlayOpacity: 100, showPenaltyAnimation: true,
  cacheMaxSizeMB: 500, cacheTTLDays: 30, language: 'en_US', enableStreamDeck: true, autosaveIntervalSec: 30,
  display: { ...DISPLAY.DEFAULTS }, sound: JSON.parse(JSON.stringify(SOUND.DEFAULTS)), toastSeconds: 4, animationSeconds: 3,
  enableStartGameToast: true, enableStartGameAnimation: true, enableTrainerAKO_OOC_Animation: true, enableAttackToast: true
};

describe('what a package may carry of the control settings', () => {
  it('takes what the producer set: what is shown, timings, announcements and sounds', () => {
    const picked = pickSharedSettings({
      ...DEFAULTS,
      display: { ...DEFAULTS.display, nationality: false, record: false },
      toastSeconds: 6, animationSeconds: 2.5, overlayOpacity: 80, autoScale: false,
      enableAttackToast: false, enableTrainerAKO_OOC_Animation: false,
      sound: { enabled: true, volume: 55, events: { ...DEFAULTS.sound.events, damage: { enabled: false, volume: 40 } } }
    }, DEFAULTS);
    assert.equal(picked.display.nationality, false);
    assert.equal(picked.display.record, false);
    assert.equal(picked.display.scoreboard, true);
    assert.equal(Object.keys(picked.display).length, DISPLAY.KEYS.length);
    assert.deepEqual([picked.toastSeconds, picked.animationSeconds, picked.overlayOpacity, picked.autoScale], [6, 2.5, 80, false]);
    assert.equal(picked.enableAttackToast, false);
    assert.equal(picked.enableTrainerAKO_OOC_Animation, false);
    assert.deepEqual(picked.sound.events.damage, { enabled: false, volume: 40 });
    assert.equal(picked.sound.enabled, true);
    assert.equal(picked.sound.volume, 55);
  });

  it('never takes anything that belongs to one computer, and never the secrets', () => {
    const picked = pickSharedSettings({
      ...DEFAULTS, apiKey: 'sk-very-secret', apiProvider: 'scrydex', cacheMaxSizeMB: 9999, cacheTTLDays: 1, language: 'ja_JP',
      enableStreamDeck: false, autosaveIntervalSec: 1, password: 'hunter2', passwordHash: 'abc', authSecret: 'def', toString: 'x', __proto__: { evil: true },
      enableSomethingElse: true, enableFooToast: true, constructor: { prototype: {} }
    }, DEFAULTS);
    const json = JSON.stringify(picked);
    for (const secret of ['sk-very-secret', 'hunter2', 'abc', 'def', 'scrydex', 'ja_JP', 'apiKey', 'apiProvider', 'cacheMaxSizeMB', 'cacheTTLDays', 'language', 'enableStreamDeck', 'autosaveIntervalSec', 'password', 'evil']) {
      assert.ok(!json.includes(secret), `"${secret}" must not be in ${json.slice(0, 200)}`);
    }
    assert.equal('enableSomethingElse' in picked, false, 'not an announcement flag');
    assert.equal('enableFooToast' in picked, false, 'an announcement flag the game does not have');
  });

  it('ignores values of the wrong type, and keeps volumes in range', () => {
    const picked = pickSharedSettings({
      display: { scoreboard: 'yes', nationality: 0, record: false, nonsense: false }, toastSeconds: '4', animationSeconds: NaN, overlayOpacity: Infinity,
      autoScale: 1, enableAttackToast: 'no',
      sound: { enabled: 'on', volume: 500, events: { damage: { enabled: 'x', volume: -20 }, ko: { volume: 50.6 }, nonsense: { enabled: true }, heal: 7 } }
    }, DEFAULTS);
    assert.deepEqual(picked.display, { record: false });
    assert.deepEqual(Object.keys(picked).sort(), ['display', 'sound']);
    assert.deepEqual(picked.sound, { volume: 100, events: { damage: { volume: 0 }, ko: { volume: 51 } } });
  });

  it('takes nothing from something that is not settings', () => {
    for (const nothing of [undefined, null, 'settings', 5, []]) assert.deepEqual(pickSharedSettings(nothing, DEFAULTS), {});
    assert.deepEqual(pickSharedSettings({}, DEFAULTS), {});
  });

  it('describes the settings in plain facts', () => {
    const facts = describeControls(pickSharedSettings({
      display: { nationality: false, record: false, scoreboard: true }, toastSeconds: 6, animationSeconds: 2,
      enableAttackToast: false, enableStartGameAnimation: false,
      sound: { enabled: true, volume: 40, events: { damage: { enabled: false }, ko: { enabled: false }, heal: { enabled: true } } }
    }, DEFAULTS));
    assert.deepEqual(facts.hidden, ['Nationality', 'Tournament record (W/L/T)']);
    assert.equal(facts.shown, 1);
    assert.deepEqual([facts.toastSeconds, facts.animationSeconds], [6, 2]);
    assert.deepEqual(facts.sound, { enabled: true, volume: 40, mutedCues: ['Damage', 'Knock out'] });
    assert.equal(facts.announcementsOff, 2);
    assert.equal(describeControls({ toastSeconds: 3 }).sound, undefined);
    assert.deepEqual(describeControls({ toastSeconds: 3 }).hidden, []);
  });
});

describe('packing and unpacking', () => {
  const design = () => ({
    design: { name: 'Store League', author: 'Mina', description: 'Neon', colors: { '--accent': '#ff4d6d' }, images: { logoImage: 'images/logoImage.png' }, font: 'fonts/font.woff2', sounds: { damage: 'sounds/damage.mp3' } },
    files: [{ ref: 'images/logoImage.png', data: S.PNG }, { ref: 'fonts/font.woff2', data: S.WOFF2 }, { ref: 'sounds/damage.mp3', data: S.MP3 }]
  });
  const controls = () => pickSharedSettings({ ...DEFAULTS, display: { ...DEFAULTS.display, record: false }, toastSeconds: 7 }, DEFAULTS);

  it('makes an ordinary ZIP with a description, the design, its files and the settings', () => {
    const files = readZip(pack({ name: 'Store League', design: design(), controls: controls(), app: 'OTO 1.0.0' }));
    assert.deepEqual([...files.keys()], ['manifest.json', 'design.json', 'images/logoImage.png', 'fonts/font.woff2', 'sounds/damage.mp3', 'controls.json']);
    const manifest = JSON.parse(files.get('manifest.json'));
    assert.equal(manifest.format, FORMAT);
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.name, 'Store League');
    assert.equal(manifest.app, 'OTO 1.0.0');
    assert.deepEqual(manifest.contents, { design: true, sounds: 1, controls: true });
    assert.ok(Math.abs(Date.parse(manifest.created) - Date.now()) < 5000);
    assert.deepEqual(JSON.parse(files.get('controls.json')).settings.display.record, false);
    assert.deepEqual(files.get('images/logoImage.png'), S.PNG);
  });

  it('gives back what was packed', () => {
    const opened = unpack(pack({ name: 'Store League', design: design(), controls: controls() }), DEFAULTS);
    assert.equal(opened.manifest.name, 'Store League');
    assert.equal(opened.design.name, 'Store League');
    assert.equal(opened.design.author, 'Mina');
    assert.equal(opened.design.description, 'Neon');
    assert.deepEqual(opened.design.colors, { '--accent': '#ff4d6d' });
    assert.deepEqual(opened.design.images.logoImage, S.PNG);
    assert.deepEqual(opened.design.font, S.WOFF2);
    assert.deepEqual(opened.design.sounds.damage, S.MP3);
    assert.equal(opened.controls.settings.display.record, false);
    assert.equal(opened.controls.settings.toastSeconds, 7);
    assert.deepEqual(opened.ignored, []);
  });

  it('can hold only a design, or only settings', () => {
    const onlyDesign = unpack(pack({ name: 'x', design: design() }), DEFAULTS);
    assert.equal(onlyDesign.controls, null);
    assert.ok(onlyDesign.design);
    const onlySettings = unpack(pack({ name: 'My setup', controls: controls() }), DEFAULTS);
    assert.equal(onlySettings.design, null);
    assert.equal(onlySettings.manifest.name, 'My setup');
    assert.ok(onlySettings.controls);
  });

  it('is smaller than its parts', () => {
    const wide = { design: { name: 'x', colors: {}, images: {}, sounds: {} }, files: [{ ref: 'images/logoImage.svg', data: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="9" height="9"/>'.repeat(500)}</svg>`) }] };
    const file = pack({ name: 'x', design: wide, controls: controls() });
    assert.ok(file.length < wide.files[0].data.length / 3, `${file.length} bytes for ${wide.files[0].data.length}`);
  });

  it('finds the files of a package made by zipping a folder by hand', () => {
    // no manifest, and design.json says nothing about the files: they are found by their names
    const opened = unpack(zip({
      'design.json': { name: 'Hand made', colors: { '--accent': '#123456' } },
      'images/logoImage.jpg': S.JPG, 'images/trainerBAvatar.png': S.PNG, 'fonts/font.ttf': S.TTF, 'sounds/ko.wav': S.WAV, 'sounds/win.ogg': S.OGG
    }), DEFAULTS);
    assert.equal(opened.manifest.name, '');
    assert.equal(opened.design.name, 'Hand made');
    assert.deepEqual(Object.keys(opened.design.images), ['logoImage', 'trainerBAvatar']);
    assert.ok(opened.design.font);
    assert.deepEqual(Object.keys(opened.design.sounds), ['ko', 'win']);
  });

  it('finds the files when the folder itself was zipped, as Windows does by default', () => {
    const opened = unpack(zip({
      'my design/design.json': { name: 'Wrapped', colors: { '--accent': '#123456' } },
      'my design/images/logoImage.png': S.PNG, 'my design/sounds/ko.wav': S.WAV, 'my design/controls.json': { settings: { toastSeconds: 5 } }
    }), DEFAULTS);
    assert.equal(opened.design.name, 'Wrapped');
    assert.deepEqual(Object.keys(opened.design.images), ['logoImage']);
    assert.deepEqual(Object.keys(opened.design.sounds), ['ko']);
    assert.equal(opened.controls.settings.toastSeconds, 5);
    assert.deepEqual(opened.ignored, []);

    // macOS adds entries of its own next to the folder
    const mac = unpack(zip({ 'Design/design.json': { name: 'Mac' }, '__MACOSX/Design/._design.json': 'junk', '.DS_Store': 'junk' }), DEFAULTS);
    assert.equal(mac.design.name, 'Mac');
  });

  it('does not mistake a normal package for a wrapped one', () => {
    // files at the top and in several folders: nothing is stripped
    const normal = unpack(zip({ 'design.json': { name: 'Plain' }, 'images/logoImage.png': S.PNG, 'sounds/ko.wav': S.WAV }), DEFAULTS);
    assert.deepEqual(Object.keys(normal.design.images), ['logoImage']);
    assert.deepEqual(Object.keys(normal.design.sounds), ['ko']);
    // one folder holding a design next to a top-level file is left as it is, and is not a usable package
    refuses(() => unpack(zip({ 'readme.txt': 'hi', 'folder/design.json': { name: 'x' } })), /no design and no control settings/);
  });

  it('prefers the file design.json names when a slot has several', () => {
    const opened = unpack(zip({ 'design.json': { name: 'Two', images: { logoImage: 'images/logoImage.jpg' } }, 'images/logoImage.png': S.PNG, 'images/logoImage.jpg': S.JPG }), DEFAULTS);
    assert.deepEqual(opened.design.images.logoImage, S.JPG);
    const other = unpack(zip({ 'design.json': { name: 'Two' }, 'images/logoImage.png': S.PNG, 'images/logoImage.jpg': S.JPG }), DEFAULTS);
    assert.deepEqual(other.design.images.logoImage, S.PNG, 'otherwise the first type in a fixed order');
  });

  it('names a design after the package when the design has no name', () => {
    assert.equal(unpack(zip({ 'manifest.json': { format: 'oto', version: 1, name: 'From the manifest' }, 'design.json': { colors: {} } }), DEFAULTS).design.name, 'From the manifest');
    assert.equal(unpack(zip({ 'design.json': { colors: {} } }), DEFAULTS).design.name, 'Imported design');
  });

  it('ignores files it has no use for, and says which', () => {
    const opened = unpack(zip({
      'manifest.json': { format: 'oto', version: 1 }, 'design.json': { name: 'x' },
      'README.txt': 'hello', '__MACOSX/._design.json': 'junk', '.DS_Store': 'junk', 'images/notASlot.png': S.PNG, 'sounds/notACue.mp3': S.MP3, 'images/logoImage.png': S.PNG
    }), DEFAULTS);
    assert.deepEqual(opened.ignored.sort(), ['.DS_Store', 'README.txt', '__MACOSX/._design.json', 'images/notASlot.png', 'sounds/notACue.mp3']);
    assert.deepEqual(Object.keys(opened.design.images), ['logoImage']);
  });

  it('reads the settings whether they are wrapped or bare, and drops what is not shareable', () => {
    const wrapped = unpack(zip({ 'controls.json': { version: 1, settings: { toastSeconds: 5, apiKey: 'secret' } } }), DEFAULTS);
    assert.deepEqual(wrapped.controls.settings, { toastSeconds: 5 });
    const bare = unpack(zip({ 'controls.json': { toastSeconds: 5, display: { record: false }, apiKey: 'secret' } }), DEFAULTS);
    assert.deepEqual(bare.controls.settings, { toastSeconds: 5, display: { record: false } });
  });

  it('does not follow web addresses or paths written in design.json', () => {
    const opened = unpack(zip({ 'design.json': { name: 'x', images: { logoImage: 'https://tracker.example/p.png', backgroundImage: '../../etc/passwd' }, font: 'http://x.example/f.woff2' } }), DEFAULTS);
    assert.deepEqual(opened.design.images, {});
    assert.equal(opened.design.font, null);
  });

  it('explains what is wrong with a file that is not a package', () => {
    refuses(() => unpack(Buffer.alloc(0)), /No file was sent/);
    refuses(() => unpack('a string'), /No file was sent/);
    refuses(() => unpack(text('just some text that is not a zip file at all')), /not a package file/, ZipError);
    refuses(() => unpack(zip({ 'readme.txt': 'hello' })), /no design and no control settings/);
    refuses(() => unpack(zip({ 'manifest.json': { format: 'oto', version: 1 } })), /no design and no control settings/);
    refuses(() => unpack(zip({ 'manifest.json': { format: 'something-else' }, 'design.json': { name: 'x' } })), /not an OTO package/);
    refuses(() => unpack(zip({ 'manifest.json': { format: 'oto', version: 99 }, 'design.json': { name: 'x' } })), /newer version of OTO/);
    refuses(() => unpack(zip({ 'manifest.json': { format: 'oto', version: 'one' }, 'design.json': { name: 'x' } })), /invalid version/);
    refuses(() => unpack(zip({ 'manifest.json': '{ nope' })), /The description in that package cannot be read/);
    refuses(() => unpack(zip({ 'design.json': '[1,2]' })), /The design in that package cannot be read/);
    refuses(() => unpack(zip({ 'design.json': '{ nope' })), /The design in that package cannot be read/);
    refuses(() => unpack(zip({ 'controls.json': 'null' })), /The control settings in that package cannot be read/);
    refuses(() => unpack(zip({ 'design.json': { name: '!!!' } })), /at least one letter or digit/);
  });

  it('refuses a package that is too large, or has files that are', () => {
    refuses(() => unpack(Buffer.alloc(MAX_PACKAGE_BYTES + 1)), /too large to be a package/);
    refuses(() => unpack(zip({ 'design.json': { name: 'x' }, 'sounds/damage.wav': S.bigWav(1.6 * 1024 * 1024) })), /"sounds\/damage.wav" is too large \(1.5 MB at most\)/, ZipError);
    refuses(() => unpack(zip({ 'design.json': { name: 'x' }, 'images/logoImage.png': S.bigPng(4.6 * 1024 * 1024) })), /is too large/, ZipError);
    refuses(() => unpack(zip({ 'design.json': Buffer.alloc(2 * 1024 * 1024, ' ') })), /"design.json" is too large/, ZipError);
    refuses(() => unpack(zip({ 'design.json': { name: 'x' }, 'notes.bin': Buffer.alloc(9 * 1024 * 1024, 1) })), /"notes.bin" is too large/, ZipError);
  });

  it('refuses names that could reach outside', () => {
    refuses(() => unpack(zip({ 'design.json': { name: 'x' }, '../evil.png': S.PNG })), /unsafe name/, ZipError);
    refuses(() => unpack(zip({ 'design.json': { name: 'x' }, 'images/../../evil.png': S.PNG })), /unsafe name/, ZipError);
  });
});

describe('the package service', () => {
  let dir;
  let themes;
  let sounds;
  let service;
  let settings;
  let commits;
  let events;

  beforeEach(() => {
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'packages-'));
    const values = {};
    themes = new ThemeStore(path.join(dir, 'themes'), { getSetting: (key, fallback = null) => (key in values ? values[key] : fallback), setSetting: (key, value) => { values[key] = value; } });
    themes.init();
    sounds = new SoundStore(path.join(dir, 'sounds'));
    settings = { ...DEFAULTS, apiKey: 'sk-secret-key', display: { ...DEFAULTS.display, record: false }, toastSeconds: 6 };
    commits = [];
    events = [];
    service = new PackageService({
      themes, sounds,
      gameState: { state: { settings }, getDefaultState: () => ({ settings: DEFAULTS }) },
      session: { commit: (label, change) => { commits.push({ label, change }); } },
      emit: (event) => events.push(event),
      appVersion: '1.2.3'
    });
    themes.save('Store League', { colors: { '--accent': '#ff4d6d' }, author: 'Mina' });
    themes.setImage('Store League', 'logoImage', S.PNG);
    themes.setSound('Store League', 'damage', S.MP3);
    themes.setSound('Store League', 'ko', S.OGG);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const applied = () => {
    const patches = [];
    for (const { change } of commits) change({ updateSettings: (patch) => patches.push(patch) });
    return patches;
  };

  describe('exporting', () => {
    it('packs a design with its sounds and the control settings', () => {
      const { buffer, filename } = service.exportPackage({ design: 'Store League', controls: true });
      assert.equal(filename, 'store-league.oto');
      const files = readZip(buffer);
      assert.deepEqual([...files.keys()].sort(), ['controls.json', 'design.json', 'images/logoImage.png', 'manifest.json', 'sounds/damage.mp3', 'sounds/ko.ogg']);
      assert.equal(JSON.parse(files.get('manifest.json')).app, 'OTO 1.2.3');
      assert.equal(JSON.parse(files.get('design.json')).author, 'Mina');
      assert.equal(JSON.parse(files.get('controls.json')).settings.toastSeconds, 6);
    });

    it('never writes the card API key or anything private into a package', () => {
      const { buffer } = service.exportPackage({ design: 'Store League', controls: true });
      for (const data of readZip(buffer).values()) {
        if (data.equals(S.PNG) || data.equals(S.MP3) || data.equals(S.OGG)) continue;
        assert.ok(!data.toString('latin1').includes('sk-secret-key'));
        assert.ok(!/apiKey|cacheMaxSizeMB|language/.test(data.toString('latin1')));
      }
    });

    it('can leave the settings out, or the design out', () => {
      const designOnly = readZip(service.exportPackage({ design: 'Store League' }).buffer);
      assert.equal(designOnly.has('controls.json'), false);
      const settingsOnly = service.exportPackage({ controls: true });
      assert.equal(settingsOnly.filename, 'my-oto-setup.oto');
      assert.deepEqual([...readZip(settingsOnly.buffer).keys()], ['manifest.json', 'controls.json']);
    });

    it('can put the producer\'s own sounds in, which win over the design\'s', () => {
      sounds.save('damage', S.WAV);
      sounds.save('heal', S.MP3);
      const files = readZip(service.exportPackage({ design: 'Store League', mySounds: true }).buffer);
      assert.deepEqual([...files.keys()].filter((name) => name.startsWith('sounds/')).sort(), ['sounds/damage.wav', 'sounds/heal.mp3', 'sounds/ko.ogg']);
      assert.deepEqual(files.get('sounds/damage.wav'), S.WAV);
      assert.deepEqual(JSON.parse(files.get('design.json')).sounds, { damage: 'sounds/damage.wav', ko: 'sounds/ko.ogg', heal: 'sounds/heal.mp3' });
      // and the design on disk is untouched
      assert.deepEqual(Object.keys(themes.get('Store League').sounds).sort(), ['damage', 'ko']);

      const without = readZip(service.exportPackage({ design: 'Store League' }).buffer);
      assert.deepEqual(without.get('sounds/damage.mp3'), S.MP3, 'not unless asked');
    });

    it('needs something to put in, and a design that exists', () => {
      refuses(() => service.exportPackage({}), /Choose what to put in the package/);
      refuses(() => service.exportPackage({ design: 'Nobody' }), /does not exist/, ThemeError);
    });
  });

  describe('looking inside a package', () => {
    const exported = () => service.exportPackage({ design: 'Store League', controls: true }).buffer;

    it('says when a package switches on something that is off to begin with', () => {
      const controls = Buffer.from(JSON.stringify({ version: 1, settings: { display: { gxMarker: true, vstarMarker: false, nationality: false, locks: true } } }));
      const info = service.inspect(createZip([{ name: 'controls.json', data: controls }]));
      assert.deepEqual(info.controls.revealed, ['GX attack marker (once per game)']);
      assert.deepEqual(info.controls.hidden, ['Nationality'], 'the VSTAR marker it leaves off is not a thing it hides');
    });

    it('says what it holds without changing anything', () => {
      const info = service.inspect(exported());
      assert.equal(info.name, 'Store League');
      assert.equal(info.author, 'Mina');
      assert.equal(info.app, 'OTO 1.2.3');
      assert.deepEqual(info.design, { name: 'Store League', exists: true, images: ['logoImage'], font: false, sounds: ['damage', 'ko'], colors: 1, layout: 0, crop: [] });
      assert.deepEqual(info.controls.hidden, ['Tournament record (W/L/T)'], 'the markers that are off to begin with are not "hidden"');
      assert.deepEqual(info.controls.revealed, []);
      assert.equal(info.controls.toastSeconds, 6);
      assert.deepEqual(info.ignored, []);
      assert.deepEqual(themes.list(), ['Store League']);
      assert.deepEqual(commits, []);
      assert.deepEqual(events, []);
    });

    it('says when a design has its own layout or crop', () => {
      themes.save('Store League', { layout: { scoreboard: { x: 0, y: 30, scale: 1 }, logo: { x: 5, y: 0, scale: 1 } }, crop: { active: { x: 0.07, y: 0.115, w: 0.86, h: 0.385 } } });
      const info = service.inspect(exported());
      assert.equal(info.design.layout, 2, 'two pieces moved');
      assert.deepEqual(info.design.crop, ['active']);
    });

    it('knows whether the design is new here', () => {
      const other = exported();
      themes.remove('Store League');
      assert.equal(service.inspect(other).design.exists, false);
    });

    it('describes a package that only has settings', () => {
      const info = service.inspect(service.exportPackage({ controls: true }).buffer);
      assert.equal(info.name, 'My OTO setup');
      assert.equal(info.design, null);
      assert.ok(info.controls);
    });
  });

  describe('installing', () => {
    const exported = (options = { design: 'Store League', controls: true }) => service.exportPackage(options).buffer;

    it('adds the design under a free name, puts it on air and applies the settings', () => {
      const result = service.install(exported());
      assert.deepEqual(result, { design: { name: 'Store League 2', replaced: false }, activated: true, controlsApplied: true });
      assert.deepEqual(themes.list(), ['Store League', 'Store League 2']);
      assert.equal(themes.activeName(), 'Store League 2');
      assert.deepEqual(Object.keys(themes.get('Store League 2').sounds).sort(), ['damage', 'ko']);
      assert.deepEqual(events, ['theme:changed', 'sounds:changed']);

      assert.equal(commits.length, 1);
      assert.equal(commits[0].label, 'Settings from "Store League"', 'named after the package, which is what the producer chose to install');
      const [patch] = applied();
      assert.equal(patch.toastSeconds, 6);
      assert.equal(patch.display.record, false);
      assert.equal('apiKey' in patch, false);
    });

    it('can replace the design that has the same name', () => {
      themes.setSound('Store League', 'heal', S.WAV);
      const result = service.install(exported({ design: 'Store League' }), { replace: true });
      assert.deepEqual(result.design, { name: 'Store League', replaced: true });
      assert.deepEqual(themes.list(), ['Store League']);
      assert.equal(result.controlsApplied, false, 'the package had no settings');
    });

    it('can install only the design, or only the settings', () => {
      const onlyDesign = service.install(exported(), { controls: false, activate: false });
      assert.equal(onlyDesign.controlsApplied, false);
      assert.equal(onlyDesign.activated, false);
      assert.equal(themes.activeName(), null);
      assert.deepEqual(commits, []);
      assert.deepEqual(events, [], 'the design is not on air, so the screens have nothing to reload');

      const onlySettings = service.install(exported(), { design: false });
      assert.equal(onlySettings.design, null);
      assert.equal(onlySettings.controlsApplied, true);
      assert.equal(themes.list().length, 2, 'no further design was added');
    });

    it('does not put the design on air unless asked, and tells the screens only when it matters', () => {
      themes.setActive('Store League');
      service.install(exported(), { activate: false, replace: true });
      assert.deepEqual(events, ['theme:changed', 'sounds:changed'], 'the one on air was replaced');
    });

    it('refuses to install nothing', () => {
      refuses(() => service.install(exported(), { design: false, controls: false }), /Nothing was chosen/);
      refuses(() => service.install(exported({ design: 'Store League' }), { design: false }), /Nothing was chosen/);
    });

    it('installs nothing at all when part of a package is bad', () => {
      const bad = zip({
        'design.json': { name: 'Booby Trapped' }, 'images/logoImage.png': S.PNG,
        'images/backgroundImage.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'controls.json': { settings: { toastSeconds: 9 } }
      });
      refuses(() => service.install(bad), /scripts or links/);
      assert.deepEqual(themes.list(), ['Store League']);
      assert.deepEqual(commits, [], 'the settings were not applied either');
      assert.deepEqual(events, []);
      assert.equal(themes.activeName(), null);
    });

    it('refuses a file that is not a package', () => {
      refuses(() => service.install(text('not a package at all, just text')), /not a package/, ZipError);
      refuses(() => service.install(Buffer.alloc(0)), /No file was sent/);
    });

    it('applies settings only from the shareable list', () => {
      service.install(zip({ 'controls.json': { settings: { toastSeconds: 3, apiKey: 'stolen', cacheMaxSizeMB: 1, display: { record: false } } } }));
      assert.deepEqual(applied(), [{ toastSeconds: 3, display: { record: false } }]);
    });
  });
});
