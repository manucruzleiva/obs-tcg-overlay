/**
 * Every action a control panel can send, in one place.
 *
 * For each action the registry says how to validate and apply it, which part of the
 * game it touches (`targets`, used to detect two producers changing the same thing),
 * and how to describe it to humans (`label`, used by the activity feed).
 *
 * Applying an action only changes the GameStateService it is given, so the same code
 * serves the live game and the private copy behind a producer's draft.
 */

const announcements = require('./services/announcements');
const { attacksOf, retreatOf } = require('./services/attacks');
const GAME = require('../public/js/game-data');
const DECK = require('../public/js/deck');

const SIDE_LABEL = { trainerA: 'Trainer A', trainerB: 'Trainer B' };

// Raised for input that a well-behaved control panel would never send
class ActionError extends Error {}

// ------------------------------------------------------------------ validation

function text(value, name, max = 80) {
  if (typeof value !== 'string') throw new ActionError(`${name} must be text`);
  return value.trim().slice(0, max);
}

function integer(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ActionError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

function bool(value, name) {
  if (typeof value !== 'boolean') throw new ActionError(`${name} must be true or false`);
  return value;
}

// Card images must be web addresses (or same-site paths); empty means "no image"
function imageUrl(value, name) {
  if (value === undefined || value === null || value === '') return '';
  const url = text(value, name, 2048);
  if (url && !/^(https?:\/\/|\/)/i.test(url)) throw new ActionError(`${name} must be a web address`);
  return url;
}

// One of the cards that are the prizes, as the card picker sends it: { cardId, name, image }, or null for a prize card without a card
const PRIZE_CARDS = 6; // as many as there are prize cards
function prizeCard(card) {
  if (card === null || card === undefined) return null;
  if (typeof card !== 'object' || Array.isArray(card)) throw new ActionError('each prize card must be a card, or null');
  const name = text(card.name ?? '', 'name', 80);
  if (!name) throw new ActionError('a card needs a name');
  return { cardId: text(card.cardId ?? '', 'cardId', 64), name, image: imageUrl(card.image, 'image') };
}

const penaltyText = (count) => (count === 0 ? 'none' : `${count} prize card${count === 1 ? '' : 's'} in red`);

const pickSlot = (value) => integer(value, 'slot', -1, 7);
const benchSlot = (value) => integer(value, 'slot', 0, 7);
// Damage and healing come in tens, like the damage counters of the game
const inTens = (number, name) => {
  if (number % 10 !== 0) throw new ActionError(`${name} comes in tens (10, 20, 30...)`);
  return number;
};
const amount = (value) => inTens(integer(value, 'amount', -9999, 9999), 'damage and healing');

// -------------------------------------------------------------------- helpers

const who = (gs, side) => gs.state[side].name || SIDE_LABEL[side];
const slotKey = (side, slot) => (Number(slot) === -1 ? `${side}.active` : `${side}.bench.${slot}`);
const slotName = (gs, side, slot) => {
  const pokemon = gs.pokemonAt(side, Number(slot));
  return (pokemon && pokemon.name) || (Number(slot) === -1 ? 'Active' : `Bench ${Number(slot) + 1}`);
};
const opponent = (side) => (side === 'trainerA' ? 'trainerB' : 'trainerA');
const signed = (n) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

// Ability names from card data: strings or { name } objects. Undefined means "no information".
function abilityNames(list) {
  if (!Array.isArray(list)) return undefined;
  return list
    .map((item) => (typeof item === 'string' ? item : item && item.name))
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim().slice(0, 60))
    .slice(0, 4);
}

// Pokémon data sent with setActive / setBench
function pokemonFields(p) {
  const hp = p.hp === undefined || p.hp === '' ? 0 : Number(p.hp);
  return {
    cardId: text(p.cardId ?? '', 'cardId', 64),
    name: text(p.name ?? '', 'name', 80),
    image: imageUrl(p.image, 'image'),
    hp: Number.isFinite(hp) ? hp : 0,
    abilities: abilityNames(p.abilities),
    attacks: attacksOf(p.attacks),
    retreat: retreatOf({ retreat: p.retreat })
  };
}

// Toggle-style actions double as absolute ones when the sender says what it wants ({ enabled: true })
function flagAction(name, apply) {
  return {
    targets: (side, p) => (typeof p.enabled === 'boolean' ? null : [`${side}.flag.${name}`]),
    run: (gs, side, p) => apply(gs, side, typeof p.enabled === 'boolean' ? p.enabled : undefined),
    label: (gs, side) => `${who(gs, side)}: ${name} changed`
  };
}

// A once-per-turn token: going up uses it, going down gives it back. Only the supporter token has a sound of its own:
// attaching energy and playing a stadium already make theirs.
function counterAction(kind, key, delta, cue) {
  return {
    sfx: cue && delta > 0 ? () => cue : undefined,
    targets: (side) => [`${side}.${key}`],
    run: (gs, side) => gs.stepCounter(side, kind, delta),
    label: (gs, side) => `${who(gs, side)}: ${key} ${signed(delta)}`
  };
}

// A once-per-game marker (the GX attack, the VSTAR Power): going up uses it, going down gives it back. The game
// giving them back is done by the game state (see resetGameMarkers).
function markerAction(kind, name, delta) {
  return {
    targets: (side) => [`${side}.${name}`],
    run: (gs, side) => gs.stepCounter(side, kind, delta),
    label: (gs, side) => `${who(gs, side)} ${delta > 0 ? `used the ${name}` : `has the ${name} again`}`
  };
}

// ------------------------------------------------------------------- trainers

const TRAINER = {
  setName: {
    targets: () => null,
    run: (gs, side, p) => gs.setName(side, text(p.name, 'name', 60)),
    label: (gs, side) => `${SIDE_LABEL[side]} name → ${gs.state[side].name}`
  },
  setNationality: {
    targets: () => null,
    run: (gs, side, p) => gs.setNationality(side, text(p.nationality, 'nationality', 40)),
    label: (gs, side) => `${who(gs, side)} nationality → ${gs.state[side].nationality || 'none'}`
  },
  setDeck: {
    targets: () => null,
    run: (gs, side, p) => gs.setDeck(side, text(p.deck ?? '', 'deck', DECK.MAX_LENGTH)),
    label: (gs, side) => `${who(gs, side)} deck → ${gs.state[side].deck || 'none'}`
  },
  setDeckIcon: {
    targets: () => null,
    run: (gs, side, p) => gs.setDeckIcon(side, text(p.icon ?? '', 'icon', DECK.MAX_LENGTH)),
    label: (gs, side) => `${who(gs, side)} deck picture → ${gs.state[side].deckIcon || 'automatic'}`
  },
  setRecord: {
    targets: () => null,
    run: (gs, side, p) => gs.setRecord(side, {
      wins: integer(p.wins, 'wins', 0, 999),
      losses: integer(p.losses, 'losses', 0, 999),
      ties: integer(p.ties, 'ties', 0, 999)
    }),
    label: (gs, side) => {
      const { wins, losses, ties } = gs.state[side].record;
      return `${who(gs, side)} record ${wins}-${losses}-${ties}`;
    }
  },
  setTurn: {
    targets: () => ['turn'],
    run: (gs, side, p) => gs.setTurn(side, bool(p.isTurn, 'isTurn')),
    label: (gs, side) => `Turn → ${who(gs, gs.state.trainerA.isTurn ? 'trainerA' : 'trainerB')}`
  },

  prizeMinus: {
    sfx: () => 'prize',
    targets: (side) => [`${side}.prizes`],
    run: (gs, side) => gs.adjustPrizes(side, -1),
    label: (gs, side) => `${who(gs, side)} prizes −1 (${gs.state[side].prizes.count} left)`
  },
  prizePlus: {
    targets: (side) => [`${side}.prizes`],
    run: (gs, side) => gs.adjustPrizes(side, 1),
    label: (gs, side) => `${who(gs, side)} prizes +1 (${gs.state[side].prizes.count} left)`
  },
  prizeSet: {
    targets: () => null,
    run: (gs, side, p) => gs.setPrizes(side, integer(p.count, 'count', 0, 6)),
    label: (gs, side) => `${who(gs, side)} prizes set to ${gs.state[side].prizes.count}`
  },
  prizeReset: {
    targets: () => null,
    run: (gs, side) => gs.setPrizes(side, 6),
    label: (gs, side) => `${who(gs, side)} prizes reset`
  },
  togglePrizeHidden: flagAction('prize cards hidden', (gs, side, value) => gs.setPrizesHidden(side, value)),
  // Choose the cards that are the prizes: up to six, one for each prize card (null leaves one without a card). They show on the overlay on
  // their prize cards, face down with a question mark while the prizes are hidden. An empty list takes them all away.
  prizeCardsSet: {
    targets: (side) => [`${side}.prizeCards`],
    run: (gs, side, p, out, ctx) => {
      if (!Array.isArray(p.cards) || p.cards.length > PRIZE_CARDS) throw new ActionError(`cards must be a list of up to ${PRIZE_CARDS} cards`);
      gs.setPrizeCards(side, p.cards.map(prizeCard));
      ctx.count = gs.state[side].prizes.cards.filter(Boolean).length;
    },
    label: (gs, side, p, ctx) => (ctx.count ? `${who(gs, side)} prize cards set (${ctx.count})` : `${who(gs, side)} prize cards cleared`)
  },
  // The penalty is a number of prize cards, shown in red on the overlay
  prizePenaltyPlus: {
    targets: (side) => [`${side}.penalty`],
    run: (gs, side) => gs.adjustPrizePenalty(side, 1),
    label: (gs, side) => `${who(gs, side)} penalty: ${penaltyText(gs.state[side].prizes.penalty)}`
  },
  prizePenaltyMinus: {
    targets: (side) => [`${side}.penalty`],
    run: (gs, side) => gs.adjustPrizePenalty(side, -1),
    label: (gs, side) => `${who(gs, side)} penalty: ${penaltyText(gs.state[side].prizes.penalty)}`
  },
  prizePenaltySet: {
    targets: () => null,
    run: (gs, side, p) => gs.setPrizePenalty(side, integer(p.count, 'count', 0, 6)),
    label: (gs, side) => `${who(gs, side)} penalty: ${penaltyText(gs.state[side].prizes.penalty)}`
  },
  toggleItemLock: flagAction('item lock', (gs, side, value) => gs.setLock(side, 'itemLock', value)),
  toggleEvoLock: flagAction('evolution lock', (gs, side, value) => gs.setLock(side, 'evoLock', value)),

  energyPlus: counterAction('energyPerTurn', 'energy', 1),
  energyMinus: counterAction('energyPerTurn', 'energy', -1),
  energyReset: {
    targets: () => null,
    run: (gs, side) => gs.resetCounter(side, 'energyPerTurn'),
    label: (gs, side) => `${who(gs, side)} energy counter reset`
  },
  stadiumPlus: counterAction('stadiumPerTurn', 'stadium use', 1),
  stadiumMinus: counterAction('stadiumPerTurn', 'stadium use', -1),
  stadiumReset: {
    targets: () => null,
    run: (gs, side) => gs.resetCounter(side, 'stadiumPerTurn'),
    label: (gs, side) => `${who(gs, side)} stadium counter reset`
  },

  gxPlus: markerAction('gxPerGame', 'GX attack', 1),
  gxMinus: markerAction('gxPerGame', 'GX attack', -1),
  gxReset: {
    targets: () => null,
    run: (gs, side) => gs.resetCounter(side, 'gxPerGame'),
    label: (gs, side) => `${who(gs, side)} has the GX attack again`
  },
  vstarPlus: markerAction('vstarPerGame', 'VSTAR Power', 1),
  vstarMinus: markerAction('vstarPerGame', 'VSTAR Power', -1),
  vstarReset: {
    targets: () => null,
    run: (gs, side) => gs.resetCounter(side, 'vstarPerGame'),
    label: (gs, side) => `${who(gs, side)} has the VSTAR Power again`
  },

  supporterPlus: counterAction('supporterPerTurn', 'supporter', 1, 'supporter'),
  supporterMinus: counterAction('supporterPerTurn', 'supporter', -1),
  supporterReset: {
    targets: () => null,
    run: (gs, side) => gs.resetCounter(side, 'supporterPerTurn'),
    label: (gs, side) => `${who(gs, side)} supporter counter reset`
  },

  // Attach energy to a Pokémon. By default it counts as the turn's energy attachment;
  // send countsAsTurn: false for a special attachment (an ability or card effect).
  attachEnergy: {
    sfx: () => 'energy',
    targets: (side, p) => {
      const keys = [slotKey(side, p.slot)];
      if (p.countsAsTurn !== false) keys.push(`${side}.energy`);
      return keys;
    },
    run: (gs, side, p, out, ctx) => {
      const slot = pickSlot(p.slot);
      const type = text(p.energyType, 'energyType', 20);
      if (!GAME.ENERGY_KEYS.includes(type)) throw new ActionError('unknown energy type');
      const count = p.count === undefined ? 1 : integer(p.count, 'count', 1, 10);
      const pokemon = gs.pokemonAt(side, slot);
      if (!pokemon || !(pokemon.cardId || pokemon.name)) throw new ActionError('no Pokémon in that slot');

      for (let i = 0; i < count; i++) gs.attachEnergy(side, slot, type);
      if (p.countsAsTurn !== false) gs.stepCounter(side, 'energyPerTurn', 1);
      ctx.type = type;
      ctx.count = count;
    },
    label: (gs, side, p, ctx) =>
      `${slotName(gs, side, p.slot)} +${ctx.count} ${ctx.type} energy${p.countsAsTurn === false ? ' (special attachment)' : ''}`
  },
  // Attach a Special Energy card (a card, not one of the basic types). It counts as the turn's energy attachment
  // unless countsAsTurn is false.
  attachSpecialEnergy: {
    sfx: () => 'energy',
    targets: (side, p) => {
      const keys = [slotKey(side, p.slot)];
      if (p.countsAsTurn !== false) keys.push(`${side}.energy`);
      return keys;
    },
    run: (gs, side, p, out, ctx) => {
      const slot = pickSlot(p.slot);
      const cardId = text(p.cardId, 'cardId', 64);
      const name = text(p.name, 'name', 80);
      if (!cardId || !name) throw new ActionError('a Special Energy card needs an id and a name');
      const pokemon = gs.pokemonAt(side, slot);
      if (!pokemon || !(pokemon.cardId || pokemon.name)) throw new ActionError('no Pokémon in that slot');
      if (!gs.attachSpecialEnergy(side, slot, { cardId, name, image: imageUrl(p.image, 'image') })) {
        throw new ActionError('that Pokémon already has as many Special Energy cards as it can show');
      }
      if (p.countsAsTurn !== false) gs.stepCounter(side, 'energyPerTurn', 1);
      ctx.name = name;
    },
    label: (gs, side, p, ctx) => `${slotName(gs, side, p.slot)} +${ctx.name}${p.countsAsTurn === false ? ' (special attachment)' : ''}`
  },
  // Special conditions of the Active Pokémon (Asleep, Burned, Confused, Paralyzed, Poisoned). The sender says whether the
  // condition is now on, so two producers clicking the same chip agree; without it the condition is toggled.
  toggleStatus: {
    targets: (side, p) => (typeof p.enabled === 'boolean' ? null : [`${side}.status`]),
    run: (gs, side, p, out, ctx) => {
      const condition = text(p.condition, 'condition', 20);
      if (!GAME.STATUS_KEYS.includes(condition)) throw new ActionError('unknown special condition');
      const pokemon = gs.state[side].active;
      if (!(pokemon.cardId || pokemon.name)) throw new ActionError('there is no Active Pokémon');
      ctx.condition = GAME.STATUS_CONDITIONS.find((entry) => entry.key === condition).label;
      ctx.on = gs.setStatus(side, condition, typeof p.enabled === 'boolean' ? p.enabled : undefined).includes(condition);
    },
    label: (gs, side, p, ctx) => `${slotName(gs, side, -1)} is ${ctx.on ? '' : 'no longer '}${ctx.condition}`
  },
  clearStatus: {
    targets: (side) => [`${side}.status`],
    run: (gs, side) => gs.clearStatus(side),
    label: (gs, side) => `${slotName(gs, side, -1)} recovered from every special condition`
  },
  setRetreat: {
    targets: (side, p) => [slotKey(side, p.slot)],
    run: (gs, side, p) => gs.setRetreat(side, pickSlot(p.slot), integer(p.cost, 'cost', 0, 6)),
    label: (gs, side, p) => `${slotName(gs, side, p.slot)} retreat cost ${gs.pokemonAt(side, Number(p.slot)).retreat}`
  },
  removeSpecialEnergy: {
    targets: (side, p) => [slotKey(side, p.slot)],
    run: (gs, side, p) => gs.removeSpecialEnergy(side, pickSlot(p.slot), integer(p.index, 'index', 0, 9)),
    label: (gs, side, p) => `${slotName(gs, side, p.slot)} lost a Special Energy`
  },
  removeEnergy: {
    targets: (side, p) => [slotKey(side, p.slot)],
    run: (gs, side, p) => gs.removeEnergy(side, pickSlot(p.slot), integer(p.index, 'index', 0, 99)),
    label: (gs, side, p) => `${slotName(gs, side, p.slot)} lost an energy`
  },

  // Ability tokens. The sender says whether the ability is now used, so two producers
  // clicking the same token agree instead of cancelling each other out.
  setAbilityUsed: {
    sfx: (side, p) => (p.used === true ? 'ability' : null),
    targets: () => null,
    run: (gs, side, p, out, ctx) => {
      const slot = pickSlot(p.slot);
      const index = integer(p.index, 'index', 0, 3);
      const used = bool(p.used, 'used');
      const ability = (gs.pokemonAt(side, slot) || { abilities: [] }).abilities[index];
      if (!ability) throw new ActionError('no such ability token');
      ctx.name = ability.name;
      ctx.used = used;
      gs.setAbilityUsed(side, slot, index, used);
    },
    label: (gs, side, p, ctx) => `${slotName(gs, side, p.slot)}: ${ctx.name} ${ctx.used ? 'used' : 'ready'}`
  },
  addAbility: {
    targets: (side, p) => [`${slotKey(side, p.slot)}.abilities`],
    run: (gs, side, p, out, ctx) => {
      const slot = pickSlot(p.slot);
      const name = text(p.name, 'name', 60);
      if (!name) throw new ActionError('name is required');
      const scope = p.scope === 'game' ? 'game' : 'turn';
      const pokemon = gs.pokemonAt(side, slot);
      if (!pokemon || !(pokemon.cardId || pokemon.name)) throw new ActionError('no Pokémon in that slot');
      ctx.name = name;
      gs.addAbility(side, slot, name, scope);
    },
    label: (gs, side, p, ctx) => `${slotName(gs, side, p.slot)}: added ability token "${ctx.name}"`
  },
  removeAbility: {
    targets: (side, p) => [`${slotKey(side, p.slot)}.abilities`],
    run: (gs, side, p) => gs.removeAbility(side, pickSlot(p.slot), integer(p.index, 'index', 0, 3)),
    label: (gs, side, p) => `${slotName(gs, side, p.slot)}: removed an ability token`
  },
  resetAbilities: {
    targets: () => null,
    run: (gs, side, p) => gs.resetAbilities(side, { includeGame: p.includeGame === true }),
    label: (gs, side) => `${who(gs, side)}: abilities ready again`
  },

  // Switch a benched Pokémon with the active one
  swapWithActive: {
    sfx: () => 'deploy',
    targets: (side, p) => [`${side}.active`, `${side}.bench.${p.slot}`],
    run: (gs, side, p, out, ctx) => {
      const slot = benchSlot(p.slot);
      const benched = gs.pokemonAt(side, slot);
      if (!benched || !(benched.cardId || benched.name)) throw new ActionError('no Pokémon in that bench slot');
      ctx.name = benched.name;
      gs.swapWithActive(side, slot);
    },
    label: (gs, side, p, ctx) => `${who(gs, side)} switched in ${ctx.name || 'a Pokémon'}`
  },

  // Drag and drop: the Pokémon in one slot goes to another (-1 is the Active spot, 0 and up the bench). When there is a Pokémon there
  // they change places.
  moveSlot: {
    sfx: (side, p) => (Number(p.from) === -1 || Number(p.to) === -1 ? 'deploy' : 'bench'),
    targets: (side, p) => [slotKey(side, p.from), slotKey(side, p.to)],
    run: (gs, side, p, out, ctx) => {
      const from = pickSlot(p.from);
      const to = pickSlot(p.to);
      if (from === to) throw new ActionError('that is the same slot');
      const size = gs.state[side].benchSize;
      if (from >= size || to >= size) throw new ActionError('that bench slot is not in use');
      const moving = gs.pokemonAt(side, from);
      if (!moving || !(moving.cardId || moving.name)) throw new ActionError('no Pokémon in that slot');
      const other = gs.pokemonAt(side, to);
      ctx.name = moving.name || 'a Pokémon';
      ctx.other = other && (other.cardId || other.name) ? other.name || 'a Pokémon' : '';
      ctx.to = to;
      gs.moveSlot(side, from, to);
    },
    label: (gs, side, p, ctx) => {
      const place = ctx.to === -1 ? 'the Active spot' : `bench ${ctx.to + 1}`;
      return ctx.other ? `${who(gs, side)} swapped ${ctx.name} and ${ctx.other}` : `${who(gs, side)} moved ${ctx.name} to ${place}`;
    }
  },

  // A Pokémon is knocked out: announce it, take it off the table and let the opponent take prizes
  knockOut: {
    sfx: () => 'ko',
    targets: (side, p) => [slotKey(side, p.slot), `${opponent(side)}.prizes`],
    run: (gs, side, p, out, ctx) => {
      const slot = pickSlot(p.slot);
      const prizes = p.prizes === undefined ? 1 : integer(p.prizes, 'prizes', 0, 6);
      const pokemon = gs.pokemonAt(side, slot);
      if (!pokemon || !(pokemon.cardId || pokemon.name)) throw new ActionError('no Pokémon in that slot');

      ctx.name = pokemon.name || 'Pokémon';
      ctx.prizes = prizes;
      gs.knockOut(side, slot, { prizesTaken: prizes, clear: p.clear !== false });
      const a = announcements.build(gs.state, 'ko', { side, isOOC: slot !== -1, slot });
      if (a) out.push(a);
    },
    label: (gs, side, p, ctx) =>
      `${ctx.name} knocked out (${who(gs, opponent(side))} takes ${ctx.prizes} prize${ctx.prizes === 1 ? '' : 's'})`
  },

  // Positive amounts are damage, negative amounts heal
  activeDamage: {
    sfx: (side, p) => (Number(p.amount) < 0 ? 'heal' : 'damage'),
    targets: (side) => [`${side}.active.hp`],
    run: (gs, side, p) => gs.damage(side, -1, amount(p.amount)),
    label: (gs, side, p) => `${slotName(gs, side, -1)} ${Number(p.amount) >= 0 ? 'took' : 'healed'} ${Math.abs(Number(p.amount))}`
  },
  benchDamage: {
    sfx: (side, p) => (Number(p.amount) < 0 ? 'heal' : 'damage'),
    targets: (side, p) => [`${side}.bench.${p.slot}.hp`],
    run: (gs, side, p) => gs.damage(side, benchSlot(p.slot), amount(p.amount)),
    label: (gs, side, p) => `${slotName(gs, side, p.slot)} ${Number(p.amount) >= 0 ? 'took' : 'healed'} ${Math.abs(Number(p.amount))}`
  },
  activeHeal: {
    sfx: () => 'heal',
    targets: (side) => [`${side}.active.hp`],
    run: (gs, side) => gs.healFull(side, -1),
    label: (gs, side) => `${slotName(gs, side, -1)} fully healed`
  },
  benchHeal: {
    sfx: () => 'heal',
    targets: (side, p) => [`${side}.bench.${p.slot}.hp`],
    run: (gs, side, p) => gs.healFull(side, benchSlot(p.slot)),
    label: (gs, side, p) => `${slotName(gs, side, p.slot)} fully healed`
  },
  setHP: {
    targets: () => null,
    run: (gs, side, p) => gs.setHP(side, pickSlot(p.slot), integer(p.current, 'current', 0, 9999)),
    label: (gs, side, p) => `${slotName(gs, side, p.slot)} HP set to ${gs.pokemonAt(side, Number(p.slot)).hp.current}`
  },
  setMaxHP: {
    targets: () => null,
    run: (gs, side, p) => gs.setMaxHP(side, pickSlot(p.slot), integer(p.max, 'max', 0, 9999)),
    label: (gs, side, p) => `${slotName(gs, side, p.slot)} max HP set to ${gs.pokemonAt(side, Number(p.slot)).hp.max}`
  },

  setActive: {
    sfx: () => 'deploy',
    targets: (side) => [`${side}.active`],
    run: (gs, side, p) => gs.setPokemon(side, -1, pokemonFields(p)),
    label: (gs, side) => `${who(gs, side)} active → ${slotName(gs, side, -1)}`
  },
  setBench: {
    sfx: () => 'bench',
    targets: (side, p) => [`${side}.bench.${p.slot}`],
    run: (gs, side, p) => gs.setPokemon(side, benchSlot(p.slot), pokemonFields(p)),
    label: (gs, side, p) => `${who(gs, side)} bench ${Number(p.slot) + 1} → ${slotName(gs, side, p.slot)}`
  },
  clearSlot: {
    targets: (side, p) => [slotKey(side, p.slot)],
    run: (gs, side, p) => gs.clearSlot(side, pickSlot(p.slot)),
    label: (gs, side, p) => `${who(gs, side)} cleared ${Number(p.slot) === -1 ? 'active' : `bench ${Number(p.slot) + 1}`}`
  },
  benchSizePlus: {
    targets: (side) => [`${side}.benchSize`],
    run: (gs, side) => gs.adjustBenchSize(side, 1),
    label: (gs, side) => `${who(gs, side)} bench size ${gs.state[side].benchSize}`
  },
  benchSizeMinus: {
    targets: (side) => [`${side}.benchSize`],
    run: (gs, side) => gs.adjustBenchSize(side, -1),
    label: (gs, side) => `${who(gs, side)} bench size ${gs.state[side].benchSize}`
  },
  benchSizeReset: {
    targets: (side) => [`${side}.benchSize`],
    run: (gs, side) => gs.resetBenchSize(side),
    label: (gs, side) => `${who(gs, side)} bench back to ${gs.state[side].benchSize} slots`
  }
};

// ---------------------------------------------------------------------- match

function matchWinAction(side, direction) {
  return {
    sfx: () => (direction > 0 ? 'point' : null),
    targets: () => ['score'],
    run: (gs) => (direction > 0 ? gs.matchWin(side) : gs.matchWinMinus(side)),
    label: (gs) => {
      const { trainerAWins, trainerBWins } = gs.state.matchScore;
      return `Score ${trainerAWins}–${trainerBWins}`;
    }
  };
}

const MATCH = {
  toggleTurn: {
    sfx: () => 'turn',
    targets: () => ['turn'],
    run: (gs, side, p, announce) => {
      gs.toggleTurn();
      const a = announcements.build(gs.state, 'passturn');
      if (a) announce.push(a);
    },
    label: (gs) => `Turn → ${who(gs, gs.state.trainerA.isTurn ? 'trainerA' : 'trainerB')}`
  },
  startGame: {
    targets: () => ['game', 'score', 'trainerA.prizes', 'trainerB.prizes'],
    run: (gs) => gs.startGame(),
    label: () => 'Game started'
  },
  // The next game of the match: both trainers' prize cards and penalties start again and the once-per-game markers come back. The score
  // and the names stay (startGame, above, starts a whole new match: the score goes back to 0 too).
  nextGame: {
    targets: () => ['game', 'trainerA.prizes', 'trainerB.prizes', 'trainerA.penalty', 'trainerB.penalty'],
    run: (gs) => gs.nextGame(),
    label: (gs) => {
      const { trainerAWins, trainerBWins } = gs.state.matchScore;
      return `Next game (score ${trainerAWins}–${trainerBWins})`;
    }
  },
  // The game is paused (a judge call, a break) or resumed. While it is paused the overlay shows a banner and grays out the rest; resuming
  // shows a short toast. `enabled` says what is wanted, so two producers pressing it at once agree.
  togglePause: {
    targets: (side, p) => (typeof p.enabled === 'boolean' ? null : ['paused']),
    run: (gs, side, p, out) => {
      const was = gs.state.paused;
      const now = gs.setPaused(typeof p.enabled === 'boolean' ? p.enabled : undefined);
      if (was && !now) {
        const resumed = announcements.build(gs.state, 'resume');
        if (resumed) out.push(resumed);
      }
    },
    label: (gs) => (gs.state.paused ? 'Game paused' : 'Game resumed')
  },
  endGame: {
    targets: () => ['game'],
    run: (gs, side, p) => {
      const winner = p.winner;
      if (winner !== 'trainerA' && winner !== 'trainerB') throw new ActionError('winner must be trainerA or trainerB');
      gs.endGame(winner);
    },
    label: (gs, side, p) => `Game ended, ${who(gs, p.winner)} won`
  },
  trainerAMatchWin: matchWinAction('trainerA', 1),
  trainerAMatchWinPlus: matchWinAction('trainerA', 1),
  trainerBMatchWin: matchWinAction('trainerB', 1),
  trainerBMatchWinPlus: matchWinAction('trainerB', 1),
  trainerAMatchWinMinus: matchWinAction('trainerA', -1),
  trainerBMatchWinMinus: matchWinAction('trainerB', -1),
  resetMatchScore: {
    targets: () => null,
    run: (gs) => gs.resetMatchScore(),
    label: () => 'Score reset'
  },
  setRoundLabel: {
    targets: () => null,
    run: (gs, side, p) => gs.setRoundLabel(text(p.text ?? '', 'text', 40)),
    label: (gs) => (gs.state.matchInfo.round ? `Round label → ${gs.state.matchInfo.round}` : 'Round label cleared')
  },
  setBestOf: {
    targets: () => null,
    run: (gs, side, p) => {
      const bestOf = integer(p.bestOf, 'bestOf', 1, 5);
      if (bestOf % 2 === 0) throw new ActionError('bestOf must be 1, 3 or 5');
      gs.setBestOf(bestOf);
    },
    label: (gs) => `Best of ${gs.state.matchScore.bestOf}`
  },
  resetGamePrizes: {
    targets: () => null,
    run: (gs) => {
      gs.setPrizes('trainerA', 6);
      gs.setPrizes('trainerB', 6);
    },
    label: () => 'Prizes reset for both trainers'
  }
};

// ----------------------------------------------------------- announcements

const ANNOUNCEMENT_SOUND = { topdeck: 'topdeck', attack: 'attack', startgame: 'startgame', win: 'win', passturn: 'turn', ko: 'ko' };

function announce(action, type, describe, paramsFrom = () => ({})) {
  return {
    // an ability announced like an attack has the ability's sound
    sfx: (side, p) => (type === 'attack' && p && p.ability === true ? 'ability' : ANNOUNCEMENT_SOUND[type]),
    targets: () => [`announce.${action}`],
    run: (gs, side, p, out) => {
      const a = announcements.build(gs.state, type, paramsFrom(p));
      if (a) out.push(a);
    },
    label: describe
  };
}

const TOAST = {
  topDeck: announce('topDeck', 'topdeck', () => 'Top Deck announcement', (p) => ({ target: p.target })),
  attack: announce('attack', 'attack', () => 'Attack announcement', (p) => ({
    attackName: p.attackName === undefined ? undefined : text(p.attackName, 'attackName', 60),
    // who attacks (or uses the ability); without it, whoever has the turn
    source: p.source === 'trainerA' || p.source === 'trainerB' ? p.source : undefined,
    ability: p.ability === true,
    damage: p.damage === undefined || p.ability === true ? 0 : inTens(integer(p.damage, 'damage', 0, 9999), 'damage')
  })),
  startGame: announce('startGame', 'startgame', () => 'Game start announcement'),
  trainerAWin: announce('trainerAWin', 'win', () => 'Trainer A victory announcement', () => ({ side: 'trainerA' })),
  trainerBWin: announce('trainerBWin', 'win', () => 'Trainer B victory announcement', () => ({ side: 'trainerB' })),
  passTurn: announce('passTurn', 'passturn', () => 'Pass Turn announcement'),
  trainerAKO: announce('trainerAKO', 'ko', () => 'Trainer A KO announcement', (p) => ({ side: 'trainerA', isOOC: Boolean(p.isOOC), slot: p.slot })),
  trainerBKO: announce('trainerBKO', 'ko', () => 'Trainer B KO announcement', (p) => ({ side: 'trainerB', isOOC: Boolean(p.isOOC), slot: p.slot }))
};

// ---------------------------------------------------------------------- cards

const CARD_TARGET = /^(trainer[AB])-(active|bench-(\d))$/;

function cardTargetKey(target) {
  if (target === 'stadium') return 'stadium';
  const match = CARD_TARGET.exec(String(target));
  if (!match) return null;
  return match[2] === 'active' ? `${match[1]}.active` : `${match[1]}.bench.${match[3]}`;
}

// The card data the server resolved (or the control panel supplied), reduced to what we use
function cleanCard(data) {
  if (!data || typeof data !== 'object') throw new ActionError('card data is missing');
  const images = {};
  for (const size of ['small', 'medium', 'large']) {
    const url = imageUrl(data.images && data.images[size], `${size} image`);
    if (url) images[size] = url;
  }
  return {
    id: text(data.id ?? '', 'card id', 64),
    name: text(data.name ?? '', 'card name', 80),
    hp: data.hp === undefined || data.hp === null ? '' : String(data.hp).slice(0, 6),
    abilities: abilityNames(data.abilities),
    attacks: attacksOf(data.attacks),
    retreat: retreatOf({ retreat: data.retreat }),
    images
  };
}

// A Stadium that is played uses the Stadium play of the turn of the trainer who played it, unless the sender says it does not (`consume:
// false`: a correction, or an effect that put it there). `playedBy` says who (the control panel always does); without it, whoever has the turn.
const isSide = (value) => value === 'trainerA' || value === 'trainerB';
const stadiumPlayedBy = (gs, p) => (isSide(p.playedBy) ? p.playedBy : gs.turnHolder());
const stadiumTargets = (p) => (p.consume !== false && isSide(p.playedBy) ? [`${p.playedBy}.stadium use`] : []);
const stadiumLabel = (gs, ctx) => (ctx.usedBy ? ` · ${who(gs, ctx.usedBy)} used the Stadium play` : '');

const CARD = {
  select: {
    sfx: (side, p) => (p.target === 'stadium' ? 'stadium' : /-active$/.test(String(p.target)) ? 'deploy' : 'bench'),
    targets: (side, p) => {
      const key = cardTargetKey(p.target);
      return key ? [key, ...(p.target === 'stadium' ? stadiumTargets(p) : [])] : null;
    },
    run: (gs, side, p, out, ctx) => {
      if (p.target !== 'stadium' && !CARD_TARGET.test(String(p.target))) throw new ActionError('invalid card target');
      gs.selectCard(p.target, cleanCard(p.cardData), { keep: p.evolve === true });
      if (p.target === 'stadium' && p.consume !== false) ctx.usedBy = gs.useStadiumPlay(stadiumPlayedBy(gs, p));
    },
    label: (gs, side, p, ctx) => `${p.target === 'stadium' ? 'Stadium' : p.target.replace('-', ' ').replace('-', ' ')} → ${p.cardData && p.cardData.name}${stadiumLabel(gs, ctx)}`
  },
  setStadium: {
    sfx: (side, p) => (p.cardId || p.name ? 'stadium' : null),
    targets: (side, p) => ['stadium', ...stadiumTargets(p)],
    run: (gs, side, p, out, ctx) => {
      gs.setStadium(text(p.cardId ?? '', 'cardId', 64), text(p.name ?? '', 'name', 80), imageUrl(p.image, 'image'));
      // (taking it away, with nothing in its place, uses nothing)
      if (gs.state.stadium.inPlay && p.consume !== false) ctx.usedBy = gs.useStadiumPlay(stadiumPlayedBy(gs, p));
    },
    label: (gs, side, p, ctx) => (gs.state.stadium.inPlay ? `Stadium → ${gs.state.stadium.name}${stadiumLabel(gs, ctx)}` : 'Stadium cleared')
  },
  favorite: {
    targets: (side, p) => [`favorite.${p.cardId}`],
    run: (gs, side, p) => gs.toggleFavorite(text(p.cardId, 'cardId', 64)),
    label: (gs, side, p) => `Favorite toggled (${p.cardId})`
  },
  addFeatureCard: {
    targets: () => ['featureCards'],
    run: (gs, side, p) => gs.addFeatureCard({
      cardId: text(p.cardId ?? '', 'cardId', 64),
      name: text(p.name ?? '', 'name', 80),
      image: imageUrl(p.image, 'image')
    }),
    label: (gs, side, p) => `Feature card added: ${p.name}`
  },
  addFeatureSeparator: {
    targets: () => ['featureCards'],
    run: (gs, side, p) => {
      if (!GAME.FEATURE_SEPARATORS.some((one) => one.symbol === p.symbol)) {
        throw new ActionError(`the sign between feature cards can be: ${GAME.FEATURE_SEPARATORS.map((one) => one.symbol).join(', ')}`);
      }
      gs.addFeatureSeparator(p.symbol);
    },
    label: (gs, side, p) => `Feature separator added: ${p.symbol}`
  },
  removeFeatureCard: {
    targets: () => ['featureCards'],
    run: (gs, side, p) => gs.removeFeatureCard({
      id: p.id === undefined ? undefined : text(p.id, 'id', 64),
      index: p.id === undefined ? integer(p.index, 'index', 0, 99) : undefined
    }),
    label: () => 'Feature card removed'
  },
  clearFeatureCards: {
    targets: () => ['featureCards'],
    run: (gs) => gs.clearFeatureCards(),
    label: () => 'Feature cards cleared'
  }
};

// ------------------------------------------------------------------- settings

const SETTINGS = {
  import: {
    targets: () => ['*'],
    run: (gs, side, p) => {
      if (!p.config || typeof p.config !== 'object' || Array.isArray(p.config)) throw new ActionError('config must be an object');
      gs.importState(p.config);
    },
    label: () => 'Configuration imported'
  },
  save: {
    silent: true,
    targets: () => null,
    run: (gs) => gs.autosave(),
    label: () => 'Saved'
  }
};

// Any other settings message is a settings change: the fields besides `action` and `meta` are the new values
const SETTINGS_UPDATE = {
  targets: () => null,
  run: (gs, side, p) => {
    const { action, meta, ...patch } = p;
    // a key that cannot be one is refused with a reason, rather than quietly not kept
    for (const name of GAME.SECRET_SETTINGS) {
      if (name in patch && (typeof patch[name] !== 'string' || !GAME.isSecretValue(patch[name].trim()))) {
        throw new ActionError('That does not look like a key: it has to be made of letters, digits and symbols, without spaces');
      }
    }
    gs.updateSettings(patch);
  },
  // (what is said here is read by every producer: a key itself never is)
  label: (gs, side, p) => ('display' in p ? 'Overlay visibility changed'
    : GAME.SECRET_SETTINGS.some((name) => name in p) ? 'A card service key changed'
      : ['apiProvider', 'cardLanguage', 'librarySource'].some((name) => name in p) ? 'Card services changed' : 'Settings changed')
};

const RESET = {
  run: (gs) => gs.fullReset(),
  targets: () => ['*'],
  label: () => 'Everything reset'
};

// ----------------------------------------------------------------- public API

// Look up the handler for a socket event + payload. Returns null for anything unknown or invalid.
function resolve(event, payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.action !== 'string') return null;
  const { action } = payload;

  let spec = null;
  let side = null;

  switch (event) {
    case 'action:trainerA':
    case 'action:trainerB':
      side = event.slice('action:'.length);
      spec = Object.hasOwn(TRAINER, action) ? TRAINER[action] : null;
      break;
    case 'action:match':
      spec = Object.hasOwn(MATCH, action) ? MATCH[action] : null;
      break;
    case 'action:toast':
      spec = Object.hasOwn(TOAST, action) ? TOAST[action] : null;
      break;
    case 'action:card':
      spec = Object.hasOwn(CARD, action) ? CARD[action] : null;
      break;
    case 'action:settings':
      spec = Object.hasOwn(SETTINGS, action) ? SETTINGS[action] : SETTINGS_UPDATE;
      break;
    case 'action:reset':
      spec = payload.confirm === 'FULL_RESET' ? RESET : null;
      break;
    default:
      return null;
  }
  if (!spec) return null;

  const ctx = {};
  return {
    event,
    action,
    side,
    silent: Boolean(spec.silent),
    // Parts of the game this touches, or null for "last writer wins" changes
    targets: () => (spec.targets ? spec.targets(side, payload) : null),
    // Applies the action to `gs` and returns the announcements it triggers
    run(gs) {
      const out = [];
      const winning = { trainerA: gs.isWinning('trainerA'), trainerB: gs.isWinning('trainerB') };
      spec.run(gs, side, payload, out, ctx);
      // Whoever has just taken the last prize card they need has won the game: the score goes up and the victory is announced by
      // itself, whatever took the card (a knock out, the minus button, a draft sent from somewhere else) or gave the opponent the
      // penalty that made the last one unnecessary. The opponent's penalty counts as prize cards already taken.
      for (const trainer of ['trainerA', 'trainerB']) {
        if (winning[trainer] || !gs.isWinning(trainer)) continue;
        gs.matchWin(trainer);
        const victory = announcements.build(gs.state, 'win', { side: trainer, game: true });
        if (victory) out.push(victory);
        ctx.won = true;
        ctx.winners = [...(ctx.winners || []), trainer];
      }
      return out;
    },
    // Human-readable description, to be called after run()
    label: (gs) => {
      const text = spec.label(gs, side, payload, ctx);
      if (!ctx.winners) return text;
      const { trainerAWins, trainerBWins } = gs.state.matchScore;
      return `${text} · ${ctx.winners.map((winner) => who(gs, winner)).join(' and ')} won the game (${trainerAWins}–${trainerBWins})`;
    },
    // The sound cues this action makes, to be called after run(). Independent of the visual announcements.
    cues: () => [...(spec.sfx ? [].concat(spec.sfx(side, payload, ctx) || []) : []), ...(ctx.won ? ['win'] : [])]
  };
}

// Fetch whatever an action needs from the network before it is applied (kept out of the
// synchronous apply step so a slow card API never delays other producers)
const DETAILS_TIMEOUT_MS = 2500;

async function prepare(gs, event, payload) {
  if (event !== 'action:card' || payload.action !== 'select' || typeof payload.cardId !== 'string') return payload;

  const supplied = payload.cardData && typeof payload.cardData === 'object' ? payload.cardData : null;
  // A Pokémon's abilities, attacks and retreat cost are not in search results, so look the card up (cached after the first time)
  if (supplied && (payload.target === 'stadium' || (supplied.abilities !== undefined && supplied.attacks !== undefined))) return payload;

  const details = await Promise.race([
    gs.pokemonTCG.getCard(payload.cardId, { source: supplied && supplied.source, language: supplied && supplied.language }).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), DETAILS_TIMEOUT_MS).unref())
  ]);
  // The card service did not answer in time: the Pokémon is put there now, and the attacks and the retreat cost are looked for in the
  // background and filled in when they come (see Session.fillDetailsLater)
  if (!details) return payload.target === 'stadium' ? payload : { ...payload, detailsLater: true };
  return { ...payload, cardData: supplied ? { ...supplied, abilities: details.abilities, attacks: details.attacks, retreat: details.retreat } : details };
}

module.exports = { resolve, prepare, ActionError, SIDE_LABEL };
