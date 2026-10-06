/**
 * The decks that are played the most, as people call them, with the Pokémon of the icon each has: the suggestions for the name of a deck in the
 * control panel, and a picture for a deck whose name does not say which Pokémon it is ("Basic Box", "Festival Lead"). Loaded in the browser as
 * OTO_DECK_POPULAR and by the server and the tests (via require).
 *
 * The deck list of Limitless TCG (https://limitlesstcg.com/decks), read on 2026-10-06 (the 40 decks that were played the most, with their share of the results at that
 * time). Only the names, the share and which Pokémon is on the icon of each are kept: the pictures are the ones OTO already shows (the official artwork
 * from PokeAPI). `pokemon` holds Pokédex numbers (the first is the picture of the deck) and `icons` the names of the sprites on Limitless.
 * Written by src/services/limitless.js (`npm run update:decks`); the app can bring it up to date by itself (Settings, Cards).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_DECK_POPULAR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SOURCE = { name: "Limitless TCG", url: "https://limitlesstcg.com/decks", date: "2026-10-06" };
  const DECKS = [
    { name: "Dragapult ex", share: 33.43, pokemon: [887], icons: ["dragapult"] },
    { name: "N's Zoroark ex", share: 9.35, pokemon: [571], icons: ["zoroark"] },
    { name: "Basic Box", share: 7.83, pokemon: [1017, 35], icons: ["ogerpon","clefairy"] },
    { name: "Slowking Seek Inspiration", share: 7.79, pokemon: [199], icons: ["slowking"] },
    { name: "Festival Lead", share: 6.59, pokemon: [1011, 811], icons: ["dipplin","thwackey"] },
    { name: "Alakazam Powerful Hand", share: 6.44, pokemon: [65], icons: ["alakazam"] },
    { name: "Mega Lopunny ex", share: 3.96, pokemon: [428], icons: ["lopunny-mega"] },
    { name: "Hydrapple ex", share: 3.48, pokemon: [1019], icons: ["hydrapple"] },
    { name: "Mega Excadrill ex", share: 3.26, pokemon: [530], icons: ["excadrill-mega"] },
    { name: "Crustle Mysterious Rock Inn", share: 2.98, pokemon: [558], icons: ["crustle"] },
    { name: "Mega Lucario ex", share: 2.11, pokemon: [448], icons: ["lucario-mega"] },
    { name: "Rocket's Honchkrow", share: 1.85, pokemon: [430, 233], icons: ["honchkrow","porygon2"] },
    { name: "Dhelmise Hide n' Sneak", share: 1.85, pokemon: [781, 354], icons: ["dhelmise","banette"] },
    { name: "Cynthia's Garchomp ex", share: 1.59, pokemon: [445], icons: ["garchomp"] },
    { name: "Ogerpon Meganium", share: 0.96, pokemon: [1017, 154], icons: ["ogerpon","meganium"] },
    { name: "Mega Sharpedo ex", share: 0.94, pokemon: [319], icons: ["sharpedo-mega"] },
    { name: "Raging Bolt ex", share: 0.54, pokemon: [1021], icons: ["raging-bolt"] },
    { name: "Hop's Trevenant", share: 0.54, pokemon: [709], icons: ["trevenant"] },
    { name: "Mew Box Memory Helix", share: 0.52, pokemon: [151, 35], icons: ["mew","clefairy"] },
    { name: "Lillie's Clefairy ex", share: 0.48, pokemon: [35], icons: ["clefairy"] },
    { name: "Marnie's Grimmsnarl ex", share: 0.46, pokemon: [861], icons: ["grimmsnarl"] },
    { name: "Rocket's Mewtwo ex", share: 0.43, pokemon: [150, 918], icons: ["mewtwo","spidops"] },
    { name: "Ethan's Typhlosion", share: 0.26, pokemon: [157], icons: ["typhlosion"] },
    { name: "Toxtricity Sinister Surge", share: 0.26, pokemon: [849], icons: ["toxtricity"] },
    { name: "Greninja ex", share: 0.24, pokemon: [658], icons: ["greninja"] },
    { name: "Ceruledge ex", share: 0.24, pokemon: [937], icons: ["ceruledge"] },
    { name: "Beedrill ex", share: 0.2, pokemon: [15], icons: ["beedrill"] },
    { name: "Mega Absol Box", share: 0.19, pokemon: [359, 115], icons: ["absol-mega","kangaskhan-mega"] },
    { name: "Mega Starmie ex", share: 0.19, pokemon: [121], icons: ["starmie-mega"] },
    { name: "Tera Box", share: 0.15, pokemon: [164, 1017], icons: ["noctowl","ogerpon-wellspring"] },
    { name: "Mega Kangaskhan ex", share: 0.15, pokemon: [115], icons: ["kangaskhan-mega"] },
    { name: "Mega Greninja ex", share: 0.15, pokemon: [658], icons: ["greninja-mega"] },
    { name: "Mega Chandelure ex", share: 0.15, pokemon: [609], icons: ["chandelure-mega"] },
    { name: "Steven's Metagross ex", share: 0.11, pokemon: [376], icons: ["metagross"] },
    { name: "Okidogi Adrena-Power", share: 0.06, pokemon: [1014], icons: ["okidogi"] },
    { name: "Mega Venusaur ex", share: 0.06, pokemon: [3], icons: ["venusaur-mega"] },
    { name: "Metagross Metal Maker", share: 0.06, pokemon: [376], icons: ["metagross"] },
    { name: "Mega Darkrai ex", share: 0.06, pokemon: [491], icons: ["darkrai-mega"] },
    { name: "Toucannon Feather Rondo", share: 0.06, pokemon: [733], icons: ["toucannon"] },
    { name: "Cinccino ex", share: 0.06, pokemon: [573], icons: ["cinccino"] }
  ];

  // Compared without capitals, accents or punctuation: "N's Zoroark ex" is "nszoroarkex"
  const fold = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
