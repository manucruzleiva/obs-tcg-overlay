/**
 * GameState Service - the single source of truth for a match.
 *
 * Every mutation is a plain synchronous method, so the same code runs on the live
 * state and on a throwaway copy (see fork()) used to preview a producer's draft.
 */

const { randomUUID } = require('crypto');
const DISPLAY = require('../../public/js/display-options');
const SOUND = require('../../public/js/sound-options');
const GAME = require('../../public/js/game-data');
const DECK = require('../../public/js/deck');
const { MAX_ATTACKS, MAX_RETREAT } = require('./attacks');

const MAX_ENERGIES_PER_POKEMON = 20;
const MAX_ABILITIES = 4;
const MAX_SPECIAL_ENERGIES = 4;
const MAX_TOOLS = 3; // Pokémon Tools attached to one Pokémon (the rules say one, but some effects allow more)
const MAX_STAGES = 4; // the earlier stages of a Pokémon that evolved, kept so it can go back
const MIN_SECONDS = 1;
const MAX_SECONDS = 30;

const MAX_PRIZES = 6;
const MIN_BENCH = 2;
const MAX_BENCH = 8;
const DEFAULT_BENCH = 5;
const MAX_FEATURE_ENTRIES = 14; // feature cards and the separators between them
const MAX_FAVORITES = 50;

// Used by forked copies so a draft preview never writes to the database
const NOOP_DB = {
  saveMatch() {},
  addFavorite() {},
  removeFavorite() {},
  saveGameState() {}
};

const otherSide = (side) => (side === 'trainerA' ? 'trainerB' : 'trainerA');

// The cards that are the prizes of a trainer, one for each prize card: { cardId, name, image }, or null for a prize card nobody has chosen a
// card for. The overlay shows each on its prize card (face down with a question mark while the prizes are hidden).
const emptyPrizeCards = () => Array.from({ length: MAX_PRIZES }, () => null);

// What was saved or sent as prize cards, made into exactly one entry (a card, or null) for each prize card
function cleanPrizeCards(list) {
  const cards = emptyPrizeCards();
  if (!Array.isArray(list)) return cards;
  list.slice(0, MAX_PRIZES).forEach((card, index) => {
    if (!card || typeof card !== 'object' || typeof card.name !== 'string' || !card.name) return;
    cards[index] = { cardId: typeof card.cardId === 'string' ? card.cardId : '', name: card.name, image: typeof card.image === 'string' ? card.image : '' };
  });
  return cards;
}

// What a Pokémon Tool is when it is kept: the card, and how much it adds to the maximum HP of the Pokémon (0 for most)
function cleanTools(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string' && tool.name).slice(0, MAX_TOOLS).map((tool) => ({
    cardId: typeof tool.cardId === 'string' ? tool.cardId.slice(0, 64) : '',
    name: tool.name.slice(0, 80),
    image: typeof tool.image === 'string' ? tool.image : '',
    hp: Number.isInteger(tool.hp) ? Math.max(0, Math.min(999, tool.hp)) : 0
  }));
}

// The earlier stages of a Pokémon that evolved (Pichu, then Pikachu, then Raichu): the card each was, to go back to
function cleanStages(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((stage) => stage && typeof stage === 'object' && typeof stage.name === 'string' && stage.name).slice(-MAX_STAGES).map((stage) => ({
    cardId: typeof stage.cardId === 'string' ? stage.cardId.slice(0, 64) : '',
    name: stage.name.slice(0, 80),
    image: typeof stage.image === 'string' ? stage.image : '',
    hp: Number.isFinite(stage.hp) ? Math.max(0, Math.min(9999, Math.trunc(stage.hp))) : 0,
    abilities: Array.isArray(stage.abilities) ? stage.abilities.filter((name) => typeof name === 'string').slice(0, MAX_ABILITIES) : [],
    attacks: Array.isArray(stage.attacks) ? stage.attacks.slice(0, MAX_ATTACKS) : [],
    retreat: Number.isInteger(stage.retreat) ? Math.max(0, Math.min(MAX_RETREAT, stage.retreat)) : 0
  }));
}

const emptyPokemon = (slot) => ({
  slot,
  cardId: '',
  name: '',
  image: '',
  hp: { max: 0, current: 0 },
  energies: [],
  // Special Energy cards: { cardId, name, image }. They are cards, not one of the basic types, so the overlay shows a circle cut out of each.
  specialEnergies: [],
  // What the card says it can do: [{ name, damage, mod }] (see attacks.js), and how many Energy it costs to retreat
  attacks: [],
  retreat: 0,
  // Pokémon Tools: { cardId, name, image, hp } where hp is what the tool adds to the maximum HP
  tools: [],
  // the card this Pokémon was before it evolved (the last one is the stage just before this one)
  stages: [],
  status: [],
  // Ability tokens: { name, used, scope } where scope 'turn' refreshes every turn and 'game' never does
  abilities: []
});

class GameStateService {
  constructor(db, pokemonTCG) {
    this.db = db;
    this.pokemonTCG = pokemonTCG;

    // Load saved state or create default
    this.state = this.loadState();
    this.matchStartTime = null;

    // unref: the timer alone never keeps the process alive (the HTTP server does that)
    this.autosaveInterval = setInterval(() => this.autosave(), 30000).unref();
  }

  // ---------------------------------------------------------------- loading

  loadState() {
    const saved = this.db.loadGameState();
    return saved ? this.mergeWithDefaults(saved) : this.getDefaultState();
  }

  getDefaultState() {
    return {
      // Bumped by the server on every change; clients use it to detect stale actions
      revision: 0,
      settings: {
        // which card services are asked ('auto', 'pokemontcg' or 'tcgdex') and the language of the cards TCGdex gives
        apiProvider: 'auto',
        cardLanguage: 'en',
        // which service builds the card libraries (see catalog.js)
        librarySource: 'pokemontcg',
        // the keys of the card services: secrets (see SECRET_SETTINGS)
        apiKey: '',
        scrydexKey: '',
        scrydexTeam: '',
        preferLowestRarity: true,
        autoScale: true,
        overlayOpacity: 100,
        showPenaltyAnimation: true,
        cacheMaxSizeMB: 500,
        cacheTTLDays: 30,
        language: 'en_US',
        enableStreamDeck: true,
        autosaveIntervalSec: 30,

        // What the overlay shows: one switch per element (see public/js/display-options.js)
        display: { ...DISPLAY.DEFAULTS },

        // Sound effects: a master switch and volume, plus a switch and volume for each cue
        sound: structuredClone(SOUND.DEFAULTS),

        // How long announcements stay on screen, in seconds (see MIN_SECONDS / MAX_SECONDS)
        toastSeconds: 2,
        animationSeconds: 3,

        // Announcement enable flags (toast = small banner, animation = full-screen effect)
        // (the pause toast: the banner that stays while the game is paused, and the short one when it is resumed)
        enablePauseToast: true,
        enableStartGameToast: true,
        enableStartGameAnimation: true,
        enableTrainerAWinToast: true,
        enableTrainerAWinAnimation: true,
        enableTrainerBWinToast: true,
        enableTrainerBWinAnimation: true,
        enableTopDeckToast: true,
        enableTopDeckAnimation: true,
        enableAttackToast: true,
        enableAttackAnimation: true,
        enablePassTurnToast: true,
        enablePassTurnAnimation: true,
        enableTrainerAKOToast: true,
        enableTrainerAKOAnimation: true,
        enableTrainerAKO_OOC_Animation: true,
        enableTrainerBKOToast: true,
        enableTrainerBKOAnimation: true,
        enableTrainerBKO_OOC_Animation: true
      },
      trainerA: this.getDefaultTrainer('Trainer A'),
      trainerB: this.getDefaultTrainer('Trainer B'),
      stadium: { cardId: '', name: '', image: '', inPlay: false },
      featureCards: [],
      favoriteCardIds: [],
      matchScore: { trainerAWins: 0, trainerBWins: 0, bestOf: 3 },
      // Shown on the scoreboard, for example "Round 3" or "Top 8"
      matchInfo: { round: '' },
      // The game is paused (a judge call, a break): the overlay says so, and grays out the rest, until it is resumed
      paused: false
    };
  }

  getDefaultTrainer(name) {
    return {
      name,
      nationality: '',
      // the deck ("Charizard ex", "Lightning GLC") shown next to the name, and what to put a picture of next to it when that is not what the
      // deck says: an energy type or a Pokémon (empty is what the deck says, "none" is no picture); see public/js/deck.js
      deck: '',
      deckIcon: '',
      record: { wins: 0, losses: 0, ties: 0 },
      // penalty: how many prize cards the OTHER trainer counts as already taken (0 to 6); they are marked red on that trainer's side
      // (hidden: the prize cards are face down until the producer shows them, and so are the cards put on them)
      prizes: { count: MAX_PRIZES, hidden: true, penalty: 0, cards: emptyPrizeCards() },
      resources: {
        energyPerTurn: { available: 1, used: 0 },
        stadiumPerTurn: { available: 1, used: 0 },
        supporterPerTurn: { available: 1, used: 0 },
        // the GX attack and the VSTAR Power: one of each per game, back when the game ends
        gxPerGame: { available: 1, used: 0 },
        vstarPerGame: { available: 1, used: 0 }
      },
      locks: { itemLock: false, evoLock: false },
      isTurn: false,
      benchSize: DEFAULT_BENCH, // configurable 2-8
      active: emptyPokemon('active'),
      bench: Array.from({ length: MAX_BENCH }, (_, i) => emptyPokemon(i))
    };
  }

  mergeWithDefaults(saved) {
    const merged = this.deepMerge(this.getDefaultState(), saved);
    // Announcements used to be stored as state; they are one-shot events now
    for (const key of ['trainerAToast', 'trainerBToast', 'topDeckAnimation', 'attackAnimation',
      'passTurnAnimation', 'trainerAKOAnimation', 'trainerBKOAnimation', 'activeTheme']) {
      delete merged[key];
    }
    if (!Number.isInteger(merged.revision) || merged.revision < 0) merged.revision = 0;
    merged.paused = merged.paused === true;
    // A feature card used to carry a note for the casters; it does not any more
    for (const card of merged.featureCards || []) if (card && typeof card === 'object') delete card.note;
    // what is featured is cards, and the separators between them (see addFeatureSeparator): nothing else
    merged.featureCards = (Array.isArray(merged.featureCards) ? merged.featureCards : [])
      .filter((entry) => entry && typeof entry === 'object' && (entry.separator === undefined ? typeof entry.name === 'string' : GAME.FEATURE_SEPARATORS.some((one) => one.symbol === entry.separator)))
      .slice(-MAX_FEATURE_ENTRIES);
    // Before TCGdex the setting held the one service there was ('pokemontcg') and nothing could change it: it is automatic now
    if (!(saved.settings && 'cardLanguage' in saved.settings) || !GAME.CARD_SOURCES.some((source) => source.key === merged.settings.apiProvider)) merged.settings.apiProvider = 'auto';
    if (!GAME.CARD_LANGUAGES.some(([code]) => code === merged.settings.cardLanguage)) merged.settings.cardLanguage = 'en';
    if (!GAME.CARD_SERVICES.some((service) => service.key === merged.settings.librarySource)) merged.settings.librarySource = 'pokemontcg';
    for (const name of GAME.SECRET_SETTINGS) if (!GAME.isSecretValue(merged.settings[name])) merged.settings[name] = '';
    for (const side of ['trainerA', 'trainerB']) {
      // Pokémon saved before Special Energy, attacks and retreat costs existed hold none
      for (const pokemon of [merged[side].active, ...merged[side].bench]) {
        if (!pokemon) continue;
        if (!Array.isArray(pokemon.specialEnergies)) pokemon.specialEnergies = [];
        if (!Array.isArray(pokemon.attacks)) pokemon.attacks = [];
        if (!Number.isInteger(pokemon.retreat)) pokemon.retreat = 0;
        pokemon.tools = cleanTools(pokemon.tools);
        pokemon.stages = cleanStages(pokemon.stages);
        pokemon.status = GAME.cleanStatus(pokemon.status);
      }
      // The penalty used to be an on/off flag: it is a number of prize cards now
      const prizes = merged[side].prizes;
      if (typeof prizes.penalty === 'boolean') prizes.penalty = prizes.penalty ? 1 : 0;
      else if (!Number.isInteger(prizes.penalty)) prizes.penalty = 0;
      prizes.penalty = Math.max(0, Math.min(MAX_PRIZES, prizes.penalty));
      // and the cards of the prizes came later still
      prizes.cards = cleanPrizeCards(prizes.cards);
      // the deck came after the nationality
      for (const key of ['deck', 'deckIcon']) merged[side][key] = typeof merged[side][key] === 'string' ? merged[side][key].trim().slice(0, DECK.MAX_LENGTH) : '';
    }
    return merged;
  }

  deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  getState() {
    return this.state;
  }

  // -------------------------------------------------- snapshots and forking

  snapshot() {
    return structuredClone(this.state);
  }

  // Put an earlier snapshot back, keeping the revision counter moving forward
  restore(snapshot) {
    const revision = this.state.revision;
    this.state = structuredClone(snapshot);
    this.state.revision = revision;
  }

  // A detached copy for previewing changes: same logic, no timers, no database writes
  fork() {
    const copy = Object.create(GameStateService.prototype);
    copy.db = NOOP_DB;
    copy.pokemonTCG = this.pokemonTCG;
    copy.state = this.snapshot();
    copy.matchStartTime = this.matchStartTime;
    return copy;
  }

  // ---------------------------------------------------------------- trainers

  setName(side, name) {
    this.state[side].name = name;
  }

  setNationality(side, nationality) {
    this.state[side].nationality = nationality;
  }

  // The deck shown next to the name, and the picture box that can say what to put a picture of next to it
  setDeck(side, deck) {
    this.state[side].deck = deck;
  }

  setDeckIcon(side, icon) {
    this.state[side].deckIcon = icon;
  }

  // The trainer's tournament record, shown next to the name
  setRecord(side, { wins, losses, ties }) {
    this.state[side].record = { wins, losses, ties };
  }

  setRoundLabel(text) {
    this.state.matchInfo.round = text;
  }

  setTurn(side, isTurn) {
    this.state[side].isTurn = isTurn;
    this.state[otherSide(side)].isTurn = !isTurn;
  }

  adjustPrizes(side, delta) {
    const prizes = this.state[side].prizes;
    prizes.count = Math.max(0, Math.min(MAX_PRIZES, prizes.count + delta));
  }

  setPrizes(side, count) {
    this.state[side].prizes.count = Math.max(0, Math.min(MAX_PRIZES, count));
  }

  // Choose the cards that are the prizes: a list of up to six, one for each prize card, where null (or nothing) leaves a prize card without
  // a card. They show on the overlay on their prize cards, so which ones are taken is still the count.
  setPrizeCards(side, cards) {
    this.state[side].prizes.cards = cleanPrizeCards(cards);
  }

  // Hide the prize cards (the overlay shows them face down with a question mark); omit value to toggle
  setPrizesHidden(side, value) {
    const prizes = this.state[side].prizes;
    prizes.hidden = value === undefined ? !prizes.hidden : value;
  }

  // A player has won the game when they have taken every prize card they need. A penalty is a number of prize cards the OTHER player
  // counts as already taken, so the cards a player still has are enough when they are no more than the opponent's penalty.
  isWinning(side) {
    return this.state[side].prizes.count <= this.state[otherSide(side)].prizes.penalty;
  }

  // The penalty of a player (what they did wrong, in prize cards): that many of the opponent's prize cards are marked red
  setPrizePenalty(side, count) {
    this.state[side].prizes.penalty = Math.max(0, Math.min(MAX_PRIZES, Math.trunc(count)));
  }

  adjustPrizePenalty(side, delta) {
    this.setPrizePenalty(side, this.state[side].prizes.penalty + delta);
  }

  // lock is 'itemLock' or 'evoLock'; omit value to toggle
  setLock(side, lock, value) {
    const locks = this.state[side].locks;
    locks[lock] = value === undefined ? !locks[lock] : value;
  }

  // kind is 'energyPerTurn', 'stadiumPerTurn' or 'supporterPerTurn'; "used" moves within 0..available
  stepCounter(side, kind, delta) {
    const counter = this.state[side].resources[kind];
    counter.used = Math.max(0, Math.min(counter.available, counter.used + delta));
  }

  resetCounter(side, kind) {
    this.state[side].resources[kind].used = 0;
  }

  // Who has the turn ('trainerA' or 'trainerB'), or null before anybody does
  turnHolder() {
    return this.state.trainerA.isTurn ? 'trainerA' : this.state.trainerB.isTurn ? 'trainerB' : null;
  }

  // A Stadium has been played: it uses the Stadium play of the turn of the trainer who played it. Gives back the trainer it was used for,
  // or null when there is nobody to use it for, or that trainer had used it already.
  useStadiumPlay(side) {
    if (side !== 'trainerA' && side !== 'trainerB') return null;
    const counter = this.state[side].resources.stadiumPerTurn;
    if (counter.used >= counter.available) return null;
    counter.used += 1;
    return side;
  }

  // slot -1 is the active Pokémon, 0.. are bench slots
  pokemonAt(side, slot) {
    const trainer = this.state[side];
    if (slot === -1) return trainer.active;
    return trainer.bench[slot] || null;
  }

  // Positive amounts are damage, negative amounts heal. HP never leaves 0..max (when max is known)
  damage(side, slot, amount) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon) return;
    const { max, current } = pokemon.hp;
    const next = Math.max(0, current - amount);
    pokemon.hp.current = max > 0 ? Math.min(max, next) : next;
  }

  healFull(side, slot) {
    const pokemon = this.pokemonAt(side, slot);
    if (pokemon) pokemon.hp.current = pokemon.hp.max;
  }

  setHP(side, slot, current) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon) return;
    const { max } = pokemon.hp;
    pokemon.hp.current = Math.max(0, max > 0 ? Math.min(max, current) : current);
  }

  // The maximum HP. By default the current HP only comes down when it is over the new maximum; with `keepDamage` the damage taken stays what it
  // is (a Pokémon with 10 more maximum HP has 10 more HP).
  setMaxHP(side, slot, max, { keepDamage = false } = {}) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon) return;
    const before = pokemon.hp.max;
    pokemon.hp.max = Math.max(0, max);
    pokemon.hp.current = keepDamage ? Math.max(0, Math.min(pokemon.hp.max, pokemon.hp.current + (pokemon.hp.max - before))) : Math.min(pokemon.hp.current, pokemon.hp.max);
  }

  // Put a card into a slot. A fresh Pokémon starts at full HP with nothing attached;
  // an evolution (keep: true) keeps its attachments and the damage already taken, and remembers the card it was (so it can go back:
  // see devolve). `back` is that going back: it does not remember anything.
  setPokemon(side, slot, { cardId, name, image, hp, abilities, attacks, retreat }, { keep = false, back = false } = {}) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon) return;

    // What the tools add to the maximum HP stays with the Pokémon while it evolves, so the card's own HP is what is left
    const toolBonus = keep ? cleanTools(pokemon.tools).reduce((sum, tool) => sum + tool.hp, 0) : 0;
    const newMax = (Number.isFinite(hp) && hp > 0 ? hp : 0) + (Number.isFinite(hp) && hp > 0 ? toolBonus : 0);
    const damageTaken = Math.max(0, pokemon.hp.max - pokemon.hp.current);

    if (keep && !back && (pokemon.cardId || pokemon.name)) {
      const own = Math.max(0, pokemon.hp.max - cleanTools(pokemon.tools).reduce((sum, tool) => sum + tool.hp, 0));
      pokemon.stages = cleanStages([...(pokemon.stages || []), {
        cardId: pokemon.cardId, name: pokemon.name, image: pokemon.image, hp: own,
        abilities: (pokemon.abilities || []).map((ability) => ability.name), attacks: pokemon.attacks, retreat: pokemon.retreat
      }]);
    } else if (!keep) {
      pokemon.stages = [];
    }

    Object.assign(pokemon, { cardId, name, image });
    // A different card, an evolution too, has no special conditions (the rules cure them when a Pokémon evolves)
    pokemon.status = [];
    if (!keep) {
      pokemon.energies = [];
      pokemon.specialEnergies = [];
      pokemon.tools = [];
    }
    // A different card has different abilities; with no data an evolution keeps the tokens it had
    if (Array.isArray(abilities)) {
      pokemon.abilities = abilities.slice(0, MAX_ABILITIES).map((abilityName) => ({ name: abilityName, used: false, scope: 'turn' }));
    } else if (!keep) {
      pokemon.abilities = [];
    }
    // Attacks and the retreat cost belong to the card, so a different card (an evolution too) has its own
    pokemon.attacks = Array.isArray(attacks) ? attacks.slice(0, MAX_ATTACKS) : [];
    pokemon.retreat = Number.isInteger(retreat) ? Math.max(0, Math.min(MAX_RETREAT, retreat)) : 0;
    pokemon.hp.max = newMax;
    pokemon.hp.current = keep ? Math.max(0, newMax - damageTaken) : newMax;
  }

  // Go back to the card this Pokémon was before it evolved: it keeps what is attached to it and the damage it has taken. False when
  // it never evolved here (there is no earlier card on file).
  devolve(side, slot) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon || !Array.isArray(pokemon.stages) || pokemon.stages.length === 0) return false;
    const stage = pokemon.stages[pokemon.stages.length - 1];
    const rest = pokemon.stages.slice(0, -1);
    this.setPokemon(side, slot, stage, { keep: true, back: true });
    pokemon.stages = rest;
    return true;
  }

  // A Pokémon Tool on a Pokémon (any slot). `tool.hp` is what it adds to the maximum HP: the Pokémon has that much more HP while it is there.
  // False when it already holds as many as it may.
  attachTool(side, slot, tool) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon || !(pokemon.cardId || pokemon.name)) return false;
    const [clean] = cleanTools([tool]);
    if (!clean) return false;
    pokemon.tools = cleanTools(pokemon.tools);
    if (pokemon.tools.length >= MAX_TOOLS) return false;
    pokemon.tools.push(clean);
    pokemon.hp.max += clean.hp;
    pokemon.hp.current += clean.hp;
    return true;
  }

  // Take a tool off: what it added to the maximum HP goes with it (the damage counters stay)
  removeTool(side, slot, index) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon || !Array.isArray(pokemon.tools) || index < 0 || index >= pokemon.tools.length) return;
    const [tool] = pokemon.tools.splice(index, 1);
    const bonus = Number(tool.hp) || 0;
    pokemon.hp.max = Math.max(0, pokemon.hp.max - bonus);
    pokemon.hp.current = Math.max(0, Math.min(pokemon.hp.max, pokemon.hp.current - bonus));
  }

  // Move damage from one Pokémon to another (an effect that moves damage counters): the first is healed by as much as the second is damaged.
  // `from` and `to` are { side, slot }; it never moves more than the first has taken. Returns how much it moved.
  moveDamage(from, to, amount) {
    const source = this.pokemonAt(from.side, from.slot);
    const target = this.pokemonAt(to.side, to.slot);
    if (!source || !target) return 0;
    const moved = Math.max(0, Math.min(amount, source.hp.max - source.hp.current));
    source.hp.current += moved;
    target.hp.current = Math.max(0, target.hp.current - moved);
    return moved;
  }

  // Has this trainer any Pokémon on the table?
  hasPokemon(side) {
    const trainer = this.state[side];
    const there = (pokemon) => Boolean(pokemon && (pokemon.cardId || pokemon.name));
    return there(trainer.active) || trainer.bench.slice(0, trainer.benchSize).some(there);
  }

  // The attacks and the retreat cost of the card found after the Pokémon was put there
  fillPokemonDetails(side, slot, { attacks, retreat }) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon) return;
    pokemon.attacks = Array.isArray(attacks) ? attacks.slice(0, MAX_ATTACKS) : pokemon.attacks;
    if (Number.isInteger(retreat)) pokemon.retreat = Math.max(0, Math.min(MAX_RETREAT, retreat));
  }

  // Change how many Energy it costs to retreat (an effect can make it cheaper or dearer)
  setRetreat(side, slot, cost) {
    const pokemon = this.pokemonAt(side, slot);
    if (pokemon) pokemon.retreat = Math.max(0, Math.min(MAX_RETREAT, Math.trunc(cost)));
  }

  // Attach one energy of the given type. Whether it also counts as the turn's energy attachment
  // is decided by the caller (a "special" attachment from an ability or an effect does not).
  attachEnergy(side, slot, type) {
    const pokemon = this.pokemonAt(side, slot);
    if (pokemon && pokemon.energies.length < MAX_ENERGIES_PER_POKEMON) pokemon.energies.push(type);
  }

  removeEnergy(side, slot, index) {
    const pokemon = this.pokemonAt(side, slot);
    if (pokemon && index >= 0 && index < pokemon.energies.length) pokemon.energies.splice(index, 1);
  }

  // Attach a Special Energy card ({ cardId, name, image }). Returns false when the Pokémon holds as many as it may.
  attachSpecialEnergy(side, slot, card) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon) return false;
    if (!Array.isArray(pokemon.specialEnergies)) pokemon.specialEnergies = []; // a save from before they existed
    if (pokemon.specialEnergies.length >= MAX_SPECIAL_ENERGIES) return false;
    pokemon.specialEnergies.push({ cardId: card.cardId, name: card.name, image: card.image });
    return true;
  }

  removeSpecialEnergy(side, slot, index) {
    const pokemon = this.pokemonAt(side, slot);
    if (pokemon && Array.isArray(pokemon.specialEnergies) && index >= 0 && index < pokemon.specialEnergies.length) pokemon.specialEnergies.splice(index, 1);
  }

  // A special condition of the Active Pokémon; omit `on` to toggle. Putting on Asleep, Confused or Paralyzed takes
  // off whichever of the three it had (see GAME.cleanStatus). Returns the conditions it has now.
  setStatus(side, condition, on) {
    const pokemon = this.state[side].active;
    if (!GAME.STATUS_KEYS.includes(condition)) return pokemon.status;
    const rest = pokemon.status.filter((key) => key !== condition);
    const wanted = on === undefined ? !pokemon.status.includes(condition) : on;
    pokemon.status = GAME.cleanStatus(wanted ? [...rest, condition] : rest);
    return pokemon.status;
  }

  // Cure the Active Pokémon of everything
  clearStatus(side) {
    this.state[side].active.status = [];
  }

  setAbilityUsed(side, slot, index, used) {
    const pokemon = this.pokemonAt(side, slot);
    if (pokemon && pokemon.abilities[index]) pokemon.abilities[index].used = used;
  }

  // A custom token for something the card data does not list (or an effect that grants an ability)
  addAbility(side, slot, name, scope = 'turn') {
    const pokemon = this.pokemonAt(side, slot);
    if (pokemon && pokemon.abilities.length < MAX_ABILITIES) pokemon.abilities.push({ name, used: false, scope });
  }

  removeAbility(side, slot, index) {
    const pokemon = this.pokemonAt(side, slot);
    if (pokemon && index >= 0 && index < pokemon.abilities.length) pokemon.abilities.splice(index, 1);
  }

  // Make a trainer's ability tokens ready again. Per-game tokens are only touched when asked.
  resetAbilities(side, { includeGame = false } = {}) {
    const trainer = this.state[side];
    for (const pokemon of [trainer.active, ...trainer.bench]) {
      for (const ability of pokemon.abilities) {
        if (includeGame || ability.scope !== 'game') ability.used = false;
      }
    }
  }

  // Switch the active Pokémon with a benched one: each keeps its own HP and attachments
  swapWithActive(side, slot) {
    const trainer = this.state[side];
    const benched = trainer.bench[slot];
    if (!benched) return;
    const active = trainer.active;
    active.status = []; // special conditions end when a Pokémon leaves the Active spot
    active.slot = slot;
    benched.slot = 'active';
    trainer.active = benched;
    trainer.bench[slot] = active;
  }

  // Move the Pokémon in one slot to another (-1 is the Active spot, 0 and up the bench). When there is a Pokémon in the other slot they
  // change places; each keeps its own HP and attachments. A special condition ends when a Pokémon leaves the Active spot.
  moveSlot(side, from, to) {
    const trainer = this.state[side];
    const at = (slot) => (slot === -1 ? trainer.active : trainer.bench[slot]);
    const moving = at(from);
    const other = at(to);
    if (!moving || !other || from === to) return;
    const place = (slot, pokemon) => {
      pokemon.slot = slot === -1 ? 'active' : slot;
      if (slot === -1) trainer.active = pokemon;
      else trainer.bench[slot] = pokemon;
    };
    if (from === -1) moving.status = [];
    if (to === -1) other.status = [];
    place(to, moving);
    place(from, other);
  }

  // A Pokémon is knocked out: it leaves play and the opponent takes prize cards
  knockOut(side, slot, { prizesTaken = 1, clear = true } = {}) {
    if (clear) this.clearSlot(side, slot);
    this.adjustPrizes(otherSide(side), -prizesTaken);
  }

  clearSlot(side, slot) {
    const trainer = this.state[side];
    if (slot === -1) {
      trainer.active = emptyPokemon('active');
    } else if (slot >= 0 && slot < trainer.bench.length) {
      trainer.bench[slot] = emptyPokemon(slot);
    }
  }

  adjustBenchSize(side, delta) {
    this.setBenchSize(side, this.state[side].benchSize + delta);
  }

  // The bench has this many slots (2 to 8); the Pokémon in the slots that go are gone with them
  setBenchSize(side, wanted) {
    const trainer = this.state[side];
    const size = Math.max(MIN_BENCH, Math.min(MAX_BENCH, wanted));
    if (size === trainer.benchSize) return;
    trainer.benchSize = size;
    while (trainer.bench.length < size) trainer.bench.push(emptyPokemon(trainer.bench.length));
    if (trainer.bench.length > size) trainer.bench = trainer.bench.slice(0, size);
  }

  // Back to the usual bench of 5 (what a Stadium such as Area Zero Underdepths made bigger is over)
  resetBenchSize(side) {
    this.setBenchSize(side, DEFAULT_BENCH);
  }

  // ------------------------------------------------------------------- match

  // A game is over (won, or a new one begins): the once-per-game markers are available again
  resetGameMarkers() {
    for (const side of ['trainerA', 'trainerB']) {
      for (const kind of ['gxPerGame', 'vstarPerGame']) this.resetCounter(side, kind);
    }
  }

  startGame() {
    this.matchStartTime = Date.now();
    for (const side of ['trainerA', 'trainerB']) {
      this.state[side].prizes.count = MAX_PRIZES;
      this.state[side].prizes.penalty = 0;
      this.state[side].prizes.cards = emptyPrizeCards();
      this.state[side].prizes.hidden = true; // new prizes are face down again
    }
    this.resetGameMarkers();
    this.state.matchScore = { trainerAWins: 0, trainerBWins: 0, bestOf: this.state.matchScore.bestOf };
    this.resetAbilities('trainerA', { includeGame: true });
    this.resetAbilities('trainerB', { includeGame: true });
  }

  endGame(winner) {
    const { trainerA, trainerB, matchScore } = this.state;
    this.db.saveMatch({
      playerName: trainerA.name,
      opponentName: trainerB.name,
      playerWins: matchScore.trainerAWins,
      opponentWins: matchScore.trainerBWins,
      bestOf: matchScore.bestOf,
      winner,
      startedAt: this.matchStartTime,
      endedAt: Date.now(),
      state: { ...this.state }
    });
  }

  // Pass the turn: A -> B -> A. If nobody has the turn yet, trainer A starts.
  toggleTurn() {
    const { trainerA, trainerB } = this.state;
    const starting = trainerA.isTurn ? trainerB : trainerA;
    trainerA.isTurn = starting === trainerA;
    trainerB.isTurn = starting === trainerB;
    // A new turn: the energy attachment, stadium play, supporter play and once-per-turn abilities are available again
    for (const kind of ['energyPerTurn', 'stadiumPerTurn', 'supporterPerTurn']) {
      starting.resources[kind].used = 0;
    }
    this.resetAbilities(starting === trainerA ? 'trainerA' : 'trainerB');
  }

  matchWin(side) {
    const score = this.state.matchScore;
    const key = `${side}Wins`;
    score[key]++;
    this.resetGameMarkers(); // that game is over
    if (score[key] > score.bestOf / 2) this.endGame(side);
  }

  matchWinMinus(side) {
    const score = this.state.matchScore;
    const key = `${side}Wins`;
    score[key] = Math.max(0, score[key] - 1);
  }

  resetMatchScore() {
    this.state.matchScore = { trainerAWins: 0, trainerBWins: 0, bestOf: this.state.matchScore.bestOf };
    this.resetGameMarkers();
  }

  // The next game of the same match: prize cards and penalties start again (with new cards for the prizes, which nobody has chosen yet) and
  // the once-per-game markers and abilities come back. The score, the names and what is on the table stay.
  nextGame() {
    for (const side of ['trainerA', 'trainerB']) {
      this.state[side].prizes.count = MAX_PRIZES;
      this.state[side].prizes.penalty = 0;
      this.state[side].prizes.cards = emptyPrizeCards();
      this.state[side].prizes.hidden = true;
      this.resetAbilities(side, { includeGame: true });
    }
    this.resetGameMarkers();
  }

  // Pause the game, or resume it; omit `paused` to toggle. Returns whether it is paused now.
  setPaused(paused) {
    this.state.paused = paused === undefined ? !this.state.paused : Boolean(paused);
    return this.state.paused;
  }

  setBestOf(bestOf) {
    this.state.matchScore.bestOf = bestOf;
  }

  // ------------------------------------------------------------------- cards

  // target: 'trainerA-active', 'trainerB-bench-2' or 'stadium'. `card` is already resolved card data.
  selectCard(target, card, { keep = false, back = false } = {}) {
    const image = this.pokemonTCG.selectBestImageUrl(card, 'large');
    const hp = parseInt(card.hp, 10);

    if (target === 'stadium') {
      this.state.stadium = { cardId: card.id, name: card.name, image, inPlay: true };
      return;
    }

    const match = /^(trainer[AB])-(active|bench-(\d+))$/.exec(target);
    if (!match) throw new Error(`Invalid card target: ${target}`);
    const [, side, where, benchIndex] = match;
    const slot = where === 'active' ? -1 : Number(benchIndex);
    this.setPokemon(side, slot, { cardId: card.id, name: card.name, image, hp, abilities: card.abilities, attacks: card.attacks, retreat: card.retreat }, { keep, back });
  }

  setStadium(cardId, name, image) {
    this.state.stadium = { cardId, name, image, inPlay: Boolean(cardId || name || image) };
  }

  toggleFavorite(cardId) {
    const favorites = this.state.favoriteCardIds;
    if (favorites.includes(cardId)) {
      this.state.favoriteCardIds = favorites.filter((id) => id !== cardId);
      this.db.removeFavorite(cardId);
    } else if (favorites.length < MAX_FAVORITES) {
      favorites.push(cardId);
      this.db.addFavorite(cardId);
    }
  }

  // The featured cards are in the order they were added, the way they are read: the overlay shows the last ones. The oldest go when there are too many.
  addFeatureCard({ cardId, name, image }) {
    this.state.featureCards.push({ id: randomUUID(), cardId, name, image, addedAt: Date.now() });
    while (this.state.featureCards.length > MAX_FEATURE_ENTRIES) this.state.featureCards.shift();
  }

  // A sign between two feature cards ("+", "→", "=" or "or") that says how they go together. It goes at the end unless `at` says where.
  addFeatureSeparator(symbol, at) {
    if (!GAME.FEATURE_SEPARATORS.some((one) => one.symbol === symbol)) return;
    const entry = { id: randomUUID(), separator: symbol, addedAt: Date.now() };
    const list = this.state.featureCards;
    if (Number.isInteger(at)) list.splice(Math.max(0, Math.min(list.length, at)), 0, entry);
    else list.push(entry);
    while (list.length > MAX_FEATURE_ENTRIES) list.shift();
  }

  // Put a feature card (or a sign) at another place in the row: `to` is the place it ends up in. False when there is no such entry.
  moveFeature(id, to) {
    const list = this.state.featureCards;
    const from = list.findIndex((entry) => entry.id === id);
    if (from < 0) return false;
    const [entry] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, entry);
    return true;
  }

  // Remove by id (stable even if another producer changed the list) or, for older clients, by index
  removeFeatureCard({ id, index }) {
    const cards = this.state.featureCards;
    const at = id !== undefined ? cards.findIndex((card) => card.id === id) : index;
    if (at >= 0 && at < cards.length) cards.splice(at, 1);
  }

  clearFeatureCards() {
    this.state.featureCards = [];
  }

  // ---------------------------------------------------------------- settings

  // Only known settings with a value of the right type are accepted
  updateSettings(patch) {
    const defaults = this.getDefaultState().settings;
    for (const [key, value] of Object.entries(patch || {})) {
      if (key === 'display') {
        // Individual overlay switches: merge, ignoring unknown keys and non-booleans
        for (const [option, shown] of Object.entries(value || {})) {
          if (DISPLAY.KEYS.includes(option) && typeof shown === 'boolean') {
            this.state.settings.display[option] = shown;
          }
        }
      } else if (GAME.SECRET_SETTINGS.includes(key)) {
        // a key is kept as it was pasted, without the spaces around it; one that cannot go in a header is not kept
        if (typeof value === 'string' && GAME.isSecretValue(value.trim())) this.state.settings[key] = value.trim();
      } else if (key === 'librarySource') {
        if (GAME.CARD_SERVICES.some((service) => service.key === value)) this.state.settings.librarySource = value;
      } else if (key === 'apiProvider') {
        if (GAME.CARD_SOURCES.some((source) => source.key === value)) this.state.settings.apiProvider = value;
      } else if (key === 'cardLanguage') {
        if (GAME.CARD_LANGUAGES.some(([code]) => code === value)) this.state.settings.cardLanguage = value;
      } else if (key === 'sound') {
        this.mergeSound(value);
      } else if ((key === 'toastSeconds' || key === 'animationSeconds') && Number.isFinite(value)) {
        // keep announcements on screen for a sensible, bounded time
        this.state.settings[key] = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(value * 10) / 10));
      } else if (Object.hasOwn(defaults, key) && typeof value === typeof defaults[key]) {
        this.state.settings[key] = value;
      }
    }
  }

  // Merge a (possibly partial) sound settings change, ignoring anything unknown or out of range
  mergeSound(patch) {
    if (!patch || typeof patch !== 'object') return;
    const sound = this.state.settings.sound;
    const volume = (value) => Math.min(100, Math.max(0, Math.round(value)));

    if (typeof patch.enabled === 'boolean') sound.enabled = patch.enabled;
    if (Number.isFinite(patch.volume)) sound.volume = volume(patch.volume);

    for (const [cue, change] of Object.entries(patch.events || {})) {
      if (!SOUND.KEYS.includes(cue) || !change || typeof change !== 'object') continue;
      if (typeof change.enabled === 'boolean') sound.events[cue].enabled = change.enabled;
      if (Number.isFinite(change.volume)) sound.events[cue].volume = volume(change.volume);
    }
  }

  // Replace everything with a saved configuration (the revision keeps counting up)
  importState(config) {
    const revision = this.state.revision;
    // the keys are this computer's own: a file (which never holds them) cannot take them away or give others
    const keys = Object.fromEntries(GAME.SECRET_SETTINGS.map((name) => [name, this.state.settings[name]]));
    this.state = this.mergeWithDefaults(config);
    Object.assign(this.state.settings, keys);
    this.state.revision = revision;
  }

  fullReset() {
    const revision = this.state.revision;
    this.state = this.getDefaultState();
    this.state.revision = revision;
  }

  // ------------------------------------------------------------- persistence

  autosave() {
    this.db.saveGameState(this.state);
  }

  destroy() {
    clearInterval(this.autosaveInterval);
    this.autosave();
  }
}

module.exports = GameStateService;
