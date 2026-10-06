/**
 * The deck of a trainer, as the overlay shows it next to the name: a short text ("Charizard ex", "Lightning GLC", "Lost Zone Box") and a
 * picture when the text names one: a Pokémon (its official artwork) or an energy type (its icon). Loaded in the browser as OTO_DECK and by the
 * server and the tests (via require).
 *
 * The picture of a deck is, in this order:
 *   - nothing, when the picture box says "none";
 *   - what the picture box names, when something is written there (so a deck called "Control" can have Gardevoir next to it);
 *   - what the deck text names: one of the decks that are played the most ("Basic Box" has the Pokémon of its icon), or else the first
 *     Pokémon in it ("Team Rocket's Mewtwo ex", "Mega Lucario ex"), or else the first energy type ("Water Box").
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./game-data'), require('./pokedex'), require('./deck-popular'));
  else root.OTO_DECK = factory(root.OTO_GAME, root.OTO_POKEDEX, root.OTO_DECK_POPULAR);
}(typeof self !== 'undefined' ? self : this, function (GAME, POKEDEX, POPULAR) {
  const MAX_LENGTH = 40;
  const NO_PICTURE = 'none';

  // Other words for the energy types, as people say them
  const ALIASES = { electric: 'lightning', dark: 'darkness', steel: 'metal', normal: 'colorless' };
  const ENERGY = Object.fromEntries(GAME.ENERGY_TYPES.map((type) => [type.key, type]));

  const words = (text) => String(text).toLowerCase().split(/[^a-z]+/).filter(Boolean);

  // The first energy type a text names ("Water Box", "Electric", "Dark"), or null
  function energyOf(text) {
    for (const word of words(text)) {
      const type = ENERGY[word] || ENERGY[ALIASES[word]];
      if (type) return type;
    }
    return null;
  }

  // The address of the picture of a Pokémon (kept on this computer the first time it is shown, see src/services/images.js)
  const spriteUrl = (id) => `/img/sprite/${id}.png`;

  // What a text names: { kind: 'pokemon', id, name, src } or { kind: 'energy', key, name, src }, or null when it names nothing. A Pokémon is
  // preferred, as it says more about a deck than a type does ("Dark Gardevoir").
  function namedBy(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    // a deck that is known by its name ("Basic Box") has the Pokémon of its icon, whatever words are in the name
    const popular = POPULAR.find(text);
    const id = (popular && popular.pokemon[0]) || POKEDEX.idOf(text);
    if (id) return { kind: 'pokemon', id, name: POKEDEX.nameOf(id), src: spriteUrl(id) };
    const type = energyOf(text);
    return type ? { kind: 'energy', key: type.key, name: `${type.label} energy`, src: type.icon } : null;
  }

  // The picture next to a deck, from the deck text and the picture box (see above), or null for none
  function pictureFor(deck, picture) {
    const asked = typeof picture === 'string' ? picture.trim() : '';
    if (asked.toLowerCase() === NO_PICTURE) return null;
    return namedBy(asked || deck);
  }

  // What the control panel offers while someone types: the decks that are played the most, then the energy types and every Pokémon, written
  // for a person
  const popularNames = () => POPULAR.NAMES.slice();
  const energyNames = () => GAME.ENERGY_TYPES.map((type) => type.label);
  const pokemonNames = () => POKEDEX.NAMES.map((name, index) => POKEDEX.nameOf(index + 1));
  const suggestions = () => [...new Set([...popularNames(), ...energyNames(), ...pokemonNames()])];

  return { MAX_LENGTH, NO_PICTURE, ALIASES, namedBy, pictureFor, popularNames, energyNames, pokemonNames, suggestions, spriteUrl };
}));
