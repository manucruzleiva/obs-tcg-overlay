/**
 * Unit tests for the game state and the action registry (no server, no network).
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const GameStateService = require('../src/services/gamestate');
const GAME = require('../public/js/game-data');
const actions = require('../src/actions');
const announcements = require('../src/services/announcements');

function makeGame(overrides = {}) {
  const calls = { saveMatch: [], addFavorite: [], removeFavorite: [], saveGameState: [] };
  const db = {
    loadGameState: () => overrides.saved || null,
    saveGameState: (state) => calls.saveGameState.push(state),
    saveMatch: (match) => calls.saveMatch.push(match),
    addFavorite: (id) => calls.addFavorite.push(id),
    removeFavorite: (id) => calls.removeFavorite.push(id)
  };
  const pokemonTCG = { selectBestImageUrl: (card) => (card.images && card.images.large) || '' };
  const gs = new GameStateService(db, pokemonTCG);
  gs.calls = calls;
  return gs;
}

const IMG = 'https://img.test/c.png';
const put = (gs, side, slot, extra = {}) =>
  gs.setPokemon(side, slot, { cardId: `${side}-${slot}`, name: `Mon ${slot}`, image: IMG, hp: 60, ...extra });

describe('GameStateService', () => {
  let gs;
  beforeEach(() => {
    gs = makeGame();
  });

  it('starts with sensible defaults', () => {
    const { state } = gs;
    assert.equal(state.revision, 0);
    assert.equal(state.trainerA.prizes.count, 6);
    assert.equal(state.trainerA.bench.length, 8);
    assert.equal(state.trainerA.benchSize, 5);
    assert.equal(state.settings.display.nationality, true);
    assert.equal(state.settings.toastSeconds, 2, 'banners stay for two seconds unless the producer says otherwise');
    assert.equal(state.settings.display.gxMarker, false, 'the GX marker is off until the producer asks for it');
    assert.equal(state.settings.display.vstarMarker, false, 'and so is the VSTAR marker');
    assert.equal(state.settings.display.supporterCounter, true, 'the others show');
    assert.equal(state.settings.display.nationalityFlag, false, 'the nationality is text until the producer chooses flags');
    assert.equal(state.settings.display.benchRow, false, 'the bench is stacked at the side until the producer asks for a row');
    assert.equal(state.settings.display.benchAttacks, false, 'the attacks of the benched Pokémon are not shown until the producer asks for them');
    assert.equal(state.settings.display.spaces, true, 'the frames of the reserved spaces show');
    assert.ok(Object.entries(state.settings.display).every(([key, shown]) => shown === true || ['gxMarker', 'vstarMarker', 'nationalityFlag', 'benchRow', 'benchAttacks', 'toolNames'].includes(key)));
  });

  it('keeps the GX attack and the VSTAR Power as markers that can be used once per game, back when the game ends', () => {
    const marker = (side, kind) => gs.state[side].resources[kind];
    for (const side of ['trainerA', 'trainerB']) {
      assert.deepEqual([marker(side, 'gxPerGame'), marker(side, 'vstarPerGame')], [{ available: 1, used: 0 }, { available: 1, used: 0 }]);
    }

    gs.stepCounter('trainerA', 'gxPerGame', 1);
    gs.stepCounter('trainerA', 'gxPerGame', 1);
    assert.equal(marker('trainerA', 'gxPerGame').used, 1, 'once is all there is');
    gs.stepCounter('trainerB', 'vstarPerGame', 1);
    gs.stepCounter('trainerA', 'vstarPerGame', 1);
    gs.stepCounter('trainerA', 'vstarPerGame', -1);
    assert.equal(marker('trainerA', 'vstarPerGame').used, 0, 'taking it back works');

    // a turn passing is not a game ending
    gs.toggleTurn();
    gs.toggleTurn();
    assert.equal(marker('trainerA', 'gxPerGame').used, 1);
    assert.equal(marker('trainerB', 'vstarPerGame').used, 1);

    // a game won gives both trainers both of them back
    gs.matchWin('trainerA');
    for (const side of ['trainerA', 'trainerB']) assert.deepEqual([marker(side, 'gxPerGame').used, marker(side, 'vstarPerGame').used], [0, 0], side);

    // so does starting a new one, and starting the score again
    for (const [side, kind] of [['trainerA', 'gxPerGame'], ['trainerB', 'vstarPerGame']]) gs.stepCounter(side, kind, 1);
    gs.startGame();
    for (const side of ['trainerA', 'trainerB']) assert.deepEqual([marker(side, 'gxPerGame').used, marker(side, 'vstarPerGame').used], [0, 0], `${side} after a new game`);
    gs.stepCounter('trainerB', 'gxPerGame', 1);
    gs.resetMatchScore();
    assert.equal(marker('trainerB', 'gxPerGame').used, 0);

    // taking a win back does not hand anything back
    gs.matchWin('trainerA');
    gs.stepCounter('trainerA', 'vstarPerGame', 1);
    gs.matchWinMinus('trainerA');
    assert.equal(marker('trainerA', 'vstarPerGame').used, 1);
  });

  it('gives the markers to a game saved before they existed', () => {
    const saved = makeGame().state;
    delete saved.trainerA.resources.gxPerGame;
    delete saved.trainerB.resources.vstarPerGame;
    delete saved.settings.display.gxMarker;
    const loaded = makeGame({ saved });
    assert.deepEqual(loaded.state.trainerA.resources.gxPerGame, { available: 1, used: 0 });
    assert.deepEqual(loaded.state.trainerB.resources.vstarPerGame, { available: 1, used: 0 });
    assert.equal(loaded.state.settings.display.gxMarker, false, 'and they stay off');
  });

  it('chooses which card services are asked and the language of the cards, refusing what it does not know', () => {
    assert.deepEqual([gs.state.settings.apiProvider, gs.state.settings.cardLanguage], ['auto', 'en']);
    gs.updateSettings({ apiProvider: 'tcgdex', cardLanguage: 'pt-br' });
    assert.deepEqual([gs.state.settings.apiProvider, gs.state.settings.cardLanguage], ['tcgdex', 'pt-br']);
    gs.updateSettings({ apiProvider: 'pokemontcg' });
    assert.equal(gs.state.settings.apiProvider, 'pokemontcg');
    gs.updateSettings({ apiProvider: 'klingon', cardLanguage: 'tlh' });
    gs.updateSettings({ apiProvider: 7, cardLanguage: null });
    assert.deepEqual([gs.state.settings.apiProvider, gs.state.settings.cardLanguage], ['pokemontcg', 'pt-br'], 'nothing it does not know gets in');
  });

  it('moves a game saved before TCGdex to automatic, and keeps what was chosen since', () => {
    const older = makeGame().state;
    older.settings.apiProvider = 'pokemontcg'; // the only service there was: nothing could change it
    delete older.settings.cardLanguage;
    assert.equal(makeGame({ saved: older }).state.settings.apiProvider, 'auto');

    const chosen = makeGame().state;
    chosen.settings.apiProvider = 'pokemontcg';
    chosen.settings.cardLanguage = 'fr';
    const loaded = makeGame({ saved: chosen }).state.settings;
    assert.deepEqual([loaded.apiProvider, loaded.cardLanguage], ['pokemontcg', 'fr'], 'a choice made on purpose stays');

    const odd = makeGame().state;
    odd.settings.apiProvider = 'klingon';
    odd.settings.cardLanguage = 'tlh';
    const fixed = makeGame({ saved: odd }).state.settings;
    assert.deepEqual([fixed.apiProvider, fixed.cardLanguage], ['auto', 'en']);

    // Scrydex is a service now, so a game saved with it keeps it
    const scrydex = makeGame().state;
    scrydex.settings.apiProvider = 'scrydex';
    assert.equal(makeGame({ saved: scrydex }).state.settings.apiProvider, 'scrydex');
  });

  it('lets the producer show the markers on the overlay', () => {
    gs.updateSettings({ display: { gxMarker: true, vstarMarker: true } });
    assert.equal(gs.state.settings.display.gxMarker, true);
    assert.equal(gs.state.settings.display.vstarMarker, true);
  });

  it('gives the turn to trainer A first, then alternates, refreshing the starting trainer\'s limits', () => {
    gs.stepCounter('trainerB', 'energyPerTurn', 1);
    gs.stepCounter('trainerB', 'supporterPerTurn', 1);
    gs.stepCounter('trainerA', 'energyPerTurn', 1);

    gs.toggleTurn();
    assert.equal(gs.state.trainerA.isTurn, true);
    assert.equal(gs.state.trainerB.isTurn, false);
    assert.equal(gs.state.trainerA.resources.energyPerTurn.used, 0, 'A\'s turn begins, so A refreshes');
    assert.equal(gs.state.trainerB.resources.energyPerTurn.used, 1, 'B keeps what it used');

    gs.toggleTurn();
    assert.equal(gs.state.trainerB.isTurn, true);
    assert.equal(gs.state.trainerB.resources.energyPerTurn.used, 0);
    assert.equal(gs.state.trainerB.resources.supporterPerTurn.used, 0);
  });

  it('clamps prizes, bench size and counters', () => {
    gs.adjustPrizes('trainerA', -10);
    assert.equal(gs.state.trainerA.prizes.count, 0);
    gs.adjustPrizes('trainerA', 10);
    assert.equal(gs.state.trainerA.prizes.count, 6);

    for (let i = 0; i < 10; i++) gs.adjustBenchSize('trainerA', 1);
    assert.equal(gs.state.trainerA.benchSize, 8);
    for (let i = 0; i < 10; i++) gs.adjustBenchSize('trainerA', -1);
    assert.equal(gs.state.trainerA.benchSize, 2);
    assert.equal(gs.state.trainerA.bench.length, 2);
    gs.adjustBenchSize('trainerA', 1);
    assert.equal(gs.state.trainerA.bench.length, 3);
    assert.equal(gs.state.trainerA.bench[2].slot, 2);
  });

  it('puts the bench back to five slots, whatever size it was, and loses the Pokémon in the slots that go', () => {
    for (let i = 0; i < 4; i++) gs.adjustBenchSize('trainerA', 1);
    assert.equal(gs.state.trainerA.benchSize, 8);
    gs.setPokemon('trainerA', 1, { cardId: 'k-2', name: 'Kept', hp: 50 });
    gs.setPokemon('trainerA', 6, { cardId: 'g-7', name: 'Gone', hp: 50 });

    gs.resetBenchSize('trainerA');
    assert.equal(gs.state.trainerA.benchSize, 5);
    assert.equal(gs.state.trainerA.bench.length, 5);
    assert.equal(gs.state.trainerA.bench[1].name, 'Kept');
    assert.ok(!gs.state.trainerA.bench.some((slot) => slot.name === 'Gone'));

    // a smaller bench grows to five, empty; one already at five stays as it is
    for (let i = 0; i < 4; i++) gs.adjustBenchSize('trainerA', -1);
    assert.equal(gs.state.trainerA.benchSize, 2);
    gs.resetBenchSize('trainerA');
    assert.deepEqual([gs.state.trainerA.benchSize, gs.state.trainerA.bench.length], [5, 5]);
    assert.equal(gs.state.trainerA.bench[1].name, 'Kept');
    const before = JSON.stringify(gs.state.trainerA);
    gs.resetBenchSize('trainerA');
    assert.equal(JSON.stringify(gs.state.trainerA), before);
    assert.equal(gs.state.trainerB.benchSize, 5, 'the other trainer is not touched');
  });

  it('sets and toggles flags and locks', () => {
    gs.setLock('trainerA', 'itemLock');
    assert.equal(gs.state.trainerA.locks.itemLock, true);
    gs.setLock('trainerA', 'itemLock', true);
    assert.equal(gs.state.trainerA.locks.itemLock, true, 'setting is idempotent');
    gs.setLock('trainerA', 'itemLock', false);
    assert.equal(gs.state.trainerA.locks.itemLock, false);

    assert.equal(gs.state.trainerB.prizes.hidden, true, 'the prize cards are face down until they are shown');
    gs.setPrizesHidden('trainerB');
    assert.equal(gs.state.trainerB.prizes.hidden, false, 'with no value it toggles');
    gs.setPrizesHidden('trainerB');
    assert.equal(gs.state.trainerB.prizes.hidden, true);
  });

  it('keeps a penalty as a number of prize cards, from none to all six', () => {
    assert.equal(gs.state.trainerA.prizes.penalty, 0);
    gs.setPrizePenalty('trainerA', 2);
    assert.equal(gs.state.trainerA.prizes.penalty, 2);
    gs.adjustPrizePenalty('trainerA', 1);
    assert.equal(gs.state.trainerA.prizes.penalty, 3);
    gs.adjustPrizePenalty('trainerA', 99);
    assert.equal(gs.state.trainerA.prizes.penalty, 6, 'never more than the six prize cards');
    gs.adjustPrizePenalty('trainerA', -99);
    assert.equal(gs.state.trainerA.prizes.penalty, 0, 'never below none');
    gs.setPrizePenalty('trainerB', 2.9);
    assert.equal(gs.state.trainerB.prizes.penalty, 2, 'whole cards only');
    assert.equal(gs.state.trainerA.prizes.penalty, 0, 'the other trainer is not affected');
  });

  it('has won when the prize cards it has left are no more than the penalty of the opponent', () => {
    assert.equal(gs.isWinning('trainerA'), false);
    gs.setPrizes('trainerA', 0);
    assert.equal(gs.isWinning('trainerA'), true, 'every prize card taken');
    gs.setPrizes('trainerA', 2);
    assert.equal(gs.isWinning('trainerA'), false);

    gs.setPrizePenalty('trainerB', 1);
    assert.equal(gs.isWinning('trainerA'), false, 'a penalty of one is not enough for two cards left');
    gs.setPrizePenalty('trainerB', 2);
    assert.equal(gs.isWinning('trainerA'), true, 'two cards left and a penalty of two: it has taken what it needs');
    assert.equal(gs.isWinning('trainerB'), false, 'a penalty is nothing for the trainer who has it');

    gs.setPrizePenalty('trainerA', 6); // the penalty of Trainer A counts for Trainer B
    assert.equal(gs.isWinning('trainerB'), true);
    gs.setPrizePenalty('trainerA', 0);
    gs.setPrizePenalty('trainerB', 0);
    assert.deepEqual([gs.isWinning('trainerA'), gs.isWinning('trainerB')], [false, false]);
  });

  it('starts the next game of the match: prizes, penalties and the once-per-game markers start again, the score, names and table stay', () => {
    put(gs, 'trainerA', -1, { hp: 60 });
    gs.setName('trainerA', 'Ash');
    gs.matchWin('trainerA');
    gs.setPrizes('trainerA', 2);
    gs.setPrizes('trainerB', 4);
    gs.setPrizePenalty('trainerA', 3);
    gs.setPrizePenalty('trainerB', 1);
    gs.stepCounter('trainerA', 'gxPerGame', 1);
    gs.stepCounter('trainerB', 'vstarPerGame', 1);
    gs.setPrizesHidden('trainerB', true);
    gs.addAbility('trainerA', -1, 'Once a game', 'game');
    gs.setAbilityUsed('trainerA', -1, 0, true);

    gs.nextGame();
    for (const side of ['trainerA', 'trainerB']) assert.deepEqual([gs.state[side].prizes.count, gs.state[side].prizes.penalty], [6, 0], side);
    assert.deepEqual([gs.state.trainerA.resources.gxPerGame.used, gs.state.trainerB.resources.vstarPerGame.used], [0, 0]);
    assert.equal(gs.state.trainerA.active.abilities[0].used, false, 'a once-per-game ability is ready again');
    assert.equal(gs.state.matchScore.trainerAWins, 1, 'the score stays');
    assert.equal(gs.state.trainerA.name, 'Ash');
    assert.equal(gs.state.trainerA.active.name, 'Mon -1', 'and what is on the table');
    assert.equal(gs.state.trainerB.prizes.hidden, true, 'and whether the prize cards are shown');
  });

  it('pauses the game and resumes it, remembers it in a saved game, and has it off in a new one', () => {
    assert.equal(gs.state.paused, false);
    assert.equal(gs.setPaused(true), true);
    assert.equal(gs.setPaused(true), true, 'pausing a paused game changes nothing');
    assert.equal(gs.setPaused(false), false);
    assert.equal(gs.setPaused(), true, 'with nothing said it toggles');
    assert.equal(gs.setPaused(), false);

    gs.setPaused(true);
    assert.equal(makeGame({ saved: JSON.parse(JSON.stringify(gs.state)) }).state.paused, true, 'a game saved while paused is paused when it opens');
    const old = JSON.parse(JSON.stringify(makeGame().state));
    delete old.paused;
    assert.equal(makeGame({ saved: old }).state.paused, false, 'a game saved before the pause existed is not paused');
    assert.equal(makeGame({ saved: { ...old, paused: 'yes' } }).state.paused, false, 'only true pauses it');
    assert.equal(gs.state.settings.enablePauseToast, true, 'its banner is on unless it is switched off');
  });

  it('starts every game without a penalty', () => {
    gs.setPrizePenalty('trainerA', 3);
    gs.setPrizePenalty('trainerB', 1);
    gs.startGame();
    assert.equal(gs.state.trainerA.prizes.penalty, 0);
    assert.equal(gs.state.trainerB.prizes.penalty, 0);
  });

  it('understands a saved penalty from when it was only on or off', () => {
    const old = (penalty) => makeGame({ saved: { trainerA: { prizes: { count: 4, hidden: false, penalty } }, trainerB: { prizes: { penalty: 'yes' } } } });
    assert.equal(old(true).state.trainerA.prizes.penalty, 1, 'on becomes one prize card');
    assert.equal(old(false).state.trainerA.prizes.penalty, 0);
    assert.equal(old(4).state.trainerA.prizes.penalty, 4);
    assert.equal(old(40).state.trainerA.prizes.penalty, 6, 'out of range is brought back');
    assert.equal(old(true).state.trainerB.prizes.penalty, 0, 'anything else is no penalty');
    assert.equal(old(true).state.trainerA.prizes.count, 4, 'the rest of the prizes is kept');
  });

  it('holds up to four Special Energy cards on a Pokémon, and loses them with the card', () => {
    put(gs, 'trainerA', -1);
    const card = (n) => ({ cardId: `e-${n}`, name: `Energy ${n}`, image: IMG });
    assert.deepEqual(gs.state.trainerA.active.specialEnergies, []);
    for (let n = 1; n <= 4; n++) assert.equal(gs.attachSpecialEnergy('trainerA', -1, card(n)), true);
    assert.equal(gs.attachSpecialEnergy('trainerA', -1, card(5)), false, 'no more than four');

    gs.removeSpecialEnergy('trainerA', -1, 1);
    gs.removeSpecialEnergy('trainerA', -1, 9);
    gs.removeSpecialEnergy('trainerA', -1, -1);
    assert.deepEqual(gs.state.trainerA.active.specialEnergies.map((energy) => energy.cardId), ['e-1', 'e-3', 'e-4']);

    // an evolution keeps its attachments; a different card does not
    gs.setPokemon('trainerA', -1, { cardId: 'evo', name: 'Raichu', image: IMG, hp: 120 }, { keep: true });
    assert.equal(gs.state.trainerA.active.specialEnergies.length, 3);
    gs.setPokemon('trainerA', -1, { cardId: 'new', name: 'Mew', image: IMG, hp: 40 });
    assert.deepEqual(gs.state.trainerA.active.specialEnergies, []);
  });

  it('keeps the attacks and the retreat cost of the card in the slot, and lets go of them with it', () => {
    const attacks = [{ name: 'Gnaw', damage: 20, mod: '' }, { name: 'Thunderbolt', damage: 120, mod: '' }];
    gs.setPokemon('trainerA', -1, { cardId: 'p', name: 'Pikachu', image: IMG, hp: 60, attacks, retreat: 1 });
    assert.deepEqual(gs.state.trainerA.active.attacks, attacks);
    assert.equal(gs.state.trainerA.active.retreat, 1);

    // an evolution is another card: its own attacks, or none known (by hand), never the ones it had
    gs.setPokemon('trainerA', -1, { cardId: 'r', name: 'Raichu', image: IMG, hp: 120, attacks: [{ name: 'Thunder', damage: 90, mod: '' }], retreat: 2 }, { keep: true });
    assert.deepEqual(gs.state.trainerA.active.attacks, [{ name: 'Thunder', damage: 90, mod: '' }]);
    gs.setPokemon('trainerA', -1, { cardId: 'r2', name: 'Raichu', image: IMG, hp: 120 }, { keep: true });
    assert.deepEqual(gs.state.trainerA.active.attacks, []);
    assert.equal(gs.state.trainerA.active.retreat, 0);

    // out-of-range numbers and too many attacks are brought back
    gs.setPokemon('trainerA', 0, { cardId: 'm', name: 'Mew', image: IMG, hp: 40, attacks: Array.from({ length: 9 }, (_, i) => ({ name: `A${i}`, damage: 10, mod: '' })), retreat: 99 });
    assert.equal(gs.state.trainerA.bench[0].attacks.length, 4);
    assert.equal(gs.state.trainerA.bench[0].retreat, 6);
    gs.setRetreat('trainerA', 0, -4);
    assert.equal(gs.state.trainerA.bench[0].retreat, 0);
    gs.setRetreat('trainerA', 0, 2.7);
    assert.equal(gs.state.trainerA.bench[0].retreat, 2);
  });

  it('reads a save from before attacks and retreat costs were kept', () => {
    const old = makeGame({ saved: { trainerA: { active: { slot: -1, cardId: 'p', name: 'Pikachu', hp: { max: 60, current: 60 } }, bench: [{ slot: 0, cardId: 'e', name: 'Eevee', hp: { max: 50, current: 50 }, retreat: 'x' }] } } });
    assert.deepEqual(old.state.trainerA.active.attacks, []);
    assert.equal(old.state.trainerA.active.retreat, 0);
    assert.equal(old.state.trainerA.bench[0].retreat, 0, 'a retreat cost that is not a number is none');
  });

  it('reads a save from before Special Energy existed', () => {
    const old = makeGame({ saved: { trainerA: { active: { slot: -1, cardId: 'p', name: 'Pikachu', energies: ['fire'], hp: { max: 60, current: 60 } }, bench: [{ slot: 0, cardId: 'e', name: 'Eevee', energies: [], hp: { max: 50, current: 50 } }] } } });
    assert.deepEqual(old.state.trainerA.active.specialEnergies, []);
    assert.deepEqual(old.state.trainerA.bench[0].specialEnergies, []);
    assert.equal(old.attachSpecialEnergy('trainerA', -1, { cardId: 'e-1', name: 'Energy', image: IMG }), true);
    assert.deepEqual(old.state.trainerA.active.energies, ['fire'], 'the basic ones are as they were');
  });

  it('keeps HP inside 0..max when damaging and healing', () => {
    put(gs, 'trainerA', -1);
    gs.damage('trainerA', -1, 25);
    assert.equal(gs.state.trainerA.active.hp.current, 35);
    gs.damage('trainerA', -1, -100);
    assert.equal(gs.state.trainerA.active.hp.current, 60);
    gs.damage('trainerA', -1, 1000);
    assert.equal(gs.state.trainerA.active.hp.current, 0);
    gs.setHP('trainerA', -1, 9999);
    assert.equal(gs.state.trainerA.active.hp.current, 60);
    gs.setMaxHP('trainerA', -1, 40);
    assert.deepEqual(gs.state.trainerA.active.hp, { max: 40, current: 40 });
  });

  it('ignores damage aimed at a slot that does not exist', () => {
    assert.doesNotThrow(() => gs.damage('trainerA', 99, 10));
    assert.doesNotThrow(() => gs.healFull('trainerA', 99));
    assert.doesNotThrow(() => gs.attachEnergy('trainerA', 99, 'fire'));
  });

  it('puts a fresh Pokémon at full HP with nothing attached, and keeps attachments and damage on evolution', () => {
    put(gs, 'trainerA', -1, { hp: 70, abilities: ['Old'] });
    gs.attachEnergy('trainerA', -1, 'fire');
    gs.damage('trainerA', -1, 30);

    gs.setPokemon('trainerA', -1, { cardId: 'evo', name: 'Evolved', image: IMG, hp: 100, abilities: ['New'] }, { keep: true });
    const evolved = gs.state.trainerA.active;
    assert.deepEqual(evolved.hp, { max: 100, current: 70 }); // 30 damage carries over to the new card
    assert.deepEqual(evolved.energies, ['fire']);
    assert.deepEqual(evolved.abilities, [{ name: 'New', used: false, scope: 'turn' }]);

    gs.setPokemon('trainerA', -1, { cardId: 'fresh', name: 'Fresh', image: IMG, hp: 80 });
    const fresh = gs.state.trainerA.active;
    assert.deepEqual(fresh.hp, { max: 80, current: 80 });
    assert.deepEqual(fresh.energies, []);
    assert.deepEqual(fresh.abilities, []);
  });

  it('switches a bench Pokémon with the active one', () => {
    put(gs, 'trainerA', -1, { hp: 60 });
    put(gs, 'trainerA', 2, { hp: 90 });
    gs.attachEnergy('trainerA', 2, 'water');

    gs.swapWithActive('trainerA', 2);
    assert.equal(gs.state.trainerA.active.name, 'Mon 2');
    assert.deepEqual(gs.state.trainerA.active.energies, ['water']);
    assert.equal(gs.state.trainerA.bench[2].name, 'Mon -1');
    assert.equal(gs.state.trainerA.active.slot, 'active');
    assert.equal(gs.state.trainerA.bench[2].slot, 2);

    assert.doesNotThrow(() => gs.swapWithActive('trainerA', 99));
  });

  describe('moving a Pokémon to another slot (drag and drop)', () => {
    const names = (side = 'trainerA') => [gs.state[side].active.name, ...gs.state[side].bench.slice(0, 5).map((slot) => slot.name)];

    it('changes places with the Pokémon that is there, each keeping its own HP and attachments, on the bench or with the Active', () => {
      put(gs, 'trainerA', -1, { hp: 60 });
      put(gs, 'trainerA', 0, { hp: 30 });
      put(gs, 'trainerA', 2, { hp: 90 });
      gs.attachEnergy('trainerA', 2, 'water');

      gs.moveSlot('trainerA', 0, 2);
      assert.deepEqual(names(), ['Mon -1', 'Mon 2', '', 'Mon 0', '', '']);
      assert.deepEqual(gs.state.trainerA.bench[0].energies, ['water'], 'it keeps what is attached to it');
      assert.equal(gs.state.trainerA.bench[2].hp.max, 30);
      assert.deepEqual(gs.state.trainerA.bench.slice(0, 5).map((slot) => slot.slot), [0, 1, 2, 3, 4], 'every slot knows its place');

      gs.moveSlot('trainerA', -1, 0); // the Active and a Pokémon of the bench
      assert.equal(gs.state.trainerA.active.name, 'Mon 2');
      assert.deepEqual(gs.state.trainerA.active.energies, ['water']);
      assert.equal(gs.state.trainerA.bench[0].name, 'Mon -1');
      assert.equal(gs.state.trainerA.active.slot, 'active');
      assert.equal(gs.state.trainerA.bench[0].slot, 0);
    });

    it('moves into an empty slot, and leaves an empty slot behind, also for the Active spot', () => {
      put(gs, 'trainerA', -1, { hp: 60 });
      put(gs, 'trainerA', 1, { hp: 40 });

      gs.moveSlot('trainerA', 1, 3);
      assert.deepEqual(names(), ['Mon -1', '', '', '', 'Mon 1', ''], 'the Active, then the five slots of the bench');
      assert.equal(gs.state.trainerA.bench[1].slot, 1);
      assert.equal(gs.state.trainerA.bench[3].slot, 3);

      gs.clearSlot('trainerA', -1); // the Active was knocked out: a Pokémon of the bench steps up
      gs.moveSlot('trainerA', 3, -1);
      assert.deepEqual(names(), ['Mon 1', '', '', '', '', '']);
      assert.equal(gs.state.trainerA.active.slot, 'active');
      gs.moveSlot('trainerA', -1, 4); // and back down to an empty slot
      assert.equal(gs.state.trainerA.active.name, '');
      assert.equal(gs.state.trainerA.bench[4].name, 'Mon 1');
    });

    it('ends the special conditions of a Pokémon that leaves the Active spot, and leaves the others alone', () => {
      put(gs, 'trainerA', -1, { hp: 60 });
      put(gs, 'trainerA', 1, { hp: 40 });
      gs.setStatus('trainerA', 'asleep', true);
      gs.setStatus('trainerA', 'poisoned', true);

      gs.moveSlot('trainerA', -1, 1);
      assert.deepEqual(gs.state.trainerA.bench[1].status, [], 'it is cured on its way out');
      assert.deepEqual(gs.state.trainerA.active.status, []);

      gs.setStatus('trainerA', 'burned', true);
      gs.moveSlot('trainerA', 1, -1); // the other way: the one coming up has none, the one going down is cured
      assert.deepEqual(gs.state.trainerA.bench[1].status, []);
      assert.deepEqual(gs.state.trainerA.active.status, []);
    });

    it('does nothing for the same slot or a slot that is not there, and never touches the other trainer', () => {
      put(gs, 'trainerA', -1, { hp: 60 });
      put(gs, 'trainerA', 1, { hp: 40 });
      put(gs, 'trainerB', -1, { hp: 70 });
      const before = JSON.stringify(gs.state);
      gs.moveSlot('trainerA', 1, 1);
      gs.moveSlot('trainerA', 1, 99);
      gs.moveSlot('trainerA', 99, 1);
      gs.moveSlot('trainerA', -1, -1);
      assert.equal(JSON.stringify(gs.state), before);

      gs.moveSlot('trainerA', 1, -1);
      assert.equal(gs.state.trainerB.active.name, 'Mon -1');
      assert.equal(gs.state.trainerB.active.hp.max, 70);
    });
  });

  it('puts special conditions on the Active Pokémon: one of Asleep, Confused and Paralyzed at most, the rest together', () => {
    put(gs, 'trainerA', -1);
    const status = () => gs.state.trainerA.active.status;
    assert.deepEqual(status(), []);

    gs.setStatus('trainerA', 'poisoned');
    gs.setStatus('trainerA', 'asleep');
    assert.deepEqual(status(), ['asleep', 'poisoned']);
    gs.setStatus('trainerA', 'paralyzed', true);
    assert.deepEqual(status(), ['paralyzed', 'poisoned'], 'paralyzed takes the place of asleep: the card is turned one way');
    gs.setStatus('trainerA', 'confused', true);
    gs.setStatus('trainerA', 'burned', true);
    gs.setStatus('trainerA', 'trapped', true);
    assert.deepEqual(status(), ['burned', 'confused', 'poisoned', 'trapped'], 'markers go with anything, always in the same order');

    gs.setStatus('trainerA', 'burned'); // no value: toggles
    gs.setStatus('trainerA', 'trapped', false);
    gs.setStatus('trainerA', 'confused', false);
    assert.deepEqual(status(), ['poisoned']);
    gs.setStatus('trainerA', 'poisoned', true);
    assert.deepEqual(status(), ['poisoned'], 'twice is still once');

    gs.setStatus('trainerA', 'sparkly', true);
    assert.deepEqual(status(), ['poisoned'], 'a condition the game does not have is ignored');
    gs.clearStatus('trainerA');
    assert.deepEqual(status(), []);
    assert.deepEqual(gs.state.trainerB.active.status, [], 'the other trainer is untouched');
  });

  it('ends the conditions of a Pokémon that goes to the bench, evolves or is replaced', () => {
    put(gs, 'trainerA', -1, { hp: 60 });
    put(gs, 'trainerA', 1, { hp: 80 });
    gs.setStatus('trainerA', 'poisoned', true);
    gs.setStatus('trainerA', 'trapped', true);

    gs.setPokemon('trainerA', -1, { cardId: 'evo', name: 'Evolved', image: IMG, hp: 100 }, { keep: true });
    assert.deepEqual(gs.state.trainerA.active.status, [], 'evolving cures it');

    gs.setStatus('trainerA', 'burned', true);
    gs.swapWithActive('trainerA', 1);
    assert.deepEqual(gs.state.trainerA.bench[1].status, [], 'retreating cures it');
    assert.deepEqual(gs.state.trainerA.active.status, []);

    gs.setStatus('trainerA', 'asleep', true);
    gs.setPokemon('trainerA', -1, { cardId: 'fresh', name: 'Fresh', image: IMG, hp: 70 });
    assert.deepEqual(gs.state.trainerA.active.status, [], 'a new card has none');
    gs.setStatus('trainerA', 'asleep', true);
    gs.knockOut('trainerA', -1);
    assert.deepEqual(gs.state.trainerA.active.status, []);
  });

  it('tidies the conditions of a saved game', () => {
    const saved = makeGame().state;
    saved.trainerA.active = { ...saved.trainerA.active, cardId: 'x', name: 'X', status: ['poisoned', 'sparkly', 'asleep', 'confused', 'poisoned'] };
    saved.trainerB.active = { ...saved.trainerB.active, cardId: 'y', name: 'Y', status: 'poisoned' };
    const loaded = makeGame({ saved });
    assert.deepEqual(loaded.state.trainerA.active.status, ['confused', 'poisoned'], 'only the last of the turned ones, known ones only');
    assert.deepEqual(loaded.state.trainerB.active.status, [], 'anything that is not a list is nothing');
  });

  it('knocks a Pokémon out, moving prizes to the opponent', () => {
    put(gs, 'trainerA', -1);
    gs.knockOut('trainerA', -1, { prizesTaken: 3, clear: true });
    assert.equal(gs.state.trainerA.active.name, '');
    assert.equal(gs.state.trainerB.prizes.count, 3);

    put(gs, 'trainerB', 0);
    gs.knockOut('trainerB', 0, { prizesTaken: 1, clear: false });
    assert.equal(gs.state.trainerB.bench[0].name, 'Mon 0', 'clear: false leaves the Pokémon');
    assert.equal(gs.state.trainerA.prizes.count, 5);
  });

  it('resets once-per-turn ability tokens when that trainer\'s turn begins, but not once-per-game ones', () => {
    put(gs, 'trainerA', -1, { abilities: ['Per turn'] });
    gs.addAbility('trainerA', -1, 'Per game', 'game');
    gs.setAbilityUsed('trainerA', -1, 0, true);
    gs.setAbilityUsed('trainerA', -1, 1, true);

    gs.toggleTurn(); // A starts
    assert.equal(gs.state.trainerA.active.abilities[0].used, false);
    assert.equal(gs.state.trainerA.active.abilities[1].used, true);

    gs.startGame(); // a new game readies everything
    assert.equal(gs.state.trainerA.active.abilities[1].used, false);
  });

  it('limits ability tokens per Pokémon', () => {
    put(gs, 'trainerA', -1);
    for (let i = 0; i < 6; i++) gs.addAbility('trainerA', -1, `Token ${i}`);
    assert.equal(gs.state.trainerA.active.abilities.length, 4);
  });

  it('records a match when someone wins it', () => {
    gs.state.trainerA.name = 'Ash';
    gs.state.trainerB.name = 'Gary';
    gs.matchWin('trainerA');
    assert.equal(gs.calls.saveMatch.length, 0, 'one win of a best-of-3 is not a finished match');
    gs.matchWin('trainerA');
    assert.equal(gs.calls.saveMatch.length, 1);
    assert.equal(gs.calls.saveMatch[0].playerName, 'Ash');
    assert.equal(gs.calls.saveMatch[0].winner, 'trainerA');
    gs.matchWinMinus('trainerA');
    assert.equal(gs.state.matchScore.trainerAWins, 1);
  });

  it('accepts only known settings of the right type', () => {
    gs.updateSettings({ overlayOpacity: 50, autoScale: 'yes', unknown: 1, apiKey: 'k' });
    assert.equal(gs.state.settings.overlayOpacity, 50);
    assert.equal(gs.state.settings.autoScale, true, 'wrong type ignored');
    assert.equal('unknown' in gs.state.settings, false);
    assert.equal(gs.state.settings.apiKey, 'k');
  });

  it('merges visibility switches one by one and rejects unknown ones', () => {
    gs.updateSettings({ display: { nationality: false, hpBars: 'no', madeUp: false } });
    assert.equal(gs.state.settings.display.nationality, false);
    assert.equal(gs.state.settings.display.hpBars, true);
    assert.equal('madeUp' in gs.state.settings.display, false);
    gs.updateSettings({ display: { trainerName: false } });
    assert.equal(gs.state.settings.display.nationality, false, 'earlier switches are kept');
    assert.equal(gs.state.settings.display.trainerName, false);
  });

  it('keeps announcement durations within a sensible range', () => {
    gs.updateSettings({ toastSeconds: 500, animationSeconds: -3 });
    assert.equal(gs.state.settings.toastSeconds, 30);
    assert.equal(gs.state.settings.animationSeconds, 1);
    gs.updateSettings({ toastSeconds: 7.26 });
    assert.equal(gs.state.settings.toastSeconds, 7.3);
    gs.updateSettings({ toastSeconds: 'soon' });
    assert.equal(gs.state.settings.toastSeconds, 7.3, 'non-numbers are ignored');
  });

  it('toggles favorites through the database, at most 50, and manages feature cards', () => {
    gs.toggleFavorite('a');
    assert.deepEqual(gs.state.favoriteCardIds, ['a']);
    assert.deepEqual(gs.calls.addFavorite, ['a']);
    gs.toggleFavorite('a');
    assert.deepEqual(gs.calls.removeFavorite, ['a']);

    for (let i = 0; i < 60; i++) gs.toggleFavorite(`card-${i}`);
    assert.equal(gs.state.favoriteCardIds.length, 50);

    for (let i = 0; i < 16; i++) gs.addFeatureCard({ cardId: `f${i}`, name: `F${i}`, image: IMG, note: 'a note is no longer kept' });
    assert.equal(gs.state.featureCards.length, 14);
    assert.deepEqual(gs.state.featureCards.map((card) => card.name).slice(0, 2), ['F2', 'F3'], 'the oldest go when there are too many');
    assert.equal(gs.state.featureCards.at(-1).name, 'F15', 'and the newest is the last one');
    assert.ok(gs.state.featureCards.every((card) => !('note' in card)), 'a feature card has no note');
    const { id } = gs.state.featureCards[3];
    gs.removeFeatureCard({ id });
    assert.equal(gs.state.featureCards.some((card) => card.id === id), false);
    gs.removeFeatureCard({ id: 'does-not-exist' });
    assert.equal(gs.state.featureCards.length, 13);
  });

  it('keeps a sign between feature cards (+, →, = or or) in the order it was added, and ignores any other', () => {
    assert.deepEqual(GAME.FEATURE_SEPARATORS.map((one) => one.symbol), ['+', '→', '=', 'or']);
    gs.addFeatureCard({ cardId: 'a', name: 'Boss Orders', image: IMG });
    gs.addFeatureSeparator('+');
    gs.addFeatureCard({ cardId: 'b', name: 'Ultra Ball', image: IMG });
    gs.addFeatureSeparator('→');
    gs.addFeatureSeparator('nonsense');
    gs.addFeatureSeparator(undefined);
    assert.deepEqual(gs.state.featureCards.map((entry) => entry.separator || entry.name), ['Boss Orders', '+', 'Ultra Ball', '→']);
    const sign = gs.state.featureCards[1];
    assert.equal(typeof sign.id, 'string');
    assert.ok(!('name' in sign) && !('image' in sign), 'a sign is not a card');
    gs.removeFeatureCard({ id: sign.id });
    assert.deepEqual(gs.state.featureCards.map((entry) => entry.separator || entry.name), ['Boss Orders', 'Ultra Ball', '→'], 'a sign can be taken away like a card');
    gs.clearFeatureCards();
    assert.deepEqual(gs.state.featureCards, []);
  });

  it('loads the feature cards and signs it knows, and drops anything else from a file written by hand', () => {
    const saved = makeGame().state;
    saved.featureCards = [
      { id: 's1', separator: '+', addedAt: 1 }, { id: 'c1', cardId: 'a', name: 'Boss Orders', image: IMG, addedAt: 2 },
      { id: 's2', separator: 'maybe', addedAt: 3 }, 'junk', null, 7, { id: 'x' }, { id: 'c2', cardId: 'b', name: 'Ultra Ball', image: IMG, addedAt: 4 }
    ];
    const loaded = makeGame({ saved });
    assert.deepEqual(loaded.state.featureCards.map((entry) => entry.separator || entry.name), ['+', 'Boss Orders', 'Ultra Ball']);
    saved.featureCards = 'nothing';
    assert.deepEqual(makeGame({ saved }).state.featureCards, []);
  });

  it('drops the note of a feature card saved before they had none', () => {
    const saved = makeGame().state;
    saved.featureCards = [{ id: 'old-1', cardId: 'f-1', name: 'Boss Orders', image: IMG, note: 'Played this turn', addedAt: 1 }, { id: 'old-2', cardId: 'f-2', name: 'Ultra Ball', image: IMG, addedAt: 2 }];
    const loaded = makeGame({ saved });
    assert.deepEqual(loaded.state.featureCards.map((card) => card.name), ['Boss Orders', 'Ultra Ball']);
    assert.ok(loaded.state.featureCards.every((card) => !('note' in card)));
  });

  it('snapshots and restores while the revision keeps counting up', () => {
    const snapshot = gs.snapshot();
    gs.state.trainerA.name = 'Changed';
    gs.state.revision = 7;
    gs.restore(snapshot);
    assert.equal(gs.state.trainerA.name, 'Trainer A');
    assert.equal(gs.state.revision, 7);
  });

  it('imports and resets without losing the revision', () => {
    gs.state.revision = 12;
    gs.importState({ trainerA: { name: 'Imported' }, revision: 1 });
    assert.equal(gs.state.trainerA.name, 'Imported');
    assert.equal(gs.state.trainerA.prizes.count, 6, 'missing parts come from the defaults');
    assert.equal(gs.state.revision, 12);

    gs.fullReset();
    assert.equal(gs.state.trainerA.name, 'Trainer A');
    assert.equal(gs.state.revision, 12);
  });

  it('drops announcement state that older versions saved', () => {
    const old = makeGame({ saved: { trainerA: { name: 'Saved' }, trainerAToast: { visible: true }, topDeckAnimation: { active: true }, activeTheme: 'x' } });
    assert.equal(old.state.trainerA.name, 'Saved');
    assert.equal('trainerAToast' in old.state, false);
    assert.equal('topDeckAnimation' in old.state, false);
    assert.equal('activeTheme' in old.state, false);
  });

  it('forks a copy that changes independently and never touches the database', () => {
    gs.state.trainerA.name = 'Live';
    const fork = gs.fork();
    fork.state.trainerA.name = 'Draft';
    fork.matchWin('trainerA');
    fork.matchWin('trainerA'); // finishes the match in the copy
    fork.toggleFavorite('card');

    assert.equal(gs.state.trainerA.name, 'Live');
    assert.equal(gs.state.matchScore.trainerAWins, 0);
    assert.equal(gs.calls.saveMatch.length, 0, 'a draft does not write match history');
    assert.equal(gs.calls.addFavorite.length, 0);
    assert.equal(fork.autosaveInterval, undefined, 'a fork has no timers');
  });
});

describe('the cards on the prizes', () => {
  let gs;
  beforeEach(() => {
    gs = makeGame();
  });
  const card = (n) => ({ cardId: `sv1-${n}`, name: `Card ${n}`, image: `/img/sv1/${n}.png` });
  const cardsOf = (side) => gs.state[side].prizes.cards;
  const NONE = [null, null, null, null, null, null];
  const choose = (side, cards) => actions.resolve(`action:${side}`, { action: 'prizeCardsSet', cards });

  it('hides the prize cards again for a new game, which has new prizes', () => {
    gs.setPrizesHidden('trainerA', false);
    gs.setPrizesHidden('trainerB', false);
    gs.nextGame();
    assert.deepEqual([gs.state.trainerA.prizes.hidden, gs.state.trainerB.prizes.hidden], [true, true]);
    gs.setPrizesHidden('trainerA', false);
    gs.startGame();
    assert.equal(gs.state.trainerA.prizes.hidden, true);
  });

  it('starts with no card chosen for any prize card', () => {
    assert.deepEqual(cardsOf('trainerA'), NONE);
    assert.deepEqual(cardsOf('trainerB'), NONE);
  });

  it('keeps the cards in the order they were chosen, one for each prize card, with a gap where nobody chose one, for that trainer only', () => {
    gs.setPrizeCards('trainerA', [card(1), null, card(3)]);
    assert.deepEqual(cardsOf('trainerA'), [card(1), null, card(3), null, null, null]);
    assert.deepEqual(cardsOf('trainerB'), NONE);
    gs.setPrizeCards('trainerA', [null, card(2)]);
    assert.deepEqual(cardsOf('trainerA'), [null, card(2), null, null, null, null], 'the last choice is all there is');
    gs.setPrizeCards('trainerA', []);
    assert.deepEqual(cardsOf('trainerA'), NONE, 'an empty list takes them all away');
  });

  it('makes six of whatever it is given, and nothing of what is not a card', () => {
    gs.setPrizeCards('trainerA', [1, 2, 3, 4, 5, 6, 7, 8].map(card));
    assert.deepEqual(cardsOf('trainerA'), [1, 2, 3, 4, 5, 6].map(card), 'six is as many as there are');
    gs.setPrizeCards('trainerA', ['Pikachu', 7, true, [], {}, { name: '' }, { cardId: 'x' }]);
    assert.deepEqual(cardsOf('trainerA'), NONE, 'a card has a name');
    for (const notAList of [undefined, null, 'cards', 5, { 0: card(1) }]) {
      gs.setPrizeCards('trainerA', [card(1)]);
      gs.setPrizeCards('trainerA', notAList);
      assert.deepEqual(cardsOf('trainerA'), NONE, JSON.stringify(notAList));
    }
    gs.setPrizeCards('trainerB', [{ name: 'Only a name' }, { name: 'Odd', cardId: 5, image: 7, extra: 'dropped' }]);
    assert.deepEqual(cardsOf('trainerB'), [{ cardId: '', name: 'Only a name', image: '' }, { cardId: '', name: 'Odd', image: '' }, null, null, null, null]);
  });

  it('are the same cards whichever prize cards are taken or given back, and after the prizes are reset', () => {
    gs.setPrizeCards('trainerA', [1, 2, 3, 4, 5, 6].map(card));
    gs.adjustPrizes('trainerA', -2);
    gs.setPrizes('trainerA', 1);
    gs.knockOut('trainerB', -1);
    actions.resolve('action:trainerA', { action: 'prizeMinus' }).run(gs);
    actions.resolve('action:trainerA', { action: 'prizeReset' }).run(gs);
    actions.resolve('action:match', { action: 'resetGamePrizes' }).run(gs);
    gs.setPrizesHidden('trainerA', true);
    assert.deepEqual(cardsOf('trainerA'), [1, 2, 3, 4, 5, 6].map(card));
    assert.equal(gs.state.trainerA.prizes.count, 6);
  });

  it('are not chosen yet for a new game (the next game, or a new match), but stay when a game is won, until then', () => {
    gs.setPrizeCards('trainerA', [card(1), card(2)]);
    gs.setPrizeCards('trainerB', [card(3)]);
    gs.matchWin('trainerA');
    assert.deepEqual(cardsOf('trainerA'), [card(1), card(2), null, null, null, null], 'the game is over, the table is as it was');
    gs.nextGame();
    assert.deepEqual([cardsOf('trainerA'), cardsOf('trainerB')], [NONE, NONE], 'new prizes for the next game');
    gs.setPrizeCards('trainerA', [card(4)]);
    gs.startGame();
    assert.deepEqual(cardsOf('trainerA'), NONE, 'and for a new match');
  });

  it('comes back from a saved game, and a game saved before the cards existed has none', () => {
    gs.setPrizeCards('trainerA', [card(1), null, card(3)]);
    const saved = JSON.parse(JSON.stringify(gs.state));
    assert.deepEqual(makeGame({ saved }).state.trainerA.prizes.cards, [card(1), null, card(3), null, null, null]);

    delete saved.trainerA.prizes.cards;
    saved.trainerB.prizes.cards = 'oops';
    const loaded = makeGame({ saved });
    assert.deepEqual([loaded.state.trainerA.prizes.cards, loaded.state.trainerB.prizes.cards], [NONE, NONE]);

    saved.trainerA.prizes.cards = [card(1), 'x', { name: 12 }, card(4), card(5), card(6), card(7)];
    assert.deepEqual(makeGame({ saved }).state.trainerA.prizes.cards, [card(1), null, null, card(4), card(5), card(6)], 'what is not a card is dropped, and there are six');
  });

  describe('the action that chooses them', () => {
    it('sets them for the trainer that sends it, says what it did, and counts only the cards', () => {
      gs.state.trainerA.name = 'Ash';
      const spec = choose('trainerA', [card(1), null, card(3)]);
      spec.run(gs);
      assert.deepEqual(cardsOf('trainerA'), [card(1), null, card(3), null, null, null]);
      assert.equal(spec.label(gs), 'Ash prize cards set (2)');
      const none = choose('trainerA', []);
      none.run(gs);
      assert.equal(none.label(gs), 'Ash prize cards cleared');
      assert.deepEqual(cardsOf('trainerA'), NONE);
    });

    it('trims what it is sent, and takes a picture that is a web address or a path of this site, or none', () => {
      choose('trainerB', [{ cardId: ' a-1 ', name: '  Pikachu  ', image: 'https://img.test/p.png' }, { name: 'Local', image: '/img/sv1/1.png' }, { name: 'No picture' }, { name: 'Empty', image: '' }, null]).run(gs);
      assert.deepEqual(cardsOf('trainerB'), [
        { cardId: 'a-1', name: 'Pikachu', image: 'https://img.test/p.png' },
        { cardId: '', name: 'Local', image: '/img/sv1/1.png' },
        { cardId: '', name: 'No picture', image: '' },
        { cardId: '', name: 'Empty', image: '' },
        null, null
      ]);
    });

    it('touches the cards of that trainer and not the count, so taking a prize at the same time is no conflict', () => {
      assert.deepEqual(choose('trainerA', [card(1)]).targets(), ['trainerA.prizeCards']);
      assert.deepEqual(choose('trainerB', []).targets(), ['trainerB.prizeCards']);
      const overlaps = (a, b) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
      assert.equal(overlaps('trainerA.prizeCards', actions.resolve('action:trainerA', { action: 'prizeMinus' }).targets()[0]), false);
    });

    it('refuses what it cannot make sense of, and changes nothing', () => {
      gs.setPrizeCards('trainerA', [card(1)]);
      const before = JSON.stringify(gs.state);
      for (const cards of [undefined, null, 'cards', 7, {}, [1, 2, 3, 4, 5, 6, 7].map(card), ['Pikachu'], [7], [[]], [{}], [{ name: '' }], [{ name: 5 }], [{ name: 'x', image: 'ftp://x' }], [{ name: 'x', cardId: 5 }], [{ name: 'x', image: 5 }]]) {
        assert.throws(() => choose('trainerA', cards).run(gs), actions.ActionError, JSON.stringify(cards));
      }
      assert.equal(JSON.stringify(gs.state), before);
    });
  });
});

describe('actions', () => {
  let gs;
  beforeEach(() => {
    gs = makeGame();
  });

  const run = (event, payload) => {
    const spec = actions.resolve(event, payload);
    assert.ok(spec, `${event} ${JSON.stringify(payload)} should be a known action`);
    const announced = spec.run(gs);
    return { spec, announced, label: spec.label(gs), targets: spec.targets() };
  };

  it('ignores anything that is not a known action', () => {
    for (const [event, payload] of [
      ['action:trainerA', null],
      ['action:trainerA', {}],
      ['action:trainerA', { action: 7 }],
      ['action:trainerA', { action: 'nope' }],
      ['action:trainerA', { action: '__proto__' }],
      ['action:trainerA', { action: 'constructor' }],
      ['action:trainerA', { action: 'toString' }],
      ['action:reset', { action: 'full' }], // missing confirmation
      ['action:nothing', { action: 'prizeMinus' }]
    ]) {
      assert.equal(actions.resolve(event, payload), null, `${event} ${JSON.stringify(payload)}`);
    }
  });

  it('describes which part of the game each action touches', () => {
    assert.deepEqual(run('action:trainerA', { action: 'prizeMinus' }).targets, ['trainerA.prizes']);
    assert.deepEqual(run('action:trainerB', { action: 'energyPlus' }).targets, ['trainerB.energy']);
    assert.deepEqual(run('action:trainerA', { action: 'prizePenaltyPlus' }).targets, ['trainerA.penalty']);
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'attachSpecialEnergy', slot: -1, cardId: 'e', name: 'E' }).targets(), ['trainerA.active', 'trainerA.energy']);
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'attachSpecialEnergy', slot: 0, cardId: 'e', name: 'E', countsAsTurn: false }).targets(), ['trainerA.bench.0']);
    assert.deepEqual(actions.resolve('action:trainerB', { action: 'removeSpecialEnergy', slot: -1, index: 0 }).targets(), ['trainerB.active']);
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'benchDamage', slot: 2, amount: 10 }).targets(), ['trainerA.bench.2.hp']);
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'clearSlot', slot: -1 }).targets(), ['trainerA.active']);
    assert.deepEqual(actions.resolve('action:card', { action: 'select', target: 'trainerB-bench-3' }).targets(), ['trainerB.bench.3']);
    assert.deepEqual(actions.resolve('action:card', { action: 'select', target: 'stadium' }).targets(), ['stadium']);
    assert.deepEqual(actions.resolve('action:match', { action: 'toggleTurn' }).targets(), ['turn']);
    assert.deepEqual(actions.resolve('action:toast', { action: 'topDeck' }).targets(), ['announce.topDeck']);
    assert.deepEqual(actions.resolve('action:reset', { action: 'full', confirm: 'FULL_RESET' }).targets(), ['*']);
  });

  it('treats "last writer wins" changes as touching nothing', () => {
    for (const [event, payload] of [
      ['action:trainerA', { action: 'setName', name: 'x' }],
      ['action:trainerA', { action: 'setAbilityUsed', slot: -1, index: 0, used: true }],
      ['action:trainerA', { action: 'togglePrizeHidden', enabled: true }],
      ['action:settings', { action: 'update', overlayOpacity: 50 }],
      ['action:match', { action: 'setBestOf', bestOf: 3 }]
    ]) {
      assert.equal(actions.resolve(event, payload).targets(), null, `${event} ${payload.action}`);
    }
    // ...but the same toggle without an explicit value is relative
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'togglePrizeHidden' }).targets(), ['trainerA.flag.prize cards hidden']);
  });

  it('validates input before changing anything', () => {
    put(gs, 'trainerA', -1);
    const before = JSON.stringify(gs.state);
    for (const [event, payload] of [
      ['action:trainerA', { action: 'activeDamage', amount: 'lots' }],
      ['action:trainerA', { action: 'activeDamage', amount: 1e9 }],
      ['action:trainerA', { action: 'benchDamage', slot: 8, amount: 1 }],
      ['action:trainerA', { action: 'setName', name: 5 }],
      ['action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'plasma' }],
      ['action:trainerA', { action: 'setActive', cardId: 'x', name: 'x', image: 'ftp://x' }],
      ['action:trainerA', { action: 'prizeSet', count: 9 }],
      ['action:trainerA', { action: 'prizePenaltySet', count: 7 }],
      ['action:trainerA', { action: 'prizePenaltySet', count: 'all' }],
      ['action:trainerA', { action: 'prizePenaltySet', count: -1 }],
      ['action:trainerA', { action: 'knockOut', slot: 5, prizes: 1 }],
      ['action:match', { action: 'setBestOf', bestOf: 4 }],
      ['action:match', { action: 'endGame', winner: 'x' }],
      ['action:card', { action: 'select', target: 'nowhere', cardData: { id: 'x', name: 'x' } }],
      ['action:settings', { action: 'import', config: [] }]
    ]) {
      const spec = actions.resolve(event, payload);
      assert.throws(() => spec.run(gs), actions.ActionError, `${event} ${JSON.stringify(payload)}`);
    }
    assert.equal(JSON.stringify(gs.state), before, 'nothing changed');
  });

  it('describes changes in plain language', () => {
    gs.state.trainerA.name = 'Ash';
    assert.equal(run('action:trainerA', { action: 'prizeMinus' }).label, 'Ash prizes −1 (5 left)');
    put(gs, 'trainerB', -1, { name: 'Eevee' });
    assert.match(run('action:trainerB', { action: 'activeDamage', amount: 20 }).label, /Eevee took 20/);
    assert.match(run('action:trainerB', { action: 'attachEnergy', slot: -1, energyType: 'water', countsAsTurn: false }).label, /special attachment/);
    assert.match(run('action:trainerB', { action: 'knockOut', slot: -1, prizes: 2 }).label, /Eevee knocked out \(Ash takes 2 prizes\)/);
  });

  it('uses and gives back the GX attack and the VSTAR Power, and says so', () => {
    gs.state.trainerA.name = 'Ash';
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'gxPlus' }).targets(), ['trainerA.GX attack']);
    assert.deepEqual(actions.resolve('action:trainerB', { action: 'vstarMinus' }).targets(), ['trainerB.VSTAR Power']);
    assert.equal(run('action:trainerA', { action: 'gxPlus' }).label, 'Ash used the GX attack');
    assert.equal(gs.state.trainerA.resources.gxPerGame.used, 1);
    assert.equal(run('action:trainerA', { action: 'gxMinus' }).label, 'Ash has the GX attack again');
    assert.equal(run('action:trainerA', { action: 'vstarPlus' }).label, 'Ash used the VSTAR Power');
    assert.equal(gs.state.trainerA.resources.vstarPerGame.used, 1);
    assert.equal(run('action:trainerA', { action: 'vstarReset' }).label, 'Ash has the VSTAR Power again');
    assert.equal(gs.state.trainerA.resources.vstarPerGame.used, 0);
    run('action:trainerB', { action: 'gxPlus' });
    run('action:trainerB', { action: 'gxReset' });
    assert.equal(gs.state.trainerB.resources.gxPerGame.used, 0);
    assert.equal(actions.resolve('action:trainerA', { action: 'gxReset' }).targets(), null, 'last writer wins');
  });

  it('puts conditions on the Active Pokémon, and a click that says what it wants is not a toggle', () => {
    put(gs, 'trainerA', -1, { name: 'Pikachu' });
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'toggleStatus', condition: 'poisoned' }).targets(), ['trainerA.status']);
    assert.equal(actions.resolve('action:trainerA', { action: 'toggleStatus', condition: 'poisoned', enabled: true }).targets(), null, 'last writer wins');

    assert.equal(run('action:trainerA', { action: 'toggleStatus', condition: 'poisoned' }).label, 'Pikachu is Poisoned');
    assert.deepEqual(gs.state.trainerA.active.status, ['poisoned']);
    assert.equal(run('action:trainerA', { action: 'toggleStatus', condition: 'poisoned', enabled: true }).label, 'Pikachu is Poisoned', 'two producers agree');
    assert.deepEqual(gs.state.trainerA.active.status, ['poisoned']);
    assert.equal(run('action:trainerA', { action: 'toggleStatus', condition: 'trapped', enabled: true }).label, 'Pikachu is Trapped');
    assert.deepEqual(gs.state.trainerA.active.status, ['poisoned', 'trapped']);
    assert.equal(run('action:trainerA', { action: 'toggleStatus', condition: 'poisoned', enabled: false }).label, 'Pikachu is no longer Poisoned');
    assert.equal(run('action:trainerA', { action: 'clearStatus' }).label, 'Pikachu recovered from every special condition');
    assert.deepEqual(gs.state.trainerA.active.status, []);
  });

  it('refuses a condition the game does not have, and one for an empty Active spot', () => {
    for (const payload of [{ condition: 'sparkly' }, { condition: 7 }, {}]) {
      put(gs, 'trainerA', -1);
      assert.throws(() => actions.resolve('action:trainerA', { action: 'toggleStatus', ...payload }).run(gs), actions.ActionError, JSON.stringify(payload));
    }
    assert.throws(() => actions.resolve('action:trainerB', { action: 'toggleStatus', condition: 'asleep' }).run(gs), /no Active Pokémon/);
    assert.deepEqual(gs.state.trainerB.active.status, []);
  });

  it('applies a draft to a fork without touching the live game', () => {
    const fork = gs.fork();
    const spec = actions.resolve('action:trainerA', { action: 'prizeMinus' });
    spec.run(fork);
    assert.equal(fork.state.trainerA.prizes.count, 5);
    assert.equal(gs.state.trainerA.prizes.count, 6);
    spec.run(gs); // the same action replays on the live game
    assert.equal(gs.state.trainerA.prizes.count, 5);
  });

  it('turns a card selection into HP, abilities and image', () => {
    run('action:card', {
      action: 'select',
      target: 'trainerA-active',
      cardData: { id: 'c1', name: 'Pikachu', hp: '60', images: { small: 'https://i.test/s.png', large: 'https://i.test/l.png' }, abilities: [{ name: 'Static' }, 'Zap'] }
    });
    const active = gs.state.trainerA.active;
    assert.equal(active.image, 'https://i.test/l.png');
    assert.deepEqual(active.hp, { max: 60, current: 60 });
    assert.deepEqual(active.abilities.map((a) => a.name), ['Static', 'Zap']);
  });
});

describe('announcements', () => {
  it('builds one-shot events from the current state and settings', () => {
    const gs = makeGame();
    gs.state.trainerB.name = 'Gary';
    const topDeck = announcements.build(gs.state, 'topdeck', { target: 'trainerB' });
    assert.equal(topDeck.side, 'trainerB');
    assert.match(topDeck.subtitle, /Gary/);
    assert.equal(topDeck.toastMs, 2000, 'a banner stays two seconds by default');
    assert.equal(topDeck.animationMs, 3000);

    gs.state.settings.toastSeconds = 9;
    gs.state.settings.enableTopDeckAnimation = false;
    const toastOnly = announcements.build(gs.state, 'topdeck', {});
    assert.equal(toastOnly.toastMs, 9000);
    assert.equal(toastOnly.animationMs, 0);
    assert.equal(toastOnly.animation, false);

    gs.state.settings.enableTopDeckToast = false;
    assert.equal(announcements.build(gs.state, 'topdeck', {}), null, 'nothing to show');
  });

  it('gives an out-of-combat KO an animation but no banner', () => {
    const gs = makeGame();
    const ko = announcements.build(gs.state, 'ko', { side: 'trainerA', isOOC: true, slot: 1 });
    assert.equal(ko.toast, false);
    assert.equal(ko.animation, true);
    assert.equal(ko.toastMs, 0);
  });

  it('ignores unknown types', () => {
    assert.equal(announcements.build(makeGame().state, 'party'), null);
  });
});
