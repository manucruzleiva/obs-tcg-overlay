/**
 * What can happen to a Pokémon on the table: an Item played as a Pokémon, evolving and going back, Pokémon Tools, moving damage, several
 * knocked out at once, and a trainer with no Pokémon left losing the game.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wait } = require('../test-support/harness');

const IMG = '/art/test.svg';

describe('Pokémon on the table', () => {
  let server;
  let me;

  before(async () => {
    server = await startServer({ label: 'pokemon-moves' });
    me = server.client({ clientId: 'moves-producer-01', name: 'Maya' });
    await me.ready();
  });
  after(() => server.stop());

  const reset = () => me.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
  const act = (side, payload) => me.act(`action:${side}`, payload);
  const state = async () => (await fetch(`${server.base}/api/state`)).json();
  const mon = (slot, name, hp = 100, extra = {}) => ({ action: slot === -1 ? 'setActive' : 'setBench', slot, cardId: `${name}-id`, name, image: IMG, hp, ...extra });
  const place = async (side, slot, name, hp, extra) => (await act(side, mon(slot, name, hp, extra))).state;

  beforeEach(async () => { await reset(); });

  describe('an Item card played as a Pokémon (a Fossil, a Doll)', () => {
    it('is a 60 HP Pokémon when the sender says it is played as one, and has no HP otherwise', async () => {
      const card = { id: 'fossil-1', name: 'Antique Sail Fossil', images: { small: IMG }, source: 'pokemontcg' };
      let result = await me.act('action:card', { action: 'select', target: 'trainerA-active', cardId: 'fossil-1', cardData: { ...card, abilities: [], attacks: [], retreat: 1 }, asPokemon: true });
      assert.equal(result.ok, true);
      assert.deepEqual([result.state.trainerA.active.name, result.state.trainerA.active.hp], ['Antique Sail Fossil', { max: 60, current: 60 }]);
      assert.equal(result.state.trainerA.active.retreat, 1);

      result = await me.act('action:card', { action: 'select', target: 'trainerB-bench-0', cardId: 'doll-1', cardData: { id: 'doll-1', name: 'Snorlax Doll', hp: '100', images: { small: IMG }, abilities: [], attacks: [], retreat: 0 }, asPokemon: true });
      assert.equal(result.state.trainerB.bench[0].hp.max, 100, 'a card that has HP keeps it');

      result = await me.act('action:card', { action: 'select', target: 'trainerB-bench-1', cardId: 'item-2', cardData: { ...card, id: 'item-2', abilities: [], attacks: [], retreat: 0 } });
      assert.equal(result.state.trainerB.bench[1].hp.max, 0, 'an ordinary pick of a card with no HP stays without');
    });
  });

  describe('evolving and going back', () => {
    const evolve = (target, name, hp) => me.act('action:card', { action: 'select', target, cardId: `${name}-id`, cardData: { id: `${name}-id`, name, hp: String(hp), images: { small: IMG }, abilities: [], attacks: [{ name: `${name} attack`, damage: '30' }], retreat: 1 }, evolve: true });

    it('remembers each stage, keeps the energy, the tools and the damage, and goes back one stage at a time', async () => {
      await place('trainerA', -1, 'Pichu', 40);
      await act('trainerA', { action: 'attachEnergy', slot: -1, energyType: 'lightning', count: 2 });
      await act('trainerA', { action: 'attachTool', slot: -1, cardId: 'tool-1', name: 'Brave Charm', image: IMG, hp: 50 });
      await act('trainerA', { action: 'activeDamage', amount: 30 });
      await act('trainerA', { action: 'toggleStatus', condition: 'poisoned', enabled: true });
      assert.deepEqual((await state()).trainerA.active.hp, { max: 90, current: 60 });

      let result = await evolve('trainerA-active', 'Pikachu', 60);
      let active = result.state.trainerA.active;
      assert.deepEqual([active.name, active.hp, active.energies, active.tools.length, active.status], ['Pikachu', { max: 110, current: 80 }, ['lightning', 'lightning'], 1, []], 'the tool\'s 50 HP stays; 30 damage; no condition after evolving');
      assert.deepEqual(active.stages.map((stage) => stage.name), ['Pichu']);

      result = await evolve('trainerA-active', 'Raichu', 100);
      active = result.state.trainerA.active;
      assert.deepEqual([active.name, active.hp], ['Raichu', { max: 150, current: 120 }]);
      assert.deepEqual(active.stages.map((stage) => stage.name), ['Pichu', 'Pikachu']);
      assert.equal(active.attacks[0].name, 'Raichu attack');

      result = await act('trainerA', { action: 'devolve', slot: -1 });
      assert.equal(result.ok, true);
      active = result.state.trainerA.active;
      assert.deepEqual([active.name, active.hp, active.energies.length, active.tools.length], ['Pikachu', { max: 110, current: 80 }, 2, 1]);
      assert.equal(active.attacks[0].name, 'Pikachu attack', 'the attacks of that card');
      assert.deepEqual(active.stages.map((stage) => stage.name), ['Pichu']);
      assert.match((await me.events.activity.at(-1)).label, /Raichu went back to Pikachu/);

      result = await act('trainerA', { action: 'devolve', slot: -1 });
      assert.deepEqual([result.state.trainerA.active.name, result.state.trainerA.active.hp, result.state.trainerA.active.stages], ['Pichu', { max: 90, current: 60 }, []]);

      const nothing = await act('trainerA', { action: 'devolve', slot: -1 });
      assert.equal(nothing.ok, false);
      assert.match(nothing.rejected.message, /no earlier card on file for Pichu/);
    });

    it('knows what a card says it evolves from, keeps that for each stage, and shows it again when it goes back', async () => {
      const put = (name, from, hp, extra = {}) => me.act('action:card', { action: 'select', target: 'trainerA-active', cardId: `${name}-id`, cardData: { id: `${name}-id`, name, hp: String(hp), images: { small: IMG }, abilities: [], attacks: [], retreat: 0, evolvesFrom: from }, ...extra });
      let result = await put('Pikachu', 'Pichu', 60);
      assert.equal(result.state.trainerA.active.evolvesFrom, 'Pichu', 'a Pokémon put there directly, as the stage it is: nothing on file, but the card says what it came from');
      assert.deepEqual(result.state.trainerA.active.stages, []);

      result = await put('Raichu', 'Pikachu', 100, { evolve: true });
      assert.deepEqual([result.state.trainerA.active.evolvesFrom, result.state.trainerA.active.stages.map((stage) => [stage.name, stage.evolvesFrom])], ['Pikachu', [['Pikachu', 'Pichu']]]);

      result = await act('trainerA', { action: 'devolve', slot: -1 });
      assert.deepEqual([result.state.trainerA.active.name, result.state.trainerA.active.evolvesFrom], ['Pikachu', 'Pichu'], 'back to the card on file, which knows what it evolves from');

      result = await put('Eevee', '', 60);
      assert.equal(result.state.trainerA.active.evolvesFrom, '', 'a Basic Pokémon evolves from nothing');
      result = await act('trainerA', mon(-1, 'Mew', 70));
      assert.equal(result.state.trainerA.active.evolvesFrom, '', 'and a Pokémon put there by hand knows nothing');
    });

    it('does not remember anything for a Pokémon that is put there fresh, or when the slot is empty', async () => {
      await place('trainerA', 0, 'Eevee', 60);
      await evolve('trainerA-bench-0', 'Jolteon', 90);
      assert.equal((await state()).trainerA.bench[0].stages.length, 1);
      await place('trainerA', 0, 'Mew', 70);
      assert.deepEqual((await state()).trainerA.bench[0].stages, [], 'a Pokémon that is deployed anew has no earlier stages');
      const empty = await act('trainerA', { action: 'devolve', slot: 3 });
      assert.equal(empty.ok, false);
      assert.match(empty.rejected.message, /no Pokémon in that slot/);
    });
  });

  describe('Pokémon Tools', () => {
    it('go on a Pokémon of the bench too, add to its maximum HP, and take it away again when they go', async () => {
      await place('trainerB', 2, 'Absol', 100);
      await act('trainerB', { action: 'benchDamage', slot: 2, amount: 40 });
      let result = await act('trainerB', { action: 'attachTool', slot: 2, cardId: 'bc', name: 'Bravery Charm', image: IMG, hp: 50 });
      assert.equal(result.ok, true);
      let absol = result.state.trainerB.bench[2];
      assert.deepEqual([absol.tools, absol.hp], [[{ cardId: 'bc', name: 'Bravery Charm', image: IMG, hp: 50 }], { max: 150, current: 110 }]);
      assert.match((await me.events.activity.at(-1)).label, /Bravery Charm attached to Absol \(\+50 HP\)/);

      result = await act('trainerB', { action: 'attachTool', slot: 2, cardId: 'ft', name: 'Float Stone', image: IMG });
      absol = result.state.trainerB.bench[2];
      assert.deepEqual([absol.tools.length, absol.hp.max], [2, 150], 'a tool that adds nothing leaves the HP alone');

      result = await act('trainerB', { action: 'removeTool', slot: 2, index: 0 });
      absol = result.state.trainerB.bench[2];
      assert.deepEqual([absol.tools.map((tool) => tool.name), absol.hp], [['Float Stone'], { max: 100, current: 60 }], 'the damage counters stay: 40 damage on 100 HP');

      const missing = await act('trainerB', { action: 'removeTool', slot: 2, index: 5 });
      assert.equal(missing.ok, false);
      assert.match(missing.rejected.message, /no such tool/);
    });

    it('are at most three, and are refused for an empty slot, a bonus that is not in tens or a card with no name', async () => {
      await place('trainerA', -1, 'Pikachu', 60);
      for (const name of ['One', 'Two', 'Three']) assert.equal((await act('trainerA', { action: 'attachTool', slot: -1, cardId: name, name, image: IMG })).ok, true);
      const full = await act('trainerA', { action: 'attachTool', slot: -1, cardId: 'x', name: 'Four', image: IMG });
      assert.equal(full.ok, false);
      assert.match(full.rejected.message, /already has as many Pokémon Tools as it can hold/);
      assert.equal((await act('trainerB', { action: 'attachTool', slot: -1, cardId: 'x', name: 'Tool', image: IMG })).ok, false, 'no Pokémon there');
      assert.match((await act('trainerA', { action: 'attachTool', slot: -1, cardId: 'x', name: 'Odd', image: IMG, hp: 15 })).rejected.message, /comes in tens/);
      assert.equal((await act('trainerA', { action: 'attachTool', slot: -1, cardId: 'x', name: '', image: IMG })).ok, false);
      assert.equal((await state()).trainerA.active.tools.length, 3);
    });
  });

  describe('the maximum HP', () => {
    it('can be changed with the damage kept (10 more maximum HP is 10 more HP) or without', async () => {
      await place('trainerA', -1, 'Pikachu', 100);
      await act('trainerA', { action: 'activeDamage', amount: 30 });
      let result = await act('trainerA', { action: 'setMaxHP', slot: -1, max: 120, keepDamage: true });
      assert.deepEqual(result.state.trainerA.active.hp, { max: 120, current: 90 }, 'still 30 damage');
      result = await act('trainerA', { action: 'setMaxHP', slot: -1, max: 100, keepDamage: true });
      assert.deepEqual(result.state.trainerA.active.hp, { max: 100, current: 70 });
      result = await act('trainerA', { action: 'setMaxHP', slot: -1, max: 150 });
      assert.deepEqual(result.state.trainerA.active.hp, { max: 150, current: 70 }, 'as it always was: only the maximum changes');
      result = await act('trainerA', { action: 'setMaxHP', slot: -1, max: 50, keepDamage: true });
      assert.deepEqual(result.state.trainerA.active.hp, { max: 50, current: 0 }, 'never below nothing');
    });
  });

  describe('the feature cards in another order', () => {
    const card = (name) => me.act('action:card', { action: 'addFeatureCard', cardId: name, name, image: IMG });
    const names = async () => (await state()).featureCards.map((entry) => entry.separator || entry.name);
    const idOf = async (label) => (await state()).featureCards.find((entry) => (entry.separator || entry.name) === label).id;

    it('puts a card or a sign at the place it is moved to, and a sign can be added at a place', async () => {
      for (const name of ['Boss Orders', 'Ultra Ball', 'Iono']) await card(name);
      assert.deepEqual(await names(), ['Boss Orders', 'Ultra Ball', 'Iono']);

      let result = await me.act('action:card', { action: 'moveFeature', id: await idOf('Iono'), to: 0 });
      assert.equal(result.ok, true);
      assert.deepEqual(await names(), ['Iono', 'Boss Orders', 'Ultra Ball']);
      await me.act('action:card', { action: 'moveFeature', id: await idOf('Iono'), to: 5 });
      assert.deepEqual(await names(), ['Boss Orders', 'Ultra Ball', 'Iono'], 'a place after the end is the end');

      // signs go where they are put
      await me.act('action:card', { action: 'addFeatureSeparator', symbol: '+', at: 1 });
      await me.act('action:card', { action: 'addFeatureSeparator', symbol: '→', at: 3 });
      await me.act('action:card', { action: 'addFeatureSeparator', symbol: '=' });
      assert.deepEqual(await names(), ['Boss Orders', '+', 'Ultra Ball', '→', 'Iono', '=']);
      result = await me.act('action:card', { action: 'moveFeature', id: await idOf('+'), to: 4 });
      assert.deepEqual(await names(), ['Boss Orders', 'Ultra Ball', '→', 'Iono', '+', '=']);
      assert.match(me.events.activity.at(-1).label, /Feature cards: \+ moved/);
    });

    it('refuses an entry that is not there and a place that makes no sense, changing nothing', async () => {
      await card('Boss Orders');
      const before = await state();
      for (const payload of [{ id: 'nobody', to: 0 }, { id: before.featureCards[0].id, to: -1 }, { id: before.featureCards[0].id, to: 99 }, { id: before.featureCards[0].id }, {}]) {
        const refused = await me.act('action:card', { action: 'moveFeature', ...payload });
        assert.equal(refused.ok, false, JSON.stringify(payload));
      }
      assert.equal((await me.act('action:card', { action: 'addFeatureSeparator', symbol: '+', at: -2 })).ok, false);
      assert.deepEqual((await state()).featureCards, before.featureCards);
    });
  });

  describe('moving damage', () => {
    it('heals the first Pokémon and damages the second by the same amount, whoever they belong to and wherever they are', async () => {
      await place('trainerA', -1, 'Pikachu', 100);
      await place('trainerA', 1, 'Eevee', 60);
      await place('trainerB', -1, 'Charizard', 200);
      await act('trainerA', { action: 'activeDamage', amount: 70 });

      // from the Active Pokémon to the bench of the same trainer
      let result = await me.act('action:match', { action: 'moveDamage', from: { side: 'trainerA', slot: -1 }, to: { side: 'trainerA', slot: 1 }, amount: 40 });
      assert.equal(result.ok, true, JSON.stringify(result.rejected));
      assert.deepEqual([result.state.trainerA.active.hp.current, result.state.trainerA.bench[1].hp.current], [70, 20]);
      assert.match(me.events.activity.at(-1).label, /Moved 40 damage from Pikachu \(Trainer A\) to Eevee \(Trainer A\)/);

      // to the opponent
      result = await me.act('action:match', { action: 'moveDamage', from: { side: 'trainerA', slot: -1 }, to: { side: 'trainerB', slot: -1 }, amount: 30 });
      assert.deepEqual([result.state.trainerA.active.hp.current, result.state.trainerB.active.hp.current], [100, 170]);

      // and the other way: from the opponent's Pokémon to one of the bench
      await act('trainerB', { action: 'activeDamage', amount: 10 }); // 160 left
      result = await me.act('action:match', { action: 'moveDamage', from: { side: 'trainerB', slot: -1 }, to: { side: 'trainerA', slot: 1 }, amount: 20 });
      assert.deepEqual([result.state.trainerB.active.hp.current, result.state.trainerA.bench[1].hp.current], [180, 0]);
    });

    it('never moves more than the first Pokémon has taken, and says so when there is nothing to move or the request is wrong', async () => {
      await place('trainerA', -1, 'Pikachu', 100);
      await place('trainerB', -1, 'Charizard', 200);
      await act('trainerA', { action: 'activeDamage', amount: 20 });
      const result = await me.act('action:match', { action: 'moveDamage', from: { side: 'trainerA', slot: -1 }, to: { side: 'trainerB', slot: -1 }, amount: 90 });
      assert.deepEqual([result.state.trainerA.active.hp.current, result.state.trainerB.active.hp.current], [100, 180], 'only the 20 it had taken');
      assert.match(me.events.activity.at(-1).label, /Moved 20 damage/);

      const bad = async (payload, pattern) => {
        const refused = await me.act('action:match', { action: 'moveDamage', ...payload });
        assert.equal(refused.ok, false, JSON.stringify(payload));
        assert.match(refused.rejected.message, pattern);
      };
      const A = { side: 'trainerA', slot: -1 };
      const B = { side: 'trainerB', slot: -1 };
      await bad({ from: A, to: B, amount: 10 }, /has no damage to move/);
      await act('trainerA', { action: 'activeDamage', amount: 30 });
      await bad({ from: A, to: A, amount: 10 }, /another Pokémon/);
      await bad({ from: A, to: B, amount: 15 }, /comes in tens/);
      await bad({ from: A, to: B, amount: 0 }, /from 10 to 9999/);
      await bad({ from: A, to: { side: 'trainerB', slot: 3 }, amount: 10 }, /no Pokémon in that slot/);
      await bad({ from: A, to: { side: 'nobody', slot: -1 }, amount: 10 }, /say whose Pokémon/);
      await bad({ to: B, amount: 10 }, /say whose Pokémon/);
    });
  });

  describe('knocking out several at once', () => {
    it('takes them all off the table, gives each other trainer their prize cards, and announces it once', async () => {
      await place('trainerA', -1, 'Pikachu ex', 200);
      await place('trainerA', 0, 'Eevee', 60);
      await place('trainerB', -1, 'Charizard ex', 330);
      await place('trainerB', 1, 'Pidgey', 50);
      await place('trainerB', 2, 'Rattata', 50);
      const announced = me.expect('announce', (announcement) => announcement.type === 'ko');
      const result = await me.act('action:match', { action: 'knockOutMany', knockouts: [
        { side: 'trainerA', slot: -1, prizes: 2 }, { side: 'trainerB', slot: 1, prizes: 1 }, { side: 'trainerB', slot: 2 }
      ] });
      assert.equal(result.ok, true, JSON.stringify(result.rejected));
      const { trainerA, trainerB } = result.state;
      assert.deepEqual([trainerA.active.name, trainerA.bench[0].name], ['', 'Eevee']);
      assert.deepEqual([trainerB.active.name, trainerB.bench[1].name, trainerB.bench[2].name], ['Charizard ex', '', '']);
      assert.deepEqual([trainerA.prizes.count, trainerB.prizes.count], [6 - 2, 6 - 2], 'B takes 2 for the Pikachu ex; A takes 1 and 1 (the default) for the two of B');
      const ko = await announced;
      assert.deepEqual([ko.title, ko.side], ['TRIPLE KO!', null], 'one banner, for both trainers');
      assert.equal(ko.subtitle, 'Pikachu ex · Pidgey · Rattata');
      assert.match(me.events.activity.at(-1).label, /Pikachu ex and Pidgey and Rattata knocked out \(Gary takes 2 prizes, Ash takes 2 prizes\)|Pikachu ex and Pidgey and Rattata knocked out \(Trainer B takes 2 prizes, Trainer A takes 2 prizes\)/);
    });

    it('can leave them on the table (an announcement only), uses a banner of the trainer for Pokémon of one trainer, and refuses a list with a mistake without changing anything', async () => {
      await place('trainerA', -1, 'Pikachu', 100);
      await place('trainerA', 0, 'Eevee', 60);
      const announced = me.expect('announce', (announcement) => announcement.type === 'ko');
      const result = await me.act('action:match', { action: 'knockOutMany', clear: false, knockouts: [{ side: 'trainerA', slot: -1 }, { side: 'trainerA', slot: 0 }] });
      assert.equal(result.state.trainerA.active.name, 'Pikachu');
      const ko = await announced;
      assert.deepEqual([ko.title, ko.side], ['DOUBLE KO!', 'trainerA']);
      assert.equal(result.state.trainerB.prizes.count, 4);

      const revision = (await state()).revision;
      const bad = async (knockouts, pattern) => {
        const refused = await me.act('action:match', { action: 'knockOutMany', knockouts });
        assert.equal(refused.ok, false);
        assert.match(refused.rejected.message, pattern);
      };
      await bad([], /choose the Pokémon/);
      await bad([{ side: 'trainerA', slot: 0 }, { side: 'trainerA', slot: 5 }], /no Pokémon in that slot/);
      await bad([{ side: 'trainerA', slot: 0 }, { side: 'trainerA', slot: 0 }], /twice/);
      await bad([{ side: 'trainerA', slot: 0, prizes: 9 }], /prizes/);
      await bad([{ side: 'trainerC', slot: 0 }], /say whose Pokémon/);
      assert.equal((await state()).revision, revision, 'nothing changed');
    });
  });

  describe('a trainer with no Pokémon left', () => {
    const winsOf = async () => { const { matchScore } = await state(); return [matchScore.trainerAWins, matchScore.trainerBWins]; };

    it('loses the game at once when the last Pokémon is knocked out: the other trainer wins, with the banner and the score', async () => {
      await place('trainerA', -1, 'Pikachu', 100);
      await place('trainerB', -1, 'Charizard', 200);
      const won = me.expect('announce', (announcement) => announcement.type === 'win');
      const result = await act('trainerA', { action: 'knockOut', slot: -1, prizes: 1 });
      assert.equal(result.ok, true);
      assert.deepEqual(await winsOf(), [0, 1]);
      const victory = await won;
      assert.equal(victory.side, 'trainerB');
      assert.match(victory.subtitle, /wins the (game|match)/);
      assert.match(me.events.activity.at(-1).label, /won the game \(Trainer A has no Pokémon left\)/);
    });

    it('does the same when the last one is taken off the table, whether it is the Active Pokémon or one of the bench', async () => {
      await place('trainerB', 3, 'Mew', 70);
      await place('trainerA', -1, 'Pikachu', 100);
      await act('trainerB', { action: 'clearSlot', slot: 3 });
      assert.deepEqual(await winsOf(), [1, 0], 'Trainer A wins: Trainer B had one Pokémon, and it was taken off');
    });

    it('does nothing while the trainer still has a Pokémon, when the game was just won on prize cards, or when nobody had one', async () => {
      await place('trainerA', -1, 'Pikachu', 100);
      await place('trainerA', 1, 'Eevee', 60);
      await place('trainerB', -1, 'Charizard', 200);
      await act('trainerA', { action: 'knockOut', slot: -1, prizes: 1 });
      assert.deepEqual(await winsOf(), [0, 0], 'there is still Eevee');
      await act('trainerA', { action: 'moveSlot', from: 1, to: -1 });
      await act('trainerA', { action: 'clearSlot', slot: 1 });
      assert.deepEqual(await winsOf(), [0, 0], 'taking an empty slot off the table is nothing');

      // an empty table is not a loss for either trainer: the game has not begun
      await reset();
      await act('trainerA', { action: 'clearSlot', slot: -1 });
      assert.deepEqual(await winsOf(), [0, 0]);
      // and neither is a reset
      await place('trainerA', -1, 'Pikachu', 100);
      await reset();
      assert.deepEqual(await winsOf(), [0, 0]);
    });

    it('is not counted twice when the same knock out also won the game on prize cards', async () => {
      await place('trainerA', -1, 'Pikachu', 100);
      await place('trainerB', -1, 'Charizard', 200);
      await act('trainerB', { action: 'prizeSet', count: 1 });
      await act('trainerB', { action: 'knockOut', slot: -1, prizes: 1 }); // A takes the last prize card, and B has no Pokémon left
      assert.deepEqual(await winsOf(), [1, 0]);
      await wait(50);
    });
  });
});
