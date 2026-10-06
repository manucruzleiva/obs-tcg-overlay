/**
 * What the design editor is editing: a draft of one design (its author, description, colors, layout,
 * crop, tile, the picture on the prize cards, its screen and its reserved spaces), the design as last saved, and an undo history. The canvas, the code view and the crop selector
 * all read and change this one thing, and tell each other through it.
 */

const clone = (value) => JSON.parse(JSON.stringify(value));
const HISTORY_LIMIT = 100;
const NO_MOVE = { x: 0, y: 0, scale: 1 };

// Objects compared by what they hold, whatever order the keys came in
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// The files of a design that are not in the draft: its pictures, its main font and the fonts of the groups of text
const filesOf = (design) => ({ images: design.images || {}, font: design.font || null, fonts: design.fonts || {} });

// The part of a design the editor changes
function editable(design) {
  return {
    author: design.author || '',
    description: design.description || '',
    colors: clone(design.colors || {}),
    layout: clone(design.layout || {}),
    crop: clone(design.crop || {}),
    tile: clone(design.tile || {}),
    prizeStyle: design.prizeStyle || '', // the picture on the prize cards; empty for the usual one
    prizeLayout: design.prizeLayout || '', // how the six are laid out; empty for the usual row
    orientation: design.orientation || '', // the screen; empty for the usual wide one
    spaces: clone(design.spaces || []), // the places kept clear for a camera feed or the like
    fontFamilies: clone(design.fontFamilies || {}) // the fonts to use for each group of text
  };
}

export class EditorModel {
  constructor(design) {
    this.name = design.name;
    this.version = design.version;
    this.files = filesOf(design); // the pictures and fonts: they go up when they are chosen, not with the draft
    this.saved = editable(design);
    this.draft = clone(this.saved);
    this.history = [clone(this.draft)];
    this.at = 0;
    this.listeners = new Set();
    this.everSaved = false; // saved at least once while the editor was open
  }

  // `listener({ kind, source })`: kind is "edit" (the draft changed), "history" (undo or redo) or "saved"
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change) {
    for (const listener of [...this.listeners]) listener(change);
  }

  get dirty() {
    return !same(this.draft, this.saved);
  }

  get canUndo() {
    return this.at > 0 || !same(this.draft, this.history[this.at]);
  }

  get canRedo() {
    return this.at < this.history.length - 1 && same(this.draft, this.history[this.at]);
  }

  // Change parts of the draft. While something is being dragged pass `commit: false`, then call commit() at the end,
  // so the whole drag is one step in the history.
  update(patch, { source = 'canvas', commit = true } = {}) {
    for (const [key, value] of Object.entries(patch)) this.draft[key] = clone(value);
    if (commit) this.commit(source);
    else this.emit({ kind: 'edit', source });
  }

  // Make what the draft is now a step in the history (once, however many times this is called for it)
  commit(source = 'canvas') {
    if (!same(this.draft, this.history[this.at])) {
      this.history = this.history.slice(0, this.at + 1);
      this.history.push(clone(this.draft));
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      this.at = this.history.length - 1;
    }
    this.emit({ kind: 'edit', source });
  }

  undo() {
    if (!this.canUndo) return;
    // changes still being dragged are undone first
    if (!same(this.draft, this.history[this.at])) this.draft = clone(this.history[this.at]);
    else this.draft = clone(this.history[--this.at]);
    this.emit({ kind: 'history', source: 'undo' });
  }

  redo() {
    if (!this.canRedo) return;
    this.draft = clone(this.history[++this.at]);
    this.emit({ kind: 'history', source: 'redo' });
  }

  // Back to what was last saved (a step of its own, so it can be undone)
  revert() {
    this.draft = clone(this.saved);
    this.commit('revert');
  }

  markSaved(design) {
    this.everSaved = true;
    this.saved = editable(design);
    this.version = design.version;
    this.files = filesOf(design);
    this.emit({ kind: 'saved', source: 'save' });
  }

  // A picture was put in or taken out (that is saved at once, not with the design): the pictures and the version are the server's now
  setFiles(design) {
    this.everSaved = true; // (so the screen behind the editor reads the design again when it closes)
    this.version = design.version;
    this.files = filesOf(design);
    this.emit({ kind: 'files', source: 'upload' });
  }

  // ---- the layout, one piece at a time

  layoutOf(key) {
    return { ...NO_MOVE, ...(this.draft.layout[key] || {}) };
  }

  isMoved(key) {
    return Boolean(this.draft.layout[key]);
  }

  setLayout(key, entry, options) {
    const layout = clone(this.draft.layout);
    const next = { ...NO_MOVE, ...entry };
    if (next.x === 0 && next.y === 0 && next.scale === 1) delete layout[key];
    else layout[key] = next;
    this.update({ layout }, options);
  }

  // ---- the crop

  // What shows for the Active Pokémon, the bench and the Stadium ("active", "bench", "stadium": the picture of the card unless set) and
  // Special Energy ("energy": a circle in the middle of the picture window unless set)
  cropOf(which) {
    if (this.draft.crop[which]) return { ...this.draft.crop[which] };
    return which === 'energy' ? { ...window.OTO_THEME.ENERGY_CIRCLE } : { ...this.usualCrop(which) };
  }

  // The part of a card a kind of card shows when the design says nothing: the Stadium has its own picture window, as its card is laid out
  // differently, and a prize card shows the whole card
  usualCrop(which) {
    const THEME = window.OTO_THEME;
    return which === 'stadium' ? THEME.STADIUM_CROP_DEFAULT : which === 'prize' ? THEME.PRIZE_CROP_DEFAULT : THEME.CROP_DEFAULT;
  }

  setCrop(which, rect, options) {
    const crop = clone(this.draft.crop);
    const usual = window.OTO_THEME_RULES;
    const isDefault = rect && (which === 'energy' ? usual.isUsualCircle(rect) : usual.isUsualCrop(rect, this.usualCrop(which)));
    if (!rect || isDefault) delete crop[which];
    else crop[which] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    this.update({ crop }, options);
  }

  // ---- the tile

  // Where the HP bar, the energy and the retreat cost go for "active" or "bench" (the usual places unless set)
  tileOf(kind) {
    return { ...window.OTO_THEME.TILE_DEFAULT, ...(this.draft.tile[kind] || {}) };
  }

  setTile(kind, part, place, options) {
    const tile = clone(this.draft.tile);
    const entry = { ...(tile[kind] || {}), [part]: place };
    if (place === window.OTO_THEME.TILE_DEFAULT[part]) delete entry[part];
    if (Object.keys(entry).length) tile[kind] = entry;
    else delete tile[kind];
    this.update({ tile }, options);
  }

  // ---- the prize cards

  // The picture on the prize cards: "current" (what the design has) or one of the others
  prizeOf() {
    return this.draft.prizeStyle || window.OTO_THEME.PRIZE_DEFAULT;
  }

  setPrize(style, options) {
    this.update({ prizeStyle: style === window.OTO_THEME.PRIZE_DEFAULT ? '' : style }, options);
  }

  // How the prize cards are laid out: "row" (the usual), "column", "two-rows" or "three-rows"
  prizeLayoutOf() {
    return this.draft.prizeLayout || window.OTO_THEME.PRIZE_LAYOUT_DEFAULT;
  }

  setPrizeLayout(layout, options) {
    this.update({ prizeLayout: layout === window.OTO_THEME.PRIZE_LAYOUT_DEFAULT ? '' : layout }, options);
  }

  // ---- the screen

  // "landscape" (a wide 1920 x 1080 screen, the usual) or "portrait" (a tall 1080 x 1920 one, for a phone)
  orientationOf() {
    return this.draft.orientation || window.OTO_THEME.ORIENTATION_DEFAULT;
  }

  setOrientation(orientation, options) {
    this.update({ orientation: orientation === window.OTO_THEME.ORIENTATION_DEFAULT ? '' : orientation }, options);
  }

  // The size of the stage this design is drawn on, in pixels
  stageSize() {
    return window.OTO_THEME.stageSizeOf(this.orientationOf());
  }

  // ---- the reserved spaces

  // A new space of a shape (a rectangle, a rounded one or a circle), in the middle of the stage, with the lowest id that is free.
  // Returns its place in the list, or -1 when there are as many as there may be.
  addSpace(shape, options) {
    const THEME = window.OTO_THEME;
    const spaces = clone(this.draft.spaces);
    if (spaces.length >= THEME.SPACE_LIMITS.max) return -1;
    let id = 1;
    while (spaces.some((space) => space.id === id)) id++;
    const size = THEME.SPACE_SIZES[shape] || THEME.SPACE_SIZES.rect;
    const stage = this.stageSize();
    // (each new one a little further down and to the right, so they are not all on top of each other)
    const step = 40 * spaces.length;
    spaces.push({
      id, name: shape === 'circle' ? 'Round' : 'Camera', shape,
      x: Math.round((stage.width - size.w) / 2 + step), y: Math.round((stage.height - size.h) / 2 + step), w: size.w, h: size.h
    });
    this.update({ spaces }, options);
    return spaces.length - 1;
  }

  // Change one space (its name, shape, place or size); what does not fit is brought to the nearest that does
  setSpace(index, change, options) {
    const THEME = window.OTO_THEME;
    const { offset, minSize, maxSize, nameLength } = THEME.SPACE_LIMITS;
    const spaces = clone(this.draft.spaces);
    if (!spaces[index]) return;
    const next = { ...spaces[index], ...change };
    const whole = (value, low, high, fallback) => (Number.isFinite(Number(value)) && value !== '' ? Math.round(Math.max(low, Math.min(high, Number(value)))) : fallback);
    next.x = whole(next.x, -offset, offset, spaces[index].x);
    next.y = whole(next.y, -offset, offset, spaces[index].y);
    next.w = whole(next.w, minSize, maxSize, spaces[index].w);
    next.h = whole(next.h, minSize, maxSize, spaces[index].h);
    if (!THEME.SPACE_SHAPE_KEYS.includes(next.shape)) next.shape = spaces[index].shape;
    next.name = String(next.name === undefined ? '' : next.name).slice(0, nameLength);
    if (!next.name) delete next.name;
    spaces[index] = next;
    this.update({ spaces }, options);
  }

  removeSpace(index, options) {
    const spaces = clone(this.draft.spaces);
    if (!spaces[index]) return;
    spaces.splice(index, 1);
    this.update({ spaces }, options);
  }

  // ---- the fonts

  // The fonts to use for a group of text ("names", "numbers"...): a list such as "Impact, sans-serif"; empty for the main font's
  setFontFamily(role, families, options) {
    const fontFamilies = clone(this.draft.fontFamilies);
    const text = String(families || '').trim();
    if (text) fontFamilies[role] = text;
    else delete fontFamilies[role];
    this.update({ fontFamilies }, options);
  }

  // The font file a group of text has (the name of the file), or null
  fontFileOf(role) {
    const ref = role === 'display' ? this.files.font : this.files.fonts[role];
    return ref ? ref.split('/').pop() : null;
  }

  // What the overlay needs to draw this draft: addresses for the pictures the design holds
  theme(designAssetUrl) {
    const images = {};
    for (const [key, ref] of Object.entries(this.files.images)) images[key] = designAssetUrl(ref);
    const theme = { name: this.name, colors: this.draft.colors, images, layout: this.draft.layout, crop: this.draft.crop, tile: this.draft.tile };
    if (this.draft.prizeStyle) theme.prizeStyle = this.draft.prizeStyle;
    if (this.draft.prizeLayout) theme.prizeLayout = this.draft.prizeLayout;
    if (this.draft.orientation) theme.orientation = this.draft.orientation;
    if (this.draft.spaces.length) theme.spaces = this.draft.spaces;
    if (this.files.font) theme.font = designAssetUrl(this.files.font);
    if (Object.keys(this.files.fonts).length) theme.fonts = Object.fromEntries(Object.entries(this.files.fonts).map(([role, ref]) => [role, designAssetUrl(ref)]));
    if (Object.keys(this.draft.fontFamilies).length) theme.fontFamilies = this.draft.fontFamilies;
    return theme;
  }

  // The design as it is written in the code view (and in design.json), without the pictures
  toCode() {
    const code = { author: this.draft.author, description: this.draft.description, colors: this.draft.colors, layout: this.draft.layout, crop: this.draft.crop, tile: this.draft.tile };
    if (this.draft.prizeStyle) code.prizeStyle = this.draft.prizeStyle;
    if (this.draft.prizeLayout) code.prizeLayout = this.draft.prizeLayout;
    if (this.draft.orientation) code.orientation = this.draft.orientation;
    if (this.draft.spaces.length) code.spaces = this.draft.spaces;
    if (Object.keys(this.draft.fontFamilies).length) code.fontFamilies = this.draft.fontFamilies;
    return JSON.stringify(code, null, 2);
  }
}
