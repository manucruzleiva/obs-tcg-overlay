/**
 * The rules for the layout and the crop of a design, in one place for the server (which refuses what
 * does not fit, or drops it when it came from a file written by hand) and the design editor (which
 * shows the same complaint while someone is typing). Loaded in the browser as OTO_THEME_RULES.
 *
 * Colors: the CSS values of a design's colors and shapes (unknown names are ignored; a value that could
 * carry anything but a color or a length is refused).
 * Layout: where each piece of the overlay is moved to and how big it is.
 *   { "scoreboard": { "x": 0, "y": 40, "scale": 1.1 } }
 * Crop: which part of the card picture shows for the Active Pokémon, the bench and the Stadium, as fractions of the card (the picture of
 * the card unless the design says otherwise), and which circle of a Special Energy card shows on the Pokémon it is attached to.
 *   { "active": { "x": 0, "y": 0, "w": 1, "h": 1 }, "energy": { "x": 0.3, "y": 0.2, "w": 0.4 } }
 * Tile: where the HP bar, the attached energy and the retreat cost go on a Pokémon's picture (or below it).
 *   { "active": { "hp": "bottom", "retreat": "top-right" } }
 * Prize style: the picture on the prize cards: "current" (usual), "english" or "japanese" card back, or a "pokeball".
 *   "pokeball"
 * Orientation: the screen: "landscape" (a wide 1920 x 1080 one, the usual) or "portrait" (a tall 1080 x 1920 one, for a phone).
 * Font families: for each group of text (see FONT_ROLES), the fonts to use, as a CSS font-family: { "names": "Impact, Arial Black, sans-serif" }.
 * Spaces: places kept clear for something else (a camera feed), each with a shape and where it is, in pixels of the stage.
 *   [ { "id": 1, "name": "Camera", "shape": "rounded", "x": 700, "y": 400, "w": 480, "h": 270 } ]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./theme-options'));
  else root.OTO_THEME_RULES = factory(root.OTO_THEME);
}(typeof self !== 'undefined' ? self : this, function (THEME) {
  const { COLOR_KEYS, BLOCK_KEYS, LAYOUT_LIMITS, CROP_KEYS, CROP_MIN_SIZE, CARD_ASPECT, ENERGY_CIRCLE, CROP_DEFAULT, STADIUM_CROP_DEFAULT, TILE_KEYS, tilePartsOf, TILE_DEFAULT, PRIZE_KEYS, PRIZE_DEFAULT, PRIZE_LAYOUT_KEYS, PRIZE_LAYOUT_DEFAULT, PRIZE_CROP_DEFAULT, ORIENTATION_KEYS, ORIENTATION_DEFAULT, SPACE_SHAPE_KEYS, SPACE_LIMITS, FONT_ROLE_KEYS, FONT_FAMILY_MAX } = THEME;
  const MAX_COLOR_LENGTH = 200;

  // A complaint that can be shown to a person as it is
  class RuleError extends Error {}

  const roundTo = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  // The colors of a design. Always strict: one bad value is refused (the server drops them all when a file has one).
  function sanitizeColors(input) {
    const colors = {};
    for (const [key, value] of Object.entries(isObject(input) ? input : {})) {
      if (!COLOR_KEYS.includes(key)) continue; // unknown variables are ignored
      if (typeof value !== 'string' || value.length > MAX_COLOR_LENGTH || /[;{}<>\\]/.test(value)) {
        throw new RuleError(`Invalid value for ${key}`);
      }
      if (value.trim()) colors[key] = value.trim();
    }
    return colors;
  }

  // Where each piece of the overlay is moved to. With `strict` a bad entry is refused with a message (the
  // editor and the API); without it, it is dropped (a design saved by hand, or one from a package, may hold anything).
  function sanitizeLayout(input, { strict = false } = {}) {
    const layout = {};
    if (input === undefined || input === null) return layout;
    if (!isObject(input)) {
      if (strict) throw new RuleError('The layout must be an object');
      return layout;
    }
    const { offset, minScale, maxScale } = LAYOUT_LIMITS;
    for (const [key, value] of Object.entries(input)) {
      if (!BLOCK_KEYS.includes(key)) {
        if (strict) throw new RuleError(`There is no piece of the overlay called "${key}"`);
        continue;
      }
      const given = isObject(value) ? value : {};
      const x = given.x === undefined ? 0 : given.x;
      const y = given.y === undefined ? 0 : given.y;
      const scale = given.scale === undefined ? 1 : given.scale;
      const fits = isObject(value) && isNumber(x) && isNumber(y) && isNumber(scale)
        && Math.abs(x) <= offset && Math.abs(y) <= offset && scale >= minScale && scale <= maxScale;
      if (!fits) {
        if (strict) throw new RuleError(`"${key}" needs x and y between -${offset} and ${offset}, and a scale between ${minScale} and ${maxScale}`);
        continue;
      }
      const entry = { x: Math.round(x), y: Math.round(y), scale: roundTo(scale, 2) };
      if (entry.x !== 0 || entry.y !== 0 || entry.scale !== 1) layout[key] = entry; // a piece that has not moved is not listed
    }
    return layout;
  }

  // A part of a card as fractions of the picture, or null when it does not make sense
  function cleanRect(value) {
    if (!isObject(value) || ![value.x, value.y, value.w, value.h].every(isNumber)) return null;
    const rect = { x: roundTo(value.x, 3), y: roundTo(value.y, 3), w: roundTo(value.w, 3), h: roundTo(value.h, 3) };
    if (rect.x < 0 || rect.y < 0 || rect.w < CROP_MIN_SIZE || rect.h < CROP_MIN_SIZE || rect.x + rect.w > 1.0005 || rect.y + rect.h > 1.0005) return null;
    rect.w = Math.min(rect.w, roundTo(1 - rect.x, 3));
    rect.h = Math.min(rect.h, roundTo(1 - rect.y, 3));
    return rect;
  }

  const isWholeCard = (rect) => rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1;

  // A circle on the card, given as the square (in pixels) that holds it: its height is worked out from its width
  function cleanCircle(value) {
    const rect = cleanRect(isObject(value) ? { ...value, h: isNumber(value.w) ? value.w / CARD_ASPECT : value.h } : value);
    if (!rect) return null;
    rect.h = roundTo(rect.w / CARD_ASPECT, 3);
    if (rect.y + rect.h > 1.0005) return null;
    return rect;
  }
  const isUsualCircle = (rect) => ['x', 'y', 'w', 'h'].every((side) => Math.abs(rect[side] - ENERGY_CIRCLE[side]) < 0.0015);
  // What a Pokémon shows when its design says nothing: the picture of the card (`usual` is the picture window of another kind of card:
  // the Stadium's)
  const isUsualCrop = (rect, usual = CROP_DEFAULT) => ['x', 'y', 'w', 'h'].every((side) => Math.abs(rect[side] - usual[side]) < 0.0015);

  // Which part of the card shows for the Active Pokémon, the bench and the Stadium
  function sanitizeCrop(input, { strict = false } = {}) {
    const crop = {};
    if (input === undefined || input === null) return crop;
    if (!isObject(input)) {
      if (strict) throw new RuleError('The crop must be an object');
      return crop;
    }
    for (const [key, value] of Object.entries(input)) {
      if (!CROP_KEYS.includes(key)) {
        if (strict) throw new RuleError(`There is no crop called "${key}" (use "active", "bench", "stadium", "prize", "tool" or "energy")`);
        continue;
      }
      const circle = key === 'energy';
      const rect = circle ? cleanCircle(value) : cleanRect(value);
      if (!rect) {
        if (strict) {
          throw new RuleError(circle
            ? 'The crop for "energy" is a circle: it needs x, y and w (the width) as fractions of the card (0 to 1), at least ' + (CROP_MIN_SIZE * 100) + '% wide, and inside the card'
            : `The crop for "${key}" needs x, y, w and h as fractions of the card (0 to 1), at least ${CROP_MIN_SIZE * 100}% wide and high, and inside the card`);
        }
        continue;
      }
      // what is usual (the picture of the card, the Stadium's own picture window, and for energy the usual circle) is not listed; the whole card is
      const usual = key === 'stadium' || key === 'tool' ? STADIUM_CROP_DEFAULT : key === 'prize' ? PRIZE_CROP_DEFAULT : CROP_DEFAULT;
      if (circle ? !isUsualCircle(rect) : !isUsualCrop(rect, usual)) crop[key] = rect;
    }
    return crop;
  }

  // Where the parts of a Pokémon's tile go, for the Active Pokémon and for the bench. Only what differs from the usual is kept.
  function sanitizeTile(input, { strict = false } = {}) {
    const tile = {};
    if (input === undefined || input === null) return tile;
    if (!isObject(input)) {
      if (strict) throw new RuleError('The tile must be an object');
      return tile;
    }
    for (const [key, value] of Object.entries(input)) {
      if (!TILE_KEYS.includes(key)) {
        if (strict) throw new RuleError(`There is no tile called "${key}" (use "active" or "bench")`);
        continue;
      }
      if (!isObject(value)) {
        if (strict) throw new RuleError(`The tile for "${key}" must be an object such as { "hp": "bottom" }`);
        continue;
      }
      const entry = {};
      for (const [part, place] of Object.entries(value)) {
        const parts = tilePartsOf(key);
        const known = parts.find((item) => item.key === part);
        if (!known) {
          if (strict) throw new RuleError(`There is no part of a tile called "${part}" for "${key}" (use ${parts.map((item) => `"${item.key}"`).join(', ')})`);
          continue;
        }
        if (!known.places.includes(place)) {
          if (strict) throw new RuleError(`"${part}" can go in one of these places: ${known.places.join(', ')}`);
          continue;
        }
        if (place !== TILE_DEFAULT[part]) entry[part] = place;
      }
      if (Object.keys(entry).length) tile[key] = entry;
    }
    return tile;
  }

  // The picture on the prize cards: one of PRIZE_KEYS. What is usual ("current") is not listed: the result is an empty string for it.
  function sanitizePrize(input, { strict = false } = {}) {
    if (input === undefined || input === null || input === '') return '';
    if (typeof input !== 'string' || !PRIZE_KEYS.includes(input)) {
      if (strict) throw new RuleError(`The prize cards can show: ${PRIZE_KEYS.map((key) => `"${key}"`).join(', ')}`);
      return '';
    }
    return input === PRIZE_DEFAULT ? '' : input;
  }

  // How the prize cards are laid out: one of PRIZE_LAYOUT_KEYS. The usual one ("row") is not listed: the result is an empty string for it.
  function sanitizePrizeLayout(input, { strict = false } = {}) {
    if (input === undefined || input === null || input === '') return '';
    if (typeof input !== 'string' || !PRIZE_LAYOUT_KEYS.includes(input)) {
      if (strict) throw new RuleError(`The prize cards can be laid out as: ${PRIZE_LAYOUT_KEYS.map((key) => `"${key}"`).join(', ')}`);
      return '';
    }
    return input === PRIZE_LAYOUT_DEFAULT ? '' : input;
  }

  // The fonts to use for each group of text: { role: "Font One, Font Two, sans-serif" }. A name is letters, digits, spaces, commas, quotes, dots,
  // dashes and underscores (what a list of fonts is made of), so it can never carry anything else into the page. Without `strict` a bad entry is
  // dropped; with it, it is refused.
  function sanitizeFontFamilies(input, { strict = false } = {}) {
    const families = {};
    if (input === undefined || input === null) return families;
    if (!isObject(input)) {
      if (strict) throw new RuleError('The font families must be an object such as { "names": "Impact, sans-serif" }');
      return families;
    }
    for (const [role, value] of Object.entries(input)) {
      if (!FONT_ROLE_KEYS.includes(role)) {
        if (strict) throw new RuleError(`There is no group of text called "${role}" (use ${FONT_ROLE_KEYS.map((key) => `"${key}"`).join(', ')})`);
        continue;
      }
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) continue; // nothing is the usual
      if (text.length > FONT_FAMILY_MAX || !/^[\p{L}\p{N} ,'"._-]+$/u.test(text)) {
        if (strict) throw new RuleError(`The fonts for "${role}" can use letters, digits, spaces, commas, quotes, dots and dashes, up to ${FONT_FAMILY_MAX} characters`);
        continue;
      }
      families[role] = text;
    }
    return families;
  }

  // The screen of the design: one of ORIENTATION_KEYS. The usual ("landscape") is not listed: the result is an empty string for it.
  function sanitizeOrientation(input, { strict = false } = {}) {
    if (input === undefined || input === null || input === '') return '';
    if (typeof input !== 'string' || !ORIENTATION_KEYS.includes(input)) {
      if (strict) throw new RuleError(`The screen can be: ${ORIENTATION_KEYS.map((key) => `"${key}"`).join(', ')}`);
      return '';
    }
    return input === ORIENTATION_DEFAULT ? '' : input;
  }

  // The reserved spaces of a design, as a list of { id, name, shape, x, y, w, h }: the id (1 to 6) says which picture is the space's frame
  // ("spaceFrame<id>"); a space without one gets the lowest that is free. Without `strict` a bad entry is dropped, with it the entry is refused.
  function sanitizeSpaces(input, { strict = false } = {}) {
    if (input === undefined || input === null) return [];
    const { max, minSize, maxSize, offset, nameLength } = SPACE_LIMITS;
    if (!Array.isArray(input)) {
      if (strict) throw new RuleError('The spaces must be a list');
      return [];
    }
    if (strict && input.length > max) throw new RuleError(`A design can have ${max} reserved spaces at most`);
    const taken = new Set();
    const spaces = [];
    input.slice(0, max).forEach((value, index) => {
      const label = `Space ${index + 1}`;
      const refuse = (message) => { if (strict) throw new RuleError(`${label}: ${message}`); };
      if (!isObject(value)) return refuse('it must be an object such as { "x": 700, "y": 400, "w": 480, "h": 270 }');
      const shape = value.shape === undefined ? 'rect' : value.shape;
      if (!SPACE_SHAPE_KEYS.includes(shape)) return refuse(`the shape can be ${SPACE_SHAPE_KEYS.map((key) => `"${key}"`).join(', ')}`);
      const numbers = {};
      for (const [key, low, high] of [['x', -offset, offset], ['y', -offset, offset], ['w', minSize, maxSize], ['h', minSize, maxSize]]) {
        const given = value[key];
        if (!isNumber(given) || given < low || given > high) return refuse(`"${key}" must be a number from ${low} to ${high}`);
        numbers[key] = Math.round(given);
      }
      if (value.name !== undefined && typeof value.name !== 'string') return refuse('the name must be text');
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      if (name.length > nameLength) return refuse(`the name can have ${nameLength} letters at most`);
      let id = value.id;
      if (id !== undefined && (!Number.isInteger(id) || id < 1 || id > max)) {
        if (strict) return refuse(`"id" must be a whole number from 1 to ${max}`);
        id = undefined;
      }
      if (id !== undefined && taken.has(id)) {
        if (strict) return refuse(`another space already has the id ${id}`);
        id = undefined;
      }
      if (id !== undefined) taken.add(id);
      spaces.push({ id, ...(name ? { name } : {}), shape, ...numbers });
    });
    // the ones with no id (or a repeated one) take the lowest free
    for (const space of spaces) {
      if (space.id !== undefined) continue;
      let id = 1;
      while (taken.has(id)) id++;
      taken.add(id);
      space.id = id;
    }
    // (id first, whatever the order they were given in)
    return spaces.map(({ id, name, shape, x, y, w, h }) => ({ id, ...(name ? { name } : {}), shape, x, y, w, h }));
  }

  return { RuleError, sanitizeColors, sanitizeLayout, sanitizeCrop, sanitizeTile, sanitizePrize, sanitizePrizeLayout, sanitizeOrientation, sanitizeSpaces, sanitizeFontFamilies, cleanRect, cleanCircle, isWholeCard, isUsualCrop, isUsualCircle, MAX_COLOR_LENGTH };
}));
