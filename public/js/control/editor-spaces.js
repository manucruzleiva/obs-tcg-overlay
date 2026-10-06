/**
 * The "Spaces" tab of the design editor: the places a design keeps clear for something else on the overlay, a camera feed for example.
 * Each is a rectangle, a rounded one or an oval with a name (only for the editor), a place and a size, and it can have a picture that is
 * drawn over it (a frame with a see-through middle). On the canvas a space is dragged to move it, and a corner of it resized.
 */
import { h, icon } from './dom.js';

const THEME = window.OTO_THEME;

const ADD = [
  ['rect', 'A camera feed', 'A wide rectangle, 16 to 9'],
  ['rounded', 'Rounded', 'A wide rectangle with round corners'],
  ['circle', 'A circle', 'A round one (drag a corner to make it an oval)']
];

export class SpacesPanel {
  // `model`: the EditorModel; `canvas`: the EditorCanvas. `frameUrl(id)` is the address of the picture of a space, or null;
  // `upload(id)` asks for a picture and puts it on the space; `removePicture(id)` takes it off.
  constructor({ model, canvas, frameUrl, upload, removePicture }) {
    this.model = model;
    this.canvas = canvas;
    this.frameUrl = frameUrl;
    this.upload = upload;
    this.removePicture = removePicture;
    this.shape = ''; // what the list was last built for
    this.build();
    this.refresh();
  }

  build() {
    this.adders = ADD.map(([shape, label, help]) => h('button', {
      class: 'btn tiny', type: 'button', title: help, dataset: { add: shape },
      onclick: () => {
        const index = this.model.addSpace(shape);
        if (index >= 0) this.canvas.select(`space:${index}`);
      }
    }, icon('plus', 14), label));
    this.count = h('span', { class: 'hint' });
    this.list = h('div', { class: 'space-list' });
    this.element = h('div', { class: 'spaces-panel' },
      h('p', { class: 'settings-note' }, 'A reserved space keeps a place clear for something else, a camera feed for example. It is drawn as an outline of its shape, or with a picture of your own, and what is inside it stays see-through. Drag it on the overlay to move it and drag a corner to resize it (Shift keeps its shape), or type where it goes. Turn on the grid to line things up.'),
      h('div', { class: 'section-label' }, 'Add a space', this.count),
      h('div', { class: 'button-row' }, this.adders),
      this.list);
  }

  // Put what the model says into the list: rebuilt when spaces came or went, otherwise the values are updated where they are
  refresh() {
    const spaces = this.model.draft.spaces;
    const structure = spaces.map((space) => space.id).join(',');
    this.count.textContent = `${spaces.length} of ${THEME.SPACE_LIMITS.max}`;
    for (const button of this.adders) button.disabled = spaces.length >= THEME.SPACE_LIMITS.max;
    const typing = this.list.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
    if (structure !== this.structure || !typing && this.picturesChanged()) {
      this.structure = structure;
      this.rebuild();
    }
    const selected = this.canvas.selectedSpace;
    spaces.forEach((space, index) => {
      const card = this.list.children[index];
      if (!card || !card.dataset) return;
      card.classList.toggle('on', index === selected);
      for (const [key, input] of Object.entries(card.fields || {})) {
        if (document.activeElement !== input) input.value = key === 'name' ? (space.name || '') : String(space[key]);
      }
      if (card.shape && document.activeElement !== card.shape) card.shape.value = space.shape;
    });
  }

  // The pictures of the spaces changed since the list was built (one was put on a space, or taken off)
  picturesChanged() {
    const now = this.model.draft.spaces.map((space) => this.frameUrl(space.id) || '').join('|');
    if (now === this.pictures) return false;
    this.pictures = now;
    return true;
  }

  rebuild() {
    const spaces = this.model.draft.spaces;
    this.pictures = spaces.map((space) => this.frameUrl(space.id) || '').join('|');
    this.list.textContent = '';
    if (spaces.length === 0) {
      this.list.appendChild(h('p', { class: 'empty' }, 'No reserved spaces yet. Add one above.'));
      return;
    }
    spaces.forEach((space, index) => this.list.appendChild(this.card(space, index)));
  }

  card(space, index) {
    const fields = {};
    const number = (key, label, min, max) => {
      const input = h('input', { type: 'number', step: 1, min, max, 'aria-label': `${label} (space ${space.id})` });
      input.addEventListener('change', () => this.model.setSpace(index, { [key]: input.value }, { source: 'fields' }));
      fields[key] = input;
      return h('label', { class: 'crop-field' }, h('span', {}, label), input);
    };
    const { offset, minSize, maxSize, nameLength } = THEME.SPACE_LIMITS;
    const name = h('input', { type: 'text', maxlength: nameLength, placeholder: `Space ${space.id}`, 'aria-label': `Name of space ${space.id}` });
    name.addEventListener('change', () => this.model.setSpace(index, { name: name.value }, { source: 'fields' }));
    fields.name = name;
    const shape = h('select', { 'aria-label': `Shape of space ${space.id}` },
      THEME.SPACE_SHAPES.map((entry) => h('option', { value: entry.key }, entry.label)));
    shape.addEventListener('change', () => this.model.setSpace(index, { shape: shape.value }, { source: 'fields' }));

    const picture = this.frameUrl(space.id);
    const frame = h('div', { class: 'space-frame' },
      h('div', { class: 'image-preview' }, picture ? h('img', { src: picture, alt: '' }) : h('span', { class: 'muted' }, 'None')),
      h('div', { class: 'image-info' },
        h('strong', {}, 'Frame picture'),
        h('small', {}, 'Drawn over the space, stretched to fit: a frame with a see-through middle, for example'),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn tiny', type: 'button', dataset: { frame: String(space.id) }, onclick: () => this.upload(space.id) }, icon('upload', 14), picture ? 'Replace' : 'Upload'),
          picture && h('button', { class: 'btn tiny', type: 'button', onclick: () => this.removePicture(space.id) }, icon('trash', 14), 'Remove'))));

    const card = h('section', { class: 'space-card', dataset: { index: String(index), id: String(space.id) } },
      h('div', { class: 'space-head' }, name, shape,
        h('button', { class: 'round-btn small', type: 'button', title: 'Take this space away', 'aria-label': `Remove space ${space.id}`, onclick: () => this.model.removeSpace(index, { source: 'fields' }) }, icon('trash', 14))),
      h('div', { class: 'crop-fields' }, number('x', 'Across', -offset, offset), number('y', 'Down', -offset, offset), number('w', 'Wide', minSize, maxSize), number('h', 'High', minSize, maxSize)),
      frame);
    card.fields = fields;
    card.shape = shape;
    // picking the card picks the space on the overlay (a click on a box or a button inside it does what that does)
    card.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      this.canvas.select(`space:${index}`);
    });
    return card;
  }
}
