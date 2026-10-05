/**
 * Unit tests for the game state and the action registry (no server, no network).
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const GameStateService = require('../src/services/gamestate');
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

  it('sets and toggles flags and locks', () => {
    gs.setLock('trainerA', 'itemLock');
    assert.equal(gs.state.trainerA.locks.itemLock, true);
    gs.setLock('trainerA', 'itemLock', true);
    assert.equal(gs.state.trainerA.locks.itemLock, true, 'setting is idempotent');
    gs.setLock('trainerA', 'itemLock', false);
    assert.equal(gs.state.trainerA.locks.itemLock, false);

    gs.setPrizesHidden('trainerB');
    assert.equal(gs.state.trainerB.prizes.hidden, true);
    gs.setPrizesHidden('trainerB');
    assert.equal(gs.state.trainerB.prizes.hidden, false, 'with no value it toggles');
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

    for (let i = 0; i < 12; i++) gs.addFeatureCard({ cardId: `f${i}`, name: `F${i}`, image: IMG, note: '' });
    assert.equal(gs.state.featureCards.length, 10);
    const { id } = gs.state.featureCards[3];
    gs.removeFeatureCard({ id });
    assert.equal(gs.state.featureCards.some((card) => card.id === id), false);
    gs.removeFeatureCard({ id: 'does-not-exist' });
    assert.equal(gs.state.featureCards.length, 9);
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
