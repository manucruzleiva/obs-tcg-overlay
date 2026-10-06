/**
 * Designs: the colors, pictures, font and sounds that give the overlay its own look and feel.
 * (The code and the API call them "themes".)
 *
 * A design is a folder, so artists can open it, swap a file and share it:
 *
 *   themes/store-league/
 *     design.json            the colors and which file fills each slot
 *     images/logoImage.png   one picture per slot (logo, background, avatars, card backs, energy icons)
 *     fonts/font.woff2       the main font, for names, numbers and announcements
 *     fonts/names.woff2      a font for one group of text (names, numbers, labels, banners, subtitles, text): optional
 *     sounds/damage.mp3      a sound for any cue; used by the overlay while this design is on air
 *
 *   design.json
 *   {
 *     "name": "Store League", "author": "Mina", "description": "Neon, for Friday nights",
 *     "colors": { "--accent": "#ff4d6d", "--bg-panel": "rgba(10,10,20,0.8)" },
 *     "images": { "logoImage": "images/logoImage.png" },
 *     "font": "fonts/font.woff2",
 *     "sounds": { "damage": "sounds/damage.mp3" },
 *     "layout": { "scoreboard": { "x": 0, "y": 40, "scale": 1.1 } },
 *     "crop": { "active": { "x": 0, "y": 0, "w": 1, "h": 1 } },
 *     "tile": { "active": { "hp": "bottom" } },
 *     "prizeStyle": "english",
 *     "prizeLayout": "two-rows",
 *     "fonts": { "names": "fonts/names.woff2" },
 *     "fontFamilies": { "numbers": "Impact, Arial Black, sans-serif" },
 *     "orientation": "portrait",
 *     "spaces": [ { "id": 1, "name": "Camera", "shape": "rounded", "x": 700, "y": 400, "w": 480, "h": 270 } ]
 *   }
 *
 * "layout" moves and resizes pieces of the overlay (see BLOCKS in public/js/theme-options.js); "crop"
 * shows only part of the card picture for the Active Pokémon, the bench and the Stadium (the artwork unless it says otherwise);
 * "tile" says where the HP bar, the attached energy and the retreat cost go on that picture; "prizeStyle" is the picture on the prize
 * cards: "english" or "japanese" card back, or a "pokeball" (left out, they keep the design's card back, or have the English one);
 * "prizeLayout" is how the six are laid out: "column", "two-rows" or "three-rows" (left out, a row of six); "orientation" is the screen:
 * "portrait" for a tall mobile one (left out, a wide 1920 x 1080 one); "spaces" are places kept clear for a camera feed or the like, each with
 * a picture of its own that can be drawn over it (the image slot "spaceFrame<id>").
 *
 * Everything a design uses is a file inside its folder: nothing is fetched from the web while it is on
 * air, so it works offline, and a shared design can never make an overlay contact someone's server.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// What a design may set comes from shared lists (also used by the control panel's design editor)
const { COLOR_KEYS, IMAGE_KEYS, FONT_ROLE_KEYS } = require('../../public/js/theme-options');
const EXTRA_FONT_ROLES = FONT_ROLE_KEYS.filter((role) => role !== 'display'); // ("display" is the main font: the file `font`)
const SOUND = require('../../public/js/sound-options');
const { sniff: sniffSound, MAX_SOUND_BYTES } = require('./sounds');

const MAX_NAME = 40;
const MAX_VALUE = 200; // a color or length
const MAX_AUTHOR = 60;
const MAX_DESCRIPTION = 300;
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const MAX_FONT_BYTES = 4.5 * 1024 * 1024;
const MAX_DESIGN_BYTES = 40 * 1024 * 1024; // all the files of one design

// Windows will not make a folder with one of these names
const RESERVED_FOLDER = /^(con|prn|aux|nul|com\d|lpt\d)$/;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'svg'];
const FONT_EXTENSIONS = ['woff2', 'woff', 'otf', 'ttf'];
const SOUND_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'webm'];

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', ttf: 'font/ttf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm'
};

class ThemeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status; // what the API answers with
  }
}

// ------------------------------------------------------------------------------------- names

// The folder name for a design: letters, digits, dashes
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function cleanName(name) {
  if (typeof name !== 'string') throw new ThemeError('A design needs a name');
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
  if (!slug(clean)) throw new ThemeError('A design name needs at least one letter or digit');
  return clean;
}

function folderName(name) {
  const base = slug(cleanName(name));
  return RESERVED_FOLDER.test(base) ? `${base}-design` : base;
}

const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// ---------------------------------------------------------------------------- colors, layout and crop

// The rules live in one file shared with the design editor (public/js/theme-rules.js); a complaint
// from them is a ThemeError here, so the API answers with it.
const rules = require('../../public/js/theme-rules');

function asThemeError(work) {
  try {
    return work();
  } catch (error) {
    throw error instanceof rules.RuleError ? new ThemeError(error.message) : error;
  }
}

// The colors of a design: one bad value is refused
const sanitizeColors = (input) => asThemeError(() => rules.sanitizeColors(input));

// Where each piece of the overlay is moved to. With `strict` a bad entry is refused; otherwise it is dropped.
const sanitizeLayout = (input, options) => asThemeError(() => rules.sanitizeLayout(input, options));

// Which part of the card shows for the Active Pokémon and the bench
const sanitizeCrop = (input, options) => asThemeError(() => rules.sanitizeCrop(input, options));

// Where the HP bar, the attached energy and the retreat cost go on a Pokémon's tile
const sanitizeTile = (input, options) => asThemeError(() => rules.sanitizeTile(input, options));

// The picture on the prize cards (an empty string for the usual one)
const sanitizePrize = (input, options) => asThemeError(() => rules.sanitizePrize(input, options));
// How the prize cards are laid out (an empty string for the usual row)
const sanitizePrizeLayout = (input, options) => asThemeError(() => rules.sanitizePrizeLayout(input, options));
const sanitizeOrientation = (input, options) => asThemeError(() => rules.sanitizeOrientation(input, options));
const sanitizeSpaces = (input, options) => asThemeError(() => rules.sanitizeSpaces(input, options));
const sanitizeFontFamilies = (input, options) => asThemeError(() => rules.sanitizeFontFamilies(input, options));

// ------------------------------------------------------------------------------------- files

// A picture can be a script carrier when it is an SVG; these are never allowed in one
const UNSAFE_SVG = /<script|<foreignObject|<iframe|<embed|<object|<audio|<video|\son[a-z]+\s*=|javascript:|data:text\/html|@import|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|data:text)|url\(\s*["']?\s*(?:https?:|\/\/)/i;

// What kind of picture a file really is, from its first bytes (the name and the sender's claim are not trusted)
function sniffImage(buffer) {
  if (buffer.length < 12) return null;
  const at = (from, to) => buffer.toString('latin1', from, to);
  if (buffer[0] === 0x89 && at(1, 4) === 'PNG') return { ext: 'png', mime: MIME.png };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: MIME.jpg };
  if (at(0, 4) === 'GIF8') return { ext: 'gif', mime: MIME.gif };
  if (at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return { ext: 'webp', mime: MIME.webp };

  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 4096)).replace(/^﻿/, '').trimStart();
  if ((head.startsWith('<svg') || head.startsWith('<?xml')) && /<svg[\s>]/i.test(head)) {
    if (UNSAFE_SVG.test(buffer.toString('utf8'))) {
      throw new ThemeError('That SVG contains scripts or links, which are not allowed. Export it as plain shapes, or use a PNG.');
    }
    return { ext: 'svg', mime: MIME.svg };
  }
  return null;
}

function sniffFont(buffer) {
  if (buffer.length < 12) return null;
  const tag = buffer.toString('latin1', 0, 4);
  if (tag === 'wOF2') return { ext: 'woff2', mime: MIME.woff2 };
  if (tag === 'wOFF') return { ext: 'woff', mime: MIME.woff };
  if (tag === 'OTTO') return { ext: 'otf', mime: MIME.otf };
  if (tag === 'true' || (buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0 && buffer[3] === 0)) return { ext: 'ttf', mime: MIME.ttf };
  return null;
}

// Check a file for a slot and say what it is; explains in plain words when it cannot be used
function checkImage(buffer, label = 'The picture') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ThemeError('No picture was sent');
  if (buffer.length > MAX_IMAGE_BYTES) throw new ThemeError(`${label} is too large (4.5 MB at most)`);
  const kind = sniffImage(buffer);
  if (!kind) throw new ThemeError(`${label} is not a supported picture (use PNG, JPG, GIF, WebP or SVG)`);
  return kind;
}

function checkFont(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ThemeError('No font was sent');
  if (buffer.length > MAX_FONT_BYTES) throw new ThemeError('The font file is too large (4.5 MB at most)');
  const kind = sniffFont(buffer);
  if (!kind) throw new ThemeError('That is not a supported font (use WOFF2, WOFF, TTF or OTF)');
  return kind;
}

function checkSound(buffer, label = 'The sound') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ThemeError('No audio was sent');
  if (buffer.length > MAX_SOUND_BYTES) throw new ThemeError(`${label} is too large (1.5 MB at most)`);
  const kind = sniffSound(buffer);
  if (!kind) throw new ThemeError(`${label} is not a supported audio file (use MP3, WAV, OGG, M4A or WebM)`);
  return kind;
}

// Windows can keep a folder busy for a moment after it was deleted or while something (a virus scanner, the search
// indexer, a picture still being sent) has a file of it open. Moving a folder into place is tried again briefly.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function moveFolder(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!BUSY.has(error.code) || attempt >= 10) throw error;
      pause(30 * attempt);
    }
  }
}
const REMOVE_FOLDER = { recursive: true, force: true, maxRetries: 8, retryDelay: 40 };

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data);
  moveFolder(temp, file); // (a file is moved into place the same way: Windows may keep the old one busy for a moment)
}

// The references a design may hold: one fixed name per slot, so a reference can never point anywhere else
const imageRef = (key) => new RegExp(`^images/${key}\\.(${IMAGE_EXTENSIONS.join('|')})$`);
const fontRef = new RegExp(`^fonts/font\\.(${FONT_EXTENSIONS.join('|')})$`);
const fontRoleRef = (role) => new RegExp(`^fonts/${role}\\.(${FONT_EXTENSIONS.join('|')})$`);
// Every file a design holds (pictures, fonts, sounds): the references, as they are in design.json
const fileRefs = (design) => [...Object.values(design.images), ...Object.values(design.sounds), ...(design.font ? [design.font] : []), ...Object.values(design.fonts || {})];
const soundRef = (cue) => new RegExp(`^sounds/${cue}\\.(${SOUND_EXTENSIONS.join('|')})$`);
const extensionOf = (ref) => ref.slice(ref.lastIndexOf('.') + 1);

// ------------------------------------------------------------------------------------- store

class ThemeStore {
  // `db` remembers which design is on air
  constructor(dir, db) {
    this.dir = dir;
    this.db = db;
  }

  // Make the folder, and turn designs saved by an earlier version (one JSON file with the pictures
  // inside) into folders. Returns what happened, for the log.
  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    const converted = [];
    const failed = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json') || !fs.statSync(path.join(this.dir, file)).isFile()) continue;
      try {
        const legacy = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
        const name = cleanName(legacy.name);
        if (fs.existsSync(this.folderFor(name))) throw new ThemeError('a design with that name already exists');
        this.importLegacy(legacy);
        fs.renameSync(path.join(this.dir, file), path.join(this.dir, `${file}.old`));
        converted.push(name);
      } catch (error) {
        failed.push({ file, reason: error.message });
      }
    }
    return { converted, failed };
  }

  folderFor(name) {
    return path.join(this.dir, folderName(name));
  }

  fileFor(name) {
    return path.join(this.folderFor(name), 'design.json');
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    const names = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const design = this.readFolder(path.join(this.dir, entry.name));
      if (design) names.push(design.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  // The design in a folder, with every reference checked against the files that are really there
  readFolder(folder) {
    let raw;
    let stats;
    try {
      const file = path.join(folder, 'design.json');
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      stats = fs.statSync(file);
    } catch {
      return null; // an unreadable design is skipped rather than breaking the list
    }
    if (!raw || typeof raw !== 'object') return null;
    const exists = (ref) => fs.existsSync(path.join(folder, ref));

    let name;
    try { name = cleanName(raw.name); } catch { return null; }
    const design = { name, colors: {}, images: {}, sounds: {}, version: Math.round(stats.mtimeMs) };
    try { design.colors = sanitizeColors(raw.colors); } catch { /* a bad color is dropped */ }
    const author = cleanText(raw.author, MAX_AUTHOR);
    const description = cleanText(raw.description, MAX_DESCRIPTION);
    if (author) design.author = author;
    if (description) design.description = description;
    const layout = sanitizeLayout(raw.layout);
    const crop = sanitizeCrop(raw.crop);
    const tile = sanitizeTile(raw.tile);
    const prizeStyle = sanitizePrize(raw.prizeStyle);
    const prizeLayout = sanitizePrizeLayout(raw.prizeLayout);
    const orientation = sanitizeOrientation(raw.orientation);
    const spaces = sanitizeSpaces(raw.spaces);
    if (Object.keys(layout).length) design.layout = layout;
    if (Object.keys(crop).length) design.crop = crop;
    if (Object.keys(tile).length) design.tile = tile;
    if (prizeStyle) design.prizeStyle = prizeStyle;
    if (prizeLayout) design.prizeLayout = prizeLayout;
    if (orientation) design.orientation = orientation;
    if (spaces.length) design.spaces = spaces;

    for (const key of IMAGE_KEYS) {
      const ref = raw.images && raw.images[key];
      if (typeof ref === 'string' && imageRef(key).test(ref) && exists(ref)) design.images[key] = ref;
    }
    if (typeof raw.font === 'string' && fontRef.test(raw.font) && exists(raw.font)) design.font = raw.font;
    // a font for a group of text, and the fonts to use for it
    for (const role of EXTRA_FONT_ROLES) {
      const ref = raw.fonts && raw.fonts[role];
      if (typeof ref === 'string' && fontRoleRef(role).test(ref) && exists(ref)) (design.fonts ||= {})[role] = ref;
    }
    const fontFamilies = sanitizeFontFamilies(raw.fontFamilies);
    if (Object.keys(fontFamilies).length) design.fontFamilies = fontFamilies;
    for (const cue of SOUND.KEYS) {
      const ref = raw.sounds && raw.sounds[cue];
      if (typeof ref === 'string' && soundRef(cue).test(ref) && exists(ref)) design.sounds[cue] = ref;
    }
    return design;
  }

  get(name) {
    try {
      return this.readFolder(this.folderFor(name));
    } catch {
      return null;
    }
  }

  // Write design.json (the version number is the file's own modification time, so every change is a new version)
  store(design) {
    const { version, ...plain } = design;
    writeAtomic(this.fileFor(design.name), JSON.stringify(plain, null, 2));
    return this.get(design.name);
  }

  // Make a design, or change its colors, author, description, layout, crop, tile and prize style. Pictures, font and sounds have their own calls.
  save(name, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ThemeError('A design must be an object');
    const clean = cleanName(name ?? input.name);
    const existing = this.get(clean);
    const design = existing || { name: clean, colors: {}, images: {}, sounds: {} };
    if ('colors' in input) design.colors = sanitizeColors(input.colors);
    if ('author' in input) design.author = cleanText(input.author, MAX_AUTHOR) || undefined;
    if ('description' in input) design.description = cleanText(input.description, MAX_DESCRIPTION) || undefined;
    if ('layout' in input) design.layout = sanitizeLayout(input.layout, { strict: true });
    if ('crop' in input) design.crop = sanitizeCrop(input.crop, { strict: true });
    if ('tile' in input) design.tile = sanitizeTile(input.tile, { strict: true });
    if ('prizeStyle' in input) design.prizeStyle = sanitizePrize(input.prizeStyle, { strict: true });
    if ('prizeLayout' in input) design.prizeLayout = sanitizePrizeLayout(input.prizeLayout, { strict: true });
    if ('orientation' in input) design.orientation = sanitizeOrientation(input.orientation, { strict: true });
    if ('spaces' in input) design.spaces = sanitizeSpaces(input.spaces, { strict: true });
    if ('fontFamilies' in input) design.fontFamilies = sanitizeFontFamilies(input.fontFamilies, { strict: true });
    if (design.fontFamilies && !Object.keys(design.fontFamilies).length) delete design.fontFamilies;
    if (!design.prizeStyle) delete design.prizeStyle;
    if (!design.prizeLayout) delete design.prizeLayout;
    if (!design.orientation) delete design.orientation;
    if (design.spaces && !design.spaces.length) delete design.spaces;
    if (!design.author) delete design.author;
    if (!design.description) delete design.description;
    if (design.layout && !Object.keys(design.layout).length) delete design.layout;
    if (design.crop && !Object.keys(design.crop).length) delete design.crop;
    if (design.tile && !Object.keys(design.tile).length) delete design.tile;
    return this.store(design);
  }

  remove(name) {
    const folder = this.folderFor(name);
    const existed = fs.existsSync(folder);
    if (existed) fs.rmSync(folder, REMOVE_FOLDER);
    if (this.isActive(name)) this.setActive(null);
    return existed;
  }

  // ---- the design on air

  activeName() {
    return this.db.getSetting('activeTheme', null);
  }

  // The design the overlay should be wearing, or null for the built-in look
  active() {
    const name = this.activeName();
    return name ? this.get(name) : null;
  }

  isActive(name) {
    const active = this.activeName();
    return Boolean(active) && folderName(active) === folderName(name);
  }

  setActive(name) {
    if (name === null) {
      this.db.setSetting('activeTheme', null);
      return;
    }
    const design = this.get(name);
    if (!design) throw new ThemeError('That design does not exist', 404);
    this.db.setSetting('activeTheme', design.name);
  }

  // ---- files

  totalBytes(design) {
    const refs = fileRefs(design);
    return refs.reduce((sum, ref) => {
      try { return sum + fs.statSync(path.join(this.folderFor(design.name), ref)).size; } catch { return sum; }
    }, 0);
  }

  // Put a file in a slot: `kind` says how to check it, `ref` is where it goes. An older file in the
  // same slot (it may have been another type) is removed.
  place(name, slot, buffer, check, make, assign) {
    const design = this.get(name);
    if (!design) throw new ThemeError('That design does not exist', 404);
    const kind = check(buffer);
    const ref = make(kind.ext);
    const previous = slot(design);
    if (this.totalBytes(design) - (previous ? this.sizeOf(design.name, previous) : 0) + buffer.length > MAX_DESIGN_BYTES) {
      throw new ThemeError('This design has reached its size limit (40 MB). Remove something first.');
    }
    writeAtomic(path.join(this.folderFor(design.name), ref), buffer);
    if (previous && previous !== ref) fs.rmSync(path.join(this.folderFor(design.name), previous), { force: true });
    assign(design, ref);
    return this.store(design);
  }

  sizeOf(name, ref) {
    try { return fs.statSync(path.join(this.folderFor(name), ref)).size; } catch { return 0; }
  }

  discard(name, slot, clear) {
    const design = this.get(name);
    if (!design) throw new ThemeError('That design does not exist', 404);
    const ref = slot(design);
    if (!ref) return design;
    fs.rmSync(path.join(this.folderFor(design.name), ref), { force: true });
    clear(design);
    return this.store(design);
  }

  setImage(name, key, buffer) {
    if (!IMAGE_KEYS.includes(key)) throw new ThemeError('There is no such picture slot');
    return this.place(name, (d) => d.images[key], buffer, (b) => checkImage(b), (ext) => `images/${key}.${ext}`, (d, ref) => { d.images[key] = ref; });
  }

  removeImage(name, key) {
    if (!IMAGE_KEYS.includes(key)) throw new ThemeError('There is no such picture slot');
    return this.discard(name, (d) => d.images[key], (d) => { delete d.images[key]; });
  }

  setFont(name, buffer) {
    return this.place(name, (d) => d.font, buffer, checkFont, (ext) => `fonts/font.${ext}`, (d, ref) => { d.font = ref; });
  }

  removeFont(name) {
    return this.discard(name, (d) => d.font, (d) => { delete d.font; });
  }

  // The font file of a group of text ("names", "numbers"...); "display" is the main font
  setFontRole(name, role, buffer) {
    if (!FONT_ROLE_KEYS.includes(role)) throw new ThemeError('There is no such group of text');
    if (role === 'display') return this.setFont(name, buffer);
    return this.place(name, (d) => d.fonts && d.fonts[role], buffer, checkFont, (ext) => `fonts/${role}.${ext}`, (d, ref) => { d.fonts = { ...(d.fonts || {}), [role]: ref }; });
  }

  removeFontRole(name, role) {
    if (!FONT_ROLE_KEYS.includes(role)) throw new ThemeError('There is no such group of text');
    if (role === 'display') return this.removeFont(name);
    return this.discard(name, (d) => d.fonts && d.fonts[role], (d) => {
      delete d.fonts[role];
      if (!Object.keys(d.fonts).length) delete d.fonts;
    });
  }

  setSound(name, cue, buffer) {
    if (!SOUND.KEYS.includes(cue)) throw new ThemeError('There is no such sound');
    return this.place(name, (d) => d.sounds[cue], buffer, (b) => checkSound(b), (ext) => `sounds/${cue}.${ext}`, (d, ref) => { d.sounds[cue] = ref; });
  }

  removeSound(name, cue) {
    if (!SOUND.KEYS.includes(cue)) throw new ThemeError('There is no such sound');
    return this.discard(name, (d) => d.sounds[cue], (d) => { delete d.sounds[cue]; });
  }

  // The file behind a reference of a design: { path, mime } or null. Only references the design
  // really holds can be asked for, so nothing else in the folder is reachable by name.
  assetFile(name, ref) {
    const design = this.get(name);
    if (!design || typeof ref !== 'string') return null;
    const held = fileRefs(design);
    if (!held.includes(ref)) return null;
    return { path: path.join(this.folderFor(design.name), ref), mime: MIME[extensionOf(ref)], root: this.folderFor(design.name) };
  }

  // The design as the overlay needs it: colors, and an address for each picture and the font
  // (cues with a sound of their own are listed; the sounds themselves go through /api/sounds)
  // `byName`: the addresses of the files say which design they are of (an overlay screen that wears a design that is not the one on air)
  resolved(name, { byName = false } = {}) {
    const design = this.get(name);
    if (!design) return null;
    const url = (ref) => `/api/theme/assets/${ref}?v=${design.version}${byName ? `&design=${encodeURIComponent(design.name)}` : ''}`;
    const resolved = { name: design.name, colors: design.colors, images: {}, sounds: Object.keys(design.sounds) };
    if (design.layout) resolved.layout = design.layout;
    if (design.crop) resolved.crop = design.crop;
    if (design.tile) resolved.tile = design.tile;
    if (design.prizeStyle) resolved.prizeStyle = design.prizeStyle;
    if (design.prizeLayout) resolved.prizeLayout = design.prizeLayout;
    if (design.orientation) resolved.orientation = design.orientation;
    if (design.spaces) resolved.spaces = design.spaces;
    for (const [key, ref] of Object.entries(design.images)) resolved.images[key] = url(ref);
    if (design.font) resolved.font = url(design.font);
    if (design.fonts) resolved.fonts = Object.fromEntries(Object.entries(design.fonts).map(([role, ref]) => [role, url(ref)]));
    if (design.fontFamilies) resolved.fontFamilies = design.fontFamilies;
    return resolved;
  }

  // The sounds of the design on air: { cue: { mime, size, version } }
  activeSounds() {
    const design = this.active();
    if (!design) return {};
    const sounds = {};
    for (const [cue, ref] of Object.entries(design.sounds)) {
      sounds[cue] = { mime: MIME[extensionOf(ref)], size: this.sizeOf(design.name, ref), version: `${design.version}-${design.name}` };
    }
    return sounds;
  }

  activeSound(cue) {
    const design = this.active();
    const ref = design && Object.hasOwn(design.sounds, cue) ? design.sounds[cue] : null;
    if (!ref) return null;
    try {
      return { buffer: fs.readFileSync(path.join(this.folderFor(design.name), ref)), mime: MIME[extensionOf(ref)] };
    } catch {
      return null;
    }
  }

  // ---- sharing

  // Everything a design is made of: its description and its files (for a package)
  exportDesign(name) {
    const design = this.get(name);
    if (!design) throw new ThemeError('That design does not exist', 404);
    const { version, ...plain } = design;
    const refs = fileRefs(design);
    return { design: plain, files: refs.map((ref) => ({ ref, data: fs.readFileSync(path.join(this.folderFor(design.name), ref)) })) };
  }

  // A name nobody is using: "Store League", then "Store League 2", "Store League 3"...
  freeName(name) {
    const base = cleanName(name);
    if (!this.get(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = ` ${n}`;
      const candidate = `${base.slice(0, MAX_NAME - suffix.length).trim()}${suffix}`;
      if (!this.get(candidate)) return candidate;
    }
    throw new ThemeError('Too many designs with that name');
  }

  // Add a design from files that came from outside (a package). Everything is checked; the design appears
  // all at once or not at all. `parts`: { name, author, description, colors, images: { key: Buffer }, font: Buffer, sounds: { cue: Buffer } }
  // With `replace`, a design of the same name is overwritten; otherwise the new one gets a free name.
  addDesign(parts, { replace = false } = {}) {
    // replacing reuses the folder (it only depends on the letters and digits of the name)
    const finalName = replace ? cleanName(parts.name) : this.freeName(parts.name);

    fs.mkdirSync(this.dir, { recursive: true });
    const stage = fs.mkdtempSync(path.join(this.dir, `.adding-${crypto.randomBytes(4).toString('hex')}-`));
    try {
      const design = { name: finalName, colors: sanitizeColors(parts.colors), images: {}, sounds: {} };
      const author = cleanText(parts.author, MAX_AUTHOR);
      const description = cleanText(parts.description, MAX_DESCRIPTION);
      if (author) design.author = author;
      if (description) design.description = description;
      const layout = sanitizeLayout(parts.layout);
      const crop = sanitizeCrop(parts.crop);
      const tile = sanitizeTile(parts.tile);
      const prizeStyle = sanitizePrize(parts.prizeStyle);
      const prizeLayout = sanitizePrizeLayout(parts.prizeLayout);
      const orientation = sanitizeOrientation(parts.orientation);
      const spaces = sanitizeSpaces(parts.spaces);
      if (Object.keys(layout).length) design.layout = layout;
      if (Object.keys(crop).length) design.crop = crop;
      if (Object.keys(tile).length) design.tile = tile;
      if (prizeStyle) design.prizeStyle = prizeStyle;
      if (prizeLayout) design.prizeLayout = prizeLayout;
      if (orientation) design.orientation = orientation;
      if (spaces.length) design.spaces = spaces;

      let total = 0;
      const put = (ref, buffer) => {
        total += buffer.length;
        if (total > MAX_DESIGN_BYTES) throw new ThemeError('This design is too large (40 MB of files at most)');
        writeAtomic(path.join(stage, ref), buffer);
      };
      for (const [key, buffer] of Object.entries(parts.images || {})) {
        if (!IMAGE_KEYS.includes(key)) continue;
        const kind = checkImage(buffer, `The picture for "${key}"`);
        design.images[key] = `images/${key}.${kind.ext}`;
        put(design.images[key], buffer);
      }
      for (const role of EXTRA_FONT_ROLES) {
        const buffer = parts.fonts && parts.fonts[role];
        if (!buffer) continue;
        const kind = checkFont(buffer);
        (design.fonts ||= {})[role] = `fonts/${role}.${kind.ext}`;
        put(design.fonts[role], buffer);
      }
      const fontFamilies = sanitizeFontFamilies(parts.fontFamilies);
      if (Object.keys(fontFamilies).length) design.fontFamilies = fontFamilies;
      if (parts.font) {
        const kind = checkFont(parts.font);
        design.font = `fonts/font.${kind.ext}`;
        put(design.font, parts.font);
      }
      for (const [cue, buffer] of Object.entries(parts.sounds || {})) {
        if (!SOUND.KEYS.includes(cue)) continue;
        const kind = checkSound(buffer, `The sound for "${cue}"`);
        design.sounds[cue] = `sounds/${cue}.${kind.ext}`;
        put(design.sounds[cue], buffer);
      }
      writeAtomic(path.join(stage, 'design.json'), JSON.stringify(design, null, 2));

      const target = this.folderFor(finalName);
      if (fs.existsSync(target)) fs.rmSync(target, REMOVE_FOLDER);
      moveFolder(stage, target);
      return this.get(finalName);
    } catch (error) {
      fs.rmSync(stage, REMOVE_FOLDER);
      throw error;
    }
  }

  // A design in the old format: one JSON document with the pictures inside as data: addresses.
  // Web addresses cannot be kept (a design is made of files it carries), so they are left out.
  importLegacy(legacy) {
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new ThemeError('A design must be an object');
    const decode = (value) => {
      const match = /^data:[^;,]*;base64,(.*)$/s.exec(typeof value === 'string' ? value : '');
      return match ? Buffer.from(match[1], 'base64') : null;
    };
    const images = {};
    for (const [key, value] of Object.entries(legacy.images || {})) {
      const buffer = IMAGE_KEYS.includes(key) ? decode(value) : null;
      if (buffer) images[key] = buffer;
    }
    return this.addDesign({ name: legacy.name, colors: legacy.colors, images, font: decode(legacy.font) }, { replace: true });
  }
}

module.exports = {
  ThemeStore, ThemeError, COLOR_KEYS, IMAGE_KEYS, MAX_DESIGN_BYTES, MAX_IMAGE_BYTES, MIME,
  sniffImage, sniffFont, checkImage, checkFont, checkSound, sanitizeColors, sanitizeLayout, sanitizeCrop, sanitizeTile, sanitizePrize, sanitizePrizeLayout, sanitizeOrientation, sanitizeSpaces, sanitizeFontFamilies, cleanName, cleanText, folderName
};
