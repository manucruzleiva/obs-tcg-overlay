/**
 * The dialogs behind the keyboard shortcuts: pick a card, knock out, damage and heal, energy, bench,
 * prize cards, abilities, attack announcement, help, overlay preview and draft conflicts.
 */
import { h, icon, replace, debounce, energyStyle } from './dom.js';
import { openModal, closeModal } from './ui.js';

const GAME = window.OTO_GAME;
const SIDES = ['trainerA', 'trainerB'];
const SIDE_LABEL = { trainerA: 'Trainer A', trainerB: 'Trainer B' };
const otherSide = (side) => (side === 'trainerA' ? 'trainerB' : 'trainerA');
const hasPokemon = (pokemon) => Boolean(pokemon && (pokemon.cardId || pokemon.name));
const trainerName = (state, side) => state[side].name || SIDE_LABEL[side];

// ------------------------------------------------------------------------------ shared pieces

// Two buttons to choose which trainer a dialog is about
function sideTabs(app, current, onChange) {
  const node = h('div', { class: 'side-tabs', role: 'tablist' });
  const render = (side) => replace(node, SIDES.map((key) => h('button', {
    class: `side-tab ${key === 'trainerA' ? 'side-a' : 'side-b'}${key === side ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(key === side),
    onclick: () => { render(key); onChange(key); }
  }, trainerName(app.state, key))));
  render(current);
  return node;
}

// The Pokémon a trainer has in play, as { slot, pokemon } (slot -1 is the active one)
function inPlay(state, side) {
  const trainer = state[side];
  const list = [];
  if (hasPokemon(trainer.active)) list.push({ slot: -1, pokemon: trainer.active });
  trainer.bench.slice(0, trainer.benchSize).forEach((pokemon, index) => {
    if (hasPokemon(pokemon)) list.push({ slot: index, pokemon });
  });
  return list;
}

const slotLabel = (slot) => (slot === -1 ? 'Active' : `Bench ${slot + 1}`);

function hpText(pokemon) {
  return pokemon.hp && pokemon.hp.max ? `${pokemon.hp.current}/${pokemon.hp.max} HP` : '';
}

// A row of selectable Pokémon
function pokemonChoices(state, side, selected, onSelect, { multiple = false } = {}) {
  const chosen = new Set(Array.isArray(selected) ? selected : [selected]);
  const list = inPlay(state, side);
  const node = h('div', { class: 'choice-list' });
  const render = () => replace(node, list.length === 0
    ? h('p', { class: 'empty' }, `${trainerName(state, side)} has no Pokémon in play.`)
    : list.map(({ slot, pokemon }) => h('button', {
      class: `choice${chosen.has(slot) ? ' on' : ''}`, type: 'button', 'aria-pressed': String(chosen.has(slot)),
      onclick: () => {
        if (multiple) { if (chosen.has(slot)) chosen.delete(slot); else chosen.add(slot); } else { chosen.clear(); chosen.add(slot); }
        render();
        onSelect(multiple ? Array.from(chosen) : slot);
      }
    }, pokemon.image && h('img', { src: pokemon.image, alt: '' }), h('span', { class: 'choice-text' }, h('strong', {}, pokemon.name), h('span', {}, `${slotLabel(slot)} · ${hpText(pokemon)}`)))));
  render();
  return node;
}

// ---------------------------------------------------------------------------------- card picker

const FILTERS = [
  { label: 'All', value: '' },
  { label: 'Pokémon', value: 'Pokémon' },
  { label: 'Trainer', value: 'Trainer' },
  { label: 'Energy', value: 'Energy' }
];

// What kinds of search the picker does: Active, bench, stadium, a feature card, an evolution, a Special Energy
// card for a Pokémon (`countsAsTurn` and `onDone` belong to that one: whether it uses up the turn's energy
// attachment, and what to do when a card has been attached), or one of the prize cards (`onPick` gets the card: nothing is sent,
// the prize cards dialog behind it holds the choice).
export function openPicker(app, purpose) {
  const { kind, side, slot, countsAsTurn, onDone, onPick } = purpose;
  const state = app.state;
  const fixedFilter = kind === 'stadium' ? 'Stadium' : kind === 'special-energy' ? 'Energy' : kind === 'active' || kind === 'bench' || kind === 'evolve' ? 'Pokémon' : '';
  let filter = fixedFilter;
  let evolvesFrom = '';
  let token = 0;

  const titles = {
    active: `Deploy the Active Pokémon · ${side && trainerName(state, side)}`,
    bench: `Bench slot ${slot + 1} · ${side && trainerName(state, side)}`,
    stadium: 'Stadium',
    feature: 'Feature a card',
    evolve: 'Evolve',
    'special-energy': `Special Energy · ${side && trainerName(state, side)}`,
    prize: `Prize card ${slot + 1} · ${side && trainerName(state, side)}`
  };

  const input = h('input', { type: 'search', class: 'search-input', placeholder: kind === 'stadium' ? 'Search stadium cards…' : kind === 'special-energy' ? 'Search Special Energy cards, for example Double Turbo…' : 'Search by card name…', 'aria-label': 'Card name', 'data-autofocus': true, autocomplete: 'off' });
  const results = h('div', { class: 'card-grid', 'aria-live': 'polite' });
  const status = h('p', { class: 'picker-status' }, 'Type a card name to search.');
  // What the list shows: 'start' (the most used and the saved cards, before anything is typed), 'search' or nothing
  let showing = '';

  if (kind === 'evolve') {
    const mon = app.state[side][slot === -1 ? 'active' : 'bench'];
    evolvesFrom = (slot === -1 ? mon : mon[slot]).name;
    status.textContent = `Searching for evolutions of ${evolvesFrom}…`;
  }

  // A Stadium that is played uses the Stadium play of the turn of whoever plays it: the one who has the turn unless it is said otherwise,
  // and it can be left unused (a correction, or an effect that put it there)
  let playedBy = state.trainerA.isTurn ? 'trainerA' : state.trainerB.isTurn ? 'trainerB' : app.focus;
  let consume = true;
  const playRow = kind === 'stadium' ? h('div', { class: 'stadium-play' }) : null;
  const drawPlay = () => {
    if (!playRow) return;
    const counter = app.state[playedBy].resources.stadiumPerTurn;
    const used = counter.used >= counter.available;
    const box = h('input', { type: 'checkbox', checked: consume, 'aria-label': 'Uses the Stadium play of the turn' });
    box.addEventListener('change', () => { consume = box.checked; drawPlay(); });
    replace(playRow,
      h('div', { class: 'section-label' }, 'Played by'),
      sideTabs(app, playedBy, (next) => { playedBy = next; drawPlay(); }),
      h('label', { class: 'switch inline' }, box, h('span', { class: 'track' }), h('span', { class: 'switch-label' }, `Uses ${trainerName(app.state, playedBy)}'s Stadium play for the turn`)),
      h('p', { class: `hint-line${consume && used ? ' warn' : ''}` }, consume
        ? (used ? `${trainerName(app.state, playedBy)} already played a Stadium this turn. Turn this off for a correction or an effect.` : "Uses up the turn's Stadium play.")
        : "The turn's Stadium play stays available."));
  };
  drawPlay();

  const pick = async (card) => {
    // where the card came from goes with it, so the details (attacks, abilities) are asked of the same service
    const cardData = { id: card.id, name: card.name, hp: card.hp, images: card.images, source: card.source, language: card.language };
    let result;
    if (kind === 'feature') {
      result = await app.act('action:card', { action: 'addFeatureCard', cardId: card.id, name: card.name, image: (card.images && (card.images.large || card.images.small)) || '' });
    } else if (kind === 'stadium') {
      result = await app.act('action:card', { action: 'select', target: 'stadium', cardId: card.id, cardData, playedBy, consume });
    } else if (kind === 'special-energy') {
      result = await app.act(`action:${side}`, {
        action: 'attachSpecialEnergy', slot, cardId: card.id, name: card.name,
        image: (card.images && (card.images.large || card.images.small)) || '', countsAsTurn: countsAsTurn !== false
      });
    } else if (kind === 'prize') {
      // a prize card is small on the overlay: the small picture is enough
      onPick({ cardId: card.id, name: card.name, image: (card.images && (card.images.small || card.images.large)) || '' });
      result = { ok: true };
    } else {
      const target = `${side}-${slot === undefined || slot === -1 ? 'active' : `bench-${slot}`}`;
      result = await app.act('action:card', { action: 'select', target, cardId: card.id, cardData, evolve: kind === 'evolve' });
    }
    if (result.ok) {
      // counted, so it is offered first next time (nobody waits for this)
      fetch('/api/cards/used', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) }).catch(() => {});
      closeModal();
      if (onDone) onDone();
    }
  };

  // The star on a card: it shows whether the card is a favorite (also when another producer changes it)
  const isFavorite = (card) => app.state.favoriteCardIds.includes(card.id);
  const showStar = (button, on) => {
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'A favorite: click (or right-click the card) to take the star off' : 'Mark as a favorite: it is listed first next time (right-click on the card does the same)';
  };
  const render = (cards) => {
    replace(results, cards.map((card) => {
      const star = h('button', { class: 'star-btn', type: 'button', 'aria-label': `Favorite: ${card.name}`, dataset: { card: card.id } }, icon('star', 16));
      showStar(star, isFavorite(card));
      const toggleStar = async () => {
        const was = isFavorite(card);
        const result = await app.act('action:card', { action: 'favorite', cardId: card.id });
        if (!result.ok) return;
        showStar(star, !was);
        // so the card can be listed with the favorites later, whatever the picture it was found with
        if (!was) fetch('/api/cards/known', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) }).catch(() => {});
      };
      star.addEventListener('click', toggleStar);
      return h('div', { class: 'card-tile', oncontextmenu: (event) => { event.preventDefault(); toggleStar(); } },
        h('button', { class: 'card-pick', type: 'button', onclick: () => pick(card), title: `${card.name} · ${card.setName} #${card.number}` },
          card.images && card.images.small ? h('img', { src: card.images.small, alt: card.name, loading: 'lazy' }) : h('span', { class: 'art-fallback' }, icon('star', 28)),
          h('span', { class: 'card-name' }, card.name),
          h('span', { class: 'card-meta' }, `${card.setName} #${card.number}`)),
        star);
    }));
  };
  // another producer's star shows here too
  const followStars = app.conn.on('state', () => {
    for (const star of results.querySelectorAll('.star-btn')) showStar(star, app.state.favoriteCardIds.includes(star.dataset.card));
  });

  // Load one page of results: the first replaces the list, later ones ("Show more") add to it
  let listed = [];
  const moreButton = h('button', { class: 'btn', type: 'button', hidden: true }, 'Show more');
  const load = async (pageNumber) => {
    const text = input.value.trim();
    const mine = ++token;
    // Nothing typed: start from the cards used most, then the ones already saved on this computer
    const starting = !text && !evolvesFrom;
    status.textContent = starting ? 'Looking at the cards on this computer…' : 'Searching…';
    const params = new URLSearchParams({ page: String(pageNumber) });
    if (text) params.set('q', text);
    // The card API groups cards as Pokémon, Trainer or Energy; a Stadium is a kind of Trainer
    if (kind === 'stadium') { params.set('supertype', 'Trainer'); params.set('subtype', 'Stadium'); }
    else if (kind === 'special-energy') { params.set('supertype', 'Energy'); params.set('subtype', 'Special'); }
    else if (filter) params.set('supertype', filter);
    if (evolvesFrom) params.set('evolvesFrom', evolvesFrom);
    try {
      const response = await fetch(starting ? `/api/cards/popular?${params}` : `/api/cards/search?${params}`);
      const data = await response.json();
      if (mine !== token) return;
      if (!response.ok) throw new Error(data.error || 'Search failed');
      listed = pageNumber === 1 ? data.cards : listed.concat(data.cards);
      showing = starting ? 'start' : 'search';
      if (starting) {
        // what the list is made of, in the order it is listed
        const parts = [data.favorites > 0 && 'Your favorite cards', data.used > 0 && 'your most used cards', (data.saved === undefined ? data.source !== 'used' : data.saved > 0) && 'cards saved on this computer'].filter(Boolean);
        const what = parts.join(', then ').replace(/^./, (letter) => letter.toUpperCase());
        status.textContent = listed.length
          ? `${what} (${data.totalCount > listed.length ? `showing ${listed.length} of ${data.totalCount}` : data.totalCount}). Type a card name to search for others.`
          : 'Type a card name to search. The cards you use, and the ones you give a star, are listed here next time.';
      } else {
        const where = data.source === 'library' ? ` in your ${data.library} library` : data.source === 'tcgdex' ? ' on TCGdex' : data.source === 'scrydex' ? ' on Scrydex' : '';
        // TCGdex does not say how many cards there are in all: a full page means there may be more
        const open = data.source === 'tcgdex' && data.hasMore;
        status.textContent = listed.length
          ? `${open ? `${listed.length}+` : data.totalCount} cards found${where}${!open && data.totalCount > listed.length ? ` (showing ${listed.length})` : ''}`
          : data.offline ? `Nothing in your ${data.library} library matches, and the online search cannot be reached.` : `No cards found${where}.`;
      }
      render(listed);
      moreButton.hidden = listed.length >= data.totalCount || data.cards.length === 0;
      moreButton.onclick = () => load(pageNumber + 1);
    } catch (error) {
      if (mine !== token) return;
      replace(results);
      moreButton.hidden = true;
      status.textContent = `Could not search: ${error.message}. Check the internet connection.`;
    }
  };
  const search = () => load(1);
  const searchSoon = debounce(search, 280);
  input.addEventListener('input', () => {
    // The first letters replace the starting list at once, or the answer for it that is still on its way (it is dropped):
    // Enter cannot choose a card the person did not mean
    if (input.value.trim() && showing !== 'search') {
      token++;
      showing = '';
      listed = [];
      replace(results);
      moreButton.hidden = true;
      status.textContent = 'Searching…';
    }
    searchSoon();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // with nothing typed the list is a suggestion, not an answer: Enter does not choose from it
    if (!input.value.trim() && !evolvesFrom) return;
    const first = results.querySelector('.card-pick');
    if (first) first.click(); else search();
  });

  const chips = !fixedFilter
    ? h('div', { class: 'filter-chips' }, FILTERS.map((entry) => h('button', {
      class: `chip${entry.value === filter ? ' on' : ''}`, type: 'button',
      onclick: (event) => {
        filter = entry.value;
        for (const node of event.currentTarget.parentElement.children) node.classList.toggle('on', node === event.currentTarget);
        search();
      }
    }, entry.label)))
    : null;

  // Promote a Pokémon already on the bench instead of searching for a new one
  const benchChoices = kind === 'active'
    ? inPlay(state, side).filter((entry) => entry.slot !== -1)
    : [];
  const fromBench = benchChoices.length > 0 && h('div', { class: 'from-bench' },
    h('div', { class: 'section-label' }, 'Or bring one up from the bench'),
    h('div', { class: 'choice-list row' }, benchChoices.map(({ slot: benchSlot, pokemon }) => h('button', {
      class: 'choice', type: 'button',
      onclick: async () => { const result = await app.act(`action:${side}`, { action: 'swapWithActive', slot: benchSlot }); if (result.ok) closeModal(); }
    }, pokemon.image && h('img', { src: pokemon.image, alt: '' }), h('span', { class: 'choice-text' }, h('strong', {}, pokemon.name), h('span', {}, `Bench ${benchSlot + 1} · ${hpText(pokemon)}`))))));

  openModal({
    title: titles[kind], size: 'lg', name: 'picker', stacked: kind === 'special-energy' || kind === 'prize', // over the energy editor or the prize cards that asked for it
    onClose: followStars,
    body: [fromBench, playRow, h('div', { class: 'search-row' }, h('span', { class: 'search-icon' }, icon('search', 18)), input), chips, status, results, h('div', { class: 'more-row' }, moreButton)]
  });
  search();
}

// ------------------------------------------------------------------------------------ knock out

export function openKO(app, side, slot) {
  const state = app.state;
  let current = side || app.focus;
  let chosenSlot = slot;
  let prizes = 1;
  let clear = true;

  const body = h('div', {});
  const prizeButtons = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Prize cards taken' });
  const draw = () => {
    const list = inPlay(state, current);
    if (!list.some((entry) => entry.slot === chosenSlot)) chosenSlot = list.length ? list[0].slot : undefined;
    replace(prizeButtons, [1, 2, 3].map((n) => h('button', {
      class: `seg${n === prizes ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(n === prizes),
      onclick: () => { prizes = n; draw(); }
    }, `${n} prize${n === 1 ? '' : 's'}`, h('kbd', {}, String(n)))));
    replace(body,
      sideTabs(app, current, (next) => { current = next; chosenSlot = undefined; draw(); }),
      h('div', { class: 'section-label' }, 'Which Pokémon was knocked out?'),
      pokemonChoices(state, current, chosenSlot, (value) => { chosenSlot = value; }),
      h('div', { class: 'section-label' }, `Prize cards ${trainerName(state, otherSide(current))} takes`),
      prizeButtons,
      h('label', { class: 'switch inline' }, (() => {
        const box = h('input', { type: 'checkbox', checked: clear });
        box.addEventListener('change', () => { clear = box.checked; });
        return box;
      })(), h('span', { class: 'track' }), h('span', { class: 'switch-label' }, 'Take it off the table')));
  };

  const confirm = async () => {
    if (chosenSlot === undefined) return;
    const result = await app.act(`action:${current}`, { action: 'knockOut', slot: chosenSlot, prizes, clear });
    if (!result.ok) return;
    const wasActive = chosenSlot === -1;
    closeModal();
    // The Active Pokémon is gone: offer the next one right away
    if (wasActive && clear) app.openPicker({ kind: 'active', side: current });
  };

  draw();
  const modal = openModal({
    title: 'Knock out', subtitle: 'Announces it, clears the slot and moves the prize cards', size: 'md', name: 'ko', body,
    footer: [h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn danger', type: 'button', 'data-autofocus': true, onclick: confirm }, icon('skull', 16), 'Knock out')]
  });
  modal.root.addEventListener('keydown', (event) => {
    if (['1', '2', '3'].includes(event.key) && event.target.tagName !== 'INPUT') { prizes = Number(event.key); draw(); }
    if (event.key === 'Enter' && event.target.tagName !== 'BUTTON') confirm();
  });
}

// ----------------------------------------------------------------------------- damage and heal

export function openDamage(app, mode, side, slot) {
  const state = app.state;
  const holder = state.trainerA.isTurn ? 'trainerA' : state.trainerB.isTurn ? 'trainerB' : null;
  // damage lands on the trainer who is not attacking; healing on the one in focus
  let current = side || (mode === 'damage' && holder ? otherSide(holder) : app.focus);
  let targets = slot !== undefined ? [slot] : [-1];
  let healing = mode === 'heal';
  let amount = 0;

  const body = h('div', {});
  const amountInput = h('input', { type: 'number', min: 0, max: 9999, step: 10, value: '0', class: 'amount-input', 'aria-label': 'Amount', 'data-autofocus': true });
  const preview = h('div', { class: 'preview-list' });

  const updatePreview = () => {
    amount = tens(amountInput.value);
    replace(preview, targets.map((target) => {
      const pokemon = target === -1 ? state[current].active : state[current].bench[target];
      if (!hasPokemon(pokemon)) return null;
      const before = pokemon.hp.current;
      const max = pokemon.hp.max;
      const after = max ? Math.max(0, Math.min(max, before + (healing ? amount : -amount))) : before;
      return h('div', { class: 'preview-row' }, h('strong', {}, pokemon.name), h('span', {}, max ? `${before} → ${after} / ${max}` : 'HP not set'));
    }));
  };
  amountInput.addEventListener('input', updatePreview);
  // a number typed in is brought to the nearest ten when the box is left: damage and healing come in tens
  amountInput.addEventListener('change', () => { amountInput.value = String(tens(amountInput.value)); updatePreview(); });

  const quick = (n) => h('button', { class: 'btn quick', type: 'button', onclick: () => { amountInput.value = String((parseInt(amountInput.value, 10) || 0) + n); updatePreview(); } }, `+${n}`);

  const draw = () => {
    replace(body,
      h('div', { class: 'segmented wide', role: 'radiogroup' },
        h('button', { class: `seg${!healing ? ' on' : ''}`, type: 'button', onclick: () => { healing = false; draw(); } }, icon('drop', 16), 'Damage', h('kbd', {}, 'D')),
        h('button', { class: `seg${healing ? ' on' : ''}`, type: 'button', onclick: () => { healing = true; draw(); } }, icon('plus', 16), 'Heal', h('kbd', {}, 'H'))),
      sideTabs(app, current, (next) => { current = next; targets = [-1]; draw(); }),
      h('div', { class: 'section-label' }, 'Targets (choose one or more)'),
      pokemonChoices(state, current, targets, (value) => { targets = value; updatePreview(); }, { multiple: true }),
      h('div', { class: 'section-label' }, 'Amount', h('span', { class: 'hint' }, 'In tens: 10, 20, 30...')),
      h('div', { class: 'amount-row' }, amountInput, [10, 20, 30, 50, 100].map(quick),
        h('button', { class: 'btn quick', type: 'button', onclick: () => { amountInput.value = '0'; updatePreview(); } }, 'Clear')),
      preview);
    updatePreview();
    amountInput.focus();
    amountInput.select();
  };

  const apply = async () => {
    if (!amount || targets.length === 0) return;
    for (const target of targets) {
      if (!hasPokemon(target === -1 ? state[current].active : state[current].bench[target])) continue;
      const signed = healing ? -amount : amount;
      const result = await app.act(`action:${current}`, target === -1
        ? { action: 'activeDamage', amount: signed }
        : { action: 'benchDamage', slot: target, amount: signed });
      if (!result.ok) return;
    }
    closeModal();
  };

  const modal = openModal({
    title: 'Damage and heal', size: 'md', name: 'damage', body,
    footer: [h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: apply }, 'Apply')]
  });
  draw();
  modal.root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName !== 'BUTTON') { event.preventDefault(); apply(); }
  });
}

// ----------------------------------------------------------------------------------------- energy

export function openEnergy(app, side, slot) {
  let current = side || app.focus;
  let target = slot;
  let counts = {};
  let countsAsTurn = true;

  const body = h('div', {});

  const draw = () => {
    const state = app.state;
    const list = inPlay(state, current);
    if (!list.some((entry) => entry.slot === target)) target = list.length ? list[0].slot : undefined;
    const pokemon = target === undefined ? null : target === -1 ? state[current].active : state[current].bench[target];
    const counter = state[current].resources.energyPerTurn;
    const used = counter.used >= counter.available;
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

    const grid = h('div', { class: 'energy-grid' }, GAME.ENERGY_TYPES.map((type) => h('button', {
      class: `energy-pick${counts[type.key] ? ' on' : ''}`, type: 'button', style: energyStyle(type),
      onclick: () => { counts[type.key] = (counts[type.key] || 0) + 1; draw(); },
      oncontextmenu: (event) => { event.preventDefault(); counts[type.key] = Math.max(0, (counts[type.key] || 0) - 1); draw(); }
    }, h('span', { class: 'energy-dot' }), type.label, counts[type.key] ? h('span', { class: 'energy-count' }, `×${counts[type.key]}`) : null)));

    const specials = pokemon ? pokemon.specialEnergies || [] : [];
    const attachedNow = pokemon && ((pokemon.energies || []).length || specials.length)
      ? h('div', { class: 'chips energies' },
        (pokemon.energies || []).map((type, index) => h('button', {
          class: 'energy-chip', type: 'button', title: `Remove ${type} energy`, style: energyStyle(GAME.ENERGY_TYPES.find((t) => t.key === type) || GAME.ENERGY_TYPES[10]),
          onclick: async () => { await app.act(`action:${current}`, { action: 'removeEnergy', slot: target, index }); draw(); }
        })),
        specials.map((card, index) => h('button', {
          class: 'energy-chip special', type: 'button', title: `Remove ${card.name}`, 'aria-label': `Remove ${card.name}`,
          onclick: async () => { await app.act(`action:${current}`, { action: 'removeSpecialEnergy', slot: target, index }); draw(); }
        }, card.image && h('img', { src: card.image, alt: '' }))))
      : h('p', { class: 'empty' }, 'No energy attached yet.');

    replace(body,
      sideTabs(app, current, (next) => { current = next; target = undefined; counts = {}; draw(); }),
      h('div', { class: 'section-label' }, 'Attach to'),
      pokemonChoices(state, current, target, (value) => { target = value; draw(); }),
      h('div', { class: 'section-label' }, 'Energy to attach', h('span', { class: 'hint' }, 'Click to add, right-click to take one back')),
      grid,
      h('div', { class: 'section-label' }, 'Special Energy cards', h('span', { class: 'hint' }, 'Shown as a circle cut out of the card')),
      h('div', { class: 'button-row' }, h('button', {
        class: 'btn', type: 'button', disabled: target === undefined || undefined,
        onclick: () => openPicker(app, { kind: 'special-energy', side: current, slot: target, countsAsTurn, onDone: draw })
      }, icon('plus', 16), 'Add a Special Energy card…')),
      h('label', { class: 'switch inline' }, (() => {
        const box = h('input', { type: 'checkbox', checked: countsAsTurn });
        box.addEventListener('change', () => { countsAsTurn = box.checked; draw(); });
        return box;
      })(), h('span', { class: 'track' }), h('span', { class: 'switch-label' }, "Counts as this turn's energy attachment")),
      h('p', { class: `hint-line${countsAsTurn && used ? ' warn' : ''}` }, countsAsTurn
        ? (used ? `${trainerName(state, current)} already attached this turn. Turn this off for a special attachment (an ability or a card effect).` : "Uses up the turn's attachment.")
        : "A special attachment: the turn's attachment stays available."),
      h('div', { class: 'section-label' }, `Attached now${pokemon ? ` to ${pokemon.name}` : ''}`),
      attachedNow);

    attachButton.disabled = total === 0 || target === undefined;
    attachButton.textContent = total ? `Attach ${total} energy` : 'Attach';
  };

  const attach = async () => {
    for (const [type, count] of Object.entries(counts)) {
      if (!count) continue;
      const result = await app.act(`action:${current}`, { action: 'attachEnergy', slot: target, energyType: type, count, countsAsTurn });
      if (!result.ok) return;
      // only the first batch can use up the turn's attachment
      countsAsTurn = false;
    }
    closeModal();
  };

  const attachButton = h('button', { class: 'btn primary', type: 'button', onclick: attach }, 'Attach');
  const modal = openModal({
    title: 'Energy', size: 'lg', name: 'energy', body,
    footer: [h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Close'), attachButton]
  });
  draw();
  modal.root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName !== 'BUTTON' && !attachButton.disabled) attach();
  });
}

// ----------------------------------------------------------------------------------------- prizes

const PRIZE_SLOTS = 6;
const sameCard = (a, b) => (a ? Boolean(b) && a.cardId === b.cardId && a.name === b.name && a.image === b.image : !b);

// Choose the cards that are the prizes of a trainer: up to six, one on each prize card. They show on the overlay on the prize cards (face
// down with a question mark while the prizes are hidden). Nothing is sent until "Set prizes".
export function openPrizes(app, side) {
  const key = side || app.focus;
  const saved = () => (app.state[key].prizes.cards || []);
  // what is chosen so far, a card ({ cardId, name, image }) or nothing (null) for each prize card
  const cards = Array.from({ length: PRIZE_SLOTS }, (_, index) => saved()[index] || null);
  const body = h('div', {});

  const choose = (index) => openPicker(app, { kind: 'prize', side: key, slot: index, onPick: (card) => { cards[index] = card; draw(); } });
  const apply = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    const result = await app.act(`action:${key}`, { action: 'prizeCardsSet', cards });
    if (result.ok) closeModal();
  } }, 'Set prizes');
  const clearAll = h('button', { class: 'btn tiny', type: 'button', onclick: () => { cards.fill(null); draw(); } }, 'Clear all');

  function draw() {
    const left = app.state[key].prizes.count; // the prize cards from the right are the ones taken
    replace(body,
      h('p', { class: 'hint-line' }, 'Choose the card of each prize. They show on the prize cards of the overlay, and turn face down with the Hide prizes switch. Prize cards that are taken fade out, from the right.'),
      h('div', { class: 'prize-slots' }, cards.map((card, index) => h('div', { class: `prize-slot${card ? ' filled' : ''}${index >= left ? ' taken' : ''}`, dataset: { slot: index } },
        h('button', {
          class: 'prize-pick', type: 'button', 'data-autofocus': index === 0 || undefined,
          'aria-label': card ? `Prize card ${index + 1}: ${card.name}. Choose another card` : `Prize card ${index + 1}: choose a card`,
          onclick: () => choose(index)
        }, card && card.image ? h('img', { src: card.image, alt: '' }) : card ? icon('star', 28) : icon('plus', 24)),
        h('span', { class: 'prize-slot-name' }, card ? card.name : `Prize ${index + 1}`),
        card ? h('button', { class: 'btn tiny danger-text', type: 'button', 'aria-label': `Clear prize card ${index + 1}`, onclick: () => { cards[index] = null; draw(); } }, 'Clear') : h('span', { class: 'prize-slot-gap' })))),
      h('div', { class: 'button-row' }, clearAll));
    clearAll.disabled = !cards.some(Boolean);
    apply.disabled = cards.every((card, index) => sameCard(card, saved()[index] || null));
  }

  draw(); // before it opens, so the first prize card is there to take the focus
  openModal({
    title: `Prize cards · ${trainerName(app.state, key)}`, subtitle: 'Put cards on the prizes', size: 'lg', name: 'prizes', body,
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, 'Cancel'), apply]
  });
}

// ------------------------------------------------------------------------------------------ bench

export function openBench(app, side) {
  let current = side || app.focus;
  const body = h('div', {});

  const draw = () => {
    const state = app.state;
    const trainer = state[current];
    replace(body,
      sideTabs(app, current, (next) => { current = next; draw(); }),
      h('div', { class: 'section-label' }, `Bench · ${trainer.benchSize} slots`,
        h('span', { class: 'bench-controls' },
          h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Smaller bench', onclick: async () => { await app.act(`action:${current}`, { action: 'benchSizeMinus' }); draw(); } }, icon('minus', 14)),
          h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Bigger bench', onclick: async () => { await app.act(`action:${current}`, { action: 'benchSizePlus' }); draw(); } }, icon('plus', 14)),
          h('button', { class: 'btn tiny', type: 'button', title: 'Back to the usual 5 slots', disabled: trainer.benchSize === 5 || undefined, onclick: async () => { await app.act(`action:${current}`, { action: 'benchSizeReset' }); draw(); } }, 'Reset to 5'))),
      h('div', { class: 'bench-list' }, trainer.bench.slice(0, trainer.benchSize).map((pokemon, index) => {
        const present = hasPokemon(pokemon);
        return h('div', { class: `bench-row${present ? '' : ' empty'}` },
          h('span', { class: 'bench-index' }, index + 1),
          present ? h('span', { class: 'bench-name' }, pokemon.name, h('small', {}, hpText(pokemon))) : h('span', { class: 'bench-name muted' }, 'Empty'),
          h('div', { class: 'bench-actions' },
            h('button', { class: 'btn tiny', type: 'button', onclick: () => app.openPicker({ kind: 'bench', side: current, slot: index }) }, present ? 'Replace' : 'Add Pokémon'),
            present && h('button', { class: 'btn tiny', type: 'button', onclick: async () => { await app.act(`action:${current}`, { action: 'swapWithActive', slot: index }); draw(); } }, 'Switch in'),
            present && h('button', { class: 'btn tiny', type: 'button', onclick: () => app.openEvolve(current, index) }, 'Evolve'),
            present && h('button', { class: 'btn tiny danger-text', type: 'button', onclick: async () => { await app.act(`action:${current}`, { action: 'clearSlot', slot: index }); draw(); } }, 'Remove')));
      })));
  };

  openModal({ title: 'Bench', size: 'md', name: 'bench', body, footer: h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Done') });
  draw();
}

// -------------------------------------------------------------------------------------- abilities

export function openAbilities(app, side) {
  let current = side || app.focus;
  let draftTarget = -1;
  let draftScope = 'turn';
  const body = h('div', {});
  const nameInput = h('input', { type: 'text', maxlength: 60, placeholder: 'Ability or token name', 'aria-label': 'New token name' });

  const draw = () => {
    const state = app.state;
    const list = inPlay(state, current);
    if (!list.some((entry) => entry.slot === draftTarget)) draftTarget = list.length ? list[0].slot : -1;

    const rows = list.map(({ slot, pokemon }) => h('div', { class: 'ability-row' },
      h('div', { class: 'ability-owner' }, h('strong', {}, pokemon.name), h('small', {}, slotLabel(slot))),
      h('div', { class: 'chips abilities' },
        (pokemon.abilities || []).length === 0 ? h('span', { class: 'muted' }, 'No ability tokens') : pokemon.abilities.map((ability, index) => h('span', { class: 'ability-token' },
          h('button', {
            class: `ability-chip${ability.used ? ' used' : ''}`, type: 'button', 'aria-pressed': String(Boolean(ability.used)),
            title: `${ability.scope === 'game' ? 'Once per game' : 'Once per turn'}: click to mark ${ability.used ? 'ready' : 'used'}`,
            onclick: async () => { await app.act(`action:${current}`, { action: 'setAbilityUsed', slot, index, used: !ability.used }); draw(); }
          }, h('span', { class: 'diamond' }), ability.name, ability.scope === 'game' && h('small', {}, ' · game'), ability.used && h('span', { class: 'used-tag' }, 'USED')),
          h('button', { class: 'round-btn small', type: 'button', 'aria-label': `Remove ${ability.name}`, onclick: async () => { await app.act(`action:${current}`, { action: 'removeAbility', slot, index }); draw(); } }, icon('close', 12)))))));

    const select = h('select', { 'aria-label': 'Add to which Pokémon' }, list.map(({ slot, pokemon }) => h('option', { value: slot, selected: slot === draftTarget }, `${pokemon.name} (${slotLabel(slot)})`)));
    select.addEventListener('change', () => { draftTarget = Number(select.value); });
    const scope = h('select', { 'aria-label': 'How often' },
      h('option', { value: 'turn', selected: draftScope === 'turn' }, 'Once per turn'),
      h('option', { value: 'game', selected: draftScope === 'game' }, 'Once per game'));
    scope.addEventListener('change', () => { draftScope = scope.value; });

    replace(body,
      sideTabs(app, current, (next) => { current = next; draw(); }),
      h('div', { class: 'section-label' }, 'Click a token to mark it used or ready', h('button', { class: 'btn tiny', type: 'button', onclick: async () => { await app.act(`action:${current}`, { action: 'resetAbilities' }); draw(); } }, 'All ready')),
      list.length === 0 ? h('p', { class: 'empty' }, `${trainerName(state, current)} has no Pokémon in play.`) : h('div', { class: 'ability-list' }, rows),
      list.length > 0 && h('div', { class: 'section-label' }, 'Add a token'),
      list.length > 0 && h('div', { class: 'add-token' }, select, nameInput, scope,
        h('button', { class: 'btn', type: 'button', onclick: addToken }, icon('plus', 16), 'Add')));
  };

  const addToken = async () => {
    if (!nameInput.value.trim()) { nameInput.focus(); return; }
    const result = await app.act(`action:${current}`, { action: 'addAbility', slot: draftTarget, name: nameInput.value, scope: draftScope });
    if (result.ok) { nameInput.value = ''; draw(); }
  };
  nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addToken(); } });

  openModal({ title: 'Abilities', subtitle: 'Once-per-turn abilities refresh when that trainer\'s turn begins', size: 'md', name: 'abilities', body, footer: h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Done') });
  draw();
}

// ---------------------------------------------------------------------------------------- attack

// Damage comes in tens, like the damage counters of the game: a number is brought to the nearest ten
const tens = (value) => Math.max(0, Math.min(9999, Math.round((parseInt(value, 10) || 0) / 10) * 10));

// What the card says an attack does: "60", "50+" (more with some conditions), "20×" (times something) or "—"
const damageText = (attack) => (attack.damage ? `${attack.damage}${attack.mod || ''}` : attack.mod || '—');
const MODIFIER_HINT = { '+': 'and more with some conditions', '×': 'times something', '-': 'less with some conditions' };

// Announce an attack or an ability. The Active Pokémon's attacks and the abilities of the Pokémon in play are listed from
// their cards: pick one (or press its number) and the name and the base damage are filled in, ready to be changed.
// The attacks of the benched Pokémon are in a list that is closed until it is wanted (an attack that is copied from the bench, for example).
export function openAttack(app) {
  const holder = app.state.trainerA.isTurn ? 'trainerA' : app.state.trainerB.isTurn ? 'trainerB' : app.focus;
  let attacker = holder;
  let chosen = null; // what was picked from a card: { kind: 'attack' | 'ability', slot, index, label, base, used }
  let items = []; // what the number keys pick, in the order they are listed
  let applyDamage = true;
  let markUsed = true;
  let benchOpen = false; // the list of the benched Pokémon's attacks stays as it was left while the dialog is drawn again

  const body = h('div', {});
  const name = h('input', { type: 'text', maxlength: 60, placeholder: 'Attack name (for example Thunderbolt)', 'aria-label': 'Attack name' });
  const damage = h('input', { type: 'number', min: 0, max: 9999, step: 10, value: '0', class: 'amount-input', 'aria-label': 'Damage' });
  const lessButton = h('button', { class: 'round-btn', type: 'button', 'aria-label': '10 less' }, icon('minus', 16));
  const moreButton = h('button', { class: 'round-btn', type: 'button', 'aria-label': '10 more' }, icon('plus', 16));
  const baseButton = h('button', { class: 'btn tiny', type: 'button', hidden: true });
  const applyBox = h('input', { type: 'checkbox', checked: true });
  const usedBox = h('input', { type: 'checkbox', checked: true });
  const announce = h('button', { class: 'btn danger', type: 'button' });

  const setDamage = (value) => {
    damage.value = String(tens(value));
    refresh();
  };
  // the stepper stops at 0, and "Base" brings back what the card says once the damage has been changed
  function refresh() {
    const now = tens(damage.value);
    lessButton.disabled = now <= 0;
    moreButton.disabled = now >= 9999;
    const base = chosen && chosen.kind === 'attack' ? tens(chosen.base) : null;
    baseButton.hidden = base === null || base === now || base === 0;
    baseButton.textContent = `Base ${base}`;
  }
  lessButton.addEventListener('click', () => setDamage(tens(damage.value) - 10));
  moreButton.addEventListener('click', () => setDamage(tens(damage.value) + 10));
  baseButton.addEventListener('click', () => setDamage(chosen.base));
  damage.addEventListener('input', refresh);
  damage.addEventListener('change', () => setDamage(damage.value));
  applyBox.addEventListener('change', () => { applyDamage = applyBox.checked; });
  usedBox.addEventListener('change', () => { markUsed = usedBox.checked; });

  const sameAsChosen = (entry) => chosen && chosen.kind === entry.kind && chosen.slot === entry.slot && chosen.index === entry.index;

  const choose = (entry) => {
    chosen = entry;
    if (entry.kind === 'attack') {
      name.value = entry.label;
      damage.value = String(tens(entry.base));
    } else {
      markUsed = !entry.used; // an ability that is already used is announced again without marking it twice
      usedBox.checked = markUsed;
    }
    draw();
    if (entry.kind === 'attack') { damage.focus(); damage.select(); } else announce.focus();
  };

  // (the attacks of the benched Pokémon have no number: they are picked with a click)
  const listed = (entry, content, { numbered = true } = {}) => {
    if (numbered) items.push(entry);
    return h('button', {
      class: `attack-pick${entry.kind === 'ability' ? ' ability' : ''}${numbered ? '' : ' bench-pick'}${sameAsChosen(entry) ? ' on' : ''}`, type: 'button',
      'aria-pressed': String(Boolean(sameAsChosen(entry))), dataset: { kind: entry.kind, index: String(entry.index), slot: String(entry.slot) },
      'data-autofocus': (numbered && items.length === 1) || undefined,
      onclick: () => choose(entry)
    }, numbered && h('kbd', {}, String(items.length)), content);
  };

  // The Pokémon that holds an attack: the Active one (slot -1) or one of the bench
  const holderOf = (state, entry) => (entry.slot === -1 ? state[attacker].active : state[attacker].bench[entry.slot]);

  const draw = () => {
    const state = app.state;
    const defender = otherSide(attacker);
    const active = state[attacker].active;
    const attacks = hasPokemon(active) ? active.attacks || [] : [];
    const owners = inPlay(state, attacker).filter(({ pokemon }) => (pokemon.abilities || []).length > 0);
    items = [];

    const attackList = attacks.map((attack, index) => listed(
      { kind: 'attack', slot: -1, index, label: attack.name, base: attack.damage },
      [h('span', { class: 'attack-name' }, attack.name),
        h('span', { class: 'attack-damage', title: attack.mod ? `${attack.damage} ${MODIFIER_HINT[attack.mod] || ''}`.trim() : undefined }, damageText(attack))]));

    const abilityList = owners.flatMap(({ slot, pokemon }) => pokemon.abilities.map((ability, index) => listed(
      { kind: 'ability', slot, index, label: ability.name, used: Boolean(ability.used), owner: pokemon.name },
      [h('span', { class: 'diamond' }), h('span', { class: 'attack-name' }, ability.name, h('small', {}, ` ${pokemon.name} · ${slotLabel(slot)}`)),
        ability.used ? h('span', { class: 'used-tag' }, 'USED') : h('span', { class: 'attack-damage' }, ability.scope === 'game' ? 'game' : 'turn')])));

    const usingAbility = chosen && chosen.kind === 'ability';
    // the benched Pokémon that have attacks on file, in a list of their own
    const benched = inPlay(state, attacker).filter(({ slot, pokemon }) => slot >= 0 && (pokemon.attacks || []).length > 0);
    const benchList = benched.length > 0 && h('details', {
      class: 'bench-attacks', open: benchOpen, ontoggle: (event) => { benchOpen = event.target.open; }
    },
    h('summary', {}, 'Attacks of the benched Pokémon', h('span', { class: 'hint' }, benched.length === 1 ? '1 Pokémon' : `${benched.length} Pokémon`)),
    benched.map(({ slot, pokemon }) => h('div', { class: 'bench-attack-group' },
      h('div', { class: 'bench-attack-owner' }, pokemon.name, h('small', {}, ` · ${slotLabel(slot)}`)),
      h('div', { class: 'attack-list' }, pokemon.attacks.map((attack, index) => listed(
        { kind: 'attack', slot, index, label: attack.name, base: attack.damage, owner: pokemon.name },
        [h('span', { class: 'attack-name' }, attack.name),
          h('span', { class: 'attack-damage', title: attack.mod ? `${attack.damage} ${MODIFIER_HINT[attack.mod] || ''}`.trim() : undefined }, damageText(attack))],
        { numbered: false }))))));

    const chosenAttack = chosen && chosen.kind === 'attack' ? (holderOf(state, chosen) || {}).attacks?.[chosen.index] : null;
    const card = chosenAttack && chosenAttack.mod ? chosenAttack : null;
    const fields = usingAbility
      ? [
        h('p', { class: 'ability-line' }, h('span', { class: 'diamond' }), h('strong', {}, chosen.label), h('small', {}, ` ${chosen.owner}`)),
        h('label', { class: 'switch inline' }, usedBox, h('span', { class: 'track' }), h('span', { class: 'switch-label' }, `Mark ${chosen.label} as used`))
      ]
      : [
        chosen && chosen.slot >= 0 && h('p', { class: 'hint-line from-bench' }, `The attack of ${chosen.owner} (${slotLabel(chosen.slot)}), on the bench.`),
        h('label', { class: 'field' }, h('span', {}, 'Attack'), name),
        h('div', { class: 'field' }, h('span', {}, 'Damage', h('small', { class: 'tens-note' }, ' · in tens')),
          h('div', { class: 'amount-row' }, lessButton, damage, moreButton, baseButton)),
        card && h('p', { class: 'hint-line' }, `The card says ${damageText(card)}: ${MODIFIER_HINT[card.mod]}. Change the damage to what it really did.`),
        h('label', { class: 'switch inline' }, applyBox, h('span', { class: 'track' }), h('span', { class: 'switch-label' }, `Also apply the damage to ${trainerName(state, defender)}'s Active Pokémon`))
      ];

    replace(body,
      sideTabs(app, attacker, (next) => { attacker = next; chosen = null; name.value = ''; damage.value = '0'; draw(); subtitle(); }),
      h('div', { class: 'section-label' }, hasPokemon(active) ? `Attacks · ${active.name}` : 'Attacks', h('span', { class: 'hint' }, 'Pick one, or press its number')),
      attackList.length > 0
        ? h('div', { class: 'attack-list' }, attackList)
        : h('p', { class: 'empty' }, hasPokemon(active) ? 'This card has no attacks on file. Type the attack below.' : `${trainerName(state, attacker)} has no Active Pokémon. Type the attack below.`),
      benchList,
      abilityList.length > 0 && h('div', { class: 'section-label' }, 'Abilities', h('span', { class: 'hint' }, 'Announced like an attack')),
      abilityList.length > 0 && h('div', { class: 'attack-list' }, abilityList),
      h('div', { class: 'section-label' }, 'Announce'),
      fields);
    announce.textContent = usingAbility ? 'Announce ability' : 'Announce attack';
    refresh();
  };

  const go = async () => {
    const defender = otherSide(attacker);
    if (chosen && chosen.kind === 'ability') {
      const said = await app.act('action:toast', { action: 'attack', attackName: chosen.label, ability: true, source: attacker });
      if (!said.ok) return;
      if (markUsed && !chosen.used) await app.act(`action:${attacker}`, { action: 'setAbilityUsed', slot: chosen.slot, index: chosen.index, used: true });
      closeModal();
      return;
    }
    const amount = tens(damage.value);
    const said = await app.act('action:toast', { action: 'attack', attackName: name.value.trim() || undefined, damage: amount, source: attacker });
    if (!said.ok) return;
    if (applyDamage && amount > 0 && hasPokemon(app.state[defender].active)) {
      await app.act(`action:${defender}`, { action: 'activeDamage', amount });
    }
    closeModal();
  };
  announce.addEventListener('click', go);

  const whoAttacks = () => `${trainerName(app.state, attacker)} attacks ${trainerName(app.state, otherSide(attacker))}`;
  const modal = openModal({
    title: 'Attack', subtitle: whoAttacks(), size: 'md', name: 'attack', body,
    footer: [h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'), announce]
  });
  const subtitle = () => { modal.root.querySelector('.modal-sub').textContent = whoAttacks(); };
  draw();
  // the first attack has the focus (the number keys pick), or the name box when the card lists none
  const first = body.querySelector('[data-autofocus]');
  (first || name).focus();

  modal.root.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) && event.target.type !== 'checkbox';
    if (!typing && /^[1-9]$/.test(event.key) && items[Number(event.key) - 1]) {
      event.preventDefault();
      choose(items[Number(event.key) - 1]);
      return;
    }
    if (event.key === 'Enter' && event.target.tagName !== 'BUTTON' && event.target.tagName !== 'SUMMARY') { event.preventDefault(); go(); }
  });
}

// ------------------------------------------------------------------------------------------ help

export function openHelp(app) {
  const groups = app.keymap.reduce((all, entry) => {
    (all[entry.group] ||= []).push(entry);
    return all;
  }, {});
  openModal({
    title: 'Keyboard shortcuts', subtitle: 'Shortcuts are ignored while you are typing in a box', size: 'lg', name: 'help',
    body: h('div', { class: 'help-grid' }, Object.entries(groups).map(([group, entries]) => h('section', { class: 'help-group' },
      h('h3', {}, group),
      h('dl', {}, entries.map((entry) => [h('dt', {}, entry.keys.map((key) => h('kbd', {}, key))), h('dd', {}, entry.label)]))))),
    footer: h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Close')
  });
}

// --------------------------------------------------------------------------------------- preview

export function openPreview(app) {
  const frame = h('iframe', { src: '/overlay?preview=1', title: 'Overlay preview', class: 'preview-frame', tabindex: '-1' });
  const stage = h('div', { class: 'preview-stage' }, frame);
  const fit = () => {
    const width = stage.clientWidth;
    frame.style.transform = `scale(${width / 1920})`;
    stage.style.height = `${(width / 1920) * 1080}px`;
  };
  openModal({
    title: 'Overlay preview', subtitle: 'What the audience sees. Shown on a dark table; the real overlay is transparent.', size: 'xl', name: 'preview',
    body: stage, footer: h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Close'),
    onClose: () => window.removeEventListener('resize', fit)
  });
  fit();
  window.addEventListener('resize', fit);
}

// ------------------------------------------------------------------------------ draft conflicts

export function openDraftConflicts(app, { conflicts }) {
  openModal({
    title: 'Some changes clash with the live game',
    subtitle: 'Another producer changed the same things since you began your draft.',
    size: 'md', name: 'draft-conflicts',
    body: h('ul', { class: 'conflict-list' }, conflicts.map((entry) => h('li', {},
      h('strong', {}, entry.label),
      h('span', {}, entry.conflict.by ? ` — ${entry.conflict.by} changed this` : ` — ${entry.conflict.label}`)))),
    footer: [
      h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Keep editing'),
      h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); app.sendDraft('skip'); } }, 'Send the rest'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => { closeModal(); app.sendDraft('force'); } }, 'Send everything anyway')
    ]
  });
}
