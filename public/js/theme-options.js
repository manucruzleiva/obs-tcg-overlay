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
    { key: 'energySymbols', label: 'Energy icons', help: 'A strip of 11 equal squares: Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon, Fairy, Colorless' },
    { key: 'statusSymbols', label: 'Status icons', help: 'A strip of 6 equal squares: Asleep, Burned, Confused, Paralyzed, Poisoned, Trapped' }
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

  // Which part of a card shows for the Active Pokémon, for the Pokémon on the bench, for the Stadium (see STADIUM_CROP_DEFAULT) and (as a
  // circle) for Special Energy. The numbers are fractions of the card picture: x and y are the top left corner, w and h the width and height.
  // Unless a design says otherwise the Pokémon show just the picture of the card, the part where the artwork is.
  const CROP_DEFAULT = { x: 0.07, y: 0.115, w: 0.86, h: 0.385 };
  const CROP_PRESETS = [
    { key: 'full', label: 'Full card', help: 'The whole card', rect: { x: 0, y: 0, w: 1, h: 1 } },
    { key: 'art', label: 'Art only', help: 'Just the picture of the Pokémon (the usual)', rect: { ...CROP_DEFAULT } },
    { key: 'top', label: 'Name and art', help: 'The name, HP and the picture', rect: { x: 0.02, y: 0.02, w: 0.96, h: 0.48 } }
  ];
  const CROP_MIN_SIZE = 0.05;

  // The picture window of a Stadium card. A Trainer card has its title row above the picture, so the window starts lower than a
  // Pokémon's (measured on Stadium cards of the Scarlet & Violet and Sword & Shield sets). Unless a design says otherwise the Stadium
  // shows just this, with its name below.
  const STADIUM_CROP_DEFAULT = { x: 0.082, y: 0.145, w: 0.836, h: 0.37 };
  const STADIUM_PRESETS = [
    { key: 'full', label: 'Full card', help: 'The whole card', rect: { x: 0, y: 0, w: 1, h: 1 } },
    { key: 'art', label: 'Art only', help: 'Just the picture of the Stadium (the usual)', rect: { ...STADIUM_CROP_DEFAULT } },
    { key: 'top', label: 'Name and art', help: 'The name and the picture', rect: { x: 0.03, y: 0.065, w: 0.94, h: 0.455 } }
  ];

  // The overlay draws a card 300 x 418 (the shape of a real card): the height is this many times the width
  const CARD_ASPECT = 418 / 300;

  // A Special Energy card on a Pokémon shows as a circle cut out of the card. This is the usual circle, in the
  // middle of the picture window, as a part of the card like the other crops (so its width and height are the
  // same number of pixels).
  const ENERGY_CIRCLE = { x: 0.232, y: 0.115, w: 0.536, h: 0.385 };

  // A Pokémon's tile is the picture of its card with the HP bar, the energy attached, the retreat cost and the status icons on it.
  // Each part can go on the picture (at the top or the bottom, or in a corner) or below it. These are the usual places.
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const TILE_PARTS = [
    { key: 'hp', label: 'HP bar', places: ['top', 'bottom', 'below'] },
    { key: 'energy', label: 'Attached energy', places: [...CORNERS, 'below'] },
    { key: 'retreat', label: 'Retreat cost', places: [...CORNERS, 'below'] },
    { key: 'status', label: 'Status icons', places: [...CORNERS, 'below'] }
  ];
  const TILE_PLACES = {
    top: 'On the picture, at the top',
    bottom: 'On the picture, at the bottom',
    'top-left': 'On the picture, top left',
    'top-right': 'On the picture, top right',
    'bottom-left': 'On the picture, bottom left',
    'bottom-right': 'On the picture, bottom right',
    below: 'Below the picture'
  };
  const TILE_DEFAULT = { hp: 'top', energy: 'bottom-left', retreat: 'bottom-right', status: 'top-right' };

  // The picture on the prize cards (they stay cards: grayed out when taken). "current" is how they look when a design says nothing: its own
  // prize card back or card back picture, or the built-in one. The others are a card back or a ball, from a file in the assets folder
  // (assets/cardbacks/<key>.png, .jpg or .webp: the `picture` ones) or, when there is no file, a plain drawing.
  const PRIZE_STYLES = [
    { key: 'current', label: 'The current card back', help: "The design's own prize card back (or card back), or the built-in one" },
    { key: 'english', label: 'English Pokémon card back', help: 'assets/cardbacks/english (a PNG, JPG or WebP)', picture: true },
    { key: 'japanese', label: 'Japanese Pokémon card back', help: 'assets/cardbacks/japanese (a PNG, JPG or WebP)', picture: true },
    { key: 'pokeball', label: 'A Poké Ball', help: 'assets/cardbacks/pokeball (a PNG, JPG or WebP)', picture: true }
  ];
  // The kinds of picture a card back can be, in the order they are looked for
  const PRIZE_PICTURE_TYPES = ['png', 'webp', 'jpg', 'jpeg'];

  return {
    COLORS,
    IMAGES,
    PRIZE_STYLES,
    PRIZE_PICTURE_TYPES,
    PRIZE_KEYS: PRIZE_STYLES.map((style) => style.key),
    PRIZE_DEFAULT: 'current',
    COLOR_KEYS: COLORS.map((color) => color.key),
    IMAGE_KEYS: IMAGES.map((image) => image.key),
    BLOCKS,
    BLOCK_KEYS: BLOCKS.map((block) => block.key),
    LAYOUT_LIMITS,
    CROP_DEFAULT,
    CROP_PRESETS,
    CROP_MIN_SIZE,
    STADIUM_CROP_DEFAULT,
    STADIUM_PRESETS,
    CARD_ASPECT,
    ENERGY_CIRCLE,
    CROP_KEYS: ['active', 'bench', 'stadium', 'energy'],
    TILE_KEYS: ['active', 'bench'],
    TILE_PARTS,
    TILE_PLACES,
    TILE_DEFAULT
  };
}));
