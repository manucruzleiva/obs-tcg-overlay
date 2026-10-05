/**
 * What a theme can change: the colors and shapes (CSS variables) and the images.
 *
 * One source of truth for the server (which validates themes) and the control panel's theme editor.
 * Loaded in the browser as OTO_THEME.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_THEME = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const COLORS = [
    { key: '--accent', label: 'Highlight', group: 'Brand' },
    { key: '--accent-hover', label: 'Highlight (bright)', group: 'Brand' },
    { key: '--trainer-a', label: 'Trainer A color', group: 'Brand' },
    { key: '--trainer-b', label: 'Trainer B color', group: 'Brand' },
    { key: '--bg-panel', label: 'Panel background', group: 'Surfaces' },
    { key: '--bg-card', label: 'Card background', group: 'Surfaces' },
    { key: '--bg-primary', label: 'Page background', group: 'Surfaces' },
    { key: '--bg-secondary', label: 'Raised background', group: 'Surfaces' },
    { key: '--bg-tertiary', label: 'Input background', group: 'Surfaces' },
    { key: '--fg-primary', label: 'Text', group: 'Text' },
    { key: '--fg-secondary', label: 'Secondary text', group: 'Text' },
    { key: '--fg-muted', label: 'Muted text', group: 'Text' },
    { key: '--success', label: 'Good (healthy HP, ready)', group: 'Status' },
    { key: '--warning', label: 'Warning (low HP)', group: 'Status' },
    { key: '--danger', label: 'Danger (critical HP, KO)', group: 'Status' },
    { key: '--info', label: 'Info', group: 'Status' },
    { key: '--border', label: 'Borders', group: 'Shape' },
    { key: '--shadow', label: 'Shadows', group: 'Shape' },
    { key: '--radius', label: 'Corner roundness', group: 'Shape' },
    { key: '--radius-sm', label: 'Small corner roundness', group: 'Shape' },
    { key: '--transition', label: 'Animation speed', group: 'Shape' }
  ];

  const IMAGES = [
    { key: 'logoImage', label: 'Logo', help: 'Shown in the top left corner' },
    { key: 'backgroundImage', label: 'Background', help: 'Fills the whole overlay behind everything' },
    { key: 'trainerAAvatar', label: 'Trainer A avatar', help: 'Round picture next to the name' },
    { key: 'trainerBAvatar', label: 'Trainer B avatar', help: 'Round picture next to the name' },
    { key: 'prizeCardBack', label: 'Prize card back', help: 'The face-down prize cards' },
    { key: 'cardBackImage', label: 'Card back', help: 'Used for prize cards when there is no prize card back' },
    { key: 'energySymbols', label: 'Energy icons', help: 'A strip of 11 equal squares: Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon, Fairy, Colorless' }
  ];

  return {
    COLORS,
    IMAGES,
    COLOR_KEYS: COLORS.map((color) => color.key),
    IMAGE_KEYS: IMAGES.map((image) => image.key)
  };
}));
