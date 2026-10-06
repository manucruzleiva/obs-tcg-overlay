/**
 * The logo in the corner of the control panel and the sign-in page, in a real browser: it shows, and when it does not arrive
 * the corner recovers instead of showing the broken-picture icon.
 * Run with: npm run test:ui
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../support/harness');
const { findBrowser, launch } = require('./browser');

const skip = findBrowser() ? false : 'no Chrome or Edge found (set BROWSER_PATH to use another)';

describe('the logo in the corner', { skip }, () => {
  let browser;
  let open;
  let locked;

  before(async () => {
    open = await startServer({ label: 'ui-brand' });
    locked = await startServer({ label: 'ui-brand-locked', env: { OTO_PASSWORD: 'let-me-in' } });
    browser = await launch();
  });

  after(async () => {
    if (browser) await browser.close();
    await Promise.all([open && open.stop(), locked && locked.stop()]);
  });

  // Opens a page with the requests for the logo answered by `behave(route, number)`; resolves once something is showing in the corner
  async function visit(url, behave) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    const page = await context.newPage();
    const asked = [];
    await page.route('**/logo.gif*', (route) => {
      asked.push(new URL(route.request().url()).search);
      return behave(route, asked.length);
    });
    await page.goto(url);
    await page.waitForFunction(() => {
      const image = document.querySelector('.brand-logo');
      return Boolean(image && image.complete && image.naturalWidth > 0);
    });
    const corner = await page.evaluate(() => {
      const image = document.querySelector('.brand-logo');
      return { src: image.getAttribute('src'), width: image.naturalWidth, box: Math.round(image.getBoundingClientRect().width) };
    });
    await context.close();
    return { corner, asked };
  }

  const fine = (route) => route.continue();
  const fails = (route) => route.abort();
  const notFound = (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'nothing here' });
  const cutShort = (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('GIF89a') });

  // the logo is 34 pixels wide in the bar of the control panel and 52 on the sign-in page
  for (const [name, base, path, size] of [['control panel', () => open.base, '/control', 34], ['sign-in page', () => locked.base, '/login', 52]]) {
    describe(`on the ${name}`, () => {
      it('shows the logo with one request', async () => {
        const { corner, asked } = await visit(`${base()}${path}`, fine);
        assert.deepEqual([corner.src, corner.width, corner.box], ['/logo.gif', 800, size]);
        assert.deepEqual(asked, [''], 'asked once, with no tricks');
      });

      it('asks again under a new address when the first try fails, and shows the real logo', async () => {
        const { corner, asked } = await visit(`${base()}${path}`, (route, number) => (number === 1 ? fails(route) : fine(route)));
        assert.match(corner.src, /^\/logo\.gif\?retry=\d+$/);
        assert.equal(corner.width, 800);
        assert.equal(asked.length, 2);
      });

      it('draws a mark of its own when the logo never arrives, so no broken picture shows', async () => {
        const { corner, asked } = await visit(`${base()}${path}`, notFound);
        assert.match(corner.src, /^data:image\/svg\+xml,/);
        assert.ok(corner.width > 0, 'a picture that is really there');
        assert.equal(corner.box, size, 'in the place of the logo');
        assert.equal(asked.length, 2, 'tried twice, not for ever');
      });

      it('treats a picture that arrives cut short the same way', async () => {
        const { corner } = await visit(`${base()}${path}`, cutShort);
        assert.match(corner.src, /^data:image\/svg\+xml,/);
        assert.ok(corner.width > 0);
      });
    });
  }
});
