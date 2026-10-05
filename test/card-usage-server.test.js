const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, startMockCardApi } = require('../test-support/harness');

// The most used cards and the cards already saved on this computer, through the real server
describe('the cards to start from, through the server', () => {
  let api;
  let server;

  const card = (id, name, extra = {}) => {
    const [set, number] = id.split('-');
    return {
      id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp: '70', types: ['Lightning'], number, rarity: 'Common',
      set: { id: set, name: `Set ${set}` }, images: { small: `https://images.test/${set}/${number}.png`, large: `https://images.test/${set}/${number}_hires.png` }, ...extra
    };
  };
  const call = async (method, path, body) => {
    const response = await fetch(`${server.base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  };
  const popular = (query = '') => call('GET', `/api/cards/popular${query}`);
  const names = (response) => response.json.cards.map((entry) => entry.name);

  before(async () => {
    api = await startMockCardApi({
      '/cards?': (url) => {
        const q = decodeURIComponent(url);
        if (q.includes('subtypes:"Stadium"')) return { data: [card('sv-2', 'Area Zero', { supertype: 'Trainer', subtypes: ['Stadium'], hp: undefined })], totalCount: 1, page: 1, pageSize: 20 };
        return { data: [card('sv-1', 'Pikachu'), card('sv-3', 'Raichu')], totalCount: 2, page: 1, pageSize: 20 };
      }
    });
    server = await startServer({ label: 'card-usage', env: { POKEMONTCG_API_URL: api.url } });
  });

  after(async () => {
    if (server) await server.stop();
    if (api) await api.close();
  });

  it('has nothing to offer on a computer that has seen no cards', async () => {
    const response = await popular();
    assert.equal(response.status, 200, 'and "popular" is not taken for a card id');
    assert.deepEqual(response.json, { cards: [], totalCount: 0, page: 1, pageSize: 20, source: 'cache', used: 0 });
  });

  it('offers the cards a search already saved, before any was used', async () => {
    assert.equal((await call('GET', '/api/cards/search?q=pika')).json.cards.length, 2);
    const response = await popular();
    assert.deepEqual(names(response).sort(), ['Pikachu', 'Raichu']);
    assert.equal(response.json.source, 'cache');
    assert.deepEqual(response.json.cards[0].images, { small: 'https://images.test/sv/1.png', large: 'https://images.test/sv/1_hires.png' });
    assert.equal(response.json.cards[0].setName, 'Set sv');
  });

  it('narrows what it offers like a search is narrowed', async () => {
    await call('GET', `/api/cards/search?q=area&supertype=Trainer&subtype=Stadium`);
    assert.deepEqual(names(await popular('?supertype=Trainer&subtype=Stadium')), ['Area Zero']);
    assert.deepEqual(names(await popular(`?supertype=${encodeURIComponent('Pokémon')}`)).sort(), ['Pikachu', 'Raichu']);
    assert.deepEqual(names(await popular('?supertype=Energy')), []);
  });

  it('puts the cards that are used first, the most used at the very front', async () => {
    const raichu = { id: 'sv-3', name: 'Raichu', setName: 'Set sv', setId: 'sv', number: '3', rarity: 'Common', types: 'Lightning', hp: '70', supertype: 'Pokémon', subtypes: 'Basic', images: { small: 'https://images.test/sv/3.png', large: 'https://images.test/sv/3_hires.png' } };
    assert.deepEqual((await call('POST', '/api/cards/used', raichu)).json, { ok: true });
    let response = await popular(`?supertype=${encodeURIComponent('Pokémon')}`);
    assert.deepEqual(names(response), ['Raichu', 'Pikachu']);
    assert.equal(response.json.source, 'mixed');
    assert.equal(response.json.used, 1);

    const pikachu = { ...raichu, id: 'sv-1', name: 'Pikachu', number: '1' };
    await call('POST', '/api/cards/used', pikachu);
    await call('POST', '/api/cards/used', pikachu);
    response = await popular(`?supertype=${encodeURIComponent('Pokémon')}`);
    assert.deepEqual(names(response), ['Pikachu', 'Raichu'], 'used twice beats used once');
    assert.equal(response.json.source, 'used');
  });

  it('refuses what is not a card', async () => {
    for (const bad of [{}, { name: 'x' }, { id: '../etc/passwd', name: 'x' }, { id: 'sv-9' }, []]) {
      assert.equal((await call('POST', '/api/cards/used', bad)).status, 400, JSON.stringify(bad));
    }
    const sneaky = await call('POST', '/api/cards/used', { id: 'sv-8', name: 'Sneaky', images: { small: 'javascript:alert(1)', large: '/img/sv/8.png' }, supertype: 'Pokémon', subtypes: 'Basic' });
    assert.equal(sneaky.status, 200);
    const stored = (await popular()).json.cards.find((entry) => entry.id === 'sv-8');
    assert.deepEqual(stored.images, { small: '', large: '/img/sv/8.png' });
  });

  it('forgets the lookups with "clear remembered searches", and the use with its own call', async () => {
    assert.equal((await call('POST', '/api/cache/clear')).status, 200);
    let response = await popular();
    assert.ok(names(response).includes('Pikachu'), 'what was used stays');
    assert.equal(names(response).includes('Area Zero'), false, 'what was only saved is gone');

    assert.deepEqual((await call('DELETE', '/api/cards/used')).json, { ok: true });
    response = await popular();
    assert.deepEqual(response.json, { cards: [], totalCount: 0, page: 1, pageSize: 20, source: 'cache', used: 0 });
  });

  it('keeps the list and the counting behind the password', async () => {
    const locked = await startServer({ label: 'card-usage-locked', env: { POKEMONTCG_API_URL: api.url, OTO_PASSWORD: 'let-me-in' } });
    try {
      const ask = (method, path, body) => fetch(`${locked.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      assert.equal((await ask('GET', '/api/cards/popular')).status, 401);
      assert.equal((await ask('POST', '/api/cards/used', { id: 'sv-1', name: 'Pikachu' })).status, 401);
      assert.equal((await ask('DELETE', '/api/cards/used')).status, 401);
    } finally {
      await locked.stop();
    }
  });
});
