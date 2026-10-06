/**
 * Reference data shared by the server, the control panel and the overlay.
 * Loaded by the browser (as OTO_GAME) and by the server (via require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_GAME = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // key is what is stored in the game state; icon is the picture of the type (see assets/energy);
  // color is the plain disc drawn instead if those pictures are not there
  const ENERGY_TYPES = [
    { key: 'grass', label: 'Grass', color: '#4caf50', icon: '/assets/energy/grass.png' },
    { key: 'fire', label: 'Fire', color: '#f4511e', icon: '/assets/energy/fire.png' },
    { key: 'water', label: 'Water', color: '#29b6f6', icon: '/assets/energy/water.png' },
    { key: 'lightning', label: 'Lightning', color: '#fdd835', icon: '/assets/energy/lightning.png' },
    { key: 'psychic', label: 'Psychic', color: '#ab47bc', icon: '/assets/energy/psychic.png' },
    { key: 'fighting', label: 'Fighting', color: '#a1672f', icon: '/assets/energy/fighting.png' },
    { key: 'darkness', label: 'Darkness', color: '#37474f', icon: '/assets/energy/darkness.png' },
    { key: 'metal', label: 'Metal', color: '#90a4ae', icon: '/assets/energy/metal.png' },
    { key: 'dragon', label: 'Dragon', color: '#c9a227', icon: '/assets/energy/dragon.png' },
    { key: 'fairy', label: 'Fairy', color: '#f48fb1', icon: '/assets/energy/fairy.png' },
    { key: 'colorless', label: 'Colorless', color: '#e0e0e0', icon: '/assets/energy/colorless.png' }
  ];

  const ENERGY_KEYS = ENERGY_TYPES.map((type) => type.key);

  // The statuses of the Active Pokémon: the special conditions of the game and "Trapped" (an effect that stops it
  // from retreating). In the game Asleep, Confused and Paralyzed are shown by turning the card, so a Pokémon has
  // only one of those (`turn: true`); the rest are markers and go with anything. `hint` says what a status means
  // when its name does not. color is the chip's background and ink the text on it; icon is the picture of it (see
  // assets/status) and glyph what is drawn on the colored disc when that picture is not there.
  const STATUS_CONDITIONS = [
    { key: 'asleep', label: 'Asleep', color: '#5c6bc0', ink: '#ffffff', turn: true, icon: '/assets/status/asleep.png', glyph: 'Zz' },
    { key: 'burned', label: 'Burned', color: '#f4511e', ink: '#ffffff', icon: '/assets/status/burned.png', glyph: 'B' },
    { key: 'confused', label: 'Confused', color: '#ec407a', ink: '#ffffff', turn: true, icon: '/assets/status/confused.png', glyph: '?' },
    { key: 'paralyzed', label: 'Paralyzed', color: '#fdd835', ink: '#1d1402', turn: true, icon: '/assets/status/paralysis.png', glyph: '!' },
    { key: 'poisoned', label: 'Poisoned', color: '#ab47bc', ink: '#ffffff', icon: '/assets/status/poison.png', glyph: 'P' },
    { key: 'trapped', label: 'Trapped', hint: 'Can\'t retreat', color: '#78909c', ink: '#ffffff', icon: '/assets/status/trapped.png', glyph: 'T' }
  ];

  const STATUS_KEYS = STATUS_CONDITIONS.map((condition) => condition.key);

  // A list of conditions as the game keeps it: known ones only, one of Asleep / Confused / Paralyzed at most (the
  // last of them in the list wins), in the order of STATUS_CONDITIONS so the overlay always shows them the same way
  function cleanStatus(list) {
    const wanted = new Set(Array.isArray(list) ? list.filter((key) => STATUS_KEYS.includes(key)) : []);
    const turned = STATUS_CONDITIONS.filter((condition) => condition.turn && wanted.has(condition.key));
    const keepTurned = Array.isArray(list) ? [...list].reverse().find((key) => turned.some((condition) => condition.key === key)) : undefined;
    return STATUS_CONDITIONS.filter((condition) => wanted.has(condition.key) && (!condition.turn || condition.key === keepTurned)).map((condition) => condition.key);
  }

  // The card services OTO can ask: what each one is, the credentials it takes (each is a setting that stays on the server and is
  // only ever shown masked) and the card libraries it can build (see catalog.js). Two of them work without a key.
  const CARD_SERVICES = [
    {
      key: 'pokemontcg', label: 'Pokémon TCG API', site: 'https://pokemontcg.io/', libraries: ['standard', 'glc', 'expanded'],
      note: 'English cards. It works without a key; a free key from pokemontcg.io/developer raises the request limit.',
      credentials: [{ setting: 'apiKey', label: 'API key', needed: false }]
    },
    {
      key: 'scrydex', label: 'Scrydex', site: 'https://scrydex.com/', libraries: ['standard'],
      note: 'English cards, the newest sets first. It needs an account: an API key and the ID of your team.',
      credentials: [{ setting: 'scrydexKey', label: 'API key', needed: true }, { setting: 'scrydexTeam', label: 'Team ID', needed: true }]
    },
    {
      key: 'tcgdex', label: 'TCGdex', site: 'https://tcgdex.dev/', libraries: ['standard'],
      note: 'Cards in many languages, and quick. Free, no key needed.',
      credentials: []
    }
  ];

  // Where cards are searched for. "Automatic" asks the Pokémon TCG API and, when it does not answer, TCGdex.
  const CARD_SOURCES = [
    { key: 'auto', label: 'Automatic', help: 'The Pokémon TCG API, and TCGdex when it does not answer' },
    ...CARD_SERVICES.map((service) => ({ key: service.key, label: `${service.label} only`, help: service.credentials.some((entry) => entry.needed) ? 'Needs your key' : service.note }))
  ];

  // The settings that are secrets: kept on the server, never sent to a page, left out of exports and packages
  const SECRET_SETTINGS = CARD_SERVICES.flatMap((service) => service.credentials.map((entry) => entry.setting));

  // A secret as it is shown: its first three characters, three stars, its last four. A short one shows less, since the ends
  // would be most of it.
  function maskSecret(value) {
    const text = typeof value === 'string' ? value : '';
    if (!text) return '';
    if (text.length >= 12) return `${text.slice(0, 3)}***${text.slice(-4)}`;
    if (text.length >= 8) return `${text.slice(0, 2)}***${text.slice(-2)}`;
    return '***';
  }

  // Something that can be a key: visible characters only and no spaces, so it can go in a header; or nothing, to remove it
  const isSecretValue = (value) => typeof value === 'string' && /^[\x21-\x7e]{0,200}$/.test(value);

  // The languages TCGdex has cards in: its code and the name shown
  const CARD_LANGUAGES = [
    ['en', 'English'], ['es', 'Español'], ['es-mx', 'Español (México)'], ['pt-br', 'Português (Brasil)'],
    ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['ja', '日本語']
  ];

  // How many prize cards a knocked-out Pokémon is usually worth
  const PRIZE_CHOICES = [1, 2, 3];

  return { ENERGY_TYPES, ENERGY_KEYS, STATUS_CONDITIONS, STATUS_KEYS, cleanStatus, CARD_SERVICES, CARD_SOURCES, SECRET_SETTINGS, maskSecret, isSecretValue, CARD_LANGUAGES, PRIZE_CHOICES };
}));
