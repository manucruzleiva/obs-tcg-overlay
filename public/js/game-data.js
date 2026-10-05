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

  // How many prize cards a knocked-out Pokémon is usually worth
  const PRIZE_CHOICES = [1, 2, 3];

  return { ENERGY_TYPES, ENERGY_KEYS, PRIZE_CHOICES };
}));
