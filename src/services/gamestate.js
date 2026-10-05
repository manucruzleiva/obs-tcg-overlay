/**
 * GameState Service - the single source of truth for a match.
 *
 * Every mutation is a plain synchronous method, so the same code runs on the live
 * state and on a throwaway copy (see fork()) used to preview a producer's draft.
 */

const { randomUUID } = require('crypto');
const DISPLAY = require('../../public/js/display-options');
const SOUND = require('../../public/js/sound-options');

const MAX_ENERGIES_PER_POKEMON = 20;
const MAX_ABILITIES = 4;
const MIN_SECONDS = 1;
const MAX_SECONDS = 30;

const MAX_PRIZES = 6;
const MIN_BENCH = 2;
const MAX_BENCH = 8;
const MAX_FEATURE_CARDS = 10;
const MAX_FAVORITES = 50;

// Used by forked copies so a draft preview never writes to the database
const NOOP_DB = {
  saveMatch() {},
  addFavorite() {},
  removeFavorite() {},
  saveGameState() {}
};

const otherSide = (side) => (side === 'trainerA' ? 'trainerB' : 'trainerA');

const emptyPokemon = (slot) => ({
  slot,
  cardId: '',
  name: '',
  image: '',
  hp: { max: 0, current: 0 },
  energies: [],
  tools: [],
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
        apiProvider: 'pokemontcg',
        apiKey: '',
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
      matchInfo: { round: '' }
    };
  }

  getDefaultTrainer(name) {
    return {
      name,
      nationality: '',
      record: { wins: 0, losses: 0, ties: 0 },
      // penalty: how many prize cards are marked red (0 to 6)
      prizes: { count: MAX_PRIZES, hidden: false, penalty: 0 },
      resources: {
        energyPerTurn: { available: 1, used: 0 },
        stadiumPerTurn: { available: 1, used: 0 },
        supporterPerTurn: { available: 1, used: 0 }
      },
      locks: { itemLock: false, evoLock: false },
      isTurn: false,
      benchSize: 5, // configurable 2-8
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
    // The penalty used to be an on/off flag: it is a number of prize cards now
    for (const side of ['trainerA', 'trainerB']) {
      const prizes = merged[side].prizes;
      if (typeof prizes.penalty === 'boolean') prizes.penalty = prizes.penalty ? 1 : 0;
      else if (!Number.isInteger(prizes.penalty)) prizes.penalty = 0;
      prizes.penalty = Math.max(0, Math.min(MAX_PRIZES, prizes.penalty));
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

  // Hide the prize cards (the overlay shows them face down with a question mark); omit value to toggle
  setPrizesHidden(side, value) {
    const prizes = this.state[side].prizes;
    prizes.hidden = value === undefined ? !prizes.hidden : value;
  }

  // How many prize cards are marked red as a penalty
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

  setMaxHP(side, slot, max) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon) return;
    pokemon.hp.max = Math.max(0, max);
    pokemon.hp.current = Math.min(pokemon.hp.current, pokemon.hp.max);
  }

  // Put a card into a slot. A fresh Pokémon starts at full HP with nothing attached;
  // an evolution (keep: true) keeps its attachments and the damage already taken.
  setPokemon(side, slot, { cardId, name, image, hp, abilities }, { keep = false } = {}) {
    const pokemon = this.pokemonAt(side, slot);
    if (!pokemon) return;

    const newMax = Number.isFinite(hp) && hp > 0 ? hp : 0;
    const damageTaken = Math.max(0, pokemon.hp.max - pokemon.hp.current);

    Object.assign(pokemon, { cardId, name, image });
    if (!keep) {
      pokemon.energies = [];
      pokemon.tools = [];
      pokemon.status = [];
    }
    // A different card has different abilities; with no data an evolution keeps the tokens it had
    if (Array.isArray(abilities)) {
      pokemon.abilities = abilities.slice(0, MAX_ABILITIES).map((abilityName) => ({ name: abilityName, used: false, scope: 'turn' }));
    } else if (!keep) {
      pokemon.abilities = [];
    }
    pokemon.hp.max = newMax;
    pokemon.hp.current = keep ? Math.max(0, newMax - damageTaken) : newMax;
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
    active.slot = slot;
    benched.slot = 'active';
    trainer.active = benched;
    trainer.bench[slot] = active;
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
    const trainer = this.state[side];
    const size = Math.max(MIN_BENCH, Math.min(MAX_BENCH, trainer.benchSize + delta));
    if (size === trainer.benchSize) return;
    trainer.benchSize = size;
    while (trainer.bench.length < size) trainer.bench.push(emptyPokemon(trainer.bench.length));
    if (trainer.bench.length > size) trainer.bench = trainer.bench.slice(0, size);
  }

  // ------------------------------------------------------------------- match

  startGame() {
    this.matchStartTime = Date.now();
    for (const side of ['trainerA', 'trainerB']) {
      this.state[side].prizes.count = MAX_PRIZES;
      this.state[side].prizes.penalty = 0;
    }
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
    if (score[key] > score.bestOf / 2) this.endGame(side);
  }

  matchWinMinus(side) {
    const score = this.state.matchScore;
    const key = `${side}Wins`;
    score[key] = Math.max(0, score[key] - 1);
  }

  resetMatchScore() {
    this.state.matchScore = { trainerAWins: 0, trainerBWins: 0, bestOf: this.state.matchScore.bestOf };
  }

  setBestOf(bestOf) {
    this.state.matchScore.bestOf = bestOf;
  }

  // ------------------------------------------------------------------- cards

  // target: 'trainerA-active', 'trainerB-bench-2' or 'stadium'. `card` is already resolved card data.
  selectCard(target, card, { keep = false } = {}) {
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
    this.setPokemon(side, slot, { cardId: card.id, name: card.name, image, hp, abilities: card.abilities }, { keep });
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

  addFeatureCard({ cardId, name, image, note }) {
    this.state.featureCards.unshift({ id: randomUUID(), cardId, name, image, note, addedAt: Date.now() });
    if (this.state.featureCards.length > MAX_FEATURE_CARDS) this.state.featureCards.pop();
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
    this.state = this.mergeWithDefaults(config);
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
