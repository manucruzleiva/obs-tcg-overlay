/**
 * Which card service answers: the Pokémon TCG API, TCGdex, or one after the other. Both are stand-ins on this computer.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const PokemonTCGService = require('../src/services/pokemon-tcg');
const CacheService = require('../src/services/cache');
const { TcgdexClient } = require('../src/services/tcgdex');
const { ScrydexClient } = require('../src/services/scrydex');
const { startMockTcgdex, startMockScrydex, respond } = require('../test-support/harness');

function fakeDb() {
  const searches = new Map();
  const cards = new Map();
  const etags = new Map();
  return {
    getSearch: (key) => searches.get(key) || null,
    setSearch: (key, provider, query, page, data) => searches.set(key, data),
    getCard: (id) => cards.get(id) || null,
    setCard: (id, provider, data) => cards.set(id, data),
    getETag: (url) => etags.get(url) || null,
    setETag: (url, etag) => etags.set(url, etag)
  };
}

const ASSETS = 'https://assets.tcgdex.net';
const tcgdexCard = (id, name, extra = {}) => {
  const [set, local] = id.split('-');
  return {
    id, localId: local, name, image: `${ASSETS}/en/series/${set}/${local}`, category: 'Pokemon', rarity: 'Common', hp: 70, types: ['Lightning'], stage: 'Basic',
    set: { id: set, name: `Dex set ${set}` }, ...extra
  };
};
const apiCard = (id, name, extra = {}) => ({
  id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp: '60', types: ['Lightning'], number: id.split('-')[1], rarity: 'Common',
  set: { id: id.split('-')[0], name: 'API set' }, images: { small: 'https://img.test/s.png', large: 'https://img.test/l.png' }, attacks: [{ name: 'Gnaw', damage: '20' }], convertedRetreatCost: 1, abilities: [], ...extra
});

describe('the card services, together', () => {
  let apiServer;
  let apiRequests;
  let apiAnswer;
  let dex;
  let service;
  let cache;

  before(async () => {
    apiServer = http.createServer((req, res) => {
      apiRequests.push(req.url);
      apiAnswer(req, res);
    });
    await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    dex = await startMockTcgdex({
      cards: [
        tcgdexCard('sv9-1', 'Pikachu', { attacks: [{ name: 'Zap', damage: 30 }, { name: 'Bolt', damage: '60+' }], retreat: 1, abilities: [{ name: 'Static' }], rarity: 'Rare' }),
        tcgdexCard('sv9-2', 'Pikachu ex', { suffix: 'ex', hp: 200 })
      ]
    });
  });
  after(async () => { apiServer.close(); await dex.close(); });

  const api = (data) => (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/cards/')) return res.end(JSON.stringify({ data: data[0] }));
    return res.end(JSON.stringify({ data, totalCount: data.length, page: 1, pageSize: 20 }));
  };
  const down = (status = 500) => (req, res) => { res.statusCode = status; res.end('{}'); };
  const names = (result) => result.cards.map((entry) => entry.name);

  beforeEach(() => {
    apiRequests = [];
    dex.requests.length = 0;
    dex.bodies.length = 0;
    apiAnswer = api([apiCard('base1-58', 'Pikachu (API)')]);
    cache = new CacheService(fakeDb());
    service = new PokemonTCGService(cache, { tcgdex: new TcgdexClient({ baseUrl: dex.url, retryDelayMs: 1 }) });
    service.providers.pokemontcg.baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
  });

  describe('automatic', () => {
    it('is how it starts, in English, asking the Pokémon TCG API first', async () => {
      assert.equal(service.getProvider(), 'auto');
      assert.equal(service.language, 'en');
      assert.deepEqual(service.order(), ['pokemontcg', 'tcgdex']);
      assert.deepEqual(names(await service.searchCards('pika')), ['Pikachu (API)']);
      assert.equal(dex.requests.length, 0, 'the other service was not bothered');
    });

    it('asks TCGdex when the Pokémon TCG API does not answer, and says where the cards came from', async () => {
      apiAnswer = down(502);
      const found = await service.searchCards('pika');
      assert.deepEqual(names(found).sort(), ['Pikachu', 'Pikachu ex']);
      assert.ok(found.cards.every((entry) => entry.source === 'tcgdex'));
      assert.equal(found.source, 'tcgdex', 'the whole answer says where it came from too');
      assert.equal(found.hasMore, false);
      assert.equal(found.cards[0].images.small, '/img/tcgdex/en__series__sv9__' + (found.cards[0].id === 'sv9-1' ? '1' : '2') + '__low.webp', 'pictures are kept on this computer');
      assert.equal(apiRequests.length, 1);
    });

    it('asks the one that failed last for a while, and goes back to it later or when it answers', async () => {
      apiAnswer = down();
      await service.searchCards('pika');
      assert.deepEqual(service.order(), ['tcgdex', 'pokemontcg'], 'it failed a moment ago');

      apiRequests.length = 0;
      await service.searchCards('pikachu');
      assert.equal(apiRequests.length, 0, 'not asked at all while TCGdex answers');

      service.failedAt.pokemontcg = Date.now() - 3 * 60 * 1000;
      assert.deepEqual(service.order(), ['pokemontcg', 'tcgdex'], 'after a couple of minutes it is tried again');

      apiAnswer = api([apiCard('base1-58', 'Pikachu (API)')]);
      assert.deepEqual(names(await service.searchCards('pikachu again')), ['Pikachu (API)']);
      assert.deepEqual(service.failedAt, {}, 'and what it did well is not held against it');
    });

    it('gives up when nothing answers, with what the first service said', async () => {
      apiAnswer = down(503);
      const lost = new PokemonTCGService(cache, { tcgdex: new TcgdexClient({ baseUrl: 'http://127.0.0.1:9/v2', retryDelayMs: 1 }) });
      lost.providers.pokemontcg.baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
      await assert.rejects(() => lost.searchCards('pika'), /503/);
    });

    it('answers from the library on this computer when it has the cards, and says it is offline when nothing else can', async () => {
      const library = { search: (text) => ({ cards: [{ id: 'sv4-1', name: 'Pikachu' }], totalCount: text === 'pika' ? 1 : 0, page: 1, pageSize: 20, source: 'library', library: 'Standard' }), get: () => null };
      service.setCatalog(library);
      assert.equal((await service.searchCards('pika')).source, 'library');
      assert.equal(apiRequests.length, 0);

      apiAnswer = down();
      dex.requests.length = 0;
      const lost = new PokemonTCGService(cache, { tcgdex: new TcgdexClient({ baseUrl: 'http://127.0.0.1:9/v2', retryDelayMs: 1 }) });
      lost.providers.pokemontcg.baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
      lost.setCatalog(library);
      const offline = await lost.searchCards('charmander');
      assert.deepEqual([offline.offline, offline.source, offline.totalCount], [true, 'library', 0]);
    });

    it('tries the other service when one finds nothing on the first page, and keeps the empty answer if the other finds nothing too', async () => {
      apiAnswer = api([]);
      assert.deepEqual(names(await service.searchCards('pika')).sort(), ['Pikachu', 'Pikachu ex'], 'a set one service does not know yet');
      assert.deepEqual(service.failedAt, {}, 'an empty answer is not a failure');

      const found = await service.searchCards('zzzz');
      assert.deepEqual([found.cards, found.totalCount, found.source], [[], 0, undefined], 'the Pokémon TCG API\'s answer, with nothing in it');

      // a second page is not looked for in the other service: the first one ran out
      dex.requests.length = 0;
      await service.searchCards('pika', 2);
      assert.equal(dex.requests.length, 0);
    });

    it('leaves the Pokémon TCG API\'s own query syntax to the Pokémon TCG API', async () => {
      apiAnswer = api([]);
      await service.searchCards('name:pika* set.id:sv9');
      assert.equal(dex.requests.length, 0, 'TCGdex does not speak it');
      assert.match(apiRequests[0], /q=name%3Apika\*/);
    });

    it('gives the Pokémon TCG API less time when there is another service to ask', async () => {
      apiAnswer = () => {}; // never answers
      const started = Date.now();
      const found = await service.searchCards('pika');
      const took = Date.now() - started;
      assert.ok(took >= 4500 && took < 8000, `waited ${took} ms for the first one, not the whole eight seconds`);
      assert.equal(found.cards[0].source, 'tcgdex');
    });
  });

  describe('one service only', () => {
    it('never asks TCGdex when told to use the Pokémon TCG API only', async () => {
      service.setProvider('pokemontcg');
      assert.deepEqual(service.order(), ['pokemontcg']);
      apiAnswer = down();
      await assert.rejects(() => service.searchCards('pika'), /500/);
      assert.equal(dex.requests.length, 0);
    });

    it('never asks the Pokémon TCG API when told to use TCGdex only', async () => {
      service.setProvider('tcgdex');
      assert.deepEqual(service.order(), ['tcgdex']);
      assert.deepEqual(names(await service.searchCards('pika')).sort(), ['Pikachu', 'Pikachu ex']);
      assert.equal(apiRequests.length, 0);
    });

    it('takes only what it knows: a service, an API key, a language', () => {
      service.setProvider('klingon', 'key', 'klingon');
      assert.equal(service.getProvider(), 'auto', 'an unknown service is ignored');
      assert.equal(service.apiKey, 'key');
      assert.equal(service.language, 'en', 'an unknown language is English');
      service.setProvider('tcgdex', '', 'pt-br');
      assert.deepEqual([service.getProvider(), service.language, service.tcgdex.language], ['tcgdex', 'pt-br', 'pt-br']);
    });
  });

  describe('in another language', () => {
    it('asks TCGdex first, which has the cards in that language, and the Pokémon TCG API after it', async () => {
      service.setProvider('auto', '', 'es');
      assert.deepEqual(service.order(), ['tcgdex', 'pokemontcg']);
      const found = await service.searchCards('pika');
      assert.ok(found.cards.length > 0 && found.cards.every((entry) => entry.language === 'es'));
      assert.match(dex.requests[0], /^GET \/v2\/es\/cards\?/);
      assert.equal(apiRequests.length, 0);

      // when TCGdex is down, English cards are better than none
      const lost = new PokemonTCGService(cache, { tcgdex: new TcgdexClient({ baseUrl: 'http://127.0.0.1:9/v2', retryDelayMs: 1 }) });
      lost.providers.pokemontcg.baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
      lost.setProvider('auto', '', 'fr');
      assert.deepEqual(names(await lost.searchCards('pika')), ['Pikachu (API)']);
    });

    it('leaves the English library out of it', async () => {
      let asked = 0;
      service.setCatalog({ search: () => { asked++; return { cards: [{ id: 'x' }], totalCount: 1, source: 'library' }; }, get: () => null });
      service.setProvider('auto', '', 'de');
      await service.searchCards('pika');
      assert.equal(asked, 0);
      service.setProvider('auto', '', 'en');
      await service.searchCards('pika');
      assert.equal(asked, 1);
    });

    it('remembers what TCGdex said for each language on its own', async () => {
      service.setProvider('tcgdex', '', 'es');
      await service.searchCards('pika');
      await service.searchCards('pika');
      assert.equal(dex.requests.length, 1, 'the second time comes from what was kept');
      service.setProvider('tcgdex', '', 'fr');
      await service.searchCards('pika');
      assert.equal(dex.requests.length, 2, 'another language is another question');
      service.setProvider('tcgdex', '', 'es');
      await service.searchCards('pika', 1, { supertype: 'Pokémon' });
      assert.equal(dex.requests.length, 3, 'and so is a filter');
    });

    it('falls back on what it kept when TCGdex cannot be reached any more', async () => {
      service.setProvider('tcgdex');
      const first = await service.searchCards('pika');
      dex.requests.length = 0;
      const broken = new PokemonTCGService(cache, { tcgdex: new TcgdexClient({ baseUrl: 'http://127.0.0.1:9/v2', retryDelayMs: 1 }) });
      broken.setProvider('tcgdex');
      assert.deepEqual(names(await broken.searchCards('pika')), names(first));
    });
  });

  describe('one card', () => {
    it('is asked of the service it came from, in the language it was found in, with its attacks', async () => {
      const found = await service.getCard('sv9-1', { source: 'tcgdex', language: 'es' });
      assert.equal(found.name, 'Pikachu');
      assert.deepEqual(found.attacks, [{ name: 'Zap', damage: 30, mod: '' }, { name: 'Bolt', damage: 60, mod: '+' }]);
      assert.equal(found.retreat, 1);
      assert.deepEqual(found.abilities, ['Static']);
      assert.deepEqual(dex.requests, ['GET /v2/es/cards/sv9-1']);
      assert.equal(apiRequests.length, 0);
      assert.equal(found.images.large, '/img/tcgdex/en__series__sv9__1__high.webp', 'its picture is kept on this computer');

      await service.getCard('sv9-1', { source: 'tcgdex', language: 'es' });
      assert.equal(dex.requests.length, 1, 'kept for next time');
      await service.getCard('sv9-1', { source: 'tcgdex', language: 'fr' });
      assert.equal(dex.requests.length, 2, 'but not for another language');
    });

    it('is asked of the Pokémon TCG API when that is where it came from, or when nothing is known', async () => {
      assert.equal((await service.getCard('base1-58', { source: 'pokemontcg' })).name, 'Pikachu (API)');
      assert.equal(dex.requests.length, 0);
      assert.equal((await service.getCard('base1-59')).name, 'Pikachu (API)');
      assert.equal(dex.requests.length, 0);
    });

    it('is looked for in the other service when the first does not know it, which says nothing against the first', async () => {
      apiAnswer = down(404);
      const found = await service.getCard('sv9-2');
      assert.equal(found.name, 'Pikachu ex');
      assert.deepEqual(service.failedAt, {}, 'a card that is not there is not an outage');
      assert.equal(await service.getCard('nope-1').catch(() => 'gone'), 'gone', 'and when neither has it there is an error');
    });

    it('is asked of the other service when the first is down, and remembers that it is', async () => {
      apiAnswer = down(503);
      assert.equal((await service.getCard('sv9-2')).name, 'Pikachu ex');
      assert.ok(service.failedAt.pokemontcg);
    });

    it('comes from the library when it is there with its attacks, with no question asked', async () => {
      service.setCatalog({ get: () => ({ id: 'sv4-1', name: 'Pikachu', attacks: [{ name: 'Gnaw', damage: 20, mod: '' }], retreat: 1 }), search: () => null });
      assert.equal((await service.getCard('sv4-1')).name, 'Pikachu');
      assert.equal(apiRequests.length + dex.requests.length, 0);
    });

    it('is still usable by hand when the card is in the library with no attacks and nobody answers', async () => {
      const lost = new PokemonTCGService(cache, { tcgdex: new TcgdexClient({ baseUrl: 'http://127.0.0.1:9/v2', retryDelayMs: 1 }) });
      lost.providers.pokemontcg.baseUrl = 'http://127.0.0.1:9';
      lost.setCatalog({ get: () => ({ id: 'sv4-1', name: 'Pikachu', attacks: undefined }), search: () => null });
      const found = await lost.getCard('sv4-1');
      assert.deepEqual([found.name, found.attacks, found.retreat], ['Pikachu', [], 0]);
    });
  });

  describe('a TCGdex that misbehaves', () => {
    it('is not asked again at once when it failed', async () => {
      const broken = await startMockTcgdex({ cards: [], behave: () => respond(500, { error: 'no' }) });
      try {
        const lost = new PokemonTCGService(cache, { tcgdex: new TcgdexClient({ baseUrl: broken.url, retryDelayMs: 1 }) });
        lost.providers.pokemontcg.baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
        apiAnswer = down();
        await assert.rejects(() => lost.searchCards('pika'));
        assert.deepEqual(Object.keys(lost.failedAt).sort(), ['pokemontcg', 'tcgdex'], 'both are held against');
      } finally {
        await broken.close();
      }
    });
  });
});

describe('Scrydex among the card services', () => {
  let api;
  let scrydex;
  let service;
  let apiRequests = [];

  const scrydexCard = (id, name, extra = {}) => ({
    id, name, supertype: 'Pokémon', subtypes: ['Basic'], types: ['Lightning'], hp: '60', number: id.split('-')[1], rarity: 'Common',
    images: [{ type: 'front', small: `https://images.scrydex.com/pokemon/${id}/small`, medium: 'm', large: `https://images.scrydex.com/pokemon/${id}/large` }],
    expansion: { id: id.split('-')[0], name: 'Scrydex set' }, attacks: [{ name: 'Zap', damage: '30' }], abilities: [], convertedRetreatCost: '2', ...extra
  });

  before(async () => {
    api = http.createServer((req, res) => { apiRequests.push(req.url); res.statusCode = 500; res.end('{}'); });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    scrydex = await startMockScrydex({ cards: [scrydexCard('sv9-1', 'Pikachu'), scrydexCard('sv9-2', 'Pikachu ex', { rarity: 'Double Rare' })] });
  });
  after(async () => { api.close(); await scrydex.close(); });

  const make = ({ credentials = true } = {}) => {
    apiRequests = [];
    scrydex.requests.length = 0;
    const found = new PokemonTCGService(new CacheService(fakeDb()), { tcgdex: new TcgdexClient({ baseUrl: 'http://127.0.0.1:9/v2', retryDelayMs: 1 }), scrydex: new ScrydexClient({ baseUrl: scrydex.url, retryDelayMs: 1 }) });
    found.providers.pokemontcg.baseUrl = `http://127.0.0.1:${api.address().port}`;
    if (credentials) found.setCredentials({ scrydexKey: scrydex.key, scrydexTeam: scrydex.team });
    return found;
  };

  beforeEach(() => { service = make(); });

  it('is asked on its own when chosen, with the account, and says where the cards came from', async () => {
    service.setProvider('scrydex');
    assert.equal(service.getProvider(), 'scrydex');
    assert.deepEqual(service.order(), ['scrydex']);
    const found = await service.searchCards('pika');
    assert.deepEqual(found.cards.map((entry) => entry.name).sort(), ['Pikachu', 'Pikachu ex']);
    assert.equal(found.source, 'scrydex');
    assert.ok(found.cards.every((entry) => entry.source === 'scrydex'));
    assert.equal(apiRequests.length, 0, 'the other services are not asked');
    assert.equal(scrydex.headers[0]['x-api-key'], scrydex.key);
    assert.equal(scrydex.headers[0]['x-team-id'], scrydex.team);
    assert.equal(found.cards.find((entry) => entry.name === 'Pikachu').images.small, '/img/scrydex/sv9-1_small.png', 'its pictures are kept on this computer');
  });

  it('is not asked when it is only one of the automatic choices: that is the Pokémon TCG API and TCGdex', async () => {
    assert.deepEqual(service.order(), ['pokemontcg', 'tcgdex']);
    await assert.rejects(() => service.searchCards('pika'));
    assert.equal(scrydex.requests.length, 0);
  });

  it('says what is missing when there is no account yet, without asking anything', async () => {
    const bare = make({ credentials: false });
    bare.setProvider('scrydex');
    await assert.rejects(() => bare.searchCards('pika'), /API key and your team ID/);
    assert.equal(scrydex.requests.length, 0);
  });

  it('says so when the account is not accepted, and keeps what it had found for next time', async () => {
    service.setProvider('scrydex');
    await service.searchCards('pika');
    scrydex.requests.length = 0;
    await service.searchCards('pika');
    assert.equal(scrydex.requests.length, 0, 'the second time comes from what was kept');

    service.setCredentials({ scrydexKey: 'wrong-key', scrydexTeam: scrydex.team });
    await assert.rejects(() => service.searchCards('charizard'), /did not accept the API key and team ID/);
  });

  it('looks a card up on Scrydex when that is where it came from, with its attacks and retreat cost', async () => {
    const found = await service.getCard('sv9-1', { source: 'scrydex' });
    assert.equal(found.name, 'Pikachu');
    assert.deepEqual(found.attacks, [{ name: 'Zap', damage: 30, mod: '' }]);
    assert.equal(found.retreat, 2);
    assert.equal(found.images.large, '/img/scrydex/sv9-1_large.png');
    assert.equal(apiRequests.length, 0);
    await service.getCard('sv9-1', { source: 'scrydex' });
    assert.equal(scrydex.requests.length, 1, 'kept for next time');
    assert.equal(await service.getCard('nope-1', { source: 'scrydex' }), null, 'a card it does not have is no card');
  });
});
