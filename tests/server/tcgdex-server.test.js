const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, startMockCardApi, startMockTcgdex, startMockImageHost, respond } = require('../support/harness');

// TCGdex as a card source, through the real server: the search and the fallback, pictures kept on this computer,
// the settings, and what happens when a card of TCGdex is put in play
describe('TCGdex through the server', () => {
  let assets;
  let dex;
  let api;
  let server;
  let producer;
  let apiDown = true;

  const dexCard = (id, name, extra = {}) => {
    const [set, local] = id.split('-');
    return {
      id, localId: local, name, image: `${assets.url}/en/series/${set}/${local}`, category: 'Pokemon', rarity: 'Common', hp: 70, types: ['Lightning'], stage: 'Basic',
      set: { id: set, name: `Dex set ${set}` }, ...extra
    };
  };
  const call = async (method, route, body) => {
    const response = await fetch(`${server.base}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buffer.toString('utf8')); } catch { /* not JSON */ }
    return { status: response.status, json, buffer, headers: response.headers };
  };
  const settings = async (patch) => { await call('POST', '/api/settings', patch); return (await call('GET', '/api/settings')).json; };

  before(async () => {
    assets = await startMockImageHost();
    dex = await startMockTcgdex({
      cards: [
        dexCard('sv9-1', 'Pikachu', { attacks: [{ name: 'Zap', damage: 30 }, { name: 'Bolt', damage: '60+' }], retreat: 2, abilities: [{ name: 'Static' }], hp: 90 }),
        dexCard('sv9-2', 'Pikachu ex', { suffix: 'ex', hp: 200 }),
        dexCard('sv9-3', 'Area Zero', { category: 'Trainer', trainerType: 'Stadium', hp: undefined, types: undefined, stage: undefined })
      ]
    });
    // the Pokémon TCG API: down, or answering with one card, as a test decides
    api = await startMockCardApi({
      '/cards': () => (apiDown ? respond(503, { error: 'down' }) : { data: [{ id: 'base1-58', name: 'Pikachu (API)', supertype: 'Pokémon', subtypes: ['Basic'], hp: '40', number: '58', rarity: 'Common', types: ['Lightning'], set: { id: 'base1', name: 'Base' }, images: {} }], totalCount: 1, page: 1, pageSize: 20 })
    });
    server = await startServer({ label: 'tcgdex', env: { POKEMONTCG_API_URL: api.url, OTO_TCGDEX_URL: dex.url, OTO_TCGDEX_ASSETS: assets.url } });
    producer = server.client({ clientId: 'tcgdex-producer', name: 'Maya' });
    await producer.ready();
  });

  after(async () => {
    if (server) await server.stop();
    await Promise.all([assets && assets.close(), dex && dex.close(), api && api.close()]);
  });

  it('starts on automatic, in English', async () => {
    const current = (await call('GET', '/api/settings')).json;
    assert.equal(current.apiProvider, 'auto');
    assert.equal(current.cardLanguage, 'en');
  });

  it('asks TCGdex when the Pokémon TCG API does not answer, and serves its pictures from this computer', async () => {
    const found = await call('GET', '/api/cards/search?q=pika');
    assert.equal(found.status, 200);
    assert.equal(found.json.source, 'tcgdex');
    assert.deepEqual(found.json.cards.map((card) => card.name).sort(), ['Pikachu', 'Pikachu ex']);
    const pikachu = found.json.cards.find((card) => card.name === 'Pikachu');
    assert.deepEqual(pikachu.images, { small: '/img/tcgdex/en__series__sv9__1__low.webp', large: '/img/tcgdex/en__series__sv9__1__high.webp' });
    assert.equal(pikachu.source, 'tcgdex');

    const picture = await call('GET', pikachu.images.small);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get('content-type'), 'image/webp');
    assert.deepEqual(picture.buffer, assets.png);
    assert.deepEqual(assets.requests, ['/en/series/sv9/1/low.webp']);
    await call('GET', pikachu.images.small);
    assert.equal(assets.requests.length, 1, 'kept on this computer: the host is not asked again');
    assert.ok(fs.existsSync(path.join(server.dir, 'images', 'tcgdex', 'en__series__sv9__1__low.webp')));
  });

  it('serves only pictures of TCGdex with the names it makes, never another address', async () => {
    for (const name of ['..__x.webp', 'en__series__sv9__1__huge.webp', 'en__series__sv9__low.webp', 'en__a__b__c__low.exe', 'en__../../x__b__c__low.webp', 'EN%2F..__a__b__c__low.webp']) {
      assert.equal((await call('GET', `/img/tcgdex/${name}`)).status, 404, name);
    }
    assert.ok(assets.requests.every((url) => /^\/en\/series\/sv9\/1\/low\.webp$/.test(url)), 'none of those reached the picture host');
  });

  it('is told where cards come from and in which language, and the settings refuse what they do not know', async () => {
    assert.equal((await settings({ apiProvider: 'klingon' })).apiProvider, 'auto');
    assert.equal((await settings({ cardLanguage: 'tlh' })).cardLanguage, 'en');
    assert.equal((await settings({ apiProvider: 5 })).apiProvider, 'auto');
    const now = await settings({ apiProvider: 'tcgdex', cardLanguage: 'es' });
    assert.deepEqual([now.apiProvider, now.cardLanguage], ['tcgdex', 'es']);

    dex.requests.length = 0;
    const found = await call('GET', '/api/cards/search?q=pika');
    assert.equal(found.json.source, 'tcgdex');
    assert.ok(found.json.cards.every((card) => card.language === 'es'));
    assert.match(dex.requests[0], /^GET \/v2\/es\/cards\?/);
  });

  it('looks a card up in the service it came from, with its attacks, retreat cost and abilities', async () => {
    const card = await call('GET', '/api/cards/sv9-1?source=tcgdex&language=es');
    assert.equal(card.status, 200);
    assert.equal(card.json.name, 'Pikachu');
    assert.deepEqual(card.json.attacks, [{ name: 'Zap', damage: 30, mod: '' }, { name: 'Bolt', damage: 60, mod: '+' }]);
    assert.equal(card.json.retreat, 2);
    assert.deepEqual(card.json.abilities, ['Static']);
    assert.match(dex.requests[dex.requests.length - 1], /^GET \/v2\/es\/cards\/sv9-1$/);
    assert.equal((await call('GET', '/api/cards/nope-1?source=tcgdex')).status, 404);
    assert.equal((await call('GET', '/api/cards/sv9-1?source=evil&language=../x')).status, 200, 'what it does not know is left out');
  });

  it('takes a card of TCGdex into play with what the card can do', async () => {
    await settings({ apiProvider: 'auto', cardLanguage: 'en' });
    const search = (await call('GET', '/api/cards/search?q=pikachu')).json.cards.find((card) => card.name === 'Pikachu');
    const applied = await producer.act('action:card', {
      action: 'select', target: 'trainerA-active', cardId: search.id,
      cardData: { id: search.id, name: search.name, hp: search.hp, images: search.images, source: search.source, language: search.language }
    });
    assert.equal(applied.ok, true);
    const active = (await call('GET', '/api/state')).json.trainerA.active;
    assert.equal(active.name, 'Pikachu');
    assert.equal(active.hp.max, 90, 'the HP of the card in the list');
    assert.deepEqual(active.attacks, [{ name: 'Zap', damage: 30, mod: '' }, { name: 'Bolt', damage: 60, mod: '+' }]);
    assert.equal(active.retreat, 2);
    assert.deepEqual(active.abilities.map((ability) => ability.name), ['Static']);
    assert.equal(active.image, '/img/tcgdex/en__series__sv9__1__high.webp', 'and its picture is kept on this computer');
  });

  it('keeps to the Pokémon TCG API when told to, and says so when it does not answer', async () => {
    await settings({ apiProvider: 'pokemontcg' });
    dex.requests.length = 0;
    const down = await call('GET', '/api/cards/search?q=pikachu&page=2');
    assert.equal(down.status, 500);
    assert.equal(dex.requests.length, 0, 'TCGdex is not asked');
    apiDown = false;
    const found = await call('GET', '/api/cards/search?q=pika');
    assert.equal(found.json.cards[0].name, 'Pikachu (API)');
    assert.equal(found.json.source, undefined);
    apiDown = true;
  });

  it('lists what it found for the picker to start from, pictures included', async () => {
    await settings({ apiProvider: 'auto', cardLanguage: 'en' });
    const popular = (await call('GET', '/api/cards/popular')).json;
    assert.ok(popular.cards.some((card) => card.name === 'Pikachu' && card.source === 'tcgdex' && card.images.small.startsWith('/img/tcgdex/')), 'what TCGdex gave was saved with the rest');
  });
});
