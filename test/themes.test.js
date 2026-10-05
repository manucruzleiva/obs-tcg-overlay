/**
 * Designs ("themes"): checking what is sent, and the folder of files each design is kept in.
 * (Through the server: designs-server.test.js.)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ThemeStore, ThemeError, COLOR_KEYS, IMAGE_KEYS, sniffImage, sniffFont, checkImage, checkFont, checkSound,
  sanitizeColors, cleanName, cleanText, folderName
} = require('../src/services/themes');
const SOUND = require('../public/js/sound-options');
const S = require('../test-support/samples');
const { ROOT } = require('../test-support/harness');

const refuses = (fn, pattern, status) => assert.throws(fn, (error) => error instanceof ThemeError && pattern.test(error.message) && (status === undefined || error.status === status), String(pattern));

describe('what a design may hold', () => {
  it('knows which variables and picture slots a design can set', () => {
    assert.ok(COLOR_KEYS.includes('--accent'));
    assert.ok(COLOR_KEYS.includes('--trainer-a'));
    assert.deepEqual(IMAGE_KEYS, ['logoImage', 'backgroundImage', 'trainerAAvatar', 'trainerBAvatar', 'prizeCardBack', 'cardBackImage', 'energySymbols']);
  });

  it('keeps the colors it knows and drops everything else', () => {
    assert.deepEqual(sanitizeColors({ '--accent': ' #ff0000 ', '--nonsense': 'red', '--bg-panel': '', '--radius': '12px' }), { '--accent': '#ff0000', '--radius': '12px' });
    assert.deepEqual(sanitizeColors(undefined), {});
    assert.deepEqual(sanitizeColors('red'), {});
  });

  it('refuses values that could break out of a style', () => {
    for (const bad of ['red; background: url(x)', 'red}body{display:none', '<script>', 'a\\b', 'x'.repeat(201), 5]) {
      refuses(() => sanitizeColors({ '--accent': bad }), /Invalid value for --accent/);
    }
  });

  it('needs a usable name, and tidies it', () => {
    refuses(() => cleanName(''), /at least one letter or digit/);
    refuses(() => cleanName('!!!'), /at least one letter or digit/);
    refuses(() => cleanName(undefined), /needs a name/);
    assert.equal(cleanName('  Store\u0000 League  '), 'Store League');
    assert.equal(cleanName('x'.repeat(100)).length, 40);
    assert.equal(folderName('Store League!'), 'store-league');
    assert.equal(folderName('CON'), 'con-design', 'Windows would not make a folder called con');
    assert.equal(folderName('lpt1'), 'lpt1-design');
    assert.equal(cleanText('  two\n\nlines\tof   text ', 50), 'two lines of text');
    assert.equal(cleanText(42, 50), '');
  });

  it('recognises pictures by what is inside the file', () => {
    assert.equal(sniffImage(S.PNG).ext, 'png');
    assert.equal(sniffImage(S.JPG).ext, 'jpg');
    assert.equal(sniffImage(S.GIF).ext, 'gif');
    assert.equal(sniffImage(S.WEBP).ext, 'webp');
    assert.equal(sniffImage(S.SVG).ext, 'svg');
    assert.equal(sniffImage(S.SVG).mime, 'image/svg+xml');
    for (const notAPicture of [S.HTML, S.EXE, S.TEXT, S.WOFF2, S.MP3, Buffer.alloc(5)]) assert.equal(sniffImage(notAPicture), null);
  });

  it('refuses an SVG that carries scripts or links', () => {
    const svg = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`);
    for (const inner of [
      '<script>alert(1)</script>', '<rect onload="x()" width="1" height="1"/>', '<foreignObject><div/></foreignObject>',
      '<image href="https://tracker.example/pixel.png"/>', '<image xlink:href="//tracker.example/p.png"/>',
      '<style>@import url(https://x.example/a.css);</style>', '<rect style="fill:url(https://x.example/a)"/>', '<a href="javascript:alert(1)"><rect/></a>'
    ]) {
      refuses(() => sniffImage(svg(inner)), /scripts or links/);
    }
    assert.equal(sniffImage(svg('<image href="data:image/png;base64,AAAA"/><rect fill="url(#g)"/>')).ext, 'svg', 'a picture inside the file is fine');
  });

  it('recognises fonts and sounds the same way', () => {
    assert.deepEqual([S.WOFF2, S.WOFF, S.OTF, S.TTF].map((font) => sniffFont(font).ext), ['woff2', 'woff', 'otf', 'ttf']);
    for (const notAFont of [S.PNG, S.HTML, S.EXE, Buffer.alloc(3)]) assert.equal(sniffFont(notAFont), null);
    assert.equal(checkSound(S.MP3).ext, 'mp3');
    refuses(() => checkSound(S.PNG), /not a supported audio file/);
    refuses(() => checkSound(S.bigWav(1.6 * 1024 * 1024)), /too large \(1.5 MB at most\)/);
  });

  it('explains what is wrong with a file in plain words', () => {
    refuses(() => checkImage(S.HTML), /not a supported picture/);
    refuses(() => checkImage(S.bigPng(4.6 * 1024 * 1024)), /too large \(4.5 MB at most\)/);
    refuses(() => checkImage(Buffer.alloc(0)), /No picture was sent/);
    refuses(() => checkImage('data:image/png;base64,AAAA'), /No picture was sent/);
    refuses(() => checkFont(S.PNG), /not a supported font/);
    refuses(() => checkFont(undefined), /No font was sent/);
  });
});

describe('the folder a design lives in', () => {
  let dir;
  let db;
  let store;

  class MemoryDb {
    constructor() { this.values = {}; }
    getSetting(key, fallback = null) { return key in this.values ? this.values[key] : fallback; }
    setSetting(key, value) { this.values[key] = value; }
  }

  beforeEach(() => {
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'designs-'));
    db = new MemoryDb();
    store = new ThemeStore(path.join(dir, 'themes'), db);
    store.init();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const files = (name) => {
    const found = [];
    const walk = (folder, prefix = '') => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(folder, entry.name), `${prefix}${entry.name}/`);
        else found.push(`${prefix}${entry.name}`);
      }
    };
    walk(store.folderFor(name));
    return found.sort();
  };

  describe('making and keeping designs', () => {
    it('makes a design, lists it, reads it back and removes it', () => {
      assert.deepEqual(store.list(), []);
      const saved = store.save('Store League', { colors: { '--accent': '#ff4d6d' }, author: 'Mina', description: 'Neon, for Friday nights' });
      assert.equal(saved.name, 'Store League');
      assert.deepEqual(saved.colors, { '--accent': '#ff4d6d' });
      assert.equal(saved.author, 'Mina');
      assert.equal(typeof saved.version, 'number');
      store.save('Arena', {});
      assert.deepEqual(store.list(), ['Arena', 'Store League']);
      assert.deepEqual(store.get('Store League').colors, { '--accent': '#ff4d6d' });
      assert.equal(store.get('store league!').name, 'Store League', 'found by its letters and digits');
      assert.equal(store.get('Nope'), null);

      assert.equal(store.remove('Store League'), true);
      assert.equal(store.remove('Store League'), false);
      assert.deepEqual(store.list(), ['Arena']);
      assert.equal(fs.existsSync(store.folderFor('Store League')), false, 'the whole folder goes');
    });

    it('keeps a design as a folder with a plain design.json', () => {
      store.save('Store League', { colors: { '--accent': '#ff4d6d' } });
      assert.deepEqual(files('Store League'), ['design.json']);
      const text = fs.readFileSync(path.join(store.folderFor('Store League'), 'design.json'), 'utf8');
      assert.ok(text.includes('\n  "name": "Store League"'), 'indented, so people can read and edit it');
      assert.deepEqual(JSON.parse(text), { name: 'Store League', colors: { '--accent': '#ff4d6d' }, images: {}, sounds: {} });
    });

    it('changes the colors, author and description of a design, and leaves its files alone', () => {
      store.save('Store League', { colors: { '--accent': '#111111' } });
      store.setImage('Store League', 'logoImage', S.PNG);
      store.setSound('Store League', 'damage', S.MP3);

      const changed = store.save('Store League', { colors: { '--accent': '#222222' }, author: '  Mina  ', description: 'x'.repeat(500) });
      assert.deepEqual(changed.colors, { '--accent': '#222222' });
      assert.equal(changed.author, 'Mina');
      assert.equal(changed.description.length, 300);
      assert.deepEqual(Object.keys(changed.images), ['logoImage']);
      assert.deepEqual(Object.keys(changed.sounds), ['damage']);

      const cleared = store.save('Store League', { author: '', description: '' });
      assert.equal('author' in cleared, false);
      assert.equal('description' in cleared, false);
      assert.deepEqual(cleared.colors, { '--accent': '#222222' }, 'colors not mentioned are untouched');
    });

    it('refuses what is not a design', () => {
      refuses(() => store.save('x', 'text'), /must be an object/);
      refuses(() => store.save('x', [1]), /must be an object/);
      refuses(() => store.save('', {}), /at least one letter or digit/);
      refuses(() => store.save('x', { colors: { '--accent': 'red;' } }), /Invalid value/);
    });

    it('skips a damaged design instead of failing', () => {
      store.save('Good', {});
      fs.mkdirSync(path.join(store.dir, 'broken'));
      fs.writeFileSync(path.join(store.dir, 'broken', 'design.json'), '{ not json');
      fs.mkdirSync(path.join(store.dir, 'empty'));
      fs.mkdirSync(path.join(store.dir, '.adding-leftover'));
      fs.writeFileSync(path.join(store.dir, 'stray.txt'), 'hello');
      assert.deepEqual(store.list(), ['Good']);
      assert.equal(store.get('broken'), null);
    });

    it('does not trust the references written in design.json', () => {
      store.save('Store League', {});
      store.setImage('Store League', 'logoImage', S.PNG);
      const file = path.join(store.folderFor('Store League'), 'design.json');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({
        ...written,
        images: {
          logoImage: 'images/logoImage.png', // really there
          backgroundImage: 'images/backgroundImage.png', // not there
          trainerAAvatar: '../../outside.png', // out of the folder
          trainerBAvatar: 'images/logoImage.png', // another slot's file
          prizeCardBack: 'https://tracker.example/pixel.png', // from the web
          nonsenseSlot: 'images/nonsenseSlot.png'
        },
        font: 'fonts/font.exe',
        sounds: { damage: 'sounds/damage.mp3', bogusCue: 'sounds/bogusCue.mp3', ko: '../x.mp3' }
      }));
      const design = store.get('Store League');
      assert.deepEqual(design.images, { logoImage: 'images/logoImage.png' });
      assert.equal(design.font, undefined);
      assert.deepEqual(design.sounds, {});
    });

    it('can use a name Windows would not allow as a folder', () => {
      store.save('CON', { colors: { '--accent': '#123456' } });
      assert.equal(path.basename(store.folderFor('CON')), 'con-design');
      assert.equal(store.get('CON').name, 'CON');
      assert.deepEqual(store.list(), ['CON']);
    });
  });

  describe('pictures, font and sounds', () => {
    beforeEach(() => store.save('Store League', {}));

    it('puts a picture in a slot, named after the slot and the real type of the file', () => {
      const design = store.setImage('Store League', 'logoImage', S.PNG);
      assert.equal(design.images.logoImage, 'images/logoImage.png');
      assert.deepEqual(files('Store League'), ['design.json', 'images/logoImage.png']);
      assert.deepEqual(fs.readFileSync(path.join(store.folderFor('Store League'), 'images/logoImage.png')), S.PNG);

      const other = store.setImage('Store League', 'backgroundImage', S.SVG);
      assert.equal(other.images.backgroundImage, 'images/backgroundImage.svg');
    });

    it('replaces a picture, even with another type, without leaving the old file', () => {
      store.setImage('Store League', 'logoImage', S.PNG);
      const design = store.setImage('Store League', 'logoImage', S.JPG);
      assert.equal(design.images.logoImage, 'images/logoImage.jpg');
      assert.deepEqual(files('Store League'), ['design.json', 'images/logoImage.jpg']);
    });

    it('changes nothing when a file is not usable', () => {
      store.setImage('Store League', 'logoImage', S.PNG);
      const before = store.get('Store League');
      refuses(() => store.setImage('Store League', 'logoImage', S.HTML), /not a supported picture/);
      refuses(() => store.setImage('Store League', 'logoImage', S.EXE), /not a supported picture/);
      refuses(() => store.setImage('Store League', 'logoImage', S.bigPng(5 * 1024 * 1024)), /too large/);
      refuses(() => store.setImage('Store League', 'logoImage', undefined), /No picture/);
      refuses(() => store.setImage('Store League', 'nonsense', S.PNG), /no such picture slot/);
      refuses(() => store.setImage('Store League', '__proto__', S.PNG), /no such picture slot/);
      refuses(() => store.setImage('Nobody', 'logoImage', S.PNG), /does not exist/, 404);
      assert.deepEqual(store.get('Store League'), before);
      assert.deepEqual(files('Store League'), ['design.json', 'images/logoImage.png']);
    });

    it('removes a picture and its file', () => {
      store.setImage('Store League', 'logoImage', S.PNG);
      const design = store.removeImage('Store League', 'logoImage');
      assert.deepEqual(design.images, {});
      assert.deepEqual(files('Store League'), ['design.json']);
      assert.deepEqual(store.removeImage('Store League', 'logoImage').images, {}, 'removing nothing is fine');
      refuses(() => store.removeImage('Store League', 'nonsense'), /no such picture slot/);
    });

    it('keeps one font', () => {
      assert.equal(store.setFont('Store League', S.WOFF2).font, 'fonts/font.woff2');
      assert.equal(store.setFont('Store League', S.TTF).font, 'fonts/font.ttf');
      assert.deepEqual(files('Store League'), ['design.json', 'fonts/font.ttf']);
      refuses(() => store.setFont('Store League', S.PNG), /not a supported font/);
      assert.equal(store.removeFont('Store League').font, undefined);
      assert.deepEqual(files('Store League'), ['design.json']);
    });

    it('keeps a sound for any cue', () => {
      assert.equal(SOUND.KEYS.length, 16);
      assert.equal(store.setSound('Store League', 'damage', S.MP3).sounds.damage, 'sounds/damage.mp3');
      assert.equal(store.setSound('Store League', 'damage', S.WAV).sounds.damage, 'sounds/damage.wav');
      store.setSound('Store League', 'ko', S.OGG);
      assert.deepEqual(files('Store League'), ['design.json', 'sounds/damage.wav', 'sounds/ko.ogg']);
      refuses(() => store.setSound('Store League', 'damage', S.PNG), /not a supported audio file/);
      refuses(() => store.setSound('Store League', 'applause', S.MP3), /no such sound/);
      refuses(() => store.setSound('Store League', 'damage', S.bigWav(2 * 1024 * 1024)), /too large \(1.5 MB at most\)/);
      assert.deepEqual(Object.keys(store.removeSound('Store League', 'ko').sounds), ['damage']);
    });

    it('limits how much one design can hold', () => {
      for (const key of IMAGE_KEYS) store.setImage('Store League', key, S.bigPng(4.4 * 1024 * 1024));
      store.setFont('Store League', Buffer.concat([S.WOFF2, Buffer.alloc(4.4 * 1024 * 1024)]));
      const cues = SOUND.KEYS;
      let stoppedAt = null;
      for (const cue of cues) {
        try { store.setSound('Store League', cue, S.bigWav(1.4 * 1024 * 1024)); } catch (error) { stoppedAt = cue; refuses(() => { throw error; }, /size limit \(40 MB\)/); break; }
      }
      assert.ok(stoppedAt, 'it stopped before all the sounds were in');
      // replacing something already there is fine: only what is added counts
      assert.ok(store.setImage('Store League', 'logoImage', S.bigPng(4.4 * 1024 * 1024)));
    });

    it('lets only the files a design holds be asked for', () => {
      store.setImage('Store League', 'logoImage', S.PNG);
      store.setSound('Store League', 'damage', S.MP3);
      store.save('Arena', {});
      store.setImage('Arena', 'logoImage', S.JPG);

      const found = store.assetFile('Store League', 'images/logoImage.png');
      assert.equal(found.mime, 'image/png');
      assert.equal(found.root, store.folderFor('Store League'));
      assert.equal(store.assetFile('Store League', 'sounds/damage.mp3').mime, 'audio/mpeg');

      for (const ref of ['design.json', 'images/logoImage.jpg', '../arena/images/logoImage.jpg', 'images/../design.json', '/etc/passwd', 'images/backgroundImage.png', '', undefined, 5]) {
        assert.equal(store.assetFile('Store League', ref), null, String(ref));
      }
      assert.equal(store.assetFile('Nobody', 'images/logoImage.png'), null);
    });

    it('gives the overlay an address for each file, that changes when the design does', () => {
      store.setImage('Store League', 'logoImage', S.PNG);
      store.setFont('Store League', S.WOFF2);
      store.setSound('Store League', 'ko', S.MP3);
      const first = store.resolved('Store League');
      const version = store.get('Store League').version;
      assert.deepEqual(first.images, { logoImage: `/api/theme/assets/images/logoImage.png?v=${version}` });
      assert.equal(first.font, `/api/theme/assets/fonts/font.woff2?v=${version}`);
      assert.deepEqual(first.sounds, ['ko']);
      assert.deepEqual(first.colors, {});
      assert.equal(store.resolved('Nobody'), null);
    });
  });

  describe('the design on air', () => {
    it('remembers which design is on air, and falls back to the built-in look', () => {
      assert.equal(store.activeName(), null);
      assert.equal(store.active(), null);
      store.save('Store League', { colors: { '--accent': '#ff4d6d' } });
      store.setActive('Store League');
      assert.equal(store.activeName(), 'Store League');
      assert.equal(store.active().colors['--accent'], '#ff4d6d');
      assert.equal(store.isActive('store league'), true);
      assert.equal(store.isActive('Arena'), false);

      store.setActive(null);
      assert.equal(store.active(), null);
      refuses(() => store.setActive('Nobody'), /does not exist/, 404);
    });

    it('goes back to the built-in look when the design on air is removed', () => {
      store.save('Store League', {});
      store.setActive('Store League');
      store.remove('Store League');
      assert.equal(store.activeName(), null);
      assert.equal(store.active(), null);
    });

    it('offers the sounds of the design on air', () => {
      store.save('Store League', {});
      store.setSound('Store League', 'damage', S.MP3);
      store.setSound('Store League', 'ko', S.WAV);
      store.save('Arena', {});
      store.setSound('Arena', 'heal', S.OGG);

      assert.deepEqual(store.activeSounds(), {});
      assert.equal(store.activeSound('damage'), null);

      store.setActive('Store League');
      const sounds = store.activeSounds();
      assert.deepEqual(Object.keys(sounds), ['damage', 'ko']);
      assert.deepEqual([sounds.damage.mime, sounds.ko.mime], ['audio/mpeg', 'audio/wav']);
      assert.equal(sounds.damage.size, S.MP3.length);
      assert.deepEqual(store.activeSound('damage'), { buffer: S.MP3, mime: 'audio/mpeg' });
      assert.equal(store.activeSound('heal'), null, 'another design\'s sound');
      for (const cue of ['__proto__', 'constructor', 'toString', 'nonsense']) assert.equal(store.activeSound(cue), null, cue);

      store.setActive('Arena');
      assert.deepEqual(Object.keys(store.activeSounds()), ['heal']);
      assert.notEqual(sounds.damage.version, store.activeSounds().heal.version);
    });
  });

  describe('adding a design from outside', () => {
    const parts = (extra = {}) => ({
      name: 'From a package', author: 'Mina', description: 'Shared', colors: { '--accent': '#00ff88' },
      images: { logoImage: S.PNG, backgroundImage: S.JPG }, font: S.WOFF2, sounds: { damage: S.MP3, ko: S.WAV },
      ...extra
    });

    it('adds all of it at once', () => {
      const added = store.addDesign(parts());
      assert.equal(added.name, 'From a package');
      assert.deepEqual(added.colors, { '--accent': '#00ff88' });
      assert.deepEqual(files('From a package'), ['design.json', 'fonts/font.woff2', 'images/backgroundImage.jpg', 'images/logoImage.png', 'sounds/damage.mp3', 'sounds/ko.wav']);
      assert.deepEqual(store.get('From a package').images, { logoImage: 'images/logoImage.png', backgroundImage: 'images/backgroundImage.jpg' });
    });

    it('uses a free name rather than overwrite a design with the same one', () => {
      store.save('From a package', { colors: { '--accent': '#111111' } });
      assert.equal(store.addDesign(parts()).name, 'From a package 2');
      assert.equal(store.addDesign(parts()).name, 'From a package 3');
      assert.deepEqual(store.get('From a package').colors, { '--accent': '#111111' }, 'the original is untouched');
      assert.equal(store.freeName('Brand new'), 'Brand new');
      assert.equal(store.freeName('x'.repeat(40)), 'x'.repeat(40));
      store.save('x'.repeat(40), {});
      assert.equal(store.freeName('x'.repeat(40)).length, 40, 'a long name is shortened to make room for the number');
      assert.match(store.freeName('x'.repeat(40)), / 2$/);
    });

    it('can replace the design with the same name instead', () => {
      store.save('From a package', {});
      store.setImage('From a package', 'trainerAAvatar', S.PNG);
      const added = store.addDesign(parts(), { replace: true });
      assert.equal(added.name, 'From a package');
      assert.deepEqual(Object.keys(added.images), ['logoImage', 'backgroundImage'], 'the old pictures are gone');
      assert.equal(store.list().length, 1);
    });

    it('leaves nothing behind when one file is bad', () => {
      store.save('Existing', {});
      for (const bad of [
        parts({ images: { logoImage: S.PNG, backgroundImage: S.HTML } }),
        parts({ font: S.PNG }),
        parts({ sounds: { damage: S.PNG } }),
        parts({ colors: { '--accent': 'red;' } }),
        parts({ name: '' })
      ]) {
        assert.throws(() => store.addDesign(bad), ThemeError);
      }
      assert.deepEqual(store.list(), ['Existing']);
      assert.deepEqual(fs.readdirSync(store.dir).sort(), ['existing'], 'not even a half-built folder');
    });

    it('ignores slots and cues that do not exist, and keeps within the size limit', () => {
      const added = store.addDesign(parts({ images: { logoImage: S.PNG, notASlot: S.PNG }, sounds: { damage: S.MP3, notACue: S.MP3 } }));
      assert.deepEqual(Object.keys(added.images), ['logoImage']);
      assert.deepEqual(Object.keys(added.sounds), ['damage']);
      const huge = Object.fromEntries(IMAGE_KEYS.map((key) => [key, S.bigPng(4.4 * 1024 * 1024)]));
      refuses(() => store.addDesign(parts({ name: 'Huge', images: huge, font: Buffer.concat([S.WOFF2, Buffer.alloc(4.4 * 1024 * 1024)]), sounds: Object.fromEntries(SOUND.KEYS.map((cue) => [cue, S.bigWav(1.4 * 1024 * 1024)])) })), /too large \(40 MB/);
      assert.equal(store.get('Huge'), null);
    });

    it('hands over a design with its files, for a package', () => {
      store.addDesign(parts());
      const { design, files: held } = store.exportDesign('From a package');
      assert.equal(design.name, 'From a package');
      assert.equal('version' in design, false);
      assert.deepEqual(held.map((file) => file.ref).sort(), ['fonts/font.woff2', 'images/backgroundImage.jpg', 'images/logoImage.png', 'sounds/damage.mp3', 'sounds/ko.wav']);
      assert.deepEqual(held.find((file) => file.ref === 'images/logoImage.png').data, S.PNG);
      refuses(() => store.exportDesign('Nobody'), /does not exist/, 404);
    });
  });

  describe('designs saved by an earlier version', () => {
    const legacy = (extra = {}) => ({
      name: 'Old League',
      colors: { '--accent': '#ff0000' },
      images: {
        logoImage: `data:image/png;base64,${S.PNG.toString('base64')}`,
        backgroundImage: 'https://example.com/background.jpg', // a web address cannot be kept
        prizeCardBack: `data:image/jpeg;base64,${S.JPG.toString('base64')}`,
        nonsense: `data:image/png;base64,${S.PNG.toString('base64')}`
      },
      font: `data:font/woff2;base64,${S.WOFF2.toString('base64')}`,
      ...extra
    });

    it('turns a one-file design into a folder, keeping the file as a backup', () => {
      fs.writeFileSync(path.join(store.dir, 'old-league.json'), JSON.stringify(legacy()));
      const result = store.init();
      assert.deepEqual(result, { converted: ['Old League'], failed: [] });

      const design = store.get('Old League');
      assert.deepEqual(design.colors, { '--accent': '#ff0000' });
      assert.deepEqual(design.images, { logoImage: 'images/logoImage.png', prizeCardBack: 'images/prizeCardBack.jpg' });
      assert.equal(design.font, 'fonts/font.woff2');
      assert.deepEqual(files('Old League'), ['design.json', 'fonts/font.woff2', 'images/logoImage.png', 'images/prizeCardBack.jpg']);
      assert.deepEqual(fs.readFileSync(path.join(store.folderFor('Old League'), 'images/logoImage.png')), S.PNG);
      assert.ok(fs.existsSync(path.join(store.dir, 'old-league.json.old')));
      assert.equal(fs.existsSync(path.join(store.dir, 'old-league.json')), false);
      assert.deepEqual(store.list(), ['Old League']);
      assert.deepEqual(store.init(), { converted: [], failed: [] }, 'nothing left to do the next time');
    });

    it('reports a file it cannot convert and carries on with the rest', () => {
      fs.writeFileSync(path.join(store.dir, 'broken.json'), '{ nope');
      fs.writeFileSync(path.join(store.dir, 'bad-picture.json'), JSON.stringify(legacy({ name: 'Bad Picture', images: { logoImage: `data:image/png;base64,${S.HTML.toString('base64')}` } })));
      fs.writeFileSync(path.join(store.dir, 'fine.json'), JSON.stringify(legacy({ name: 'Fine' })));
      const result = store.init();
      assert.deepEqual(result.converted, ['Fine']);
      assert.deepEqual(result.failed.map((failure) => failure.file).sort(), ['bad-picture.json', 'broken.json']);
      assert.deepEqual(store.list(), ['Fine']);
      assert.ok(fs.existsSync(path.join(store.dir, 'broken.json')), 'a file that failed is left where it is');
    });

    it('does not overwrite a design that already has the name', () => {
      store.save('Old League', { colors: { '--accent': '#00ff00' } });
      fs.writeFileSync(path.join(store.dir, 'old-league.json'), JSON.stringify(legacy()));
      const result = store.init();
      assert.deepEqual(result.converted, []);
      assert.equal(result.failed.length, 1);
      assert.deepEqual(store.get('Old League').colors, { '--accent': '#00ff00' });
    });

    it('imports a design from a file in the old format', () => {
      const design = store.importLegacy(legacy());
      assert.equal(design.name, 'Old League');
      assert.deepEqual(Object.keys(design.images), ['logoImage', 'prizeCardBack']);
      assert.equal(store.importLegacy(legacy({ colors: { '--accent': '#0000ff' } })).colors['--accent'], '#0000ff', 'importing again replaces it');
      assert.equal(store.list().length, 1);
      refuses(() => store.importLegacy('nope'), /must be an object/);
      refuses(() => store.importLegacy({ colors: {} }), /needs a name/);
    });
  });
});
