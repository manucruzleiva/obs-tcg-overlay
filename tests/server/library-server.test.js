const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, startMockCardApi, startMockImageHost, respond, wait } = require('../support/harness');

// The card library and card pictures through the real server
describe('card library through the server', () => {
  let images;
  let scrydex;
  let api;
  let server;
  let producer;
  let overlay;
  let handler;

  const card = (id, name, extra = {}) => {
    const [set, number] = id.split('-');
    return {
      id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp: '70', types: ['Lightning'], number, rarity: 'Common',
      set: { id: set, name: `Set ${set}`, releaseDate: '2024/05/01' },
      images: { small: `${images.url}/${set}/${number}.png`, large: `${images.url}/${set}/${number}_hires.png` },
      regulationMark: 'H', legalities: { expanded: 'Legal' }, ...extra
    };
  };

  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${server.base}${path}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text, buffer, headers: response.headers };
  };

  before(async () => {
    images = await startMockImageHost();
    scrydex = await startMockImageHost();
    const library = () => [
      card('sv4-1', 'Pikachu', { abilities: [{ name: 'Static', text: 'Paralyze.' }] }),
      card('sv4-2', 'Raichu', { evolvesFrom: 'Pikachu' }),
      card('sv8-3', 'Iono', { supertype: 'Trainer', subtypes: ['Supporter'], hp: undefined })
    ];
    handler = (url) => {
      const params = new URL(url, 'http://mock').searchParams;
      const q = params.get('q') || '';
      // a card that is not in the library, for the online fallback
      if (q.includes('zubat')) return { data: [card('xx-9', 'Zubat', { set: { id: 'xx', name: 'Elsewhere', releaseDate: '2020/01/01' } })], totalCount: 1, page: 1, pageSize: 20 };
      // another one, from a new set: its pictures are on Scrydex
      if (q.includes('oddish')) {
        const pictures = { small: `${scrydex.url}/pokemon/me3-5/small`, large: `${scrydex.url}/pokemon/me3-5/large` };
        return { data: [card('me3-5', "Erika's Oddish", { images: pictures, set: { id: 'me3', name: 'Perfect Order', releaseDate: '2026/03/27' } })], totalCount: 1, page: 1, pageSize: 20 };
      }
      const found = library().filter((item) => !/regulationMark:(\w)/.test(q) || q.includes(`regulationMark:${item.regulationMark}`));
      const page = Number(params.get('page') || 1);
      const pageSize = Number(params.get('pageSize') || 20);
      return { data: found.slice((page - 1) * pageSize, page * pageSize), page, pageSize, totalCount: found.length };
    };
    api = await startMockCardApi({
      '/cards/sv4-1': () => ({ data: card('sv4-1', 'Pikachu (online copy)') }),
      '/cards/xx-9': () => ({ data: card('xx-9', 'Zubat', { abilities: [{ name: 'Leech Life' }] }) }),
      '/cards?': (url) => handler(url)
    });
    server = await startServer({
      label: 'library',
      env: { POKEMONTCG_API_URL: api.url, OTO_IMAGE_BASE: images.url, OTO_SCRYDEX_IMAGE_BASE: scrydex.url, OTO_CATALOG_PACE_MS: '0', OTO_CATALOG_RETRY_MS: '2' }
    });
    producer = server.client({ clientId: 'lib-producer', name: 'Maya' });
    overlay = server.client({ clientId: 'lib-overlay', role: 'overlay' });
    await Promise.all([producer.ready(), overlay.ready()]);
  });

  after(async () => {
    if (server) await server.stop();
    await Promise.all([images && images.close(), scrydex && scrydex.close(), api && api.close()]);
  });

  it('starts with nothing downloaded and searches online', async () => {
    const { status, json } = await call('GET', '/api/catalog');
    assert.equal(status, 200);
    assert.equal(json.active, null);
    assert.deepEqual(json.profiles.map((p) => [p.id, p.ready]), [['standard', false], ['glc', false], ['expanded', false]]);
    assert.deepEqual(json.pictures, { count: 0, bytes: 0 });
    assert.equal(json.job, null);

    const search = await call('GET', '/api/cards/search?q=pika');
    assert.equal(search.status, 200);
    assert.equal(search.json.source, undefined, 'answered by the card service');
    assert.equal(search.json.cards[0].name, 'Pikachu');
    assert.deepEqual(search.json.cards[0].images, { small: '/img/sv4/1.png', large: '/img/sv4/1_hires.png' }, 'pictures go through this app even for online results');
  });

  it('checks what it is asked to download', async () => {
    const big = await call('POST', '/api/catalog/expanded/download', {});
    assert.equal(big.status, 400);
    assert.equal(big.json.needsConfirm, true);
    assert.ok(big.json.approximate > 10000);
    assert.equal((await call('POST', '/api/catalog/bogus/download', {})).status, 404);
    assert.equal((await call('PUT', '/api/catalog/active', { profile: 'glc' })).status, 409);
    assert.equal((await call('PUT', '/api/catalog/active', { profile: 'bogus' })).status, 404);
    assert.equal((await call('DELETE', '/api/catalog/bogus')).status, 404);
    assert.equal((await call('POST', '/api/catalog/pictures', { sizes: 'standard' })).status, 409, 'no library chosen yet');
  });

  it('downloads Standard in the background and tells the producers how it is going', async () => {
    const finished = producer.expect('catalog:progress', (status) => status.job && status.job.finished, 8000);
    const started = await call('POST', '/api/catalog/standard/download', {});
    assert.equal(started.status, 202);

    const status = await finished;
    assert.equal(status.job.phase, 'done');
    assert.equal(status.job.ok, true);
    assert.equal(status.active, 'standard', 'the first library downloaded is the one in use');
    assert.deepEqual(status.profiles[0].count, 3);

    const phases = new Set(producer.events['catalog:progress'].filter((s) => s.job).map((s) => s.job.phase));
    assert.ok(['counting', 'downloading', 'saving', 'done'].every((phase) => phases.has(phase)), [...phases].join());
    assert.equal(overlay.events['catalog:progress'], undefined, 'the overlay is not sent download progress');
  });

  it('answers card searches from the library, without asking the card service', async () => {
    api.requests.length = 0;
    const search = await call('GET', '/api/cards/search?q=pika');
    assert.equal(search.json.source, 'library');
    assert.equal(search.json.library, 'Standard');
    assert.deepEqual(search.json.cards.map((c) => c.name), ['Pikachu']);
    assert.equal(api.requests.length, 0);

    const evolutions = await call('GET', '/api/cards/search?evolvesFrom=Pikachu');
    assert.deepEqual(evolutions.json.cards.map((c) => c.name), ['Raichu'], 'the evolutions of a Pokémon need no search text');
    assert.equal(api.requests.length, 0);

    const one = await call('GET', '/api/cards/sv4-1');
    assert.equal(one.json.name, 'Pikachu', 'from the library, not the online copy');
    assert.deepEqual(one.json.abilities, ['Static']);
    assert.equal(api.requests.length, 0);
  });

  it('adds the abilities of a chosen card from the library, with no internet needed', async () => {
    api.requests.length = 0;
    const answer = await producer.act('action:card', {
      action: 'select', target: 'trainerA-active', cardId: 'sv4-1',
      cardData: { id: 'sv4-1', name: 'Pikachu', hp: '70', images: { small: '/img/sv4/1.png', large: '/img/sv4/1_hires.png' } }
    });
    assert.equal(answer.ok, true);
    const active = answer.state.trainerA.active;
    assert.equal(active.image, '/img/sv4/1_hires.png', 'the picture address on this app is kept');
    assert.deepEqual(active.abilities.map((a) => a.name), ['Static']);
    assert.equal(api.requests.length, 0);
  });

  it('looks online for a card the library does not have, and says when it cannot', async () => {
    const online = await call('GET', '/api/cards/search?q=zubat');
    assert.equal(online.json.source, undefined);
    assert.equal(online.json.cards[0].name, 'Zubat');

    const saved = handler;
    handler = () => respond(503, { error: 'down' });
    try {
      const offline = await call('GET', '/api/cards/search?q=golbat');
      assert.equal(offline.status, 200, 'not an error: the library answered, with nothing');
      assert.equal(offline.json.offline, true);
      assert.equal(offline.json.library, 'Standard');
      assert.deepEqual(offline.json.cards, []);
      assert.equal((await call('GET', '/api/cards/search?q=iono')).json.cards[0].name, 'Iono', 'the library still works');
    } finally {
      handler = saved;
    }
  });

  it('searches the card service for the evolutions of a Pokémon without any text', async () => {
    assert.equal((await call('PUT', '/api/catalog/active', { profile: null })).json.active, null);
    api.requests.length = 0;
    const found = await call('GET', `/api/cards/search?evolvesFrom=Pikachu&supertype=${encodeURIComponent('Pokémon')}`);
    assert.equal(found.status, 200);
    const asked = decodeURIComponent(api.requests.find((url) => url.startsWith('/cards?')));
    assert.match(asked, /evolvesFrom:"Pikachu"/);
    assert.match(asked, /supertype:"Pokémon"/);
    assert.doesNotMatch(asked, /name:/);

    assert.equal((await call('GET', '/api/cards/search')).status, 400);
    assert.equal((await call('GET', `/api/cards/search?q=${'x'.repeat(201)}`)).status, 400);
    assert.equal((await call('GET', '/api/cards/search?q=a&rarity[x]=1')).status, 200, 'odd filters are ignored, not trusted');

    assert.equal((await call('PUT', '/api/catalog/active', { profile: 'standard' })).json.active, 'standard');
  });

  it('serves card pictures from disk after fetching each once', async () => {
    images.requests.length = 0;
    const first = await call('GET', '/img/sv4/1.png');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.match(first.headers.get('cache-control'), /immutable/);
    assert.deepEqual(first.buffer, images.png);
    assert.equal(images.requests.length, 1);

    assert.equal((await call('GET', '/img/sv4/1.png')).status, 200);
    assert.equal(images.requests.length, 1, 'the second time comes from disk');
  });

  it('serves the pictures of the newest sets, which are on Scrydex, the same way', async () => {
    // an online result for a card of a new set already points at this app
    const online = await call('GET', '/api/cards/search?q=oddish');
    assert.equal(online.status, 200);
    assert.deepEqual(online.json.cards[0].images, { small: '/img/scrydex/me3-5_small.png', large: '/img/scrydex/me3-5_large.png' });

    scrydex.requests.length = 0;
    const first = await call('GET', '/img/scrydex/me3-5_small.png');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.deepEqual(first.buffer, scrydex.png);
    assert.deepEqual(scrydex.requests, ['/pokemon/me3-5/small']);

    assert.equal((await call('GET', '/img/scrydex/me3-5_small.png')).status, 200);
    assert.equal(scrydex.requests.length, 1, 'the second time comes from disk');

    // only their card pictures are ever asked for
    for (const name of ['evil.png', 'me3-5.png', 'me3-5_huge.png', 'me3-5_small.jpg', 'a_b_small.png']) {
      assert.equal((await call('GET', `/img/scrydex/${name}`)).status, 404, name);
    }
    assert.equal(scrydex.requests.length, 1);
  });

  it('still shows a picture it has seen when the picture host is gone', async () => {
    await call('GET', '/img/sv4/2.png');
    await images.close();
    assert.equal((await call('GET', '/img/sv4/2.png')).status, 200);
    assert.equal((await call('GET', '/img/sv4/99.png')).status, 404, 'one it never saw cannot be had');
  });

  it('refuses picture addresses that are not plain names', async () => {
    for (const path of ['/img/a%2Fb/1.png', '/img/sv4/..%5C..%5Cx.png', '/img/sv4/x.exe', '/img/sv4/%2e%2e', `/img/${'x'.repeat(50)}/1.png`, '/img/sv4']) {
      const { status } = await call('GET', path);
      assert.ok(status === 404, `${path} gave ${status}`);
    }
  });

  it('can save the library pictures ahead of time, and delete them', async () => {
    // a fresh picture host (the first one is closed)
    await server.stop();
    images = await startMockImageHost();
    server = await startServer({
      label: 'library-pictures',
      env: { POKEMONTCG_API_URL: api.url, OTO_IMAGE_BASE: images.url, OTO_SCRYDEX_IMAGE_BASE: scrydex.url, OTO_CATALOG_PACE_MS: '0', OTO_CATALOG_RETRY_MS: '2' }
    });
    producer = server.client({ clientId: 'lib-producer-2', name: 'Maya' });
    await producer.ready();

    const finishedLibrary = producer.expect('catalog:progress', (status) => status.job && status.job.finished, 8000);
    await call('POST', '/api/catalog/standard/download', {});
    await finishedLibrary;

    assert.equal((await call('POST', '/api/catalog/pictures', { sizes: 'enormous' })).status, 400);
    const finished = producer.expect('catalog:progress', (status) => status.job && status.job.kind === 'pictures' && status.job.finished, 8000);
    assert.equal((await call('POST', '/api/catalog/pictures', { sizes: 'both' })).status, 202);
    const status = await finished;
    assert.equal(status.job.phase, 'done');
    assert.equal(status.job.done, 6, 'two pictures for each of the three cards');
    assert.equal(images.requests.length, 6);

    const stats = (await call('GET', '/api/catalog')).json.pictures;
    assert.equal(stats.count, 6);
    assert.equal(stats.bytes, 6 * images.png.length);

    assert.equal((await call('DELETE', '/api/catalog/pictures')).json.pictures.count, 0);
  });

  it('removes a library', async () => {
    const removed = await call('DELETE', '/api/catalog/standard');
    assert.equal(removed.status, 200);
    assert.equal(removed.json.active, null);
    assert.equal(removed.json.profiles[0].ready, false);
  });

  it('keeps the library behind the password, while pictures stay open for OBS', async () => {
    const locked = await startServer({
      label: 'library-locked',
      env: { POKEMONTCG_API_URL: api.url, OTO_IMAGE_BASE: images.url, OTO_PASSWORD: 'let-me-in' }
    });
    try {
      const get = (path, init) => fetch(`${locked.base}${path}`, init);
      assert.equal((await get('/api/catalog')).status, 401);
      assert.equal((await get('/api/catalog/standard/download', { method: 'POST' })).status, 401);
      assert.equal((await get('/api/catalog/pictures', { method: 'DELETE' })).status, 401);
      assert.equal((await get('/api/cards/search?q=pika')).status, 401);
      assert.notEqual((await get('/img/sv4/1.png')).status, 401);
    } finally {
      await locked.stop();
    }
  });
});
