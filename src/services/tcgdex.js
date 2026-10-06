/**
 * TCGdex (https://tcgdex.dev): a free card database with no key, quick and rarely down, in many languages.
 * Used next to the Pokémon TCG API: either can answer a search, and when one is down the other does.
 *
 *   - English: one GraphQL request returns a whole page with everything the card picker shows.
 *   - Other languages: the REST list, which has the name, the number and a picture; the rest of a card
 *     (HP, abilities...) is fetched when one is chosen.
 *
 * Cards come out in the same shape as the other service's (see PokemonTCGService.parseCardSummary), with
 * `source: 'tcgdex'`. Pictures are https://assets.tcgdex.net/<language>/<series>/<set>/<number>/<quality>.webp;
 * the picture cache (images.js) keeps them on disk like the others.
 */

const { attacksOf, retreatOf } = require('./attacks');
const { CARD_LANGUAGES } = require('../../public/js/game-data');

const DEFAULT_BASE = 'https://api.tcgdex.net/v2';

// The languages offered in the settings: TCGdex code and the name shown
const LANGUAGES = CARD_LANGUAGES;
const LANGUAGE_CODES = LANGUAGES.map(([code]) => code);

const PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 8000;

// TCGdex's words for what a card is, in the words the rest of the app uses
const SUPERTYPE = { Pokemon: 'Pokémon', Trainer: 'Trainer', Energy: 'Energy' };
const SUPERTYPE_BACK = { Pokémon: 'Pokemon', Pokemon: 'Pokemon', Trainer: 'Trainer', Energy: 'Energy' };
const STAGE = { Stage1: 'Stage 1', Stage2: 'Stage 2' };
const TRAINER_TYPE = { Tool: 'Pokémon Tool' };
const TRAINER_TYPE_BACK = { 'Pokémon Tool': 'Tool', 'Pokemon Tool': 'Tool' };
const ENERGY_TYPE = { Normal: 'Basic', Special: 'Special' };
const ENERGY_TYPE_BACK = { Basic: 'Normal', Special: 'Special' };

// How common a card is, most common first, for putting the usual cards at the front of a page.
// TCGdex's rarity names are many (the Pocket game has its own): anything not known goes last.
const RARITY_RANK = [
  [/^(common|one diamond)$/i, 0], [/^(uncommon|two diamond)$/i, 1], [/^(rare|three diamond|classic collection)$/i, 2],
  [/^(rare holo|holo rare)$/i, 3],
  // the rarest first, since "special illustration rare" also says "illustration"
  [/secret|hyper|special illustration|crown|mega hyper|one star|two star|three star/i, 5],
  [/holo|ultra|double rare|illustration|four diamond|shiny|amazing|radiant|ace spec|legend|prime|promo/i, 4]
];
const rarityRank = (rarity) => {
  const found = RARITY_RANK.find(([pattern]) => pattern.test(rarity || ''));
  return found ? found[1] : RARITY_RANK.length;
};

// "Pokémon Catcher" is found by "pokemon catcher" too: TCGdex matches accents exactly, so both spellings are asked
function spellings(text) {
  const plain = /poke/i.test(text) && !/poké/i.test(text);
  return plain ? [text, text.replace(/poke/gi, (match) => `${match.slice(0, 3)}${match[3] === 'E' ? 'É' : 'é'}`)] : [text];
}

class TcgdexError extends Error {}

const imageUrl = (base, size) => (base ? `${base}/${size === 'small' ? 'low' : 'high'}.webp` : '');

class TcgdexClient {
  constructor({ baseUrl = process.env.OTO_TCGDEX_URL || DEFAULT_BASE, fetchImpl = fetch, language = 'en', timeoutMs = REQUEST_TIMEOUT_MS, retryDelayMs = Number(process.env.OTO_TCGDEX_RETRY_MS) || 600 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.language = LANGUAGE_CODES.includes(language) ? language : 'en';
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
  }

  setLanguage(language) {
    this.language = LANGUAGE_CODES.includes(language) ? language : 'en';
  }

  // The same service asked for another language (a card is looked up in the language it was found in)
  withLanguage(language) {
    if (language === this.language || !LANGUAGE_CODES.includes(language)) return this;
    return new TcgdexClient({ baseUrl: this.baseUrl, fetchImpl: this.fetch, language, timeoutMs: this.timeoutMs, retryDelayMs: this.retryDelayMs });
  }

  // ------------------------------------------------------------------------------------ requests

  // One request, tried again once when the service is busy. `attempts` is how many tries in all.
  async request(url, options = {}, attempts = 1) {
    let failure;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(this.timeoutMs), headers: { 'User-Agent': 'obs-tcg-overlay/1.0', ...(options.headers || {}) } });
        if (response.ok) return await response.json();
        if (response.status === 404) throw Object.assign(new TcgdexError('not found'), { status: 404 });
        failure = new TcgdexError(`the card service answered ${response.status}`);
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        if (error.status === 404) throw error;
        failure = error instanceof TcgdexError ? error : new TcgdexError(error.name === 'TimeoutError' ? 'the card service took too long to answer' : error.message);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
    }
    throw failure;
  }

  async graphql(query, variables, attempts) {
    const data = await this.request(`${this.baseUrl}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }, attempts);
    if (data && data.errors && data.errors.length) throw new TcgdexError(String(data.errors[0].message || 'the card service refused the question'));
    return data && data.data;
  }

  // ------------------------------------------------------------------------------------- searching

  // The filters of the app (supertype, subtype, rarity, set, evolvesFrom) as TCGdex's own
  filtersFor(filters = {}) {
    const out = {};
    if (filters.supertype) out.category = SUPERTYPE_BACK[filters.supertype] || filters.supertype;
    if (filters.subtype) {
      const subtype = filters.subtype;
      if (filters.supertype === 'Trainer' || (!filters.supertype && Object.keys(TRAINER_TYPE_BACK).concat(['Stadium', 'Supporter', 'Item']).includes(subtype))) out.trainerType = TRAINER_TYPE_BACK[subtype] || subtype;
      else if (filters.supertype === 'Energy') out.energyType = ENERGY_TYPE_BACK[subtype] || subtype;
      else if (/^Stage ?[12]$/.test(subtype)) out.stage = subtype.replace(/\s/g, '');
      else if (['Basic', 'VMAX', 'VSTAR', 'MEGA', 'BREAK', 'V-UNION', 'LEVEL-UP', 'RESTORED', 'Baby'].includes(subtype)) out.stage = subtype;
      else out.suffix = subtype;
    }
    if (filters.rarity) out.rarity = filters.rarity;
    if (filters.evolvesFrom) out.evolveFrom = filters.evolvesFrom;
    return out;
  }

  // A page of results: { cards, totalCount, page, pageSize, hasMore }. TCGdex does not say how many there are in
  // all, so the count is what has been seen, plus one when the page was full (there may be more).
  async search(text, page = 1, filters = {}, { attempts = 1 } = {}) {
    const wanted = this.filtersFor(filters);
    const names = text ? spellings(text) : [''];
    const rich = this.language === 'en' && !filters.set;
    const pages = await Promise.all(names.map((name) => (rich ? this.searchRich(name, page, wanted, attempts) : this.searchBrief(name, page, filters, wanted, attempts))));

    const seen = new Set();
    const cards = [];
    for (const card of pages.flat()) {
      if (!seen.has(card.id)) { seen.add(card.id); cards.push(card); }
    }
    // the usual cards first within the page, the way the other service's results are ordered
    cards.sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity));
    const full = pages.some((items) => items.length >= PAGE_SIZE);
    const before = (page - 1) * PAGE_SIZE;
    return { cards, totalCount: before + cards.length + (full ? 1 : 0), page, pageSize: PAGE_SIZE, hasMore: full };
  }

  // English: everything the picker shows, in one request
  async searchRich(name, page, wanted, attempts) {
    const query = `query($filters: CardsFilters, $pagination: Pagination) {
      cards(filters: $filters, pagination: $pagination) {
        id localId name image category rarity hp types stage suffix evolveFrom regulationMark trainerType energyType
        legal { standard expanded }
        set { id name releaseDate }
      }
    }`;
    const filters = { ...wanted };
    if (name) filters.name = name;
    const data = await this.graphql(query, { filters, pagination: { page, itemsPerPage: PAGE_SIZE } }, attempts);
    return ((data && data.cards) || []).map((item) => this.summary(item, 'en'));
  }

  // Other languages (and a search by set): the list TCGdex gives, which is the name, the number and a picture
  async searchBrief(name, page, filters, wanted, attempts) {
    const params = new URLSearchParams({ 'pagination:page': String(page), 'pagination:itemsPerPage': String(PAGE_SIZE) });
    if (name) params.set('name', name);
    for (const [key, value] of Object.entries(wanted)) params.set(key, value);
    if (filters.set) params.set('set.id', filters.set);
    const items = await this.request(`${this.baseUrl}/${this.language}/cards?${params}`, {}, attempts);
    return (Array.isArray(items) ? items : []).map((item) => this.summary(item, this.language));
  }

  // ---------------------------------------------------------------------------------- one card

  // A card with everything the overlay and the game take from it, or null when there is no such card
  async getCard(id, { attempts = 1 } = {}) {
    try {
      const item = await this.request(`${this.baseUrl}/${this.language}/cards/${encodeURIComponent(id)}`, {}, attempts);
      return item ? this.detail(item, this.language) : null;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  // ----------------------------------------------------------------------------------- the shapes

  subtypes(item) {
    return subtypesOf(item);
  }

  // As the card search shows a card (see PokemonTCGService.parseCardSummary)
  summary(item, language) {
    return cardSummary(item, language);
  }

  // As a single card is shown (see PokemonTCGService.parseCardResponse)
  detail(item, language) {
    return cardDetail(item, language);
  }

  // ------------------------------------------------------------------------------------ libraries

  // What it takes to ask for a page of cards for a card library (see catalog.js): the request, which the library sends itself
  // so it can wait, try again and be stopped. `filters` are TCGdex's own (a regulation mark, a category...).
  libraryRequest(filters, page, itemsPerPage) {
    const query = `query($filters: CardsFilters, $pagination: Pagination) {
      cards(filters: $filters, pagination: $pagination) {
        id localId name image category rarity hp types stage suffix evolveFrom regulationMark trainerType energyType effect retreat
        set { id name }
        attacks { name damage }
        abilities { name }
      }
    }`;
    return {
      url: `${this.baseUrl}/graphql`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'obs-tcg-overlay/1.0 (card library)' }, body: JSON.stringify({ query, variables: { filters, pagination: { page, itemsPerPage } } }) }
    };
  }

  // The request for the release date of every set (a card's own set says none), which orders a library newest first
  setsRequest() {
    return {
      url: `${this.baseUrl}/graphql`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'obs-tcg-overlay/1.0 (card library)' }, body: JSON.stringify({ query: '{ sets { id releaseDate } }' }) }
    };
  }
}

// What the picker shows of a card, and what the game takes from one, without a client to ask
function subtypesOf(item) {
  const list = [];
  if (item.category === 'Pokemon') {
    if (item.stage) list.push(STAGE[item.stage] || item.stage);
    if (item.suffix) list.push(item.suffix);
  } else if (item.category === 'Trainer' && item.trainerType) {
    list.push(TRAINER_TYPE[item.trainerType] || item.trainerType);
  } else if (item.category === 'Energy' && item.energyType) {
    list.push(ENERGY_TYPE[item.energyType] || item.energyType);
  }
  return list;
}

function cardSummary(item, language) {
  return {
    id: item.id || '',
    name: item.name || '',
    setName: (item.set && item.set.name) || '',
    setId: (item.set && item.set.id) || '',
    images: { small: imageUrl(item.image, 'small'), large: imageUrl(item.image, 'large') },
    rarity: item.rarity && item.rarity !== 'None' ? item.rarity : 'Unknown',
    types: (item.types || []).join(', '),
    hp: item.hp ? String(item.hp) : '',
    number: item.localId || '',
    supertype: SUPERTYPE[item.category] || '',
    subtypes: subtypesOf(item).join(', '),
    source: 'tcgdex',
    language
  };
}

function cardDetail(item, language) {
  return {
    ...cardSummary(item, language),
    rules: item.effect || '',
    artist: item.illustrator || '',
    flavorText: item.description || '',
    regulationMark: item.regulationMark || '',
    attacks: attacksOf(item.attacks) || [],
    retreat: retreatOf(item),
    abilities: (item.abilities || []).map((ability) => ability && ability.name).filter(Boolean)
  };
}

module.exports = { TcgdexClient, TcgdexError, LANGUAGES, LANGUAGE_CODES, PAGE_SIZE, spellings, rarityRank, cardSummary, cardDetail };
