/**
 * The Scrydex client, against a stand-in made from its documentation (no network, no account needed).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ScrydexClient, ScrydexError, PAGE_SIZE, frontImages } = require('../../src/services/scrydex');
const { startMockScrydex, respond } = require('../support/harness');

const IMAGES = (id) => [{ type: 'front', small: `https://images.scrydex.com/pokemon/${id}/small`, medium: `https://images.scrydex.com/pokemon/${id}/medium`, large: `https://images.scrydex.com/pokemon/${id}/large` }];
const card = (id, name, extra = {}) => {
  const [set, number] = id.split('-');
  return {
    id, name, supertype: 'Pokémon', subtypes: ['Basic'], types: ['Lightning'], hp: '70', number, rarity: 'Common', regulationMark: 'H',
    images: IMAGES(id), expansion: { id: set, name: `Set ${set}`, series: 'Test', releaseDate: '2025/01/01' },
    attacks: [], abilities: [], rules: [], evolvesFrom: [], convertedRetreatCost: '1', ...extra
  };
};

const POOL = [
  card('sv1-3', 'Pikachu ex', { rarity: 'Double Rare', hp: '200', subtypes: ['Basic', 'ex'], rules: ['ex rule: 2 Prize cards.'] }),
  card('sv1-1', 'Pikachu', { attacks: [{ name: 'Gnaw', damage: '20', cost: ['Lightning'], convertedEnergyCost: 1 }, { name: 'Thunder Jolt', damage: '30+' }], abilities: [{ type: 'Ability', name: 'Static', text: 'x' }, { name: '' }], convertedRetreatCost: '2', artist: 'Mina', flavorText: 'Flavor.' }),
  card('sv1-2', 'Raichu', { subtypes: ['Stage 1'], evolvesFrom: ['Pikachu'], rarity: 'Uncommon', hp: '120' }),
  card('sv1-4', 'Mr. Mime', { types: ['Psychic'] }),
  card('sv1-5', 'Iono', { supertype: 'Trainer', subtypes: ['Supporter'], hp: undefined, types: undefined, convertedRetreatCost: undefined }),
  card('sv2-1', 'Basic Lightning Energy', { supertype: 'Energy', subtypes: ['Basic'], hp: undefined, types: undefined, convertedRetreatCost: undefined, regulationMark: undefined })
];

describe('the Scrydex client', () => {
  let api;
  let client;

  before(async () => { api = await startMockScrydex({ cards: POOL }); });
  after(() => api.close());
  beforeEach(() => {
    api.requests.length = 0;
    api.headers.length = 0;
    client = new ScrydexClient({ baseUrl: api.url, retryDelayMs: 1 });
    client.setCredentials({ key: api.key, team: api.team });
  });

  describe('the account', () => {
    it('needs both the API key and the team ID, and says so without asking anything', async () => {
      const bare = new ScrydexClient({ baseUrl: api.url });
      assert.equal(bare.configured, false);
      await assert.rejects(() => bare.search('pika'), (error) => error instanceof ScrydexError && error.status === 401 && /API key and your team ID/.test(error.message));
      bare.setCredentials({ key: 'only-a-key' });
      assert.equal(bare.configured, false, 'a key without its team is not an account');
      bare.setCredentials({ key: api.key, team: api.team });
      assert.equal(bare.configured, true);
      assert.equal(api.requests.length, 0, 'nothing was asked of the service');
    });

    it('sends both in the headers the documentation names', async () => {
      await client.search('pika');
      assert.equal(api.headers[0]['x-api-key'], api.key);
      assert.equal(api.headers[0]['x-team-id'], api.team);
      assert.equal(api.headers[0]['user-agent'], 'obs-tcg-overlay/1.0');
    });

    it('says what is wrong when the service does not accept them, and does not try again', async () => {
      client.setCredentials({ key: 'wrong', team: api.team });
      await assert.rejects(() => client.search('pika', 1, {}, { attempts: 3 }), (error) => error instanceof ScrydexError && error.status === 401 && /did not accept the API key and team ID/.test(error.message));
      assert.equal(api.requests.length, 1);
    });
  });

  describe('searching', () => {
    it('asks for a page of cards in camel case and gives them as the other services do, the usual ones first', async () => {
      const found = await client.search('pika', 1);
      const url = new URL(api.requests[0], 'http://x');
      assert.equal(url.pathname, '/pokemon/v1/cards');
      assert.equal(url.searchParams.get('q'), 'name:pika*');
      assert.equal(url.searchParams.get('page'), '1');
      assert.equal(url.searchParams.get('page_size'), String(PAGE_SIZE));
      assert.equal(url.searchParams.get('casing'), 'camel');
      assert.deepEqual(found.cards.map((entry) => entry.name), ['Pikachu', 'Pikachu ex'], 'a common card before a double rare');
      assert.deepEqual(found.cards[0], {
        id: 'sv1-1', name: 'Pikachu', setName: 'Set sv1', setId: 'sv1', number: '1', rarity: 'Common', types: 'Lightning', hp: '70',
        supertype: 'Pokémon', subtypes: 'Basic',
        images: { small: 'https://images.scrydex.com/pokemon/sv1-1/small', large: 'https://images.scrydex.com/pokemon/sv1-1/large' },
        source: 'scrydex'
      });
      assert.deepEqual([found.totalCount, found.page, found.pageSize, found.hasMore], [2, 1, PAGE_SIZE, false]);
    });

    it('turns what a person typed and the picker filters into the query language', () => {
      assert.equal(client.queryFor('pika'), 'name:pika*');
      assert.equal(client.queryFor('mr mi'), 'name:mr name:mi*', 'the last word is the one being typed');
      assert.equal(client.queryFor('  '), '');
      assert.equal(client.queryFor('a+b (c) "d"'), 'name:a name:b name:c name:d*', 'what the language reads is left out');
      assert.equal(client.queryFor('name:pika* expansion.id:sv1'), 'name:pika* expansion.id:sv1', 'its own words are left alone');
      assert.equal(client.queryFor('pika', { supertype: 'Pokémon', subtype: 'Stage 1', rarity: 'Rare', set: 'sv1', evolvesFrom: 'Pikachu' }),
        'name:pika* supertype:"Pokémon" subtypes:"Stage 1" rarity:"Rare" expansion.id:"sv1" evolves_from:"Pikachu"');
      assert.equal(client.queryFor('', { supertype: 'Trainer', subtype: 'Stadium' }), 'supertype:"Trainer" subtypes:"Stadium"');
      assert.equal(client.queryFor('x', { rarity: 'say "hi"' }), 'name:x* rarity:"say hi"', 'quotes cannot break the query');
    });

    it('finds a name that is being typed, the cards of a filter, and nothing', async () => {
      assert.deepEqual((await client.search('mr mi')).cards.map((entry) => entry.name), ['Mr. Mime']);
      assert.deepEqual((await client.search('', 1, { supertype: 'Trainer', subtype: 'Supporter' })).cards.map((entry) => entry.name), ['Iono']);
      assert.deepEqual((await client.search('', 1, { evolvesFrom: 'Pikachu' })).cards.map((entry) => entry.name), ['Raichu']);
      assert.deepEqual((await client.search('zzzz')).cards, []);
    });

    it('pages with the total it is told, and with a guess when it is not told', async () => {
      const many = await startMockScrydex({ cards: Array.from({ length: 45 }, (_, i) => card(`bulk-${i + 1}`, `Bulbasaur ${i + 1}`)) });
      try {
        const two = new ScrydexClient({ baseUrl: many.url });
        two.setCredentials({ key: many.key, team: many.team });
        const first = await two.search('bulba', 1);
        assert.deepEqual([first.cards.length, first.totalCount, first.hasMore], [20, 45, true]);
        const last = await two.search('bulba', 3);
        assert.deepEqual([last.cards.length, last.totalCount, last.hasMore], [5, 45, false]);
      } finally {
        await many.close();
      }
      // an answer without a total (or with it in snake case)
      const bare = new ScrydexClient({ baseUrl: 'http://x', fetchImpl: async () => ({ ok: true, json: async () => ({ data: Array.from({ length: PAGE_SIZE }, (_, i) => card(`a-${i}`, `A${i}`)) }) }) });
      bare.setCredentials({ key: 'k', team: 't' });
      const guess = await bare.search('a', 2);
      assert.deepEqual([guess.totalCount, guess.hasMore], [PAGE_SIZE + PAGE_SIZE + 1, true], 'a full page: there may be more');
      const snaked = new ScrydexClient({ baseUrl: 'http://x', fetchImpl: async () => ({ ok: true, json: async () => ({ data: [card('a-1', 'A')], total_count: 7 }) }) });
      snaked.setCredentials({ key: 'k', team: 't' });
      assert.equal((await snaked.search('a')).totalCount, 7);
    });
  });

  describe('one card', () => {
    it('has what the game takes from a card: attacks with their damage, the retreat cost, abilities, the text', async () => {
      const found = await client.getCard('sv1-1');
      assert.equal(new URL(api.requests[0], 'http://x').pathname, '/pokemon/v1/cards/sv1-1');
      assert.equal(found.name, 'Pikachu');
      assert.deepEqual(found.attacks, [{ name: 'Gnaw', damage: 20, mod: '' }, { name: 'Thunder Jolt', damage: 30, mod: '+' }]);
      assert.equal(found.retreat, 2, 'the cost the service writes as text');
      assert.deepEqual(found.abilities, ['Static'], 'a name that is empty is no ability');
      assert.deepEqual([found.artist, found.flavorText, found.regulationMark, found.hp, found.source], ['Mina', 'Flavor.', 'H', '70', 'scrydex']);
      const ex = await client.getCard('sv1-3');
      assert.equal(ex.rules, 'ex rule: 2 Prize cards.');
    });

    it('is null when there is no such card, and an error when the service cannot say', async () => {
      assert.equal(await client.getCard('nope-1'), null);
      assert.equal(await client.getCard('../../etc'), null, 'an id is one path part, whatever it says');
      const down = await startMockScrydex({ cards: POOL, behave: () => respond(500, {}) });
      try {
        const broken = new ScrydexClient({ baseUrl: down.url });
        broken.setCredentials({ key: down.key, team: down.team });
        await assert.rejects(() => broken.getCard('sv1-1'), /answered 500/);
      } finally {
        await down.close();
      }
    });

    it('reads a card written in snake case too, and one with pictures in any order', () => {
      const detail = client.detail({ id: 'x-1', name: 'X', converted_retreat_cost: '3', regulation_mark: 'G', flavor_text: 'Hi', images: [{ type: 'back', small: 'b' }, { type: 'front', small: 's', large: 'l' }], expansion: { id: 'x', name: 'X set' } });
      assert.deepEqual([detail.retreat, detail.regulationMark, detail.flavorText, detail.images], [3, 'G', 'Hi', { small: 's', large: 'l' }]);
      assert.deepEqual(frontImages({ images: [{ small: 'only' }] }), { small: 'only', large: 'only' });
      assert.deepEqual(frontImages({}), { small: '', large: '' });
      assert.equal(client.detail({ id: 'y-1', name: 'Y', retreatCost: ['Colorless', 'Colorless'] }).retreat, 2, 'or a list of costs');
    });
  });

  describe('when the service misbehaves', () => {
    it('tries again when it is busy, if asked to', async () => {
      let failures = 1;
      const flaky = await startMockScrydex({ cards: POOL, behave: () => (failures-- > 0 ? respond(503, {}) : null) });
      try {
        const patient = new ScrydexClient({ baseUrl: flaky.url, retryDelayMs: 1 });
        patient.setCredentials({ key: flaky.key, team: flaky.team });
        assert.equal((await patient.search('pika', 1, {}, { attempts: 2 })).cards.length, 2);
        assert.equal(flaky.requests.length, 2);
      } finally {
        await flaky.close();
      }
    });

    it('gives up at once when it was not asked to try again, and says when it takes too long', async () => {
      const down = await startMockScrydex({ cards: POOL, behave: () => respond(429, {}) });
      try {
        const limited = new ScrydexClient({ baseUrl: down.url });
        limited.setCredentials({ key: down.key, team: down.team });
        await assert.rejects(() => limited.search('pika'), /answered 429/);
        assert.equal(down.requests.length, 1);
      } finally {
        await down.close();
      }
      const slow = await startMockScrydex({ cards: POOL, behave: () => ({ hang: true }) });
      try {
        const patient = new ScrydexClient({ baseUrl: slow.url, timeoutMs: 80 });
        patient.setCredentials({ key: slow.key, team: slow.team });
        await assert.rejects(() => patient.search('pika'), /took too long/);
      } finally {
        await slow.close();
      }
    });
  });

  describe('a library page', () => {
    it('is a page of cards as the service gives them, with the total, for the library to turn into records', async () => {
      const page = await client.libraryPage('regulation_mark:H', 1, 100, { select: 'id,name' });
      assert.deepEqual(page.items.map((item) => item.id).sort(), ['sv1-1', 'sv1-2', 'sv1-3', 'sv1-4', 'sv1-5']);
      assert.equal(page.totalCount, 5);
      const url = new URL(api.requests[0], 'http://x');
      assert.equal(url.searchParams.get('q'), 'regulation_mark:H');
      assert.equal(url.searchParams.get('page_size'), '100');
      assert.equal(url.searchParams.get('select'), 'id,name');
    });
  });
});
