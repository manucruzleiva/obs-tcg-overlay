/**
 * The cards producers use most, so the card picker has something to show before anything is typed.
 *
 * Every card picked in the picker is counted. When the search box is empty the picker lists the cards with a star first,
 * then the most used ones and, after them, the cards already saved on this computer by earlier lookups and searches (the
 * lookup cache), so it is not empty on the first day either. All of it is local: nothing here asks the internet.
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

  // Remember how a card looks without counting a use of it: a card with a star is listed from this later
  remember(card) {
    const summary = summaryOf(card);
    if (!summary) return false;
    this.db.rememberCard(summary.id, summary);
    return true;
  }

  // The cards the lookup cache holds, as the picker shows them (a card once; none that cannot be read)
  saved() {
    const found = [];
    const seen = new Set();
    for (const raw of this.db.cachedCards()) {
      let card = null;
      try { card = summaryOf(this.localize(raw)); } catch { /* an entry that cannot be read is no card */ }
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      found.push(card);
    }
    return found;
  }

  // One page of cards to start from: { cards, totalCount, page, pageSize, source, favorites, used, saved }.
  // The cards with a star come first (`favorites` are their ids, the latest star first), then the most used, then the ones
  // saved by earlier lookups. `source` says what the list is made of: 'used' (the person's own cards: stars and uses),
  // 'mixed' (those, then saved lookups) or 'cache' (saved lookups alone).
  popular({ supertype = '', subtype = '', page = 1, favorites = [] } = {}) {
    const wanted = { supertype, subtype };
    const known = this.db.usedCards()
      .map((entry) => ({ card: summaryOf(entry.card), uses: entry.uses }))
      .filter((entry) => entry.card);
    const byId = new Map(known.map((entry) => [entry.card.id, entry.card]));

    // the latest star first; a star for a card this computer has no picture of is looked for among the saved lookups
    const starred = [];
    const seen = new Set();
    let savedById = null;
    for (const id of [...(Array.isArray(favorites) ? favorites : [])].reverse()) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      let card = byId.get(id);
      if (!card) {
        savedById = savedById || new Map(this.saved().map((entry) => [entry.id, entry]));
        card = savedById.get(id);
      }
      if (card && matches(card, wanted)) starred.push(card);
    }

    const used = known.filter((entry) => entry.uses > 0 && !seen.has(entry.card.id) && matches(entry.card, wanted)).map((entry) => entry.card);
    for (const card of used) seen.add(card.id);

    const saved = [];
    for (const card of this.saved()) {
      if (seen.has(card.id) || !matches(card, wanted)) continue;
      seen.add(card.id);
      saved.push(card);
      if (saved.length >= MAX_FROM_CACHE) break;
    }

    const list = [...starred, ...used, ...saved];
    const start = (Math.max(1, page) - 1) * PAGE_SIZE;
    return {
      cards: list.slice(start, start + PAGE_SIZE),
      totalCount: list.length,
      page,
      pageSize: PAGE_SIZE,
      source: starred.length + used.length === 0 ? 'cache' : saved.length === 0 ? 'used' : 'mixed',
      favorites: starred.length,
      used: used.length,
      saved: saved.length
    };
  }

  // Forget what was used. The cards with a star (`keep`) are still listed, as the stars say.
  clear(keep = []) {
    this.db.clearCardUsage((Array.isArray(keep) ? keep : []).filter((id) => typeof id === 'string'));
  }
}

module.exports = { CardUsage, summaryOf, PAGE_SIZE };
