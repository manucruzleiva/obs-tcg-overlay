/**
 * The health check of the card data.
 *
 * A Pokémon that comes to the table without its attacks or its retreat cost comes from a card record that never had them: a library built
 * from a list that does not carry them (the card services send a short card when they list, and the long one when one card is asked for), a
 * lookup saved by an older version, or a card service that did not answer when the Pokémon was put in play. This module finds those cards and
 * mends them:
 *
 *   - the libraries on this computer (Standard, Gym Leader Challenge, Expanded): each Pokémon is checked, and the ones that lack their data are asked
 *     of the card service one by one and written back into the library (a few hundred each time: they are asked for politely)
 *   - the lookup cache (single cards the app has asked for before): a card that lacks its data is forgotten, so the next lookup asks again
 *   - the Pokémon on the table: the ones with no attacks, abilities or retreat cost on file are asked for again and filled in
 *
 * `problemsOf` says what is wrong with a card record; it is also what the card lookup uses to know it has to ask the card service.
 */

const { EventEmitter } = require('node:events');

const POKEMON = 'Pokémon';

// What can be wrong with a card, in words (the key is what the page and the tests read)
const PROBLEMS = {
  noAttackData: 'its attacks were never looked up',
  noRetreatData: 'its retreat cost was never looked up',
  emptyCard: 'a Pokémon with no attacks and no abilities (they were not looked up, or the card service did not send them)',
  noHp: 'it has no HP',
  noPicture: 'it has no picture'
};

// What a repair asks of one card service at a time, in cards, and how long it waits between two requests
const REPAIR_LIMIT = 400;
const PACE_MS = 150;
const SAMPLES = 5;

const isPokemon = (card) => Boolean(card) && (card.supertype === POKEMON || (!card.supertype && Boolean(card.hp)));

// What is wrong with a card as it is kept: [] when nothing is. Only a Pokémon has attacks, a retreat cost and HP to lack.
// (`detailed` is put on a library record once its card was asked for: a card that has none really has none)
function problemsOf(card) {
  if (!card || typeof card !== 'object') return ['noPicture'];
  const found = [];
  const images = card.images && typeof card.images === 'object' ? card.images : {};
  if (!images.small && !images.large) found.push('noPicture');
  if (!isPokemon(card)) return found;
  if (!card.hp) found.push('noHp');
  const hasAttacks = Array.isArray(card.attacks);
  if (!hasAttacks) found.push('noAttackData');
  if (!Number.isInteger(card.retreat)) found.push('noRetreatData');
  const abilities = Array.isArray(card.abilities) ? card.abilities : [];
  if (hasAttacks && card.attacks.length === 0 && abilities.length === 0 && card.detailed !== true) found.push('emptyCard');
  return found;
}

// Does the card lookup have to ask a card service for what this card says it can do?
const lacksDetails = (card) => problemsOf(card).some((problem) => ['noAttackData', 'noRetreatData', 'emptyCard'].includes(problem));

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

class CardHealth extends EventEmitter {
  // `db`, `catalog` (the libraries) and `pokemonTCG` (the card lookup) are the services of the same names; `readState()` gives the game, and
  // `healInPlay(side, slot)` asks again for the details of a Pokémon on the table and fills them in
  constructor({ db, catalog, pokemonTCG, readState = () => null, healInPlay = async () => false, paceMs = PACE_MS, limit = REPAIR_LIMIT, log = () => {} }) {
    super();
    this.db = db;
    this.catalog = catalog;
    this.pokemonTCG = pokemonTCG;
    this.readState = readState;
    this.healInPlay = healInPlay;
    this.paceMs = paceMs;
    this.limit = limit;
    this.log = log;
    this.report = null; // the last check
    this.job = null; // the repair that is running, or the last one that ended
    this.stopped = false;
    this.serial = 0;
  }

  // ---- the check

  // Count the problems of a list of cards: { cards, pokemon, flagged, repairable, problems: { key: count }, samples: [{ id, name, problems }] }
  // (`repairable` are the Pokémon whose card can be asked for again)
  static summarize(cards) {
    const result = { cards: 0, pokemon: 0, flagged: 0, repairable: 0, problems: {}, samples: [] };
    for (const card of cards) {
      result.cards++;
      if (isPokemon(card)) result.pokemon++;
      const found = problemsOf(card);
      if (found.length === 0) continue;
      result.flagged++;
      if (isPokemon(card) && lacksDetails(card)) result.repairable++;
      for (const key of found) result.problems[key] = (result.problems[key] || 0) + 1;
      if (result.samples.length < SAMPLES) result.samples.push({ id: card.id || '', name: card.name || '', problems: found });
    }
    return result;
  }

  // Look at everything: the libraries, the lookup cache and the Pokémon on the table. Nothing is changed.
  scan() {
    const libraries = this.catalog.libraryIds().map((id) => {
      let cards = [];
      try { cards = this.catalog.readLibrary(id); } catch (error) { this.log('warn', 'A library could not be read for the health check', { id, error: error.message }); }
      return { id, label: this.catalog.labelOf(id), ...CardHealth.summarize(cards) };
    });

    const lookup = CardHealth.summarize(this.db.cachedCardRows().map((row) => ({ ...row.data, id: row.id })));

    const inPlay = this.pokemonInPlay().map(({ side, slot, name, cardId }) => ({ side, slot, name, cardId }));

    this.serial++;
    this.report = {
      scannedAt: Date.now(),
      libraries,
      lookup,
      inPlay,
      flagged: libraries.reduce((sum, library) => sum + library.flagged, 0) + lookup.flagged + inPlay.length
    };
    this.emit('progress', this.status());
    return this.report;
  }

  // The Pokémon on the table that have no attacks, no abilities and no retreat cost on file (and a card to ask for)
  pokemonInPlay() {
    const state = this.readState();
    const found = [];
    if (!state) return found;
    for (const side of ['trainerA', 'trainerB']) {
      const trainer = state[side];
      if (!trainer) continue;
      [trainer.active, ...(trainer.bench || [])].forEach((pokemon, index) => {
        if (!pokemon || !pokemon.cardId) return;
        const empty = (!pokemon.attacks || pokemon.attacks.length === 0) && (!pokemon.abilities || pokemon.abilities.length === 0) && !pokemon.retreat;
        if (empty) found.push({ side, slot: index === 0 ? -1 : index - 1, name: pokemon.name, cardId: pokemon.cardId });
      });
    }
    return found;
  }

  // ---- the repair

  status() {
    return { serial: this.serial, report: this.report, job: this.job ? { ...this.job } : null };
  }

  running() {
    return Boolean(this.job && !this.job.finished);
  }

  cancel() {
    if (!this.running()) return false;
    this.stopped = true;
    return true;
  }

  progress(patch) {
    this.job = { ...this.job, ...patch };
    this.serial++;
    this.emit('progress', this.status());
  }

  // Mend what the check found, in the background. Returns the job at once; its progress is emitted ('progress') as it goes.
  repair() {
    if (this.running()) return { ...this.job };
    if (this.catalog.running('library')) {
      const error = new Error('Wait for the card library to finish downloading, then try again.');
      error.status = 409;
      throw error;
    }
    this.stopped = false;
    this.job = { id: (this.job ? this.job.id : 0) + 1, finished: false, phase: 'starting', message: 'Looking at the cards…', done: 0, total: 0, fixed: 0, failed: 0, left: 0, removed: 0, inPlay: 0 };
    this.run().catch((error) => {
      this.log('error', 'The card data repair failed', { error: error.message });
      this.progress({ finished: true, phase: 'error', message: `It stopped: ${error.message}` });
    });
    return { ...this.job };
  }

  async run() {
    // what there is to mend, counted first so the bar knows its length
    const libraryWork = [];
    for (const id of this.catalog.libraryIds()) {
      let cards = [];
      try { cards = this.catalog.readLibrary(id); } catch { continue; }
      const ids = cards.filter((card) => isPokemon(card) && lacksDetails(card)).map((card) => card.id);
      if (ids.length) libraryWork.push({ id, ids });
    }
    const placed = this.pokemonInPlay();
    const lookupRows = this.db.cachedCardRows().filter((row) => lacksDetails({ ...row.data, id: row.id }) && isPokemon(row.data));

    const allowed = libraryWork.reduce((sum, work) => sum + Math.min(work.ids.length, this.limit), 0);
    const total = lookupRows.length + placed.length + allowed;
    this.progress({ phase: 'repairing', total, message: 'Mending the card data:' });

    // 1. the lookup cache: a card without its data is forgotten, and asked for again when it is next needed
    let removed = 0;
    for (const row of lookupRows) {
      this.db.deleteCachedCard(row.id);
      removed++;
      this.progress({ done: this.job.done + 1, removed });
    }

    // 2. the Pokémon on the table: asked for again and filled in
    let mended = 0;
    for (const entry of placed) {
      if (this.stopped) break;
      let ok = false;
      try { ok = await this.healInPlay(entry.side, entry.slot); } catch (error) { this.log('warn', 'A Pokémon on the table could not be mended', { name: entry.name, error: error.message }); }
      if (ok) mended++;
      this.progress({ done: this.job.done + 1, inPlay: mended, failed: this.job.failed + (ok ? 0 : 1) });
    }

    // 3. the libraries: each card is asked of the card service that built the library, and written back with what it says
    let fixed = 0;
    let left = 0;
    for (const work of libraryWork) {
      if (this.stopped) { left += work.ids.length; continue; }
      const batch = work.ids.slice(0, this.limit);
      left += work.ids.length - batch.length;
      const source = this.catalog.sourceOf(work.id);
      const patches = new Map();
      for (const cardId of batch) {
        if (this.stopped) { left += batch.length - patches.size; break; }
        let details = null;
        try {
          details = await this.pokemonTCG.getCard(cardId, { source }, { fresh: true });
        } catch (error) {
          details = null;
        }
        if (details && Array.isArray(details.attacks)) {
          patches.set(cardId, {
            attacks: details.attacks,
            retreat: Number.isInteger(details.retreat) ? details.retreat : 0,
            abilities: Array.isArray(details.abilities) ? details.abilities : [],
            ...(details.evolvesFrom ? { evolvesFrom: String(details.evolvesFrom) } : {}),
            detailed: true
          });
          fixed++;
        } else {
          this.progress({ failed: this.job.failed + 1 });
        }
        this.progress({ done: this.job.done + 1, fixed });
        if (this.paceMs) await wait(this.paceMs);
      }
      if (patches.size) {
        try { this.catalog.patchRecords(work.id, patches); } catch (error) { this.log('warn', 'A library could not be updated', { id: work.id, error: error.message }); }
      }
    }

    const after = this.scan();
    const outcome = this.stopped ? 'stopped' : 'done';
    this.progress({
      finished: true,
      phase: outcome,
      left,
      message: this.stopped
        ? `Stopped. ${fixed} cards mended so far.`
        : `Done: ${fixed} library cards mended, ${removed} saved lookups forgotten, ${mended} Pokémon on the table filled in${left ? `. ${left} more are left: run it again` : ''}${after.flagged ? `. ${after.flagged} still look empty (some cards have nothing to show)` : ''}.`
    });
  }
}

module.exports = { CardHealth, problemsOf, lacksDetails, isPokemon, PROBLEMS, REPAIR_LIMIT };
