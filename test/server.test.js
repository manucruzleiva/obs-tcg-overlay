/**
 * Integration tests: boot the real server with a throwaway database and drive it over socket.io
 * with the same actions the control panel emits (one producer; see multi-producer.test.js for several).
 *
 * Run with: npm test
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, startMockCardApi } = require('../test-support/harness');

const IMG = 'https://img.test/card.png';

describe('server', () => {
  let server;
  let api;
  let producer;

  before(async () => {
    api = await startMockCardApi({
      '/cards/sv9-9': { data: { id: 'sv9-9', name: 'Uncached', supertype: 'Pokémon', hp: '40', set: { id: 'sv9', name: 'Test' }, images: { large: IMG } } },
      '/cards/sv1-1': {
        data: {
          id: 'sv1-1', name: 'Sprigatito', supertype: 'Pokémon', hp: '70',
          set: { id: 'sv1', name: 'Scarlet & Violet' },
          images: { large: IMG, small: IMG },
          abilities: [{ name: 'Spring Dance' }],
          attacks: [{ name: 'Scratch', damage: '10' }, { name: 'Leafage', damage: '30+' }],
          convertedRetreatCost: 1
        }
      }
    });
    server = await startServer({ env: { POKEMONTCG_API_URL: api.url } });
    producer = server.client({ clientId: 'solo-producer-1' });
    await producer.ready();
  });

  after(async () => {
    await server.stop();
    await api.close();
  });

  beforeEach(async () => {
    await producer.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
  });

  const trainer = (side, payload) => producer.act(`action:${side}`, payload);

  it('serves health and the initial state', async () => {
    const state = await (await fetch(`${server.base}/api/state`)).json();
    assert.equal(state.trainerA.name, 'Trainer A');
    assert.equal(state.trainerA.prizes.count, 6);
    assert.equal(state.matchScore.bestOf, 3);
    assert.equal(Number.isInteger(state.revision), true);
    // Announcements are events, not state
    assert.equal('trainerAToast' in state, false);
    assert.equal('topDeckAnimation' in state, false);
  });

  it('steps the per-turn counters up and down within bounds', async () => {
    for (const side of ['trainerA', 'trainerB']) {
      for (const [kind, key] of [['energy', 'energyPerTurn'], ['stadium', 'stadiumPerTurn'], ['supporter', 'supporterPerTurn']]) {
        let { state } = await trainer(side, { action: `${kind}Plus` });
        assert.equal(state[side].resources[key].used, 1);

        // capped at "available" (1 by default)
        ({ state } = await trainer(side, { action: `${kind}Plus` }));
        assert.equal(state[side].resources[key].used, 1);

        ({ state } = await trainer(side, { action: `${kind}Minus` }));
        assert.equal(state[side].resources[key].used, 0);

        // floored at zero
        ({ state } = await trainer(side, { action: `${kind}Minus` }));
        assert.equal(state[side].resources[key].used, 0);

        await trainer(side, { action: `${kind}Plus` });
        ({ state } = await trainer(side, { action: `${kind}Reset` }));
        assert.equal(state[side].resources[key].used, 0);
      }
    }
  });

  it('adjusts prizes and clamps them to 0..6', async () => {
    let last;
    for (let i = 0; i < 7; i++) last = await trainer('trainerA', { action: 'prizeMinus' });
    assert.equal(last.state.trainerA.prizes.count, 0);
    for (let i = 0; i < 7; i++) last = await trainer('trainerA', { action: 'prizePlus' });
    assert.equal(last.state.trainerA.prizes.count, 6);
  });

  it('resets both trainers prizes with resetGamePrizes', async () => {
    await trainer('trainerA', { action: 'prizeMinus' });
    await trainer('trainerB', { action: 'prizeMinus' });
    const { state } = await producer.act('action:match', { action: 'resetGamePrizes' });
    assert.equal(state.trainerA.prizes.count, 6);
    assert.equal(state.trainerB.prizes.count, 6);
  });

  it('sets and clears the active and bench slots', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });
    await trainer('trainerA', { action: 'setBench', slot: 0, cardId: 'b-1', name: 'Eevee', image: IMG, hp: 50 });

    let { state } = await trainer('trainerA', { action: 'clearSlot', slot: -1 });
    assert.equal(state.trainerA.active.name, '');
    assert.equal(state.trainerA.bench[0].name, 'Eevee');

    ({ state } = await trainer('trainerA', { action: 'clearSlot', slot: 0 }));
    assert.equal(state.trainerA.bench[0].name, '');
    assert.equal(state.trainerA.bench[0].slot, 0);
  });

  it('takes HP and ability tokens from the card data when a card is selected', async () => {
    const { state } = await producer.act('action:card', {
      action: 'select',
      target: 'trainerB-active',
      cardId: 'sv1-1',
      // what the control panel sends from a search result: no abilities in it
      cardData: { id: 'sv1-1', name: 'Sprigatito', images: { large: IMG }, hp: '70' }
    });
    const active = state.trainerB.active;
    assert.equal(active.name, 'Sprigatito');
    assert.equal(active.image, IMG);
    assert.deepEqual(active.hp, { max: 70, current: 70 });
    assert.deepEqual(active.abilities, [{ name: 'Spring Dance', used: false, scope: 'turn' }]);
    assert.ok(api.requests.includes('/cards/sv1-1'), 'the card details were looked up');
  });

  it('still selects a card when the card details cannot be fetched', async () => {
    const { state } = await producer.act('action:card', {
      action: 'select',
      target: 'trainerA-bench-1',
      cardId: 'unknown-9',
      cardData: { id: 'unknown-9', name: 'Mystery', images: { large: IMG }, hp: '40' }
    });
    assert.equal(state.trainerA.bench[1].name, 'Mystery');
    assert.deepEqual(state.trainerA.bench[1].hp, { max: 40, current: 40 });
    assert.deepEqual(state.trainerA.bench[1].abilities, []);
  });

  it('keeps the damage on an evolution and fully heals a fresh Pokémon', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Charmander', image: IMG, hp: 70 });
    await trainer('trainerA', { action: 'activeDamage', amount: 30 });

    const evolved = await producer.act('action:card', {
      action: 'select', target: 'trainerA-active', evolve: true, cardId: 'a-2',
      cardData: { id: 'a-2', name: 'Charmeleon', images: { large: IMG }, hp: '90', abilities: [] }
    });
    assert.deepEqual(evolved.state.trainerA.active.hp, { max: 90, current: 60 }); // the 30 damage carries over

    const fresh = await producer.act('action:card', {
      action: 'select', target: 'trainerA-active', cardId: 'a-3',
      cardData: { id: 'a-3', name: 'Snorlax', images: { large: IMG }, hp: '150', abilities: [] }
    });
    assert.deepEqual(fresh.state.trainerA.active.hp, { max: 150, current: 150 });
  });

  it('applies damage and healing within 0..max', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });

    let { state } = await trainer('trainerA', { action: 'activeDamage', amount: 20 });
    assert.equal(state.trainerA.active.hp.current, 40);
    ({ state } = await trainer('trainerA', { action: 'activeDamage', amount: -100 }));
    assert.equal(state.trainerA.active.hp.current, 60); // healing stops at max
    ({ state } = await trainer('trainerA', { action: 'activeDamage', amount: 500 }));
    assert.equal(state.trainerA.active.hp.current, 0);
    ({ state } = await trainer('trainerA', { action: 'setHP', slot: -1, current: 25 }));
    assert.equal(state.trainerA.active.hp.current, 25);
    ({ state } = await trainer('trainerA', { action: 'activeHeal' }));
    assert.equal(state.trainerA.active.hp.current, 60);
  });

  it('attaches energy, optionally without using the turn\'s attachment', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });

    // the default counts as the turn's energy attachment
    let { state } = await trainer('trainerA', { action: 'attachEnergy', slot: -1, energyType: 'lightning' });
    assert.deepEqual(state.trainerA.active.energies, ['lightning']);
    assert.equal(state.trainerA.resources.energyPerTurn.used, 1);

    // a special attachment (an ability or a card effect) does not
    ({ state } = await trainer('trainerA', { action: 'attachEnergy', slot: -1, energyType: 'fire', countsAsTurn: false, count: 2 }));
    assert.deepEqual(state.trainerA.active.energies, ['lightning', 'fire', 'fire']);
    assert.equal(state.trainerA.resources.energyPerTurn.used, 1);

    ({ state } = await trainer('trainerA', { action: 'removeEnergy', slot: -1, index: 0 }));
    assert.deepEqual(state.trainerA.active.energies, ['fire', 'fire']);
  });

  it('attaches Special Energy cards, shown as part of the card, up to four, and takes them off again', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });
    const card = (n) => ({ cardId: `sv-e${n}`, name: `Special ${n}`, image: IMG });

    // like basic energy, it counts as the turn's attachment unless told it does not
    let { state } = await trainer('trainerA', { action: 'attachSpecialEnergy', slot: -1, ...card(1) });
    assert.deepEqual(state.trainerA.active.specialEnergies, [card(1)]);
    assert.equal(state.trainerA.resources.energyPerTurn.used, 1);
    assert.deepEqual(state.trainerA.active.energies, [], 'it is not one of the basic types');

    ({ state } = await trainer('trainerA', { action: 'attachSpecialEnergy', slot: -1, countsAsTurn: false, ...card(2) }));
    assert.equal(state.trainerA.resources.energyPerTurn.used, 1, 'a special attachment leaves the turn\'s attachment alone');
    await trainer('trainerA', { action: 'attachSpecialEnergy', slot: -1, countsAsTurn: false, ...card(3) });
    ({ state } = await trainer('trainerA', { action: 'attachSpecialEnergy', slot: -1, countsAsTurn: false, ...card(4) }));
    assert.equal(state.trainerA.active.specialEnergies.length, 4);

    const full = await trainer('trainerA', { action: 'attachSpecialEnergy', slot: -1, countsAsTurn: false, ...card(5) });
    assert.equal(full.ok, false);
    assert.match(full.rejected.message, /as many Special Energy cards as it can show/);
    assert.equal((await (await fetch(`${server.base}/api/state`)).json()).trainerA.active.specialEnergies.length, 4);

    ({ state } = await trainer('trainerA', { action: 'removeSpecialEnergy', slot: -1, index: 1 }));
    assert.deepEqual(state.trainerA.active.specialEnergies.map((e) => e.cardId), ['sv-e1', 'sv-e3', 'sv-e4']);
    ({ state } = await trainer('trainerA', { action: 'removeSpecialEnergy', slot: -1, index: 7 }));
    assert.equal(state.trainerA.active.specialEnergies.length, 3, 'one that is not there is nothing to take off');

    // the Pokémon keeps them when it is switched with one on the bench
    await trainer('trainerA', { action: 'setBench', slot: 0, cardId: 'b-1', name: 'Eevee', image: IMG, hp: 50 });
    ({ state } = await trainer('trainerA', { action: 'swapWithActive', slot: 0 }));
    assert.equal(state.trainerA.bench[0].specialEnergies.length, 3);
    assert.deepEqual(state.trainerA.active.specialEnergies, []);

    // and loses them when the card in the slot is replaced
    ({ state } = await trainer('trainerA', { action: 'setBench', slot: 0, cardId: 'c-1', name: 'Mew', image: IMG, hp: 40 }));
    assert.deepEqual(state.trainerA.bench[0].specialEnergies, []);
  });

  it('refuses a Special Energy with nothing to attach it to, no name, or a picture that is not a web address', async () => {
    const card = { cardId: 'sv-e1', name: 'Special 1', image: IMG };
    const empty = await trainer('trainerA', { action: 'attachSpecialEnergy', slot: 3, ...card });
    assert.equal(empty.ok, false);
    assert.equal(empty.rejected.reason, 'invalid');

    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });
    for (const bad of [{ ...card, name: '' }, { ...card, cardId: '' }, { ...card, image: 'ftp://x/y.png' }, { cardId: 'a' }]) {
      const result = await trainer('trainerA', { action: 'attachSpecialEnergy', slot: -1, ...bad });
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
    assert.deepEqual((await (await fetch(`${server.base}/api/state`)).json()).trainerA.active.specialEnergies, []);
    const long = await trainer('trainerA', { action: 'attachSpecialEnergy', slot: -1, countsAsTurn: false, ...card, name: 'x'.repeat(200) });
    assert.equal(long.state.trainerA.active.specialEnergies[0].name.length, 80, 'a name that is too long is cut, like every other name');
    await trainer('trainerA', { action: 'removeSpecialEnergy', slot: -1, index: 0 });
    const none = await trainer('trainerA', { action: 'attachSpecialEnergy', slot: -1, cardId: 'sv-e1', name: 'No picture' });
    assert.equal(none.ok, true, 'a card with no picture is fine: the overlay draws a plain disc');
  });

  it('takes the attacks and the retreat cost from the card chosen, and from what a deployment says', async () => {
    // the mock card service answers the lookup with Scratch and Leafage (see the card fixtures above)
    let { state } = await producer.act('action:card', { action: 'select', target: 'trainerA-active', cardId: 'sv1-1', cardData: { id: 'sv1-1', name: 'Sprigatito', hp: '70', images: { large: IMG } } });
    assert.deepEqual(state.trainerA.active.attacks.map((attack) => [attack.name, attack.damage, attack.mod]), [['Scratch', 10, ''], ['Leafage', 30, '+']]);
    assert.equal(state.trainerA.active.retreat, 1);

    ({ state } = await trainer('trainerA', { action: 'setBench', slot: 0, cardId: 'b-1', name: 'Eevee', image: IMG, hp: 50, attacks: [{ name: 'Tackle', damage: '10' }, { name: '' }, 'Growl'], retreat: 2 }));
    assert.deepEqual(state.trainerA.bench[0].attacks, [{ name: 'Tackle', damage: 10, mod: '' }, { name: 'Growl', damage: 0, mod: '' }]);
    assert.equal(state.trainerA.bench[0].retreat, 2);

    ({ state } = await trainer('trainerA', { action: 'setRetreat', slot: 0, cost: 0 }));
    assert.equal(state.trainerA.bench[0].retreat, 0);
    assert.equal((await trainer('trainerA', { action: 'setRetreat', slot: 0, cost: 9 })).ok, false);
    assert.equal((await trainer('trainerA', { action: 'setRetreat', slot: 0, cost: 'free' })).ok, false);
  });

  it('takes damage and healing in tens only, and says so', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 100 });
    let { state } = await trainer('trainerA', { action: 'activeDamage', amount: 30 });
    assert.equal(state.trainerA.active.hp.current, 70);
    ({ state } = await trainer('trainerA', { action: 'activeDamage', amount: -20 }));
    assert.equal(state.trainerA.active.hp.current, 90);
    for (const amount of [15, 5, -25, 1, 99]) {
      const refused = await trainer('trainerA', { action: 'activeDamage', amount });
      assert.equal(refused.ok, false, String(amount));
      assert.match(refused.rejected.message, /comes in tens/);
    }
    const bench = await trainer('trainerA', { action: 'benchDamage', slot: 0, amount: 25 });
    assert.equal(bench.ok, false);
    assert.equal((await trainer('trainerA', { action: 'activeDamage', amount: 0 })).ok, true, 'nothing is a multiple of ten too');
    assert.equal((await producer.act('action:toast', { action: 'attack', attackName: 'Gnaw', damage: 25 })).ok, false, 'and so is an attack');
    assert.equal((await producer.act('action:toast', { action: 'attack', attackName: 'Gnaw', damage: 120 })).ok, true);
    assert.equal(((await fetch(`${server.base}/api/state`)).ok), true);
  });

  it('announces the victory by itself when a trainer takes their last prize card', async () => {
    // what was announced in earlier tests is not counted
    const wins = () => (producer.events.announce || []).filter((a) => a.type === 'win').length;
    const earlier = wins();
    const listener = producer.expect('announce', (announcement) => announcement.type === 'win', 6000);
    for (let i = 0; i < 5; i++) await trainer('trainerA', { action: 'prizeMinus' });
    // five taken: nobody has won yet
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(wins(), earlier, 'five of six is not a victory');

    const last = await trainer('trainerA', { action: 'prizeMinus' });
    assert.equal(last.ok, true);
    const victory = await listener;
    assert.equal(victory.type, 'win');
    assert.equal(victory.side, 'trainerA');
    assert.match(victory.subtitle, /Trainer A wins/);
    assert.ok(victory.toastMs > 0 && victory.animationMs > 0);
    assert.equal((await fetch(`${server.base}/api/state`).then((r) => r.json())).trainerA.prizes.count, 0);

    // once only: with none left there is nothing more to take, and nothing more to announce
    const after = wins();
    await trainer('trainerA', { action: 'prizeMinus' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(wins(), after, 'zero stays zero: nothing to announce');
  });

  describe('winning a game', () => {
    const score = async () => (await fetch(`${server.base}/api/state`).then((r) => r.json())).matchScore;
    const win = () => producer.expect('announce', (announcement) => announcement.type === 'win', 6000);

    beforeEach(async () => {
      await producer.act('action:match', { action: 'resetMatchScore' });
      for (const side of ['trainerA', 'trainerB']) {
        await trainer(side, { action: 'prizeReset' });
        await trainer(side, { action: 'prizePenaltySet', count: 0 });
      }
      await producer.act('action:match', { action: 'resetMatchScore' });
    });

    it('adds a game to the score of whoever takes the last prize card, in the same step as the toast, and an undo takes both back', async () => {
      for (let i = 0; i < 5; i++) await trainer('trainerA', { action: 'prizeMinus' });
      assert.deepEqual([(await score()).trainerAWins, (await score()).trainerBWins], [0, 0], 'five of six is no game won');

      const announced = win();
      const last = await trainer('trainerA', { action: 'prizeMinus' });
      assert.equal(last.ok, true);
      const victory = await announced;
      assert.equal(victory.side, 'trainerA');
      assert.equal(victory.subtitle, 'Trainer A wins the game (1–0)');
      assert.equal(last.state.matchScore.trainerAWins, 1, 'the score goes up with the toast');
      assert.equal(last.state.matchScore.trainerBWins, 0);
      const feed = await new Promise((resolve) => setTimeout(resolve, 100)).then(() => (producer.events.activity || []).filter((entry) => /won the game/.test(entry.label)));
      assert.match(feed[feed.length - 1].label, /Trainer A won the game \(1–0\)/);

      // once only: nothing more to take, nothing more to add
      await trainer('trainerA', { action: 'prizeMinus' });
      assert.equal((await score()).trainerAWins, 1);

      // (the extra minus at zero changed nothing, so it is not a step of its own)
      const undone = await producer.act('action:undo', {});
      assert.equal(undone.ok, true);
      const back = await fetch(`${server.base}/api/state`).then((r) => r.json());
      assert.deepEqual([back.trainerA.prizes.count, back.matchScore.trainerAWins], [1, 0], 'the last prize card and the game won go back together');
    });

    it('says match, not game, when it was the game that decided a best-of-three', async () => {
      await producer.act('action:match', { action: 'trainerBMatchWinPlus' });
      await trainer('trainerB', { action: 'prizeSet', count: 1 });
      const announced = win();
      await trainer('trainerB', { action: 'prizeMinus' });
      assert.equal((await announced).subtitle, 'Trainer B wins the match (2–0)');
      assert.equal((await score()).trainerBWins, 2);
    });

    it('counts the penalty of the opponent as prize cards already taken', async () => {
      await trainer('trainerA', { action: 'prizePenaltySet', count: 2 }); // Trainer A did something wrong: Trainer B needs two fewer
      for (let i = 0; i < 3; i++) await trainer('trainerB', { action: 'prizeMinus' });
      assert.equal((await score()).trainerBWins, 0, 'three taken and a penalty of two: three left, not enough yet');

      const announced = win();
      await trainer('trainerB', { action: 'prizeMinus' }); // two left, and the penalty is two
      const victory = await announced;
      assert.equal(victory.side, 'trainerB');
      assert.equal((await fetch(`${server.base}/api/state`).then((r) => r.json())).trainerB.prizes.count, 2, 'it did not need to take the last two');
      assert.equal((await score()).trainerBWins, 1);
      assert.equal((await score()).trainerAWins, 0, 'a penalty is no win for whoever has it');
    });

    it('announces the victory when the penalty is what makes the last prize cards unnecessary', async () => {
      await trainer('trainerB', { action: 'prizeSet', count: 2 });
      assert.equal((await score()).trainerBWins, 0);
      const announced = win();
      await trainer('trainerA', { action: 'prizePenaltySet', count: 2 });
      assert.equal((await announced).side, 'trainerB');
      assert.equal((await score()).trainerBWins, 1);

      // more of the same penalty while it has been won is not another game
      await trainer('trainerA', { action: 'prizePenaltyPlus' });
      assert.equal((await score()).trainerBWins, 1);
    });
  });

  describe('playing a Stadium', () => {
    const stadium = (extra = {}) => producer.act('action:card', { action: 'setStadium', cardId: 's-1', name: 'Area Zero', image: IMG, ...extra });
    const used = (result) => [result.state.trainerA.resources.stadiumPerTurn.used, result.state.trainerB.resources.stadiumPerTurn.used];

    it('uses the Stadium play of the player whose turn it is, unless it is said not to', async () => {
      await trainer('trainerB', { action: 'setTurn', isTurn: true });
      const played = await stadium();
      assert.equal(played.ok, true);
      assert.equal(played.state.stadium.name, 'Area Zero');
      assert.deepEqual(used(played), [0, 1], "Trainer B had the turn: it is Trainer B's Stadium play");
      const feed = (producer.events.activity || []).filter((entry) => /Area Zero/.test(entry.label));
      assert.match(feed[feed.length - 1].label, /Stadium → Area Zero · Trainer B used the Stadium play/);

      // not for a correction, or a Stadium an effect put there
      await producer.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
      await trainer('trainerA', { action: 'setTurn', isTurn: true });
      const free = await stadium({ consume: false });
      assert.deepEqual(used(free), [0, 0]);
      assert.equal(free.state.stadium.name, 'Area Zero');
    });

    it('uses the one of the player it says played it, whoever has the turn', async () => {
      await trainer('trainerA', { action: 'setTurn', isTurn: true });
      assert.deepEqual(used(await stadium({ playedBy: 'trainerB' })), [0, 1]);
      await producer.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
      await trainer('trainerA', { action: 'setTurn', isTurn: true });
      assert.deepEqual(used(await stadium({ playedBy: 'nobody' })), [1, 0], 'something that is not a player is the turn holder');
    });

    it('uses nothing when nobody has the turn, when there is nothing in its place, or when the play was used already', async () => {
      assert.deepEqual(used(await stadium()), [0, 0], 'nobody has the turn yet');
      assert.deepEqual(used(await producer.act('action:card', { action: 'setStadium', cardId: '', name: '', image: '' })), [0, 0], 'taking it away');

      await trainer('trainerA', { action: 'setTurn', isTurn: true });
      assert.deepEqual(used(await stadium({ cardId: 's-2', name: 'Artazon' })), [1, 0]);
      const again = await stadium({ cardId: 's-3', name: 'Mesagoza' });
      assert.deepEqual(used(again), [1, 0], 'there is one Stadium play a turn: it stays used');
      assert.equal(again.state.stadium.name, 'Mesagoza', 'and the Stadium is put there all the same');
      const feed = (producer.events.activity || []).filter((entry) => /Mesagoza/.test(entry.label));
      assert.doesNotMatch(feed[feed.length - 1].label, /used the Stadium play/, 'it does not say it used what was used');
    });

    it('takes a Stadium chosen from the picker the same way, and an undo gives back the Stadium and its play', async () => {
      await trainer('trainerA', { action: 'setTurn', isTurn: true });
      const picked = await producer.act('action:card', {
        action: 'select', target: 'stadium', cardId: 's-9', playedBy: 'trainerA',
        cardData: { id: 's-9', name: 'Training Court', hp: '', images: { small: IMG, large: IMG } }
      });
      assert.equal(picked.ok, true, JSON.stringify(picked.rejected));
      assert.equal(picked.state.stadium.name, 'Training Court');
      assert.deepEqual(used(picked), [1, 0]);

      const undone = await producer.act('action:undo', {});
      assert.equal(undone.state.stadium.name, '');
      assert.deepEqual(used(undone), [0, 0]);
    });

    it('is refused by a producer who changed the same Stadium play a moment before', async () => {
      await trainer('trainerA', { action: 'setTurn', isTurn: true });
      const other = server.client({ clientId: 'stadium-other-producer', name: 'Noa' });
      await other.ready();
      const seen = other.state.revision;
      await trainer('trainerA', { action: 'stadiumPlus' }); // somebody marks the Stadium play used first
      const late = await other.act('action:card', { action: 'setStadium', cardId: 's-5', name: 'Gym', image: IMG, playedBy: 'trainerA' }, { baseRevision: seen });
      assert.equal(late.ok, false);
      assert.equal(late.rejected.reason, 'conflict');
      other.close();
    });
  });

  describe('the cards on the prizes', () => {
    const prizeCard = (n) => ({ cardId: `sv1-${n}`, name: `Card ${n}`, image: `/img/sv1/${n}.png` });
    const NONE = [null, null, null, null, null, null];
    const stateNow = () => fetch(`${server.base}/api/state`).then((r) => r.json());
    const choose = (side, cards, options) => producer.act(`action:${side}`, { action: 'prizeCardsSet', cards }, options);

    it('puts the chosen cards on the prize cards of that trainer for everybody, says so in the feed, and an undo and a redo take them away and bring them back', async () => {
      await trainer('trainerA', { action: 'setName', name: 'Ash' });
      const set = await choose('trainerA', [prizeCard(1), prizeCard(2), null, prizeCard(4)]);
      assert.equal(set.ok, true, JSON.stringify(set.rejected));
      assert.deepEqual(set.state.trainerA.prizes.cards, [prizeCard(1), prizeCard(2), null, prizeCard(4), null, null]);
      assert.deepEqual(set.state.trainerB.prizes.cards, NONE, 'the other trainer has none');
      assert.equal(set.state.trainerA.prizes.count, 6, 'which ones are taken is still the count');
      assert.deepEqual((await stateNow()).trainerA.prizes.cards, set.state.trainerA.prizes.cards, 'the same for anybody who asks');
      const feed = (producer.events.activity || []).filter((entry) => /prize cards set/.test(entry.label));
      assert.match(feed[feed.length - 1].label, /Ash prize cards set \(3\)/);

      const undone = await producer.act('action:undo', {});
      assert.deepEqual(undone.state.trainerA.prizes.cards, NONE, 'one step');
      const redone = await producer.act('action:redo', {});
      assert.deepEqual(redone.state.trainerA.prizes.cards, [prizeCard(1), prizeCard(2), null, prizeCard(4), null, null]);

      const cleared = await choose('trainerA', []);
      assert.deepEqual(cleared.state.trainerA.prizes.cards, NONE);
      assert.match((producer.events.activity || []).filter((entry) => /prize cards cleared/.test(entry.label)).pop().label, /Ash prize cards cleared/);
    });

    it('is not a step when it changes nothing, and does not change the prizes that are left, the penalty or the hidden prizes', async () => {
      await trainer('trainerA', { action: 'prizePenaltySet', count: 1 });
      await trainer('trainerB', { action: 'prizeSet', count: 4 });
      await trainer('trainerB', { action: 'togglePrizeHidden', enabled: true });
      const set = await choose('trainerB', [prizeCard(1)]);
      assert.deepEqual([set.state.trainerB.prizes.count, set.state.trainerB.prizes.hidden, set.state.trainerA.prizes.penalty], [4, true, 1]);
      const same = await choose('trainerB', [prizeCard(1)]);
      assert.equal(same.ok, true);
      assert.deepEqual(same.state.trainerB.prizes.cards, set.state.trainerB.prizes.cards, 'the same cards again: nothing happened');
      const undone = await producer.act('action:undo', {});
      assert.deepEqual(undone.state.trainerB.prizes.cards, NONE, 'so the undo is for the cards, not for the nothing after them');
      assert.equal(undone.state.trainerB.prizes.hidden, true);
    });

    it('refuses a list that is not one, one with too many cards, and a card that is none, and changes nothing', async () => {
      await choose('trainerA', [prizeCard(1)]);
      for (const cards of [undefined, 'cards', {}, [1, 2, 3, 4, 5, 6, 7].map(prizeCard), ['Pikachu'], [{}], [{ name: 'x', image: 'ftp://x' }], [{ name: 5 }]]) {
        const refused = await choose('trainerA', cards);
        assert.equal(refused.ok, false, JSON.stringify(cards));
        assert.equal(refused.rejected.reason, 'invalid', JSON.stringify(cards));
      }
      assert.deepEqual((await stateNow()).trainerA.prizes.cards, [prizeCard(1), null, null, null, null, null]);
    });

    it('is refused by a producer who set the same cards a moment before, but not because a prize card was taken in the meantime', async () => {
      const other = server.client({ clientId: 'prize-cards-other-producer', name: 'Noa' });
      await other.ready();
      const seen = other.state.revision;
      await trainer('trainerA', { action: 'prizeMinus' }); // somebody takes a prize card
      const fine = await other.act('action:trainerA', { action: 'prizeCardsSet', cards: [prizeCard(1)] }, { baseRevision: seen });
      assert.equal(fine.ok, true, 'the count and the cards are not the same thing');
      assert.equal(fine.state.trainerA.prizes.count, 5);

      const seenAgain = other.state.revision;
      await choose('trainerA', [prizeCard(2), prizeCard(3)]); // and somebody else chooses the cards
      const late = await other.act('action:trainerA', { action: 'prizeCardsSet', cards: [prizeCard(5)] }, { baseRevision: seenAgain });
      assert.equal(late.ok, false);
      assert.equal(late.rejected.reason, 'conflict');
      assert.deepEqual((await stateNow()).trainerA.prizes.cards, [prizeCard(2), prizeCard(3), null, null, null, null]);

      // the other trainer's cards are another matter
      const aside = await other.act('action:trainerB', { action: 'prizeCardsSet', cards: [prizeCard(6)] }, { baseRevision: seenAgain });
      assert.equal(aside.ok, true);
      other.close();
    });

    it('are not chosen yet for the next game, but stay when a game is won', async () => {
      await choose('trainerA', [prizeCard(1), prizeCard(2)]);
      await choose('trainerB', [prizeCard(3)]);
      for (const side of ['trainerA', 'trainerB']) await trainer(side, { action: 'prizePenaltySet', count: 0 });
      await trainer('trainerA', { action: 'prizeSet', count: 1 });
      const won = await trainer('trainerA', { action: 'prizeMinus' });
      assert.equal(won.state.matchScore.trainerAWins, 1, 'a game was won');
      assert.deepEqual(won.state.trainerA.prizes.cards, [prizeCard(1), prizeCard(2), null, null, null, null], 'the table is as it was');

      const next = await producer.act('action:match', { action: 'nextGame' });
      assert.equal(next.ok, true, JSON.stringify(next.rejected));
      assert.deepEqual([next.state.trainerA.prizes.cards, next.state.trainerB.prizes.cards], [NONE, NONE]);
      assert.equal(next.state.trainerA.prizes.count, 6);
      const back = await producer.act('action:undo', {});
      assert.deepEqual(back.state.trainerA.prizes.cards, [prizeCard(1), prizeCard(2), null, null, null, null], 'and the next game can be undone with its cards');
    });

    it('has a state from before the cards existed, which the page and the overlay can read all the same', async () => {
      const state = await stateNow();
      for (const side of ['trainerA', 'trainerB']) assert.equal(Array.isArray(state[side].prizes.cards), true, `${side} lists its prize cards`);
    });
  });

  describe('pausing the game', () => {
    const paused = async () => (await fetch(`${server.base}/api/state`).then((r) => r.json())).paused;

    it('keeps the game paused, with no announcement, until it is resumed with a short toast', async () => {
      assert.equal(await paused(), false);
      const before = (producer.events.announce || []).length;
      const pause = await producer.act('action:match', { action: 'togglePause', enabled: true });
      assert.equal(pause.ok, true);
      assert.equal(pause.state.paused, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((producer.events.announce || []).length, before, 'pausing is no toast: its banner stays on the overlay');
      assert.equal(await paused(), true);

      // pressing it again with the same wish changes nothing (two producers agree)
      assert.equal((await producer.act('action:match', { action: 'togglePause', enabled: true })).state.paused, true);

      const resumed = producer.expect('announce', (announcement) => announcement.type === 'resume', 6000);
      const resume = await producer.act('action:match', { action: 'togglePause', enabled: false });
      assert.equal(resume.state.paused, false);
      const toast = await resumed;
      assert.deepEqual([toast.title, toast.toast, toast.animation], ['GAME RESUMED', true, false]);
      assert.ok(toast.toastMs > 0 && toast.animationMs === 0);
      assert.equal(toast.side, null);

      // resuming a game that was not paused announces nothing
      const count = (producer.events.announce || []).length;
      await producer.act('action:match', { action: 'togglePause', enabled: false });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((producer.events.announce || []).length, count);
    });

    it('says so in the activity feed, can be switched off like a banner, and is undone with the rest', async () => {
      const feed = producer.expect('activity', (entry) => entry.label === 'Game paused', 6000);
      await producer.act('action:match', { action: 'togglePause', enabled: true });
      assert.equal((await feed).label, 'Game paused');

      await producer.act('action:settings', { action: 'update', enablePauseToast: false });
      const count = (producer.events.announce || []).length;
      await producer.act('action:match', { action: 'togglePause', enabled: false });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((producer.events.announce || []).length, count, 'banner switched off: no resumed toast either');
      assert.equal(await paused(), false);

      await producer.act('action:match', { action: 'togglePause', enabled: true });
      assert.equal((await producer.act('action:undo', {})).state.paused, false, 'the pause can be undone');
    });
  });

  it('announces it whatever takes the last prize card, for the right trainer, and respects the switches', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });
    await trainer('trainerB', { action: 'prizeSet', count: 2 });
    const first = producer.expect('announce', (a) => a.type === 'win', 6000);
    await trainer('trainerA', { action: 'knockOut', slot: -1, prizes: 2 });
    const knockOut = await first;
    assert.equal(knockOut.side, 'trainerB', 'the trainer who took the cards, not the one who lost the Pokémon');

    // set to zero by hand counts too
    await trainer('trainerA', { action: 'prizeReset' });
    const second = producer.expect('announce', (a) => a.type === 'win' && a.side === 'trainerA', 6000);
    await trainer('trainerA', { action: 'prizeSet', count: 0 });
    assert.equal((await second).side, 'trainerA');

    // the banner and the effect can be switched off in the settings, like any other announcement
    await trainer('trainerB', { action: 'prizeReset' });
    await producer.act('action:settings', { action: 'update', enableTrainerBWinToast: false, enableTrainerBWinAnimation: false });
    const before = (producer.events.announce || []).length;
    await trainer('trainerB', { action: 'prizeSet', count: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((producer.events.announce || []).length, before, 'both switched off: nothing to show');
  });

  it('announces an ability like an attack, with its name, no damage and the ability sound', async () => {
    await producer.act('action:settings', { action: 'update', sound: { enabled: true } });
    await producer.act('action:match', { action: 'setTurn' }).catch(() => null);
    await trainer('trainerA', { action: 'setTurn', isTurn: true });
    const banner = producer.expect('announce', (a) => a.type === 'attack' && a.data && a.data.ability === true, 6000);
    const cue = producer.expect('sfx', (message) => message.cue === 'ability', 6000);
    assert.equal((await producer.act('action:toast', { action: 'attack', attackName: 'Static', ability: true, damage: 120 })).ok, true, 'a damage sent with an ability is ignored');
    const announced = await banner;
    assert.equal(announced.title, 'Static');
    assert.equal(announced.subtitle, 'ABILITY USED');
    assert.equal(announced.data.damage, 0);
    assert.equal(announced.side, 'trainerA', 'the trainer who uses it, not the one who is attacked');
    assert.equal((await cue).cue, 'ability');

    // an attack is as it was
    const attack = producer.expect('announce', (a) => a.type === 'attack' && a.data && a.data.ability === false && a.title === 'Gnaw', 6000);
    await producer.act('action:toast', { action: 'attack', attackName: 'Gnaw', damage: 30 });
    const plain = await attack;
    assert.equal(plain.subtitle, '30 damage');
    assert.equal(plain.side, 'trainerB');
  });

  it('plays the victory sound with it', async () => {
    await producer.act('action:settings', { action: 'update', sound: { enabled: true } });
    const cue = producer.expect('sfx', (message) => message.cue === 'win', 6000);
    await trainer('trainerA', { action: 'prizeSet', count: 0 });
    assert.equal((await cue).cue, 'win');
  });

  it('refuses to attach energy to an empty slot or an unknown type', async () => {
    const empty = await trainer('trainerA', { action: 'attachEnergy', slot: 2, energyType: 'water' });
    assert.equal(empty.ok, false);
    assert.equal(empty.rejected.reason, 'invalid');

    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });
    const unknown = await trainer('trainerA', { action: 'attachEnergy', slot: -1, energyType: 'plasma' });
    assert.equal(unknown.ok, false);
  });

  it('switches a benched Pokémon with the active one', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });
    await trainer('trainerA', { action: 'setBench', slot: 0, cardId: 'b-1', name: 'Eevee', image: IMG, hp: 50 });
    await trainer('trainerA', { action: 'activeDamage', amount: 10 });

    const { state } = await trainer('trainerA', { action: 'swapWithActive', slot: 0 });
    assert.equal(state.trainerA.active.name, 'Eevee');
    assert.deepEqual(state.trainerA.active.hp, { max: 50, current: 50 });
    assert.equal(state.trainerA.bench[0].name, 'Pikachu');
    assert.deepEqual(state.trainerA.bench[0].hp, { max: 60, current: 50 }); // keeps its own damage
    assert.equal(state.trainerA.active.slot, 'active');
    assert.equal(state.trainerA.bench[0].slot, 0);
  });

  it('knocks a Pokémon out: announces it, clears the slot and moves the opponent\'s prizes', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });

    const announced = producer.expect('announce');
    const { state } = await trainer('trainerA', { action: 'knockOut', slot: -1, prizes: 2 });
    assert.equal(state.trainerA.active.name, '');
    assert.equal(state.trainerB.prizes.count, 4);

    const announcement = await announced;
    assert.equal(announcement.type, 'ko');
    assert.equal(announcement.side, 'trainerA');
    assert.match(producer.last('activity').label, /Pikachu knocked out/);
  });

  it('refreshes the per-turn limits and once-per-turn abilities when the turn passes', async () => {
    await trainer('trainerA', { action: 'setTurn', isTurn: true });
    await trainer('trainerB', { action: 'setActive', cardId: 'b-1', name: 'Eevee', image: IMG, hp: 50, abilities: ['Adaptive Evolution'] });
    await trainer('trainerB', { action: 'addAbility', slot: -1, name: 'VSTAR Power', scope: 'game' });
    await trainer('trainerB', { action: 'setAbilityUsed', slot: -1, index: 0, used: true });
    await trainer('trainerB', { action: 'setAbilityUsed', slot: -1, index: 1, used: true });
    await trainer('trainerB', { action: 'energyPlus' });
    await trainer('trainerB', { action: 'supporterPlus' });

    // trainer B's turn begins
    const { state } = await producer.act('action:match', { action: 'toggleTurn' });
    assert.equal(state.trainerB.isTurn, true);
    assert.equal(state.trainerB.resources.energyPerTurn.used, 0);
    assert.equal(state.trainerB.resources.supporterPerTurn.used, 0);
    assert.equal(state.trainerB.active.abilities[0].used, false); // once per turn: ready again
    assert.equal(state.trainerB.active.abilities[1].used, true); // once per game: stays used
  });

  it('manages ability tokens', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60, abilities: ['Static'] });

    let { state } = await trainer('trainerA', { action: 'setAbilityUsed', slot: -1, index: 0, used: true });
    assert.equal(state.trainerA.active.abilities[0].used, true);
    // setting the same value again is harmless (two producers can agree)
    ({ state } = await trainer('trainerA', { action: 'setAbilityUsed', slot: -1, index: 0, used: true }));
    assert.equal(state.trainerA.active.abilities[0].used, true);

    ({ state } = await trainer('trainerA', { action: 'addAbility', slot: -1, name: 'Extra', scope: 'turn' }));
    assert.equal(state.trainerA.active.abilities.length, 2);

    ({ state } = await trainer('trainerA', { action: 'resetAbilities' }));
    assert.equal(state.trainerA.active.abilities[0].used, false);

    ({ state } = await trainer('trainerA', { action: 'removeAbility', slot: -1, index: 1 }));
    assert.deepEqual(state.trainerA.active.abilities.map((a) => a.name), ['Static']);

    const missing = await trainer('trainerA', { action: 'setAbilityUsed', slot: -1, index: 3, used: true });
    assert.equal(missing.ok, false);
  });

  it('adds feature cards and toggles favorites', async () => {
    // (a client that still sends a note is not refused: the note is simply not kept)
    let { state } = await producer.act('action:card', { action: 'addFeatureCard', cardId: 'f-1', name: 'Charizard', image: IMG, note: 'big' });
    assert.equal(state.featureCards.length, 1);
    assert.equal(typeof state.featureCards[0].id, 'string');
    assert.equal('note' in state.featureCards[0], false, 'a feature card has no note');

    ({ state } = await producer.act('action:card', { action: 'removeFeatureCard', id: state.featureCards[0].id }));
    assert.equal(state.featureCards.length, 0);

    ({ state } = await producer.act('action:card', { action: 'favorite', cardId: 'f-1' }));
    assert.deepEqual(state.favoriteCardIds, ['f-1']);
    assert.deepEqual(await (await fetch(`${server.base}/api/favorites`)).json(), ['f-1']);

    ({ state } = await producer.act('action:card', { action: 'favorite', cardId: 'f-1' }));
    assert.deepEqual(state.favoriteCardIds, []);
  });

  it('records a finished match without dropping the score update', async () => {
    // games won earlier in this file (a trainer taking the last prize card adds a win) are not part of this one
    await producer.act('action:match', { action: 'resetMatchScore' });
    const earlier = (await (await fetch(`${server.base}/api/matches`)).json()).length;
    let { state } = await producer.act('action:match', { action: 'trainerAMatchWinPlus' });
    assert.equal(state.matchScore.trainerAWins, 1);

    // second win in a best-of-3 ends the match and writes match history
    ({ state } = await producer.act('action:match', { action: 'trainerAMatchWinPlus' }));
    assert.equal(state.matchScore.trainerAWins, 2);

    const matches = await (await fetch(`${server.base}/api/matches`)).json();
    assert.equal(matches.length, earlier + 1);
    assert.equal(matches[0].winner, 'trainerA');
    assert.equal(matches[0].player_wins, 2);
    assert.equal('state' in matches[0], false, 'the list leaves out the saved game states');

    ({ state } = await producer.act('action:match', { action: 'trainerAMatchWinMinus' }));
    assert.equal(state.matchScore.trainerAWins, 1);
  });

  it('keeps the card API key secret', async () => {
    const { state } = await producer.act('action:settings', { action: 'setApiKey', apiKey: 'abc123' });
    assert.equal('apiKey' in state.settings, false);
    assert.equal(state.settings.apiKeySet, true);
    assert.equal('action' in state.settings, false, 'the action name is not stored as a setting');

    const rest = await (await fetch(`${server.base}/api/state`)).json();
    assert.equal('apiKey' in rest.settings, false);
    assert.doesNotMatch(JSON.stringify(rest), /abc123/);

    // ...but it is used: it reaches the card API as a request header
    await fetch(`${server.base}/api/cards/sv9-9`);
    assert.equal(api.headers[api.headers.length - 1]['x-api-key'], 'abc123');
  });

  it('switches overlay elements on and off, ignoring unknown options', async () => {
    const { state } = await producer.act('action:settings', {
      action: 'update',
      display: { nationality: false, abilityTokens: false, notAnOption: false, hpBars: 'no' }
    });
    assert.equal(state.settings.display.nationality, false);
    assert.equal(state.settings.display.abilityTokens, false);
    assert.equal(state.settings.display.hpBars, true, 'a non-boolean is ignored');
    assert.equal('notAnOption' in state.settings.display, false);
    assert.equal(state.settings.display.trainerName, true, 'untouched options keep their value');
  });

  it('sends announcements to every screen as events, not as state', async () => {
    const overlay = server.client({ role: 'overlay', clientId: 'overlay-screen-1' });
    await overlay.ready();

    const onProducer = producer.expect('announce');
    const onOverlay = overlay.expect('announce');
    const { state } = await producer.act('action:toast', { action: 'topDeck', target: 'trainerB' });

    const [a, b] = await Promise.all([onProducer, onOverlay]);
    assert.equal(a.type, 'topdeck');
    assert.equal(a.side, 'trainerB');
    assert.equal(a.toast, true);
    assert.equal(a.animation, true);
    assert.equal(a.id, b.id);
    assert.equal('topDeckAnimation' in state, false);

    // a screen that connects later does not replay it
    const late = server.client({ role: 'overlay', clientId: 'overlay-screen-2' });
    await late.ready();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((late.events.announce || []).length, 0);
  });

  it('stays silent when an announcement is switched off', async () => {
    await producer.act('action:settings', { action: 'update', enableTopDeckToast: false, enableTopDeckAnimation: false });
    const before = (producer.events.announce || []).length;
    await producer.act('action:toast', { action: 'topDeck', target: 'trainerA' });
    assert.equal((producer.events.announce || []).length, before);
  });

  it('survives every action the control panel can emit', async () => {
    await trainer('trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 60 });
    await trainer('trainerB', { action: 'setActive', cardId: 'b-1', name: 'Eevee', image: IMG, hp: 50 });

    const perSide = [
      { action: 'setName', name: 'Ash' },
      { action: 'setNationality', nationality: 'US' },
      { action: 'toggleItemLock' },
      { action: 'toggleEvoLock' },
      { action: 'toggleItemLock', enabled: false },
      { action: 'togglePrizeHidden' },
      { action: 'prizePenaltyPlus' },
      { action: 'prizePenaltyMinus' },
      { action: 'prizePenaltySet', count: 2 },
      { action: 'prizeSet', count: 4 },
      { action: 'prizeReset' },
      { action: 'benchSizePlus' },
      { action: 'benchSizeMinus' },
      { action: 'benchSizeReset' },
      { action: 'activeHeal' },
      { action: 'activeDamage', slot: -1, amount: 10 },
      { action: 'benchDamage', slot: 0, amount: 10 },
      { action: 'benchHeal', slot: 0 },
      { action: 'setMaxHP', slot: -1, max: 80 },
      { action: 'energyReset' },
      { action: 'stadiumReset' },
      { action: 'supporterReset' },
      { action: 'setTurn', isTurn: true }
    ];
    for (const side of ['trainerA', 'trainerB']) {
      for (const payload of perSide) {
        const result = await trainer(side, payload);
        assert.equal(result.ok, true, `${side} ${payload.action}: ${JSON.stringify(result.rejected)}`);
      }
    }

    for (const action of ['toggleTurn', 'resetMatchScore', 'trainerBMatchWinPlus', 'trainerBMatchWinMinus', 'startGame']) {
      assert.equal((await producer.act('action:match', { action })).ok, true, action);
    }
    assert.equal((await producer.act('action:match', { action: 'setBestOf', bestOf: 5 })).ok, true);

    for (const action of ['topDeck', 'passTurn', 'startGame', 'trainerAWin', 'trainerBWin']) {
      assert.equal((await producer.act('action:toast', { action })).ok, true, action);
    }
    await producer.act('action:toast', { action: 'attack', attackName: 'Thunderbolt', damage: 90 });
    await producer.act('action:toast', { action: 'trainerAKO', isOOC: false, slot: -1 });
    await producer.act('action:toast', { action: 'trainerBKO', isOOC: true, slot: 0 });

    assert.equal((await fetch(`${server.base}/api/health`)).status, 200);
  });

  it('rejects invalid input with a reason and keeps running', async () => {
    const bad = [
      ['action:trainerA', { action: 'activeDamage', amount: 'lots' }],
      ['action:trainerA', { action: 'benchDamage', slot: 99, amount: 5 }],
      ['action:trainerA', { action: 'setName', name: 42 }],
      ['action:trainerA', { action: 'setActive', cardId: 'x', name: 'x', image: 'javascript:alert(1)' }],
      ['action:match', { action: 'setBestOf', bestOf: 2 }],
      ['action:match', { action: 'endGame', winner: 'nobody' }],
      ['action:card', { action: 'select', cardId: 'x', cardData: { name: 'n' } }]
    ];
    for (const [event, payload] of bad) {
      const result = await producer.act(event, payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
      assert.equal(result.rejected.reason, 'invalid', JSON.stringify(payload));
    }

    // things that are not actions at all are ignored without a reply
    for (const event of ['action:trainerA', 'action:trainerB', 'action:match', 'action:toast', 'action:card', 'action:settings', 'action:reset']) {
      producer.emit(event, null);
      producer.emit(event, 'not-an-object');
      producer.emit(event, { action: 'doesNotExist' });
      producer.emit(event, { action: '__proto__' });
      producer.emit(event, { action: 'constructor' });
    }
    const alive = await trainer('trainerA', { action: 'setName', name: 'still alive' });
    assert.equal(alive.ok, true);
    assert.equal((await fetch(`${server.base}/api/health`)).status, 200);
  });

  it('exports and re-imports the configuration without the API key', async () => {
    await trainer('trainerA', { action: 'setName', name: 'Export Me' });
    await producer.act('action:settings', { action: 'setApiKey', apiKey: 'super-secret' });
    const exported = await (await fetch(`${server.base}/api/config/export`)).json();
    assert.equal(exported.trainerA.name, 'Export Me');
    assert.equal(exported.settings.apiKey, '');
    assert.doesNotMatch(JSON.stringify(exported), /super-secret/);

    const res = await fetch(`${server.base}/api/config/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exported)
    });
    assert.equal(res.status, 200);
    const state = await (await fetch(`${server.base}/api/state`)).json();
    assert.equal(state.trainerA.name, 'Export Me');
  });

  it('serves the control panel, the overlay and their assets', async () => {
    const root = await fetch(`${server.base}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/control');

    for (const page of ['/control', '/overlay']) {
      const res = await fetch(`${server.base}${page}`);
      assert.equal(res.status, 200, page);
      assert.match(res.headers.get('content-type'), /text\/html/);
    }

    const assets = [
      '/js/control/app.js', '/js/control/library.js', '/js/control/settings.js', '/js/overlay.js', '/js/login.js', '/js/sfx.js',
      '/css/control.css', '/css/overlay.css', '/css/tokens.css', '/css/login.css',
      '/js/display-options.js', '/js/game-data.js', '/js/countries.js', '/js/brand.js', '/js/sound-options.js', '/js/theme-options.js', '/socket.io/socket.io.js'
    ];
    for (const asset of assets) {
      assert.equal((await fetch(`${server.base}${asset}`)).status, 200, asset);
    }
  });

  it('sets security headers and rejects bad API requests cleanly', async () => {
    const res = await fetch(`${server.base}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.doesNotMatch(csp, /upgrade-insecure-requests/, 'the app is served over plain http on a local network');

    assert.equal((await fetch(`${server.base}/api/cards/search`)).status, 400);
    assert.equal((await fetch(`${server.base}/api/evolution/search`)).status, 400);
    assert.equal((await fetch(`${server.base}/api/does-not-exist`)).status, 404);
  });

  it('reports how to reach the control panel and overlay', async () => {
    const info = await (await fetch(`${server.base}/api/network`)).json();
    assert.equal(info.port, server.port);
    assert.equal(info.local.control, `http://localhost:${server.port}/control`);
    assert.equal(info.local.overlay, `http://localhost:${server.port}/overlay`);
    // These tests bind to 127.0.0.1, so nothing is shared with other devices
    assert.equal(info.shared, false);
    assert.deepEqual(info.lan, []);
  });
});
