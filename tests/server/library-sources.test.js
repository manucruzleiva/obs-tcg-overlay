/**
 * The card libraries built from the other card services: Scrydex (with the account of the person) and TCGdex, against stand-ins
 * for both (no network, no account needed). The Pokémon TCG API's own downloads are in catalog.test.js.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CatalogService, CatalogError, PROFILES, SOURCES } = require('../../src/services/catalog');
const { ScrydexClient } = require('../../src/services/scrydex');
const { TcgdexClient } = require('../../src/services/tcgdex');
const { startMockCardApi, startMockScrydex, startMockTcgdex, respond, ROOT } = require('../support/harness');

class MemoryDb {
  constructor() { this.values = {}; }
  getSetting(key, fallback = null) { return key in this.values ? this.values[key] : fallback; }
  setSetting(key, value) { this.values[key] = value; }
}

const ex = ['Pokémon ex rule: When your Pokémon ex is Knocked Out, your opponent takes 2 Prize cards.'];

// A card as Scrydex gives it (with casing=camel)
const scrydexCard = (id, name, extra = {}) => {
  const [set, number] = id.split('-');
  return {
    id, name, supertype: 'Pokémon', subtypes: ['Basic'], types: ['Lightning'], hp: '70', number, rarity: 'Common', regulationMark: 'H',
    images: [{ type: 'front', small: `https://images.scrydex.com/pokemon/${id}/small`, large: `https://images.scrydex.com/pokemon/${id}/large` }],
    expansion: { id: set, name: `Set ${set}`, releaseDate: '2024/05/01' },
    attacks: [{ name: 'Zap', damage: '30' }], abilities: [], rules: [], evolvesFrom: [], convertedRetreatCost: '1', ...extra
  };
};
const scrydexEnergy = { supertype: 'Energy', subtypes: ['Basic'], hp: undefined, types: undefined, attacks: undefined, convertedRetreatCost: undefined };
const SCRYDEX_POOL = [
  scrydexCard('sv4-1', 'Pikachu', { attacks: [{ name: 'Gnaw', damage: '20' }, { name: 'Thunder Jolt', damage: '30+' }], abilities: [{ name: 'Static' }], convertedRetreatCost: '2' }),
  scrydexCard('sv4-2', 'Raichu', { subtypes: ['Stage 1'], evolvesFrom: ['Pikachu'] }),
  scrydexCard('sv5-3', 'Pikachu ex', { subtypes: ['Basic', 'ex'], rules: ex }),
  scrydexCard('sv8-5', 'Eevee', { regulationMark: 'I', types: ['Colorless'], expansion: { id: 'sv8', name: 'Set sv8', releaseDate: '2024/11/08' } }),
  scrydexCard('me1-6', 'Pikachu', { regulationMark: 'J', expansion: { id: 'me1', name: 'Set me1', releaseDate: '2025/11/01' } }),
  // a card of a Standard mark that is also basic Energy: kept once
  scrydexCard('sve-1', 'Basic Lightning Energy', scrydexEnergy),
  // old, with no mark: only the basic Energy search finds it
  scrydexCard('sve-2', 'Basic Fire Energy', { ...scrydexEnergy, regulationMark: undefined, expansion: { id: 'sve', name: 'Set sve', releaseDate: '2013/01/01' } }),
  // a rotated mark: not Standard
  scrydexCard('sm1-1', 'Pikachu', { regulationMark: 'F', expansion: { id: 'sm1', name: 'Set sm1', releaseDate: '2017/02/03' } })
];

// A card as TCGdex gives it
const dexCard = (id, name, extra = {}) => {
  const [set, local] = id.split('-');
  return {
    id, localId: local, name, image: `https://assets.tcgdex.net/en/sv/${set}/${local}`, category: 'Pokemon', rarity: 'Common', hp: 70, types: ['Lightning'],
    stage: 'Basic', regulationMark: 'H', set: { id: set, name: `Set ${set}` }, attacks: [{ name: 'Zap', damage: '30' }], abilities: [], retreat: 1, ...extra
  };
};
const dexEnergy = { category: 'Energy', energyType: 'Normal', hp: undefined, types: undefined, stage: undefined, regulationMark: undefined, attacks: undefined, retreat: undefined };
const DEX_POOL = [
  dexCard('sv4-1', 'Pikachu', { attacks: [{ name: 'Gnaw', damage: '20' }, { name: 'Thunder Jolt', damage: '30+' }], retreat: 2, abilities: [{ name: 'Static' }] }),
  dexCard('sv4-2', 'Raichu', { stage: 'Stage1', evolveFrom: 'Pikachu' }),
  dexCard('sv5-3', 'Pikachu ex', { suffix: 'ex' }),
  dexCard('sv8-5', 'Eevee', { regulationMark: 'I', types: ['Colorless'] }),
  dexCard('me1-6', 'Pikachu', { regulationMark: 'J' }),
  dexCard('sve-1', 'Basic Lightning Energy', dexEnergy),
  dexCard('sm1-1', 'Pikachu', { regulationMark: 'F' })
];
const DEX_SETS = [
  { id: 'sv4', releaseDate: '2024-05-01' }, { id: 'sv5', releaseDate: '2024-05-01' }, { id: 'sv8', releaseDate: '2024-11-08' },
  { id: 'me1', releaseDate: '2025-11-01' }, { id: 'sve', releaseDate: '2013-01-01' }, { id: 'sm1', releaseDate: '2017-02-03' }
];

// A card as the Pokémon TCG API gives it, for the libraries only it can build
const apiCard = (id, name, extra = {}) => {
  const [set, number] = id.split('-');
  return {
    id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp: '70', types: ['Lightning'], number, rarity: 'Common',
    set: { id: set, name: `Set ${set}`, releaseDate: '2024/05/01' },
    images: { small: `https://images.pokemontcg.io/${set}/${number}.png`, large: `https://images.pokemontcg.io/${set}/${number}_hires.png` }, ...extra
  };
};
const API_POOL = [apiCard('sv4-1', 'Pikachu'), apiCard('sv5-3', 'Pikachu ex', { subtypes: ['Basic', 'ex'], rules: ex }), apiCard('xy1-1', 'Pikachu EX', { subtypes: ['Basic', 'EX'] })];

const query = (url) => new URL(url, 'http://mock').searchParams;

describe('card libraries built from other services', () => {
  let scrydex;
  let dex;
  let api;
  let dir;
  let db;
  let chosen;
  let scrydexClient;
  let dexClient;
  let logs;
  const track = [];
  const mocks = [];

  function open(options = {}) {
    const catalog = new CatalogService({
      dir, db, baseUrl: api.url, scrydex: scrydexClient, tcgdex: dexClient, librarySource: () => chosen, paceMs: 0, retryDelayMs: 1,
      log: (level, message) => logs.push([level, message]), ...options
    });
    catalog.init();
    track.push(catalog);
    return catalog;
  }

  // Resolves with the job once the next one ends. Call before starting the download.
  const ended = (catalog) => new Promise((resolve) => {
    const check = (status) => {
      if (status.job && status.job.finished) { catalog.off('progress', check); resolve(status.job); }
    };
    catalog.on('progress', check);
  });
  const run = (catalog, id, options) => {
    const done = ended(catalog);
    catalog.download(id, options);
    return done;
  };
  // another stand-in, closed after the test
  const another = async (starter, options) => {
    const mock = await starter(options);
    mocks.push(mock);
    return mock;
  };
  const cards = (catalog) => catalog.search('').cards.map((entry) => entry.id);
  const meta = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf8'));
  const saved = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).cards;

  before(async () => {
    scrydex = await startMockScrydex({ cards: SCRYDEX_POOL });
    dex = await startMockTcgdex({ cards: DEX_POOL, sets: DEX_SETS });
    api = await startMockCardApi({
      '/cards?': (url) => {
        const params = query(url);
        const page = Number(params.get('page') || 1);
        const size = Number(params.get('pageSize') || 20);
        return { data: API_POOL.slice((page - 1) * size, page * size), page, pageSize: size, count: API_POOL.length, totalCount: API_POOL.length };
      }
    });
  });
  after(() => Promise.all([scrydex.close(), dex.close(), api.close()]));

  beforeEach(() => {
    for (const mock of [scrydex, dex, api]) {
      mock.requests.length = 0;
      if (mock.headers) mock.headers.length = 0;
      if (mock.bodies) mock.bodies.length = 0;
    }
    scrydexClient = new ScrydexClient({ baseUrl: scrydex.url, retryDelayMs: 1 });
    scrydexClient.setCredentials({ key: scrydex.key, team: scrydex.team });
    dexClient = new TcgdexClient({ baseUrl: dex.url, retryDelayMs: 1 });
    chosen = 'pokemontcg';
    logs = [];
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'sources-'));
    db = new MemoryDb();
  });
  afterEach(async () => {
    for (const catalog of track.splice(0)) catalog.cancel();
    await Promise.all(mocks.splice(0).map((mock) => mock.close()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('what a library can be built from', () => {
    it('knows the three services, and which libraries each one can build', () => {
      assert.deepEqual(Object.keys(SOURCES), ['pokemontcg', 'scrydex', 'tcgdex']);
      assert.deepEqual(PROFILES.standard.sources, ['pokemontcg', 'scrydex', 'tcgdex']);
      assert.deepEqual(PROFILES.glc.sources, ['pokemontcg'], 'only the Pokémon TCG API says what is legal in Expanded');
      assert.deepEqual(PROFILES.expanded.sources, ['pokemontcg']);

      const status = open().status();
      assert.equal(status.source, 'pokemontcg');
      assert.deepEqual(status.sources, { pokemontcg: 'Pokémon TCG API', scrydex: 'Scrydex', tcgdex: 'TCGdex' });
      assert.deepEqual(status.profiles.map((profile) => [profile.id, profile.sources, profile.source]), [
        ['standard', ['pokemontcg', 'scrydex', 'tcgdex'], null], ['glc', ['pokemontcg'], null], ['expanded', ['pokemontcg'], null]
      ]);
    });

    it('asks for the chosen service every time, and uses the Pokémon TCG API when the choice is not one it knows', async () => {
      chosen = 'klingon';
      const catalog = open();
      assert.equal(catalog.status().source, 'pokemontcg', 'the status never names a service that is not there');
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(catalog.status().profiles[0].source, 'pokemontcg');
      assert.equal(scrydex.requests.length + dex.requests.length, 0);
      assert.ok(api.requests.length > 0);
    });
  });

  describe('from Scrydex', () => {
    it('builds Standard from the regulation marks and basic Energy, with the key and team of the account', async () => {
      chosen = 'scrydex';
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(job.ok, true);
      assert.match(job.message, /Standard is ready: 7 cards \(from Scrydex\)\./);
      assert.deepEqual([catalog.status().profiles[0].ready, catalog.status().profiles[0].count, catalog.status().profiles[0].source], [true, 7, 'scrydex']);

      const asked = scrydex.requests.map(query);
      assert.deepEqual(asked.filter((params) => params.get('page_size') === '1').map((params) => params.get('q')), [
        'regulation_mark:H', 'regulation_mark:I', 'regulation_mark:J', 'supertype:Energy subtypes:Basic'
      ], 'a count for each search; the cards with no mark are the Pokémon TCG API\'s to find');
      const pages = asked.filter((params) => params.get('page_size') === '100');
      assert.equal(pages.length, 4, 'every search ends on its first page');
      assert.ok(pages.every((params) => params.get('casing') === 'camel' && params.get('select').includes('expansion')));
      assert.ok(scrydex.headers.every((headers) => headers['x-api-key'] === scrydex.key && headers['x-team-id'] === scrydex.team));
      assert.equal(api.requests.length + dex.requests.length, 0, 'none of the other services was asked');
    });

    it('keeps what is needed to search, pick and show each card, newest set first', async () => {
      chosen = 'scrydex';
      const catalog = open();
      await run(catalog, 'standard');

      assert.deepEqual(cards(catalog), ['me1-6', 'sv8-5', 'sv4-1', 'sve-1', 'sv4-2', 'sv5-3', 'sve-2']);
      assert.ok(!cards(catalog).includes('sm1-1'), 'a rotated mark is not Standard');
      const pikachu = catalog.get('sv4-1');
      assert.deepEqual([pikachu.name, pikachu.retreat, pikachu.regulationMark, pikachu.abilities, pikachu.setName], ['Pikachu', 2, 'H', ['Static'], 'Set sv4']);
      assert.deepEqual(pikachu.attacks.map((attack) => [attack.name, attack.damage, attack.mod]), [['Gnaw', 20, ''], ['Thunder Jolt', 30, '+']]);
      assert.deepEqual(pikachu.images, { small: '/img/scrydex/sv4-1_small.png', large: '/img/scrydex/sv4-1_large.png' }, 'the pictures are kept here like the others');
      assert.equal(catalog.search('raichu').cards[0].subtypes, 'Stage 1');
      assert.deepEqual(catalog.search('', 1, { evolvesFrom: 'Pikachu' }).cards.map((entry) => entry.id), ['sv4-2']);
      assert.equal(saved('standard').find((entry) => entry.id === 'sv5-3').ruleBox, true, 'a rule box is known, as it is for the other services');
      assert.equal(saved('standard').find((entry) => entry.id === 'sv4-1').ruleBox, undefined);
      assert.equal(meta('standard').source, 'scrydex');
    });

    it('pages through a search 100 cards at a time, each card once', async () => {
      const many = await another(startMockScrydex, { cards: Array.from({ length: 230 }, (_, i) => scrydexCard(`sv1-${i + 1}`, `Card ${i + 1}`)) });
      scrydexClient = new ScrydexClient({ baseUrl: many.url, retryDelayMs: 1 });
      scrydexClient.setCredentials({ key: many.key, team: many.team });
      chosen = 'scrydex';
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(catalog.status().profiles[0].count, 230);
      assert.deepEqual(many.requests.map(query).filter((params) => params.get('page_size') === '100').map((params) => params.get('page')), ['1', '2', '3']);
      assert.match(job.message, /230 cards/);
    });

    it('will not start without the key and the team, and says what to do', () => {
      chosen = 'scrydex';
      scrydexClient.setCredentials({ key: scrydex.key, team: '' });
      const catalog = open();
      assert.throws(() => catalog.download('standard'), (error) => error instanceof CatalogError && error.status === 400 && /needs your API key and team ID.*Settings, Cards/.test(error.message));
      assert.equal(catalog.status().job, null, 'nothing started');
      assert.equal(scrydex.requests.length, 0);
    });

    it('stops at once, with the reason, when the account is not accepted', async () => {
      chosen = 'scrydex';
      scrydexClient.setCredentials({ key: 'not-the-key', team: 'not-the-team' });
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'error');
      assert.match(job.message, /Scrydex did not accept the API key and team ID: check them in Settings, Cards/);
      assert.equal(scrydex.requests.length, 1, 'no point asking again');
      assert.equal(catalog.status().profiles[0].ready, false);
    });

    it('tries again when the service is busy, and carries on from the page it got to after a failure', async () => {
      let broken = true;
      const many = await another(startMockScrydex, {
        cards: Array.from({ length: 230 }, (_, i) => scrydexCard(`sv1-${i + 1}`, `Card ${i + 1}`)),
        behave: ({ url }) => (broken && url.includes('page=3') && url.includes('page_size=100') ? respond(503, {}) : null)
      });
      scrydexClient = new ScrydexClient({ baseUrl: many.url, retryDelayMs: 1 });
      scrydexClient.setCredentials({ key: many.key, team: many.team });
      chosen = 'scrydex';
      const catalog = open();

      const first = await run(catalog, 'standard');
      assert.equal(first.phase, 'error');
      assert.match(first.message, /not answering/);
      assert.equal(catalog.status().profiles[0].resumable, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'standard.partial.json'), 'utf8')).signature.includes('scrydex'), true, 'what is left over says which service it is from');

      broken = false;
      many.requests.length = 0;
      const second = await run(catalog, 'standard');
      assert.equal(second.phase, 'done', second.message);
      assert.equal(catalog.status().profiles[0].count, 230);
      assert.deepEqual(many.requests.map(query).map((params) => [params.get('page'), params.get('page_size')]), [['3', '100']], 'only the page that was left');
      assert.equal(fs.existsSync(path.join(dir, 'standard.partial.json')), false);
    });

    it('asks for whole cards if Scrydex does not take the list of fields, and does not change how the others are asked', async () => {
      let refused = 0;
      const picky = await another(startMockScrydex, { cards: SCRYDEX_POOL, behave: ({ url }) => (query(url).get('select') ? (refused++, respond(400, {})) : null) });
      scrydexClient = new ScrydexClient({ baseUrl: picky.url, retryDelayMs: 1 });
      scrydexClient.setCredentials({ key: picky.key, team: picky.team });
      chosen = 'scrydex';
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(refused, 1, 'asked once, then never again');
      assert.equal(catalog.status().profiles[0].count, 7);

      chosen = 'pokemontcg';
      api.requests.length = 0;
      await run(catalog, 'standard');
      assert.ok(api.requests.map(query).some((params) => params.get('select')), 'the Pokémon TCG API is still asked for the list of fields');
    });
  });

  describe('from TCGdex', () => {
    it('builds Standard from the regulation marks and basic Energy, and gives each card the date of its set', async () => {
      chosen = 'tcgdex';
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.match(job.message, /Standard is ready: 6 cards \(from TCGdex\)\./);
      assert.deepEqual([catalog.status().profiles[0].count, catalog.status().profiles[0].source], [6, 'tcgdex']);

      // the sets first (for their dates), then the cards of each search; TCGdex does not count, so each ends on a page that is not full
      const bodies = dex.bodies.filter(Boolean);
      assert.equal(bodies.length, 5);
      assert.match(bodies[0].query, /sets/);
      assert.deepEqual(bodies.slice(1).map((body) => body.variables.filters), [
        { regulationMark: 'H' }, { regulationMark: 'I' }, { regulationMark: 'J' }, { category: 'Energy', energyType: 'Normal' }
      ]);
      assert.ok(bodies.slice(1).every((body) => body.variables.pagination.page === 1 && body.variables.pagination.itemsPerPage === 250));
      assert.equal(api.requests.length + scrydex.requests.length, 0, 'none of the other services was asked');

      assert.deepEqual(cards(catalog), ['me1-6', 'sv8-5', 'sv4-1', 'sv4-2', 'sv5-3', 'sve-1'], 'newest set first, and the rotated mark is not there');
      const record = saved('standard').find((entry) => entry.id === 'sv4-1');
      assert.equal(record.released, '2024/05/01');
      assert.equal(meta('standard').source, 'tcgdex');
    });

    it('keeps what is needed to search, pick and show each card', async () => {
      chosen = 'tcgdex';
      const catalog = open();
      await run(catalog, 'standard');

      const pikachu = catalog.get('sv4-1');
      assert.deepEqual([pikachu.name, pikachu.retreat, pikachu.regulationMark, pikachu.abilities, pikachu.setName, pikachu.hp], ['Pikachu', 2, 'H', ['Static'], 'Set sv4', '70']);
      assert.deepEqual(pikachu.attacks.map((attack) => [attack.name, attack.damage, attack.mod]), [['Gnaw', 20, ''], ['Thunder Jolt', 30, '+']]);
      assert.deepEqual(pikachu.images, { small: '/img/tcgdex/en__sv__sv4__1__low.webp', large: '/img/tcgdex/en__sv__sv4__1__high.webp' }, 'the pictures are kept here like the others');
      assert.equal(catalog.search('pikachu ex').cards[0].subtypes, 'Basic, ex');
      assert.equal(catalog.search('raichu').cards[0].subtypes, 'Stage 1');
      assert.deepEqual(catalog.search('', 1, { evolvesFrom: 'Pikachu' }).cards.map((entry) => entry.id), ['sv4-2']);
      assert.deepEqual(catalog.search('', 1, { supertype: 'Energy' }).cards.map((entry) => entry.id), ['sve-1']);
      assert.equal(saved('standard').find((entry) => entry.id === 'sv5-3').ruleBox, true, 'the suffix shows a rule box');
      assert.equal(saved('standard').find((entry) => entry.id === 'sv4-1').ruleBox, undefined);
    });

    it('follows the pages until one is not full, since it does not say how many cards there are', async () => {
      const many = await another(startMockTcgdex, {
        sets: DEX_SETS,
        cards: [
          ...Array.from({ length: 300 }, (_, i) => dexCard(`h-${i + 1}`, `Card H ${i + 1}`)),
          // exactly one full page: the next page is empty, and ends it
          ...Array.from({ length: 250 }, (_, i) => dexCard(`i-${i + 1}`, `Card I ${i + 1}`, { regulationMark: 'I' })),
          ...Array.from({ length: 3 }, (_, i) => dexCard(`j-${i + 1}`, `Card J ${i + 1}`, { regulationMark: 'J' }))
        ]
      });
      dexClient = new TcgdexClient({ baseUrl: many.url, retryDelayMs: 1 });
      chosen = 'tcgdex';
      const catalog = open();
      const seen = [];
      catalog.on('progress', (status) => status.job && seen.push([status.job.done, status.job.total]));

      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(catalog.status().profiles[0].count, 553);
      const asked = many.bodies.filter((body) => body && body.variables).map((body) => [JSON.stringify(body.variables.filters), body.variables.pagination.page]);
      assert.deepEqual(asked, [
        ['{"regulationMark":"H"}', 1], ['{"regulationMark":"H"}', 2],
        ['{"regulationMark":"I"}', 1], ['{"regulationMark":"I"}', 2],
        ['{"regulationMark":"J"}', 1],
        ['{"category":"Energy","energyType":"Normal"}', 1]
      ]);
      assert.ok(seen.every(([done, total]) => done <= total), 'the progress never goes past the whole');
    });

    it('still builds the library when the dates of the sets cannot be had, and says so in the log', async () => {
      const dateless = await another(startMockTcgdex, {
        cards: DEX_POOL, sets: DEX_SETS,
        behave: ({ body }) => (body && /\bsets\b/.test(String(body.query)) && !/\bcards\b/.test(String(body.query)) ? respond(500, {}) : null)
      });
      dexClient = new TcgdexClient({ baseUrl: dateless.url, retryDelayMs: 1 });
      chosen = 'tcgdex';
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(catalog.status().profiles[0].count, 6);
      assert.ok(saved('standard').every((entry) => entry.released === ''));
      assert.ok(logs.some(([level, message]) => level === 'warn' && /release dates/.test(message)));
    });

    it('says what TCGdex did not like when it refuses the question', async () => {
      const refusing = await another(startMockTcgdex, {
        cards: DEX_POOL,
        behave: ({ body }) => (body && /\bcards\b/.test(String(body.query)) ? respond(200, { errors: [{ message: 'filters are wrong' }] }) : null)
      });
      dexClient = new TcgdexClient({ baseUrl: refusing.url, retryDelayMs: 1 });
      chosen = 'tcgdex';
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'error');
      assert.match(job.message, /TCGdex refused the question \(filters are wrong\)/);
      assert.equal(catalog.status().profiles[0].ready, false);
    });

    it('can be stopped, and carries on from where it stopped', async () => {
      let catalog;
      let stopAt = 2;
      const many = await another(startMockTcgdex, {
        sets: DEX_SETS,
        cards: Array.from({ length: 600 }, (_, i) => dexCard(`h-${i + 1}`, `Card H ${i + 1}`)),
        behave: ({ body }) => {
          if (body && body.variables && body.variables.pagination.page === stopAt) catalog.cancel();
          return null;
        }
      });
      dexClient = new TcgdexClient({ baseUrl: many.url, retryDelayMs: 1 });
      chosen = 'tcgdex';
      catalog = open();

      const stopped = await run(catalog, 'standard');
      assert.equal(stopped.phase, 'cancelled');
      assert.equal(catalog.status().profiles[0].resumable, true);

      stopAt = 0;
      many.bodies.length = 0;
      const finished = await run(catalog, 'standard');
      assert.equal(finished.phase, 'done', finished.message);
      assert.equal(catalog.status().profiles[0].count, 600);
      const pages = many.bodies.filter((body) => body && body.variables).map((body) => [body.variables.filters.regulationMark || 'energy', body.variables.pagination.page]);
      assert.deepEqual(pages.slice(0, 2), [['H', 2], ['H', 3]], 'no repeat of the first page');
    });
  });

  describe('libraries that only the Pokémon TCG API can build', () => {
    it('are built from it whatever service is chosen, and the other services are left alone', async () => {
      chosen = 'scrydex';
      const catalog = open();
      const job = await run(catalog, 'expanded', { confirm: true });
      assert.equal(job.phase, 'done', job.message);
      assert.doesNotMatch(job.message, /from /);
      assert.deepEqual([catalog.status().profiles[2].count, catalog.status().profiles[2].source], [3, 'pokemontcg']);
      assert.equal(scrydex.requests.length + dex.requests.length, 0);

      // Gym Leader Challenge is made from Expanded, and says where Expanded came from
      chosen = 'tcgdex';
      const glc = await run(catalog, 'glc', { confirm: true });
      assert.equal(glc.phase, 'done', glc.message);
      assert.deepEqual([catalog.status().profiles[1].count, catalog.status().profiles[1].source], [1, 'pokemontcg']);
      assert.equal(scrydex.requests.length + dex.requests.length, 0);
    });

    it('do not ask for the key of a service that is not used for them', () => {
      chosen = 'scrydex';
      scrydexClient.setCredentials({ key: '', team: '' });
      const catalog = open();
      assert.doesNotThrow(() => catalog.download('expanded', { confirm: true }));
      catalog.cancel();
    });
  });

  describe('updating a library built from another service', () => {
    it('Scrydex: asks each search how many cards it has, downloads nothing when nothing changed, and only the search that grew', async () => {
      const pool = [...SCRYDEX_POOL];
      const own = await another(startMockScrydex, { cards: pool });
      scrydexClient = new ScrydexClient({ baseUrl: own.url, retryDelayMs: 1 });
      scrydexClient.setCredentials({ key: own.key, team: own.team });
      chosen = 'scrydex';
      const catalog = open();
      await run(catalog, 'standard');
      assert.deepEqual([catalog.status().profiles[0].updatable, catalog.status().profiles[0].using], [true, 'scrydex']);

      own.requests.length = 0;
      const same = await run(catalog, 'standard');
      assert.equal(same.message, 'Standard is up to date: 7 cards (from Scrydex). Nothing new.');
      const asked = own.requests.map(query);
      assert.equal(asked.length, 4, 'one small question for each of its four searches');
      assert.ok(asked.every((params) => params.get('page_size') === '1'));

      pool.push(scrydexCard('me2-1', 'Sprigatito', { regulationMark: 'J', expansion: { id: 'me2', name: 'Set me2', releaseDate: '2026/12/01' } }));
      own.requests.length = 0;
      const grew = await run(catalog, 'standard');
      assert.equal(grew.message, 'Standard is up to date: 8 cards (from Scrydex). 1 new.');
      const downloaded = own.requests.map(query).filter((params) => params.get('page_size') !== '1');
      assert.deepEqual(downloaded.map((params) => params.get('q')), ['regulation_mark:J'], 'the search that grew, and only that one');
      // (the shared Scrydex and TCGdex stand-ins: this test has its own Scrydex. The Pokémon TCG API stand-in can still get a late request of
      // the download the test before this one stopped)
      assert.equal(scrydex.requests.length + dex.requests.length, 0, 'no other service was asked');
      assert.equal(api.requests.map(query).filter((params) => params.get('q') && params.get('q').startsWith('regulationMark')).length, 0, 'nor the Pokémon TCG API');
    });

    it('TCGdex: says nothing is new while no set has come out since the newest one in the library, and downloads it again when one has', async () => {
      const sets = [...DEX_SETS];
      const pool = [...DEX_POOL];
      const own = await another(startMockTcgdex, { cards: pool, sets });
      dexClient = new TcgdexClient({ baseUrl: own.url, retryDelayMs: 1 });
      chosen = 'tcgdex';
      const catalog = open();
      await run(catalog, 'standard');
      assert.equal(catalog.status().profiles[0].updatable, true);

      own.bodies.length = 0;
      const same = await run(catalog, 'standard');
      assert.equal(same.message, 'Standard is up to date: 6 cards (from TCGdex). Nothing new.');
      const bodies = own.bodies.filter(Boolean);
      assert.equal(bodies.length, 1, 'only the list of sets');
      assert.match(bodies[0].query, /sets/);

      sets.push({ id: 'me2', releaseDate: '2026-12-01' });
      pool.push(dexCard('me2-1', 'Sprigatito', { regulationMark: 'J', set: { id: 'me2', name: 'Set me2' } }));
      own.bodies.length = 0;
      const grew = await run(catalog, 'standard');
      assert.equal(grew.message, 'Standard is up to date: 7 cards (from TCGdex). 1 new.');
      assert.equal(own.bodies.filter((body) => body && body.variables).length, 4, 'TCGdex does not count: every search is downloaded again');
      assert.deepEqual(catalog.search('sprigatito').cards.map((entry) => entry.id), ['me2-1']);
    });

    it('downloads the whole library again from the service chosen when it came from another one, and says so beforehand', async () => {
      chosen = 'scrydex';
      const catalog = open();
      await run(catalog, 'standard');
      chosen = 'tcgdex';
      const standard = catalog.status().profiles[0];
      assert.deepEqual([standard.source, standard.using, standard.updatable], ['scrydex', 'tcgdex', false]);
      assert.equal(catalog.canUpdate('standard', 'scrydex'), true);
      const expanded = catalog.status().profiles[2];
      assert.equal(expanded.using, 'pokemontcg', 'what only the Pokémon TCG API can build comes from it');
    });
  });

  describe('switching service', () => {
    it('replaces a library with one from another service, and remembers which service it came from after a restart', async () => {
      chosen = 'scrydex';
      const catalog = open();
      await run(catalog, 'standard');
      assert.equal(catalog.status().profiles[0].source, 'scrydex');
      assert.equal(catalog.get('sv4-1').images.small, '/img/scrydex/sv4-1_small.png');

      chosen = 'tcgdex';
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(catalog.status().profiles[0].source, 'tcgdex');
      assert.equal(catalog.status().profiles[0].count, 6);
      assert.equal(catalog.get('sv4-1').images.small, '/img/tcgdex/en__sv__sv4__1__low.webp', 'the library in use was replaced too');

      const reopened = open();
      assert.equal(reopened.status().profiles[0].source, 'tcgdex');
      assert.equal(reopened.status().source, 'tcgdex');
    });

    it('does not carry on a download of one service with the pages of another', async () => {
      const many = await another(startMockScrydex, {
        cards: Array.from({ length: 230 }, (_, i) => scrydexCard(`sv1-${i + 1}`, `Card ${i + 1}`)),
        behave: ({ url }) => (url.includes('page=3') && url.includes('page_size=100') ? respond(503, {}) : null)
      });
      scrydexClient = new ScrydexClient({ baseUrl: many.url, retryDelayMs: 1 });
      scrydexClient.setCredentials({ key: many.key, team: many.team });
      chosen = 'scrydex';
      const catalog = open();
      assert.equal((await run(catalog, 'standard')).phase, 'error');
      assert.equal(fs.existsSync(path.join(dir, 'standard.partial.json')), true);

      chosen = 'tcgdex';
      dex.bodies.length = 0;
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(catalog.status().profiles[0].count, 6, 'the cards of TCGdex only');
      assert.deepEqual(dex.bodies.filter((body) => body && body.variables).map((body) => body.variables.filters)[0], { regulationMark: 'H' }, 'from the start');
    });
  });
});
