/**
 * .oto packages: a design (colors, pictures, font and sounds) and the control settings (what the
 * overlay shows, how long announcements stay, which sounds play) in one compressed file that can be
 * shared and installed in a click.
 *
 * A .oto file is a ZIP under another name:
 *
 *   manifest.json     what it is: { format: "oto", version: 1, name, app, created, contents }
 *   design.json       the colors, author and description of the design (optional)
 *   images/<slot>.png pictures: logoImage, backgroundImage, trainerAAvatar, ... (optional)
 *   fonts/font.woff2  the font (optional)
 *   sounds/<cue>.mp3  sounds for cues such as damage, ko, turn (optional)
 *   controls.json     { version: 1, settings: { display, sound, toastSeconds, ... } } (optional)
 *
 * Pictures, font and sounds are found by their names, so a package can be made by zipping a folder and
 * renaming it. Everything in a package is checked on the way in: it is only ever data, never code,
 * and nothing it names can reach outside of OTO's own folders.
 */

const { createZip, readZip, ZipError, MB } = require('./zip');
const { ThemeError, cleanText, cleanName, folderName, sanitizeLayout, sanitizeCrop, MAX_IMAGE_BYTES } = require('./themes');
const { MAX_SOUND_BYTES } = require('./sounds');
const DISPLAY = require('../../public/js/display-options');
const SOUND = require('../../public/js/sound-options');
const { IMAGE_KEYS } = require('../../public/js/theme-options');

const FORMAT = 'oto';
const VERSION = 1;
const MAX_PACKAGE_BYTES = 48 * MB;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'svg'];
const FONT_EXTENSIONS = ['woff2', 'woff', 'otf', 'ttf'];
const SOUND_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'webm'];
const EXTENSION_OF_MIME = { 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm' };

class PackageError extends Error {}

// What a package may carry of the control settings. Nothing else (the card API key, cache sizes and the
// like belong to one computer) is ever written to a package or taken from one.
const SHARED_NUMBERS = ['toastSeconds', 'animationSeconds', 'overlayOpacity'];
const SHARED_FLAGS = ['autoScale', 'showPenaltyAnimation', 'preferLowestRarity'];
const ANNOUNCEMENT_FLAG = /^enable[A-Za-z_]*(Toast|Animation)$/;

// The part of a settings object that is fit to share, checked against the types of the defaults
function pickSharedSettings(input, defaults) {
  const settings = {};
  if (!input || typeof input !== 'object') return settings;

  if (input.display && typeof input.display === 'object') {
    const display = {};
    for (const key of DISPLAY.KEYS) if (typeof input.display[key] === 'boolean') display[key] = input.display[key];
    if (Object.keys(display).length) settings.display = display;
  }

  if (input.sound && typeof input.sound === 'object') {
    const sound = {};
    if (typeof input.sound.enabled === 'boolean') sound.enabled = input.sound.enabled;
    if (Number.isFinite(input.sound.volume)) sound.volume = Math.min(100, Math.max(0, Math.round(input.sound.volume)));
    const events = {};
    for (const cue of SOUND.KEYS) {
      const change = input.sound.events && input.sound.events[cue];
      if (!change || typeof change !== 'object') continue;
      const event = {};
      if (typeof change.enabled === 'boolean') event.enabled = change.enabled;
      if (Number.isFinite(change.volume)) event.volume = Math.min(100, Math.max(0, Math.round(change.volume)));
      if (Object.keys(event).length) events[cue] = event;
    }
    if (Object.keys(events).length) sound.events = events;
    if (Object.keys(sound).length) settings.sound = sound;
  }

  for (const key of SHARED_NUMBERS) if (Number.isFinite(input[key])) settings[key] = input[key];
  for (const key of SHARED_FLAGS) if (typeof input[key] === 'boolean') settings[key] = input[key];
  for (const key of Object.keys(input)) {
    if (ANNOUNCEMENT_FLAG.test(key) && typeof input[key] === 'boolean' && (!defaults || key in defaults)) settings[key] = input[key];
  }
  return settings;
}

// ------------------------------------------------------------------------------------ packing

const json = (value) => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

// design: { design (design.json as an object), files: [{ ref, data }] } or null; controls: shared settings or null
function pack({ name, design = null, controls = null, app = '' }) {
  const sounds = design ? design.files.filter((file) => file.ref.startsWith('sounds/')).length : 0;
  const manifest = {
    format: FORMAT,
    version: VERSION,
    name: cleanText(name, 40) || 'OTO package',
    app,
    created: new Date().toISOString(),
    contents: { design: Boolean(design), sounds, controls: Boolean(controls) }
  };
  const entries = [{ name: 'manifest.json', data: json(manifest) }];
  if (design) {
    entries.push({ name: 'design.json', data: json(design.design) });
    for (const file of design.files) entries.push({ name: file.ref, data: file.data });
  }
  if (controls) entries.push({ name: 'controls.json', data: json({ version: VERSION, settings: controls }) });
  return createZip(entries);
}

// ---------------------------------------------------------------------------------- unpacking

// The most a file of this name may hold (unknown files are read, bounded, and then ignored)
function limitFor(name) {
  if (['manifest.json', 'design.json', 'controls.json'].includes(name)) return MB;
  if (name.startsWith('images/')) return MAX_IMAGE_BYTES;
  if (name.startsWith('fonts/')) return MAX_IMAGE_BYTES;
  if (name.startsWith('sounds/')) return MAX_SOUND_BYTES;
  return 8 * MB;
}

function parseJson(files, name, what) {
  if (!files.has(name)) return undefined;
  try {
    const value = JSON.parse(files.get(name).toString('utf8').replace(/^﻿/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new PackageError(`${what} in that package cannot be read`);
  }
}

// Zipping a folder in Explorer puts the folder itself at the top of the zip ("my-design/design.json").
// When everything sits inside one such folder, look inside it. (macOS adds __MACOSX and .DS_Store entries.)
function withoutWrapperFolder(files) {
  const real = [...files.keys()].filter((name) => !name.startsWith('__MACOSX/') && !name.endsWith('.DS_Store'));
  if (real.length === 0) return files;
  const folder = real[0].split('/')[0];
  if (!real.every((name) => name.includes('/') && name.split('/')[0] === folder)) return files;
  const inside = new Map();
  for (const [name, data] of files) inside.set(name.startsWith(`${folder}/`) ? name.slice(folder.length + 1) : name, data);
  return inside;
}

// One file per slot, found by name: images/<slot>.<ext>, fonts/font.<ext>, sounds/<cue>.<ext>
function findFile(files, folder, base, extensions, preferred) {
  const candidates = extensions.map((ext) => `${folder}/${base}.${ext}`).filter((name) => files.has(name));
  if (candidates.length === 0) return null;
  const chosen = candidates.includes(preferred) ? preferred : candidates[0];
  return files.get(chosen);
}

// bytes -> { manifest, design, controls, ignored }. Throws a PackageError (or ZipError) in plain words.
function unpack(buffer, defaults = null) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new PackageError('No file was sent');
  if (buffer.length > MAX_PACKAGE_BYTES) throw new PackageError('That file is too large to be a package (48 MB at most)');

  const files = withoutWrapperFolder(readZip(buffer, { count: 200, total: 64 * MB, entry: limitFor }));

  const rawManifest = parseJson(files, 'manifest.json', 'The description');
  if (rawManifest) {
    if (rawManifest.format !== undefined && rawManifest.format !== FORMAT) throw new PackageError('That is not an OTO package');
    if (rawManifest.version !== undefined && !(Number.isInteger(rawManifest.version) && rawManifest.version >= 1)) throw new PackageError('That package has an invalid version');
    if (rawManifest.version > VERSION) throw new PackageError('That package was made by a newer version of OTO. Update OTO to open it.');
  }
  const manifest = {
    name: cleanText(rawManifest && rawManifest.name, 40),
    app: cleanText(rawManifest && rawManifest.app, 40),
    created: cleanText(rawManifest && rawManifest.created, 40)
  };

  const used = new Set(['manifest.json']);

  // ---- design
  let design = null;
  const rawDesign = parseJson(files, 'design.json', 'The design');
  if (rawDesign) {
    used.add('design.json');
    let name;
    try { name = cleanName(rawDesign.name || manifest.name || 'Imported design'); } catch (error) { throw new PackageError(error.message); }
    design = {
      name,
      author: cleanText(rawDesign.author, 60),
      description: cleanText(rawDesign.description, 300),
      colors: rawDesign.colors && typeof rawDesign.colors === 'object' ? rawDesign.colors : {},
      layout: rawDesign.layout,
      crop: rawDesign.crop,
      images: {},
      font: null,
      sounds: {}
    };
    const claimed = rawDesign.images && typeof rawDesign.images === 'object' ? rawDesign.images : {};
    for (const key of IMAGE_KEYS) {
      const data = findFile(files, 'images', key, IMAGE_EXTENSIONS, claimed[key]);
      if (data) design.images[key] = data;
    }
    design.font = findFile(files, 'fonts', 'font', FONT_EXTENSIONS, rawDesign.font);
    const claimedSounds = rawDesign.sounds && typeof rawDesign.sounds === 'object' ? rawDesign.sounds : {};
    for (const cue of SOUND.KEYS) {
      const data = findFile(files, 'sounds', cue, SOUND_EXTENSIONS, claimedSounds[cue]);
      if (data) design.sounds[cue] = data;
    }
    // files in the asset folders that sit in a slot (whatever their type) count as used; the rest are reported
    for (const entry of files.keys()) {
      if (!/^(images|fonts|sounds)\/[^/]+$/.test(entry)) continue;
      const [folder, file] = entry.split('/');
      const base = file.slice(0, file.lastIndexOf('.'));
      const wanted = folder === 'images' ? IMAGE_KEYS.includes(base) : folder === 'fonts' ? base === 'font' : SOUND.KEYS.includes(base);
      if (wanted) used.add(entry);
    }
  }

  // ---- control settings
  let controls = null;
  const rawControls = parseJson(files, 'controls.json', 'The control settings');
  if (rawControls) {
    used.add('controls.json');
    const settings = pickSharedSettings(rawControls.settings && typeof rawControls.settings === 'object' ? rawControls.settings : rawControls, defaults);
    if (Object.keys(settings).length) controls = { settings };
  }

  if (!design && !controls) throw new PackageError('That file has no design and no control settings that OTO can use');
  return { manifest, design, controls, ignored: [...files.keys()].filter((name) => !used.has(name)) };
}

// ------------------------------------------------------------------------------------ service

// Plain facts about control settings, for the "this package will change..." summary
function describeControls(settings) {
  const labels = Object.fromEntries(DISPLAY.GROUPS.flatMap((group) => group.options.map((option) => [option.key, option.label])));
  const cueLabels = Object.fromEntries(SOUND.GROUPS.flatMap((group) => group.cues.map((cue) => [cue.key, cue.label])));
  const display = settings.display || {};
  const events = (settings.sound && settings.sound.events) || {};
  return {
    hidden: Object.keys(display).filter((key) => display[key] === false).map((key) => labels[key]),
    shown: Object.keys(display).filter((key) => display[key] === true).length,
    toastSeconds: settings.toastSeconds,
    animationSeconds: settings.animationSeconds,
    sound: settings.sound && {
      enabled: settings.sound.enabled,
      volume: settings.sound.volume,
      mutedCues: Object.keys(events).filter((cue) => events[cue].enabled === false).map((cue) => cueLabels[cue])
    },
    announcementsOff: Object.keys(settings).filter((key) => ANNOUNCEMENT_FLAG.test(key) && settings[key] === false).length,
    settings: Object.keys(settings).length
  };
}

class PackageService {
  // themes: ThemeStore; sounds: SoundStore (the producer's own sounds); gameState and session: the live game;
  // emit(event): tell the screens (theme:changed, sounds:changed)
  constructor({ themes, sounds, gameState, session, emit = () => {}, appVersion = '' }) {
    this.themes = themes;
    this.sounds = sounds;
    this.gameState = gameState;
    this.session = session;
    this.emit = emit;
    this.appVersion = appVersion;
  }

  defaults() {
    return this.gameState.getDefaultState().settings;
  }

  // Build a package. `design`: the name of a design to include; `mySounds`: put the producer's own sounds in
  // (they win over the design's); `controls`: include the control settings in use now.
  exportPackage({ design = null, mySounds = false, controls = false } = {}) {
    if (!design && !controls) throw new PackageError('Choose what to put in the package');

    let included = null;
    if (design) {
      included = this.themes.exportDesign(design);
      if (mySounds) {
        const own = this.sounds.list();
        for (const cue of Object.keys(own)) {
          const sound = this.sounds.read(cue);
          const ext = EXTENSION_OF_MIME[sound.mime];
          included.files = included.files.filter((file) => !file.ref.startsWith(`sounds/${cue}.`));
          included.files.push({ ref: `sounds/${cue}.${ext}`, data: sound.buffer });
          included.design.sounds = { ...included.design.sounds, [cue]: `sounds/${cue}.${ext}` };
        }
      }
    }
    const shared = controls ? pickSharedSettings(this.gameState.state.settings, this.defaults()) : null;
    const title = included ? included.design.name : 'My OTO setup';
    const buffer = pack({ name: title, design: included, controls: shared, app: `OTO ${this.appVersion}`.trim() });
    return { buffer, filename: `${folderName(title)}.oto` };
  }

  // What is inside a package, without changing anything
  inspect(buffer) {
    const opened = unpack(buffer, this.defaults());
    const { manifest, design, controls, ignored } = opened;
    return {
      name: (design && design.name) || manifest.name || 'OTO package',
      author: design ? design.author : '',
      description: design ? design.description : '',
      app: manifest.app,
      created: manifest.created,
      design: design && {
        name: design.name,
        exists: Boolean(this.themes.get(design.name)),
        images: Object.keys(design.images),
        font: Boolean(design.font),
        sounds: Object.keys(design.sounds),
        colors: Object.keys(design.colors).length,
        layout: Object.keys(sanitizeLayout(design.layout)).length,
        crop: Object.keys(sanitizeCrop(design.crop))
      },
      controls: controls && describeControls(controls.settings),
      ignored
    };
  }

  // Put a package to use: add the design, put it on air, and apply the control settings. Each part is
  // optional. The settings go through the shared history, so undo (Ctrl+Z) takes them back; `by` is who
  // is installing it ({ clientId, name }), so the other producers see who changed their settings.
  install(buffer, { design: wantDesign = true, controls: wantControls = true, activate = true, replace = false } = {}, by = undefined) {
    const { manifest, design, controls } = unpack(buffer, this.defaults());
    const result = { design: null, activated: false, controlsApplied: false };

    if (design && wantDesign) {
      let saved;
      try {
        const replacing = replace ? this.themes.get(design.name) : null;
        saved = this.themes.addDesign(design, { replace });
        result.design = { name: saved.name, replaced: Boolean(replacing) };
      } catch (error) {
        if (error instanceof ThemeError) throw new PackageError(error.message);
        throw error;
      }
      if (activate) {
        this.themes.setActive(saved.name);
        result.activated = true;
      }
      // the screens reload the look and the sounds if the design on air is the one that changed
      if (this.themes.isActive(saved.name)) {
        this.emit('theme:changed');
        this.emit('sounds:changed');
      }
    }

    if (controls && wantControls) {
      const title = (design && design.name) || manifest.name || 'a package';
      this.session.commit(`Settings from "${title}"`, (gs) => gs.updateSettings(controls.settings), by);
      result.controlsApplied = true;
    }

    if (!result.design && !result.controlsApplied) throw new PackageError('Nothing was chosen to install');
    return result;
  }
}

module.exports = {
  PackageService, PackageError, ZipError, pack, unpack, pickSharedSettings, describeControls,
  FORMAT, VERSION, MAX_PACKAGE_BYTES
};
