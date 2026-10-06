/**
 * Catalogue of everything on the overlay that can be shown or hidden.
 *
 * One source of truth, loaded by the browser (as OTO_DISPLAY) and by the server (via require):
 * the server uses DEFAULTS as the starting settings, the control panel builds its
 * "Overlay visibility" switches from GROUPS, and the overlay maps each key to a CSS class.
 * Everything shows by default except the options marked `off: true`.
 * An option marked `style: true` is not a piece of the overlay but a way to draw one (the nationality as a flag): "Show everything"
 * and "Minimal" leave it as it is, and the design editor draws it the way the live overlay does.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_DISPLAY = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const GROUPS = [
    {
      id: 'match',
      label: 'Scoreboard',
      options: [
        { key: 'scoreboard', label: 'Scoreboard bar' },
        { key: 'matchScore', label: 'Match score (games won)' },
        { key: 'bestOf', label: 'Best-of label' },
        { key: 'roundLabel', label: 'Round / stage label' },
        { key: 'turnIndicator', label: 'Turn highlight' }
      ]
    },
    {
      id: 'trainer',
      label: 'Trainers',
      options: [
        { key: 'trainerName', label: 'Names' },
        { key: 'nationality', label: 'Nationality' },
        { key: 'nationalityFlag', label: 'Nationality as a flag emoji instead of text (when it is a country)', off: true, style: true },
        { key: 'deckType', label: 'Deck or GLC type' },
        { key: 'deckIcon', label: 'Picture next to the deck (an energy icon, or the Pokémon)' },
        { key: 'record', label: 'Tournament record (W/L/T)' },
        { key: 'prizes', label: 'Prize cards' },
        { key: 'energyCounter', label: 'Energy attachment counter' },
        { key: 'stadiumCounter', label: 'Stadium play counter' },
        { key: 'supporterCounter', label: 'Supporter play counter' },
        { key: 'gxMarker', label: 'GX attack marker (once per game)', off: true },
        { key: 'vstarMarker', label: 'VSTAR Power marker (once per game)', off: true },
        { key: 'locks', label: 'Item / Evolution lock badges' }
      ]
    },
    {
      id: 'pokemon',
      label: 'Pokémon',
      options: [
        { key: 'activePokemon', label: 'Active Pokémon' },
        { key: 'benchPokemon', label: 'Bench' },
        { key: 'pokemonNames', label: 'Pokémon names' },
        { key: 'hpBars', label: 'HP bars and numbers' },
        { key: 'attachments', label: 'Attached energy and tools' },
        { key: 'retreatCost', label: 'Retreat cost' },
        { key: 'abilityTokens', label: 'Ability tokens (ready / used)' },
        { key: 'statusConditions', label: 'Status conditions' }
      ]
    },
    {
      id: 'table',
      label: 'Table',
      options: [
        { key: 'stadium', label: 'Stadium card' },
        { key: 'featureCards', label: 'Feature cards' }
      ]
    },
    {
      id: 'effects',
      label: 'Announcements',
      options: [
        { key: 'toasts', label: 'Toast banners' },
        { key: 'animations', label: 'Full-screen animations' }
      ]
    }
  ];

  const KEYS = GROUPS.flatMap((group) => group.options.map((option) => option.key));
  const STYLE_KEYS = GROUPS.flatMap((group) => group.options).filter((option) => option.style).map((option) => option.key);
  const DEFAULTS = Object.fromEntries(GROUPS.flatMap((group) => group.options).map((option) => [option.key, !option.off]));

  return { GROUPS, KEYS, STYLE_KEYS, DEFAULTS };
}));
