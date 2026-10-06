/**
 * Finds a Chrome or Edge to drive, and sets up pages the way the tests need them.
 * The UI tests skip themselves when no browser is installed.
 */

const fs = require('node:fs');
const { chromium } = require('playwright-core');

const CANDIDATES = [
  process.env.BROWSER_PATH,
  // Windows
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge'
].filter(Boolean);

function findBrowser() {
  return CANDIDATES.find((path) => fs.existsSync(path)) || null;
}

async function launch() {
  const executablePath = findBrowser();
  if (!executablePath) return null;
  return chromium.launch({
    executablePath,
    headless: true,
    // like OBS, let the overlay play sound without anyone clicking first
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox']
  });
}

// Card art made on the spot, so no test needs the network
function cardArt(name, hue = 200) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="418" viewBox="0 0 300 418">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},78%,60%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},72%,26%)"/></linearGradient></defs>
  <rect width="300" height="418" rx="18" fill="url(#g)"/><text x="28" y="44" font-family="Arial" font-weight="700" font-size="25" fill="#fff">${name}</text></svg>`;
}

// Serve generated art for /art/<name>.svg and https://images.test/art/<name>.svg
async function routeArt(page) {
  const handler = (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop().replace('.svg', '').replace(/-/g, ' ');
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: cardArt(name) });
  };
  await page.route('**/art/*.svg', handler);
}

// A page that records anything the browser complains about (errors, blocked resources)
async function openPage(browser, url, { viewport = { width: 1920, height: 1080 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.problems = [];
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) page.problems.push(`${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => page.problems.push(`pageerror: ${error.message}`));
  await routeArt(page);
  await page.goto(url);
  return page;
}

module.exports = { findBrowser, launch, openPage, routeArt, cardArt };
