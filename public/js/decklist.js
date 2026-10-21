/**
 * The decklist of a trainer, as Pokémon TCG Live (and Limitless TCG, and most deck builders) export it: one line for each card, its count, its
 * name, the code of its set and its number ("4 Dragapult ex TWM 130"), under the headings "Pokémon: 17", "Trainer: 32" and "Energy: 11".
 * Read here into a list of cards, and the cards found in the card library on this computer (see pickCard: the name and the number, then the
 * set, then the name alone). Loaded in the browser as OTO_DECKLIST and by the server and the tests (via require).
 *
 * A line that cannot be read is skipped and said (`skipped`); a card that is not in the library stays in the list by its name, without a
 * picture, and the card picker looks it up by name when it is chosen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./game-data'));
  else root.OTO_DECKLIST = factory(root.OTO_GAME);
}(typeof self !== 'undefined' ? self : this, function (GAME) {
  const MAX_TEXT = 6000; // characters of a decklist that are kept (a deck of 60 different cards is about 2000)
  const MAX_LINES = 80; // different cards in a deck (a Gym Leader Challenge deck has 60 singles)
  const MAX_COUNT = 60; // copies of one card (basic Energy has no limit, a deck has 60 cards)
  const MAX_NAME = 80;

  const SECTIONS = ['Pokémon', 'Trainer', 'Energy'];
  // The energy symbols of Pokémon TCG Live ("Basic {R} Energy"), and what the cards are called in the card services
  const SYMBOLS = { G: 'grass', R: 'fire', W: 'water', L: 'lightning', P: 'psychic', F: 'fighting', D: 'darkness', M: 'metal', Y: 'fairy', N: 'dragon', C: 'colorless' };
  const ENERGY = Object.fromEntries(GAME.ENERGY_TYPES.map((type) => [type.key, type]));

  // The codes Pokémon TCG Live gives the sets, and the ids the card services give them (the Pokémon TCG API's, TCGdex's), so two cards
  // with the same name and number are told apart. A set that is not here is found by the name and the number all the same.
  const SET_IDS = {
    SVI: ['sv1', 'sv01'], PAL: ['sv2', 'sv02'], OBF: ['sv3', 'sv03'], MEW: ['sv3pt5', 'sv03.5'], PAR: ['sv4', 'sv04'], PAF: ['sv4pt5', 'sv04.5'],
    TEF: ['sv5', 'sv05'], TWM: ['sv6', 'sv06'], SFA: ['sv6pt5', 'sv06.5'], SCR: ['sv7', 'sv07'], SSP: ['sv8', 'sv08'], PRE: ['sv8pt5', 'sv08.5'],
    JTG: ['sv9', 'sv09'], DRI: ['sv10', 'sv10'], BLK: ['zsv10pt5', 'sv10.5b'], WHT: ['rsv10pt5', 'sv10.5w'], MEG: ['me1', 'me01'], PFL: ['me2', 'me02'],
    SVE: ['sve', 'sve'], SVP: ['svp', 'svp'], MEP: ['mep', 'mep'],
    BRS: ['swsh9', 'swsh9'], ASR: ['swsh10', 'swsh10'], PGO: ['pgo', 'swsh10.5'], LOR: ['swsh11', 'swsh11'], SIT: ['swsh12', 'swsh12'], CRZ: ['swsh12pt5', 'swsh12.5']
  };

  const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // A name as it is compared: without accents, case, punctuation or extra spaces ("Pokégear 3.0" is "pokegear 3 0")
  const nameKey = (text) => fold(text).replace(/[^a-z0-9]+/g, ' ').trim();

  // "Basic {R} Energy" and "Basic Fire Energy" are "Fire Energy", as the card services call them; the energy type of a basic Energy, or null
  function basicEnergyOf(name) {
    const symbol = /^(?:basic\s+)?\{([A-Z])\}\s+energy$/i.exec(name.trim());
    if (symbol) return SYMBOLS[symbol[1].toUpperCase()] || null;
    const words = /^(?:basic\s+)?([a-z]+)\s+energy$/i.exec(name.trim());
    if (!words) return null;
    const key = words[1].toLowerCase();
    return ENERGY[key] ? key : null;
  }
  const energyName = (key) => `${ENERGY[key].label} Energy`;

  const SECTION_LINE = /^(pok[eé]mon|trainers?|energy|energies)(?:\s+cards?)?\s*(?:[-:(]\s*\d*\s*\)?)?\s*$/i;
  const SKIP_LINE = /^(total cards|total)\b/i;
  // "4 Dragapult ex TWM 130" (or "4 Arven SVI 166", "1 Lillie's Clefairy ex JTG 56", "3 Pokégear 3.0 SVI 186", "2 Iono PAL 185a", "1 Mew ex SVP 53");
  // "* 4 ..." as the old Online game wrote it; "4x ..." as some builders do
  const CARD_LINE = /^(?:\*\s*)?(\d{1,2})x?\s+(.+?)(?:\s+([A-Z][A-Z0-9-]{1,5})\s+([A-Za-z]{0,4}\d{1,4}[a-z]?))?\s*$/;

  // The cards of a decklist: { cards: [{ count, name, set, number, section }], skipped: [lines not read] }
  function parse(text) {
    const cards = [];
    const skipped = [];
    let section = '';
    const lines = String(text || '').slice(0, MAX_TEXT).split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.replace(/\t/g, ' ').trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) {
        // "##Pokémon - 17" as the old Online game wrote the headings
        const heading = /^#+\s*(.+)$/.exec(line);
        if (heading && SECTION_LINE.test(heading[1].trim())) section = sectionOf(heading[1]);
        continue;
      }
      if (SKIP_LINE.test(line)) continue;
      if (SECTION_LINE.test(line)) { section = sectionOf(line); continue; }
      const match = CARD_LINE.exec(line);
      if (!match) { skipped.push(line.slice(0, MAX_NAME)); continue; }
      const count = Math.min(MAX_COUNT, parseInt(match[1], 10));
      let name = match[2].trim().slice(0, MAX_NAME);
      const energy = basicEnergyOf(name);
      if (energy) name = energyName(energy);
      if (!count || !name) { skipped.push(line.slice(0, MAX_NAME)); continue; }
      if (cards.length >= MAX_LINES) { skipped.push(line.slice(0, MAX_NAME)); continue; }
      cards.push({ count, name, set: match[3] || '', number: match[4] || '', section: energy ? 'Energy' : section });
    }
    return { cards, skipped };
  }

  function sectionOf(line) {
    const word = fold(line);
    return word.startsWith('pok') ? 'Pokémon' : word.startsWith('trainer') ? 'Trainer' : 'Energy';
  }

  // Of the cards of the library that have the name of a line of the decklist (`candidates`, newest first), the one it is: the same number in the
  // same set, then the same number, then (a basic Energy, or a card the library has in another set only) the newest. Null when there is none.
  function pickCard(entry, candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (list.length === 0) return null;
    const number = String(entry.number || '').toLowerCase().replace(/^0+(?=\d)/, '');
    const sameNumber = (card) => number && String(card.number || '').toLowerCase().replace(/^0+(?=\d)/, '') === number;
    const ids = SET_IDS[String(entry.set || '').toUpperCase()] || [];
    const sameSet = (card) => ids.includes(String(card.setId || '').toLowerCase());
    return list.find((card) => sameNumber(card) && sameSet(card)) || list.find(sameNumber) || list.find(sameSet) || list[0];
  }

  // How many cards a list has in all
  const total = (cards) => (Array.isArray(cards) ? cards.reduce((sum, card) => sum + (Number(card.count) || 0), 0) : 0);

  // Is a card one a kind of card picker asks for ("Pokémon", "Stadium", "Pokémon Tool", "Special Energy")? A card the library did not find says
  // only its section, so it is offered wherever its section fits.
  function fits(card, supertype, subtype) {
    if (!supertype) return true;
    const kind = card.supertype || card.section || '';
    if (nameKey(kind) !== nameKey(supertype)) return false;
    if (!subtype) return true;
    const subtypes = Array.isArray(card.subtypes) ? card.subtypes : [];
    return subtypes.length === 0 ? !card.cardId : subtypes.some((one) => nameKey(one) === nameKey(subtype));
  }

  return { MAX_TEXT, MAX_LINES, MAX_COUNT, SECTIONS, SET_IDS, parse, pickCard, basicEnergyOf, nameKey, total, fits };
}));
