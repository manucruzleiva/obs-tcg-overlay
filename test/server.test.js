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
          abilities: [{ name: 'Spring Dance' }]
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
    let { state } = await producer.act('action:card', { action: 'addFeatureCard', cardId: 'f-1', name: 'Charizard', image: IMG, note: 'big' });
    assert.equal(state.featureCards.length, 1);
    assert.equal(typeof state.featureCards[0].id, 'string');

    ({ state } = await producer.act('action:card', { action: 'removeFeatureCard', id: state.featureCards[0].id }));
    assert.equal(state.featureCards.length, 0);

    ({ state } = await producer.act('action:card', { action: 'favorite', cardId: 'f-1' }));
    assert.deepEqual(state.favoriteCardIds, ['f-1']);
    assert.deepEqual(await (await fetch(`${server.base}/api/favorites`)).json(), ['f-1']);

    ({ state } = await producer.act('action:card', { action: 'favorite', cardId: 'f-1' }));
    assert.deepEqual(state.favoriteCardIds, []);
  });

  it('records a finished match without dropping the score update', async () => {
    let { state } = await producer.act('action:match', { action: 'trainerAMatchWinPlus' });
    assert.equal(state.matchScore.trainerAWins, 1);

    // second win in a best-of-3 ends the match and writes match history
    ({ state } = await producer.act('action:match', { action: 'trainerAMatchWinPlus' }));
    assert.equal(state.matchScore.trainerAWins, 2);

    const matches = await (await fetch(`${server.base}/api/matches`)).json();
    assert.equal(matches.length, 1);
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
      { action: 'togglePrizePenalty' },
      { action: 'prizeSet', count: 4 },
      { action: 'prizeReset' },
      { action: 'benchSizePlus' },
      { action: 'benchSizeMinus' },
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
      '/js/display-options.js', '/js/game-data.js', '/js/sound-options.js', '/js/theme-options.js', '/socket.io/socket.io.js'
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
