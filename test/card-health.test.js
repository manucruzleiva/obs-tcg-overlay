/**
 * The health check of the card data (src/services/card-health.js): finding the cards that lack their attacks or their retreat cost, and mending them.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { CardHealth, problemsOf, lacksDetails } = require('../src/services/card-health');
const { startServer, startMockCardApi, startMockImageHost } = require('../test-support/harness');

const pokemon = (id, extra = {}) => ({
  id, name: id, supertype: 'Pokémon', hp: '70', images: { small: `/img/${id}.png`, large: `/img/${id}_hires.png` },
  abilities: [], attacks: [{ name: 'Gnaw', damage: '20' }], retreat: 1, ...extra
});

describe('what is wrong with a card', () => {
  it('is nothing for a Pokémon that has its attacks and its retreat cost, or for a card that is not a Pokémon', () => {
    assert.deepEqual(problemsOf(pokemon('a')), []);
    assert.deepEqual(problemsOf(pokemon('free', { retreat: 0 })), [], 'a retreat cost of nothing is a retreat cost');
    assert.deepEqual(problemsOf(pokemon('ability-only', { attacks: [], abilities: ['Static'] })), []);
    assert.deepEqual(problemsOf({ id: 't', name: 'Iono', supertype: 'Trainer', images: { small: 's' } }), [], 'a Trainer has no attacks to lack');
    assert.equal(lacksDetails(pokemon('a')), false);
  });

  it('says what a Pokémon lacks: attacks never looked up, a retreat cost never looked up, nothing at all, no HP, no picture', () => {
    assert.deepEqual(problemsOf(pokemon('old', { attacks: undefined })), ['noAttackData']);
    assert.deepEqual(problemsOf(pokemon('old', { retreat: undefined })), ['noRetreatData']);
    assert.deepEqual(problemsOf(pokemon('empty', { attacks: [], abilities: [] })), ['emptyCard']);
    assert.deepEqual(problemsOf(pokemon('nohp', { hp: '' })), ['noHp']);
    assert.deepEqual(problemsOf(pokemon('nopicture', { images: {} })), ['noPicture']);
    assert.deepEqual(problemsOf(pokemon('everything', { attacks: undefined, retreat: undefined, hp: '', images: {} })).sort(), ['noAttackData', 'noHp', 'noPicture', 'noRetreatData']);
    assert.equal(lacksDetails(pokemon('empty', { attacks: [], abilities: [] })), true);
    assert.equal(lacksDetails(pokemon('nohp', { hp: '' })), false, 'a missing HP is not mended by asking for the attacks');
  });

  it('leaves a card alone once it was asked for and really has nothing: it is marked detailed', () => {
    assert.deepEqual(problemsOf(pokemon('unown', { attacks: [], abilities: [], detailed: true })), []);
  });

  it('is told apart for a card that is not even there', () => {
    assert.deepEqual(problemsOf(null), ['noPicture']);
    assert.equal(lacksDetails(undefined), false);
  });
});

describe('the health check, with the services it works with replaced', () => {
  const trainerState = (...pokemonList) => ({ trainerA: { active: pokemonList[0] || null, bench: pokemonList.slice(1) }, trainerB: { active: null, bench: [] } });
  const bare = (cardId, name) => ({ cardId, name, attacks: [], abilities: [], retreat: 0 });

  function build({ library = [], rows = [], state = trainerState(), details = {}, running = false, limit = 400, filled = [] } = {}) {
    const patched = [];
    const forgotten = [];
    const asked = [];
    const catalog = {
      libraryIds: () => (library.length ? ['standard'] : []),
      readLibrary: () => library.map((card) => ({ ...card })),
      labelOf: () => 'Standard',
      sourceOf: () => 'pokemontcg',
      running: () => running,
      patchRecords: (id, patches) => { patched.push([id, new Map(patches)]); return patches.size; }
    };
    const db = {
      cachedCardRows: () => rows.filter((row) => !forgotten.includes(row.id)),
      deleteCachedCard: (id) => { forgotten.push(id); }
    };
    const pokemonTCG = {
      getCard: async (id, hint, options) => {
        asked.push([id, hint, options]);
        if (!(id in details)) throw new Error('the card service is not answering');
        return details[id];
      }
    };
    const health = new CardHealth({
      db, catalog, pokemonTCG, readState: () => state, paceMs: 0, limit,
      healInPlay: async (side, slot) => { filled.push([side, slot]); return true; }
    });
    return { health, patched, forgotten, asked, filled };
  }

  const finished = (health) => new Promise((resolve) => {
    if (health.job && health.job.finished) return resolve(health.job);
    health.on('progress', (status) => { if (status.job && status.job.finished) resolve(status.job); });
  });

  it('counts the problems of each library, of the lookup cache and of the Pokémon on the table, without changing anything', () => {
    const { health, patched, forgotten } = build({
      library: [pokemon('ok'), pokemon('empty', { attacks: [], abilities: [] }), pokemon('old', { attacks: undefined }), { id: 'iono', name: 'Iono', supertype: 'Trainer', images: { small: 'x' } }],
      rows: [{ id: 'sv4-9', provider: 'pokemontcg', data: pokemon('sv4-9', { attacks: undefined, retreat: undefined }) }, { id: 'sv4-8', provider: 'pokemontcg', data: pokemon('sv4-8') }],
      state: trainerState(bare('c1', 'Eevee'), { cardId: 'c2', name: 'Fine', attacks: [{ name: 'Tackle' }], abilities: [], retreat: 1 })
    });
    const report = health.scan();
    assert.deepEqual(report.libraries.map((library) => [library.id, library.label, library.cards, library.pokemon, library.flagged, library.repairable]), [['standard', 'Standard', 4, 3, 2, 2]]);
    assert.deepEqual(report.libraries[0].problems, { emptyCard: 1, noAttackData: 1 });
    assert.deepEqual(report.libraries[0].samples.map((sample) => sample.id).sort(), ['empty', 'old']);
    assert.deepEqual([report.lookup.cards, report.lookup.flagged, report.lookup.repairable], [2, 1, 1]);
    assert.deepEqual(report.inPlay, [{ side: 'trainerA', slot: -1, name: 'Eevee', cardId: 'c1' }], 'only the Pokémon with nothing on file');
    assert.equal(report.flagged, 2 + 1 + 1);
    assert.deepEqual([patched.length, forgotten.length], [0, 0]);
    assert.equal(health.status().report, report);
  });

  it('mends a library by asking the card service for each Pokémon that lacks its data, and writes it back marked as detailed', async () => {
    const { health, patched, asked } = build({
      library: [pokemon('ok'), pokemon('empty', { attacks: [], abilities: [] }), pokemon('old', { attacks: undefined })],
      details: {
        empty: { attacks: [{ name: 'Slash', damage: '30' }], retreat: 2, abilities: ['Static'], evolvesFrom: 'Pichu' },
        old: { attacks: [], retreat: 0, abilities: [] }
      }
    });
    const job = health.repair();
    assert.equal(job.finished, false);
    const done = await finished(health);
    assert.equal(done.phase, 'done');
    assert.deepEqual(asked.map(([id, hint, options]) => [id, hint.source, options.fresh]), [['empty', 'pokemontcg', true], ['old', 'pokemontcg', true]], 'only the ones that lack data, asked afresh, of the service that built the library');
    assert.equal(patched.length, 1);
    const [id, patches] = patched[0];
    assert.equal(id, 'standard');
    assert.deepEqual(patches.get('empty'), { attacks: [{ name: 'Slash', damage: '30' }], retreat: 2, abilities: ['Static'], evolvesFrom: 'Pichu', detailed: true });
    assert.deepEqual(patches.get('old'), { attacks: [], retreat: 0, abilities: [], detailed: true }, 'a card that has none really has none: it is marked so it is not asked for again');
    assert.equal(done.fixed, 2);
    assert.match(done.message, /2 library cards mended/);
  });

  it('asks for a few hundred at a time and says how many are left', async () => {
    const library = ['a', 'b', 'c', 'd', 'e'].map((id) => pokemon(id, { attacks: [], abilities: [] }));
    const details = Object.fromEntries(library.map((card) => [card.id, { attacks: [{ name: 'Hit' }], retreat: 1, abilities: [] }]));
    const { health, patched } = build({ library, details, limit: 3 });
    health.repair();
    const done = await finished(health);
    assert.equal(done.fixed, 3);
    assert.equal(done.left, 2);
    assert.match(done.message, /2 more are left: run it again/);
    assert.deepEqual([...patched[0][1].keys()], ['a', 'b', 'c']);
  });

  it('counts the cards the card service could not answer for, and mends the rest', async () => {
    const { health, patched } = build({
      library: [pokemon('ok1', { attacks: undefined }), pokemon('lost', { attacks: undefined })],
      details: { ok1: { attacks: [{ name: 'Hit' }], retreat: 1, abilities: [] } }
    });
    health.repair();
    const done = await finished(health);
    assert.deepEqual([done.fixed, done.failed], [1, 1]);
    assert.deepEqual([...patched[0][1].keys()], ['ok1']);
  });

  it('forgets the lookups that lack their data, so the next lookup asks again, and keeps the good ones', async () => {
    const { health, forgotten } = build({
      rows: [
        { id: 'bad', provider: 'pokemontcg', data: pokemon('bad', { attacks: undefined }) },
        { id: 'good', provider: 'pokemontcg', data: pokemon('good') },
        { id: 'trainer', provider: 'pokemontcg', data: { id: 'trainer', name: 'Iono', supertype: 'Trainer', images: { small: 'x' } } }
      ]
    });
    health.repair();
    const done = await finished(health);
    assert.deepEqual(forgotten, ['bad']);
    assert.equal(done.removed, 1);
  });

  it('fills in the Pokémon on the table again, the Active one and the bench', async () => {
    const { health, filled } = build({ state: trainerState(bare('c1', 'Eevee'), bare('c2', 'Zubat')) });
    health.repair();
    const done = await finished(health);
    assert.deepEqual(filled, [['trainerA', -1], ['trainerA', 0]]);
    assert.equal(done.inPlay, 2);
  });

  it('can be stopped, and is refused while a library is downloading', async () => {
    const library = ['a', 'b', 'c'].map((id) => pokemon(id, { attacks: [], abilities: [] }));
    const details = Object.fromEntries(library.map((card) => [card.id, { attacks: [{ name: 'Hit' }], retreat: 1, abilities: [] }]));
    const stopping = build({ library, details });
    stopping.health.repair();
    assert.equal(stopping.health.cancel(), true);
    const done = await finished(stopping.health);
    assert.equal(done.phase, 'stopped');
    assert.equal(stopping.health.cancel(), false, 'nothing left to stop');

    const busy = build({ library, details, running: true });
    assert.throws(() => busy.health.repair(), /Wait for the card library to finish downloading/);
  });
});

describe('the health check through the server', () => {
  let images;
  let api;
  let server;
  let producer;

  const call = async (method, path, body) => {
    const response = await fetch(`${server.base}${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await response.json(); } catch { /* an empty answer */ }
    return { status: response.status, json };
  };

  // The services list a card short, with no attacks, and give them when one card is asked for
  const listed = (id, name, extra = {}) => {
    const [set, number] = id.split('-');
    return {
      id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp: '70', types: ['Lightning'], number, rarity: 'Common',
      set: { id: set, name: `Set ${set}`, releaseDate: '2024/05/01' },
      images: { small: `${images.url}/${set}/${number}.png`, large: `${images.url}/${set}/${number}_hires.png` }, regulationMark: 'H', legalities: { expanded: 'Legal' }, ...extra
    };
  };
  const full = (id, name) => listed(id, name, { attacks: [{ name: `${name} Attack`, damage: '30', cost: ['Lightning'], convertedEnergyCost: 1 }], convertedRetreatCost: 2, abilities: [{ name: 'Static' }] });

  before(async () => {
    images = await startMockImageHost();
    api = await startMockCardApi({
      '/cards/sv4-1': () => ({ data: full('sv4-1', 'Pikachu') }),
      '/cards/sv4-2': () => ({ data: full('sv4-2', 'Raichu') }),
      '/cards?': () => ({ data: [listed('sv4-1', 'Pikachu'), listed('sv4-2', 'Raichu'), listed('sv8-3', 'Iono', { supertype: 'Trainer', subtypes: ['Supporter'], hp: undefined })], totalCount: 3, page: 1, pageSize: 250 })
    });
    server = await startServer({
      label: 'card-health',
      env: { POKEMONTCG_API_URL: api.url, OTO_IMAGE_BASE: images.url, OTO_CATALOG_PACE_MS: '0', OTO_CATALOG_RETRY_MS: '2', OTO_HEALTH_PACE_MS: '0' }
    });
    producer = server.client({ clientId: 'health-producer', name: 'Maya' });
    await producer.ready();
    const downloaded = producer.expect('catalog:progress', (status) => status.job && status.job.finished, 8000);
    assert.equal((await call('POST', '/api/catalog/standard/download', {})).status, 202);
    await downloaded;
  });

  after(async () => {
    if (server) await server.stop();
    await Promise.all([images && images.close(), api && api.close()]);
  });

  it('starts with nothing checked, and a check finds the Pokémon of the library that lack their attacks, and the one on the table', async () => {
    const first = await call('GET', '/api/cards/health');
    assert.equal(first.status, 200);
    assert.deepEqual([first.json.report, first.json.job], [null, null]);

    // a Pokémon put on the table by hand, with a card to ask for and nothing else
    assert.equal((await producer.act('action:trainerA', { action: 'setActive', cardId: 'sv4-1', name: 'Pikachu', image: '/art/x.svg', hp: 70 })).ok, true);

    const scanned = await call('POST', '/api/cards/health/scan');
    assert.equal(scanned.status, 200);
    const [standard] = scanned.json.report.libraries;
    assert.deepEqual([standard.id, standard.cards, standard.pokemon, standard.flagged, standard.repairable], ['standard', 3, 2, 2, 2]);
    assert.equal(standard.problems.emptyCard, 2);
    assert.deepEqual(scanned.json.report.inPlay.map((entry) => [entry.side, entry.slot, entry.name]), [['trainerA', -1, 'Pikachu']]);
    assert.equal(scanned.json.report.flagged, 3);
  });

  it('mends them: the library gets the attacks and the retreat cost, the Pokémon on the table too, and the next check finds nothing', async () => {
    const progress = producer.expect('health:progress', (status) => status.job && status.job.finished, 8000);
    const started = await call('POST', '/api/cards/health/repair');
    assert.equal(started.status, 202);
    const done = (await progress).job;
    assert.equal(done.phase, 'done');
    assert.equal(done.fixed, 2);
    assert.equal(done.inPlay, 1);

    const card = await call('GET', '/api/cards/sv4-1');
    assert.deepEqual([card.json.attacks.map((attack) => attack.name), card.json.retreat], [['Pikachu Attack'], 2]);
    const active = (await (await fetch(`${server.base}/api/state`)).json()).trainerA.active;
    assert.deepEqual([active.attacks.map((attack) => attack.name), active.retreat], [['Pikachu Attack'], 2], 'the Pokémon on the table has its attacks now');

    const after = await call('POST', '/api/cards/health/scan');
    assert.deepEqual([after.json.report.libraries[0].flagged, after.json.report.inPlay.length], [0, 0]);
  });

  it('has nothing to mend when nothing is wrong, and can be asked to stop', async () => {
    const again = await call('POST', '/api/cards/health/repair');
    assert.equal(again.status, 202, 'nothing wrong is not an error: it just has nothing to mend');
    const stopped = await call('POST', '/api/cards/health/cancel');
    assert.equal(stopped.status, 200);
  });
});

describe('the card lookup of a library that lacks the attacks of its cards', () => {
  let images;
  let api;
  let server;
  let producer;

  const card = (extra = {}) => ({
    id: 'sv4-1', name: 'Pikachu', supertype: 'Pokémon', subtypes: ['Basic'], hp: '70', types: ['Lightning'], number: '1', rarity: 'Common',
    set: { id: 'sv4', name: 'Set', releaseDate: '2024/05/01' }, images: { small: `${images.url}/sv4/1.png`, large: `${images.url}/sv4/1_hires.png` }, regulationMark: 'H', legalities: { expanded: 'Legal' }, ...extra
  });

  before(async () => {
    images = await startMockImageHost();
    api = await startMockCardApi({
      '/cards/sv4-1': () => ({ data: card({ attacks: [{ name: 'Gnaw', damage: '20', cost: ['Lightning'], convertedEnergyCost: 1 }], convertedRetreatCost: 1 }) }),
      '/cards?': () => ({ data: [card()], totalCount: 1, page: 1, pageSize: 250 })
    });
    server = await startServer({ label: 'card-health-lookup', env: { POKEMONTCG_API_URL: api.url, OTO_IMAGE_BASE: images.url, OTO_CATALOG_PACE_MS: '0', OTO_CATALOG_RETRY_MS: '2' } });
    producer = server.client({ clientId: 'lookup-producer', name: 'Maya' });
    await producer.ready();
    const downloaded = producer.expect('catalog:progress', (status) => status.job && status.job.finished, 8000);
    await fetch(`${server.base}/api/catalog/standard/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await downloaded;
  });

  after(async () => {
    if (server) await server.stop();
    await Promise.all([images && images.close(), api && api.close()]);
  });

  it('asks the card service for the details of a library card that has none, instead of trusting an empty list', async () => {
    api.requests.length = 0;
    const found = await (await fetch(`${server.base}/api/cards/sv4-1`)).json();
    assert.deepEqual([found.attacks.map((attack) => attack.name), found.retreat], [['Gnaw'], 1]);
    assert.ok(api.requests.some((url) => url.startsWith('/cards/sv4-1')), 'it was asked for');
  });

  it('puts a Pokémon on the table with its attacks and its retreat cost when it is picked from such a library', async () => {
    const picked = await producer.act('action:card', { action: 'select', target: 'trainerB-active', cardId: 'sv4-1', cardData: { id: 'sv4-1', name: 'Pikachu', hp: '70', images: { small: '/img/sv4/1.png' } } });
    assert.equal(picked.ok, true);
    const active = picked.state.trainerB.active;
    assert.deepEqual([active.attacks.map((attack) => attack.name), active.retreat], [['Gnaw'], 1]);
  });
});
