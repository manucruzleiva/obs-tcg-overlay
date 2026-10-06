/**
 * Catalogue of everything on the overlay that can be shown or hidden.
 *
 * One source of truth, loaded by the browser (as OTO_DISPLAY) and by the server (via require):
 * the server uses DEFAULTS as the starting settings, the control panel builds its
 * "Overlay visibility" switches from GROUPS, and the overlay maps each key to a CSS class.
 * Everything shows by default except the options marked `off: true`.
 * An option marked `style: true` is not a piece of the overlay but a way to draw one (the nationality as a flag, the bench in a row): "Show everything"
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
        { key: 'benchRow', label: 'Bench in a row under the Active Pokémon instead of stacked at the side', off: true, style: true },
        { key: 'pokemonNames', label: 'Pokémon names' },
        { key: 'hpBars', label: 'HP bars and numbers' },
        { key: 'attachments', label: 'Attached energy' },
        { key: 'toolCards', label: 'Pokémon Tools as pictures of their cards' },
        { key: 'toolNames', label: 'Pokémon Tools by name (text), as well as or instead of their cards', off: true, style: true },
        { key: 'retreatCost', label: 'Retreat cost' },
        { key: 'abilityTokens', label: 'Ability tokens (ready / used)' },
        { key: 'benchAttacks', label: 'Attacks of the benched Pokémon (name and damage)', off: true },
        { key: 'statusConditions', label: 'Status conditions' }
      ]
    },
    {
      id: 'table',
      label: 'Table',
      options: [
        { key: 'spaces', label: 'Frames of the reserved spaces (camera feeds and the like)' },
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

  // More overlays for one controller (a vertical one for a phone next to the usual wide one, say): each is an address of the overlay,
  // /overlay?screen=<id>, with a design of its own (or the one on air), its own switches (only what it says differently from the main overlay)
  // and whether it plays the sound effects (the main overlay does: two of them would play every sound twice).
  const SCREEN_LIMITS = { max: 3, nameLength: 24, idPattern: /^[a-z0-9-]{1,24}$/ };

  const KEYS = GROUPS.flatMap((group) => group.options.map((option) => option.key));

  // What is kept of a list of screens (from a save, or sent by a page): at most SCREEN_LIMITS.max, each { id, name, design, display, sound }
  function cleanScreens(list) {
    if (!Array.isArray(list)) return [];
    const screens = [];
    const seen = new Set();
    for (const raw of list) {
      if (screens.length >= SCREEN_LIMITS.max) break;
      if (!raw || typeof raw !== 'object') continue;
      const id = typeof raw.id === 'string' && SCREEN_LIMITS.idPattern.test(raw.id) ? raw.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const display = {};
      for (const [key, shown] of Object.entries(raw.display && typeof raw.display === 'object' ? raw.display : {})) {
        if (KEYS.includes(key) && typeof shown === 'boolean') display[key] = shown;
      }
      screens.push({
        id,
        name: (typeof raw.name === 'string' ? raw.name.trim() : '').slice(0, SCREEN_LIMITS.nameLength) || id,
        design: typeof raw.design === 'string' && raw.design.trim() ? raw.design.trim().slice(0, 40) : null,
        display,
        sound: raw.sound === true
      });
    }
    return screens;
  }

  // An id for a new screen from its name ("Vertical stream" is "vertical-stream"), that is not one of `taken`
  function screenId(name, taken = []) {
    const base = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'screen';
    let id = base;
    for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
    return id;
  }
  const STYLE_KEYS = GROUPS.flatMap((group) => group.options).filter((option) => option.style).map((option) => option.key);
  const DEFAULTS = Object.fromEntries(GROUPS.flatMap((group) => group.options).map((option) => [option.key, !option.off]));

  return { GROUPS, KEYS, STYLE_KEYS, DEFAULTS, SCREEN_LIMITS, cleanScreens, screenId };
}));
