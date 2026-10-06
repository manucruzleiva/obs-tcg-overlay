/**
 * One trainer's column in the control panel. The structure is built once and updated in place, so a
 * text box you are typing in is never rebuilt under you when another producer makes a change.
 */
import { h, icon, replace, energyStyle } from './dom.js';

const GAME = window.OTO_GAME;
const COUNTRIES = window.OTO_COUNTRIES;
const DECK = window.OTO_DECK;
const ENERGY = Object.fromEntries(GAME.ENERGY_TYPES.map((type) => [type.key, type]));

const SIDE_LABEL = { trainerA: 'Trainer A', trainerB: 'Trainer B' };
const USUAL_BENCH = 5; // slots; a Stadium such as Area Zero Underdepths makes it bigger for a while
const SLOT_TYPE = 'application/x-oto-slot'; // what a Pokémon being dragged carries, so nothing else dragged over a slot is mistaken for it

const hasPokemon = (pokemon) => Boolean(pokemon && (pokemon.cardId || pokemon.name));

export class TrainerView {
  constructor(side, app) {
    this.side = side;
    this.app = app;
    this.editingHp = null; // slot whose HP is being edited
    this.root = this.build();
  }

  // ----------------------------------------------------------------- structure

  build() {
    const { side, app } = this;
    const act = (action, params) => app.act(`action:${side}`, { action, ...params });
    const letter = side === 'trainerA' ? 'A' : 'B';

    // header
    this.turnButton = h('button', { class: 'turn-btn', type: 'button', onclick: () => act('setTurn', { isTurn: !this.turn }), 'aria-pressed': 'false' },
      h('span', { class: 'dot' }), 'Has the turn');
    this.focusTag = h('button', { class: 'focus-tag', type: 'button', title: `Shortcuts like E, K and D apply to this trainer (press ${side === 'trainerA' ? '1' : '2'})`, onclick: () => app.setFocus(side) },
      `Shortcuts here (${side === 'trainerA' ? '1' : '2'})`);
    const head = h('header', { class: 'tp-head' }, h('span', { class: 'side-badge' }, `TRAINER ${letter}`), this.turnButton, this.focusTag);

    // identity
    const commit = (input, action, key) => () => {
      if (input.value !== input.dataset.shown) act(action, { [key]: input.value });
    };
    this.nameInput = h('input', { type: 'text', maxlength: 60, placeholder: SIDE_LABEL[side], 'aria-label': `${SIDE_LABEL[side]} name` });
    this.natInput = h('input', { type: 'text', maxlength: 40, list: 'nationalities', placeholder: 'USA', 'aria-label': `${SIDE_LABEL[side]} nationality` });
    for (const [input, action, key] of [[this.nameInput, 'setName', 'name'], [this.natInput, 'setNationality', 'nationality']]) {
      input.addEventListener('change', commit(input, action, key));
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    }
    // the flag of what is typed as the nationality, so it is plain whether the country is known (the overlay can show it instead of the text)
    this.natFlag = h('span', { class: 'nat-flag', 'aria-hidden': 'true', hidden: true });
    this.natInput.addEventListener('input', () => this.showFlag());
    const recordInput = (label, key) => {
      const input = h('input', { type: 'number', min: 0, max: 999, 'aria-label': `${SIDE_LABEL[side]} ${label}` });
      input.addEventListener('change', () => {
        const record = this.currentRecord();
        record[key] = Math.max(0, Math.min(999, parseInt(input.value, 10) || 0));
        act('setRecord', record);
      });
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
      return input;
    };
    this.record = { wins: recordInput('wins', 'wins'), losses: recordInput('losses', 'losses'), ties: recordInput('ties', 'ties') };

    // the deck ("Charizard ex", "Lightning GLC") shown next to the name on the overlay, with a picture in front of it: an energy icon or a Pokémon
    // that the deck names, unless something else is written in the picture box ("none" for no picture)
    this.deckInput = h('input', { type: 'text', maxlength: DECK.MAX_LENGTH, list: 'deck-names', placeholder: 'Charizard ex', 'aria-label': `${SIDE_LABEL[side]} deck` });
    this.pictureInput = h('input', { type: 'text', maxlength: DECK.MAX_LENGTH, list: 'deck-pictures', placeholder: 'Automatic', 'aria-label': `${SIDE_LABEL[side]} deck picture` });
    for (const [input, action, key] of [[this.deckInput, 'setDeck', 'deck'], [this.pictureInput, 'setDeckIcon', 'icon']]) {
      input.addEventListener('change', commit(input, action, key));
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
      input.addEventListener('input', () => this.showDeckPicture());
    }
    // what the overlay will put in front of the deck, inside the picture box, and a line that says so
    this.deckPreview = h('img', { class: 'deck-preview', alt: '', hidden: true });
    this.deckPreview.addEventListener('error', () => { this.deckPreview.hidden = true; }); // a Pokémon that cannot be fetched (no internet)
    this.deckHint = h('p', { class: 'deck-hint', 'aria-live': 'polite' });
    const identity = h('section', { class: 'block identity' },
      h('label', {}, h('span', {}, 'Name'), this.nameInput),
      h('label', {}, h('span', {}, 'Nationality'), h('div', { class: 'nat-field' }, this.natInput, this.natFlag)),
      h('label', {}, h('span', {}, 'Deck or GLC type'), this.deckInput),
      h('label', {}, h('span', {}, 'Picture'), h('div', { class: 'nat-field' }, this.pictureInput, this.deckPreview)),
      this.deckHint,
      h('div', { class: 'record' }, h('span', {}, 'Record'),
        h('label', {}, 'W', this.record.wins), h('label', {}, 'L', this.record.losses), h('label', {}, 'T', this.record.ties)));

    // prizes
    this.prizeCount = h('span', { class: 'prize-number', 'aria-live': 'polite' }, '6');
    this.penaltyCount = h('output', { class: 'penalty-number', 'aria-label': 'Prize cards in red' }, '0');
    // (a prize card that has a card chosen for it shows that card)
    this.prizePips = Array.from({ length: 6 }, (_, index) => {
      const face = h('img', { class: 'pip-face', alt: '', hidden: true });
      const pip = h('button', { class: 'pip', type: 'button', 'aria-label': `Set prizes to ${index + 1}`, onclick: () => act('prizeSet', { count: index + 1 }) }, face);
      pip.face = face;
      return pip;
    });
    // the arrows are for the player whose turn it is, and Shift + the arrows for the other one: which keys are this trainer's follows the turn
    this.prizeHint = h('span', { class: 'hint', title: 'The arrows are for the player whose turn it is, and Shift + the arrows for the other one' }, side === 'trainerA' ? '↑ ↓' : 'Shift + ↑ ↓');
    const prizes = h('section', { class: 'block prizes' },
      h('div', { class: 'block-title' }, 'Prize cards', this.prizeHint),
      h('div', { class: 'prize-row' },
        h('button', { class: 'round-btn', type: 'button', 'aria-label': 'One prize card taken', onclick: () => act('prizeMinus') }, icon('minus')),
        this.prizeCount,
        h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Give back a prize card', onclick: () => act('prizePlus') }, icon('plus')),
        h('div', { class: 'pips' }, this.prizePips)),
      h('div', { class: 'toggle-row' },
        this.toggle('Hide prizes', (on) => act('togglePrizeHidden', { enabled: on }), (t) => { this.hiddenToggle = t; }),
        h('button', { class: 'btn tiny set-prizes', type: 'button', title: 'Choose the cards that are the prizes: they show on the prize cards of the overlay', onclick: () => app.openPrizes(side) }, 'Set prizes')),
      // a penalty of this player is a number of prize cards the OTHER player counts as taken: that many of theirs are red on the overlay,
      // and they need that many fewer to win
      h('div', { class: 'penalty-row', title: 'The penalty of this player: the other player has that many prize cards in red, and needs that many fewer to win' },
        h('span', { class: 'penalty-label' }, 'Penalty', h('small', {}, 'in red for the other player')),
        h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Penalty: one less', onclick: () => act('prizePenaltyMinus') }, icon('minus')),
        this.penaltyCount,
        h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Penalty: one more', onclick: () => act('prizePenaltyPlus') }, icon('plus'))));

    // once-per-turn tokens (and the once-per-game ones) and locks
    const token = (label, kind) => h('button', { class: 'token-btn', type: 'button', onclick: () => this.stepToken(kind) },
      h('span', { class: 'dot' }), label, h('span', { class: 'count' }));
    this.tokens = {
      energy: token('Energy', 'energy'),
      stadium: token('Stadium', 'stadium'),
      supporter: token('Supporter', 'supporter'),
      gx: token('GX attack', 'gx'),
      vstar: token('VSTAR Power', 'vstar')
    };
    const turnBlock = h('section', { class: 'block turn-block' },
      h('div', { class: 'block-title' }, 'This turn', h('span', { class: 'hint' }, 'Shift+S supporter')),
      h('div', { class: 'token-row' }, this.tokens.energy, this.tokens.stadium, this.tokens.supporter),
      // once per game: they come back by themselves when the game ends
      h('div', { class: 'block-title sub' }, 'This game', h('span', { class: 'hint' }, 'back when the game ends')),
      h('div', { class: 'token-row' }, this.tokens.gx, this.tokens.vstar),
      h('div', { class: 'toggle-row' },
        this.toggle('Item lock (I)', (on) => act('toggleItemLock', { enabled: on }), (t) => { this.itemToggle = t; }),
        this.toggle('Evolution lock (V)', (on) => act('toggleEvoLock', { enabled: on }), (t) => { this.evoToggle = t; })));

    // Pokémon
    this.activeBox = h('div', { class: 'mon-slot active-slot' });
    this.benchGrid = h('div', { class: 'bench-grid' });
    this.benchSize = h('span', { class: 'bench-size' });
    this.benchReset = h('button', { class: 'btn tiny', type: 'button', title: `Back to the usual ${USUAL_BENCH} slots`, onclick: () => act('benchSizeReset') }, `Reset to ${USUAL_BENCH} (Shift+B)`);
    const pokemon = h('section', { class: 'block pokemon' },
      h('div', { class: 'block-title' }, 'Active Pokémon', h('span', { class: 'hint' }, 'A deploy · D damage · H heal · E energy · K KO · drag to move')),
      this.activeBox,
      h('div', { class: 'block-title bench-title' }, 'Bench',
        h('span', { class: 'bench-controls' },
          h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Smaller bench', onclick: () => act('benchSizeMinus') }, icon('minus', 14)),
          this.benchSize,
          h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Bigger bench', onclick: () => act('benchSizePlus') }, icon('plus', 14)),
          this.benchReset,
          h('button', { class: 'btn tiny', type: 'button', onclick: () => app.openBench(side) }, 'Edit bench (B)'))),
      this.benchGrid);
    this.enableDragAndDrop(pokemon);

    return h('section', { class: `trainer-panel ${side === 'trainerA' ? 'side-a' : 'side-b'}`, dataset: { side } },
      head, identity, prizes, turnBlock, pokemon);
  }

  // A labelled on/off switch; `bind` receives it so update() can set it
  toggle(label, onChange, bind) {
    const input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => onChange(input.checked));
    const node = h('label', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', { class: 'switch-label' }, label));
    node.input = input;
    bind(node);
    return node;
  }

  // ------------------------------------------------------------------- reading

  get turn() {
    const state = this.app.conn.state;
    return state ? state[this.side].isTurn : false;
  }

  currentRecord() {
    const state = this.app.conn.state;
    const record = state ? state[this.side].record : { wins: 0, losses: 0, ties: 0 };
    return { wins: record.wins, losses: record.losses, ties: record.ties };
  }

  // Energy, stadium and supporter use: click to mark used, click again to undo
  stepToken(kind) {
    const state = this.app.conn.state;
    if (!state) return;
    const resource = { energy: 'energyPerTurn', stadium: 'stadiumPerTurn', supporter: 'supporterPerTurn', gx: 'gxPerGame', vstar: 'vstarPerGame' }[kind];
    const counter = state[this.side].resources[resource];
    this.app.act(`action:${this.side}`, { action: `${kind}${counter.used >= counter.available ? 'Minus' : 'Plus'}` });
  }

  // ------------------------------------------------------------------- updating

  // The flag of the country typed in the nationality box (nothing when it is not a country that is known)
  showFlag() {
    const typed = this.natInput.value;
    const flag = COUNTRIES.flagOf(typed);
    this.natFlag.textContent = flag;
    this.natFlag.title = flag ? COUNTRIES.nameOf(typed) : '';
    this.natFlag.hidden = !flag;
    this.natInput.classList.toggle('has-flag', Boolean(flag));
  }

  // What the overlay will show in front of the deck, from what is typed (the preview in the picture box, and a line about it)
  showDeckPicture() {
    const asked = this.pictureInput.value.trim();
    const picture = DECK.pictureFor(this.deckInput.value, asked);
    // only asked for again when it changes: a Pokémon's picture is fetched the first time it is needed
    if (picture) {
      if (this.deckPreview.getAttribute('src') !== picture.src) { this.deckPreview.hidden = false; this.deckPreview.setAttribute('src', picture.src); }
      this.deckPreview.title = picture.name;
    } else {
      this.deckPreview.hidden = true;
      this.deckPreview.removeAttribute('src');
      this.deckPreview.removeAttribute('title');
    }
    this.pictureInput.classList.toggle('has-flag', Boolean(picture));
    const none = asked.toLowerCase() === DECK.NO_PICTURE;
    let hint = '';
    if (none) hint = 'No picture next to the deck.';
    else if (asked && !picture) hint = `"${asked}" is not a Pokémon or an energy type: no picture.`;
    else if (picture) hint = `Picture: ${picture.name}${asked ? '' : ' (named by the deck)'}.`;
    else if (this.deckInput.value.trim()) hint = 'No picture: write a Pokémon or an energy type in the Picture box to add one.';
    this.deckHint.textContent = hint;
    this.deckHint.classList.toggle('warn', Boolean(asked) && !none && !picture);
  }

  update(state) {
    const trainer = state[this.side];
    const { app } = this;
    const draft = app.conn.draft.active;

    this.root.classList.toggle('is-turn', trainer.isTurn);
    this.root.classList.toggle('is-focus', app.focus === this.side);
    this.root.classList.toggle('is-draft', draft);
    this.turnButton.classList.toggle('on', trainer.isTurn);
    this.turnButton.setAttribute('aria-pressed', String(trainer.isTurn));
    this.focusTag.hidden = app.focus === this.side;

    // text boxes: never overwrite what someone is typing
    const setValue = (input, value) => {
      input.dataset.shown = value;
      if (document.activeElement !== input) input.value = value;
    };
    setValue(this.nameInput, trainer.name);
    setValue(this.natInput, trainer.nationality);
    this.showFlag();
    setValue(this.deckInput, trainer.deck || '');
    setValue(this.pictureInput, trainer.deckIcon || '');
    this.showDeckPicture();
    this.prizeHint.textContent = app.prizeSide(false) === this.side ? '↑ ↓' : 'Shift + ↑ ↓';
    for (const key of ['wins', 'losses', 'ties']) setValue(this.record[key], String(trainer.record[key]));

    // prizes
    this.prizeCount.textContent = trainer.prizes.count;
    // the other trainer's penalty is prize cards this one counts as taken: those pips are red, as the overlay shows them
    const opponent = state[this.side === 'trainerA' ? 'trainerB' : 'trainerA'];
    const penalty = Math.min(Number(opponent.prizes.penalty) || 0, trainer.prizes.count);
    const faces = trainer.prizes.cards || [];
    this.prizePips.forEach((pip, index) => {
      const card = faces[index];
      pip.classList.toggle('on', index < trainer.prizes.count);
      pip.classList.toggle('penalty', index < penalty);
      pip.classList.toggle('has-card', Boolean(card && card.image));
      if (card && card.image) {
        if (pip.face.getAttribute('src') !== card.image) pip.face.src = card.image;
        pip.title = card.name;
      } else {
        pip.face.removeAttribute('src');
        pip.removeAttribute('title');
      }
      pip.face.hidden = !(card && card.image);
    });
    this.hiddenToggle.input.checked = Boolean(trainer.prizes.hidden);
    this.penaltyCount.textContent = String(Number(trainer.prizes.penalty) || 0);
    this.penaltyCount.classList.toggle('on', Number(trainer.prizes.penalty) > 0);
    this.itemToggle.input.checked = Boolean(trainer.locks.itemLock);
    this.evoToggle.input.checked = Boolean(trainer.locks.evoLock);

    // tokens
    for (const [kind, resource] of [['energy', 'energyPerTurn'], ['stadium', 'stadiumPerTurn'], ['supporter', 'supporterPerTurn'], ['gx', 'gxPerGame'], ['vstar', 'vstarPerGame']]) {
      const counter = trainer.resources[resource];
      if (!counter) continue;
      const used = counter.used >= counter.available;
      this.tokens[kind].classList.toggle('used', used);
      this.tokens[kind].querySelector('.count').textContent = counter.available > 1 ? `${counter.used}/${counter.available}` : used ? 'used' : 'ready';
    }

    // Pokémon. The part holding an HP box being typed in is left alone, so a change by someone else
    // cannot wipe what you are typing.
    const editing = this.editingHp; // null, -1 (the active Pokémon) or a bench slot
    this.benchSize.textContent = `${trainer.benchSize} slots`;
    this.benchReset.disabled = trainer.benchSize === USUAL_BENCH;
    if (editing !== -1) this.renderActive(trainer);
    if (editing === null || editing === -1) this.renderBench(trainer);
  }

  renderActive(trainer = this.app.conn.state[this.side]) {
    replace(this.activeBox, this.pokemonCard(trainer.active, -1));
  }

  renderBench(trainer = this.app.conn.state[this.side]) {
    replace(this.benchGrid, trainer.bench.slice(0, trainer.benchSize).map((pokemon, index) => this.pokemonCard(pokemon, index)));
  }

  // Open the HP box of one Pokémon (slot -1 is the active one). Only that part is redrawn.
  editHp(slot) {
    this.editingHp = slot;
    if (slot === -1) this.renderActive(); else this.renderBench();
    // Focused straight away, not on a timer: anything typed right after the click goes in the box
    const box = this.root.querySelector('.hp-editor input');
    if (box) { box.focus(); box.select(); }
  }

  // ------------------------------------------------------------------- drag and drop

  // A Pokémon can be dragged to another slot of the same trainer (the Active spot or the bench): into an empty slot, or onto another Pokémon
  // to change places with it. The cards are drawn again with every change, so this listens on the whole section and finds the slot under
  // the pointer. What is dragged says what it is (SLOT_TYPE), so a file dragged over the slots is left to the page.
  enableDragAndDrop(section) {
    const slotAt = (node) => {
      const found = node && node.closest ? node.closest('[data-slot]') : null;
      return found && section.contains(found) ? found : null;
    };
    const ours = (event) => Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes(SLOT_TYPE);
    const clear = () => {
      for (const node of section.querySelectorAll('.drop-target, .dragging')) node.classList.remove('drop-target', 'dragging');
    };

    section.addEventListener('dragstart', (event) => {
      const card = event.target instanceof Element ? event.target.closest('.mon-card[data-slot]') : null;
      if (!card || !section.contains(card)) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(SLOT_TYPE, JSON.stringify({ side: this.side, slot: Number(card.dataset.slot) }));
      TrainerView.dragged = { side: this.side, slot: Number(card.dataset.slot) };
      card.classList.add('dragging');
    });
    section.addEventListener('dragend', () => { TrainerView.dragged = null; clear(); });
    section.addEventListener('dragover', (event) => {
      const target = slotAt(event.target);
      const from = TrainerView.dragged;
      if (!ours(event) || !target || !from || from.side !== this.side) return;
      for (const node of section.querySelectorAll('.drop-target')) if (node !== target) node.classList.remove('drop-target');
      if (Number(target.dataset.slot) === from.slot) return; // dropping a Pokémon where it is does nothing
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      target.classList.add('drop-target');
    });
    section.addEventListener('dragleave', (event) => {
      if (!event.relatedTarget || !section.contains(event.relatedTarget)) for (const node of section.querySelectorAll('.drop-target')) node.classList.remove('drop-target');
    });
    section.addEventListener('drop', (event) => {
      const target = slotAt(event.target);
      let from = null;
      try { from = JSON.parse(event.dataTransfer.getData(SLOT_TYPE)); } catch (error) { /* not ours */ }
      TrainerView.dragged = null;
      clear();
      if (!target || !from || from.side !== this.side) return;
      event.preventDefault();
      const to = Number(target.dataset.slot);
      if (to === from.slot) return;
      this.app.act(`action:${this.side}`, { action: 'moveSlot', from: from.slot, to });
    });
  }

  // ------------------------------------------------------------------- Pokémon

  pokemonCard(pokemon, slot) {
    const { side, app } = this;
    const compact = slot !== -1;

    if (!hasPokemon(pokemon)) {
      return h('button', {
        class: `empty-slot${compact ? ' compact' : ''}`, type: 'button', dataset: { slot: String(slot) },
        onclick: () => (compact ? app.openPicker({ kind: 'bench', side, slot }) : app.openPicker({ kind: 'active', side }))
      }, icon('plus', 20), compact ? `Bench ${slot + 1}` : 'Deploy Active (A)');
    }

    const act = (action, params) => app.act(`action:${side}`, { action, slot, ...params });
    const hp = pokemon.hp || { max: 0, current: 0 };
    const percent = hp.max ? Math.max(0, Math.min(100, (hp.current / hp.max) * 100)) : 0;

    // (the pictures are not draggable themselves: the whole card is what moves). Art only is the usual look here; the whole card is a choice
    // of this browser (Settings, General).
    const art = h('div', { class: `mon-art${app.cardView === 'art' ? ' cropped' : ''}` }, pokemon.image
      ? h('img', { src: pokemon.image, alt: '', loading: 'lazy', draggable: 'false' })
      : h('span', { class: 'art-fallback' }, icon('star', 28)));

    const hpValue = this.editingHp === slot
      ? this.hpEditor(pokemon, slot)
      : h('button', { class: 'hp-value', type: 'button', title: 'Click to set HP', onclick: () => this.editHp(slot) },
        hp.max ? `${hp.current}/${hp.max} HP` : 'Set HP');

    // A right click adds another of the same energy. It is the turn's attachment if that is still free, and a special attachment (an
    // ability or an effect) if it was used already, so it never fails and never uses it up twice.
    const turn = app.state && app.state[side].resources.energyPerTurn;
    const countsAsTurn = !turn || turn.used < turn.available;
    const energies = (pokemon.energies || []).map((type, index) => h('button', {
      class: 'energy-chip', type: 'button', title: `${(ENERGY[type] || ENERGY.colorless).label} energy (click to remove, right-click to add another)`,
      style: energyStyle(ENERGY[type] || ENERGY.colorless), dataset: { energy: type },
      'aria-label': `Remove ${type} energy`, onclick: () => act('removeEnergy', { index }),
      oncontextmenu: (event) => { event.preventDefault(); act('attachEnergy', { energyType: type, count: 1, countsAsTurn }); }
    }));

    // Special Energy cards: a circle cut out of each card
    const specials = (pokemon.specialEnergies || []).map((card, index) => h('button', {
      class: 'energy-chip special', type: 'button', title: `${card.name} (click to remove, right-click to add another)`,
      'aria-label': `Remove ${card.name}`, onclick: () => act('removeSpecialEnergy', { index }),
      oncontextmenu: (event) => { event.preventDefault(); act('attachSpecialEnergy', { cardId: card.cardId, name: card.name, image: card.image, countsAsTurn }); }
    }, card.image && h('img', { src: card.image, alt: '', loading: 'lazy', draggable: 'false' })));

    // How many Energy it costs to retreat (the card says, and an effect can change it)
    const cost = Number.isInteger(pokemon.retreat) ? pokemon.retreat : 0;
    const retreat = h('div', { class: 'retreat-line' },
      h('span', { class: 'retreat-label' }, 'Retreat'),
      h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Retreat cost one less', disabled: cost <= 0 || undefined, onclick: () => act('setRetreat', { cost: cost - 1 }) }, icon('minus', 12)),
      h('output', { class: 'retreat-number', 'aria-label': 'Retreat cost' }, String(cost)),
      h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Retreat cost one more', disabled: cost >= 6 || undefined, onclick: () => act('setRetreat', { cost: cost + 1 }) }, icon('plus', 12)));

    const abilities = (pokemon.abilities || []).map((ability, index) => h('button', {
      class: `ability-chip${ability.used ? ' used' : ''}`, type: 'button',
      title: `${ability.name}${ability.scope === 'game' ? ' (once per game)' : ' (once per turn)'}: click to mark ${ability.used ? 'ready' : 'used'}`,
      'aria-pressed': String(Boolean(ability.used)), onclick: () => act('setAbilityUsed', { index, used: !ability.used })
    }, h('span', { class: 'diamond' }), ability.name, ability.used && h('span', { class: 'used-tag' }, 'USED')));

    // Special conditions: only the Active Pokémon has them. The chip says what it will be after the click, so two
    // producers pressing the same one agree.
    const conditions = compact ? null : h('div', { class: 'chips conditions', role: 'group', 'aria-label': 'Special conditions' },
      GAME.STATUS_CONDITIONS.map((condition) => {
        const on = (pokemon.status || []).includes(condition.key);
        return h('button', {
          class: `condition-chip${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), dataset: { condition: condition.key },
          style: { '--c': condition.color, '--ink': condition.ink },
          title: `${condition.label}${condition.hint ? ` (${condition.hint.toLowerCase()})` : ''}: click to ${on ? 'remove it' : 'put it on'}`,
          onclick: () => act('toggleStatus', { condition: condition.key, enabled: !on })
        }, h('span', { class: 'condition-icon', style: { '--icon': `url(${condition.icon})` } }), condition.label);
      }));

    const buttons = compact
      ? [
        this.mini('Switch in', 'swap', () => act('swapWithActive')),
        this.mini('Energy', 'bolt', () => app.openEnergy(side, slot)),
        this.mini('Damage', 'drop', () => app.openDamage('damage', side, slot)),
        this.mini('Knock out', 'skull', () => app.openKO(side, slot)),
        this.mini('Remove', 'trash', () => act('clearSlot'))
      ]
      : [
        this.mini('Deploy another (A)', 'swap', () => app.openPicker({ kind: 'active', side })),
        this.mini('Energy (E)', 'bolt', () => app.openEnergy(side, -1)),
        this.mini('Damage (D)', 'drop', () => app.openDamage('damage', side, -1)),
        this.mini('Heal (H)', 'plus', () => app.openDamage('heal', side, -1)),
        this.mini('Abilities (X)', 'star', () => app.openAbilities(side)),
        this.mini('Knock out (K)', 'skull', () => app.openKO(side, -1)),
        this.mini('Remove', 'trash', () => act('clearSlot'))
      ];

    // (a card whose HP is being typed is not draggable: the box could not be used with the mouse)
    return h('div', { class: `mon-card${compact ? ' compact' : ''}`, dataset: { slot: String(slot) }, draggable: this.editingHp === slot ? undefined : 'true' },
      art,
      h('div', { class: 'mon-info' },
        h('div', { class: 'mon-name' }, pokemon.name),
        h('div', { class: 'hp-line' }, hpValue, h('div', { class: `hp-bar${percent <= 25 ? ' low' : percent <= 50 ? ' warn' : ''}` }, h('div', { style: { width: `${percent}%` } }))),
        (energies.length > 0 || specials.length > 0) && h('div', { class: 'chips energies' }, [...energies, ...specials]),
        retreat,
        abilities.length > 0 && h('div', { class: 'chips abilities' }, abilities),
        conditions,
        h('div', { class: 'mon-actions' }, buttons)));
  }

  mini(label, iconName, onclick) {
    return h('button', { class: 'mini-btn', type: 'button', title: label, 'aria-label': label, onclick }, icon(iconName, 14), h('span', {}, label));
  }

  // Inline editor for current and maximum HP
  hpEditor(pokemon, slot) {
    const { side, app } = this;
    const hp = pokemon.hp || { max: 0, current: 0 };
    const current = h('input', { type: 'number', min: 0, max: 9999, value: hp.current, 'aria-label': 'Current HP', 'data-autofocus': true });
    const max = h('input', { type: 'number', min: 0, max: 9999, value: hp.max, 'aria-label': 'Maximum HP' });

    const done = async (save) => {
      if (this.editingHp !== slot) return;
      this.editingHp = null;
      if (save) {
        const newMax = parseInt(max.value, 10);
        const newCurrent = parseInt(current.value, 10);
        if (Number.isInteger(newMax) && newMax !== hp.max) await app.act(`action:${side}`, { action: 'setMaxHP', slot, max: newMax });
        if (Number.isInteger(newCurrent)) await app.act(`action:${side}`, { action: 'setHP', slot, current: newCurrent });
      }
      this.update(app.conn.state);
    };

    const onKey = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); done(true); }
      if (event.key === 'Escape') { event.stopPropagation(); done(false); }
    };
    current.addEventListener('keydown', onKey);
    max.addEventListener('keydown', onKey);

    const editor = h('span', { class: 'hp-editor' }, current, '/', max,
      // mousedown is held back so the button never steals focus (Safari and macOS Firefox do not
      // focus buttons, which would look like "clicked away" and cancel the edit)
      h('button', { class: 'round-btn small', type: 'button', 'aria-label': 'Save HP', onmousedown: (event) => event.preventDefault(), onclick: () => done(true) }, icon('check', 14)));
    // Clicking away abandons the edit. An open box is never refreshed, so a forgotten one would
    // keep showing an HP that another producer has since changed.
    editor.addEventListener('focusout', (event) => {
      if (!editor.contains(event.relatedTarget)) done(false);
    });
    return editor;
  }
}
