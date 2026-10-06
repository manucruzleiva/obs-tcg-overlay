const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CatalogService, CatalogError, PROFILES, STANDARD_MARKS, ROTATED_MARKS, NO_MARK_QUERY, toRecord } = require('../src/services/catalog');
const { ImageCache } = require('../src/services/images');
const { startMockCardApi, startMockImageHost, respond, ROOT } = require('../test-support/harness');

const IMAGE_BASE = 'https://images.pokemontcg.io';

class MemoryDb {
  constructor() { this.values = {}; }
  getSetting(key, fallback = null) { return key in this.values ? this.values[key] : fallback; }
  setSetting(key, value) { this.values[key] = value; }
}

// A card as the API sends it
function card(id, name, extra = {}) {
  const [set, number] = id.split('-');
  return {
    id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp: '70', types: ['Lightning'], number, rarity: 'Common',
    set: { id: set, name: `Set ${set}`, releaseDate: '2024/05/01' },
    images: { small: `${IMAGE_BASE}/${set}/${number}.png`, large: `${IMAGE_BASE}/${set}/${number}_hires.png` },
    legalities: { expanded: 'Legal', unlimited: 'Legal' },
    ...extra
  };
}

const ex = ['Pokémon ex rule: When your Pokémon ex is Knocked Out, your opponent takes 2 Prize cards.'];
const STANDARD_POOL = [
  card('sv4-1', 'Pikachu', { regulationMark: 'H' }),
  card('sv4-2', 'Raichu', { regulationMark: 'H', evolvesFrom: 'Pikachu' }),
  card('sv5-3', 'Pikachu ex', { regulationMark: 'H', subtypes: ['Basic', 'ex'], rules: ex }),
  card('sv8-4', 'Iono', { regulationMark: 'I', supertype: 'Trainer', subtypes: ['Supporter'], hp: undefined, types: undefined }),
  card('sv8-5', 'Eevee', { regulationMark: 'I', types: ['Colorless'] }),
  card('sv9-9', 'Pokémon Catcher', { regulationMark: 'I', supertype: 'Trainer', subtypes: ['Item'], hp: undefined, types: undefined }),
  card('me1-6', 'Pikachu', { regulationMark: 'J', set: { id: 'me1', name: 'Set me1', releaseDate: '2025/11/01' } }),
  card('me1-7', 'Mega Lucario ex', { regulationMark: 'J', subtypes: ['MEGA', 'ex'], rules: ex, types: ['Fighting'] }),
  // matches the regulation mark and the basic Energy search: kept once
  card('sve-1', 'Basic Lightning Energy', { regulationMark: 'H', supertype: 'Energy', subtypes: ['Basic'], hp: undefined, types: undefined }),
  // old, with no regulation mark: only the basic Energy search finds it
  card('sve-2', 'Basic Fire Energy', { supertype: 'Energy', subtypes: ['Basic'], hp: undefined, types: undefined, set: { id: 'sve', name: 'Set sve', releaseDate: '2013/01/01' } }),
  // no regulation mark, in a set the card service lists as legal in Standard (the Classic Collection): found by its set
  card('me55c-1', 'Charizard', { types: ['Fire'], set: { id: 'me55c', name: 'Classic Collection', releaseDate: '2026/09/16', legalities: { standard: 'Legal', expanded: 'Legal' } } })
];
const OLDER_POOL = [
  // in that same set, but with the mark of a rotated set: the mark decides, so it is not Standard
  card('me55c-2', 'Blastoise', { regulationMark: 'F', types: ['Water'], set: { id: 'me55c', name: 'Classic Collection', releaseDate: '2026/09/16', legalities: { standard: 'Legal', expanded: 'Legal' } } }),
  card('sm1-1', 'Pikachu', { regulationMark: 'F', set: { id: 'sm1', name: 'Set sm1', releaseDate: '2017/02/03' } }),
  // a rule box shown only by its subtype: the card has no rules text
  card('xy1-1', 'Pikachu EX', { subtypes: ['Basic', 'EX'], set: { id: 'xy1', name: 'Set xy1', releaseDate: '2014/01/01' } }),
  card('base1-58', 'Pikachu', { legalities: { unlimited: 'Legal' }, set: { id: 'base1', name: 'Base', releaseDate: '1999/01/09' } })
];

// The part of the card API's query language the library uses
function matches(item, q) {
  const terms = q.match(/-?[\w.]+:"[^"]*"|-?[\w.]+:\S+/g) || [];
  return terms.every((term) => {
    const negated = term.startsWith('-');
    const [key, ...rest] = (negated ? term.slice(1) : term).split(':');
    const value = rest.join(':').replace(/"/g, '');
    let found;
    switch (key) {
      case 'regulationMark': found = item.regulationMark === value; break;
      case 'supertype': found = item.supertype === value; break;
      case 'subtypes': found = (item.subtypes || []).includes(value); break;
      case 'legalities.expanded': found = Boolean(item.legalities && item.legalities.expanded && item.legalities.expanded.toLowerCase() === value); break;
      case 'set.legalities.standard': found = Boolean(item.set && item.set.legalities && item.set.legalities.standard && item.set.legalities.standard.toLowerCase() === value); break;
      default: throw new Error(`the mock does not understand ${term}`);
    }
    return negated ? !found : found;
  });
}

// A handler for the mock card API: pages through the cards that match the query
function cardApi(all, intercept = () => null) {
  return (url) => {
    const params = new URL(url, 'http://mock').searchParams;
    const special = intercept(params);
    if (special) return special;
    const found = all.filter((item) => matches(item, params.get('q')));
    const page = Number(params.get('page') || 1);
    const pageSize = Number(params.get('pageSize') || 20);
    const data = found.slice((page - 1) * pageSize, page * pageSize);
    return { data, page, pageSize, count: data.length, totalCount: found.length };
  };
}

const pages = (api) => api.requests.map((url) => new URL(url, 'http://mock').searchParams).filter((params) => params.get('pageSize') === '250');
const counts = (api) => api.requests.map((url) => new URL(url, 'http://mock').searchParams).filter((params) => params.get('pageSize') === '1');

describe('card library', () => {
  let api;
  let dir;
  let db;
  let handler;
  const track = [];

  function open(options = {}) {
    const catalog = new CatalogService({ dir, db, baseUrl: api.url, paceMs: 0, retryDelayMs: 1, ...options });
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

  const run = async (catalog, id, options) => {
    const done = ended(catalog);
    catalog.download(id, options);
    return done;
  };

  before(async () => {
    api = await startMockCardApi({ '/cards?': (url) => handler(url) });
  });
  after(() => api.close());

  beforeEach(() => {
    api.requests.length = 0;
    api.headers.length = 0;
    handler = cardApi([...STANDARD_POOL, ...OLDER_POOL]);
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'library-'));
    db = new MemoryDb();
  });
  afterEach(() => {
    for (const catalog of track.splice(0)) catalog.cancel();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('downloading', () => {
    it('knows the three libraries and what is in each', () => {
      assert.deepEqual(Object.keys(PROFILES), ['standard', 'glc', 'expanded']);
      assert.deepEqual(STANDARD_MARKS, ['H', 'I', 'J']);
      const status = open().status();
      assert.deepEqual(status.profiles.map((p) => [p.id, p.label, p.ready, p.big]), [
        ['standard', 'Standard', false, false], ['glc', 'Gym Leader Challenge', false, true], ['expanded', 'Expanded', false, true]
      ]);
      assert.equal(status.active, null);
      assert.equal(status.job, null);
    });

    it('downloads Standard: the current rotation, basic Energy and the cards with no mark that are legal, each card once', async () => {
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done');
      assert.equal(job.ok, true);

      const standard = catalog.status().profiles[0];
      assert.equal(standard.ready, true);
      assert.equal(standard.count, 11, 'the Energy that matches two searches is kept once');
      assert.ok(standard.bytes > 0);
      assert.ok(Math.abs(standard.builtAt - Date.now()) < 5000);
      assert.match(job.message, /Standard is ready: 11 cards/);

      // one count per search (H, I, J, basic Energy and the cards with no mark), then the cards, each time with a field list
      const asked = counts(api).map((params) => params.get('q'));
      assert.deepEqual(asked, ['regulationMark:H', 'regulationMark:I', 'regulationMark:J', 'supertype:Energy subtypes:Basic', NO_MARK_QUERY]);
      assert.ok(pages(api).every((params) => params.get('select').includes('regulationMark')));
    });

    it('keeps a card that has no regulation mark when its set is legal in Standard, and only then', async () => {
      assert.ok(NO_MARK_QUERY.startsWith('set.legalities.standard:legal'));
      for (const mark of [...ROTATED_MARKS, ...STANDARD_MARKS]) assert.ok(NO_MARK_QUERY.includes(`-regulationMark:${mark}`), `not a card with ${mark}`);

      const catalog = open();
      await run(catalog, 'standard');
      const ids = catalog.search('').cards.map((entry) => entry.id);
      assert.ok(ids.includes('me55c-1'), 'the Classic Collection card has no mark and is in a legal set');
      assert.ok(!ids.includes('me55c-2'), 'one with the mark of a rotated set is not');
      assert.ok(!ids.includes('base1-58'), 'a card with no mark in a set that is not legal is not');
      assert.ok(ids.includes('sve-2'), 'the basic Energy with no mark is still there');
      assert.equal(catalog.get('me55c-1').regulationMark, '');
      assert.equal(catalog.search('charizard').cards[0].setName, 'Classic Collection');
    });

    it('says when a library was saved before it held more, and stops saying it after an update', async () => {
      const catalog = open();
      await run(catalog, 'standard');
      let standard = catalog.status().profiles[0];
      assert.equal(standard.outdated, false);
      assert.match(standard.whatsNew, /no regulation mark/);

      // the same library as an earlier version saved it: no revision in the file
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'standard.meta.json'), 'utf8'));
      delete meta.revision;
      fs.writeFileSync(path.join(dir, 'standard.meta.json'), JSON.stringify(meta));
      const reopened = open();
      standard = reopened.status().profiles[0];
      assert.equal(standard.ready, true);
      assert.equal(standard.outdated, true);
      assert.equal(reopened.status().profiles[1].outdated, false, 'a library that never changed is never out of date');

      await run(reopened, 'standard');
      assert.equal(reopened.status().profiles[0].outdated, false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'standard.meta.json'), 'utf8')).revision, PROFILES.standard.revision);
    });

    it('numbers every change, so a page can tell a late answer from a newer event', async () => {
      const catalog = open();
      const seen = [];
      catalog.on('progress', (status) => seen.push(status.serial));
      const before = catalog.status().serial;
      await run(catalog, 'standard');
      assert.ok(seen.length >= 4);
      assert.ok(seen.every((serial, i) => i === 0 || serial > seen[i - 1]), `never goes back: ${seen.join(', ')}`);
      assert.ok(seen[0] > before);
      // an answer built right after the download started is older than the event that ended it
      const last = seen[seen.length - 1];
      assert.ok(catalog.status().serial >= last);
      catalog.setActive(null);
      assert.ok(catalog.status().serial > last, 'choosing a library is a change too');
    });

    it('uses the first library you download for searching, until you choose otherwise', async () => {
      const catalog = open();
      assert.equal(catalog.search('pikachu'), null, 'nothing to search yet');
      await run(catalog, 'standard');
      assert.equal(catalog.status().active, 'standard');
      assert.equal(db.getSetting('cardLibraryActive'), 'standard');
      assert.equal(catalog.search('pikachu').source, 'library');

      catalog.setActive(null);
      assert.equal(catalog.status().active, null);
      assert.equal(catalog.search('pikachu'), null);
      catalog.setActive('standard');
      assert.equal(catalog.status().active, 'standard');
    });

    it('sends the API key it was given, and none when there is none', async () => {
      let key = '';
      const catalog = open({ apiKey: () => key });
      await run(catalog, 'standard');
      assert.ok(api.headers.every((headers) => headers['x-api-key'] === undefined));

      api.headers.length = 0;
      key = 'secret-key';
      catalog.remove('standard');
      await run(catalog, 'standard');
      assert.ok(api.headers.length > 0 && api.headers.every((headers) => headers['x-api-key'] === 'secret-key'));
    });

    it('reports progress as it goes', async () => {
      const catalog = open();
      const seen = [];
      catalog.on('progress', (status) => seen.push(status.job && { ...status.job }));
      await run(catalog, 'standard');
      const phases = [...new Set(seen.filter(Boolean).map((job) => job.phase))];
      assert.deepEqual(phases, ['starting', 'counting', 'downloading', 'saving', 'done']);
      const last = seen[seen.length - 1];
      assert.equal(last.finished, true);
      assert.equal(last.done, 11);
      assert.equal(last.total, 11);
    });

    it('asks for a go-ahead before the big downloads, and says how big', () => {
      const catalog = open();
      for (const id of ['glc', 'expanded']) {
        assert.throws(() => catalog.download(id), (error) => error instanceof CatalogError && error.status === 400 && error.extra.needsConfirm === true && error.extra.approximate > 10000);
      }
      assert.equal(catalog.status().job, null, 'nothing was started');
      assert.equal(api.requests.length, 0);
    });

    it('does one download at a time', async () => {
      handler = cardApi([...STANDARD_POOL, ...OLDER_POOL], () => null);
      const catalog = open({ paceMs: 30 });
      const done = ended(catalog);
      catalog.download('standard');
      assert.throws(() => catalog.download('standard'), (error) => error.status === 409);
      assert.throws(() => catalog.download('expanded', { confirm: true }), (error) => error.status === 409);
      assert.throws(() => catalog.downloadPictures(), (error) => error instanceof CatalogError);
      await done;
    });

    it('refuses a library that does not exist', () => {
      const catalog = open();
      assert.throws(() => catalog.download('modified'), (error) => error.status === 404);
      assert.throws(() => catalog.setActive('modified'), (error) => error.status === 404);
      assert.throws(() => catalog.remove('modified'), (error) => error.status === 404);
      assert.throws(() => catalog.setActive('expanded'), (error) => error.status === 409, 'not downloaded yet');
    });
  });

  // An update asks each search of a library how many cards it has now, and downloads only what changed
  describe('updating a library', () => {
    const NEW_SET = { id: 'me2', name: 'Set me2', releaseDate: '2026/12/01' };
    // the card API, giving the newest sets first when it is asked for that order
    const ordered = (all) => (url) => {
      const params = new URL(url, 'http://mock').searchParams;
      let found = all.filter((item) => matches(item, params.get('q')));
      if (params.get('orderBy') === '-set.releaseDate') found = [...found].sort((a, b) => (a.set.releaseDate < b.set.releaseDate ? 1 : a.set.releaseDate > b.set.releaseDate ? -1 : 0));
      const page = Number(params.get('page') || 1);
      const pageSize = Number(params.get('pageSize') || 20);
      const data = found.slice((page - 1) * pageSize, page * pageSize);
      return { data, page, pageSize, count: data.length, totalCount: found.length };
    };
    const saved = (id = 'standard') => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    const searchOf = (query, id = 'standard') => saved(id).queries.find((entry) => JSON.parse(entry.key) === query);

    it('remembers each search of a library: how many cards it had, and which', async () => {
      const catalog = open();
      await run(catalog, 'standard');
      assert.deepEqual(saved().queries.map((entry) => [JSON.parse(entry.key), entry.count]), [
        ['regulationMark:H', 4], ['regulationMark:I', 3], ['regulationMark:J', 2], ['supertype:Energy subtypes:Basic', 2], [NO_MARK_QUERY, 1]
      ]);
      assert.deepEqual(searchOf('regulationMark:H').ids, ['sv4-1', 'sv4-2', 'sv5-3', 'sve-1']);
      assert.deepEqual(searchOf('supertype:Energy subtypes:Basic').ids, ['sve-1', 'sve-2'], 'a card two searches find is in both');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'standard.meta.json'), 'utf8')).tracked, true);
      const standard = catalog.status().profiles[0];
      assert.deepEqual([standard.updatable, standard.using], [true, 'pokemontcg']);
    });

    it('asks each search how many cards it has, and downloads nothing when nothing changed', async () => {
      const catalog = open();
      await run(catalog, 'standard');
      api.requests.length = 0;
      const seen = [];
      catalog.on('progress', (status) => status.job && seen.push(status.job.phase));
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(job.message, 'Standard is up to date: 11 cards. Nothing new.');
      assert.deepEqual([job.added, job.removed], [0, 0]);
      assert.equal(counts(api).length, 5, 'one small question per search');
      assert.equal(pages(api).length, 0, 'and not one card downloaded again');
      assert.equal(catalog.status().profiles[0].count, 11);
      assert.ok(seen.includes('counting') && !seen.includes('downloading'));
      assert.equal(catalog.search('pikachu').source, 'library');
    });

    it('downloads only the new cards of a search that grew, newest first, and stops once they are in', async () => {
      const OLD = Array.from({ length: 600 }, (_, i) => card(`old${Math.floor(i / 100) + 1}-${(i % 100) + 1}`, `Card ${i + 1}`, { regulationMark: 'J' }));
      let pool = [...STANDARD_POOL, ...OLDER_POOL, ...OLD];
      handler = (url) => ordered(pool)(url);
      const catalog = open();
      await run(catalog, 'standard');
      assert.equal(catalog.status().profiles[0].count, 611);
      assert.equal(searchOf('regulationMark:J').count, 602);

      pool = [...pool, ...['Sprigatito', 'Floragato', 'Meowscarada'].map((name, i) => card(`me2-${i + 1}`, name, { regulationMark: 'J', set: NEW_SET }))];
      api.requests.length = 0;
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done', job.message);
      assert.equal(job.message, 'Standard is up to date: 614 cards. 3 new.');
      assert.deepEqual([job.added, job.removed], [3, 0]);
      const downloaded = pages(api);
      assert.equal(downloaded.length, 1, 'one page of the three that search has');
      assert.deepEqual([downloaded[0].get('q'), downloaded[0].get('orderBy'), downloaded[0].get('page')], ['regulationMark:J', '-set.releaseDate', '1']);
      assert.deepEqual(catalog.search('meowscarada').cards.map((entry) => entry.id), ['me2-3']);
      assert.equal(catalog.status().profiles[0].count, 614);
      assert.deepEqual([searchOf('regulationMark:J').count, searchOf('regulationMark:J').ids.length], [605, 605]);

      api.requests.length = 0;
      assert.equal((await run(catalog, 'standard')).message, 'Standard is up to date: 614 cards. Nothing new.', 'and the next time there is nothing to bring');
      assert.equal(pages(api).length, 0);
    });

    it('downloads a search whole when it has fewer cards than before, and keeps only what it has now', async () => {
      let pool = [...STANDARD_POOL, ...OLDER_POOL];
      handler = (url) => ordered(pool)(url);
      const catalog = open();
      await run(catalog, 'standard');
      pool = pool.filter((item) => item.id !== 'sv8-5'); // Eevee is no longer an I card
      api.requests.length = 0;
      const job = await run(catalog, 'standard');
      assert.equal(job.message, 'Standard is up to date: 10 cards. 1 no longer in it.');
      assert.deepEqual(pages(api).map((params) => [params.get('q'), params.get('orderBy')]), [['regulationMark:I', null]]);
      assert.equal(catalog.search('eevee').totalCount, 0);
    });

    it('takes away the cards of a search that is gone (a rotation), and downloads a new search whole', async () => {
      const catalog = open();
      await run(catalog, 'standard');
      handler = cardApi([...STANDARD_POOL, ...OLDER_POOL, card('me3-1', 'Mew', { regulationMark: 'K', set: { id: 'me3', name: 'Set me3', releaseDate: '2027/03/01' } })]);
      const original = PROFILES.standard.queries;
      try {
        PROFILES.standard.queries = [...original.filter((query) => query !== 'regulationMark:H'), 'regulationMark:K'];
        api.requests.length = 0;
        const job = await run(catalog, 'standard');
        assert.equal(job.phase, 'done', job.message);
        assert.equal(job.message, 'Standard is up to date: 9 cards. 1 new, 3 no longer in it.');
        assert.deepEqual(pages(api).map((params) => [params.get('q'), params.get('orderBy')]), [['regulationMark:K', null]], 'only the new search is downloaded');
        assert.equal(catalog.search('raichu').totalCount, 0, 'an H card went');
        assert.equal(catalog.search('basic lightning').totalCount, 1, 'an H card that another search finds stays');
        assert.deepEqual(catalog.search('mew').cards.map((entry) => entry.id), ['me3-1']);
        assert.equal(saved().queries.some((entry) => JSON.parse(entry.key) === 'regulationMark:H'), false);
      } finally {
        PROFILES.standard.queries = original;
      }
    });

    it('works out the searches of a library saved before they were kept, from its cards, and downloads only what it cannot', async () => {
      const catalog = open();
      await run(catalog, 'standard');
      // as an earlier version saved it
      const file = saved();
      delete file.queries;
      fs.writeFileSync(path.join(dir, 'standard.json'), JSON.stringify(file));
      const metaFile = path.join(dir, 'standard.meta.json');
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      delete meta.tracked;
      delete meta.source;
      fs.writeFileSync(metaFile, JSON.stringify(meta));

      const reopened = open();
      assert.equal(reopened.status().profiles[0].updatable, true, 'a Standard library can be worked out from its cards');
      api.requests.length = 0;
      const job = await run(reopened, 'standard');
      assert.equal(job.message, 'Standard is up to date: 11 cards. Nothing new.');
      assert.deepEqual(pages(api).map((params) => params.get('q')), [NO_MARK_QUERY], 'the cards with no mark are the only search the cards cannot tell');
      assert.equal(saved().queries.length, 5, 'and now it knows them all');
      assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).tracked, true);
    });

    it('asks for a go-ahead for a big download only, not for an update that brings what is new', async () => {
      const catalog = open();
      assert.equal(catalog.status().profiles[2].updatable, false);
      assert.throws(() => catalog.download('expanded'), (error) => error.extra && error.extra.needsConfirm === true);
      await run(catalog, 'expanded', { confirm: true });
      assert.equal(catalog.status().profiles[2].updatable, true);
      assert.equal(catalog.status().profiles[1].updatable, true, 'Gym Leader Challenge is made from Expanded, with nothing to download');

      api.requests.length = 0;
      const job = await run(catalog, 'expanded');
      assert.equal(job.message, 'Expanded is up to date: 14 cards. Nothing new.');
      assert.equal(pages(api).length, 0);

      // Gym Leader Challenge keeps the search it took from Expanded, so it can be brought up to date on its own later
      assert.equal((await run(catalog, 'glc')).phase, 'done');
      catalog.remove('expanded');
      assert.equal(catalog.status().profiles[1].updatable, true);
      api.requests.length = 0;
      const glc = await run(catalog, 'glc');
      assert.equal(glc.phase, 'done', glc.message);
      assert.match(glc.message, /^Gym Leader Challenge is up to date: \d+ cards\. Nothing new\.$/);
      assert.equal(pages(api).length, 0);
    });

    it('keeps the library as it was when the card service fails during an update', async () => {
      const catalog = open();
      await run(catalog, 'standard');
      const before = fs.readFileSync(path.join(dir, 'standard.json'), 'utf8');
      handler = cardApi([...STANDARD_POOL, ...OLDER_POOL], (params) => (params.get('pageSize') === '1' ? respond(503, {}) : null));
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'error');
      assert.equal(fs.readFileSync(path.join(dir, 'standard.json'), 'utf8'), before);
      assert.equal(catalog.status().profiles[0].count, 11);
      assert.equal(catalog.search('pikachu').source, 'library', 'and the searches still use it');
    });
  });

  describe('Gym Leader Challenge and Expanded', () => {
    it('Expanded is every Expanded-legal card', async () => {
      const catalog = open();
      const job = await run(catalog, 'expanded', { confirm: true });
      assert.equal(job.phase, 'done');
      assert.equal(catalog.status().profiles[2].count, 14, 'the Base Set card is not Expanded-legal');
      assert.equal(catalog.search('pikachu').totalCount, 5, 'Pikachu from sm1, sv4 and me1, plus Pikachu ex and Pikachu EX');
    });

    it('Gym Leader Challenge leaves out Pokémon with a rule box', async () => {
      const catalog = open();
      await run(catalog, 'glc', { confirm: true });
      const names = (text, filters) => catalog.search(text, 1, filters).cards.map((c) => c.name);

      assert.equal(catalog.status().profiles[1].count, 11);
      assert.deepEqual(names('pikachu'), ['Pikachu', 'Pikachu', 'Pikachu'], 'neither Pikachu ex (rules text) nor Pikachu EX (subtype only)');
      assert.deepEqual(names('lucario'), [], 'Mega Lucario ex has a rule box');
      // Trainers, Energy and ordinary Pokémon all stay
      assert.deepEqual(names('iono'), ['Iono']);
      assert.deepEqual(names('energy'), ['Basic Lightning Energy', 'Basic Fire Energy']);
      assert.deepEqual(names('eevee'), ['Eevee']);
      assert.equal(catalog.status().active, 'glc');
    });

    it('builds Gym Leader Challenge from Expanded without downloading again, once Expanded is here', async () => {
      const catalog = open();
      await run(catalog, 'expanded', { confirm: true });
      const before = api.requests.length;

      const job = await run(catalog, 'glc', { confirm: true });
      assert.equal(job.phase, 'done');
      assert.equal(api.requests.length, before, 'no request to the card service');
      assert.equal(catalog.status().profiles[1].count, 11);
      assert.match(job.message, /Gym Leader Challenge is ready: 11 cards/);
    });
  });

  describe('when the card service misbehaves', () => {
    it('tries again when it is busy or slow, and finishes', async () => {
      let failures = 3;
      handler = cardApi([...STANDARD_POOL, ...OLDER_POOL], () => (failures-- > 0 ? respond(500, { error: 'busy' }) : null));
      const catalog = open();
      const messages = [];
      catalog.on('progress', (status) => status.job && messages.push(status.job.message));

      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done');
      assert.equal(catalog.status().profiles[0].count, 11);
      assert.ok(messages.some((message) => /Trying again \(1 of 7\)/.test(message)), 'the person is told why it is slow');
    });

    it('waits as long as the service asks when it says to slow down', async () => {
      let limited = true;
      handler = cardApi([...STANDARD_POOL, ...OLDER_POOL], () => {
        if (!limited) return null;
        limited = false;
        return respond(429, { error: 'rate limit' }, { 'Retry-After': '1' });
      });
      const catalog = open();
      const started = Date.now();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done');
      assert.ok(Date.now() - started >= 900, `waited ${Date.now() - started} ms`);
    });

    it('gives up with a clear message, keeping what it has', async () => {
      handler = cardApi([...STANDARD_POOL, ...OLDER_POOL], () => respond(503, { error: 'down' }));
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'error');
      assert.match(job.message, /not answering/);
      assert.match(job.message, /carries on from where it stopped/);
      assert.equal(catalog.status().profiles[0].ready, false);
      assert.equal(api.requests.length, 8, 'eight attempts, no more');
    });

    it('does not retry a request the service refuses outright', async () => {
      handler = cardApi([], () => respond(403, { error: 'forbidden' }));
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'error');
      assert.match(job.message, /refused the request \(403\)/);
      assert.equal(api.requests.length, 1);
    });

    it('asks for whole cards if the service does not accept the list of fields', async () => {
      let selects = 0;
      handler = cardApi([...STANDARD_POOL, ...OLDER_POOL], (params) => {
        if (params.get('select')) { selects++; return respond(400, { error: 'bad select' }); }
        return null;
      });
      const catalog = open();
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'done');
      assert.equal(selects, 1, 'asked once, then never again');
      assert.equal(catalog.status().profiles[0].count, 11);
    });

    it('survives the service not being there at all', async () => {
      const gone = await startMockCardApi({});
      const address = gone.url;
      await gone.close();
      const catalog = new CatalogService({ dir, db, baseUrl: address, paceMs: 0, retryDelayMs: 1 });
      catalog.init();
      track.push(catalog);
      const job = await run(catalog, 'standard');
      assert.equal(job.phase, 'error');
      assert.match(job.message, /not answering/);
    });
  });

  describe('big downloads that stop part way', () => {
    const MANY = Array.from({ length: 600 }, (_, i) => card(`sv${Math.floor(i / 100) + 1}-${(i % 100) + 1}`, `Card ${i + 1}`));

    it('carries on from where it stopped after a failure', async () => {
      let broken = true;
      handler = cardApi(MANY, (params) => (broken && params.get('pageSize') === '250' && params.get('page') !== '1' ? respond(500, {}) : null));
      const catalog = open();

      const first = await run(catalog, 'expanded', { confirm: true });
      assert.equal(first.phase, 'error');
      assert.equal(catalog.status().profiles[2].resumable, true);
      const askedBefore = api.requests.length;

      broken = false;
      const second = await run(catalog, 'expanded', { confirm: true });
      assert.equal(second.phase, 'done');
      assert.equal(catalog.status().profiles[2].count, 600);
      assert.equal(catalog.status().profiles[2].resumable, false);

      const after = api.requests.slice(askedBefore).map((url) => new URL(url, 'http://mock').searchParams);
      assert.deepEqual(after.map((params) => params.get('page')), ['2', '3'], 'no count again and no repeat of the first part');
      assert.equal(fs.existsSync(path.join(dir, 'expanded.partial.json')), false, 'the leftovers are cleaned up');
    });

    it('can be stopped, and carried on later', async () => {
      let catalog;
      handler = cardApi(MANY, (params) => {
        if (params.get('pageSize') === '250' && params.get('page') === '2') catalog.cancel();
        return null;
      });
      catalog = open();

      const stopped = await run(catalog, 'expanded', { confirm: true });
      assert.equal(stopped.phase, 'cancelled');
      assert.match(stopped.message, /Stopped/);
      assert.equal(catalog.status().profiles[2].ready, false);
      assert.equal(catalog.status().profiles[2].resumable, true);

      handler = cardApi(MANY);
      api.requests.length = 0;
      const finished = await run(catalog, 'expanded', { confirm: true });
      assert.equal(finished.phase, 'done');
      assert.equal(catalog.status().profiles[2].count, 600);
      assert.deepEqual(pages(api).map((params) => params.get('page')), ['2', '3']);
    });

    it('starts over if what is left over belongs to a different search', async () => {
      handler = cardApi(MANY, (params) => (params.get('pageSize') === '250' && params.get('page') === '2' ? respond(500, {}) : null));
      const catalog = open();
      await run(catalog, 'expanded', { confirm: true });

      const partial = path.join(dir, 'expanded.partial.json');
      const saved = JSON.parse(fs.readFileSync(partial, 'utf8'));
      fs.writeFileSync(partial, JSON.stringify({ ...saved, signature: 'from an older version' }));

      handler = cardApi(MANY);
      api.requests.length = 0;
      const job = await run(catalog, 'expanded', { confirm: true });
      assert.equal(job.phase, 'done');
      assert.equal(pages(api).length, 3, 'all three parts again');
    });

    it('paces its requests so the free service is not flooded', async () => {
      handler = cardApi(MANY);
      const catalog = open({ paceMs: 60 });
      const stamps = [];
      const original = api.requests.push.bind(api.requests);
      api.requests.push = (...args) => { stamps.push(Date.now()); return original(...args); };
      await run(catalog, 'expanded', { confirm: true });
      api.requests.push = original;
      const gaps = stamps.slice(2).map((time, i) => time - stamps[i + 1]); // between the three part requests
      assert.ok(gaps.every((gap) => gap >= 50), `gaps ${gaps.join(', ')}`);
    });
  });

  describe('searching', () => {
    let catalog;
    beforeEach(async () => {
      catalog = open();
      await run(catalog, 'expanded', { confirm: true });
    });
    const names = (text, page, filters) => catalog.search(text, page, filters).cards.map((c) => c.name);

    it('finds a card by the start of any word of its name', () => {
      assert.deepEqual(names('rai'), ['Raichu']);
      assert.deepEqual(names('pika ex'), ['Pikachu ex', 'Pikachu EX'], 'every word typed has to start a word of the name');
      assert.deepEqual(names('pikachu ex ex'), ['Pikachu ex', 'Pikachu EX']);
      assert.deepEqual(names('lucario'), ['Mega Lucario ex']);
      assert.deepEqual(names('ENERGY').sort(), ['Basic Fire Energy', 'Basic Lightning Energy']);
      assert.deepEqual(names('xyz'), []);
      assert.deepEqual(names('ika'), [], 'a word has to start with what was typed');
    });

    it('ignores accents and capital letters', () => {
      assert.deepEqual(names('pokemon catcher'), ['Pokémon Catcher']);
      assert.deepEqual(names('Pokémon'), ['Pokémon Catcher']);
      assert.deepEqual(names('PIKACHU EX'), ['Pikachu ex', 'Pikachu EX']);
    });

    it('puts the exact name first, then names that start with it, newest set first', () => {
      const found = catalog.search('pikachu').cards;
      assert.deepEqual(found.map((c) => [c.name, c.id]), [
        ['Pikachu', 'me1-6'], ['Pikachu', 'sv4-1'], ['Pikachu', 'sm1-1'], ['Pikachu ex', 'sv5-3'], ['Pikachu EX', 'xy1-1']
      ]);
    });

    it('narrows by type of card, subtype, rarity, set and what it evolves from', () => {
      assert.deepEqual(names('i', 1, { supertype: 'Trainer' }), ['Iono']);
      assert.deepEqual(names('pikachu', 1, { subtype: 'ex' }), ['Pikachu ex', 'Pikachu EX'], 'capital letters do not matter');
      assert.deepEqual(names('', 1, { subtype: 'MEGA' }), ['Mega Lucario ex']);
      assert.deepEqual(names('pikachu', 1, { set: 'sv4' }), ['Pikachu']);
      assert.deepEqual(names('pikachu', 1, { supertype: 'Pokémon', set: 'me1' }), ['Pikachu']);
      assert.deepEqual(names('', 1, { evolvesFrom: 'Pikachu' }), ['Raichu'], 'no text needed to list the evolutions');
      assert.deepEqual(names('rai', 1, { evolvesFrom: 'Eevee' }), []);
      assert.deepEqual(names('', 1, { supertype: 'Energy', subtype: 'Basic' }).length, 2);
      assert.deepEqual(names('pikachu', 1, { rarity: 'Rare' }), []);
    });

    it('answers in the shape of the online search, with pictures from this app', () => {
      const [first] = catalog.search('raichu').cards;
      assert.deepEqual(first, {
        id: 'sv4-2', name: 'Raichu', setName: 'Set sv4', setId: 'sv4',
        images: { small: '/img/sv4/2.png', large: '/img/sv4/2_hires.png' },
        rarity: 'Common', types: 'Lightning', hp: '70', number: '2', supertype: 'Pokémon', subtypes: 'Basic'
      });
      const result = catalog.search('raichu');
      assert.equal(result.source, 'library');
      assert.equal(result.library, 'Expanded');
      assert.equal(result.pageSize, 20);
    });

    it('looks up a card by id, with its abilities', async () => {
      const withAbility = card('sv7-1', 'Terapagos', { regulationMark: 'I', abilities: [{ name: 'Unified Beatdown', text: 'x' }, { name: '' }] });
      handler = cardApi([withAbility]);
      const other = open({ dir: path.join(dir, 'other') });
      await run(other, 'standard');
      const found = other.get('sv7-1');
      assert.deepEqual(found.abilities, ['Unified Beatdown']);
      assert.equal(found.name, 'Terapagos');
      assert.equal(found.regulationMark, 'I');
      assert.equal(other.get('nope-1'), null);
    });

    it('pages through many results, twenty at a time', async () => {
      handler = cardApi(Array.from({ length: 45 }, (_, i) => card(`sv4-${i + 1}`, 'Pikachu', { regulationMark: 'H' })));
      const big = open({ dir: path.join(dir, 'big') });
      await run(big, 'standard');
      const sizes = [1, 2, 3, 4].map((page) => big.search('pikachu', page).cards.length);
      assert.deepEqual(sizes, [20, 20, 5, 0]);
      assert.equal(big.search('pikachu', 2).totalCount, 45);
      assert.equal(big.search('pikachu', 2).page, 2);
      assert.equal(big.search('pikachu', 'banana').page, 1);
    });
  });

  describe('keeping and removing libraries', () => {
    it('remembers the library and the choice after a restart, without the internet', async () => {
      const first = open();
      await run(first, 'standard');
      first.setActive('standard');

      handler = () => { throw new Error('the card service must not be asked'); };
      api.requests.length = 0;
      const second = open();
      assert.equal(second.status().active, 'standard');
      assert.equal(second.status().profiles[0].count, 11);
      assert.equal(second.search('iono').totalCount, 1);
      assert.equal(api.requests.length, 0);
    });

    it('removes a library, and stops using it if it was the one in use', async () => {
      const catalog = open();
      await run(catalog, 'standard');
      assert.equal(catalog.status().active, 'standard');

      catalog.remove('standard');
      assert.equal(catalog.status().profiles[0].ready, false);
      assert.equal(catalog.status().active, null);
      assert.equal(catalog.search('pikachu'), null);
      assert.deepEqual(fs.readdirSync(dir), []);
      assert.equal(db.getSetting('cardLibraryActive'), null);
    });

    it('will not remove a library while it is downloading', async () => {
      const catalog = open({ paceMs: 40 });
      const done = ended(catalog);
      catalog.download('standard');
      assert.throws(() => catalog.remove('standard'), (error) => error.status === 409);
      await done;
    });

    it('copes with a damaged file instead of failing to start', async () => {
      const first = open();
      await run(first, 'standard');
      fs.writeFileSync(path.join(dir, 'standard.json'), '{ this is not json');

      const second = open();
      assert.equal(second.status().active, null);
      assert.equal(second.status().profiles[0].ready, false);
      assert.equal(second.search('pikachu'), null);
      // and it can be downloaded again
      assert.equal((await run(second, 'standard')).phase, 'done');
    });

    it('does not count a library as there until it is completely saved', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'standard.json'), JSON.stringify({ version: 1, id: 'standard', cards: [] }));
      assert.equal(open().status().profiles[0].ready, false, 'the small "meta" file is written last');
    });
  });

  describe('card pictures', () => {
    let host;
    let scrydexHost;
    let images;
    before(async () => {
      host = await startMockImageHost((url) => (url.includes('/sv4/2') ? respond(404, 'gone', { 'Content-Type': 'text/plain' }) : null));
      scrydexHost = await startMockImageHost((url) => (url.includes('/pokemon/me3-9/') ? respond(404, 'gone', { 'Content-Type': 'text/plain' }) : null));
    });
    after(async () => { await host.close(); await scrydexHost.close(); });
    beforeEach(() => {
      host.requests.length = 0;
      scrydexHost.requests.length = 0;
      images = new ImageCache({ dir: path.join(dir, 'pictures'), base: host.url, scrydexBase: scrydexHost.url });
    });

    // The newest sets have their pictures on Scrydex: https://images.scrydex.com/pokemon/<card id>/<size>
    const onScrydex = (id, name, extra = {}) => card(id, name, {
      regulationMark: 'J',
      images: { small: `https://images.scrydex.com/pokemon/${id}/small`, large: `https://images.scrydex.com/pokemon/${id}/large` },
      ...extra
    });

    it('keeps the pictures of the newest sets under short names and shows them through this app', async () => {
      handler = cardApi([onScrydex('me3-5', "Erika's Oddish"), card('sv4-1', 'Pikachu', { regulationMark: 'H' })]);
      const catalog = open({ images });
      await run(catalog, 'standard');

      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'standard.json'), 'utf8')).cards;
      assert.deepEqual(saved.find((item) => item.id === 'me3-5').images, { small: 'scrydex/me3-5_small.png', large: 'scrydex/me3-5_large.png' });
      assert.deepEqual(saved.find((item) => item.id === 'sv4-1').images, { small: 'sv4/1.png', large: 'sv4/1_hires.png' });

      const found = catalog.search('oddish');
      assert.deepEqual(found.cards[0].images, { small: '/img/scrydex/me3-5_small.png', large: '/img/scrydex/me3-5_large.png' });
      assert.deepEqual(catalog.get('me3-5').images, { small: '/img/scrydex/me3-5_small.png', large: '/img/scrydex/me3-5_large.png' });
    });

    it('saves them with the other pictures, from their own host', async () => {
      handler = cardApi([onScrydex('me3-5', 'Oddish'), onScrydex('me3-9', 'Gloom'), card('sv4-1', 'Pikachu', { regulationMark: 'H' })]);
      const catalog = open({ images });
      await run(catalog, 'standard');

      const done = ended(catalog);
      catalog.downloadPictures({ sizes: 'both' });
      const job = await done;
      assert.equal(job.phase, 'done');
      assert.equal(host.requests.length, 2, 'the Pikachu thumbnail and card art');
      assert.deepEqual(scrydexHost.requests.sort(), ['/pokemon/me3-5/large', '/pokemon/me3-5/small', '/pokemon/me3-9/large', '/pokemon/me3-9/small']);
      assert.equal(job.failed, 2, 'Gloom is not on their host');
      assert.ok(images.has('scrydex', 'me3-5_small.png') && images.has('scrydex', 'me3-5_large.png'));
    });

    it('still understands a library that was saved with their full addresses', async () => {
      const record = toRecord(onScrydex('me3-5', 'Oddish'));
      record.images = { small: 'https://images.scrydex.com/pokemon/me3-5/small', large: 'https://images.scrydex.com/pokemon/me3-5/large' };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'standard.json'), JSON.stringify({ version: 1, id: 'standard', cards: [record] }));
      fs.writeFileSync(path.join(dir, 'standard.meta.json'), JSON.stringify({ version: 1, id: 'standard', count: 1, builtAt: Date.now() }));

      const catalog = open({ images });
      catalog.setActive('standard');
      assert.equal(catalog.search('oddish').cards[0].images.small, '/img/scrydex/me3-5_small.png');
      const done = ended(catalog);
      catalog.downloadPictures({ sizes: 'small' });
      assert.equal((await done).phase, 'done');
      assert.deepEqual(scrydexHost.requests, ['/pokemon/me3-5/small']);
    });

    it('leaves a picture on any other host as the web address it is', () => {
      const elsewhere = toRecord(card('sv4-1', 'Pikachu', { images: { small: 'https://pictures.example.test/pikachu.png', large: '' } }));
      assert.equal(elsewhere.images.small, 'https://pictures.example.test/pikachu.png');
      assert.equal(elsewhere.images.large, '');
    });

    it('saves the small pictures of the library, then finds nothing left to do', async () => {
      const catalog = open({ images });
      await run(catalog, 'standard');

      const done = ended(catalog);
      catalog.downloadPictures({ sizes: 'small' });
      const job = await done;
      assert.equal(job.kind, 'pictures');
      assert.equal(job.phase, 'done');
      assert.equal(host.requests.length, 11, 'one small picture per card');
      assert.ok(host.requests.every((url) => !url.includes('hires')));
      assert.equal(job.failed, 1, 'one picture does not exist on the host');
      assert.match(job.message, /Saved 10 pictures\. 1 could not be downloaded\./);

      const again = ended(catalog);
      host.requests.length = 0;
      catalog.downloadPictures({ sizes: 'small' });
      assert.equal((await again).phase, 'done');
      assert.equal(host.requests.length, 1, 'only the picture that failed is tried again');
    });

    it('can save the full-size card art as well', async () => {
      const catalog = open({ images });
      await run(catalog, 'standard');
      const done = ended(catalog);
      catalog.downloadPictures({ sizes: 'both' });
      await done;
      assert.equal(host.requests.length, 22);
      assert.equal(host.requests.filter((url) => url.includes('hires')).length, 11);
    });

    it('needs the library chosen first, and a sensible choice of sizes', async () => {
      const catalog = open({ images });
      assert.throws(() => catalog.downloadPictures(), (error) => error.status === 409 && /library first/.test(error.message));
      await run(catalog, 'standard');
      assert.throws(() => catalog.downloadPictures({ sizes: 'enormous' }), (error) => error.status === 400);
    });

    it('asks for a go-ahead before saving thousands of pictures', async () => {
      handler = cardApi(Array.from({ length: 300 }, (_, i) => card(`sv4-${i + 1}`, `Card ${i + 1}`, { regulationMark: 'H' })));
      const catalog = open({ images });
      await run(catalog, 'standard');

      assert.throws(() => catalog.downloadPictures({ sizes: 'both' }), (error) => error.extra.needsConfirm === true && error.extra.count === 600);
      assert.equal(host.requests.length, 0);
      const done = ended(catalog);
      catalog.downloadPictures({ sizes: 'both', confirm: true });
      await done;
      assert.equal(host.requests.length, 600);
    });

    it('can be stopped', async () => {
      handler = cardApi(Array.from({ length: 300 }, (_, i) => card(`sv4-${i + 10}`, `Card ${i}`, { regulationMark: 'H' })));
      const catalog = open({ images });
      await run(catalog, 'standard');
      const done = ended(catalog);
      catalog.downloadPictures({ sizes: 'small' });
      catalog.cancel();
      const job = await done;
      assert.equal(job.phase, 'cancelled');
      assert.ok(host.requests.length < 300);
    });

    it('deletes the saved pictures', async () => {
      const catalog = open({ images });
      await run(catalog, 'standard');
      const done = ended(catalog);
      catalog.downloadPictures({ sizes: 'small' });
      await done;
      assert.ok(catalog.status({ pictures: true }).pictures.count > 0);
      catalog.clearPictures();
      assert.deepEqual(catalog.status({ pictures: true }).pictures, { count: 0, bytes: 0 });
    });
  });
});
