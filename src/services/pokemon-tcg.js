/**
 * Card search and card details. Three card services answer: the Pokémon TCG API (English cards), TCGdex (many languages, see
 * tcgdex.js) and Scrydex (an account with a key, see scrydex.js). Which one is asked is a setting: one of them, or
 * "automatic", the Pokémon TCG API first and TCGdex when it does not answer. A service that failed a moment ago is asked
 * last, so a search never waits for one that is down. The cards kept on this computer (the card library, see catalog.js)
 * answer first, in English.
 */

const { localImageUrl } = require('./images');
const { attacksOf, retreatOf } = require('./attacks');
const { TcgdexClient, LANGUAGE_CODES } = require('./tcgdex');
const { ScrydexClient } = require('./scrydex');

// A card lookup must never hang the control panel when the network is slow or down
const REQUEST_TIMEOUT_MS = 8000;
// With another service to fall back on, the first one is given less time
const FALLBACK_TIMEOUT_MS = 5000;
// How long a service that failed is asked last
const FAILURE_MEMORY_MS = 2 * 60 * 1000;

const RARITY_ORDER = [
  'Common', 'Uncommon', 'Rare', 'Rare Holo',
  'Rare Ultra', 'Rare Secret', 'Promo', 'Unknown'
];

class PokemonTCGService {
  constructor(cache, { tcgdex = new TcgdexClient(), scrydex = new ScrydexClient() } = {}) {
    this.cache = cache;
    this.tcgdex = tcgdex;
    this.scrydex = scrydex;
    this.source = 'auto'; // which services are asked: 'auto', 'pokemontcg', 'scrydex' or 'tcgdex'
    this.language = 'en'; // the language of the cards TCGdex is asked for
    this.failedAt = {}; // when each service last failed
    this.providers = {
      pokemontcg: {
        // POKEMONTCG_API_URL points the app at another server (the tests use a local mock)
        baseUrl: process.env.POKEMONTCG_API_URL || 'https://api.pokemontcg.io/v2',
        name: 'Pokémon TCG API'
      }
    };
    this.currentProvider = 'pokemontcg';
    this.apiKey = '';
    this.catalog = null; // the card library on this computer (see catalog.js), when there is one
  }

  setCatalog(catalog) {
    this.catalog = catalog;
  }

  // Card pictures are served by this app, which keeps a copy on disk, instead of straight from the image host
  localize(card) {
    if (!card || !card.images) return card;
    return { ...card, images: Object.fromEntries(Object.entries(card.images).map(([size, url]) => [size, localImageUrl(url)])) };
  }

  localizeResult(result) {
    return { ...result, cards: result.cards.map((card) => this.localize(card)) };
  }

  // Which services to ask ('auto', 'pokemontcg', 'scrydex' or 'tcgdex'), the key of the Pokémon TCG API and the language of the cards
  setProvider(provider, apiKey = '', language = this.language) {
    if (['auto', 'pokemontcg', 'scrydex', 'tcgdex'].includes(provider)) this.source = provider;
    this.apiKey = apiKey;
    this.language = LANGUAGE_CODES.includes(language) ? language : 'en';
    this.tcgdex.setLanguage(this.language);
  }

  // The account on Scrydex: its API key and the ID of its team
  setCredentials({ scrydexKey = '', scrydexTeam = '' } = {}) {
    this.scrydex.setCredentials({ key: scrydexKey, team: scrydexTeam });
  }

  getProvider() {
    return this.source;
  }

  // The services to ask, in order. One that failed a moment ago goes last.
  order() {
    if (this.source === 'pokemontcg') return ['pokemontcg'];
    if (this.source === 'scrydex') return ['scrydex'];
    if (this.source === 'tcgdex') return ['tcgdex'];
    // the Pokémon TCG API has English cards only: another language is asked of TCGdex first
    const usual = this.language === 'en' ? ['pokemontcg', 'tcgdex'] : ['tcgdex', 'pokemontcg'];
    const down = (name) => Date.now() - (this.failedAt[name] || 0) < FAILURE_MEMORY_MS;
    return [...usual.filter((name) => !down(name)), ...usual.filter(down)];
  }

  failed(name) {
    this.failedAt[name] = Date.now();
  }

  worked(name) {
    delete this.failedAt[name];
  }

  // What a person typed ("pikachu") becomes an API query (name:"pikachu*"); anything already in
  // the API's own syntax ("name:pika* set.id:base1") is passed through. Filters narrow it further.
  buildQuery(text, filters = {}) {
    // no text is fine when a filter says what to look for (the evolutions of a Pokémon, for instance)
    const terms = text.trim() ? [/[:]/.test(text) ? text.trim() : `name:"${text.trim().replace(/"/g, '')}*"`] : [];
    const quote = (value) => `"${String(value).replace(/"/g, '')}"`;
    if (filters.supertype) terms.push(`supertype:${quote(filters.supertype)}`);
    if (filters.subtype) terms.push(`subtypes:${quote(filters.subtype)}`);
    if (filters.rarity) terms.push(`rarity:${quote(filters.rarity)}`);
    if (filters.set) terms.push(`set.id:${quote(filters.set)}`);
    if (filters.evolvesFrom) terms.push(`evolvesFrom:${quote(filters.evolvesFrom)}`);
    return terms.join(' ');
  }

  // Search for cards: the library on this computer first (instant, needs no internet, English), then the card services
  async searchCards(query, page = 1, filters = {}) {
    const text = String(query || '').trim();
    // text in the API's own syntax (name:pika* set.id:sv1) can only be answered by the API
    const library = this.language === 'en' && this.catalog && !text.includes(':') ? this.catalog.search(text, page, filters) : null;
    if (library && library.totalCount > 0) return library;

    const order = this.order();
    let failure = null;
    let empty = null; // an answer with no cards, kept in case the other service has none either
    for (const name of order) {
      if (name === 'tcgdex' && text.includes(':') && order.length > 1) continue;
      try {
        const result = name === 'tcgdex'
          ? await this.searchTcgdex(text, page, filters)
          : name === 'scrydex'
            ? await this.searchScrydex(text, page, filters)
            : this.localizeResult(await this.searchOnline(text, page, filters, { timeoutMs: order.length > 1 ? FALLBACK_TIMEOUT_MS : REQUEST_TIMEOUT_MS }));
        this.worked(name);
        // no cards on the first page: the other service may have them (a new set that one does not know yet)
        if (result.cards.length === 0 && page === 1 && order.length > 1) {
          empty = empty || result;
          continue;
        }
        return result;
      } catch (error) {
        this.failed(name);
        failure = failure || error;
      }
    }
    if (empty) return empty;
    // nothing in the library and no way to ask the web: say so, rather than fail
    if (library) return { ...library, offline: true };
    throw failure || new Error('No card service is switched on');
  }

  // Search TCGdex, with caching; the cards come out in the shape of the other service's, with pictures kept on this computer
  async searchTcgdex(text, page, filters) {
    const provider = `tcgdex:${this.language}`;
    const asked = `${text}\u0000${JSON.stringify(Object.entries(filters).sort())}`;
    const cached = await this.cache.getSearch(provider, asked, page);
    if (cached) return this.localizeResult(cached);
    // "source" tells the page where the answer came from (it says so in the status line and knows there may be more pages)
    const result = { ...(await this.tcgdex.search(text, page, filters, { attempts: 2 })), source: 'tcgdex' };
    await this.cache.setSearch(provider, asked, page, result);
    return this.localizeResult(result);
  }

  // Search Scrydex, with caching (the cache is for the account: another key may see other cards)
  async searchScrydex(text, page, filters) {
    const asked = `${text}\u0000${JSON.stringify(Object.entries(filters).sort())}`;
    const cached = await this.cache.getSearch('scrydex', asked, page);
    if (cached) return this.localizeResult(cached);
    const result = { ...(await this.scrydex.search(text, page, filters, { attempts: 2 })), source: 'scrydex' };
    await this.cache.setSearch('scrydex', asked, page, result);
    return this.localizeResult(result);
  }

  // Search the card API, with caching
  async searchOnline(query, page = 1, filters = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    // The cache is keyed on the full API query, so a search with filters never reuses one without
    const apiQuery = this.buildQuery(query, filters);

    // Check cache
    const cached = await this.cache.getSearch(this.currentProvider, apiQuery, page);
    if (cached) {
      return this.applyFilters(cached, filters);
    }

    // Fetch from API
    const provider = this.providers[this.currentProvider];
    const url = `${provider.baseUrl}/cards?q=${encodeURIComponent(apiQuery)}&page=${page}&pageSize=20`;

    const headers = { 'User-Agent': 'obs-tcg-overlay/1.0' };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    // ETag support
    const etag = this.cache.getETag(url);
    if (etag) headers['If-None-Match'] = etag;

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

      if (response.status === 304) {
        // Not modified, return cached
        const cached = await this.cache.getSearch(this.currentProvider, apiQuery, page);
        return cached || { cards: [], totalCount: 0, page, pageSize: 20 };
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const result = this.parseSearchResponse(data);

      // Cache result
      await this.cache.setSearch(this.currentProvider, apiQuery, page, result);

      // Save ETag
      const newEtag = response.headers.get('ETag');
      if (newEtag) this.cache.setETag(url, newEtag);

      return this.applyFilters(result, filters);
    } catch (error) {
      console.error('Search error:', error);
      // Return cached if available
      const cached = await this.cache.getSearch(this.currentProvider, apiQuery, page);
      if (cached) return this.applyFilters(cached, filters);
      throw error;
    }
  }

  // One card by id: from the library on this computer when it is there, otherwise from a card service. `hint` says which
  // service the card came from ({ source: 'tcgdex', language: 'es' }): the ids of the two do not always agree.
  async getCard(cardId, hint = {}) {
    const local = this.catalog && this.catalog.get(cardId);
    if (local && local.attacks !== undefined) return local;
    // A library saved before attacks and retreat costs were kept has none: ask the card service for them
    const order = ['tcgdex', 'scrydex', 'pokemontcg'].includes(hint.source) ? [hint.source] : this.order();
    let online = null;
    let failure = null;
    for (const name of order) {
      try {
        online = name === 'tcgdex' ? await this.fetchTcgdexCard(cardId, hint.language)
          : name === 'scrydex' ? await this.fetchScrydexCard(cardId)
            : this.localize(await this.fetchCard(cardId));
        if (online) {
          this.worked(name);
          break;
        }
      } catch (error) {
        failure = failure || error;
        // a card the service does not have says nothing about whether the service is up
        if (!/\b404\b/.test(error.message)) this.failed(name);
      }
    }
    if (online) return local ? { ...local, attacks: online.attacks, retreat: online.retreat } : online;
    if (local) return { ...local, attacks: [], retreat: 0 }; // no way to ask: the card is still usable, by hand
    if (failure) throw failure;
    return null;
  }

  // A card of Scrydex, with caching
  async fetchScrydexCard(cardId) {
    const key = `scrydex:${cardId}`;
    const cached = await this.cache.getCard(key);
    if (cached) return this.localize(cached);
    const card = await this.scrydex.getCard(cardId, { attempts: 2 });
    if (!card) return null;
    await this.cache.setCard(key, 'scrydex', card);
    return this.localize(card);
  }

  // A card of TCGdex in the language it was found in, with caching
  async fetchTcgdexCard(cardId, language) {
    const client = this.tcgdex.withLanguage(language || this.language);
    const key = `tcgdex:${client.language}:${cardId}`;
    const cached = await this.cache.getCard(key);
    if (cached) return this.localize(cached);
    const card = await client.getCard(cardId, { attempts: 2 });
    if (!card) return null;
    await this.cache.setCard(key, 'tcgdex', card);
    return this.localize(card);
  }

  async fetchCard(cardId) {
    // Check cache
    const cached = await this.cache.getCard(cardId);
    if (cached) return cached;

    const provider = this.providers[this.currentProvider];
    const url = `${provider.baseUrl}/cards/${cardId}`;
    const headers = { 'User-Agent': 'obs-tcg-overlay/1.0' };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    const etag = this.cache.getETag(url);
    if (etag) headers['If-None-Match'] = etag;

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

      if (response.status === 304) {
        const cached = await this.cache.getCard(cardId);
        return cached;
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      const card = this.parseCardResponse(data);

      await this.cache.setCard(cardId, this.currentProvider, card);

      const newEtag = response.headers.get('ETag');
      if (newEtag) this.cache.setETag(url, newEtag);

      return card;
    } catch (error) {
      console.error('Get card error:', error);
      const cached = await this.cache.getCard(cardId);
      if (cached) return cached;
      throw error;
    }
  }

  // Select best image URL (lowest rarity by default)
  selectBestImageUrl(card, size = 'large') {
    if (!card.images) return '';

    const sizeMap = {
      small: 'small',
      medium: 'medium',
      large: 'large',
      original: 'large' // Use large as fallback for original
    };

    const targetSize = sizeMap[size] || 'large';

    // If we have the exact size, use it
    if (card.images[targetSize]) return card.images[targetSize];

    // Fallback chain
    if (card.images.large) return card.images.large;
    if (card.images.medium) return card.images.medium;
    if (card.images.small) return card.images.small;

    return '';
  }

  // Get rarity order (lower = more common)
  getRarityOrder(rarity) {
    return RARITY_ORDER.indexOf(rarity) !== -1 ? RARITY_ORDER.indexOf(rarity) : RARITY_ORDER.length;
  }

  // Sort cards by rarity (common first)
  sortByRarity(cards) {
    return [...cards].sort((a, b) => {
      const orderA = this.getRarityOrder(a.rarity);
      const orderB = this.getRarityOrder(b.rarity);
      return orderA - orderB;
    });
  }

  parseSearchResponse(data) {
    const cards = (data.data || []).map(item => this.parseCardSummary(item));
    return {
      cards: this.sortByRarity(cards),
      totalCount: data.totalCount || 0,
      page: data.page || 1,
      pageSize: data.pageSize || 20
    };
  }

  parseCardResponse(data) {
    const item = data.data;
    if (!item) return null;

    return {
      ...this.parseCardSummary(item),
      supertype: item.supertype || '',
      subtypes: (item.subtypes || []).join(', '),
      rules: (item.rules || []).join('; '),
      artist: item.artist || '',
      flavorText: item.flavorText || '',
      regulationMark: item.regulationMark || '',
      attacks: attacksOf(item.attacks) || [],
      retreat: retreatOf(item),
      abilities: (item.abilities || []).map(a => a.name).filter(Boolean),
      evolvesFrom: item.evolvesFrom || ''
    };
  }

  parseCardSummary(item) {
    return {
      id: item.id || '',
      name: item.name || '',
      setName: item.set?.name || '',
      setId: item.set?.id || '',
      images: item.images || {},
      rarity: item.rarity || 'Unknown',
      types: (item.types || []).join(', '),
      hp: item.hp || '',
      number: item.number || '',
      supertype: item.supertype || '',
      subtypes: (item.subtypes || []).join(', ')
    };
  }

  applyFilters(result, filters) {
    let cards = result.cards;

    if (filters.rarity) {
      cards = cards.filter(c => c.rarity === filters.rarity);
    }
    if (filters.supertype) {
      cards = cards.filter(c => c.supertype === filters.supertype);
    }
    if (filters.subtype) {
      cards = cards.filter(c => c.subtypes?.includes(filters.subtype));
    }

    return { ...result, cards };
  }
}

module.exports = PokemonTCGService;