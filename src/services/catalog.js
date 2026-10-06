/**
 * The card library: a copy of the cards for a format (Standard, Gym Leader Challenge or Expanded)
 * kept on this computer, so searching is instant and still works when the venue's internet does not.
 *
 * Each library is one JSON file. Downloading runs in the background, reports its progress, can be
 * stopped, and carries on from where it stopped if the card service fails halfway (it often does).
 *
 * A library remembers each of the searches it was made of: how many cards the service said it had, and which. Updating it asks each
 * search how many it has now (one small request) and downloads only the searches that changed: from the Pokémon TCG API newest first,
 * stopping once the new cards are in. The cards of a search that is gone (after a rotation) go with it. So an Update does not download
 * again the cards that are already here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ImageCache, pictureOf } = require('./images');
const { attacksOf, retreatOf } = require('./attacks');
const { frontImages, field } = require('./scrydex');
const { cardDetail } = require('./tcgdex');

const FILE_VERSION = 1;
const PAGE_SIZE = 250; // the most the card API allows
const SELECT = 'id,name,supertype,subtypes,hp,types,number,rarity,set,images,regulationMark,rules,abilities,attacks,convertedRetreatCost,evolvesFrom';
const REQUEST_TIMEOUT_MS = 90_000; // a page of 250 cards is slow on the free API
const ATTEMPTS = 8; // the free API fails two requests in three on a bad day, so be patient before giving up
const RETRY_DELAY_MS = 2000; // doubled after each failed attempt, up to MAX_RETRY_DELAY_MS
const MAX_RETRY_DELAY_MS = 30_000;
const PACE_MS = 1200; // pause between pages: the free API allows about 30 requests a minute
const CHECKPOINT_PAGES = 4;
const PROGRESS_EVERY_MS = 250;
const RESULTS_PER_PAGE = 20;
const CONFIRM_PICTURES_ABOVE = 500;
const NEWEST_FIRST = '-set.releaseDate'; // the order the Pokémon TCG API is asked for when only the new cards of a search are wanted
const MAX_PAGES = 400; // of one search: a service that never sends a short page cannot keep a download going for ever

// "Standard" is the current rotation, chosen by regulation mark. When the format rotates, move the oldest letter from
// STANDARD_MARKS to ROTATED_MARKS and add the new one to STANDARD_MARKS (and raise the revision of the Standard
// profile below, so the libraries people already have say they can be updated); nothing else needs to change.
const STANDARD_MARKS = ['H', 'I', 'J'];
const ROTATED_MARKS = ['D', 'E', 'F', 'G'];
const EXPANDED_QUERY = 'legalities.expanded:legal';
// Some cards have no regulation mark and are legal in Standard all the same: the reprints of a set the card service lists
// as legal there (the Classic Collection, for instance). Nothing to find them by but the set, so ask for the cards of
// those sets that carry none of the marks.
const NO_MARK_QUERY = `set.legalities.standard:legal ${[...ROTATED_MARKS, ...STANDARD_MARKS].map((mark) => `-regulationMark:${mark}`).join(' ')}`;

// Pokémon with these subtypes (or with rules text on the card) have a "rule box": ex, V, VMAX, VSTAR, GX...
const RULE_BOX_SUBTYPES = new Set(['ex', 'EX', 'GX', 'V', 'VMAX', 'VSTAR', 'V-UNION', 'BREAK', 'LEGEND', 'MEGA', 'Prism Star', 'TAG TEAM', 'Radiant']);

// The services that can build a library. Each is asked for the cards in its own words: the Pokémon TCG API tells which cards are
// legal in Expanded, so it builds all three libraries; Scrydex and TCGdex know regulation marks, so they build Standard.
const SOURCES = {
  pokemontcg: { label: 'Pokémon TCG API', pageSize: PAGE_SIZE },
  scrydex: { label: 'Scrydex', pageSize: 100 },
  tcgdex: { label: 'TCGdex', pageSize: 250 }
};
// the fields asked of Scrydex (if it does not like the list it is asked for whole cards, as the Pokémon TCG API is)
const SCRYDEX_SELECT = 'id,name,supertype,subtypes,hp,types,number,rarity,expansion,images,regulationMark,rules,abilities,attacks,convertedRetreatCost,evolvesFrom';

const PROFILES = {
  standard: {
    label: 'Standard',
    description: `The current rotation (regulation marks ${STANDARD_MARKS.join(', ')}), basic Energy, and the cards that have no regulation mark but are legal in Standard (reprints such as the Classic Collection).`,
    queries: [...STANDARD_MARKS.map((mark) => `regulationMark:${mark}`), 'supertype:Energy subtypes:Basic', NO_MARK_QUERY],
    // the services that can build it; the others ask for the regulation marks and basic Energy only
    sources: ['pokemontcg', 'scrydex', 'tcgdex'],
    otherQueries: {
      scrydex: [...STANDARD_MARKS.map((mark) => `regulation_mark:${mark}`), 'supertype:Energy subtypes:Basic'],
      tcgdex: [...STANDARD_MARKS.map((regulationMark) => ({ regulationMark })), { category: 'Energy', energyType: 'Normal' }]
    },
    // Raised each time what a library holds changes, so a copy saved before says it can be updated
    revision: 2,
    whatsNew: 'the cards that have no regulation mark but are legal in Standard',
    approximate: 3000,
    big: false
  },
  glc: {
    label: 'Gym Leader Challenge',
    description: 'Every card that is legal in Expanded, except Pokémon with a rule box (ex, V, VMAX, VSTAR, GX and the like).',
    queries: [EXPANDED_QUERY],
    sources: ['pokemontcg'],
    keep: (record) => !record.ruleBox,
    from: 'expanded', // built from the Expanded library when that is already here
    approximate: 13000,
    big: true
  },
  expanded: {
    label: 'Expanded',
    description: 'Every card that is legal in Expanded. This is a big download.',
    queries: [EXPANDED_QUERY],
    sources: ['pokemontcg'],
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
    attacks: attacksOf(item.attacks) || [],
    retreat: retreatOf(item) ?? 0,
    images: { small: shortImage(item.images && item.images.small), large: shortImage(item.images && item.images.large) }
  };
  if (isRuleBox(item)) record.ruleBox = true;
  return record;
}

// A card of Scrydex (as it gives them with casing=camel; snake case is read too)
function recordFromScrydex(item) {
  const expansion = field(item, 'expansion') || {};
  const images = frontImages(item);
  const evolves = field(item, 'evolvesFrom');
  const record = {
    id: String(item.id || ''),
    name: String(item.name || ''),
    supertype: String(item.supertype || ''),
    subtypes: strings(item.subtypes),
    hp: item.hp ? String(item.hp) : '',
    types: strings(item.types),
    number: String(item.number || ''),
    rarity: String(item.rarity || ''),
    setId: String(expansion.id || ''),
    setName: String(expansion.name || ''),
    released: String(field(expansion, 'releaseDate') || ''),
    mark: String(field(item, 'regulationMark') || ''),
    abilities: (Array.isArray(item.abilities) ? item.abilities : []).map((ability) => ability && ability.name).filter((name) => typeof name === 'string' && name),
    evolvesFrom: String(Array.isArray(evolves) ? evolves[0] || '' : evolves || ''),
    attacks: attacksOf(item.attacks) || [],
    retreat: retreatOf({ convertedRetreatCost: field(item, 'convertedRetreatCost'), retreatCost: field(item, 'retreatCost') }) ?? 0,
    images: { small: shortImage(images.small), large: shortImage(images.large) }
  };
  if (isRuleBox(item)) record.ruleBox = true;
  return record;
}

// A card of TCGdex; `dates` has the release date of each set (a card's own set says none)
function recordFromTcgdex(item, dates = {}) {
  const detail = cardDetail(item, 'en');
  const list = (text) => (text ? text.split(', ') : []);
  const record = {
    id: detail.id,
    name: detail.name,
    supertype: detail.supertype,
    subtypes: list(detail.subtypes),
    hp: detail.hp,
    types: list(detail.types),
    number: detail.number,
    rarity: detail.rarity === 'Unknown' ? '' : detail.rarity,
    setId: detail.setId,
    setName: detail.setName,
    released: dates[detail.setId] || '',
    mark: detail.regulationMark,
    abilities: detail.abilities,
    evolvesFrom: String(item.evolveFrom || ''),
    attacks: detail.attacks,
    retreat: detail.retreat ?? 0,
    images: { small: shortImage(detail.images.small), large: shortImage(detail.images.large) }
  };
  // TCGdex has no rules text for a Pokémon: a rule box shows in the suffix (ex, V...) and the stage (VMAX, VSTAR...)
  if (isRuleBox({ supertype: record.supertype, rules: [], subtypes: record.subtypes })) record.ruleBox = true;
  return record;
}

// A card as one of the services gives it, as it is kept
const recordOf = (source, item, dates) => (source === 'scrydex' ? recordFromScrydex(item) : source === 'tcgdex' ? recordFromTcgdex(item, dates) : toRecord(item));

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
  // a library saved before attacks and retreat costs were kept has neither: undefined says so, and the card is asked for online
  return {
    ...summary(record), rules: '', artist: '', flavorText: '', regulationMark: record.mark, attacks: record.attacks, retreat: record.retreat, abilities: record.abilities,
    evolvesFrom: record.evolvesFrom || '', detailed: record.detailed === true
  };
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
  // `baseUrl` and `apiKey` are the Pokémon TCG API's; `scrydex` and `tcgdex` are the clients of those services (see scrydex.js and
  // tcgdex.js), and `librarySource` says which of the three builds the libraries (it is a setting)
  constructor({
    dir, db, images = null, baseUrl, apiKey = () => '', fetchImpl = fetch, scrydex = null, tcgdex = null, librarySource = () => 'pokemontcg',
    paceMs = PACE_MS, timeoutMs = REQUEST_TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS, log = () => {}
  }) {
    super();
    this.dir = dir;
    this.db = db;
    this.images = images;
    this.baseUrl = typeof baseUrl === 'function' ? baseUrl : () => baseUrl;
    this.apiKey = apiKey;
    this.scrydex = scrydex;
    this.tcgdex = tcgdex;
    this.librarySource = librarySource;
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
    this.useSelect = { pokemontcg: true, scrydex: true }; // whether each service takes a list of the fields it is asked for
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
      this.metas[id] = meta && meta.version === FILE_VERSION
        ? { count: meta.count, builtAt: meta.builtAt, bytes, revision: meta.revision || 1, source: meta.source || 'pokemontcg', tracked: meta.tracked === true }
        : null;
    } catch {
      this.metas[id] = null;
    }
  }

  readLibrary(id) {
    return this.readLibraryFile(id).cards;
  }

  // The cards of a library, and the searches it was made of ({ key, count, ids } each), or null for a library saved before they were kept
  readLibraryFile(id) {
    const data = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    if (!data || data.version !== FILE_VERSION || !Array.isArray(data.cards)) throw new Error('unreadable library file');
    const queries = Array.isArray(data.queries) && data.queries.every((entry) => entry && typeof entry.key === 'string' && Number.isInteger(entry.count) && Array.isArray(entry.ids))
      ? data.queries
      : null;
    return { cards: data.cards, queries };
  }

  // One of the files of a library, all at once (a half-written file is never seen)
  writeFile(id, kind, content) {
    const temp = `${this.file(id, kind)}.${process.pid}.tmp`;
    fs.writeFileSync(temp, content);
    // (Windows can hold a file for a moment, a virus scanner looking at it: try again a few times)
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(temp, this.file(id, kind));
        return;
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * attempt);
      }
    }
  }

  writeLibrary(id, records, source = 'pokemontcg', queries = null) {
    // The small "meta" file is written last: a library only counts as there once it exists
    this.writeFile(id, 'json', JSON.stringify(queries ? { version: FILE_VERSION, id, cards: records, queries } : { version: FILE_VERSION, id, cards: records }));
    this.writeFile(id, 'meta.json', JSON.stringify({ version: FILE_VERSION, id, count: records.length, builtAt: Date.now(), revision: PROFILES[id].revision || 1, source, tracked: Boolean(queries) }));
    this.refreshMeta(id);
  }

  // The libraries that are here, what one is called, and the service it was built from
  libraryIds() {
    return Object.keys(PROFILES).filter((id) => this.metas[id]);
  }

  labelOf(id) {
    return PROFILES[id] ? PROFILES[id].label : id;
  }

  sourceOf(id) {
    return this.metas[id] ? this.metas[id].source : 'pokemontcg';
  }

  // Put what was found out about some cards (their attacks, retreat cost, abilities) into a library that is here: `patches` is a Map of card id to the
  // fields to set. The cards, the count and the date it was built stay as they were. Returns how many cards changed.
  patchRecords(id, patches) {
    if (!PROFILES[id] || !this.metas[id]) throw new CatalogError('That library has not been downloaded yet', { status: 409 });
    if (this.running('library', id)) throw new CatalogError('Wait for the download to finish', { status: 409 });
    const { cards, queries } = this.readLibraryFile(id);
    let changed = 0;
    for (const card of cards) {
      const patch = patches.get(card.id);
      if (!patch) continue;
      Object.assign(card, patch);
      changed++;
    }
    if (changed === 0) return 0;
    this.writeFile(id, 'json', JSON.stringify(queries ? { version: FILE_VERSION, id, cards, queries } : { version: FILE_VERSION, id, cards }));
    this.refreshMeta(id);
    if (this.activeId === id) this.index = buildIndex(id, cards);
    return changed;
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

  // The service the settings choose to build the libraries (the Pokémon TCG API when they name one that is not known)
  chosenSource() {
    const chosen = this.librarySource();
    return Object.hasOwn(SOURCES, chosen) ? chosen : 'pokemontcg';
  }

  // The service that builds a library: the one chosen when it can, and the Pokémon TCG API for one that needs to know what is legal in Expanded
  sourceFor(id) {
    const chosen = this.chosenSource();
    return PROFILES[id].sources.includes(chosen) ? chosen : 'pokemontcg';
  }

  // Whether downloading a library again only brings what is new: it is here, it came from the service that would build it now, and it knows
  // the searches it was made of (or they can be worked out from its cards, which a library that leaves some cards out cannot do). A library
  // built from another one that is here (Gym Leader Challenge from Expanded) downloads nothing either.
  canUpdate(id, source = this.sourceFor(id)) {
    const profile = PROFILES[id];
    if (profile.from && this.metas[profile.from]) return true;
    const meta = this.metas[id];
    return Boolean(meta && meta.source === source && (meta.tracked || !profile.keep));
  }

  status({ pictures = false } = {}) {
    const running = this.job && !this.job.finished ? this.job : null;
    return {
      serial: this.serial,
      active: this.activeId,
      // the service that builds the libraries when one is downloaded or updated
      source: this.chosenSource(),
      sources: Object.fromEntries(Object.entries(SOURCES).map(([key, entry]) => [key, entry.label])),
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
        // the services that can build it, the one it was built from, and the one a download or an update would use now
        sources: profile.sources,
        source: this.metas[id] ? this.metas[id].source : null,
        using: this.sourceFor(id),
        // downloading it again only brings what is new
        updatable: this.canUpdate(id),
        // saved before what the library holds changed: Update brings it up to date
        outdated: Boolean(this.metas[id] && this.metas[id].revision < (profile.revision || 1)),
        whatsNew: profile.whatsNew || '',
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
    // the service chosen in the settings builds it when it can; a library that needs to know what is legal in Expanded always
    // comes from the Pokémon TCG API
    const source = this.sourceFor(id);
    // (an update that only brings the new cards is not a big download)
    if (profile.big && !confirm && !this.canUpdate(id, source)) {
      throw new CatalogError(`${profile.label} is a big download (about ${profile.approximate.toLocaleString('en-US')} cards). Confirm to start it.`, { status: 400, needsConfirm: true, approximate: profile.approximate });
    }
    if (source === 'scrydex' && !(this.scrydex && this.scrydex.configured)) {
      throw new CatalogError('Scrydex needs your API key and team ID: save them in Settings, Cards, or choose another service to build the libraries', { status: 400 });
    }
    if (source === 'tcgdex' && !this.tcgdex) throw new CatalogError('TCGdex is not available', { status: 400 });
    this.startJob('library', id);
    this.runLibrary(id, source).catch((error) => this.log('error', 'Card library job failed', { id, error: error.message }));
    return this.status();
  }

  async runLibrary(id, service = 'pokemontcg') {
    const profile = PROFILES[id];
    try {
      // Gym Leader Challenge is Expanded without the rule-box Pokémon, so build it from Expanded when that is here
      const parent = profile.from && this.metas[profile.from] ? this.readLibraryFile(profile.from) : null;
      let records;
      let queries = null; // the searches it is made of, so the next update knows what it has
      let built = service; // the service the cards came from
      let update = null; // { added, removed } when it was brought up to date rather than downloaded
      if (parent) {
        this.progress({ phase: 'saving', done: parent.cards.length, total: parent.cards.length, message: `Building from your ${PROFILES[profile.from].label} library…` });
        records = parent.cards.filter(profile.keep);
        queries = parent.queries;
        built = this.metas[profile.from].source;
      } else {
        const plan = this.updatePlan(id, profile, service);
        const result = plan ? await this.updateLibrary(profile, service, plan) : await this.fetchLibrary(id, profile, service);
        ({ records, queries } = result);
        update = result.update || null;
      }
      this.progress({ phase: 'saving', message: 'Saving…' });
      this.writeLibrary(id, records, built, queries);
      fs.rmSync(this.file(id, 'partial.json'), { force: true });

      // the first library you download is the one searches use, until you choose otherwise
      if (this.activeId === null) this.setActive(id);
      else if (this.activeId === id) this.index = buildIndex(id, records);

      const from = built === 'pokemontcg' ? '' : ` (from ${SOURCES[built].label})`;
      const cards = `${records.length.toLocaleString('en-US')} cards${from}`;
      const news = update && [update.added && `${update.added.toLocaleString('en-US')} new`, update.removed && `${update.removed.toLocaleString('en-US')} no longer in it`].filter(Boolean).join(', ');
      const message = update ? `${profile.label} is up to date: ${cards}. ${news ? `${news.charAt(0).toUpperCase()}${news.slice(1)}.` : 'Nothing new.'}` : `${profile.label} is ready: ${cards}.`;
      this.endJob({ phase: 'done', ok: true, done: records.length, total: records.length, added: update ? update.added : undefined, removed: update ? update.removed : undefined, message });
    } catch (error) {
      if (error instanceof Stopped) this.endJob({ phase: 'cancelled', message: 'Stopped. You can carry on later from where it got to.' });
      else this.endJob({ phase: 'error', message: error.message });
    }
  }

  // The questions that build a library from a service: the Pokémon TCG API's are written in the profile
  queriesOf(profile, source) {
    return source === 'pokemontcg' ? profile.queries : profile.otherQueries[source];
  }

  async fetchLibrary(id, profile, source = 'pokemontcg') {
    const queries = this.queriesOf(profile, source);
    const pageSize = SOURCES[source].pageSize;
    // (a download from the Pokémon TCG API keeps the signature it always had, so one that stopped partway can still carry on)
    const signature = JSON.stringify(source === 'pokemontcg' ? [FILE_VERSION, profile.queries] : [FILE_VERSION, source, queries]);
    const partial = this.readPartial(id, signature);

    this.progress({ phase: 'counting', message: 'Asking the card service how many cards there are…' });
    const totals = partial ? partial.totals : [];
    if (!partial) {
      // null when the service does not say (TCGdex): the pages are followed until one is not full
      for (const query of queries) totals.push(await this.countOf(source, query));
    }
    const dates = source === 'tcgdex' ? await this.tcgdexDates() : {};
    const known = totals.every((count) => count !== null);
    const total = known ? totals.reduce((sum, count) => sum + count, 0) : PROFILES[id].approximate;
    const pageCounts = totals.map((count) => (count === null ? Infinity : Math.ceil(count / pageSize)));
    const pagesTotal = pageCounts.reduce((sum, count) => sum + count, 0);

    const found = new Map((partial ? partial.cards : []).map((card) => [card.id, card]));
    // the cards each search found (a download saved part way by an earlier version has none: the next update downloads those searches again)
    const idsOf = queries.map((query, index) => new Set(partial && Array.isArray(partial.ids) && Array.isArray(partial.ids[index]) ? partial.ids[index] : []));
    let queryIndex = partial ? partial.queryIndex : 0;
    let page = partial ? partial.page : 1;
    let fetched = partial ? partial.fetched : 0;
    let sinceSave = 0;
    const checkpoint = () => {
      const data = { signature, totals, queryIndex, page, fetched, cards: [...found.values()], ids: idsOf.map((ids) => [...ids]) };
      fs.writeFileSync(this.file(id, 'partial.json'), JSON.stringify(data));
    };
    const pagesBefore = () => pageCounts.slice(0, queryIndex).reduce((sum, count) => sum + count, 0) + page;

    try {
      while (queryIndex < queries.length) {
        if (page > pageCounts[queryIndex]) { queryIndex++; page = 1; continue; }
        this.progress({ phase: 'downloading', done: fetched, total: Math.max(total, fetched), message: known ? `Downloading cards (part ${pagesBefore()} of ${pagesTotal})…` : 'Downloading cards…' });
        const items = await this.fetchPage(source, queries[queryIndex], page, pageSize);
        for (const item of items) {
          const record = recordOf(source, item, dates);
          if (!record.id) continue;
          found.set(record.id, record);
          idsOf[queryIndex].add(record.id);
        }
        fetched += items.length;
        // a page that is not full is the last one: the only way to know when the service does not say how many there are
        if (totals[queryIndex] === null && items.length < pageSize) pageCounts[queryIndex] = page;
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
    return {
      records: [...found.values()].filter(profile.keep || (() => true)),
      // (TCGdex does not say how many cards a search has: what it gave is the count)
      queries: queries.map((query, index) => ({ key: JSON.stringify(query), count: totals[index] ?? idsOf[index].size, ids: [...idsOf[index]] }))
    };
  }

  // ---- updating

  // What an update has to go on: the cards of the library and the searches it was made of, or null when it has to be downloaded whole
  // (it is not here, it came from another service, or what it was made of cannot be told)
  updatePlan(id, profile, source) {
    const meta = this.metas[id];
    if (!meta || meta.source !== source) return null;
    let file;
    try {
      file = this.readLibraryFile(id);
    } catch {
      return null;
    }
    const queries = file.queries || this.searchesOf(file.cards, profile, source);
    return queries ? { cards: file.cards, queries } : null;
  }

  // The searches of a library saved before they were kept, worked out from its cards: a regulation mark, basic Energy, every card. A
  // search it cannot work out is left out, and an update downloads it again. Nothing can be worked out for a library that leaves cards out.
  searchesOf(cards, profile, source) {
    if (profile.keep) return null;
    const basicEnergy = (card) => card.supertype === 'Energy' && card.subtypes.includes('Basic');
    const testOf = (query) => {
      if (query && typeof query === 'object') {
        if (query.regulationMark) return (card) => card.mark === query.regulationMark;
        if (query.category === 'Energy' && query.energyType === 'Normal') return basicEnergy;
        return null;
      }
      const mark = /^regulation_?[mM]ark:([A-Z])$/.exec(query);
      if (mark) return (card) => card.mark === mark[1];
      if (query === 'supertype:Energy subtypes:Basic') return basicEnergy;
      if (query === EXPANDED_QUERY) return () => true;
      return null;
    };
    const searches = [];
    for (const query of this.queriesOf(profile, source)) {
      const test = testOf(query);
      if (!test) continue;
      const ids = cards.filter(test).map((card) => card.id);
      searches.push({ key: JSON.stringify(query), count: ids.length, ids });
    }
    return searches;
  }

  // Bring a library up to date (see the top of this file). Returns its cards, its searches and how many cards came and went.
  async updateLibrary(profile, source, plan) {
    const queries = this.queriesOf(profile, source);
    const stored = new Map(plan.queries.map((entry) => [entry.key, entry]));
    const byId = new Map(plan.cards.map((record) => [record.id, record]));
    let dates = {};
    let downloaded = 0;
    const onRecord = (record) => {
      byId.set(record.id, record);
      downloaded++;
      this.progress({ done: downloaded });
    };

    // TCGdex does not say how many cards a search has: a set released after the newest one in the library is what says there is more
    let tcgdexNews = true;
    if (source === 'tcgdex') {
      this.progress({ phase: 'counting', message: 'Looking for new cards…' });
      dates = await this.tcgdexDates();
      const newest = plan.cards.reduce((latest, card) => (card.released > latest ? card.released : latest), '');
      const sets = new Set(plan.cards.map((card) => card.setId));
      tcgdexNews = Object.keys(dates).length === 0 || Object.entries(dates).some(([set, released]) => !sets.has(set) && released > newest);
    }

    const result = [];
    for (const [index, query] of queries.entries()) {
      const key = JSON.stringify(query);
      const known = stored.get(key);
      this.progress({ phase: 'counting', done: index, total: queries.length, message: `Looking for new cards (search ${index + 1} of ${queries.length})…` });
      const count = source === 'tcgdex' ? null : await this.countOf(source, query);
      const same = known && (source === 'tcgdex' ? !tcgdexNews : count === known.count);
      if (same) {
        result.push(known);
        continue;
      }
      // more cards than there were: only the new ones are wanted (the Pokémon TCG API can give them first); anything else, the whole search
      const grew = known && count !== null && count > known.count ? count - known.count : 0;
      this.progress({ phase: 'downloading', done: downloaded, total: 0, message: grew ? `Downloading the new cards (${grew.toLocaleString('en-US')})…` : 'Downloading the cards of a search that changed…' });
      const ids = await this.fetchSearch(source, query, { known: grew ? known.ids : null, grew, count, dates, onRecord });
      result.push({ key, count: count ?? ids.length, ids });
    }

    // the cards of the searches there are now (a card of a search that is gone goes with it)
    const wanted = new Set(result.flatMap((entry) => entry.ids));
    const before = new Set(plan.cards.map((record) => record.id));
    const records = [...byId.values()].filter((record) => wanted.has(record.id)).filter(profile.keep || (() => true));
    const added = records.filter((record) => !before.has(record.id)).length;
    const removed = plan.cards.filter((record) => !wanted.has(record.id)).length;
    return { records, queries: result, update: { added, removed } };
  }

  // The cards of one search, page after page, each handed to onRecord; returns the ids of all the cards the search has. When it is known
  // that `grew` cards were added to the `known` ones, the Pokémon TCG API is asked for the newest first, and it stops once they have come.
  async fetchSearch(source, query, { known = null, grew = 0, count = null, dates = {}, onRecord }) {
    const pageSize = SOURCES[source].pageSize;
    const newestFirst = source === 'pokemontcg' && Boolean(known) && grew > 0;
    const ids = new Set(newestFirst ? known : []);
    const lastPage = count === null ? MAX_PAGES : Math.min(MAX_PAGES, Math.max(1, Math.ceil(count / pageSize)));
    let fresh = 0;
    for (let page = 1; page <= lastPage; page++) {
      const items = await this.fetchPage(source, query, page, pageSize, newestFirst ? NEWEST_FIRST : undefined);
      for (const item of items) {
        const record = recordOf(source, item, dates);
        if (!record.id) continue;
        if (!ids.has(record.id)) fresh++;
        ids.add(record.id);
        onRecord(record);
      }
      await this.pause(this.paceMs);
      this.checkStop();
      if (items.length < pageSize || (newestFirst && fresh >= grew)) break;
    }
    return [...ids];
  }

  // How many cards a question has, or null when the service does not say
  async countOf(source, query) {
    if (source === 'tcgdex') return null;
    const data = await this.fetchJson(source === 'scrydex' ? { q: query, page: 1, pageSize: 1 } : { q: query, pageSize: 1 }, 'id', source);
    return Number(data.totalCount ?? data.total_count) || 0;
  }

  // One page of cards, as the service gives them (in the order asked for, when the service is the Pokémon TCG API and one is given)
  async fetchPage(source, query, page, pageSize, orderBy) {
    if (source === 'tcgdex') {
      const data = await this.fetchJson({ filters: query, page, pageSize }, undefined, source);
      if (data && data.errors && data.errors.length) throw new CatalogError(`TCGdex refused the question (${String(data.errors[0].message || '').slice(0, 120)})`, { status: 502 });
      return Array.isArray(data && data.data && data.data.cards) ? data.data.cards : [];
    }
    const params = source === 'pokemontcg' && orderBy ? { q: query, page, pageSize, orderBy } : { q: query, page, pageSize };
    const data = await this.fetchJson(params, source === 'scrydex' ? SCRYDEX_SELECT : SELECT, source);
    return Array.isArray(data.data) ? data.data : [];
  }

  // The release date of every set of TCGdex, as the other services write dates (a library lists the newest sets first). A library
  // is still built without them when they cannot be had.
  async tcgdexDates() {
    try {
      const data = await this.fetchJson({}, undefined, 'tcgdex', this.tcgdex.setsRequest());
      return Object.fromEntries(((data && data.data && data.data.sets) || []).filter((set) => set.id && set.releaseDate).map((set) => [set.id, String(set.releaseDate).replace(/-/g, '/')]));
    } catch (error) {
      if (error instanceof Stopped) throw error;
      this.log('warn', 'The release dates of the card sets could not be had', { error: error.message });
      return {};
    }
  }

  // The request for a page of cards of a source: where to ask, and how
  describe(source, params, select) {
    if (source === 'scrydex') {
      const query = new URLSearchParams({ casing: 'camel' });
      if (params.q) query.set('q', params.q);
      if (params.page) query.set('page', String(params.page));
      if (params.pageSize) query.set('page_size', String(params.pageSize));
      if (select && this.useSelect.scrydex) query.set('select', select);
      return { url: `${this.scrydex.baseUrl}/cards?${query}`, init: { headers: this.scrydex.headers() } };
    }
    if (source === 'tcgdex') return this.tcgdex.libraryRequest(params.filters, params.page, params.pageSize);
    return { url: this.url(params, select), init: { headers: this.headers() } };
  }

  // One request to a card service, retried when the service is busy or slow
  async fetchJson(params, select = SELECT, source = 'pokemontcg', request = null) {
    let failure = 'no answer';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      this.checkStop();
      let wait = Math.min(this.retryDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      try {
        const asked = request || this.describe(source, params, select);
        const response = await this.fetch(asked.url, {
          ...asked.init,
          signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.abort.signal])
        });
        if (response.ok) return await response.json();
        if (response.status === 400 && this.useSelect[source] && select) {
          // the API did not like the list of fields: ask for whole cards from now on
          this.useSelect[source] = false;
          attempt--;
          continue;
        }
        if (response.status !== 429 && response.status < 500) {
          if (source === 'scrydex' && (response.status === 401 || response.status === 403)) {
            throw new CatalogError('Scrydex did not accept the API key and team ID: check them in Settings, Cards.', { status: 502 });
          }
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
    if (select && this.useSelect.pokemontcg) all.select = select;
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

module.exports = { CatalogService, CatalogError, PROFILES, SOURCES, STANDARD_MARKS, ROTATED_MARKS, NO_MARK_QUERY, RULE_BOX_SUBTYPES, toRecord, recordFromScrydex, recordFromTcgdex, words, PAGE_SIZE };
