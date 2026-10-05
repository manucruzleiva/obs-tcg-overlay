/**
 * The card library: a copy of the cards for a format (Standard, Gym Leader Challenge or Expanded)
 * kept on this computer, so searching is instant and still works when the venue's internet does not.
 *
 * Each library is one JSON file. Downloading runs in the background, reports its progress, can be
 * stopped, and carries on from where it stopped if the card service fails halfway (it often does).
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ImageCache, pictureOf } = require('./images');

const FILE_VERSION = 1;
const PAGE_SIZE = 250; // the most the card API allows
const SELECT = 'id,name,supertype,subtypes,hp,types,number,rarity,set,images,regulationMark,rules,abilities,evolvesFrom';
const REQUEST_TIMEOUT_MS = 90_000; // a page of 250 cards is slow on the free API
const ATTEMPTS = 8; // the free API fails two requests in three on a bad day, so be patient before giving up
const RETRY_DELAY_MS = 2000; // doubled after each failed attempt, up to MAX_RETRY_DELAY_MS
const MAX_RETRY_DELAY_MS = 30_000;
const PACE_MS = 1200; // pause between pages: the free API allows about 30 requests a minute
const CHECKPOINT_PAGES = 4;
const PROGRESS_EVERY_MS = 250;
const RESULTS_PER_PAGE = 20;
const CONFIRM_PICTURES_ABOVE = 500;

// "Standard" is the current rotation, chosen by regulation mark. When the format rotates, add the new
// letter and drop the oldest one here; nothing else needs to change.
const STANDARD_MARKS = ['H', 'I', 'J'];
const EXPANDED_QUERY = 'legalities.expanded:legal';

// Pokémon with these subtypes (or with rules text on the card) have a "rule box": ex, V, VMAX, VSTAR, GX...
const RULE_BOX_SUBTYPES = new Set(['ex', 'EX', 'GX', 'V', 'VMAX', 'VSTAR', 'V-UNION', 'BREAK', 'LEGEND', 'MEGA', 'Prism Star', 'TAG TEAM', 'Radiant']);

const PROFILES = {
  standard: {
    label: 'Standard',
    description: `The current rotation (regulation marks ${STANDARD_MARKS.join(', ')}) and basic Energy.`,
    queries: [...STANDARD_MARKS.map((mark) => `regulationMark:${mark}`), 'supertype:Energy subtypes:Basic'],
    approximate: 3000,
    big: false
  },
  glc: {
    label: 'Gym Leader Challenge',
    description: 'Every card that is legal in Expanded, except Pokémon with a rule box (ex, V, VMAX, VSTAR, GX and the like).',
    queries: [EXPANDED_QUERY],
    keep: (record) => !record.ruleBox,
    from: 'expanded', // built from the Expanded library when that is already here
    approximate: 13000,
    big: true
  },
  expanded: {
    label: 'Expanded',
    description: 'Every card that is legal in Expanded. This is a big download.',
    queries: [EXPANDED_QUERY],
    approximate: 15000,
    big: true
  }
};

class CatalogError extends Error {
  constructor(message, { status = 400, ...extra } = {}) {
    super(message);
    this.name = 'CatalogError';
    this.status = status;
    this.extra = extra;
  }
}

class Stopped extends Error {}

// ------------------------------------------------------------------------------------ records

const isRuleBox = (item) => item.supertype === 'Pokémon'
  && ((Array.isArray(item.rules) && item.rules.length > 0) || (item.subtypes || []).some((subtype) => RULE_BOX_SUBTYPES.has(subtype)));

const strings = (list) => (Array.isArray(list) ? list.map(String) : []);

// Picture addresses are kept as "set/file" when they are on a card image host, which is nearly all of them
// (the pictures of the newest sets, on Scrydex, as "scrydex/<card id>_<size>.png")
const shortImage = (url) => {
  const picture = pictureOf(url);
  return picture ? `${picture.set}/${picture.file}` : typeof url === 'string' ? url : '';
};
const expandImage = (value) => {
  if (!value) return '';
  const picture = pictureOf(value); // a full address, from a library saved before the short form existed
  return picture ? `/img/${picture.set}/${picture.file}` : /^https?:/.test(value) ? value : `/img/${value}`;
};

// { set, file } for a picture kept as "set/file" (null for anything else, such as a web address on another host)
function pictureKey(value) {
  const known = pictureOf(value);
  if (known) return known;
  const [set, file, ...rest] = String(value || '').split('/');
  return rest.length === 0 && file && ImageCache.isValid(set, file) ? { set, file } : null;
}

// What is kept of a card from the API: enough to search, pick and show it
function toRecord(item) {
  const record = {
    id: String(item.id || ''),
    name: String(item.name || ''),
    supertype: String(item.supertype || ''),
    subtypes: strings(item.subtypes),
    hp: item.hp ? String(item.hp) : '',
    types: strings(item.types),
    number: String(item.number || ''),
    rarity: String(item.rarity || ''),
    setId: String((item.set && item.set.id) || ''),
    setName: String((item.set && item.set.name) || ''),
    released: String((item.set && item.set.releaseDate) || ''),
    mark: String(item.regulationMark || ''),
    abilities: (Array.isArray(item.abilities) ? item.abilities : []).map((ability) => ability && ability.name).filter((name) => typeof name === 'string' && name),
    evolvesFrom: String(item.evolvesFrom || ''),
    images: { small: shortImage(item.images && item.images.small), large: shortImage(item.images && item.images.large) }
  };
  if (isRuleBox(item)) record.ruleBox = true;
  return record;
}

// The shape the card search returns (see PokemonTCGService.parseCardSummary)
function summary(record) {
  return {
    id: record.id,
    name: record.name,
    setName: record.setName,
    setId: record.setId,
    images: { small: expandImage(record.images.small), large: expandImage(record.images.large) },
    rarity: record.rarity || 'Unknown',
    types: record.types.join(', '),
    hp: record.hp,
    number: record.number,
    supertype: record.supertype,
    subtypes: record.subtypes.join(', ')
  };
}

// The shape a single card lookup returns (see PokemonTCGService.parseCardResponse)
function detail(record) {
  return { ...summary(record), rules: '', artist: '', flavorText: '', regulationMark: record.mark, attacks: [], abilities: record.abilities };
}

// "Pokémon" matches "pokemon", and every word typed has to start some word of the name
const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (text) => fold(text).split(/[^a-z0-9]+/).filter(Boolean);

function buildIndex(id, records) {
  const cards = records.map((record) => ({ ...record, _name: fold(record.name), _words: words(record.name) }));
  // newest sets first, then by card number: the cards you are most likely to want come first
  cards.sort((a, b) => (a.released < b.released ? 1 : a.released > b.released ? -1 : (parseInt(a.number, 10) || 9999) - (parseInt(b.number, 10) || 9999) || (a.id < b.id ? -1 : 1)));
  return { id, label: PROFILES[id].label, cards, byId: new Map(cards.map((card) => [card.id, card])) };
}

// ------------------------------------------------------------------------------------ service

class CatalogService extends EventEmitter {
  constructor({
    dir, db, images = null, baseUrl, apiKey = () => '', fetchImpl = fetch,
    paceMs = PACE_MS, timeoutMs = REQUEST_TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS, log = () => {}
  }) {
    super();
    this.dir = dir;
    this.db = db;
    this.images = images;
    this.baseUrl = typeof baseUrl === 'function' ? baseUrl : () => baseUrl;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.paceMs = paceMs;
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.log = log;

    this.metas = {}; // per library: { count, builtAt, bytes } once it is downloaded
    this.index = null; // the library searches go to
    this.activeId = null;
    this.job = null; // the running download, or the last one that ended (so a page can show how it went)
    this.jobCount = 0;
    this.useSelect = true;
    this.lastEmit = 0;
    // Counts every change. Answers to HTTP requests and events pushed over the socket can arrive in either
    // order, so a page keeps only the newest of what it is sent.
    this.serial = 0;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const id of Object.keys(PROFILES)) this.refreshMeta(id);
    const active = this.db.getSetting('cardLibraryActive', null);
    if (active && this.metas[active]) {
      try {
        this.index = buildIndex(active, this.readLibrary(active));
        this.activeId = active;
      } catch (error) {
        this.log('warn', 'Card library could not be read', { id: active, error: error.message });
        this.discard(active);
      }
    }
  }

  // ---- files

  file(id, kind = 'json') {
    return path.join(this.dir, `${id}.${kind}`);
  }

  refreshMeta(id) {
    try {
      const meta = JSON.parse(fs.readFileSync(this.file(id, 'meta.json'), 'utf8'));
      const bytes = fs.statSync(this.file(id)).size; // throws when the data file is missing
      this.metas[id] = meta && meta.version === FILE_VERSION ? { count: meta.count, builtAt: meta.builtAt, bytes } : null;
    } catch {
      this.metas[id] = null;
    }
  }

  readLibrary(id) {
    const data = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    if (!data || data.version !== FILE_VERSION || !Array.isArray(data.cards)) throw new Error('unreadable library file');
    return data.cards;
  }

  writeLibrary(id, records) {
    const write = (kind, content) => {
      const temp = `${this.file(id, kind)}.${process.pid}.tmp`;
      fs.writeFileSync(temp, content);
      fs.renameSync(temp, this.file(id, kind));
    };
    // The small "meta" file is written last: a library only counts as there once it exists
    write('json', JSON.stringify({ version: FILE_VERSION, id, cards: records }));
    write('meta.json', JSON.stringify({ version: FILE_VERSION, id, count: records.length, builtAt: Date.now() }));
    this.refreshMeta(id);
  }

  discard(id) {
    for (const kind of ['json', 'meta.json', 'partial.json']) fs.rmSync(this.file(id, kind), { force: true });
    this.metas[id] = null;
  }

  readPartial(id, signature) {
    try {
      const partial = JSON.parse(fs.readFileSync(this.file(id, 'partial.json'), 'utf8'));
      return partial.signature === signature && Array.isArray(partial.cards) && Array.isArray(partial.totals) ? partial : null;
    } catch {
      return null;
    }
  }

  // ---- what the pages need

  status({ pictures = false } = {}) {
    const running = this.job && !this.job.finished ? this.job : null;
    return {
      serial: this.serial,
      active: this.activeId,
      profiles: Object.entries(PROFILES).map(([id, profile]) => ({
        id,
        label: profile.label,
        description: profile.description,
        approximate: profile.approximate,
        big: profile.big,
        ready: Boolean(this.metas[id]),
        count: this.metas[id] ? this.metas[id].count : 0,
        builtAt: this.metas[id] ? this.metas[id].builtAt : null,
        bytes: this.metas[id] ? this.metas[id].bytes : 0,
        // a download that stopped partway and can carry on
        resumable: !this.metas[id] && fs.existsSync(this.file(id, 'partial.json')) && !(running && running.profile === id),
        building: Boolean(running && running.kind === 'library' && running.profile === id)
      })),
      pictures: pictures && this.images ? this.images.stats() : undefined,
      job: this.job ? { ...this.job } : null
    };
  }

  emitStatus() {
    this.serial++;
    this.emit('progress', this.status());
  }

  // Search the active library. Returns null when there is none (the caller then asks the web).
  search(text, page = 1, filters = {}) {
    const index = this.index;
    if (!index) return null;

    const wanted = words(text);
    const same = (a, b) => fold(a) === fold(b);
    const query = fold(String(text).trim());
    const matches = index.cards.filter((card) => {
      if (wanted.length && !wanted.every((word) => card._words.some((own) => own.startsWith(word)))) return false;
      if (filters.supertype && !same(card.supertype, filters.supertype)) return false;
      if (filters.subtype && !card.subtypes.some((subtype) => same(subtype, filters.subtype))) return false;
      if (filters.rarity && !same(card.rarity, filters.rarity)) return false;
      if (filters.set && !same(card.setId, filters.set)) return false;
      if (filters.evolvesFrom && !same(card.evolvesFrom, filters.evolvesFrom)) return false;
      return true;
    });

    // the exact name first, then names that start with what was typed (the order inside each group stays newest first)
    const rank = (card) => (card._name === query ? 0 : card._name.startsWith(query) ? 1 : 2);
    if (query) matches.sort((a, b) => rank(a) - rank(b));

    const number = Math.max(1, parseInt(page, 10) || 1);
    return {
      cards: matches.slice((number - 1) * RESULTS_PER_PAGE, number * RESULTS_PER_PAGE).map(summary),
      totalCount: matches.length,
      page: number,
      pageSize: RESULTS_PER_PAGE,
      source: 'library',
      library: index.label
    };
  }

  // One card by id from the active library, or null
  get(id) {
    const card = this.index && this.index.byId.get(id);
    return card ? detail(card) : null;
  }

  setActive(id) {
    if (id !== null) {
      if (!PROFILES[id]) throw new CatalogError('There is no such library', { status: 404 });
      if (!this.metas[id]) throw new CatalogError('That library has not been downloaded yet', { status: 409 });
      this.index = buildIndex(id, this.readLibrary(id));
    } else {
      this.index = null;
    }
    this.activeId = id;
    this.db.setSetting('cardLibraryActive', id);
    this.emitStatus();
  }

  remove(id) {
    if (!PROFILES[id]) throw new CatalogError('There is no such library', { status: 404 });
    if (this.running('library', id)) throw new CatalogError('Stop the download first', { status: 409 });
    this.discard(id);
    if (this.activeId === id) this.setActive(null);
    else this.emitStatus();
  }

  clearPictures() {
    if (this.running('pictures')) throw new CatalogError('Stop the picture download first', { status: 409 });
    if (this.images) this.images.clear();
    this.emitStatus();
  }

  // ---- jobs

  running(kind, profile) {
    const job = this.job;
    return Boolean(job && !job.finished && (!kind || job.kind === kind) && (!profile || job.profile === profile));
  }

  startJob(kind, profile) {
    if (this.running()) throw new CatalogError('Something is already downloading. Wait for it to finish or stop it first.', { status: 409 });
    this.abort = new AbortController();
    this.job = { id: ++this.jobCount, kind, profile, phase: 'starting', done: 0, total: 0, failed: 0, message: 'Starting…', finished: false, ok: false, stopping: false };
    this.emitStatus();
    return this.job;
  }

  endJob(patch) {
    Object.assign(this.job, patch, { finished: true });
    this.lastEmit = 0;
    this.emitStatus();
  }

  // Update the running job. Counting up is thinned out; a new phase or a new message always goes through.
  progress(patch) {
    if (!this.job || this.job.finished) return;
    const changed = (patch.phase && patch.phase !== this.job.phase) || (patch.message !== undefined && patch.message !== this.job.message);
    Object.assign(this.job, patch);
    this.serial++;
    const now = Date.now();
    if (changed || now - this.lastEmit >= PROGRESS_EVERY_MS) {
      this.lastEmit = now;
      this.emitStatus();
    }
  }

  cancel() {
    if (!this.running()) return false;
    this.job.stopping = true;
    this.job.message = 'Stopping…';
    this.abort.abort();
    if (this.wake) this.wake();
    this.emitStatus();
    return true;
  }

  checkStop() {
    if (this.job && this.job.stopping) throw new Stopped();
  }

  pause(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wake === done) self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  // Start downloading a library in the background. Returns at once; follow the progress events.
  download(id, { confirm = false } = {}) {
    const profile = PROFILES[id];
    if (!profile) throw new CatalogError('There is no such library', { status: 404 });
    if (profile.big && !confirm) {
      throw new CatalogError(`${profile.label} is a big download (about ${profile.approximate.toLocaleString('en-US')} cards). Confirm to start it.`, { status: 400, needsConfirm: true, approximate: profile.approximate });
    }
    this.startJob('library', id);
    this.runLibrary(id).catch((error) => this.log('error', 'Card library job failed', { id, error: error.message }));
    return this.status();
  }

  async runLibrary(id) {
    const profile = PROFILES[id];
    try {
      // Gym Leader Challenge is Expanded without the rule-box Pokémon, so build it from Expanded when that is here
      const source = profile.from && this.metas[profile.from] ? this.readLibrary(profile.from) : null;
      let records;
      if (source) {
        this.progress({ phase: 'saving', done: source.length, total: source.length, message: `Building from your ${PROFILES[profile.from].label} library…` });
        records = source.filter(profile.keep);
      } else {
        records = await this.fetchLibrary(id, profile);
      }
      this.progress({ phase: 'saving', message: 'Saving…' });
      this.writeLibrary(id, records);
      fs.rmSync(this.file(id, 'partial.json'), { force: true });

      // the first library you download is the one searches use, until you choose otherwise
      if (this.activeId === null) this.setActive(id);
      else if (this.activeId === id) this.index = buildIndex(id, records);

      this.endJob({ phase: 'done', ok: true, done: records.length, total: records.length, message: `${profile.label} is ready: ${records.length.toLocaleString('en-US')} cards.` });
    } catch (error) {
      if (error instanceof Stopped) this.endJob({ phase: 'cancelled', message: 'Stopped. You can carry on later from where it got to.' });
      else this.endJob({ phase: 'error', message: error.message });
    }
  }

  async fetchLibrary(id, profile) {
    const signature = JSON.stringify([FILE_VERSION, profile.queries]);
    const partial = this.readPartial(id, signature);

    this.progress({ phase: 'counting', message: 'Asking the card service how many cards there are…' });
    const totals = partial ? partial.totals : [];
    if (!partial) {
      for (const query of profile.queries) totals.push((await this.fetchJson({ q: query, pageSize: 1 }, 'id')).totalCount || 0);
    }
    const total = totals.reduce((sum, count) => sum + count, 0);
    const pageCounts = totals.map((count) => Math.ceil(count / PAGE_SIZE));
    const pagesTotal = pageCounts.reduce((sum, count) => sum + count, 0);

    const found = new Map((partial ? partial.cards : []).map((card) => [card.id, card]));
    let queryIndex = partial ? partial.queryIndex : 0;
    let page = partial ? partial.page : 1;
    let fetched = partial ? partial.fetched : 0;
    let sinceSave = 0;
    const checkpoint = () => {
      const data = { signature, totals, queryIndex, page, fetched, cards: [...found.values()] };
      fs.writeFileSync(this.file(id, 'partial.json'), JSON.stringify(data));
    };
    const pagesBefore = () => pageCounts.slice(0, queryIndex).reduce((sum, count) => sum + count, 0) + page;

    try {
      while (queryIndex < profile.queries.length) {
        if (page > pageCounts[queryIndex]) { queryIndex++; page = 1; continue; }
        this.progress({ phase: 'downloading', done: fetched, total, message: `Downloading cards (part ${pagesBefore()} of ${pagesTotal})…` });
        const data = await this.fetchJson({ q: profile.queries[queryIndex], page, pageSize: PAGE_SIZE });
        const items = Array.isArray(data.data) ? data.data : [];
        for (const item of items) {
          const record = toRecord(item);
          if (record.id) found.set(record.id, record);
        }
        fetched += items.length;
        page++;
        this.progress({ done: fetched });
        if (++sinceSave >= CHECKPOINT_PAGES) { sinceSave = 0; checkpoint(); }
        await this.pause(this.paceMs);
        this.checkStop();
      }
    } catch (error) {
      checkpoint(); // keep what there is, so the next try carries on from here
      throw error;
    }
    return [...found.values()].filter(profile.keep || (() => true));
  }

  // One request to the card API, retried when the service is busy or slow
  async fetchJson(params, select = SELECT) {
    let failure = 'no answer';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      this.checkStop();
      let wait = Math.min(this.retryDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      try {
        const response = await this.fetch(this.url(params, select), {
          headers: this.headers(),
          signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.abort.signal])
        });
        if (response.ok) return await response.json();
        if (response.status === 400 && this.useSelect) {
          // the API did not like the list of fields: ask for whole cards from now on
          this.useSelect = false;
          attempt--;
          continue;
        }
        if (response.status !== 429 && response.status < 500) {
          throw new CatalogError(`The card service refused the request (${response.status}).`, { status: 502 });
        }
        failure = `the card service answered ${response.status}`;
        const retryAfter = Number(response.headers.get('retry-after'));
        if (retryAfter > 0) wait = Math.min(retryAfter, 60) * 1000;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        this.checkStop();
        failure = error.name === 'TimeoutError' ? 'the card service took too long to answer' : error.message;
      }
      if (attempt < ATTEMPTS) {
        this.progress({ message: `The card service is slow to answer. Trying again (${attempt} of ${ATTEMPTS - 1})…` });
        await this.pause(wait);
      }
    }
    throw new CatalogError(`The card service is not answering (${failure}). Try again in a few minutes: the download carries on from where it stopped.`, { status: 502 });
  }

  url(params, select) {
    const all = { ...params };
    if (select && this.useSelect) all.select = select;
    const query = Object.entries(all).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    return `${this.baseUrl()}/cards?${query}`;
  }

  headers() {
    const headers = { 'User-Agent': 'obs-tcg-overlay/1.0 (card library)' };
    const key = this.apiKey();
    if (key) headers['X-Api-Key'] = key;
    return headers;
  }

  // Save the pictures of the active library on disk. `sizes` is "small" (the thumbnails the picker shows)
  // or "both" (thumbnails and the larger card art the overlay shows).
  downloadPictures({ sizes = 'both', confirm = false } = {}) {
    if (!this.images) throw new CatalogError('Pictures are not available', { status: 409 });
    if (!this.index) throw new CatalogError('Choose a card library first', { status: 409 });
    if (!['small', 'both'].includes(sizes)) throw new CatalogError('Choose which pictures to save', { status: 400 });

    const wanted = [];
    for (const card of this.index.cards) {
      for (const size of sizes === 'both' ? ['small', 'large'] : ['small']) {
        const key = pictureKey(card.images[size]);
        if (key && !this.images.has(key.set, key.file)) wanted.push(key);
      }
    }
    if (wanted.length > CONFIRM_PICTURES_ABOVE && !confirm) {
      throw new CatalogError(`That is ${wanted.length.toLocaleString('en-US')} pictures. Confirm to start.`, { status: 400, needsConfirm: true, count: wanted.length });
    }

    const job = this.startJob('pictures', this.index.id);
    if (wanted.length === 0) {
      this.endJob({ phase: 'done', ok: true, message: 'All the pictures are already saved.' });
      return this.status();
    }
    this.progress({ phase: 'downloading', total: wanted.length, message: 'Saving pictures…' });
    this.images.prefetch(wanted, {
      shouldStop: () => job.stopping,
      onProgress: ({ done, failed }) => this.progress({ done, failed })
    }).then(({ done, failed, stopped }) => {
      const saved = done - failed;
      if (stopped) this.endJob({ phase: 'cancelled', done, failed, message: `Stopped after saving ${saved.toLocaleString('en-US')} pictures.` });
      else this.endJob({ phase: 'done', ok: true, done, failed, message: failed ? `Saved ${saved.toLocaleString('en-US')} pictures. ${failed.toLocaleString('en-US')} could not be downloaded.` : `Saved ${saved.toLocaleString('en-US')} pictures.` });
    }).catch((error) => this.endJob({ phase: 'error', message: error.message }));
    return this.status();
  }
}

module.exports = { CatalogService, CatalogError, PROFILES, STANDARD_MARKS, RULE_BOX_SUBTYPES, toRecord, words, PAGE_SIZE };
