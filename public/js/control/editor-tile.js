/**
 * The tile panel of the design editor: where the HP bar, the energy attached and the retreat cost go on the picture of a
 * Pokémon's card (at its top or bottom, in a corner, or below it), for the Active Pokémon and for the bench, and the picture on
 * the prize cards. A choice shows on the canvas as it is made, and what is not changed stays as it usually is.
 */
import { h } from './dom.js';

const THEME = window.OTO_THEME;
const GROUPS = [['active', 'Active Pokémon'], ['bench', 'Bench']];

export class TilePanel {
  constructor({ model }) {
    this.model = model;
    this.selects = new Map(); // `${kind}.${part}` -> the select
    this.build();
    model.on(() => this.refresh());
    this.refresh();
  }

  build() {
    const groups = GROUPS.map(([kind, label]) => h('fieldset', { class: 'tile-group', dataset: { kind } },
      h('legend', {}, label),
      THEME.tilePartsOf(kind).map((part) => {
        const select = h('select', { 'aria-label': `${label}: ${part.label}`, dataset: { part: part.key } },
          part.places.map((place) => h('option', { value: place }, THEME.TILE_PLACES[place])));
        select.addEventListener('change', () => this.model.setTile(kind, part.key, select.value, { source: 'tile' }));
        this.selects.set(`${kind}.${part.key}`, select);
        return h('label', { class: 'tile-field' }, h('span', {}, part.label), select);
      })));

    // the prize cards stay cards (grayed out when taken); this is what is printed on their back
    this.prize = h('select', { 'aria-label': 'Picture on the prize cards', dataset: { part: 'prizeStyle' } },
      THEME.PRIZE_STYLES.map((style) => h('option', { value: style.key }, style.label)));
    this.prize.addEventListener('change', () => this.model.setPrize(this.prize.value, { source: 'tile' }));
    this.prizeHelp = h('p', { class: 'settings-note prize-help' });
    // and how the six are laid out
    this.layout = h('select', { 'aria-label': 'Layout of the prize cards', dataset: { part: 'prizeLayout' } },
      THEME.PRIZE_LAYOUTS.map((layout) => h('option', { value: layout.key }, layout.label)));
    this.layout.addEventListener('change', () => this.model.setPrizeLayout(this.layout.value, { source: 'tile' }));
    const prizes = h('fieldset', { class: 'tile-group', dataset: { kind: 'prizes' } },
      h('legend', {}, 'Prize cards'),
      h('label', { class: 'tile-field' }, h('span', {}, 'Picture'), this.prize),
      h('label', { class: 'tile-field' }, h('span', {}, 'Layout'), this.layout),
      this.prizeHelp);

    this.reset = h('button', { class: 'btn tiny', type: 'button', onclick: () => this.model.update({ tile: {} }, { source: 'tile' }) }, 'Use the usual places');
    this.element = h('div', { class: 'tile-panel' },
      h('p', { class: 'settings-note' }, 'Each Pokémon shows the picture of its card (choose which part on the Card crop tab). Choose where its HP bar, the energy attached to it and its status icons go, and the retreat cost of the Active Pokémon (the bench does not show it): on the picture, or below it.'),
      groups,
      h('div', { class: 'button-row' }, this.reset),
      prizes);
  }

  refresh() {
    for (const [kind] of GROUPS) {
      const tile = this.model.tileOf(kind);
      for (const part of THEME.tilePartsOf(kind)) {
        const select = this.selects.get(`${kind}.${part.key}`);
        if (document.activeElement !== select) select.value = tile[part.key];
      }
    }
    this.reset.disabled = Object.keys(this.model.draft.tile).length === 0;

    const style = this.model.prizeOf();
    if (document.activeElement !== this.prize) this.prize.value = style;
    if (document.activeElement !== this.layout) this.layout.value = this.model.prizeLayoutOf();
    const chosen = THEME.PRIZE_STYLES.find((item) => item.key === style);
    this.prizeHelp.textContent = chosen && chosen.picture
      ? `The picture is the one in ${chosen.help}; a plain drawing shows when there is none. Prize cards that are taken fade out, as always.`
      : 'The design\'s own prize card back or card back picture, or the English card back when it has none. Prize cards that are taken fade out, as always.';
  }
}
