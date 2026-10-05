/**
 * Reference data shared by the server, the control panel and the overlay.
 * Loaded by the browser (as OTO_GAME) and by the server (via require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_GAME = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // key is what is stored in the game state; color is the default tint for its icon
  const ENERGY_TYPES = [
    { key: 'grass', label: 'Grass', color: '#4caf50' },
    { key: 'fire', label: 'Fire', color: '#f4511e' },
    { key: 'water', label: 'Water', color: '#29b6f6' },
    { key: 'lightning', label: 'Lightning', color: '#fdd835' },
    { key: 'psychic', label: 'Psychic', color: '#ab47bc' },
    { key: 'fighting', label: 'Fighting', color: '#a1672f' },
    { key: 'darkness', label: 'Darkness', color: '#37474f' },
    { key: 'metal', label: 'Metal', color: '#90a4ae' },
    { key: 'dragon', label: 'Dragon', color: '#c9a227' },
    { key: 'fairy', label: 'Fairy', color: '#f48fb1' },
    { key: 'colorless', label: 'Colorless', color: '#e0e0e0' }
  ];

  const ENERGY_KEYS = ENERGY_TYPES.map((type) => type.key);

  // How many prize cards a knocked-out Pokémon is usually worth
  const PRIZE_CHOICES = [1, 2, 3];

  return { ENERGY_TYPES, ENERGY_KEYS, PRIZE_CHOICES };
}));
