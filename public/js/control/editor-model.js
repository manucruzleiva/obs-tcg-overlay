/**
 * What the design editor is editing: a draft of one design (its author, description, colors, layout,
 * crop, tile and the picture on the prize cards), the design as last saved, and an undo history. The canvas, the code view and the crop selector
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

// The part of a design the editor changes
function editable(design) {
  return {
    author: design.author || '',
    description: design.description || '',
    colors: clone(design.colors || {}),
    layout: clone(design.layout || {}),
    crop: clone(design.crop || {}),
    tile: clone(design.tile || {}),
    prizeStyle: design.prizeStyle || '' // the picture on the prize cards; empty for the usual one
  };
}

export class EditorModel {
  constructor(design) {
    this.name = design.name;
    this.version = design.version;
    this.files = { images: design.images || {}, font: design.font || null }; // the pictures and font: not edited here
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
    this.files = { images: design.images || {}, font: design.font || null };
    this.emit({ kind: 'saved', source: 'save' });
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

  // The picture window a kind of card shows when the design says nothing: the Stadium has its own, as its card is laid out differently
  usualCrop(which) {
    return which === 'stadium' ? window.OTO_THEME.STADIUM_CROP_DEFAULT : window.OTO_THEME.CROP_DEFAULT;
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

  // What the overlay needs to draw this draft: addresses for the pictures the design holds
  theme(designAssetUrl) {
    const images = {};
    for (const [key, ref] of Object.entries(this.files.images)) images[key] = designAssetUrl(ref);
    const theme = { name: this.name, colors: this.draft.colors, images, layout: this.draft.layout, crop: this.draft.crop, tile: this.draft.tile };
    if (this.draft.prizeStyle) theme.prizeStyle = this.draft.prizeStyle;
    if (this.files.font) theme.font = designAssetUrl(this.files.font);
    return theme;
  }

  // The design as it is written in the code view (and in design.json), without the pictures
  toCode() {
    const code = { author: this.draft.author, description: this.draft.description, colors: this.draft.colors, layout: this.draft.layout, crop: this.draft.crop, tile: this.draft.tile };
    if (this.draft.prizeStyle) code.prizeStyle = this.draft.prizeStyle;
    return JSON.stringify(code, null, 2);
  }
}
