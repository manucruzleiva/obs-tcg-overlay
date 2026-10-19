/**
 * Designs ("themes"): checking what is sent, and the folder of files each design is kept in.
 * (Through the server: designs-server.test.js.)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ThemeStore, ThemeError, COLOR_KEYS, IMAGE_KEYS, sniffImage, sniffFont, checkImage, checkFont, checkSound, checkCss,
  sanitizeColors, cleanName, cleanText, folderName, MIME
} = require('../../src/services/themes');
const SOUND = require('../../public/js/sound-options');
const cssRules = require('../../public/js/theme-css');
const S = require('../support/samples');
const { ROOT } = require('../support/harness');

const refuses = (fn, pattern, status) => assert.throws(fn, (error) => error instanceof ThemeError && pattern.test(error.message) && (status === undefined || error.status === status), String(pattern));

describe('what a design may hold', () => {
  it('knows which variables and picture slots a design can set', () => {
    assert.ok(COLOR_KEYS.includes('--accent'));
    assert.ok(COLOR_KEYS.includes('--trainer-a'));
    assert.deepEqual(IMAGE_KEYS, ['logoImage', 'backgroundImage', 'trainerAAvatar', 'trainerBAvatar', 'prizeCardBack', 'cardBackImage', 'energySymbols', 'statusSymbols',
      'spaceFrame1', 'spaceFrame2', 'spaceFrame3', 'spaceFrame4', 'spaceFrame5', 'spaceFrame6']);
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

  it('refuses values that would make the overlay load a picture, from the web or not, and keeps gradients', () => {
    for (const bad of ['url(https://tracker.example/x.png)', 'url(//tracker.example/x)', 'URL(images/logoImage.png)', 'image-set("https://tracker.example/x.png" 1x)',
      '-webkit-image-set(url(//tracker.example/a) 1x)', 'linear-gradient(red, blue), url(//tracker.example/b)', 'var(--x, url(//tracker.example/c))', 'red !important']) {
      refuses(() => sanitizeColors({ '--bg-panel': bad }), /^Invalid value for --bg-panel: /);
    }
    assert.deepEqual(sanitizeColors({ '--bg-panel': 'linear-gradient(135deg, rgba(10,14,24,.9), transparent)' }), { '--bg-panel': 'linear-gradient(135deg, rgba(10,14,24,.9), transparent)' });
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

  it('takes a style sheet file that is plain UTF-8 text with nothing in it that is not allowed, and says what is wrong with one that is not', () => {
    assert.equal(checkCss(Buffer.from('﻿.a { color: red }')), '.a { color: red }', 'the text, without a byte order mark');
    assert.equal(checkCss(Buffer.from('.a::before { content: "é ★" }')), '.a::before { content: "é ★" }');
    refuses(() => checkCss(undefined), /No style sheet was sent/);
    refuses(() => checkCss('.a{}'), /No style sheet was sent/);
    refuses(() => checkCss(Buffer.alloc(0)), /No style sheet was sent/);
    refuses(() => checkCss(Buffer.alloc(256 * 1024 + 1, 0x20)), /^The style sheet is too large \(256 KB at most\)$/);
    refuses(() => checkCss(Buffer.from([0x2e, 0x61, 0x7b, 0xff, 0xfe, 0x7d])), /^The style sheet is not plain text \(save it as UTF-8\)$/);
    refuses(() => checkCss(Buffer.from('.a { color: red }\n@import "x.css";')), /^Line 2: @import is not allowed \(a design can only use the files it carries\)\.$/);
    assert.equal(MIME.css, 'text/css; charset=utf-8');
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

    it('leaves out only the color that is not allowed any more, and keeps the others when the design is saved again', () => {
      // (a design saved before url() was refused in its colors, by OTO itself or by hand)
      store.save('Neon League', { colors: { '--accent': '#ff4d6d' }, author: 'Mina' });
      const file = path.join(store.folderFor('Neon League'), 'design.json');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      written.colors = {
        '--accent': '#ff4d6d', '--trainer-a': '#3b82f6', '--trainer-b': '#ef4444',
        '--bg-panel': 'url(https://cdn.example/panel-texture.png) center / cover', '--bg-card': 'red; display: none'
      };
      fs.writeFileSync(file, JSON.stringify(written));
      const kept = { '--accent': '#ff4d6d', '--trainer-a': '#3b82f6', '--trainer-b': '#ef4444' };
      assert.deepEqual(store.get('Neon League').colors, kept);
      assert.deepEqual(store.save('Neon League', { author: 'Mina K' }).colors, kept, 'saving something else keeps them');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).colors, kept);
      store.setImage('Neon League', 'logoImage', S.PNG);
      assert.deepEqual(store.get('Neon League').colors, kept);
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
      for (const key of IMAGE_KEYS.slice(0, 8)) store.setImage('Store League', key, S.bigPng(4.4 * 1024 * 1024));
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

  describe('the style sheet', () => {
    const SHEET = '/* Store League: the logo glows */\n.logo {\n  background: url(images/css-glow.png) center / contain;\n  animation: glow 2s infinite;\n}\n@keyframes glow { 50% { opacity: .5 } }\n';
    const stylesFile = (name) => path.join(store.folderFor(name), 'styles.css');
    beforeEach(() => store.save('Store League', {}));

    it('is kept as it was written, comments and all, says it is there in design.json, and comes back to the editor', () => {
      const before = store.get('Store League').version;
      const saved = store.save('Store League', { css: SHEET });
      assert.equal(saved.styles, 'styles.css');
      assert.equal('css' in saved, false, 'its text is not in the design itself');
      assert.deepEqual(files('Store League'), ['design.json', 'styles.css']);
      assert.equal(fs.readFileSync(stylesFile('Store League'), 'utf8'), SHEET);
      assert.equal(JSON.parse(fs.readFileSync(path.join(store.folderFor('Store League'), 'design.json'), 'utf8')).styles, 'styles.css');
      assert.equal(store.cssOf('Store League'), SHEET);
      assert.deepEqual(store.forEditor('Store League'), { ...store.get('Store League'), css: SHEET });
      assert.equal(store.forEditor('Nobody'), null);
      assert.equal(store.cssOf('Nobody'), '');
      assert.ok(store.get('Store League').version >= before);
    });

    it('is handed to the overlay checked again and written anew, with the address of each of the design\'s files in it', () => {
      store.save('Store League', { css: SHEET });
      let resolved = store.resolved('Store League');
      assert.equal(resolved.css, '#stage .logo{animation:glow 2s infinite}\n@keyframes glow{\n50%{opacity:.5}\n}', 'a picture it does not have is left out');
      store.setImage('Store League', 'css-glow', S.PNG);
      const { version } = store.get('Store League');
      resolved = store.resolved('Store League');
      assert.equal(resolved.css, `#stage .logo{background:url("/api/theme/assets/images/css-glow.png?v=${version}") center / contain;animation:glow 2s infinite}\n@keyframes glow{\n50%{opacity:.5}\n}`);
      assert.equal(resolved.images['css-glow'], `/api/theme/assets/images/css-glow.png?v=${version}`, 'and the picture is one of the design\'s, so the overlay has it as var(--css-glow) too');
      assert.match(store.resolved('Store League', { byName: true }).css, new RegExp(`url\\("/api/theme/assets/images/css-glow\\.png\\?v=${version}&design=Store%20League"\\)`));
      store.save('Arena', {});
      assert.equal('css' in store.resolved('Arena'), false, 'a design without a style sheet has none');
    });

    it('writes the same style sheet once, and again when it or the design changes', () => {
      store.save('Store League', { css: '.a { color: red }' });
      const sanitize = cssRules.sanitizeCss;
      let written = 0;
      cssRules.sanitizeCss = (...args) => { written++; return sanitize(...args); };
      try {
        for (let n = 0; n < 3; n++) assert.equal(store.resolved('Store League').css, '#stage .a{color:red}');
        assert.equal(written, 1);
        assert.equal(store.resolved('Store League', { byName: true }).css, '#stage .a{color:red}');
        assert.equal(written, 2, 'the addresses are not the same for a screen');
        fs.writeFileSync(path.join(store.folderFor('Store League'), 'styles.css'), '.a { color: blue }');
        assert.equal(store.resolved('Store League').css, '#stage .a{color:blue}', 'changed by hand');
        store.setImage('Store League', 'css-x', S.PNG);
        store.resolved('Store League');
        assert.equal(written, 4, 'a new version of the design');
      } finally {
        cssRules.sanitizeCss = sanitize;
      }
    });

    it('only lets the style sheet use the pictures and fonts the design holds, never its sounds', () => {
      store.setImage('Store League', 'logoImage', S.PNG);
      store.setFont('Store League', S.WOFF2);
      store.setSound('Store League', 'damage', S.MP3);
      store.save('Store League', { css: '.a { background: url(images/logoImage.png) } @font-face { font-family: X; src: url(fonts/font.woff2), url(fonts/names.woff2) } .b { background: url(images/css-gone.png); color: red }' });
      const { version } = store.get('Store League');
      assert.equal(store.resolved('Store League').css, `#stage .a{background:url("/api/theme/assets/images/logoImage.png?v=${version}")}\n@font-face{font-family:X}\n#stage .b{color:red}`, 'a src with a font it does not have is left out');
      refuses(() => store.save('Store League', { css: '.a { background: url(sounds/damage.mp3) }' }), /url\(sounds\/damage\.mp3\) is not one of the design's files/);
    });

    it('checks a style sheet changed by hand again before the overlay gets it, and leaves out what is not allowed', () => {
      store.save('Store League', { css: '.a { color: red }' });
      fs.writeFileSync(stylesFile('Store League'), '﻿body { background: #000 } .a { background: url(https://tracker.example/a) } @import "x.css"; .b { color: red !important }');
      assert.equal(store.resolved('Store League').css, '#stage .a{}\n#stage .b{color:red}');
      fs.writeFileSync(stylesFile('Store League'), `.a { color: red }${' '.repeat(300 * 1024)}`);
      assert.equal('css' in store.resolved('Store League'), false, 'one too large is left out');
      fs.writeFileSync(stylesFile('Store League'), Buffer.from([0x2e, 0x61, 0x7b, 0x63, 0x6f, 0x6c, 0x6f, 0x72, 0x3a, 0xff, 0x7d]));
      assert.equal(store.resolved('Store League').css, '#stage .a{color:�}', 'what is not UTF-8 is read as the replacement character');
    });

    it('refuses a style sheet with something not allowed in it, and keeps the one it had', () => {
      store.save('Store League', { css: SHEET });
      refuses(() => store.save('Store League', { css: '.a { color: red }\n\n@import "https://tracker.example/x.css";' }), /^Line 3: @import is not allowed \(a design can only use the files it carries\)\.$/, 400);
      refuses(() => store.save('Store League', { css: 'body { background: #000 }' }), /rules for body are not allowed/);
      refuses(() => store.save('Store League', { css: `.a{}${' '.repeat(256 * 1024)}` }), /^The style sheet is too large \(256 KB at most\)$/);
      refuses(() => store.save('Store League', { css: 42 }), /The style sheet must be text/);
      refuses(() => store.save('Store League', { css: '.a { color: red }', colors: { '--accent': 'url(//x)' } }), /Invalid value for --accent/);
      assert.equal(fs.readFileSync(stylesFile('Store League'), 'utf8'), SHEET, 'nothing was written');
      refuses(() => store.save('Brand New', { css: '@import "x.css";' }), /@import is not allowed/);
      assert.equal(store.get('Brand New'), null, 'a design is not made with a style sheet that cannot be kept');
    });

    it('stays when other things are saved, and goes when it is emptied', () => {
      store.save('Store League', { css: SHEET });
      store.save('Store League', { colors: { '--accent': '#ff0000' }, author: 'Mina' });
      assert.equal(store.cssOf('Store League'), SHEET, 'only "css" changes the style sheet');
      const emptied = store.save('Store League', { css: '' });
      assert.equal('styles' in emptied, false);
      assert.deepEqual(files('Store League'), ['design.json']);
      assert.equal(store.forEditor('Store League').css, '');
      assert.equal('css' in store.resolved('Store League'), false);
      assert.equal(store.save('Store League', { css: '' }).name, 'Store League', 'emptying none is fine');
    });

    it('does not trust what design.json says about it', () => {
      const file = path.join(store.folderFor('Store League'), 'design.json');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...written, styles: 'styles.css' }));
      assert.equal(store.get('Store League').styles, undefined, 'not there');
      fs.writeFileSync(path.join(store.folderFor('Store League'), 'other.css'), '.a{}');
      for (const styles of ['other.css', '../styles.css', 'images/styles.css', 5]) {
        fs.writeFileSync(file, JSON.stringify({ ...written, styles }));
        assert.equal(store.get('Store League').styles, undefined, String(styles));
      }
    });

    it('is part of the design: counted in its size, handed over for a package, and served to the editor as CSS', () => {
      store.save('Store League', { css: SHEET });
      assert.equal(store.totalBytes(store.get('Store League')), Buffer.byteLength(SHEET));
      const { files: held } = store.exportDesign('Store League');
      assert.deepEqual(held.map((file) => file.ref), ['styles.css']);
      assert.equal(held[0].data.toString('utf8'), SHEET);
      const found = store.assetFile('Store League', 'styles.css');
      assert.equal(found.mime, 'text/css; charset=utf-8');
      for (const key of IMAGE_KEYS.slice(0, 8)) store.setImage('Store League', key, S.bigPng(4.4 * 1024 * 1024));
      store.setFont('Store League', Buffer.concat([S.WOFF2, Buffer.alloc(4.4 * 1024 * 1024)]));
      store.setSound('Store League', 'damage', S.bigWav(0.3 * 1024 * 1024)); // (about 100 KB are left)
      refuses(() => store.save('Store League', { css: `${SHEET}/*${'x'.repeat(200 * 1024)}*/` }), /size limit \(40 MB\)/);
      assert.equal(store.cssOf('Store League'), SHEET);
    });
  });

  describe('pictures for the style sheet', () => {
    beforeEach(() => store.save('Store League', {}));

    it('takes pictures with names of the designer\'s choosing, kept with the others', () => {
      const design = store.setImage('Store League', 'css-glow', S.PNG);
      assert.equal(design.images['css-glow'], 'images/css-glow.png');
      store.setImage('Store League', 'css-0-paper-texture', S.SVG);
      assert.deepEqual(files('Store League'), ['design.json', 'images/css-0-paper-texture.svg', 'images/css-glow.png']);
      assert.deepEqual(Object.keys(store.get('Store League').images), ['css-glow', 'css-0-paper-texture']);
      assert.deepEqual(Object.keys(store.removeImage('Store League', 'css-glow').images), ['css-0-paper-texture']);
      assert.deepEqual(store.exportDesign('Store League').files.map((file) => file.ref), ['images/css-0-paper-texture.svg']);
    });

    it('refuses a name that is not one, and a picture that is not one', () => {
      for (const key of ['css-', 'css-A', 'css-_x', '-css-x', `css-${'a'.repeat(33)}`, 'css-a.png', 'css-a/b', 'CSS-a']) {
        refuses(() => store.setImage('Store League', key, S.PNG), /no such picture slot/);
        refuses(() => store.removeImage('Store League', key), /no such picture slot/);
      }
      assert.ok(store.setImage('Store League', `css-${'a'.repeat(32)}`, S.PNG));
      refuses(() => store.setImage('Store League', 'css-glow', S.HTML), /not a supported picture/);
    });

    it('takes 24 of them at most, and a picture can still be replaced', () => {
      for (let n = 0; n < 24; n++) store.setImage('Store League', `css-p${n}`, S.PNG);
      refuses(() => store.setImage('Store League', 'css-one-more', S.PNG), /^A design can have at most 24 pictures for its style sheet\.$/);
      assert.equal(store.setImage('Store League', 'css-p3', S.JPG).images['css-p3'], 'images/css-p3.jpg');
      assert.ok(store.setImage('Store League', 'logoImage', S.PNG), 'the other slots do not count');
      store.removeImage('Store League', 'css-p0');
      assert.ok(store.setImage('Store League', 'css-one-more', S.PNG).images['css-one-more']);
    });

    it('does not trust the names written in design.json', () => {
      store.setImage('Store League', 'css-glow', S.PNG);
      const file = path.join(store.folderFor('Store League'), 'design.json');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...written, images: { 'css-glow': 'images/css-glow.png', 'css-other': 'images/css-glow.png', 'css-gone': 'images/css-gone.png', 'css-Bad': 'images/css-Bad.png', 'css-up': '../css-up.png' } }));
      assert.deepEqual(store.get('Store League').images, { 'css-glow': 'images/css-glow.png' });
      fs.writeFileSync(file, JSON.stringify({ ...written, images: ['images/css-glow.png'] }));
      assert.deepEqual(store.get('Store League').images, {});
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
      const huge = Object.fromEntries(IMAGE_KEYS.slice(0, 8).map((key) => [key, S.bigPng(4.4 * 1024 * 1024)]));
      refuses(() => store.addDesign(parts({ name: 'Huge', images: huge, font: Buffer.concat([S.WOFF2, Buffer.alloc(4.4 * 1024 * 1024)]), sounds: Object.fromEntries(SOUND.KEYS.map((cue) => [cue, S.bigWav(1.4 * 1024 * 1024)])) })), /too large \(40 MB/);
      assert.equal(store.get('Huge'), null);
    });

    it('brings its style sheet, byte for byte, and the pictures for it', () => {
      const css = Buffer.from('﻿/* from a package */\n.logo { background: url(images/css-glow.png) }\r\n');
      const added = store.addDesign(parts({ css, images: { logoImage: S.PNG, 'css-glow': S.PNG, 'css-paper': S.JPG, 'css-Nope': S.PNG } }));
      assert.equal(added.styles, 'styles.css');
      assert.deepEqual(Object.keys(added.images), ['logoImage', 'css-glow', 'css-paper'], 'a name that is not one is left out, like an unknown slot');
      assert.deepEqual(fs.readFileSync(path.join(store.folderFor(added.name), 'styles.css')), css);
      assert.equal(store.cssOf(added.name), '/* from a package */\n.logo { background: url(images/css-glow.png) }\r\n');
      assert.match(store.resolved(added.name).css, /^#stage \.logo\{background:url\("\/api\/theme\/assets\/images\/css-glow\.png\?v=\d+"\)\}$/);
    });

    it('adds nothing when its style sheet has something not allowed in it, is not text, or has too many pictures', () => {
      store.save('Existing', {});
      const many = Object.fromEntries(Array.from({ length: 25 }, (unused, n) => [`css-p${n}`, S.PNG]));
      for (const [bad, pattern] of [
        [parts({ css: Buffer.from('.a { color: red }\n.b { background: url(https://tracker.example/b) }') }), /^Line 2: a web address is not allowed in url\(\)/],
        [parts({ css: Buffer.from('@import "x.css";') }), /@import is not allowed/],
        [parts({ css: Buffer.from([0xc3, 0x28]) }), /not plain text/],
        [parts({ css: Buffer.alloc(300 * 1024, 0x20) }), /too large \(256 KB at most\)/],
        [parts({ images: many }), /^A design can have at most 24 pictures for its style sheet\.$/]
      ]) {
        refuses(() => store.addDesign(bad), pattern);
      }
      assert.deepEqual(store.list(), ['Existing']);
      assert.deepEqual(fs.readdirSync(store.dir).sort(), ['existing'], 'not even a half-built folder');
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
      assert.deepEqual(store.importLegacy(legacy({ colors: { '--accent': '#0000ff', '--bg-panel': 'url(https://cdn.example/x.png)' } })).colors, { '--accent': '#0000ff' },
        'a color that is not allowed any more is left out on its own');
      refuses(() => store.importLegacy('nope'), /must be an object/);
      refuses(() => store.importLegacy({ colors: {} }), /needs a name/);
    });
  });
});
