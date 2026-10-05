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
  // when its name does not. color is the chip's background and ink the text on it.
  const STATUS_CONDITIONS = [
    { key: 'asleep', label: 'Asleep', color: '#5c6bc0', ink: '#ffffff', turn: true },
    { key: 'burned', label: 'Burned', color: '#f4511e', ink: '#ffffff' },
    { key: 'confused', label: 'Confused', color: '#ec407a', ink: '#ffffff', turn: true },
    { key: 'paralyzed', label: 'Paralyzed', color: '#fdd835', ink: '#1d1402', turn: true },
    { key: 'poisoned', label: 'Poisoned', color: '#ab47bc', ink: '#ffffff' },
    { key: 'trapped', label: 'Trapped', hint: 'Can\'t retreat', color: '#78909c', ink: '#ffffff' }
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

  // How many prize cards a knocked-out Pokémon is usually worth
  const PRIZE_CHOICES = [1, 2, 3];

  return { ENERGY_TYPES, ENERGY_KEYS, STATUS_CONDITIONS, STATUS_KEYS, cleanStatus, PRIZE_CHOICES };
}));
