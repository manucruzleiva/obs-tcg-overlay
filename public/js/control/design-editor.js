/**
 * The design editor: the overlay on a canvas you can zoom and drag pieces around (with a grid to line them up by, and a wide or a tall
 * mobile screen), a crop selector for the Pokémon cards, where the parts of a Pokémon's tile go (and the picture on the prize cards), the
 * places kept clear for a camera feed, and the design as code. It edits one design and saves it back, so the overlay (if this design is on air)
 * follows.
 */
import { h, icon } from './dom.js';
import { openModal, closeModal, confirmDialog, pickFile } from './ui.js';
import { SpacesPanel } from './editor-spaces.js';
import { EditorModel } from './editor-model.js';
import { EditorCanvas } from './editor-canvas.js';
import { CropSelector } from './editor-crop.js';
import { TilePanel } from './editor-tile.js';
import { CodePanel } from './editor-code.js';
import { sampleState, cardArt, specialEnergyArt } from './editor-sample.js';

const THEME = window.OTO_THEME;
const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024; // the most the server takes for one picture
const GRID_KEY = 'oto-editor-grid'; // the grid mask is a choice of this browser, for editing only: it is not part of the design
const GRID_USUAL = { show: false, size: 40, snap: false };
const GRID_SIZES = { min: 8, max: 480 };

// The grid this browser used last (or the usual one)
function loadGrid() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(GRID_KEY));
    if (saved && typeof saved === 'object') {
      const size = Number(saved.size);
      return { show: saved.show === true, snap: saved.snap === true, size: Number.isFinite(size) ? Math.max(GRID_SIZES.min, Math.min(GRID_SIZES.max, Math.round(size))) : GRID_USUAL.size };
    }
  } catch (error) { /* a private window remembers nothing */ }
  return { ...GRID_USUAL };
}

function saveGrid(grid) {
  try { window.localStorage.setItem(GRID_KEY, JSON.stringify(grid)); } catch (error) { /* a private window cannot remember it */ }
}

async function getJson(url) {
  const response = await fetch(url);
  let data = null;
  try { data = await response.json(); } catch (error) { /* an empty answer */ }
  if (!response.ok) throw new Error((data && data.error) || `Something went wrong (${response.status})`);
  return data;
}

// ----------------------------------------------------------------------------- the layout panel

function layoutPanel({ model, canvas }) {
  const buttons = new Map();
  const list = h('div', { class: 'block-list', role: 'group', 'aria-label': 'Pieces of the overlay' },
    THEME.BLOCKS.map((block) => {
      const button = h('button', {
        class: 'block-item', type: 'button', dataset: { key: block.key }, 'aria-pressed': 'false',
        onclick: () => {
          canvas.select(canvas.selected === block.key ? null : block.key);
          canvas.element.focus({ preventScroll: true }); // so the arrow keys move it
        }
      }, h('span', { class: 'block-dot' }), h('span', { class: 'block-name' }, block.label));
      buttons.set(block.key, button);
      return button;
    }));

  const number = (label, step, min, max) => {
    const input = h('input', { type: 'number', step, min, max, 'aria-label': label });
    return { input, node: h('label', { class: 'crop-field' }, h('span', {}, label), input) };
  };
  const x = number('Across', 1, -1920, 1920);
  const y = number('Down', 1, -1920, 1920);
  const scale = number('Size', 0.05, 0.2, 4);
  const commit = () => {
    const key = canvas.selectedBlock;
    if (!key) return;
    const value = (field, fallback) => (field.input.value === '' || Number.isNaN(Number(field.input.value)) ? fallback : Number(field.input.value));
    const limit = THEME.LAYOUT_LIMITS;
    const entry = model.layoutOf(key);
    model.setLayout(key, {
      x: Math.round(Math.max(-limit.offset, Math.min(limit.offset, value(x, entry.x)))),
      y: Math.round(Math.max(-limit.offset, Math.min(limit.offset, value(y, entry.y)))),
      scale: Math.round(Math.max(limit.minScale, Math.min(limit.maxScale, value(scale, entry.scale))) * 100) / 100
    }, { source: 'fields' });
  };
  for (const field of [x, y, scale]) field.input.addEventListener('change', commit);

  const resetOne = h('button', { class: 'btn tiny', type: 'button', onclick: () => canvas.selectedBlock && model.setLayout(canvas.selectedBlock, {}, { source: 'fields' }) }, 'Put it back');
  const resetAll = h('button', { class: 'btn tiny', type: 'button', onclick: () => model.update({ layout: {} }, { source: 'fields' }) }, 'Put everything back');
  const name = h('strong', { class: 'block-selected' });
  const fields = h('div', { class: 'block-fields' }, name, h('div', { class: 'crop-fields' }, x.node, y.node, scale.node), h('div', { class: 'button-row' }, resetOne));

  const element = h('div', { class: 'layout-panel' },
    h('p', { class: 'settings-note' }, 'Click a piece on the overlay, or choose one from the list. Drag it to move it, and drag a corner of the box around it to resize it. The arrow keys move it by a pixel (Shift: ten). Scroll or pinch to zoom, hold Space and drag to pan.'),
    list, fields, h('div', { class: 'button-row' }, resetAll));

  function refresh() {
    const selected = canvas.selectedBlock;
    for (const [key, button] of buttons) {
      button.classList.toggle('moved', model.isMoved(key));
      button.classList.toggle('on', key === selected);
      button.classList.toggle('away', !canvas.rects[key]);
      button.setAttribute('aria-pressed', String(key === selected));
      button.title = canvas.rects[key] ? '' : 'Not showing right now (it is empty)';
    }
    fields.hidden = !selected;
    if (selected) {
      const entry = model.layoutOf(selected);
      const block = THEME.BLOCKS.find((item) => item.key === selected);
      name.textContent = block ? block.label : selected;
      if (document.activeElement !== x.input) x.input.value = String(entry.x);
      if (document.activeElement !== y.input) y.input.value = String(entry.y);
      if (document.activeElement !== scale.input) scale.input.value = String(entry.scale);
      resetOne.disabled = !model.isMoved(selected);
    }
    resetAll.disabled = Object.keys(model.draft.layout).length === 0;
  }
  return { element, refresh };
}

// ------------------------------------------------------------------------------------ the editor

// Open the editor for a design. `onClose` runs when it is closed (the screen behind it can refresh then).
export async function openDesignEditor(app, name, { onClose } = {}) {
  let design;
  let active;
  try {
    design = await getJson(`/api/themes/${encodeURIComponent(name)}`);
    active = (await getJson('/api/themes')).active;
  } catch (error) {
    app.toast(error.message, 'error');
    return null;
  }

  const model = new EditorModel(design);
  const assetUrl = (ref) => `/api/themes/${encodeURIComponent(model.name)}/assets/${ref}?v=${model.version}`;
  let matchMode = 'sample'; // or "live"

  const liveState = () => {
    const state = structuredClone(app.conn.live || app.state);
    state.settings.autoScale = false;
    return state;
  };
  // the match drawn on the canvas: a made-up one, or the live one (none until the page has the game)
  const sample = () => {
    if (!(app.conn.live || app.state)) return null;
    return matchMode === 'live' ? liveState() : sampleState(app.conn.live || app.state);
  };

  // ---- the parts
  const toolbar = {};
  const canvas = new EditorCanvas({
    model, sample, assetUrl,
    onView: (view) => { if (toolbar.zoom) toolbar.zoom.textContent = `${Math.round(view.zoom * 100)}%`; },
    // picking a reserved space on the overlay shows its tab, and picking a piece goes back to the pieces
    onSelect: (key) => {
      layout.refresh();
      spaces.refresh();
      if (typeof key === 'string' && key.startsWith('space:')) { if (current !== 'spaces') showTab('spaces'); } else if (key && current === 'spaces') showTab('layout');
    }
  });
  const layout = layoutPanel({ model, canvas });
  const cropSelector = new CropSelector({
    model,
    // the cards a crop can be shown on: a made-up one, and the ones on the table
    cards: (which) => {
      const live = app.conn.live;
      const trainers = [['trainerA', live && live.trainerA], ['trainerB', live && live.trainerB]];
      if (which === 'energy') {
        const cards = [{ label: 'A sample Special Energy card', url: specialEnergyArt() }];
        for (const [side, trainer] of trainers) {
          for (const mon of trainer ? [trainer.active, ...trainer.bench] : []) {
            for (const card of (mon && mon.specialEnergies) || []) if (card.image) cards.push({ label: `${trainer.name || side}: ${card.name}`, url: card.image });
          }
        }
        return cards;
      }
      if (which === 'stadium') {
        const cards = [{ label: 'A sample Stadium card', url: cardArt('Area Zero', 200, 'Stadium') }];
        const stadium = live && live.stadium;
        if (stadium && stadium.inPlay && stadium.image) cards.push({ label: `In play: ${stadium.name || 'the Stadium'}`, url: stadium.image });
        return cards;
      }
      const cards = [{ label: 'A sample card', url: cardArt('Sample', 50) }];
      for (const [side, trainer] of trainers) {
        if (trainer && trainer.active && trainer.active.image) cards.push({ label: `${trainer.name || side}: ${trainer.active.name}`, url: trainer.active.image });
      }
      return cards;
    }
  });
  const tilePanel = new TilePanel({ model });
  const code = new CodePanel({ model });

  // The picture that is drawn over a reserved space is one of the design's pictures (spaceFrame<id>): it is saved as soon as it is chosen,
  // not with the rest of the design
  const frameUrl = (id) => (model.files.images[`spaceFrame${id}`] ? assetUrl(model.files.images[`spaceFrame${id}`]) : null);
  const uploadFrame = async (id) => {
    const file = await pickFile('image/png,image/jpeg,image/gif,image/webp,image/svg+xml');
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) { app.toast('That picture is larger than 4.5 MB. Use a smaller one.', 'warning'); return; }
    try {
      const response = await fetch(`/api/themes/${encodeURIComponent(model.name)}/images/spaceFrame${id}`, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The picture could not be saved');
      model.setFiles(data);
    } catch (error) {
      app.toast(error.message, 'error');
    }
  };
  const removeFrame = async (id) => {
    try {
      const response = await fetch(`/api/themes/${encodeURIComponent(model.name)}/images/spaceFrame${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The picture could not be taken off');
      model.setFiles(data);
    } catch (error) {
      app.toast(error.message, 'error');
    }
  };
  const spaces = new SpacesPanel({ model, canvas, frameUrl, upload: uploadFrame, removePicture: removeFrame });

  // ---- the toolbar above the canvas
  const iconButton = (label, glyph, onclick) => h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick }, icon(glyph));
  toolbar.undo = iconButton('Undo (Ctrl+Z)', 'undo', () => model.undo());
  toolbar.redo = iconButton('Redo (Ctrl+Y)', 'redo', () => model.redo());
  toolbar.zoom = h('output', { class: 'zoom-readout', 'aria-label': 'Zoom' }, '50%');
  const snap = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Snap to lines' });
  snap.addEventListener('change', () => { canvas.snap = snap.checked; });
  const banner = h('input', { type: 'checkbox', 'aria-label': 'Show an announcement banner' });
  banner.addEventListener('change', () => canvas.showBanner(banner.checked));
  // the screen of the design: a wide one or a tall one for a phone
  const screen = h('select', { class: 'screen-select', 'aria-label': 'The screen of the design', title: 'Wide: 1920 x 1080. Mobile: 1080 x 1920, for a phone held upright', onchange: () => model.setOrientation(screen.value, { source: 'fields' }) },
    THEME.ORIENTATIONS.map((entry) => h('option', { value: entry.key, title: entry.help }, entry.label)));
  screen.value = model.orientationOf();
  // the grid mask: lines over the stage to line things up by, and pieces that jump onto them
  const grid = loadGrid();
  const gridShow = h('input', { type: 'checkbox', checked: grid.show, 'aria-label': 'Show a grid' });
  const gridSnap = h('input', { type: 'checkbox', checked: grid.snap, 'aria-label': 'Snap to the grid' });
  const gridSize = h('input', { type: 'number', class: 'grid-size', min: GRID_SIZES.min, max: GRID_SIZES.max, step: 1, value: String(grid.size), 'aria-label': 'Size of the grid squares, in pixels', title: 'Size of the squares, in pixels of the screen' });
  const useGrid = () => {
    const size = Math.max(GRID_SIZES.min, Math.min(GRID_SIZES.max, Math.round(Number(gridSize.value)) || GRID_USUAL.size));
    const next = { show: gridShow.checked, snap: gridSnap.checked, size };
    saveGrid(next);
    canvas.setGrid(next);
  };
  gridShow.addEventListener('change', useGrid);
  gridSnap.addEventListener('change', useGrid);
  gridSize.addEventListener('change', () => { gridSize.value = String(Math.max(GRID_SIZES.min, Math.min(GRID_SIZES.max, Math.round(Number(gridSize.value)) || GRID_USUAL.size))); useGrid(); });
  canvas.setGrid(grid);
  const match = h('select', { 'aria-label': 'The match to draw', onchange: () => { matchMode = match.value; canvas.draw(); } },
    h('option', { value: 'sample' }, 'A sample match'), h('option', { value: 'live' }, 'The live match'));
  const switchOf = (input, label) => h('label', { class: 'switch inline' }, input, h('span', { class: 'track' }), h('span', { class: 'switch-label' }, label));

  const bar = h('div', { class: 'editor-toolbar' },
    h('div', { class: 'toolbar-group' }, toolbar.undo, toolbar.redo),
    h('div', { class: 'toolbar-group' },
      iconButton('Zoom out (-)', 'minus', () => canvas.zoomBy(1 / 1.2)), toolbar.zoom, iconButton('Zoom in (+)', 'plus', () => canvas.zoomBy(1.2)),
      h('button', { class: 'btn tiny', type: 'button', title: 'Show the whole overlay (0)', onclick: () => canvas.fit() }, 'Fit'),
      h('button', { class: 'btn tiny', type: 'button', title: 'One pixel is one pixel (1)', onclick: () => canvas.actualSize() }, '100%')),
    h('div', { class: 'toolbar-group' }, switchOf(snap, 'Snap to lines'), switchOf(banner, 'Banner')),
    h('div', { class: 'toolbar-group' }, switchOf(gridShow, 'Grid'), gridSize, h('span', { class: 'toolbar-unit' }, 'px'), switchOf(gridSnap, 'Snap to grid')),
    h('div', { class: 'toolbar-group' }, screen, match),
    h('span', { class: 'toolbar-hint' }, 'Scroll or pinch to zoom · Space + drag to pan'));

  // ---- the side panel
  const panels = { layout: layout.element, crop: cropSelector.element, tile: tilePanel.element, spaces: spaces.element, code: code.element };
  const tabs = [['layout', 'Layout'], ['crop', 'Card crop'], ['tile', 'Tile'], ['spaces', 'Spaces'], ['code', 'Code']];
  const tabButtons = new Map();
  const sideBody = h('div', { class: 'editor-side-body' });
  let current = 'layout';
  const showTab = (id) => {
    current = id;
    for (const [key, button] of tabButtons) {
      button.classList.toggle('on', key === id);
      button.setAttribute('aria-selected', String(key === id));
    }
    sideBody.textContent = '';
    sideBody.appendChild(panels[id]);
  };
  const side = h('aside', { class: 'editor-side' },
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) => {
      const button = h('button', { class: 'tab', type: 'button', role: 'tab', dataset: { tab: id }, onclick: () => showTab(id) }, label);
      tabButtons.set(id, button);
      return button;
    })),
    sideBody);
  showTab('layout');

  // ---- saving
  const status = h('span', { class: 'save-status editor-status', role: 'status' });
  const saveButton = h('button', { class: 'btn primary', type: 'button', 'data-autofocus': true }, 'Save');
  const revertButton = h('button', { class: 'btn', type: 'button', onclick: () => model.revert() }, 'Undo all changes');
  let saving = false;

  const refreshStatus = () => {
    const dirty = model.dirty;
    status.textContent = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved';
    status.classList.toggle('unsaved', dirty);
    saveButton.disabled = !dirty || saving;
    revertButton.disabled = !dirty;
    toolbar.undo.disabled = !model.canUndo;
    toolbar.redo.disabled = !model.canRedo;
  };

  const save = async () => {
    if (saving || !model.dirty) return true;
    saving = true;
    refreshStatus();
    try {
      const response = await fetch(`/api/themes/${encodeURIComponent(model.name)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: model.draft.author, description: model.draft.description, colors: model.draft.colors, layout: model.draft.layout, crop: model.draft.crop, tile: model.draft.tile, prizeStyle: model.draft.prizeStyle, prizeLayout: model.draft.prizeLayout, orientation: model.draft.orientation, spaces: model.draft.spaces })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The design could not be saved');
      model.markSaved(data);
      let onAir = false;
      try { onAir = (await getJson('/api/themes')).active === model.name; } catch (error) { /* then it just says Saved */ }
      app.toast(onAir ? `Saved. "${model.name}" is on the overlay, so you see it on stream.` : 'Saved', 'success');
      return true;
    } catch (error) {
      app.toast(error.message, 'error');
      return false;
    } finally {
      saving = false;
      refreshStatus();
    }
  };
  saveButton.addEventListener('click', save);

  model.on((change) => {
    if (change.kind !== 'saved') canvas.redesign();
    layout.refresh();
    spaces.refresh();
    if (document.activeElement !== screen) screen.value = model.orientationOf();
    refreshStatus();
  });

  // The keyboard: Ctrl+Z / Ctrl+Y undo and redo, Ctrl+S saves (unless a box is being typed in: it has its own undo)
  const onKey = (event) => {
    if (!(event.ctrlKey || event.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) { model.undo(); event.preventDefault(); } else if (key === 'y' || (key === 'z' && event.shiftKey)) { model.redo(); event.preventDefault(); } else if (key === 's') { save(); event.preventDefault(); }
  };

  const live = app.conn.on('state', () => { if (matchMode === 'live' || !canvas.hasState) canvas.draw(); });

  const body = h('div', { class: 'editor' }, bar, h('div', { class: 'editor-main' }, h('div', { class: 'editor-canvas' }, canvas.element), side));
  body.addEventListener('keydown', onKey);
  canvas.element.addEventListener('measured', () => layout.refresh());

  const editor = { model, canvas, save, showTab: (id) => showTab(id), get tab() { return current; } };
  app.designEditor = editor;
  const dialog = openModal({
    title: `Design: ${model.name}`, subtitle: name === active ? 'This design is on the overlay: saving shows on stream' : undefined,
    size: 'full', name: 'design-editor', stacked: true, body,
    footer: [status, revertButton, h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, 'Close'), saveButton],
    // closing with changes that were not saved asks first
    beforeClose: () => {
      if (!model.dirty) return true;
      confirmDialog({ title: 'Close without saving?', message: 'This design has changes that are not saved.', confirmLabel: 'Close without saving', danger: true })
        .then((yes) => { if (yes) closeModal({ force: true }); });
      return false;
    },
    onClose: () => {
      live();
      canvas.destroy();
      if (app.designEditor === editor) app.designEditor = null;
      if (onClose) onClose(model);
    }
  });

  // the canvas needs its real size before it can fit the overlay in it
  requestAnimationFrame(() => { canvas.fit(); canvas.element.focus({ preventScroll: true }); });
  refreshStatus();
  editor.dialog = dialog;
  return editor;
}
