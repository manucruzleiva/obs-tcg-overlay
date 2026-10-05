/**
 * Catalogue of the moments that can play a sound.
 *
 * One source of truth for the server (default settings and validation), the control panel (the
 * Sounds screen) and the overlay (which plays them). Loaded in the browser as OTO_SOUND.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTO_SOUND = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const GROUPS = [
    {
      id: 'pokemon',
      label: 'Pokémon',
      cues: [
        { key: 'deploy', label: 'Deploy a new Active Pokémon' },
        { key: 'bench', label: 'Put a Pokémon on the bench' },
        { key: 'damage', label: 'Damage' },
        { key: 'heal', label: 'Heal' },
        { key: 'ko', label: 'Knock out' }
      ]
    },
    {
      id: 'turn',
      label: 'Turn',
      cues: [
        { key: 'turn', label: 'Pass the turn' },
        { key: 'energy', label: 'Attach energy' },
        { key: 'ability', label: 'Ability used' },
        { key: 'stadium', label: 'Stadium played' },
        { key: 'supporter', label: 'Supporter used' }
      ]
    },
    {
      id: 'match',
      label: 'Match',
      cues: [
        { key: 'prize', label: 'Prize card taken' },
        { key: 'point', label: 'Game won (score goes up)' },
        { key: 'startgame', label: 'Game start' },
        { key: 'win', label: 'Victory' }
      ]
    },
    {
      id: 'hype',
      label: 'Hype',
      cues: [
        { key: 'attack', label: 'Attack' },
        { key: 'topdeck', label: 'Top Deck' }
      ]
    }
  ];

  const KEYS = GROUPS.flatMap((group) => group.cues.map((cue) => cue.key));

  // Silent until a producer switches sound on: a surprise noise on a live stream is worse than none
  const DEFAULTS = {
    enabled: false,
    volume: 70,
    events: Object.fromEntries(KEYS.map((key) => [key, { enabled: true, volume: 100 }]))
  };

  return { GROUPS, KEYS, DEFAULTS };
}));
