/**
 * Scrydex (https://scrydex.com): a card database that comes with an account. Every request carries the API key and the ID of
 * the team that owns it (the X-Api-Key and X-Team-ID headers). Used next to the other card services: it can be the one that is
 * asked (Settings, Cards), and it can build the Standard card library.
 *
 * The endpoints are the ones of its documentation: GET /pokemon/v1/cards (a Lucene-like `q`, `page`, `page_size`, `select`,
 * `casing`) and GET /pokemon/v1/cards/<id>. Cards come out in the shape of the other services' (see
 * PokemonTCGService.parseCardSummary), with `source: 'scrydex'`. Pictures are on images.scrydex.com, which the picture cache
 * (images.js) keeps on disk like the others.
 */

const { attacksOf, retreatOf } = require('./attacks');

const DEFAULT_BASE = 'https://api.scrydex.com/pokemon/v1';
const PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 8000;

class ScrydexError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'ScrydexError';
    this.status = status;
  }
}

// The API says "evolvesFrom" or "evolves_from" depending on how it was asked: read either
const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const field = (item, name) => (item[name] !== undefined ? item[name] : item[snake(name)]);

// The picture of the front of a card: { small, large }
function frontImages(item) {
  const list = Array.isArray(item.images) ? item.images : [];
  const front = list.find((image) => image && (image.type === 'front' || image.type === undefined)) || list[0] || {};
  return { small: String(front.small || ''), large: String(front.large || front.medium || front.small || '') };
}

// The words of a name typed by a person, safe to put in a query: the characters the query language reads are left out
const words = (text) => String(text || '').replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').split(/\s+/).filter(Boolean);
const quote = (value) => `"${String(value).replace(/["\\]/g, '')}"`;

const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Rare Ultra', 'Rare Secret', 'Promo', 'Unknown'];

class ScrydexClient {
  constructor({ baseUrl = process.env.OTO_SCRYDEX_API_URL || DEFAULT_BASE, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, retryDelayMs = Number(process.env.OTO_SCRYDEX_RETRY_MS) || 600 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.key = '';
    this.team = '';
  }

  setCredentials({ key = '', team = '' } = {}) {
    this.key = String(key || '');
    this.team = String(team || '');
  }

  // Both are needed: a key without its team (or the other way round) is not an account
  get configured() {
    return Boolean(this.key && this.team);
  }

  headers() {
    return { 'User-Agent': 'obs-tcg-overlay/1.0', 'X-Api-Key': this.key, 'X-Team-ID': this.team };
  }

  // ---------------------------------------------------------------------------------- requests

  // One request, tried again when the service is busy. `attempts` is how many tries in all.
  async request(path, params = {}, attempts = 1) {
    if (!this.configured) throw new ScrydexError('Scrydex needs your API key and your team ID: save them in Settings, Cards', { status: 401 });
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(name, String(value));
    const url = `${this.baseUrl}${path}${query.size ? `?${query}` : ''}`;

    let failure;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.ok) return await response.json();
        if (response.status === 401 || response.status === 403) throw new ScrydexError('Scrydex did not accept the API key and team ID: check them in Settings, Cards', { status: response.status });
        if (response.status === 404) throw new ScrydexError('not found', { status: 404 });
        failure = new ScrydexError(`Scrydex answered ${response.status}`, { status: response.status });
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        if (error instanceof ScrydexError && [401, 403, 404].includes(error.status)) throw error;
        failure = error instanceof ScrydexError ? error : new ScrydexError(error.name === 'TimeoutError' ? 'Scrydex took too long to answer' : error.message);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
    }
    throw failure;
  }

  // ----------------------------------------------------------------------------------- searching

  // The question, in the service's query language, for what a person typed and the filters of the card picker. Text that is
  // already in the query language (it has a ":") is passed on as it is.
  queryFor(text, filters = {}) {
    const terms = [];
    const typed = String(text || '').trim();
    if (typed.includes(':')) {
      terms.push(typed);
    } else {
      // every word is a start of a word of the name, so a name being typed is found
      const list = words(typed);
      list.forEach((word, index) => terms.push(`name:${word}${index === list.length - 1 ? '*' : ''}`));
    }
    if (filters.supertype) terms.push(`supertype:${quote(filters.supertype)}`);
    if (filters.subtype) terms.push(`subtypes:${quote(filters.subtype)}`);
    if (filters.rarity) terms.push(`rarity:${quote(filters.rarity)}`);
    if (filters.set) terms.push(`expansion.id:${quote(filters.set)}`);
    if (filters.evolvesFrom) terms.push(`evolves_from:${quote(filters.evolvesFrom)}`);
    return terms.join(' ');
  }

  // A page of cards: { cards, totalCount, page, pageSize, hasMore }
  async search(text, page = 1, filters = {}, { attempts = 1 } = {}) {
    const body = await this.request('/cards', { q: this.queryFor(text, filters), page, page_size: PAGE_SIZE, casing: 'camel' }, attempts);
    const items = Array.isArray(body && body.data) ? body.data : [];
    const cards = items.map((item) => this.summary(item)).sort((a, b) => this.rank(a.rarity) - this.rank(b.rarity));
    const total = Number(body && (body.totalCount ?? body.total_count));
    const before = (page - 1) * PAGE_SIZE;
    const totalCount = Number.isFinite(total) ? total : before + cards.length + (items.length >= PAGE_SIZE ? 1 : 0);
    return { cards, totalCount, page, pageSize: PAGE_SIZE, hasMore: totalCount > before + cards.length };
  }

  rank(rarity) {
    const found = RARITY_ORDER.indexOf(rarity);
    return found === -1 ? RARITY_ORDER.length : found;
  }

  // ------------------------------------------------------------------------------------ one card

  // A card with everything the overlay and the game take from it, or null when there is no such card
  async getCard(id, { attempts = 1 } = {}) {
    try {
      const body = await this.request(`/cards/${encodeURIComponent(id)}`, { casing: 'camel' }, attempts);
      const item = body && (body.data || body);
      return item && item.id ? this.detail(item) : null;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  // One page of cards as the service gives them, for building a library (see catalog.js)
  async libraryPage(q, page, pageSize, { attempts = 1, select } = {}) {
    const body = await this.request('/cards', { q, page, page_size: pageSize, casing: 'camel', select }, attempts);
    return { items: Array.isArray(body && body.data) ? body.data : [], totalCount: Number(body && (body.totalCount ?? body.total_count)) };
  }

  // ------------------------------------------------------------------------------------ shapes

  // As the card search shows a card (see PokemonTCGService.parseCardSummary)
  summary(item) {
    const expansion = field(item, 'expansion') || {};
    return {
      id: String(item.id || ''),
      name: String(item.name || ''),
      setName: String(expansion.name || ''),
      setId: String(expansion.id || ''),
      images: frontImages(item),
      rarity: item.rarity || 'Unknown',
      types: (item.types || []).join(', '),
      hp: item.hp ? String(item.hp) : '',
      number: String(item.number || ''),
      supertype: item.supertype || '',
      subtypes: (item.subtypes || []).join(', '),
      source: 'scrydex'
    };
  }

  // As a single card is shown (see PokemonTCGService.parseCardResponse)
  detail(item) {
    return {
      ...this.summary(item),
      rules: (item.rules || []).join('; '),
      artist: item.artist || '',
      flavorText: field(item, 'flavorText') || '',
      regulationMark: field(item, 'regulationMark') || '',
      attacks: attacksOf(item.attacks) || [],
      retreat: retreatOf({ convertedRetreatCost: field(item, 'convertedRetreatCost'), retreatCost: field(item, 'retreatCost') }),
      abilities: (item.abilities || []).map((ability) => ability && ability.name).filter(Boolean),
      evolvesFrom: String([].concat(field(item, 'evolvesFrom') || [])[0] || '')
    };
  }
}

module.exports = { ScrydexClient, ScrydexError, PAGE_SIZE, frontImages, field };
