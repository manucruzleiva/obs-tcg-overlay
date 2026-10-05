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

  // The pieces of the overlay a design can move and resize. `selector` finds them on the overlay's stage
  // (it may match several nodes, which then move together). Nested pieces compound: moving a trainer
  // moves what is in it, and each piece can still be moved on its own.
  const trainerBlocks = (side, letter) => [
    { key: `${side}`, label: `Trainer ${letter}: everything`, selector: `.trainer-${letter.toLowerCase()}` },
    { key: `${side}.prizes`, label: `Trainer ${letter}: prize cards`, selector: `.trainer-${letter.toLowerCase()} .prizes` },
    { key: `${side}.tokens`, label: `Trainer ${letter}: turn tokens`, selector: `.trainer-${letter.toLowerCase()} .tokens` },
    { key: `${side}.locks`, label: `Trainer ${letter}: locks`, selector: `.trainer-${letter.toLowerCase()} .locks` },
    { key: `${side}.active`, label: `Trainer ${letter}: Active Pokémon`, selector: `.trainer-${letter.toLowerCase()} .active` },
    { key: `${side}.bench`, label: `Trainer ${letter}: bench`, selector: `.trainer-${letter.toLowerCase()} .bench` }
  ];

  const BLOCKS = [
    { key: 'logo', label: 'Logo', selector: '.logo' },
    { key: 'scoreboard', label: 'Scoreboard', selector: '.scoreboard' },
    ...trainerBlocks('trainerA', 'A'),
    ...trainerBlocks('trainerB', 'B'),
    { key: 'features', label: 'Feature cards', selector: '.center .features' },
    { key: 'stadium', label: 'Stadium', selector: '.center .stadium' },
    { key: 'toasts', label: 'Announcement banners', selector: '.toasts .toast-slot' }
  ];

  // How far a block may be moved (in pixels of the 1920 x 1080 stage) and how much it may be scaled
  const LAYOUT_LIMITS = { offset: 1920, minScale: 0.2, maxScale: 4 };

  // Which part of a card shows for the Active Pokémon, for the Pokémon on the bench, and (as a circle) for Special Energy. The numbers are
  // fractions of the card picture: x and y are the top left corner, w and h the width and height.
  const CROP_PRESETS = [
    { key: 'full', label: 'Full card', help: 'The whole card, as before', rect: { x: 0, y: 0, w: 1, h: 1 } },
    { key: 'art', label: 'Art only', help: 'Just the picture of the Pokémon', rect: { x: 0.07, y: 0.115, w: 0.86, h: 0.385 } },
    { key: 'top', label: 'Name and art', help: 'The name, HP and the picture', rect: { x: 0.02, y: 0.02, w: 0.96, h: 0.48 } }
  ];
  const CROP_MIN_SIZE = 0.05;

  // The overlay draws a card 300 x 418 (the shape of a real card): the height is this many times the width
  const CARD_ASPECT = 418 / 300;

  // A Special Energy card on a Pokémon shows as a circle cut out of the card. This is the usual circle, in the
  // middle of the picture window, as a part of the card like the other crops (so its width and height are the
  // same number of pixels).
  const ENERGY_CIRCLE = { x: 0.232, y: 0.115, w: 0.536, h: 0.385 };

  return {
    COLORS,
    IMAGES,
    COLOR_KEYS: COLORS.map((color) => color.key),
    IMAGE_KEYS: IMAGES.map((image) => image.key),
    BLOCKS,
    BLOCK_KEYS: BLOCKS.map((block) => block.key),
    LAYOUT_LIMITS,
    CROP_PRESETS,
    CROP_MIN_SIZE,
    CARD_ASPECT,
    ENERGY_CIRCLE,
    CROP_KEYS: ['active', 'bench', 'energy']
  };
}));
