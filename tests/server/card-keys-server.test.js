const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, startMockScrydex, startMockImageHost, wait } = require('../support/harness');
const GAME = require('../../public/js/game-data');

// The keys of the card services, through the real server: kept on the server, shown masked, left out of everything that is shared
describe('the keys of the card services', () => {
  let scrydex;
  let images;
  let server;
  let producer;
  let other;
  const POKEMONTCG_KEY = '3f9a1c52-8d44-4e07-9b6e-0a1d2c3b4e5f';

  const call = async (method, route, body) => {
    const response = await fetch(`${server.base}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  };
  const settings = async () => (await call('GET', '/api/settings')).json;

  before(async () => {
    images = await startMockImageHost();
    scrydex = await startMockScrydex({
      cards: [{
        id: 'sv9-1', name: 'Pikachu', supertype: 'Pokémon', subtypes: ['Basic'], types: ['Lightning'], hp: '60', number: '1', rarity: 'Common',
        images: [{ type: 'front', small: `${images.url}/pokemon/sv9-1/small`, large: `${images.url}/pokemon/sv9-1/large` }],
        expansion: { id: 'sv9', name: 'Set' }, attacks: [{ name: 'Zap', damage: '30' }], abilities: [], convertedRetreatCost: '1'
      }]
    });
    server = await startServer({ label: 'card-keys', env: { OTO_SCRYDEX_API_URL: scrydex.url, OTO_SCRYDEX_IMAGE_BASE: images.url } });
    producer = server.client({ clientId: 'keys-producer-1', name: 'Maya' });
    other = server.client({ clientId: 'keys-producer-2', name: 'Noa' });
    await Promise.all([producer.ready(), other.ready()]);
  });

  after(async () => {
    if (server) await server.stop();
    await Promise.all([scrydex && scrydex.close(), images && images.close()]);
  });

  const everywhere = async () => JSON.stringify([
    (await call('GET', '/api/state')).json, (await call('GET', '/api/settings')).json, producer.state, other.state, (await call('GET', '/api/config/export')).text
  ]);

  it('lists the services and what each one takes, the same for the server and the control panel', () => {
    assert.deepEqual(GAME.CARD_SERVICES.map((service) => service.key), ['pokemontcg', 'scrydex', 'tcgdex']);
    assert.deepEqual(GAME.SECRET_SETTINGS, ['apiKey', 'scrydexKey', 'scrydexTeam']);
    assert.deepEqual(GAME.CARD_SOURCES.map((source) => source.key), ['auto', 'pokemontcg', 'scrydex', 'tcgdex']);
    assert.deepEqual(GAME.CARD_SERVICES.find((service) => service.key === 'tcgdex').credentials, [], 'TCGdex needs nothing');
    assert.deepEqual(GAME.CARD_SERVICES.find((service) => service.key === 'scrydex').credentials.map((entry) => [entry.setting, entry.needed]), [['scrydexKey', true], ['scrydexTeam', true]]);
  });

  it('starts with no keys, and says which are saved without saying what they are', async () => {
    const current = await settings();
    assert.deepEqual(current.keys, { apiKey: '', scrydexKey: '', scrydexTeam: '' });
    assert.equal(current.apiKeySet, false);
    for (const name of GAME.SECRET_SETTINGS) assert.equal(name in current, false, `${name} is not part of what a page is told`);
  });

  it('shows a saved key with its first three characters, three stars and its last four, and never the key', async () => {
    const saved = await producer.act('action:settings', { action: 'update', apiKey: `  ${POKEMONTCG_KEY}  ` });
    assert.equal(saved.ok, true);
    const current = await settings();
    assert.equal(current.keys.apiKey, '3f9***4e5f');
    assert.equal(current.apiKeySet, true);
    assert.equal('apiKey' in current, false);
    for (const where of [await everywhere()]) assert.equal(where.includes(POKEMONTCG_KEY), false, 'the key is in none of the places a page can see');
    assert.equal(other.state.settings.keys.apiKey, '3f9***4e5f', 'the other producers see the same mask');
  });

  it('shows a short key with less of it, since the ends would be most of it', async () => {
    await producer.act('action:settings', { action: 'update', scrydexTeam: 'team12345' });
    assert.equal((await settings()).keys.scrydexTeam, 'te***45');
    await producer.act('action:settings', { action: 'update', scrydexTeam: 'abc123' });
    assert.equal((await settings()).keys.scrydexTeam, '***');
    await producer.act('action:settings', { action: 'update', scrydexTeam: '' });
  });

  it('refuses something that cannot be a key, with the reason, and keeps the one it had', async () => {
    for (const bad of ['has a space', 'line\nbreak', 'x'.repeat(201), 'accént', 5, null, ['a']]) {
      const result = await producer.act('action:settings', { action: 'update', apiKey: bad });
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.equal(result.rejected.reason, 'invalid');
      assert.match(result.rejected.message, /does not look like a key/);
    }
    assert.equal((await settings()).keys.apiKey, '3f9***4e5f');
    assert.equal(server.logs().includes(POKEMONTCG_KEY), false, 'it is not in the logs either');
  });

  it('tells the other producers that a key changed, but never what it is', async () => {
    const heard = other.expect('activity', (entry) => /key changed/.test(entry.label));
    await producer.act('action:settings', { action: 'update', scrydexKey: scrydex.key });
    const entry = await heard;
    assert.equal(entry.label, 'A card service key changed');
    assert.equal(entry.by.name, 'Maya');
    assert.equal(JSON.stringify(entry).includes(scrydex.key), false);
  });

  it('keeps the keys out of an exported configuration, and a configuration taken in cannot change them', async () => {
    const exported = (await call('GET', '/api/config/export')).json;
    for (const name of GAME.SECRET_SETTINGS) assert.equal(exported.settings[name], '', name);

    const before = await settings();
    const imported = await call('POST', '/api/config/import', { ...exported, settings: { ...exported.settings, toastSeconds: 5, apiKey: 'evil-key-from-a-file', scrydexKey: '' } });
    assert.equal(imported.status, 200);
    const after = await settings();
    assert.equal(after.toastSeconds, 5, 'the rest of it was taken in');
    assert.deepEqual(after.keys, before.keys, 'the keys stayed as they were');
  });

  it('uses the account of Scrydex when it is chosen: the real key and team go to the service, the pictures are kept here', async () => {
    await producer.act('action:settings', { action: 'update', scrydexTeam: scrydex.team });
    assert.equal((await settings()).keys.scrydexTeam, 'tes***0123');
    await call('POST', '/api/settings', { apiProvider: 'scrydex' });
    scrydex.headers.length = 0;
    const found = await call('GET', '/api/cards/search?q=pika');
    assert.equal(found.status, 200);
    assert.equal(found.json.source, 'scrydex');
    assert.equal(found.json.cards[0].name, 'Pikachu');
    assert.equal(scrydex.headers[0]['x-api-key'], scrydex.key);
    assert.equal(scrydex.headers[0]['x-team-id'], scrydex.team);
    assert.equal(found.json.cards[0].images.small, '/img/scrydex/sv9-1_small.png');
    const picture = await fetch(`${server.base}${found.json.cards[0].images.small}`);
    assert.equal(picture.status, 200);
    const card = await call('GET', '/api/cards/sv9-1?source=scrydex');
    assert.deepEqual([card.json.name, card.json.retreat, card.json.attacks.length], ['Pikachu', 1, 1]);
  });

  it('says what is wrong when the account is not accepted, and when a key is taken away', async () => {
    await producer.act('action:settings', { action: 'update', scrydexKey: 'a-key-that-is-not-theirs' });
    const refused = await call('GET', '/api/cards/search?q=charizard');
    assert.equal(refused.status, 500);
    assert.match(refused.json.error, /did not accept the API key and team ID/);

    await producer.act('action:settings', { action: 'update', scrydexKey: '', scrydexTeam: '' });
    const none = await call('GET', '/api/cards/search?q=charizard2');
    assert.match(none.json.error, /needs your API key and your team ID/);
    assert.deepEqual((await settings()).keys, { apiKey: '3f9***4e5f', scrydexKey: '', scrydexTeam: '' });
    await call('POST', '/api/settings', { apiProvider: 'auto' });
  });

  it('chooses which service builds the libraries, and refuses one it does not know', async () => {
    assert.equal((await settings()).librarySource, 'pokemontcg');
    await call('POST', '/api/settings', { librarySource: 'tcgdex' });
    assert.equal((await settings()).librarySource, 'tcgdex');
    await call('POST', '/api/settings', { librarySource: 'klingon' });
    await call('POST', '/api/settings', { librarySource: 5 });
    assert.equal((await settings()).librarySource, 'tcgdex');
    await call('POST', '/api/settings', { librarySource: 'pokemontcg' });
  });

  it('builds the Standard library from the service chosen in the settings, refuses Scrydex without its key, and updates it by asking how many cards there are', async () => {
    // the job that a download started, once it has ended
    const finished = async (started) => {
      for (let tries = 0; tries < 200; tries++) {
        const status = (await call('GET', '/api/catalog')).json;
        if (status.job && status.job.id === started.job.id && status.job.finished) return status;
        await wait(50);
      }
      throw new Error('the library job never ended');
    };
    await producer.act('action:settings', { action: 'update', scrydexKey: '', scrydexTeam: '' });
    await call('POST', '/api/settings', { librarySource: 'scrydex' });
    const refused = await call('POST', '/api/catalog/standard/download', {});
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /Scrydex needs your API key and team ID/);

    await producer.act('action:settings', { action: 'update', scrydexKey: scrydex.key, scrydexTeam: scrydex.team });
    scrydex.requests.length = 0;
    const started = await call('POST', '/api/catalog/standard/download', {});
    assert.equal(started.status, 202, 'accepted: it runs in the background');
    const built = await finished(started.json);
    assert.equal(built.job.phase, 'done', built.job.message);
    const standard = built.profiles.find((profile) => profile.id === 'standard');
    assert.deepEqual([standard.ready, standard.source, standard.using, standard.updatable], [true, 'scrydex', 'scrydex', true]);
    assert.ok(scrydex.requests.length > 0, 'Scrydex was asked');

    scrydex.requests.length = 0;
    const updated = await finished((await call('POST', '/api/catalog/standard/download', {})).json);
    assert.match(updated.job.message, /^Standard is up to date: \d+ cards \(from Scrydex\)\. Nothing new\.$/);
    assert.ok(scrydex.requests.every((url) => url.includes('page_size=1')), 'only how many cards each search has');

    await call('POST', '/api/settings', { librarySource: 'pokemontcg' });
    const after = (await call('GET', '/api/catalog')).json.profiles.find((profile) => profile.id === 'standard');
    assert.deepEqual([after.using, after.updatable], ['pokemontcg', false], 'from another service, an update would download it all again');
    assert.equal((await call('DELETE', '/api/catalog/standard')).status, 200);
    await producer.act('action:settings', { action: 'update', scrydexKey: '', scrydexTeam: '' });
  });

  it('is never in a package: not the key, not the team, not the choice of a service', async () => {
    const exported = await fetch(`${server.base}/api/packages/export?controls=1`);
    const bytes = Buffer.from(await exported.arrayBuffer()).toString('latin1');
    for (const secret of [POKEMONTCG_KEY, scrydex.key, scrydex.team, 'scrydexKey', 'scrydexTeam', 'apiKey', 'librarySource']) assert.equal(bytes.includes(secret), false, secret);
  });
});
