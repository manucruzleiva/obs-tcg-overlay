/**
 * Unit tests for the card API client, run against a local mock API
 * (no network access needed). Also exercises the cache service on top of an
 * in-memory stand-in for the database.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const PokemonTCGService = require('../src/services/pokemon-tcg');
const CacheService = require('../src/services/cache');

// In-memory replacement for DatabaseService's cache methods
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

const PIKACHU = {
  id: 'base1-58',
  name: 'Pikachu',
  supertype: 'Pokémon',
  subtypes: ['Basic'],
  hp: '40',
  types: ['Lightning'],
  number: '58',
  rarity: 'Common',
  set: { id: 'base1', name: 'Base' },
  images: { small: 'https://img.test/s.png', large: 'https://img.test/l.png' },
  attacks: [{ name: 'Gnaw' }],
  abilities: []
};
const CHARIZARD = { ...PIKACHU, id: 'base1-4', name: 'Charizard', rarity: 'Rare Holo', hp: '120' };

describe('PokemonTCGService', () => {
  let server;
  let requests;
  let respond;
  let service;

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push({ url: req.url, headers: req.headers });
      respond(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(() => server.close());

  beforeEach(() => {
    requests = [];
    respond = (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('ETag', '"v1"');
      if (req.url.startsWith('/cards/')) {
        res.end(JSON.stringify({ data: PIKACHU }));
      } else {
        // Deliberately out of rarity order
        res.end(JSON.stringify({ data: [CHARIZARD, PIKACHU], totalCount: 2, page: 1, pageSize: 20 }));
      }
    };
    service = new PokemonTCGService(new CacheService(fakeDb()));
    service.providers.pokemontcg.baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  it('searches, parses cards and sorts common rarities first', async () => {
    const result = await service.searchCards('name:pika');

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^\/cards\?q=name%3Apika&page=1&pageSize=20/);
    assert.equal(requests[0].headers['user-agent'], 'obs-tcg-overlay/1.0');
    assert.deepEqual(result.cards.map((c) => c.name), ['Pikachu', 'Charizard']);
    assert.equal(result.cards[0].setName, 'Base');
    assert.equal(result.totalCount, 2);
  });

  it('serves repeated searches from the cache', async () => {
    await service.searchCards('name:pika');
    const again = await service.searchCards('name:pika');

    assert.equal(requests.length, 1);
    assert.equal(again.cards.length, 2);
  });

  it('turns what a person types into an API query, and leaves the API\'s own syntax alone', () => {
    assert.equal(service.buildQuery('pikachu'), 'name:"pikachu*"');
    assert.equal(service.buildQuery('  mr. mime  '), 'name:"mr. mime*"');
    assert.equal(service.buildQuery('say "hi"'), 'name:"say hi*"', 'quotes cannot break the query');
    assert.equal(service.buildQuery('name:pika* set.id:base1'), 'name:pika* set.id:base1');
    assert.equal(
      service.buildQuery('eevee', { supertype: 'Pokémon', evolvesFrom: 'Eevee', rarity: 'Rare' }),
      'name:"eevee*" supertype:"Pokémon" rarity:"Rare" evolvesFrom:"Eevee"'
    );
  });

  it('sends a typed search to the API as a name query, with filters', async () => {
    await service.searchCards('pika', 1, { supertype: 'Pokémon' });
    const url = new URL(requests[0].url, 'http://x');
    assert.equal(url.searchParams.get('q'), 'name:"pika*" supertype:"Pokémon"');
  });

  it('does not reuse a filtered search for an unfiltered one', async () => {
    await service.searchCards('pika', 1, { supertype: 'Stadium' });
    await service.searchCards('pika', 1, {});
    assert.equal(requests.length, 2, 'two different queries went to the API');
    await service.searchCards('pika', 1, { supertype: 'Stadium' });
    assert.equal(requests.length, 2, 'the same query again comes from the cache');
  });

  it('applies client-side filters to cached results', async () => {
    const result = await service.searchCards('name:pika', 1, { rarity: 'Rare Holo' });
    assert.deepEqual(result.cards.map((c) => c.name), ['Charizard']);
  });

  it('sends the API key header when one is configured', async () => {
    service.setProvider('pokemontcg', 'my-key');
    await service.searchCards('name:pika');
    assert.equal(requests[0].headers['x-api-key'], 'my-key');
  });

  it('fetches and caches a single card with its attacks', async () => {
    const card = await service.getCard('base1-58');
    assert.equal(card.name, 'Pikachu');
    assert.deepEqual(card.attacks, ['Gnaw']);
    assert.equal(requests[0].url, '/cards/base1-58');

    await service.getCard('base1-58');
    assert.equal(requests.length, 1);
  });

  it('reports API failures instead of returning bad data', async () => {
    respond = (req, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    await assert.rejects(() => service.searchCards('name:fail'), /API error: 500/);
  });
});
