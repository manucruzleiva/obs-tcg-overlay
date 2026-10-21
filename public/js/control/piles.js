/**
 * The decklist of a trainer (pasted as Pokémon TCG Live exports it) and the cards out of play: the discard pile and the Lost Zone. The cards of
 * the decklist are offered first by every card picker of that trainer (see deckRow), and to put a card in a pile with one click.
 */
import { h, icon, replace } from './dom.js';
import { openModal, closeModal, confirmDialog } from './ui.js';

const DECKLIST = window.OTO_DECKLIST;
const GAME = window.OTO_GAME;
const SIDE_LABEL = { trainerA: 'Trainer A', trainerB: 'Trainer B' };
export const PILES = [
  { key: 'discard', label: 'Discard pile', short: 'Discard' },
  { key: 'lostZone', label: 'Lost Zone', short: 'Lost Zone' }
];
const pileOf = (key) => PILES.find((pile) => pile.key === key) || PILES[0];
const trainerName = (state, side) => state[side].name || SIDE_LABEL[side];
const ENERGY = Object.fromEntries(GAME.ENERGY_TYPES.map((type) => [type.key, type]));

const deckCards = (state, side) => (side && state[side] && state[side].decklist && state[side].decklist.cards) || [];

// The picture of a card in a pile or a decklist: its own, or for a basic Energy without one the icon of its type
export function pictureOf(card) {
  const own = card.image || (card.images && (card.images.small || card.images.large));
  if (own) return own;
  const key = card.energy || DECKLIST.basicEnergyOf(card.name || '');
  return key && ENERGY[key] ? ENERGY[key].icon : '';
}

// A card of the decklist as the card picker takes it (a search result)
export const asSearchResult = (card) => ({ id: card.cardId, name: card.name, images: card.images, setName: card.set, number: card.number, fromDeck: true });

// The cards of a trainer's decklist that a picker can use (`supertype` and `subtype` as the picker searches), as a row of buttons above the search,
// narrowed to what is typed (`query`). Null when the trainer has no decklist or none of its cards fit.
export function deckRow(state, side, { supertype = '', subtype = '', query = '', onPick }) {
  const words = DECKLIST.nameKey(query).split(' ').filter(Boolean);
  const cards = deckCards(state, side).filter((card) => DECKLIST.fits(card, supertype, subtype)
    && words.every((word) => DECKLIST.nameKey(card.name).split(' ').some((own) => own.startsWith(word))));
  if (cards.length === 0) return null;
  return h('div', { class: 'deck-cards' },
    h('div', { class: 'section-label' }, `From ${trainerName(state, side)}'s deck`, h('span', { class: 'hint' }, words.length ? `${cards.length} matching` : `${cards.length} cards`)),
    h('div', { class: 'deck-card-row' }, cards.map((card) => {
      const picture = pictureOf(card);
      return h('button', {
        class: `deck-card${card.cardId ? '' : ' not-found'}`, type: 'button', dataset: { card: card.cardId || card.name },
        title: card.cardId ? `${card.name} · ${card.set} ${card.number}` : `${card.name}: not in the card library on this computer. Click to search for it`,
        onclick: () => onPick(card)
      }, picture ? h('img', { src: picture, alt: '', loading: 'lazy' }) : h('span', { class: 'art-fallback' }, icon('star', 20)),
      h('span', { class: 'deck-card-name' }, card.name),
      h('span', { class: 'deck-card-count' }, `×${card.count}`));
    })));
}

// ----------------------------------------------------------------------------------------- decklist

// Paste a decklist for a trainer (or change it, or take it away): it is read on the server, which finds its cards in the card library
export function openDecklist(app, side) {
  const key = side || app.focus;
  const saved = () => app.state[key].decklist || { text: '', cards: [] };
  const area = h('textarea', {
    class: 'decklist-text', rows: 14, spellcheck: 'false', 'data-autofocus': true, 'aria-label': `${trainerName(app.state, key)} decklist`,
    placeholder: 'Pokémon: 12\n4 Dreepy TWM 128\n4 Drakloak TWM 129\n3 Dragapult ex TWM 130\n…\n\nTrainer: 36\n4 Arven SVI 166\n…\n\nEnergy: 12\n…'
  });
  area.value = saved().text || '';
  const preview = h('div', { class: 'decklist-preview', 'aria-live': 'polite' });
  const status = h('p', { class: 'hint-line' });

  // What the text holds, read in this page as it is typed (the server finds the cards when it is saved)
  const draw = () => {
    const { cards, skipped } = DECKLIST.parse(area.value);
    const known = new Map(saved().cards.map((card) => [`${card.count}|${card.name}|${card.set}|${card.number}`, card]));
    const total = DECKLIST.total(cards);
    const missing = saved().cards.filter((card) => !card.cardId).length;
    status.textContent = cards.length === 0
      ? 'Paste the list as Pokémon TCG Live exports it (Export, in the deck), or as Limitless TCG shows it: one card on each line, such as "4 Dragapult ex TWM 130".'
      : `${total} card${total === 1 ? '' : 's'}${total !== 60 ? ' (a deck has 60)' : ''}${skipped.length ? ` · ${skipped.length} line${skipped.length === 1 ? '' : 's'} not read: ${skipped.slice(0, 3).map((line) => `"${line}"`).join(', ')}` : ''}${area.value.trim() === (saved().text || '') && missing ? ` · ${missing} not in the card library (they are looked up by name when they are chosen)` : ''}`;
    status.classList.toggle('warn', skipped.length > 0);
    replace(preview, DECKLIST.SECTIONS.map((section) => {
      const list = cards.filter((card) => card.section === section);
      if (list.length === 0) return null;
      return h('div', { class: 'decklist-section' },
        h('div', { class: 'section-label' }, `${section} · ${DECKLIST.total(list)}`),
        h('ul', {}, list.map((card) => {
          const found = known.get(`${card.count}|${card.name}|${card.set}|${card.number}`);
          const picture = found ? pictureOf(found) : '';
          return h('li', { class: found && !found.cardId ? 'not-found' : '' }, picture ? h('img', { src: picture, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-empty' }),
            h('span', { class: 'count' }, `${card.count}`), h('span', { class: 'deck-line-name' }, card.name), h('small', {}, [card.set, card.number].filter(Boolean).join(' ')));
        })));
    }));
    save.disabled = area.value.trim() === (saved().text || '');
  };

  const send = async (text) => {
    const result = await app.act(`action:${key}`, { action: 'setDecklist', text });
    if (result.ok) closeModal();
  };
  const save = h('button', { class: 'btn primary', type: 'button', onclick: () => send(area.value) }, 'Save decklist');
  const remove = h('button', { class: 'btn danger-text', type: 'button', disabled: !saved().cards.length || undefined, onclick: async () => {
    if (await confirmDialog({ title: 'Remove the decklist?', message: `${trainerName(app.state, key)}'s cards will no longer be offered first.`, confirmLabel: 'Remove', danger: true })) send('');
  } }, 'Remove');
  area.addEventListener('input', draw);
  area.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !save.disabled) { event.preventDefault(); send(area.value); } });

  openModal({
    title: `Decklist · ${trainerName(app.state, key)}`, subtitle: 'Its cards are offered first when you choose a card for this trainer (Pokémon, tools, Stadium, prizes, discard pile).', size: 'lg', name: 'decklist',
    body: h('div', { class: 'decklist-editor' }, h('div', { class: 'decklist-input' }, area, status), preview),
    footer: [remove, h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, 'Cancel'), save]
  });
  draw();
}

// ------------------------------------------------------------------------------- discard pile and Lost Zone

// The discard pile and the Lost Zone of a trainer, in two tabs: the cards in each (the newest first), to move to the other pile or take out,
// and the cards of the decklist to put in with one click (or any card, by searching). It follows what other producers do while it is open.
export function openPiles(app, side, which = 'discard') {
  const key = side || app.focus;
  let pile = pileOf(which).key;
  const body = h('div', { class: 'piles-editor' });
  const act = (action, params) => app.act(`action:${key}`, { action, ...params });
  // a basic Energy put in a pile keeps its type, so the overlay can show its icon when it has no picture
  const add = (card) => act('pileAdd', {
    pile, cardId: card.cardId || '', name: card.name, image: (card.images && (card.images.small || card.images.large)) || '', energy: DECKLIST.basicEnergyOf(card.name) || undefined
  });

  const draw = () => {
    const trainer = app.state[key];
    const other = PILES.find((entry) => entry.key !== pile);
    const cards = trainer[pile] || [];
    replace(body,
      h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Pile' }, PILES.map((entry) => h('button', {
        class: `seg${entry.key === pile ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(entry.key === pile), dataset: { pile: entry.key },
        onclick: () => { pile = entry.key; draw(); }
      }, `${entry.label} (${(trainer[entry.key] || []).length})`))),
      h('div', { class: 'section-label' }, `${pileOf(pile).label} · ${cards.length} card${cards.length === 1 ? '' : 's'}`, h('span', { class: 'hint' }, 'the newest first'),
        h('span', { class: 'bench-controls' },
          h('button', { class: 'btn tiny', type: 'button', onclick: () => app.openPicker({ kind: 'pile', side: key, pile }) }, icon('search', 14), ' Search a card'),
          h('button', { class: 'btn tiny danger-text', type: 'button', disabled: cards.length === 0 || undefined, onclick: async () => {
            if (await confirmDialog({ title: `Empty the ${pileOf(pile).label}?`, message: `The ${cards.length} card${cards.length === 1 ? '' : 's'} in it will be taken out.`, confirmLabel: 'Empty', danger: true })) act('pileClear', { pile });
          } }, 'Empty'))),
      cards.length === 0
        ? h('p', { class: 'empty' }, `Nothing in the ${pileOf(pile).label} yet. Knocked out Pokémon go to the discard pile by themselves, with what was attached to them.`)
        : h('div', { class: 'pile-cards' }, cards.slice().reverse().map((card) => {
          const picture = pictureOf(card);
          return h('div', { class: 'pile-card', dataset: { id: card.id } },
            picture ? h('img', { src: picture, alt: '', loading: 'lazy', class: card.image ? '' : 'energy-icon' }) : h('span', { class: 'art-fallback' }, icon('star', 22)),
            h('span', { class: 'pile-card-name' }, card.name),
            h('div', { class: 'pile-card-actions' },
              h('button', { class: 'btn tiny', type: 'button', title: `Move it to the ${other.label}`, onclick: () => act('pileMove', { from: pile, to: other.key, id: card.id }) }, `→ ${other.short}`),
              h('button', { class: 'icon-btn small', type: 'button', title: `Take it out of the ${pileOf(pile).label}`, 'aria-label': `Take ${card.name} out`, onclick: () => act('pileRemove', { pile, id: card.id }) }, icon('close', 14))));
        })),
      deckRow(app.state, key, { onPick: (card) => add(card) }) || h('p', { class: 'hint-line' }, 'Paste the decklist of this trainer to put its cards in with one click, or search for a card.'));
  };

  const follow = app.conn.on('state', () => draw());
  openModal({
    title: `Cards out of play · ${trainerName(app.state, key)}`, subtitle: 'What is in the discard pile and the Lost Zone shows on the overlay.', size: 'lg', name: 'piles', body, onClose: follow,
    footer: h('button', { class: 'btn primary', type: 'button', onclick: () => closeModal() }, 'Done')
  });
  draw();
}

