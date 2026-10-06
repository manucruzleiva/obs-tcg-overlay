/**
 * The TCGdex client, against a stand-in for the service (no network needed).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TcgdexClient, TcgdexError, LANGUAGES, LANGUAGE_CODES, PAGE_SIZE, spellings, rarityRank } = require('../src/services/tcgdex');
const GAME = require('../public/js/game-data');
const { startMockTcgdex, respond } = require('../test-support/harness');

const ASSETS = 'https://assets.tcgdex.net';
const card = (id, name, extra = {}) => {
  const [set, local] = id.split('-');
  return {
    id, localId: local, name, image: `${ASSETS}/en/series/${set}/${local}`, category: 'Pokemon', rarity: 'Common', hp: 70, types: ['Lightning'], stage: 'Basic',
    set: { id: set, name: `Set ${set}`, releaseDate: '2024-01-01' }, legal: { standard: true, expanded: true }, ...extra
  };
};

const POOL = [
  card('sv1-3', 'Pikachu ex', { rarity: 'Double rare', hp: 200, suffix: 'ex' }),
  card('sv1-1', 'Pikachu', { rarity: 'Common' }),
  card('sv1-2', 'Raichu', { rarity: 'Uncommon', stage: 'Stage1', evolveFrom: 'Pikachu', hp: 120, attacks: [{ name: 'Thunder', damage: '90+' }, { name: 'Zap' }], retreat: 2, abilities: [{ name: 'Static', effect: 'x' }, { name: '' }], effect: 'Does something.', illustrator: 'Mina', description: 'Flavor.', regulationMark: 'G' }),
  card('sv1-4', 'Iono', { category: 'Trainer', trainerType: 'Supporter', hp: undefined, types: undefined, stage: undefined }),
  card('sv1-5', 'Pokémon Catcher', { category: 'Trainer', trainerType: 'Item', hp: undefined, types: undefined, stage: undefined }),
  card('sv1-6', 'Vitality Band', { category: 'Trainer', trainerType: 'Tool', hp: undefined, types: undefined, stage: undefined }),
  card('sv1-7', 'Double Turbo Energy', { category: 'Energy', energyType: 'Special', hp: undefined, types: undefined, stage: undefined }),
  card('sv1-8', 'Basic Lightning Energy', { category: 'Energy', energyType: 'Normal', hp: undefined, types: undefined, stage: undefined, rarity: 'None' })
];

describe('the TCGdex client', () => {
  let api;
  let client;

  before(async () => { api = await startMockTcgdex({ cards: POOL }); });
  after(() => api.close());
  beforeEach(() => {
    api.requests.length = 0;
    api.bodies.length = 0;
    client = new TcgdexClient({ baseUrl: api.url, retryDelayMs: 1 });
  });

  describe('searching in English', () => {
    it('asks for a page of cards in one request and gives them as the other service does, the usual ones first', async () => {
      const found = await client.search('pika', 1);
      assert.deepEqual(api.requests, ['POST /v2/graphql']);
      assert.deepEqual(api.bodies[0].variables, { filters: { name: 'pika' }, pagination: { page: 1, itemsPerPage: PAGE_SIZE } });
      assert.match(api.bodies[0].query, /cards\(filters: \$filters, pagination: \$pagination\)/);
      assert.deepEqual(found.cards.map((entry) => entry.name), ['Pikachu', 'Pikachu ex'], 'a common card before a double rare');
      assert.deepEqual(found.cards[0], {
        id: 'sv1-1', name: 'Pikachu', setName: 'Set sv1', setId: 'sv1', number: '1', rarity: 'Common', types: 'Lightning', hp: '70',
        supertype: 'Pokémon', subtypes: 'Basic',
        images: { small: `${ASSETS}/en/series/sv1/1/low.webp`, large: `${ASSETS}/en/series/sv1/1/high.webp` },
        source: 'tcgdex', language: 'en'
      });
      assert.equal(found.cards[1].subtypes, 'Basic, ex');
      assert.deepEqual([found.totalCount, found.page, found.pageSize, found.hasMore], [2, 1, PAGE_SIZE, false]);
    });

    it('says there may be more when a page is full, and counts what it has seen', async () => {
      const many = await startMockTcgdex({ cards: Array.from({ length: 45 }, (_, i) => card(`bulk-${i + 1}`, `Bulbasaur ${i + 1}`)) });
      try {
        const two = new TcgdexClient({ baseUrl: many.url });
        const first = await two.search('bulba', 1);
        assert.deepEqual([first.cards.length, first.hasMore, first.totalCount], [20, true, 21], 'a full page: there may be one more at least');
        const second = await two.search('bulba', 2);
        assert.deepEqual([second.cards.length, second.hasMore, second.totalCount], [20, true, 41]);
        const third = await two.search('bulba', 3);
        assert.deepEqual([third.cards.length, third.hasMore, third.totalCount], [5, false, 45], 'the last page is the end');
      } finally {
        await many.close();
      }
    });

    it('also asks with the accent when the name could have one, and lists a card once', async () => {
      assert.deepEqual(spellings('pokemon catcher'), ['pokemon catcher', 'pokémon catcher']);
      assert.deepEqual(spellings('Pokemon Catcher'), ['Pokemon Catcher', 'Pokémon Catcher'], 'the capital stays');
      assert.deepEqual(spellings('POKEMON'), ['POKEMON', 'POKÉMON'], 'and so does a capital E');
      assert.deepEqual(spellings('Poke Ball'), ['Poke Ball', 'Poké Ball']);
      assert.deepEqual(spellings('pokémon catcher'), ['pokémon catcher'], 'already right');
      assert.deepEqual(spellings('pikachu'), ['pikachu']);

      const found = await client.search('pokemon catcher', 1);
      assert.equal(api.requests.length, 2);
      assert.deepEqual(api.bodies.map((body) => body.variables.filters.name).sort(), ['pokemon catcher', 'pokémon catcher']);
      assert.deepEqual(found.cards.map((entry) => entry.name), ['Pokémon Catcher']);
    });

    it('answers a search with only a filter, and with nothing found', async () => {
      const evolutions = await client.search('', 1, { evolvesFrom: 'Pikachu' });
      assert.deepEqual(evolutions.cards.map((entry) => entry.name), ['Raichu']);
      assert.deepEqual(api.bodies[0].variables.filters, { evolveFrom: 'Pikachu' }, 'no name in it');
      const none = await client.search('zzzz', 1);
      assert.deepEqual([none.cards, none.totalCount, none.hasMore], [[], 0, false]);
    });

    it('turns the filters of the card picker into TCGdex\'s own', async () => {
      const filtersFor = (filters) => client.filtersFor(filters);
      assert.deepEqual(filtersFor({ supertype: 'Pokémon' }), { category: 'Pokemon' });
      assert.deepEqual(filtersFor({ supertype: 'Pokémon', subtype: 'Stage 1' }), { category: 'Pokemon', stage: 'Stage1' });
      assert.deepEqual(filtersFor({ supertype: 'Pokémon', subtype: 'Stage 2' }), { category: 'Pokemon', stage: 'Stage2' });
      assert.deepEqual(filtersFor({ supertype: 'Pokémon', subtype: 'VSTAR' }), { category: 'Pokemon', stage: 'VSTAR' });
      assert.deepEqual(filtersFor({ supertype: 'Pokémon', subtype: 'ex' }), { category: 'Pokemon', suffix: 'ex' });
      assert.deepEqual(filtersFor({ supertype: 'Trainer', subtype: 'Stadium' }), { category: 'Trainer', trainerType: 'Stadium' });
      assert.deepEqual(filtersFor({ supertype: 'Trainer', subtype: 'Pokémon Tool' }), { category: 'Trainer', trainerType: 'Tool' });
      assert.deepEqual(filtersFor({ supertype: 'Energy', subtype: 'Special' }), { category: 'Energy', energyType: 'Special' });
      assert.deepEqual(filtersFor({ supertype: 'Energy', subtype: 'Basic' }), { category: 'Energy', energyType: 'Normal' });
      assert.deepEqual(filtersFor({ subtype: 'Supporter' }), { trainerType: 'Supporter' });
      assert.deepEqual(filtersFor({ rarity: 'Rare', evolvesFrom: 'Eevee' }), { rarity: 'Rare', evolveFrom: 'Eevee' });
      assert.deepEqual(filtersFor({}), {});

      const stadiums = await client.search('', 1, { supertype: 'Trainer', subtype: 'Supporter' });
      assert.deepEqual(stadiums.cards.map((entry) => entry.name), ['Iono']);
      const special = await client.search('turbo', 1, { supertype: 'Energy', subtype: 'Special' });
      assert.deepEqual(special.cards.map((entry) => `${entry.name} ${entry.supertype}/${entry.subtypes}`), ['Double Turbo Energy Energy/Special']);
      const tools = await client.search('', 1, { supertype: 'Trainer', subtype: 'Pokémon Tool' });
      assert.equal(tools.cards[0].subtypes, 'Pokémon Tool');
    });

    it('lists a card of a rarity it does not know after the others, and keeps cards that have none', async () => {
      assert.equal(rarityRank('Common'), 0);
      assert.ok(rarityRank('Common') < rarityRank('Uncommon') && rarityRank('Uncommon') < rarityRank('Rare') && rarityRank('Rare') < rarityRank('Double rare'));
      assert.ok(rarityRank('Double rare') < rarityRank('Special illustration rare'));
      assert.ok(rarityRank('A brand new rarity') > rarityRank('Special illustration rare'));
      assert.equal(rarityRank(undefined), rarityRank('A brand new rarity'));
      const found = await client.search('energy', 1);
      assert.equal(found.cards.find((entry) => entry.name === 'Basic Lightning Energy').rarity, 'Unknown', '"None" is no rarity');
    });
  });

  describe('searching in another language', () => {
    it('asks for the list of that language, which has the name, the number and the picture', async () => {
      const spanish = new TcgdexClient({ baseUrl: api.url, language: 'es' });
      const found = await spanish.search('pika', 1);
      assert.equal(api.requests.length, 1);
      const url = new URL(api.requests[0].split(' ')[1], 'http://x');
      assert.equal(url.pathname, '/v2/es/cards');
      assert.equal(url.searchParams.get('name'), 'pika');
      assert.equal(url.searchParams.get('pagination:page'), '1');
      assert.equal(url.searchParams.get('pagination:itemsPerPage'), String(PAGE_SIZE));
      assert.deepEqual(found.cards.map((entry) => entry.name).sort(), ['Pikachu', 'Pikachu ex']);
      const pikachu = found.cards.find((entry) => entry.name === 'Pikachu');
      assert.deepEqual(pikachu.images, { small: `${ASSETS}/en/series/sv1/1/low.webp`, large: `${ASSETS}/en/series/sv1/1/high.webp` });
      assert.equal(pikachu.language, 'es');
      assert.equal(pikachu.hp, '', 'the list has no HP: it is read when the card is chosen');
    });

    it('sends a search by set, and the filters, the same way', async () => {
      await client.search('', 1, { set: 'sv1', supertype: 'Trainer' });
      const url = new URL(api.requests[0].split(' ')[1], 'http://x');
      assert.equal(url.pathname, '/v2/en/cards', 'a set can only be asked of the list');
      assert.equal(url.searchParams.get('set.id'), 'sv1');
      assert.equal(url.searchParams.get('category'), 'Trainer');
    });

    it('has a card without a picture, which the page shows as a plain card', async () => {
      const bare = await startMockTcgdex({ cards: [card('x-1', 'Pictureless', { image: undefined })] });
      try {
        const found = await new TcgdexClient({ baseUrl: bare.url, language: 'fr' }).search('picture', 1);
        assert.deepEqual(found.cards[0].images, { small: '', large: '' });
      } finally {
        await bare.close();
      }
    });
  });

  describe('one card', () => {
    it('has what the game takes from a card: attacks with their damage, the retreat cost, abilities, the text', async () => {
      const found = await client.getCard('sv1-2');
      assert.equal(api.requests[0], 'GET /v2/en/cards/sv1-2');
      assert.equal(found.name, 'Raichu');
      assert.deepEqual(found.attacks, [{ name: 'Thunder', damage: 90, mod: '+' }, { name: 'Zap', damage: 0, mod: '' }]);
      assert.equal(found.retreat, 2);
      assert.deepEqual(found.abilities, ['Static'], 'a name that is empty is no ability');
      assert.deepEqual([found.rules, found.artist, found.flavorText, found.regulationMark], ['Does something.', 'Mina', 'Flavor.', 'G']);
      assert.equal(found.hp, '120');
      assert.equal(found.source, 'tcgdex');
    });

    it('has none of those for a card that has none, and is null when there is no such card', async () => {
      const pikachu = await client.getCard('sv1-1');
      assert.deepEqual([pikachu.attacks, pikachu.retreat, pikachu.abilities], [[], undefined, []]);
      assert.equal(await client.getCard('nope-1'), null);
      assert.equal(await client.getCard('../../etc'), null, 'an id is one path part, whatever it says');
      assert.ok(api.requests.every((request) => !request.includes('etc/passwd')));
    });
  });

  describe('when the service misbehaves', () => {
    it('tries again once when it is busy, if asked to', async () => {
      let failures = 1;
      const flaky = await startMockTcgdex({ cards: POOL, behave: () => (failures-- > 0 ? respond(503, { error: 'busy' }) : null) });
      try {
        const patient = new TcgdexClient({ baseUrl: flaky.url, retryDelayMs: 1 });
        const found = await patient.search('pika', 1, {}, { attempts: 2 });
        assert.equal(found.cards.length, 2);
        assert.equal(flaky.requests.length, 2, 'it failed once and worked the second time');
      } finally {
        await flaky.close();
      }
    });

    it('gives up at once when it was not asked to try again, saying what happened', async () => {
      const down = await startMockTcgdex({ cards: POOL, behave: () => respond(500, { error: 'broken' }) });
      try {
        await assert.rejects(() => new TcgdexClient({ baseUrl: down.url }).search('pika', 1), (error) => error instanceof TcgdexError && /answered 500/.test(error.message));
        assert.equal(down.requests.length, 1);
      } finally {
        await down.close();
      }
    });

    it('does not try again for a card that is not there', async () => {
      assert.equal(await client.getCard('nope-9', { attempts: 3 }), null);
      assert.equal(api.requests.length, 1);
    });

    it('says when it takes too long, and when the question is refused', async () => {
      const slow = await startMockTcgdex({ cards: POOL, behave: () => ({ hang: true }) });
      try {
        await assert.rejects(() => new TcgdexClient({ baseUrl: slow.url, timeoutMs: 80 }).search('pika', 1), /took too long/);
      } finally {
        await slow.close();
      }
      const refusing = await startMockTcgdex({ cards: POOL, behave: () => respond(200, { errors: [{ message: 'filters are wrong' }] }) });
      try {
        await assert.rejects(() => new TcgdexClient({ baseUrl: refusing.url }).search('pika', 1), /filters are wrong/);
      } finally {
        await refusing.close();
      }
    });

    it('says when nothing answers at all', async () => {
      await assert.rejects(() => new TcgdexClient({ baseUrl: 'http://127.0.0.1:9/v2', retryDelayMs: 1 }).search('pika', 1, {}, { attempts: 2 }), TcgdexError);
    });
  });

  describe('languages', () => {
    it('knows the languages of the settings, shared with the control panel', () => {
      assert.deepEqual(LANGUAGES, GAME.CARD_LANGUAGES);
      assert.deepEqual(LANGUAGE_CODES, ['en', 'es', 'es-mx', 'pt-br', 'fr', 'de', 'it', 'ja']);
    });

    it('is asked for another language without changing, and takes English for one it does not know', () => {
      assert.equal(client.withLanguage('en'), client, 'the same one for the same language');
      assert.equal(client.withLanguage('klingon'), client);
      const french = client.withLanguage('fr');
      assert.notEqual(french, client);
      assert.equal(french.language, 'fr');
      assert.equal(french.baseUrl, client.baseUrl);
      assert.equal(client.language, 'en');
      client.setLanguage('de');
      assert.equal(client.language, 'de');
      client.setLanguage('xx');
      assert.equal(client.language, 'en');
      assert.equal(new TcgdexClient({ language: 'zz' }).language, 'en');
    });
  });
});
