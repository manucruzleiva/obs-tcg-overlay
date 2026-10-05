/**
 * A made-up match for the design editor to draw, so every piece of the overlay has something in it:
 * names, Pokémon with HP and energy, locks, a stadium, feature cards and a penalty. The card pictures
 * are drawn on the spot (nothing is fetched, and nothing is anyone's artwork). They follow the layout of
 * a real card, so the crop selector shows what a crop does to a real one.
 */

// Where the picture window is on a card, as fractions of the card (the "Art only" crop is this)
export const ART_WINDOW = { x: 0.07, y: 0.115, w: 0.86, h: 0.385 };

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// A card picture as a data: address, 300 x 418 like the real ones
export function cardArt(name, hue, kind = 'Basic') {
  const w = 300;
  const h = 418;
  const art = { x: ART_WINDOW.x * w, y: ART_WINDOW.y * h, w: ART_WINDOW.w * w, h: ART_WINDOW.h * h };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 30) % 360},65%,38%)"/></linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${(hue + 160) % 360},70%,70%)"/><stop offset="1" stop-color="hsl(${(hue + 190) % 360},60%,38%)"/></linearGradient>
  </defs>
  <rect width="${w}" height="${h}" rx="16" fill="url(#frame)"/>
  <rect x="8" y="8" width="${w - 16}" height="${h - 16}" rx="12" fill="hsl(${hue},45%,86%)"/>
  <text x="20" y="34" font-family="Arial, sans-serif" font-weight="700" font-size="22" fill="#222">${escape(name)}</text>
  <text x="${w - 20}" y="34" font-family="Arial, sans-serif" font-weight="700" font-size="18" fill="#222" text-anchor="end">HP</text>
  <text x="20" y="20" font-family="Arial, sans-serif" font-size="9" fill="#444">${escape(kind)}</text>
  <rect x="${art.x}" y="${art.y}" width="${art.w}" height="${art.h}" fill="url(#sky)"/>
  <circle cx="${art.x + art.w * 0.5}" cy="${art.y + art.h * 0.55}" r="${art.h * 0.3}" fill="hsl(${hue},85%,58%)" stroke="#fff" stroke-width="3"/>
  <circle cx="${art.x + art.w * 0.42}" cy="${art.y + art.h * 0.5}" r="${art.h * 0.045}" fill="#222"/>
  <circle cx="${art.x + art.w * 0.58}" cy="${art.y + art.h * 0.5}" r="${art.h * 0.045}" fill="#222"/>
  <path d="M${art.x + art.w * 0.43} ${art.y + art.h * 0.68} Q${art.x + art.w * 0.5} ${art.y + art.h * 0.76} ${art.x + art.w * 0.57} ${art.y + art.h * 0.68}" stroke="#222" stroke-width="3" fill="none" stroke-linecap="round"/>
  <rect x="${art.x}" y="${art.y + art.h + 2}" width="${art.w}" height="10" fill="hsl(${hue},40%,70%)"/>
  <text x="26" y="262" font-family="Arial, sans-serif" font-weight="700" font-size="17" fill="#222">Attack</text>
  <text x="${w - 26}" y="262" font-family="Arial, sans-serif" font-weight="700" font-size="17" fill="#222" text-anchor="end">60</text>
  <rect x="26" y="274" width="${w - 52}" height="2" fill="#0003"/>
  <text x="26" y="302" font-family="Arial, sans-serif" font-weight="700" font-size="17" fill="#222">Big attack</text>
  <text x="${w - 26}" y="302" font-family="Arial, sans-serif" font-weight="700" font-size="17" fill="#222" text-anchor="end">120</text>
  <rect x="26" y="314" width="${w - 52}" height="2" fill="#0003"/>
  <rect x="26" y="${h - 62}" width="${w - 52}" height="22" rx="6" fill="#0002"/>
  <text x="26" y="${h - 22}" font-family="Arial, sans-serif" font-size="10" fill="#333">weakness · resistance · retreat</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// A Special Energy card, drawn like the other sample cards
export const specialEnergyArt = (name = 'Double Turbo Energy', hue = 210) => cardArt(name, hue, 'Special Energy');
const special = (name, hue) => ({ cardId: `sample-${name}`, name, image: specialEnergyArt(name, hue) });

const mon = (slot, name, hue, hp, max, extra = {}) => ({
  slot, cardId: `sample-${slot}-${name}`, name, image: cardArt(name, hue), hp: { current: hp, max }, energies: [], specialEnergies: [], tools: [], status: [], abilities: [], ...extra
});

// The live game's own shape (so nothing is missing) filled with a made-up match
export function sampleState(base) {
  const state = structuredClone(base);
  const DISPLAY = window.OTO_DISPLAY;

  // everything on, so every piece can be placed; the editor draws the stage at its real size
  state.settings.display = Object.fromEntries(DISPLAY.KEYS.map((key) => [key, true]));
  state.settings.autoScale = false;
  state.settings.overlayOpacity = 100;
  state.settings.showPenaltyAnimation = false;

  const a = state.trainerA;
  Object.assign(a, { name: 'Ash', nationality: 'USA', record: { wins: 3, losses: 1, ties: 0 }, isTurn: true });
  a.prizes = { count: 4, hidden: false, penalty: 1 };
  a.resources.energyPerTurn.used = 1;
  a.locks = { itemLock: true, evoLock: false };
  a.benchSize = 5;
  a.active = mon(-1, 'Pikachu ex', 50, 120, 200, {
    energies: ['lightning', 'lightning', 'colorless'],
    specialEnergies: [special('Double Turbo Energy', 210), special('Jet Energy', 190)],
    abilities: [{ name: 'Static', used: false, scope: 'turn' }, { name: 'Volt Switch', used: true, scope: 'turn' }]
  });
  a.bench = a.bench.map((slot, index) => (index === 0 ? mon(0, 'Eevee', 30, 60, 60, { energies: ['colorless'] })
    : index === 1 ? mon(1, 'Pichu', 55, 20, 40)
      : index === 2 ? mon(2, 'Raichu', 45, 90, 130, { energies: ['lightning', 'lightning'], specialEnergies: [special('Gift Energy', 330)] })
        : slot));

  const b = state.trainerB;
  Object.assign(b, { name: 'Gary', nationality: 'JPN', record: { wins: 2, losses: 2, ties: 1 }, isTurn: false });
  b.prizes = { count: 5, hidden: false, penalty: 0 };
  b.locks = { itemLock: false, evoLock: true };
  b.benchSize = 5;
  b.active = mon(-1, 'Charizard ex', 15, 80, 330, {
    energies: ['fire', 'fire', 'fire', 'fire'], status: ['burned'],
    abilities: [{ name: 'Infernal Reign', used: false, scope: 'game' }]
  });
  b.bench = b.bench.map((slot, index) => (index === 0 ? mon(0, 'Charmander', 12, 70, 70, { energies: ['fire'] })
    : index === 1 ? mon(1, 'Growlithe', 25, 60, 90) : slot));

  state.stadium = { cardId: 'sample-stadium', name: 'Area Zero', image: cardArt('Area Zero', 200, 'Stadium'), inPlay: true };
  state.featureCards = [
    { id: 'f1', cardId: 'sample-f1', name: 'Boss Orders', image: cardArt('Boss Orders', 280, 'Supporter'), note: 'Played this turn' },
    { id: 'f2', cardId: 'sample-f2', name: 'Ultra Ball', image: cardArt('Ultra Ball', 190, 'Item'), note: '' }
  ];
  state.matchScore = { trainerAWins: 1, trainerBWins: 0, bestOf: 3 };
  state.matchInfo = { round: 'Top 8' };
  return state;
}
