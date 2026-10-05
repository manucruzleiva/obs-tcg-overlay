/**
 * The cards producers use most, so the card picker has something to show before anything is typed.
 *
 * Every card picked in the picker is counted. When the search box is empty the picker lists the most used cards
 * first and, after them, the cards already saved on this computer by earlier lookups and searches (the lookup cache),
 * so it is not empty on the first day either. All of it is local: nothing here asks the internet.
 */

const PAGE_SIZE = 20;
const MAX_FROM_CACHE = 60;

const CARD_ID = /^[\w.-]{1,40}$/;
const SUPERTYPES = ['Pokémon', 'Trainer', 'Energy'];

const short = (value, max = 100) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '');
// a picture is one of ours (/img/...) or a secure web address; anything else is no picture
const picture = (value) => {
  const url = short(value, 300);
  return /^(\/(?!\/)|https:\/\/)/.test(url) ? url : '';
};

// A card as the picker shows it (see PokemonTCGService.parseCardSummary), or null when it is not a card
function summaryOf(card) {
  if (!card || typeof card !== 'object' || typeof card.id !== 'string' || !CARD_ID.test(card.id) || !short(card.name)) return null;
  const images = card.images && typeof card.images === 'object' ? card.images : {};
  const summary = {
    id: card.id,
    name: short(card.name),
    setName: short(card.setName),
    setId: short(card.setId, 40),
    images: { small: picture(images.small), large: picture(images.large) },
    rarity: short(card.rarity, 40) || 'Unknown',
    types: short(card.types, 60),
    hp: short(card.hp, 10),
    number: short(card.number, 20),
    supertype: SUPERTYPES.includes(card.supertype) ? card.supertype : '',
    subtypes: short(card.subtypes, 100)
  };
  // where it came from, so a card of another card service is asked of that one when it is chosen
  if (card.source === 'tcgdex') Object.assign(summary, { source: 'tcgdex', language: short(card.language, 10) });
  return summary;
}

// Does a card pass the filters of the picker ({ supertype, subtype })?
function matches(card, { supertype, subtype }) {
  if (supertype && card.supertype !== supertype) return false;
  if (subtype && !card.subtypes.split(',').map((part) => part.trim()).includes(subtype)) return false;
  return true;
}

class CardUsage {
  // `localize` turns the picture addresses of a card from the card API into ours (PokemonTCGService.localize)
  constructor({ db, localize = (card) => card }) {
    this.db = db;
    this.localize = localize;
  }

  // Count one use of a card. False when what was sent is not a card.
  record(card) {
    const summary = summaryOf(card);
    if (!summary) return false;
    this.db.recordCardUse(summary.id, summary);
    return true;
  }

  // One page of cards to start from: { cards, totalCount, page, pageSize, source, used }.
  // `source` says what the list is made of: 'used' (cards that were used), 'mixed' (those, then saved lookups) or 'cache'.
  popular({ supertype = '', subtype = '', page = 1 } = {}) {
    const wanted = { supertype, subtype };
    const used = this.db.usedCards()
      .map((entry) => summaryOf(entry.card))
      .filter((card) => card && matches(card, wanted));
    const seen = new Set(used.map((card) => card.id));

    const saved = [];
    for (const raw of this.db.cachedCards()) {
      let card = null;
      try { card = summaryOf(this.localize(raw)); } catch { /* an entry that cannot be read is no card */ }
      if (!card || seen.has(card.id) || !matches(card, wanted)) continue;
      seen.add(card.id);
      saved.push(card);
      if (saved.length >= MAX_FROM_CACHE) break;
    }

    const list = [...used, ...saved];
    const start = (Math.max(1, page) - 1) * PAGE_SIZE;
    return {
      cards: list.slice(start, start + PAGE_SIZE),
      totalCount: list.length,
      page,
      pageSize: PAGE_SIZE,
      source: used.length === 0 ? 'cache' : saved.length === 0 ? 'used' : 'mixed',
      used: used.length
    };
  }

  clear() {
    this.db.clearCardUsage();
  }
}

module.exports = { CardUsage, summaryOf, PAGE_SIZE };
