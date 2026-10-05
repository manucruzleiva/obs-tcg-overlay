/**
 * The crop selector: pick which part of the card shows for the Active Pokémon and the bench, and which circle of a
 * Special Energy card shows on the Pokémon it is attached to. A card is drawn with a rectangle (or circle) on it
 * that can be moved, resized by its corners and edges, or drawn anew; there are presets for the usual choices
 * and exact numbers for the rest.
 */
import { h } from './dom.js';

const THEME = window.OTO_THEME;
const RULES = window.OTO_THEME_RULES;
const MIN = THEME.CROP_MIN_SIZE;
const WHOLE = { x: 0, y: 0, w: 1, h: 1 };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Math.round(value * 1000) / 1000;
const near = (a, b) => Math.abs(a - b) < 0.002;
const sameRect = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
const percent = (fraction) => String(Math.round(fraction * 1000) / 10);

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const LABELS = { active: 'Active Pokémon', bench: 'Bench', energy: 'Special energy' };
const CARD_ASPECT = THEME.CARD_ASPECT;

export class CropSelector {
  // `cards(which)` lists the pictures the rectangle can be shown on: [{ label, url }], the first one being the usual
  constructor({ model, cards }) {
    this.model = model;
    this.cards = cards;
    this.which = 'active';
    this.same = this.sameNow();
    this.drag = null;
    this.build();
    model.on(() => this.refresh());
    this.refresh();
  }

  // The Special Energy tab is about a circle, the others about a rectangle
  get circle() {
    return this.which === 'energy';
  }

  sameNow() {
    return sameRect(this.model.cropOf('active'), this.model.cropOf('bench'));
  }

  // ------------------------------------------------------------------------------------ structure

  build() {
    this.tabs = THEME.CROP_KEYS.map((which) => h('button', {
      class: 'seg', type: 'button', role: 'tab', dataset: { which },
      onclick: () => { this.which = which; this.refresh(); }
    }, LABELS[which]));

    this.sameInput = h('input', { type: 'checkbox', 'aria-label': 'Use the same crop for the bench' });
    this.sameInput.addEventListener('change', () => {
      this.same = this.sameInput.checked;
      if (this.same) this.write(this.model.cropOf(this.which), { commit: true });
      this.refresh();
    });
    this.sameSwitch = h('label', { class: 'switch' }, this.sameInput, h('span', { class: 'track' }), h('span', { class: 'switch-label' }, 'Same crop for the bench'));

    this.presets = THEME.CROP_PRESETS.map((preset) => h('button', {
      class: 'btn tiny', type: 'button', title: preset.help, dataset: { preset: preset.key },
      onclick: () => this.write({ ...preset.rect }, { commit: true })
    }, preset.label));

    // for Special Energy the choice is a circle: one preset, put back to the usual
    this.circlePresets = [h('button', {
      class: 'btn tiny', type: 'button', title: 'In the middle of the picture window', dataset: { preset: 'circle' },
      onclick: () => this.write({ ...THEME.ENERGY_CIRCLE }, { commit: true })
    }, 'The usual circle')];

    this.cardImage = h('img', { class: 'crop-card', alt: '', draggable: 'false' });
    this.handles = HANDLES.map((name) => h('span', { class: `crop-handle ${name}`, dataset: { handle: name } }));
    this.rect = h('div', { class: 'crop-rect', tabindex: '0', role: 'group', 'aria-label': 'The part of the card that shows. Arrow keys move it.' }, this.handles);
    this.stage = h('div', { class: 'crop-stage' }, this.cardImage, this.rect);

    this.cardSelect = h('select', { 'aria-label': 'Card to show the crop on', onchange: () => this.pickCard() });
    this.fields = {};
    const field = (key, label) => {
      const input = h('input', { type: 'number', min: 0, max: 100, step: 0.5, 'aria-label': `${label} (percent of the card)` });
      input.addEventListener('change', () => this.typed());
      this.fields[key] = input;
      const node = h('label', { class: 'crop-field' }, h('span', {}, label), input, h('small', {}, '%'));
      (this.fieldNodes = this.fieldNodes || {})[key] = node;
      return node;
    };
    this.summary = h('p', { class: 'crop-summary', 'aria-live': 'polite' });
    this.complaint = h('p', { class: 'prompt-complaint', role: 'alert', hidden: true });

    this.stage.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.stage.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.stage.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.stage.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    this.rect.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.element = h('div', { class: 'crop-panel' },
      h('p', { class: 'settings-note' }, 'Show only part of the card for the Pokémon on the table, for example just the picture. The overlay uses this part and takes its shape.'),
      h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Which Pokémon' }, this.tabs),
      this.sameSwitch,
      h('div', { class: 'section-label' }, 'Quick choices'),
      h('div', { class: 'button-row crop-presets' }, this.presets),
      h('div', { class: 'button-row crop-circle-presets' }, this.circlePresets),
      this.stage,
      h('label', { class: 'field crop-card-field' }, h('span', {}, 'Show it on'), this.cardSelect),
      h('div', { class: 'crop-fields' }, field('x', 'Left'), field('y', 'Top'), field('w', 'Width'), field('h', 'Height')),
      this.complaint, this.summary);
  }

  // ----------------------------------------------------------------------------------- the model

  current() {
    return this.model.cropOf(this.which);
  }

  // Write a rectangle for what is being edited (and for the bench too when they share one)
  write(rect, options) {
    const options2 = { source: 'crop', ...options };
    const clean = (this.circle ? RULES.cleanCircle(rect) : RULES.cleanRect(rect)) || this.current();
    this.model.setCrop(this.which, clean, { ...options2, commit: false });
    if (this.same && !this.circle) this.model.setCrop(this.which === 'active' ? 'bench' : 'active', clean, { ...options2, commit: false });
    if (options && options.commit) this.model.commit('crop');
  }

  refresh() {
    const rect = this.current();
    for (const tab of this.tabs) {
      tab.classList.toggle('on', tab.dataset.which === this.which);
      tab.setAttribute('aria-selected', String(tab.dataset.which === this.which));
    }
    if (document.activeElement !== this.sameInput) this.sameInput.checked = this.same;

    this.rect.classList.toggle('circle', this.circle);
    this.sameSwitch.hidden = this.circle;
    this.element.querySelector('.crop-presets').hidden = this.circle;
    this.element.querySelector('.crop-circle-presets').hidden = !this.circle;
    this.fieldNodes.h.hidden = this.circle;
    this.fieldNodes.w.querySelector('span').textContent = this.circle ? 'Size' : 'Width';
    for (const button of this.circlePresets) button.setAttribute('aria-pressed', String(RULES.isUsualCircle(rect)));
    this.rect.style.left = `${rect.x * 100}%`;
    this.rect.style.top = `${rect.y * 100}%`;
    this.rect.style.width = `${rect.w * 100}%`;
    this.rect.style.height = `${rect.h * 100}%`;
    for (const key of ['x', 'y', 'w', 'h']) if (document.activeElement !== this.fields[key]) this.fields[key].value = percent(rect[key]);
    for (const button of this.presets) {
      const preset = THEME.CROP_PRESETS.find((entry) => entry.key === button.dataset.preset);
      button.setAttribute('aria-pressed', String(sameRect(rect, preset.rect)));
    }
    const whole = sameRect(rect, WHOLE);
    this.summary.textContent = this.circle
      ? `A circle ${percent(rect.w)}% as wide as the card, cut out of each Special Energy card.`
      : whole ? 'The whole card shows.' : `Shows ${percent(rect.w)}% of the width and ${percent(rect.h)}% of the height of the card.`;
    this.fillCards();
  }

  // The pictures the rectangle can be drawn on (the match may have changed since last time)
  fillCards() {
    const cards = this.cards(this.which);
    const wanted = this.which + JSON.stringify(cards.map((card) => card.label));
    if (this.cardList !== wanted) {
      this.cardList = wanted;
      const keep = this.cardSelect.value;
      this.cardSelect.textContent = '';
      cards.forEach((card, index) => this.cardSelect.appendChild(h('option', { value: String(index) }, card.label)));
      if (keep && Number(keep) < cards.length) this.cardSelect.value = keep;
    }
    this.cardChoices = cards;
    const chosen = cards[Number(this.cardSelect.value) || 0] || cards[0];
    if (chosen && this.cardImage.getAttribute('src') !== chosen.url) this.cardImage.setAttribute('src', chosen.url);
  }

  pickCard() {
    const chosen = this.cardChoices[Number(this.cardSelect.value) || 0];
    if (chosen) this.cardImage.setAttribute('src', chosen.url);
  }

  // Numbers typed into the boxes
  typed() {
    const value = (key) => Number(this.fields[key].value) / 100;
    const rect = { x: value('x'), y: value('y'), w: value('w'), h: value('h') };
    const clean = this.circle ? RULES.cleanCircle(rect) : RULES.cleanRect(rect);
    this.complaint.hidden = Boolean(clean);
    if (!clean) {
      this.complaint.textContent = this.circle
        ? `That circle is not on the card. Left and top start at 0%; the size is at least ${MIN * 100}%, and the circle has to fit inside the card.`
        : `That is not on the card. Left and top start at 0%; the width and height are at least ${MIN * 100}%, and Left + Width and Top + Height are at most 100%.`;
      return;
    }
    this.write(clean, { commit: true });
  }

  // ---------------------------------------------------------------------------------- the mouse

  // A point of the pointer as fractions of the card
  at(event) {
    const box = this.stage.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width, 0, 1), y: clamp((event.clientY - box.top) / box.height, 0, 1) };
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    this.stage.setPointerCapture(event.pointerId);
    const handle = event.target.closest('[data-handle]');
    const point = this.at(event);
    const rect = this.current();
    if (handle) {
      // The handle may not be at the corner it stands for (a circle's are on the circle). The rectangle follows how far
      // the pointer moves from where it took hold, so nothing jumps when it is grabbed.
      const name = handle.dataset.handle;
      const corner = {
        x: name.includes('w') ? rect.x : name.includes('e') ? rect.x + rect.w : rect.x + rect.w / 2,
        y: name.includes('n') ? rect.y : name.includes('s') ? rect.y + rect.h : rect.y + rect.h / 2
      };
      this.drag = { kind: 'resize', handle: name, start: rect, offset: { x: corner.x - point.x, y: corner.y - point.y } };
    }
    else if (event.target.closest('.crop-rect') && !sameRect(rect, WHOLE)) this.drag = { kind: 'move', point, start: rect };
    else this.drag = { kind: 'draw', point, start: rect };
    this.rect.focus({ preventScroll: true });
    event.preventDefault();
  }

  onPointerMove(event) {
    const drag = this.drag;
    if (!drag) return;
    const point = this.at(event);
    let rect;
    if (drag.kind === 'move') {
      const dx = point.x - drag.point.x;
      const dy = point.y - drag.point.y;
      rect = { ...drag.start, x: clamp(drag.start.x + dx, 0, 1 - drag.start.w), y: clamp(drag.start.y + dy, 0, 1 - drag.start.h) };
    } else if (drag.kind === 'draw') {
      rect = this.between(drag.point, point);
    } else {
      rect = this.resized(drag.start, drag.handle, { x: point.x + drag.offset.x, y: point.y + drag.offset.y });
    }
    this.write(rect, {});
  }

  onPointerUp(event) {
    if (this.stage.hasPointerCapture && this.stage.hasPointerCapture(event.pointerId)) this.stage.releasePointerCapture(event.pointerId);
    if (!this.drag) return;
    this.drag = null;
    this.model.commit('crop');
  }

  // A circle grown from a corner that stays put: its size comes from how far the pointer is, in pixels of the
  // card, the way it looks. It stays on the card and is never smaller than the least allowed.
  circleFrom(anchor, point) {
    const right = point.x >= anchor.x;
    const down = point.y >= anchor.y;
    const side = Math.max(Math.abs(point.x - anchor.x), Math.abs(point.y - anchor.y) / CARD_ASPECT); // as a width
    const room = Math.min(right ? 1 - anchor.x : anchor.x, (down ? 1 - anchor.y : anchor.y) * CARD_ASPECT);
    const w = clamp(side, MIN, Math.max(MIN, room));
    const h = w / CARD_ASPECT;
    return { x: right ? anchor.x : anchor.x - w, y: down ? anchor.y : anchor.y - h, w, h };
  }

  // The rectangle with two corners at these points, never smaller than the least allowed
  between(a, b) {
    if (this.circle) return this.circleFrom(a, b);
    let x = Math.min(a.x, b.x);
    let y = Math.min(a.y, b.y);
    let w = Math.max(MIN, Math.abs(a.x - b.x));
    let h = Math.max(MIN, Math.abs(a.y - b.y));
    x = clamp(x, 0, 1 - MIN);
    y = clamp(y, 0, 1 - MIN);
    w = Math.min(w, 1 - x);
    h = Math.min(h, 1 - y);
    return { x, y, w, h };
  }

  // Drag one handle: the sides it touches move, the others stay
  resized(start, handle, point) {
    if (this.circle) {
      // a corner of the circle's square: the opposite corner stays where it is
      const anchor = { x: handle.includes('e') ? start.x : start.x + start.w, y: handle.includes('s') ? start.y : start.y + start.h };
      return this.circleFrom(anchor, point);
    }
    let left = start.x;
    let top = start.y;
    let right = start.x + start.w;
    let bottom = start.y + start.h;
    if (handle.includes('w')) left = clamp(point.x, 0, right - MIN);
    if (handle.includes('e')) right = clamp(point.x, left + MIN, 1);
    if (handle.includes('n')) top = clamp(point.y, 0, bottom - MIN);
    if (handle.includes('s')) bottom = clamp(point.y, top + MIN, 1);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  onKeyDown(event) {
    const step = event.shiftKey ? 0.05 : 0.01;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!move) return;
    const rect = this.current();
    const x = round3(clamp(rect.x + move[0], 0, 1 - rect.w));
    const y = round3(clamp(rect.y + move[1], 0, 1 - rect.h));
    this.write({ ...rect, x, y }, { commit: true });
    event.preventDefault();
  }
}
