/**
 * What a design can say about the layout of the overlay and about cropping the Pokémon cards.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ThemeStore, ThemeError, sanitizeLayout, sanitizeCrop, sanitizePrize } = require('../src/services/themes');
const THEME = require('../public/js/theme-options');
const { cleanRect } = require('../public/js/theme-rules');
const { startServer, ROOT } = require('../test-support/harness');

const refuses = (fn, pattern) => assert.throws(fn, (error) => error instanceof ThemeError && pattern.test(error.message), String(pattern));

describe('the layout of a design', () => {
  it('lists the pieces of the overlay a design can move, each with a way to find it', () => {
    assert.equal(new Set(THEME.BLOCK_KEYS).size, THEME.BLOCK_KEYS.length, 'every key once');
    for (const key of ['logo', 'scoreboard', 'trainerA', 'trainerB', 'trainerA.prizes', 'trainerB.bench', 'trainerA.active', 'features', 'stadium', 'toasts']) {
      assert.ok(THEME.BLOCK_KEYS.includes(key), key);
    }
    for (const block of THEME.BLOCKS) {
      assert.ok(block.label && block.selector, block.key);
      assert.doesNotMatch(block.selector, /[;{}]/);
    }
  });

  it('keeps what moved and leaves out what did not', () => {
    assert.deepEqual(sanitizeLayout({ scoreboard: { x: 10.4, y: -20.6, scale: 1.256 } }), { scoreboard: { x: 10, y: -21, scale: 1.26 } });
    assert.deepEqual(sanitizeLayout({ scoreboard: { x: 0, y: 0, scale: 1 }, logo: {} }), {}, 'a piece that has not moved is not listed');
    assert.deepEqual(sanitizeLayout({ stadium: { x: 5 } }), { stadium: { x: 5, y: 0, scale: 1 } }, 'what is missing is the usual');
    assert.deepEqual(sanitizeLayout(undefined), {});
    assert.deepEqual(sanitizeLayout(null), {});
  });

  it('refuses nonsense when asked to be strict, and drops it otherwise', () => {
    const bad = [
      { nowhere: { x: 1, y: 1, scale: 1 } }, { scoreboard: 'left' }, { scoreboard: { x: 'far', y: 0, scale: 1 } }, { scoreboard: { x: 5000, y: 0, scale: 1 } },
      { scoreboard: { x: 0, y: -1921, scale: 1 } }, { scoreboard: { x: 0, y: 0, scale: 0.1 } }, { scoreboard: { x: 0, y: 0, scale: 5 } }, { scoreboard: { x: NaN, y: 0, scale: 1 } },
      { scoreboard: [1, 2, 3] }, { __proto__: { scoreboard: { x: 1 } } }
    ];
    for (const layout of bad.slice(0, 9)) {
      assert.throws(() => sanitizeLayout(layout, { strict: true }), ThemeError, JSON.stringify(layout));
      assert.deepEqual(sanitizeLayout(layout), {}, JSON.stringify(layout));
    }
    refuses(() => sanitizeLayout([], { strict: true }), /must be an object/);
    refuses(() => sanitizeLayout({ nowhere: {} }, { strict: true }), /no piece of the overlay called "nowhere"/);
    refuses(() => sanitizeLayout({ scoreboard: { x: 9999, y: 0, scale: 1 } }, { strict: true }), /between -1920 and 1920.*between 0\.2 and 4/);
    assert.deepEqual(sanitizeLayout(JSON.parse('{"__proto__":{"x":1},"constructor":{"x":1}}')), {}, 'names that are not pieces are ignored');
    assert.equal(Object.prototype.x, undefined);
  });

  it('keeps one good piece when another is bad, unless strict', () => {
    const mixed = { scoreboard: { x: 5, y: 5, scale: 1 }, logo: { x: 'no' } };
    assert.deepEqual(sanitizeLayout(mixed), { scoreboard: { x: 5, y: 5, scale: 1 } });
    assert.throws(() => sanitizeLayout(mixed, { strict: true }), ThemeError);
  });
});

// a part of the card that is neither the whole card nor the artwork
const OWN = { x: 0.1, y: 0.1, w: 0.8, h: 0.4 };
const WHOLE = { x: 0, y: 0, w: 1, h: 1 };

describe('the crop of a design', () => {
  it('knows the usual crops, which all fit inside the card', () => {
    assert.deepEqual(THEME.CROP_PRESETS.map((preset) => preset.key), ['full', 'art', 'top']);
    for (const preset of THEME.CROP_PRESETS) {
      const { x, y, w, h } = preset.rect;
      assert.ok(x >= 0 && y >= 0 && x + w <= 1 && y + h <= 1 && w >= THEME.CROP_MIN_SIZE && h >= THEME.CROP_MIN_SIZE, preset.key);
    }
    assert.deepEqual(THEME.CROP_PRESETS[0].rect, WHOLE, 'the whole card is the first');
    assert.deepEqual(THEME.CROP_PRESETS[1].rect, THEME.CROP_DEFAULT, 'and the picture of the Pokémon is the usual');
    assert.deepEqual(THEME.CROP_DEFAULT, { x: 0.07, y: 0.115, w: 0.86, h: 0.385 });
  });

  it('keeps a part of the card, rounded; the artwork is how it already is, the whole card has to be asked for', () => {
    assert.deepEqual(sanitizeCrop({ active: { x: 0.1, y: 0.1, w: 0.8, h: 0.3999999 } }), { active: OWN });
    assert.deepEqual(sanitizeCrop({ active: { x: 0.07, y: 0.115, w: 0.86, h: 0.3849999 }, bench: THEME.CROP_DEFAULT }), {}, 'the artwork is not listed');
    assert.deepEqual(sanitizeCrop({ active: WHOLE, bench: WHOLE }), { active: WHOLE, bench: WHOLE }, 'the whole card is a choice, so it is kept');
    assert.deepEqual(sanitizeCrop({ active: WHOLE, bench: OWN }), { active: WHOLE, bench: OWN });
    assert.deepEqual(sanitizeCrop({ bench: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } }), { bench: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } });
    assert.deepEqual(sanitizeCrop({ active: { x: 0.5, y: 0.5, w: 0.5000001, h: 0.5 } }).active.w, 0.5, 'a rounding overshoot is trimmed to the edge');
    assert.deepEqual(sanitizeCrop(undefined), {});
  });

  it('refuses a part that is not on the card, or too small, when asked to be strict', () => {
    const bad = [
      { active: { x: -0.1, y: 0, w: 0.5, h: 0.5 } }, { active: { x: 0.6, y: 0, w: 0.5, h: 0.5 } }, { active: { x: 0, y: 0.6, w: 0.5, h: 0.5 } },
      { active: { x: 0, y: 0, w: 0.04, h: 0.5 } }, { active: { x: 0, y: 0, w: 0.5, h: 0.01 } }, { active: { x: 0, y: 0, w: 0.5 } },
      { active: { x: '0', y: 0, w: 0.5, h: 0.5 } }, { active: 'art' }, { active: null }, { active: { x: 0, y: 0, w: Infinity, h: 1 } }
    ];
    for (const crop of bad) {
      assert.deepEqual(sanitizeCrop(crop), {}, JSON.stringify(crop));
      if (crop.active !== null) assert.throws(() => sanitizeCrop(crop, { strict: true }), ThemeError, JSON.stringify(crop));
    }
    refuses(() => sanitizeCrop({ active: { x: 0.6, y: 0, w: 0.5, h: 0.5 } }, { strict: true }), /fractions of the card.*at least 5%.*inside the card/);
    refuses(() => sanitizeCrop({ hand: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { strict: true }), /no crop called "hand"/);
    refuses(() => sanitizeCrop([], { strict: true }), /must be an object/);
  });
});

describe('the crop of the Stadium', () => {
  const USUAL = { x: 0.082, y: 0.145, w: 0.836, h: 0.37 };

  it('is the picture window of a Stadium card unless the design says otherwise, which starts lower than a Pokémon\'s', () => {
    assert.deepEqual(THEME.STADIUM_CROP_DEFAULT, USUAL);
    assert.ok(THEME.STADIUM_CROP_DEFAULT.y > THEME.CROP_DEFAULT.y, 'a Trainer card has its title row above the picture');
    assert.deepEqual(THEME.STADIUM_PRESETS.map((preset) => preset.key), ['full', 'art', 'top']);
    assert.deepEqual(THEME.STADIUM_PRESETS[0].rect, WHOLE);
    assert.deepEqual(THEME.STADIUM_PRESETS[1].rect, USUAL, 'the picture is the usual');
    for (const preset of THEME.STADIUM_PRESETS) assert.ok(cleanRect(preset.rect), `${preset.key} is on the card`);
  });

  it('is kept when it is something else, and not listed when it is the usual, which is not the usual of a Pokémon', () => {
    assert.deepEqual(sanitizeCrop({ stadium: USUAL }), {}, 'the picture of the Stadium is not listed');
    assert.deepEqual(sanitizeCrop({ stadium: THEME.CROP_DEFAULT }), { stadium: THEME.CROP_DEFAULT }, 'a Pokémon\'s window is something else for a Stadium');
    assert.deepEqual(sanitizeCrop({ active: USUAL }), { active: USUAL }, 'and the Stadium\'s window is something else for a Pokémon');
    assert.deepEqual(sanitizeCrop({ stadium: WHOLE }), { stadium: WHOLE }, 'the whole card is asked for by name');
    assert.deepEqual(sanitizeCrop({ stadium: { x: 0.0805, y: 0.1455, w: 0.8365, h: 0.3695 } }), {}, 'near enough is the usual');
  });

  it('is refused when it is not on the card, with the names it can be written under', () => {
    refuses(() => sanitizeCrop({ stadium: { x: 0.5, y: 0, w: 0.8, h: 0.5 } }, { strict: true }), /"stadium" needs x, y, w and h|The crop for "stadium" needs/);
    refuses(() => sanitizeCrop({ hand: WHOLE }, { strict: true }), /use "active", "bench", "stadium" or "energy"/);
    assert.deepEqual(sanitizeCrop({ stadium: { x: 0.5, y: 0, w: 0.8, h: 0.5 } }), {}, 'a file written by hand with one is not refused, only left out');
  });

  it('is saved with a design, handed to the overlay and carried in a package', () => {
    const store = new ThemeStore(fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'stadium-crop-')), { getSetting: () => null, setSetting() {} });
    store.init();
    try {
      const saved = store.save('Arena', { crop: { stadium: { x: 0.03, y: 0.065, w: 0.94, h: 0.455 } } });
      assert.deepEqual(saved.crop.stadium, { x: 0.03, y: 0.065, w: 0.94, h: 0.455 });
      assert.deepEqual(store.resolved('Arena').crop.stadium, saved.crop.stadium);
      assert.deepEqual(store.exportDesign('Arena').design.crop.stadium, saved.crop.stadium);
      assert.equal('crop' in store.save('Arena', { crop: { stadium: USUAL } }), false, 'the usual is the same as saying nothing');
      assert.deepEqual(store.addDesign({ name: 'From A Package', crop: { stadium: WHOLE, active: THEME.CROP_DEFAULT } }).crop, { stadium: WHOLE });
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });
});

describe('the picture on the prize cards (a design\'s prizeStyle)', () => {
  it('is one of four: what the design has now, an English or a Japanese card back, or a Poké Ball', () => {
    assert.deepEqual(THEME.PRIZE_KEYS, ['current', 'english', 'japanese', 'pokeball']);
    assert.equal(THEME.PRIZE_DEFAULT, 'current');
    assert.deepEqual(THEME.PRIZE_STYLES.map((style) => style.key), THEME.PRIZE_KEYS);
    assert.ok(THEME.PRIZE_STYLES.every((style) => style.label && style.help));
  });

  it('is kept when it is one of them, and not listed when it is the usual', () => {
    for (const style of ['english', 'japanese', 'pokeball']) assert.equal(sanitizePrize(style), style);
    assert.equal(sanitizePrize('current'), '', 'the usual is the same as saying nothing');
    for (const nothing of [undefined, null, '']) assert.equal(sanitizePrize(nothing), '');
  });

  it('is refused when it is not one of them, with the list, and dropped from a file written by hand', () => {
    for (const bad of ['spanish', 'Pokeball', 7, true, ['english'], {}]) {
      assert.equal(sanitizePrize(bad), '', JSON.stringify(bad));
      refuses(() => sanitizePrize(bad, { strict: true }), /The prize cards can show: "current", "english", "japanese", "pokeball"/);
    }
  });

  it('is saved with a design, handed to the overlay, carried in a package and forgotten when it goes back to the usual', () => {
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    const store = new ThemeStore(fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'prize-style-')), { getSetting: () => null, setSetting() {} });
    store.init();
    try {
      const saved = store.save('Cards', { prizeStyle: 'japanese' });
      assert.equal(saved.prizeStyle, 'japanese');
      assert.equal(JSON.parse(fs.readFileSync(path.join(store.folderFor('Cards'), 'design.json'), 'utf8')).prizeStyle, 'japanese');
      assert.equal(new ThemeStore(store.dir, { getSetting: () => null, setSetting() {} }).get('Cards').prizeStyle, 'japanese', 'still there after a restart');
      assert.equal(store.resolved('Cards').prizeStyle, 'japanese');
      assert.equal(store.exportDesign('Cards').design.prizeStyle, 'japanese');

      assert.equal(store.save('Cards', { colors: { '--accent': '#112233' } }).prizeStyle, 'japanese', 'a save about something else leaves it alone');
      refuses(() => store.save('Cards', { prizeStyle: 'klingon' }), /The prize cards can show/);
      assert.equal(store.get('Cards').prizeStyle, 'japanese', 'and a refusal changes nothing');

      assert.equal(store.addDesign({ name: 'From A Package', prizeStyle: 'pokeball' }).prizeStyle, 'pokeball');
      assert.equal('prizeStyle' in store.addDesign({ name: 'Odd Package', prizeStyle: 'nonsense' }), false, 'what is not one of them is left out of a package');

      const back = store.save('Cards', { prizeStyle: 'current' });
      assert.equal('prizeStyle' in back, false);
      assert.equal('prizeStyle' in store.resolved('Cards'), false);
      assert.equal('prizeStyle' in JSON.parse(fs.readFileSync(path.join(store.folderFor('Cards'), 'design.json'), 'utf8')), false);
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });
});

describe('the circle for Special Energy', () => {
  it('is a third crop, a circle in the middle of the picture window unless the design says otherwise', () => {
    assert.deepEqual(THEME.CROP_KEYS, ['active', 'bench', 'stadium', 'energy']);
    const { x, y, w, h } = THEME.ENERGY_CIRCLE;
    assert.ok(Math.abs(w * 300 - h * 418) < 1, 'a circle: as many pixels across as down');
    assert.ok(Math.abs(x + w / 2 - 0.5) < 0.001, 'in the middle across');
    assert.ok(Math.abs(y + h / 2 - (THEME.CROP_PRESETS[1].rect.y + THEME.CROP_PRESETS[1].rect.h / 2)) < 0.001, 'and in the middle of the picture window');
    assert.deepEqual(sanitizeCrop({ energy: THEME.ENERGY_CIRCLE }), {}, 'the usual circle is not listed');
  });

  it('is kept as a circle whatever height it was written with', () => {
    assert.deepEqual(sanitizeCrop({ energy: { x: 0.3, y: 0.2, w: 0.4 } }), { energy: { x: 0.3, y: 0.2, w: 0.4, h: 0.287 } }, 'the height is worked out');
    assert.deepEqual(sanitizeCrop({ energy: { x: 0.3, y: 0.2, w: 0.4, h: 0.9 } }).energy.h, 0.287, 'and a height that was given is not trusted');
    assert.deepEqual(sanitizeCrop({ energy: { x: 0.1, y: 0.1, w: 0.2 }, active: OWN }).active.w, 0.8, 'next to the other crops');
  });

  it('refuses a circle that does not fit on the card, or is too small, when strict', () => {
    for (const energy of [{ x: 0.8, y: 0.1, w: 0.4 }, { x: 0.1, y: 0.8, w: 0.5 }, { x: 0.1, y: 0.1, w: 0.02 }, { x: -0.1, y: 0.1, w: 0.3 }, { x: 0.1, y: 0.1 }, 'round']) {
      assert.deepEqual(sanitizeCrop({ energy }), {}, JSON.stringify(energy));
      assert.throws(() => sanitizeCrop({ energy }, { strict: true }), (error) => error instanceof ThemeError && /is a circle/.test(error.message), JSON.stringify(energy));
    }
  });

  it('is saved with a design and handed to the overlay', () => {
    const store = new ThemeStore(fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'circle-')), { getSetting: () => null, setSetting() {} });
    store.init();
    try {
      const saved = store.save('Round', { crop: { energy: { x: 0.25, y: 0.1, w: 0.5 } } });
      assert.deepEqual(saved.crop.energy, { x: 0.25, y: 0.1, w: 0.5, h: 0.359 });
      assert.deepEqual(store.resolved('Round').crop.energy, saved.crop.energy);
      assert.equal('crop' in store.save('Round', { crop: { energy: THEME.ENERGY_CIRCLE } }), false, 'the usual circle is the same as saying nothing');
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });
});

describe('saving a design with a layout and a crop', () => {
  let dir;
  let store;
  const db = (() => { const values = {}; return { getSetting: (key, fallback = null) => (key in values ? values[key] : fallback), setSetting: (key, value) => { values[key] = value; } }; })();

  beforeEach(() => {
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'layout-'));
    store = new ThemeStore(dir, db);
    store.init();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const LAYOUT = { scoreboard: { x: 0, y: 40, scale: 1.1 }, 'trainerA.prizes': { x: -30, y: 10, scale: 1 } };
  const CROP = { active: OWN, bench: { x: 0.05, y: 0.05, w: 0.9, h: 0.5 } };

  it('keeps them in design.json and gives them back', () => {
    const saved = store.save('Store League', { colors: {}, layout: LAYOUT, crop: CROP });
    assert.deepEqual(saved.layout, LAYOUT);
    assert.deepEqual(saved.crop, CROP);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store-league', 'design.json'), 'utf8'));
    assert.deepEqual(onDisk.layout, LAYOUT);
    assert.deepEqual(onDisk.crop, CROP);
    assert.deepEqual(new ThemeStore(dir, db).get('Store League').layout, LAYOUT, 'still there after a restart');
  });

  it('leaves them alone when a save is about something else', () => {
    store.save('Store League', { layout: LAYOUT, crop: CROP });
    const later = store.save('Store League', { colors: { '--accent': '#ff0000' }, author: 'Mina' });
    assert.deepEqual(later.layout, LAYOUT);
    assert.deepEqual(later.crop, CROP);
    assert.equal(later.colors['--accent'], '#ff0000');
  });

  it('forgets them when they are saved empty', () => {
    store.save('Store League', { layout: LAYOUT, crop: CROP });
    const cleared = store.save('Store League', { layout: {}, crop: { active: THEME.CROP_DEFAULT, bench: THEME.CROP_DEFAULT } });
    assert.equal('layout' in cleared, false);
    assert.equal('crop' in cleared, false, 'the artwork is the usual: nothing to keep');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store-league', 'design.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['colors', 'images', 'name', 'sounds']);
  });

  it('keeps the whole card when a design asks for it, since the artwork is what it gets otherwise', () => {
    const saved = store.save('Full Cards', { crop: { active: WHOLE, bench: WHOLE } });
    assert.deepEqual(saved.crop, { active: WHOLE, bench: WHOLE });
    assert.deepEqual(new ThemeStore(dir, db).get('Full Cards').crop, { active: WHOLE, bench: WHOLE }, 'still there after a restart');
    assert.deepEqual(store.resolved('Full Cards').crop, { active: WHOLE, bench: WHOLE });
    assert.deepEqual(store.save('Full Cards', { crop: { active: THEME.CROP_DEFAULT, bench: WHOLE } }).crop, { bench: WHOLE }, 'one back to the artwork');
  });

  it('refuses a bad layout or crop and changes nothing', () => {
    store.save('Store League', { layout: LAYOUT, crop: CROP });
    refuses(() => store.save('Store League', { layout: { scoreboard: { x: 99999, y: 0, scale: 1 } } }), /between -1920 and 1920/);
    refuses(() => store.save('Store League', { crop: { active: { x: 2, y: 0, w: 1, h: 1 } } }), /inside the card/);
    const kept = store.get('Store League');
    assert.deepEqual(kept.layout, LAYOUT);
    assert.deepEqual(kept.crop, CROP);
  });

  it('drops a layout or crop written by hand that makes no sense, without losing the design', () => {
    store.save('Store League', { colors: { '--accent': '#00ff00' } });
    const file = path.join(dir, 'store-league', 'design.json');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    written.layout = { scoreboard: { x: 7, y: 8, scale: 1 }, nowhere: { x: 1 }, logo: { x: 'a' } };
    written.crop = { active: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, bench: 'no' };
    fs.writeFileSync(file, JSON.stringify(written));
    const read = store.get('Store League');
    assert.deepEqual(read.layout, { scoreboard: { x: 7, y: 8, scale: 1 } });
    assert.deepEqual(read.crop, { active: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
    assert.equal(read.colors['--accent'], '#00ff00');
  });

  it('hands them to the overlay with the design on air', () => {
    store.save('Store League', { layout: LAYOUT, crop: CROP });
    const resolved = store.resolved('Store League');
    assert.deepEqual(resolved.layout, LAYOUT);
    assert.deepEqual(resolved.crop, CROP);
    store.save('Plain', { colors: {} });
    assert.equal('layout' in store.resolved('Plain'), false);
    assert.equal('crop' in store.resolved('Plain'), false);
  });

  it('travels with the design in a package, checked on the way in', () => {
    store.save('Store League', { layout: LAYOUT, crop: CROP });
    const exported = store.exportDesign('Store League');
    assert.deepEqual(exported.design.layout, LAYOUT);
    assert.deepEqual(exported.design.crop, CROP);

    const added = store.addDesign({ name: 'From A Package', layout: { ...LAYOUT, nowhere: { x: 1 } }, crop: { active: CROP.active, bench: { x: 9, y: 9, w: 9, h: 9 } } });
    assert.deepEqual(added.layout, LAYOUT, 'what is not a piece of the overlay is left out');
    assert.deepEqual(added.crop, { active: CROP.active }, 'and a crop that is not on the card');
  });
});

describe('through the server', () => {
  let server;
  before(async () => { server = await startServer({ label: 'layout-crop' }); });
  after(async () => { if (server) await server.stop(); });

  const call = async (method, route, body) => {
    const response = await fetch(`${server.base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  it('saves them through the API, hands them to the overlay, and says why when refusing', async () => {
    const saved = await call('PUT', '/api/themes/Crop%20Test', { layout: { scoreboard: { x: 5, y: 6, scale: 1.5 } }, crop: { active: OWN } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.layout, { scoreboard: { x: 5, y: 6, scale: 1.5 } });
    assert.deepEqual((await call('GET', '/api/themes/Crop%20Test')).json.crop, { active: OWN });

    await call('POST', '/api/theme/active', { name: 'Crop Test' });
    const overlay = await call('GET', '/api/theme');
    assert.deepEqual(overlay.json.theme.layout, { scoreboard: { x: 5, y: 6, scale: 1.5 } });
    assert.deepEqual(overlay.json.theme.crop.active, OWN);

    const refused = await call('PUT', '/api/themes/Crop%20Test', { layout: { scoreboard: { x: 1, y: 1, scale: 50 } } });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /scale between 0\.2 and 4/);
    assert.deepEqual((await call('GET', '/api/themes/Crop%20Test')).json.layout, { scoreboard: { x: 5, y: 6, scale: 1.5 } }, 'nothing changed');
    await call('DELETE', '/api/themes/Crop%20Test');
  });
});

describe('the tile of a design', () => {
  const { sanitizeTile } = require('../src/services/themes');

  it('knows where each part of a Pokémon\'s tile can go, and the usual places', () => {
    assert.deepEqual(THEME.TILE_KEYS, ['active', 'bench']);
    assert.deepEqual(THEME.TILE_PARTS.map((part) => part.key), ['hp', 'energy', 'retreat', 'status']);
    assert.deepEqual(THEME.TILE_DEFAULT, { hp: 'top', energy: 'bottom-left', retreat: 'bottom-right', status: 'top-right' }, 'the HP bar on top, the energy at the bottom left, the retreat cost at the bottom right and the status icons at the top right');
    for (const part of THEME.TILE_PARTS) {
      assert.ok(part.places.includes(THEME.TILE_DEFAULT[part.key]), `${part.key} can be where it usually is`);
      assert.ok(part.places.includes('below'), `${part.key} can go below the picture`);
      for (const place of part.places) assert.ok(THEME.TILE_PLACES[place], `${place} has a name`);
    }
  });

  it('keeps only what differs from the usual, and drops what is not understood', () => {
    assert.deepEqual(sanitizeTile({ active: { hp: 'bottom', energy: 'bottom-left', retreat: 'top-right' }, bench: { hp: 'top' } }), { active: { hp: 'bottom', retreat: 'top-right' } });
    assert.deepEqual(sanitizeTile({ active: { hp: 'left', energy: 'below', mood: 'top' }, nobody: { hp: 'below' }, bench: 'below' }), { active: { energy: 'below' } });
    assert.deepEqual(sanitizeTile({ active: { status: 'below' }, bench: { status: 'top-right' } }), { active: { status: 'below' } }, 'the status icons can go below the picture; the top right is where they usually are');
    assert.deepEqual(sanitizeTile({ active: { status: 'top' } }), {}, 'but not in the middle of an edge: they are not a bar');
    assert.deepEqual(sanitizeTile(undefined), {});
    assert.deepEqual(sanitizeTile(null), {});
    assert.deepEqual(sanitizeTile([]), {});
    assert.deepEqual(sanitizeTile({ active: { hp: 'top' } }), {}, 'the usual place is not listed');
  });

  it('says what is wrong when asked to be strict', () => {
    refuses(() => sanitizeTile({ active: { hp: 'left' } }, { strict: true }), /"hp" can go in one of these places: top, bottom, below/);
    refuses(() => sanitizeTile({ active: { retreat: 'middle' } }, { strict: true }), /"retreat" can go in one of these places: top-left, top-right, bottom-left, bottom-right, below/);
    refuses(() => sanitizeTile({ active: { mood: 'top' } }, { strict: true }), /no part of a tile called "mood" \(use "hp", "energy", "retreat", "status"\)/);
    refuses(() => sanitizeTile({ hand: { hp: 'top' } }, { strict: true }), /no tile called "hand" \(use "active" or "bench"\)/);
    refuses(() => sanitizeTile({ active: 'below' }, { strict: true }), /The tile for "active" must be an object/);
    refuses(() => sanitizeTile([], { strict: true }), /must be an object/);
  });

  describe('saved with a design', () => {
    let dir;
    let store;
    const db = (() => { const values = {}; return { getSetting: (key, fallback = null) => (key in values ? values[key] : fallback), setSetting: (key, value) => { values[key] = value; } }; })();
    beforeEach(() => {
      fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
      dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'tile-'));
      store = new ThemeStore(dir, db);
      store.init();
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const TILE = { active: { hp: 'bottom', retreat: 'top-right' }, bench: { energy: 'below' } };

    it('is kept in design.json, handed to the overlay and left alone by other saves', () => {
      const saved = store.save('Store League', { tile: TILE });
      assert.deepEqual(saved.tile, TILE);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'store-league', 'design.json'), 'utf8')).tile, TILE);
      assert.deepEqual(new ThemeStore(dir, db).get('Store League').tile, TILE, 'still there after a restart');
      assert.deepEqual(store.resolved('Store League').tile, TILE);
      assert.deepEqual(store.save('Store League', { author: 'Mina' }).tile, TILE, 'a save about something else leaves it');
      store.save('Plain', { colors: {} });
      assert.equal('tile' in store.resolved('Plain'), false);
    });

    it('is forgotten when it is saved as the usual places', () => {
      store.save('Store League', { tile: TILE });
      const cleared = store.save('Store League', { tile: { active: { hp: 'top', energy: 'bottom-left' } } });
      assert.equal('tile' in cleared, false);
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'store-league', 'design.json'), 'utf8'))).sort(), ['colors', 'images', 'name', 'sounds']);
    });

    it('is refused when it makes no sense, changing nothing; and dropped when it was written by hand', () => {
      store.save('Store League', { tile: TILE });
      refuses(() => store.save('Store League', { tile: { active: { hp: 'sideways' } } }), /"hp" can go in one of these places/);
      assert.deepEqual(store.get('Store League').tile, TILE);

      const file = path.join(dir, 'store-league', 'design.json');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      written.tile = { active: { hp: 'below', energy: 'nowhere' }, bench: 5 };
      fs.writeFileSync(file, JSON.stringify(written));
      assert.deepEqual(store.get('Store League').tile, { active: { hp: 'below' } });
    });

    it('travels with the design in a package, checked on the way in', () => {
      store.save('Store League', { tile: TILE });
      assert.deepEqual(store.exportDesign('Store League').design.tile, TILE);
      const added = store.addDesign({ name: 'From A Package', tile: { active: { hp: 'below', energy: 'diagonal' }, bench: { retreat: 'below' } } });
      assert.deepEqual(added.tile, { active: { hp: 'below' }, bench: { retreat: 'below' } }, 'what is not a place is left out');
    });
  });
});
