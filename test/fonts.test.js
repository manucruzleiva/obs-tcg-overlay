/**
 * A font for each group of text of the overlay: the list of groups, the fonts to use, the files, and how a design keeps and shares them.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ThemeStore, ThemeError, sanitizeFontFamilies } = require('../src/services/themes');
const THEME = require('../public/js/theme-options');
const S = require('../test-support/samples');
const { ROOT } = require('../test-support/harness');

const refuses = (fn, pattern) => assert.throws(fn, (error) => error instanceof ThemeError && pattern.test(error.message), String(pattern));
const nothing = { getSetting: () => null, setSetting() {} };
const withStore = (fn) => {
  fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
  const store = new ThemeStore(fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'fonts-')), nothing);
  store.init();
  try { return fn(store); } finally { fs.rmSync(store.dir, { recursive: true, force: true }); }
};

describe('the groups of text of the overlay', () => {
  it('are the main font and six more, each with a label, a help and the variable the overlay reads', () => {
    assert.deepEqual(THEME.FONT_ROLE_KEYS, ['display', 'names', 'numbers', 'labels', 'banners', 'subtitles', 'text']);
    for (const role of THEME.FONT_ROLES) {
      assert.ok(role.label && role.help, role.key);
      assert.match(role.variable, /^--font-[a-z]+$/);
    }
    assert.equal(THEME.FONT_ROLES[0].variable, '--font-display');
    assert.equal(THEME.FONT_ROLES.at(-1).variable, '--font-body');
  });

  it('are all used by the overlay, each by its own variable, with the usual font as the fallback', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'overlay.css'), 'utf8');
    for (const role of ['names', 'numbers', 'labels', 'banners', 'subtitles']) {
      assert.match(css, new RegExp(`var\\(--font-${role}, var\\(--font-(display|body)\\)\\)`), role);
    }
    assert.doesNotMatch(css, /font: [^;]*var\(--font-display\);/, 'no rule uses the main font by itself any more');
  });
});

describe('the fonts to use for a group of text', () => {
  it('are kept as they are written when they only use what a list of fonts is made of', () => {
    assert.deepEqual(sanitizeFontFamilies({ names: ' Impact, "Arial Black", sans-serif ', numbers: "Bahnschrift, 'Segoe UI'", labels: 'Comic Neue' }),
      { names: 'Impact, "Arial Black", sans-serif', numbers: "Bahnschrift, 'Segoe UI'", labels: 'Comic Neue' });
    assert.deepEqual(sanitizeFontFamilies({ names: 'Noto Sans JP, 源ノ角ゴシック' }), { names: 'Noto Sans JP, 源ノ角ゴシック' }, 'any letters');
    for (const nothingAtAll of [undefined, null, {}, { names: '' }, { names: '   ' }]) assert.deepEqual(sanitizeFontFamilies(nothingAtAll), {});
  });

  it('drop anything else when a file was written by hand, and say what is wrong when they are sent through the editor or the API', () => {
    for (const bad of ['url(http://x/f.woff)', 'a;b', 'a{}', 'a<b', 'a\\b', 'x'.repeat(161), 42, ['Impact'], {}]) {
      assert.deepEqual(sanitizeFontFamilies({ names: bad }), {}, JSON.stringify(bad));
    }
    assert.deepEqual(sanitizeFontFamilies({ names: 'Impact', nothing: 'Arial', display: 'Arial' }), { names: 'Impact', display: 'Arial' }, 'a group nobody knows is ignored');
    assert.deepEqual(sanitizeFontFamilies('Impact'), {});
    refuses(() => sanitizeFontFamilies({ names: 'a;b' }, { strict: true }), /The fonts for "names" can use letters, digits, spaces, commas/);
    refuses(() => sanitizeFontFamilies({ nothing: 'Arial' }, { strict: true }), /There is no group of text called "nothing" \(use "display", "names"/);
    refuses(() => sanitizeFontFamilies('Impact', { strict: true }), /must be an object/);
    refuses(() => sanitizeFontFamilies({ names: 'x'.repeat(161) }, { strict: true }), /160 characters/);
  });
});

describe('the font files of a design', () => {
  it('go with a group of text, are checked like the main font, and are removed with a click', () => withStore((store) => {
    store.save('Type', { colors: {} });
    let design = store.setFontRole('Type', 'names', S.WOFF2);
    assert.deepEqual(design.fonts, { names: 'fonts/names.woff2' });
    design = store.setFontRole('Type', 'numbers', S.WOFF2);
    design = store.setFontRole('Type', 'display', S.WOFF2);
    assert.equal(design.font, 'fonts/font.woff2', 'the main font is the one it always was');
    assert.deepEqual(Object.keys(design.fonts).sort(), ['names', 'numbers']);
    assert.deepEqual(fs.readdirSync(path.join(store.folderFor('Type'), 'fonts')).sort(), ['font.woff2', 'names.woff2', 'numbers.woff2']);

    refuses(() => store.setFontRole('Type', 'names', S.PNG), /not a supported font/);
    refuses(() => store.setFontRole('Type', 'nothing', S.WOFF2), /no such group of text/);
    refuses(() => store.removeFontRole('Type', 'nothing'), /no such group of text/);

    // a restart finds them, and so does the overlay (an address for each)
    const again = new ThemeStore(store.dir, nothing);
    assert.deepEqual(again.get('Type').fonts, { names: 'fonts/names.woff2', numbers: 'fonts/numbers.woff2' });
    const resolved = store.resolved('Type');
    assert.match(resolved.fonts.names, /^\/api\/theme\/assets\/fonts\/names\.woff2\?v=\d+$/);
    assert.match(resolved.font, /fonts\/font\.woff2/);

    design = store.removeFontRole('Type', 'names');
    assert.deepEqual(Object.keys(design.fonts), ['numbers']);
    design = store.removeFontRole('Type', 'numbers');
    assert.equal('fonts' in design, false, 'no fonts is not written down');
    design = store.removeFontRole('Type', 'display');
    assert.equal('font' in design, false);
    assert.deepEqual(fs.readdirSync(path.join(store.folderFor('Type'), 'fonts')), []);
    assert.equal('fonts' in store.resolved('Type'), false);
  }));

  it('are counted in the size of the design, served by name, and only the ones the design has', () => withStore((store) => {
    store.save('Type', { colors: {} });
    store.setFontRole('Type', 'labels', S.WOFF2);
    assert.ok(store.assetFile('Type', 'fonts/labels.woff2'));
    assert.equal(store.assetFile('Type', 'fonts/names.woff2'), null, 'a font it does not have');
    assert.ok(store.totalBytes(store.get('Type')) >= S.WOFF2.length);
  }));

  it('are not taken from a file that names something else: only fonts/<group>.<type> of a group that exists', () => withStore((store) => {
    store.save('Type', { colors: {} });
    const folder = store.folderFor('Type');
    fs.mkdirSync(path.join(folder, 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'fonts', 'names.woff2'), S.WOFF2);
    fs.writeFileSync(path.join(folder, 'fonts', 'other.woff2'), S.WOFF2);
    const file = path.join(folder, 'design.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.fonts = { names: 'fonts/names.woff2', numbers: 'fonts/missing.woff2', other: 'fonts/other.woff2', labels: '../../etc/passwd', banners: 'fonts/names.woff2' };
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.deepEqual(store.get('Type').fonts, { names: 'fonts/names.woff2' });
  }));
});

describe('the fonts to use, in a design', () => {
  it('are saved with it, handed to the overlay, exported, and forgotten when there are none', () => withStore((store) => {
    const families = { names: 'Impact, sans-serif', text: 'Georgia' };
    assert.deepEqual(store.save('Type', { fontFamilies: families }).fontFamilies, families);
    assert.deepEqual(new ThemeStore(store.dir, nothing).get('Type').fontFamilies, families, 'still there after a restart');
    assert.deepEqual(store.resolved('Type').fontFamilies, families);
    assert.deepEqual(store.exportDesign('Type').design.fontFamilies, families);
    assert.deepEqual(store.save('Type', { prizeStyle: 'english' }).fontFamilies, families, 'a save about something else leaves them alone');
    refuses(() => store.save('Type', { fontFamilies: { names: 'a;b' } }), /The fonts for "names"/);
    assert.deepEqual(store.addDesign({ name: 'From A Package', fontFamilies: families }).fontFamilies, families);
    assert.equal('fontFamilies' in store.addDesign({ name: 'Odd', fontFamilies: { names: 'url(x)' } }), false);
    assert.equal('fontFamilies' in store.save('Type', { fontFamilies: {} }), false);
    assert.equal('fontFamilies' in store.resolved('Type'), false);
  }));

  it('come with the font files when a design is added from outside, and a design that is too big is still refused', () => withStore((store) => {
    const added = store.addDesign({ name: 'From A Package', font: S.WOFF2, fonts: { names: S.WOFF2, numbers: S.WOFF2, nothing: S.WOFF2 }, fontFamilies: { labels: 'Impact' } });
    assert.deepEqual(Object.keys(added.fonts).sort(), ['names', 'numbers'], 'a group nobody knows is left out');
    assert.equal(added.font, 'fonts/font.woff2');
    assert.deepEqual(added.fontFamilies, { labels: 'Impact' });
    refuses(() => store.addDesign({ name: 'Bad Font', fonts: { names: S.PNG } }), /not a supported font/);
    assert.equal(store.get('Bad Font'), null, 'nothing half-built is left');
  }));
});
