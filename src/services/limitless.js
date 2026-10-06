/**
 * The decks that are played the most, from Limitless TCG (https://limitlesstcg.com/decks): their names, and the Pokémon whose sprite is the icon of
 * each. The deck box of a trainer suggests these names, and a deck whose name does not say which Pokémon it is ("Basic Box", "Festival Lead") gets
 * the picture of its icon.
 *
 * The list comes with the app (public/js/deck-popular.js, a snapshot) and can be brought up to date: `refresh()` reads the page and keeps what it
 * found in the data folder, and the pages are given that list instead of the snapshot (`script()` is what /js/deck-popular.js answers with).
 * `npm run update:decks` does the same for the snapshot that is part of the project.
 *
 * Only the names, the share of each deck and which Pokémon are on its icon are kept; none of the page's own pictures or other data is. The
 * sprites themselves (r2.limitlesstcg.net/pokemon/gen9/<name>.png) can be shown too: /img/deckicon/<name>.png keeps each one on this computer the
 * first time it is asked for, as the card pictures are (see images.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const POKEDEX = require('../../public/js/pokedex');

const SOURCE = { name: 'Limitless TCG', url: process.env.OTO_LIMITLESS_URL || 'https://limitlesstcg.com/decks' };
const USER_AGENT = 'obs-tcg-overlay/1.0 (+https://github.com/manucruzleiva/obs-tcg-overlay)';
const FILE_VERSION = 1;
const MIN_DECKS = 5; // a page with fewer is not the list of decks
const MAX_DECKS = 100;
const PAGE_SIZE = 100; // the page shows 25 decks unless it is asked for more (?show=100)
const MAX_ICONS = 4;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const BUILT_IN = path.join(__dirname, '..', '..', 'public', 'js', 'deck-popular.js');

class LimitlessError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LimitlessError';
    this.status = status;
  }
}

// ---- reading the page

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text) => text
  .replace(/&#(\d+);/g, (all, code) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
  .replace(/&#x([0-9a-f]+);/gi, (all, code) => String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)))
  .replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] || all);

// "Dragapult <span class="annotation">ex</span>" is "Dragapult ex"; an annotation with nothing in it is nothing
function nameOf(html) {
  const text = decode(html.replace(/<span class="annotation">([\s\S]*?)<\/span>/g, ' $1 ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.slice(0, 60);
}

// The sprite of a Pokémon on Limitless is a file named for it: .../pokemon/gen9/ogerpon.png. Only plain names are taken from the page.
const slugOf = (src) => {
  const match = /\/([a-z0-9-]{1,40})\.png(?:\?|$)/i.exec(src || '');
  return match ? match[1].toLowerCase() : '';
};

// The Pokédex number of the Pokémon a sprite is of: "lopunny-mega" and "ogerpon-wellspring" are forms, and the Pokémon is the species they are of
function pokedexOf(slug) {
  let name = slug;
  for (;;) {
    const at = POKEDEX.NAMES.indexOf(name);
    if (at >= 0) return at + 1;
    const cut = name.lastIndexOf('-');
    if (cut <= 0) return 0;
    name = name.slice(0, cut);
  }
}

// The decks on the page, most played first: [{ name, share, pokemon: [Pokédex numbers], icons: [sprite names] }]. Nothing is run or fetched from it.
function parseDecks(html) {
  const decks = [];
  const seen = new Set();
  for (const row of String(html).match(/<tr[\s>][\s\S]*?<\/tr>/g) || []) {
    const link = /<a href="\/decks\/[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(row);
    if (!link) continue;
    const icons = [];
    for (const image of row.match(/<img\b[^>]*>/g) || []) {
      if (!/class="[^"]*\bpokemon\b[^"]*"/.test(image)) continue;
      const slug = slugOf((/src="([^"]*)"/.exec(image) || [])[1]);
      if (slug && !icons.includes(slug) && icons.length < MAX_ICONS) icons.push(slug);
    }
    const name = nameOf(link[1]);
    const key = name.toLowerCase();
    if (!name || icons.length === 0 || seen.has(key)) continue;
    seen.add(key);
    const share = /([\d.]+)\s*%/.exec(row.slice(row.indexOf('</a>')));
    decks.push({
      name,
      share: share ? Math.round(Number(share[1]) * 100) / 100 : 0,
      pokemon: icons.map(pokedexOf).filter((id) => id > 0),
      icons
    });
    if (decks.length >= MAX_DECKS) break;
  }
  return decks;
}

// What is kept from a list that was saved, or sent by a page: only the shape that is wanted, and nothing else
function cleanDecks(list) {
  if (!Array.isArray(list)) return [];
  const decks = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') continue;
    const name = raw.name.replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const share = Number(raw.share);
    decks.push({
      name,
      share: Number.isFinite(share) ? Math.max(0, Math.min(100, Math.round(share * 100) / 100)) : 0,
      pokemon: (Array.isArray(raw.pokemon) ? raw.pokemon : []).filter((id) => Number.isInteger(id) && id >= 1 && id <= POKEDEX.COUNT).slice(0, MAX_ICONS),
      icons: (Array.isArray(raw.icons) ? raw.icons : []).filter((slug) => typeof slug === 'string' && /^[a-z0-9-]{1,40}$/.test(slug)).slice(0, MAX_ICONS)
    });
    if (decks.length >= MAX_DECKS) break;
  }
  return decks;
}

// ---- the file the pages load (the same shape as the snapshot that is part of the project)

function render(decks, { date = new Date().toISOString().slice(0, 10), url = SOURCE.url } = {}) {
  const lines = cleanDecks(decks).map((deck) => `    { name: ${JSON.stringify(deck.name)}, share: ${deck.share}, pokemon: [${deck.pokemon.join(', ')}], icons: ${JSON.stringify(deck.icons)} }`);
  return `/**
 * The decks that are played the most, as people call them, with the Pokémon of the icon each has: the suggestions for the name of a deck in the
 * control panel, and a picture for a deck whose name does not say which Pokémon it is ("Basic Box", "Festival Lead"). Loaded in the browser as
 * OTO_DECK_POPULAR and by the server and the tests (via require).
 *
 * The deck list of Limitless TCG (${url}), read on ${date} (the ${lines.length} decks that were played the most, with their share of the results at that
 * time). Only the names, the share and which Pokémon is on the icon of each are kept: the pictures are the ones OTO already shows (the official artwork
 * from PokeAPI). \`pokemon\` holds Pokédex numbers (the first is the picture of the deck) and \`icons\` the names of the sprites on Limitless.
 * Written by src/services/limitless.js (\`npm run update:decks\`); the app can bring it up to date by itself (Settings, Cards).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_DECK_POPULAR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SOURCE = { name: ${JSON.stringify(SOURCE.name)}, url: ${JSON.stringify(url)}, date: ${JSON.stringify(date)} };
  const DECKS = [
${lines.join(',\n')}
  ];

  // Compared without capitals, accents or punctuation: "N's Zoroark ex" is "nszoroarkex"
  const fold = (text) => String(text).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let byName = new Map(DECKS.map((deck) => [fold(deck.name), deck]));

  // The popular deck a text is called (however it is written), or null
  const find = (text) => (typeof text === 'string' ? byName.get(fold(text)) || null : null);

  // A newer list (the app can bring it up to date while it runs): the pages that already have this file take it from here
  const replace = (decks, source) => {
    if (!Array.isArray(decks) || decks.length === 0) return;
    DECKS.splice(0, DECKS.length, ...decks);
    byName = new Map(DECKS.map((deck) => [fold(deck.name), deck]));
    if (source) Object.assign(SOURCE, source);
  };

  return { SOURCE, DECKS, get NAMES() { return DECKS.map((deck) => deck.name); }, find, replace };
}));
`;
}

// ---- the service

class LimitlessDecks {
  // `dir` is where the list that was read is kept (the data folder); `fetchImpl` is for the tests
  constructor({ dir, fetchImpl = fetch, url = SOURCE.url, log = () => {} }) {
    this.dir = dir;
    this.fetch = fetchImpl;
    this.url = url;
    this.log = log;
    this.data = null;
    this.running = null;
  }

  file() {
    return path.join(this.dir, 'popular-decks.json');
  }

  // The list that was read, from the data folder (null when there is none, or it cannot be read)
  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      const decks = cleanDecks(saved && saved.decks);
      this.data = saved && saved.version === FILE_VERSION && decks.length >= MIN_DECKS
        ? { source: { name: SOURCE.name, url: typeof saved.source?.url === 'string' ? saved.source.url : this.url }, fetchedAt: Number(saved.fetchedAt) || 0, decks }
        : null;
    } catch {
      this.data = null;
    }
    return this.data;
  }

  // What is known now: the list that was read, or the snapshot that comes with the app
  status() {
    if (this.data) return { builtIn: false, source: this.data.source, fetchedAt: this.data.fetchedAt, count: this.data.decks.length, decks: this.data.decks };
    const builtIn = require('../../public/js/deck-popular');
    return { builtIn: true, source: { name: builtIn.SOURCE.name, url: builtIn.SOURCE.url }, fetchedAt: Date.parse(builtIn.SOURCE.date) || 0, count: builtIn.DECKS.length, decks: builtIn.DECKS };
  }

  // The page of the list, as /js/deck-popular.js
  script() {
    if (!this.data) return fs.readFileSync(BUILT_IN, 'utf8');
    return render(this.data.decks, { date: new Date(this.data.fetchedAt).toISOString().slice(0, 10), url: this.data.source.url });
  }

  // Read the page of Limitless again and keep what is on it. The list that was kept before stays when this fails.
  async read() {
    let response;
    try {
      const address = new URL(this.url);
      if (!address.searchParams.has('show')) address.searchParams.set('show', String(PAGE_SIZE));
      response = await this.fetch(address.href, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new LimitlessError(`Limitless TCG could not be reached: ${error.message}`);
    }
    if (!response.ok) throw new LimitlessError(`Limitless TCG answered ${response.status}`);
    const html = await response.text();
    if (html.length > MAX_PAGE_BYTES) throw new LimitlessError('The page of Limitless TCG is far bigger than a list of decks');
    const decks = parseDecks(html);
    if (decks.length < MIN_DECKS) throw new LimitlessError('The page did not look like the list of decks (it may have changed)');
    return decks;
  }

  async refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const decks = await this.read();
      this.data = { source: { name: SOURCE.name, url: this.url }, fetchedAt: Date.now(), decks };
      fs.mkdirSync(this.dir, { recursive: true });
      const temp = `${this.file()}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, source: this.data.source, fetchedAt: this.data.fetchedAt, decks }));
      fs.renameSync(temp, this.file());
      this.log('info', 'The list of popular decks was read again', { decks: decks.length });
      return this.status();
    })().finally(() => { this.running = null; });
    return this.running;
  }

  // Go back to the snapshot that comes with the app
  clear() {
    fs.rmSync(this.file(), { force: true });
    this.data = null;
    return this.status();
  }
}

module.exports = { LimitlessDecks, LimitlessError, parseDecks, cleanDecks, render, pokedexOf, slugOf, SOURCE, MIN_DECKS };
