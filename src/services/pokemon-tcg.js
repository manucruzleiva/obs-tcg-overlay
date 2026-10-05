/**
 * Pokémon TCG API Service - Integration with pokemontcg.io and Scrydex
 */

const { localImageUrl } = require('./images');

// A card lookup must never hang the control panel when the network is slow or down
const REQUEST_TIMEOUT_MS = 8000;

const RARITY_ORDER = [
  'Common', 'Uncommon', 'Rare', 'Rare Holo',
  'Rare Ultra', 'Rare Secret', 'Promo', 'Unknown'
];

class PokemonTCGService {
  constructor(cache) {
    this.cache = cache;
    this.providers = {
      pokemontcg: {
        // POKEMONTCG_API_URL points the app at another server (the tests use a local mock)
        baseUrl: process.env.POKEMONTCG_API_URL || 'https://api.pokemontcg.io/v2',
        name: 'Pokémon TCG API'
      },
      scrydex: {
        baseUrl: 'https://api.scrydex.com/v1',
        name: 'Scrydex'
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

  setProvider(provider, apiKey = '') {
    if (this.providers[provider]) {
      this.currentProvider = provider;
      this.apiKey = apiKey;
    }
  }

  getProvider() {
    return this.currentProvider;
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

  // Search for cards: the library on this computer first (instant, and needs no internet), then the web
  async searchCards(query, page = 1, filters = {}) {
    const text = String(query || '').trim();
    // text in the API's own syntax (name:pika* set.id:sv1) can only be answered by the API
    const library = this.catalog && !text.includes(':') ? this.catalog.search(text, page, filters) : null;
    if (library && library.totalCount > 0) return library;

    try {
      return this.localizeResult(await this.searchOnline(text, page, filters));
    } catch (error) {
      // nothing in the library and no way to ask the web: say so, rather than fail
      if (library) return { ...library, offline: true };
      throw error;
    }
  }

  // Search the card API, with caching
  async searchOnline(query, page = 1, filters = {}) {
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
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

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

  // Get single card by ID: from the library on this computer when it is there, otherwise from the API
  async getCard(cardId) {
    const local = this.catalog && this.catalog.get(cardId);
    if (local) return local;
    return this.localize(await this.fetchCard(cardId));
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
      attacks: (item.attacks || []).map(a => a.name).filter(Boolean),
      abilities: (item.abilities || []).map(a => a.name).filter(Boolean)
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