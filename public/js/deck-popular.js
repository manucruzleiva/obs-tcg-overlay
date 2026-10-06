/**
 * The decks that are played the most, as people call them, with the Pokémon of the icon each has: the suggestions for the name of a deck in the
 * control panel, and a picture for a deck whose name does not say which Pokémon it is ("Basic Box", "Festival Lead"). Loaded in the browser as
 * OTO_DECK_POPULAR and by the server and the tests (via require).
 *
 * A snapshot of the deck list of Limitless TCG (https://limitlesstcg.com/decks), read on 2026-10-06 (the 40 archetypes that were played
 * the most, with their share of the results at that time). Only the names and which Pokémon is on the icon are kept: the pictures are the ones
 * OTO already shows (the official artwork from PokeAPI). `pokemon` holds Pokédex numbers; the first is the picture of the deck.
 * (To bring it up to date, read the list again and replace the lines below.)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_DECK_POPULAR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SOURCE = { name: 'Limitless TCG', url: 'https://limitlesstcg.com/decks', date: '2026-10-06' };
  const DECKS = [
    { name: "Dragapult ex", share: 33.43, pokemon: [887] },
    { name: "N's Zoroark ex", share: 9.35, pokemon: [571] },
    { name: "Basic Box", share: 7.83, pokemon: [1017, 35] },
    { name: "Slowking Seek Inspiration", share: 7.79, pokemon: [199] },
    { name: "Festival Lead", share: 6.59, pokemon: [1011, 811] },
    { name: "Alakazam Powerful Hand", share: 6.44, pokemon: [65] },
    { name: "Mega Lopunny ex", share: 3.96, pokemon: [428] },
    { name: "Hydrapple ex", share: 3.48, pokemon: [1019] },
    { name: "Mega Excadrill ex", share: 3.26, pokemon: [530] },
    { name: "Crustle Mysterious Rock Inn", share: 2.98, pokemon: [558] },
    { name: "Mega Lucario ex", share: 2.11, pokemon: [448] },
    { name: "Rocket's Honchkrow", share: 1.85, pokemon: [430, 233] },
    { name: "Dhelmise Hide n' Sneak", share: 1.85, pokemon: [781, 354] },
    { name: "Cynthia's Garchomp ex", share: 1.59, pokemon: [445] },
    { name: "Ogerpon Meganium", share: 0.96, pokemon: [1017, 154] },
    { name: "Mega Sharpedo ex", share: 0.94, pokemon: [319] },
    { name: "Raging Bolt ex", share: 0.54, pokemon: [1021] },
    { name: "Hop's Trevenant", share: 0.54, pokemon: [709] },
    { name: "Mew Box Memory Helix", share: 0.52, pokemon: [151, 35] },
    { name: "Lillie's Clefairy ex", share: 0.48, pokemon: [35] },
    { name: "Marnie's Grimmsnarl ex", share: 0.46, pokemon: [861] },
    { name: "Rocket's Mewtwo ex", share: 0.43, pokemon: [150, 918] },
    { name: "Ethan's Typhlosion", share: 0.26, pokemon: [157] },
    { name: "Toxtricity Sinister Surge", share: 0.26, pokemon: [849] },
    { name: "Greninja ex", share: 0.24, pokemon: [658] },
    { name: "Ceruledge ex", share: 0.24, pokemon: [937] },
    { name: "Beedrill ex", share: 0.2, pokemon: [15] },
    { name: "Mega Absol Box", share: 0.19, pokemon: [359, 115] },
    { name: "Mega Starmie ex", share: 0.19, pokemon: [121] },
    { name: "Tera Box", share: 0.15, pokemon: [164, 1017] },
    { name: "Mega Kangaskhan ex", share: 0.15, pokemon: [115] },
    { name: "Mega Greninja ex", share: 0.15, pokemon: [658] },
    { name: "Mega Chandelure ex", share: 0.15, pokemon: [609] },
    { name: "Steven's Metagross ex", share: 0.11, pokemon: [376] },
    { name: "Okidogi Adrena-Power", share: 0.06, pokemon: [1014] },
    { name: "Mega Venusaur ex", share: 0.06, pokemon: [3] },
    { name: "Metagross Metal Maker", share: 0.06, pokemon: [376] },
    { name: "Mega Darkrai ex", share: 0.06, pokemon: [491] },
    { name: "Toucannon Feather Rondo", share: 0.06, pokemon: [733] },
    { name: "Cinccino ex", share: 0.06, pokemon: [573] }
  ];

  // Compared without capitals, accents or punctuation: "N's Zoroark ex" is "nszoroarkex"
  const fold = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const BY_NAME = new Map(DECKS.map((deck) => [fold(deck.name), deck]));

  // The popular deck a text is called (however it is written), or null
  const find = (text) => (typeof text === 'string' ? BY_NAME.get(fold(text)) || null : null);

  return { SOURCE, DECKS, NAMES: DECKS.map((deck) => deck.name), find };
}));
