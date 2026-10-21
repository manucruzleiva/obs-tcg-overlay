/**
 * Draws the icons of the special conditions (assets/status/*.png) from the drawings below, with a Chrome or Edge (the one the UI tests use:
 * set BROWSER_PATH to choose another). Each icon is a disc in the color of its condition (the same as in public/js/game-data.js) with a white
 * rim and a shape of its own, so the six are told apart by their shape as well as their color, also at 20 pixels.
 *
 * Run with: node scripts/make-status-icons.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('../tests/ui/browser');

const SIZE = 128; // (they show at 18 to 30 pixels: twice the size and more, for screens that scale)
const OUT = path.join(__dirname, '..', 'assets', 'status');

// The shape on each disc, in a 64 × 64 box: white (dark on the yellow of Paralyzed), with a thin dark edge so it reads over the color
const SHAPES = {
  // a crescent moon and a small z
  asleep: `<path d="M37 14a19 19 0 1 0 13 30A15 15 0 1 1 37 14z"/><path d="M40 18h9l-9 10h9" fill="none" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" class="line"/>`,
  // a flame
  burned: `<path d="M33 9c2 8 12 12 12 25a13 13 0 0 1-26 0c0-7 4-11 7-14 0 5 2 8 5 9-2-8 0-14 2-20z"/><path d="M32 37c3 3 6 5 6 9a6 6 0 0 1-12 0c0-3 3-5 6-9z" class="inner"/>`,
  // a spiral
  confused: `<path d="M33 31a3 3 0 0 1 6 0a6 6 0 0 1-12 0a9 9 0 0 1 18 0a12 12 0 0 1-24 0a15 15 0 0 1 30 0" fill="none" stroke-width="4.2" stroke-linecap="round" class="line"/>`,
  // a lightning bolt
  paralyzed: `<path d="M36 8 18 36h12l-4 20 20-30H34l2-18z"/>`,
  // a drop with two bubbles
  poisoned: `<path d="M30 12c6 10 14 17 14 27a14 14 0 0 1-28 0c0-10 8-17 14-27z"/><circle cx="46" cy="16" r="4.5"/><circle cx="51" cy="27" r="2.8"/>`,
  // two links of a chain
  trapped: `<g fill="none" stroke-width="5.2" class="line"><rect x="11" y="24" width="24" height="15" rx="7.5" transform="rotate(-35 23 31.5)"/><rect x="29" y="25" width="24" height="15" rx="7.5" transform="rotate(-35 41 32.5)"/></g>`
};

const COLORS = { asleep: '#5c6bc0', burned: '#f4511e', confused: '#ec407a', paralyzed: '#fdd835', poisoned: '#ab47bc', trapped: '#78909c' };
// the files keep the names they have always had (a design or a maintainer may have replaced them)
const FILES = { asleep: 'asleep', burned: 'burned', confused: 'confused', paralyzed: 'paralysis', poisoned: 'poison', trapped: 'trapped' };

function svg(key) {
  const dark = key === 'paralyzed';
  const ink = dark ? '#2a1d00' : '#ffffff';
  const edge = dark ? 'rgba(255,255,255,0.55)' : 'rgba(10,14,40,0.55)';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="g" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.25"/></radialGradient>
  </defs>
  <circle cx="32" cy="32" r="30" fill="${COLORS[key]}"/>
  <circle cx="32" cy="32" r="30" fill="url(#g)"/>
  <circle cx="32" cy="32" r="29" fill="none" stroke="#ffffff" stroke-width="2.6"/>
  <g fill="${ink}" stroke="${edge}" stroke-width="1.2" stroke-linejoin="round">
    <style>.line { stroke: ${ink}; } .inner { fill: ${COLORS[key]}; stroke: none; }</style>
    ${SHAPES[key]}
  </g>
</svg>`;
}

async function main() {
  const browser = await launch();
  if (!browser) throw new Error('no Chrome or Edge found (set BROWSER_PATH)');
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  for (const key of Object.keys(SHAPES)) {
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(key)}`);
    const file = path.join(OUT, `${FILES[key]}.png`);
    fs.writeFileSync(file, await page.locator('svg').screenshot({ omitBackground: true }));
    console.log(file);
  }
  await browser.close();
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });

module.exports = { svg, SHAPES };
