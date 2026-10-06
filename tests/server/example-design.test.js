/**
 * The built-in look written out as a design (docs/examples/built-in-look/design.json), for designers to learn from: it has to stay what the
 * overlay really looks like, and be a design that OTO takes as it is.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const THEME = require('../../public/js/theme-options');
const RULES = require('../../public/js/theme-rules');
const { ThemeStore } = require('../../src/services/themes');
const { ROOT } = require('../support/harness');

const design = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'examples', 'built-in-look', 'design.json'), 'utf8'));
const tokens = fs.readFileSync(path.join(ROOT, 'public', 'css', 'tokens.css'), 'utf8');
const root = tokens.slice(tokens.indexOf(':root {'));
const valueOf = (key) => new RegExp(`${key.replace(/-/g, '\\-')}:\\s*([^;]+);`).exec(root)[1].trim();

describe('the built-in look as a design to learn from', () => {
  it('has every color a design can change, each at the value the overlay has without a design', () => {
    assert.deepEqual(Object.keys(design.colors).sort(), THEME.COLOR_KEYS.slice().sort());
    for (const key of THEME.COLOR_KEYS) assert.equal(design.colors[key], valueOf(key), key);
  });

  it('has the usual fonts of the overlay', () => {
    assert.equal(design.fontFamilies.display, valueOf('--font-display'));
    assert.equal(design.fontFamilies.text, valueOf('--font-body'));
    assert.deepEqual(RULES.sanitizeFontFamilies(design.fontFamilies, { strict: true }), design.fontFamilies);
  });

  it('says everything else at its usual value, which a design leaves out: so it takes nothing of them', () => {
    assert.deepEqual(RULES.sanitizeLayout(design.layout, { strict: true }), {}, 'a piece that has not moved');
    assert.deepEqual(RULES.sanitizeCrop(design.crop, { strict: true }), {}, 'the usual crop of every card');
    assert.deepEqual(RULES.sanitizeTile(design.tile, { strict: true }), {}, 'the usual places of the parts of a tile');
    assert.equal(RULES.sanitizePrize(design.prizeStyle, { strict: true }), '');
    assert.equal(RULES.sanitizePrizeLayout(design.prizeLayout, { strict: true }), '');
    assert.equal(RULES.sanitizeOrientation(design.orientation, { strict: true }), '');
    assert.deepEqual(RULES.sanitizeSpaces(design.spaces, { strict: true }), []);
    assert.deepEqual(RULES.sanitizeColors(design.colors), design.colors, 'and every color is a value that is allowed');
  });

  it('is kept as a design by OTO, with the colors and the fonts, and nothing else to remember', () => {
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    const store = new ThemeStore(fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'example-')), { getSetting: () => null, setSetting() {} });
    store.init();
    try {
      const saved = store.save(design.name, design);
      assert.deepEqual(saved.colors, design.colors);
      assert.deepEqual(saved.fontFamilies, design.fontFamilies);
      for (const left of ['layout', 'crop', 'tile', 'prizeStyle', 'prizeLayout', 'orientation', 'spaces']) assert.equal(left in saved, false, left);
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });
});
