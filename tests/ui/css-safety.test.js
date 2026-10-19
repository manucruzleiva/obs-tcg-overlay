/**
 * The style sheet of a design, in a real browser. What public/js/theme-css.js writes for each way of trying to make the overlay load
 * something (CSS_ATTACKS in tests/support/samples.js) is put in the <style> of a page like the overlay's, written into the page's HTML
 * as it is, and every request the browser makes is recorded: there is none but the pages themselves, no script runs, and the page
 * around the stage stays see-through. Each style sheet has a page of its own (in a frame), so one cannot hide another. The same pages
 * with the style sheets as they were given do make requests, so the check would see one.
 * Run with: npm run test:ui
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findBrowser, launch } = require('./browser');
const CSS = require('../../public/js/theme-css');
const { CSS_ATTACKS, CSS_SHEETS, PNG } = require('../support/samples');

const skip = findBrowser() ? false : 'no Chrome or Edge found (set BROWSER_PATH to use another)';

const ORIGIN = 'http://overlay.test';
const TOP = `${ORIGIN}/all`;
const pageOf = (n) => `${ORIGIN}/overlay/${n}`;
const ASSETS = `${ORIGIN}/api/theme/assets/`;

// A page like the overlay's: OTO's own style first, then the design's, and on the stage what the style sheets style
// (with text, so that a font is used, and a size, so that a background is drawn)
function overlayPage(css) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" href="data:,">
  <style>
    html, body { margin: 0; background: transparent; }
    [hidden] { display: none !important; }
    #stage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
    #stage div, #stage a { display: block; width: 40px; height: 20px; font-size: 8px; }
  </style>
  <style id="oto-design-css">${css}</style>
</head>
<body>
  <div id="stage">
    <div class="t" data-x="abc">Text in the design's font</div>
    <div class="u">More text</div>
    <div class="v">And more</div>
    <a class="link" href="#somewhere">A link</a>
    <div class="logo">Logo</div>
    <div class="secret" hidden>What the producer switched off</div>
  </div>
</body>
</html>`;
}

// The page that holds them all, one in each frame
const topPage = (count) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="icon" href="data:,">
<style>body { margin: 0; display: flex; flex-wrap: wrap; } iframe { width: 200px; height: 100px; border: 0; }</style></head>
<body>${Array.from({ length: count }, (unused, n) => `<iframe src="/overlay/${n}"></iframe>`).join('')}</body></html>`;

describe('a design\'s style sheet in a real browser', { skip }, () => {
  let browser;

  before(async () => { browser = await launch(); });
  after(async () => { if (browser) await browser.close(); });

  // Opens a page for each style sheet, waits until the browser has drawn them and loaded what they wanted, and says what it asked for
  async function visit(sheets) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const tab = await context.newPage();
    const requests = [];
    const dialogs = [];
    const errors = [];
    tab.on('request', (request) => requests.push(request.url()));
    tab.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    tab.on('pageerror', (error) => errors.push(error.message));
    // nothing leaves the browser: the pages are made here, the design's files are a tiny picture, anything else is not found
    await context.route('**/*', (route) => {
      const url = route.request().url();
      const n = url.startsWith(`${ORIGIN}/overlay/`) ? Number(url.slice(`${ORIGIN}/overlay/`.length)) : -1;
      if (url === TOP) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: topPage(sheets.length) });
      if (n >= 0 && n < sheets.length) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: overlayPage(sheets[n]) });
      if (url.startsWith(ASSETS)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not here' });
    });
    await tab.goto(TOP);
    await tab.waitForFunction((count) => window.frames.length === count && Array.from(document.querySelectorAll('iframe')).every((frame) => frame.contentDocument && frame.contentDocument.readyState === 'complete'), sheets.length);
    const frames = tab.frames().filter((frame) => frame !== tab.mainFrame());
    await Promise.all(frames.map((frame) => frame.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))));
    await tab.waitForLoadState('networkidle');
    const looks = await Promise.all(frames.map((frame) => frame.evaluate(() => {
      const style = (node, pseudo) => getComputedStyle(node, pseudo || null);
      return {
        page: Number(location.pathname.split('/').pop()),
        html: [style(document.documentElement).backgroundColor, style(document.documentElement).opacity, style(document.documentElement, '::before').content],
        body: [style(document.body).backgroundColor, style(document.body).backgroundImage],
        secret: style(document.querySelector('.secret')).display,
        scripts: document.scripts.length,
        rules: document.getElementById('oto-design-css') ? document.getElementById('oto-design-css').sheet.cssRules.length : -1
      };
    })));
    await context.close();
    looks.sort((a, b) => a.page - b.page);
    return { requests, dialogs, errors, looks, pages: [TOP, ...sheets.map((unused, n) => pageOf(n))] };
  }

  const SEE_THROUGH = { html: ['rgba(0, 0, 0, 0)', '1', 'none'], body: ['rgba(0, 0, 0, 0)', 'none'], secret: 'none', scripts: 0 };
  const lookOf = ({ html, body, secret, scripts }) => ({ html, body, secret, scripts });

  it('loads nothing, runs nothing and paints nothing around the stage for what is written of every attack', async () => {
    const { requests, dialogs, errors, looks, pages } = await visit(CSS_ATTACKS.map(([, text]) => CSS.sanitizeCss(text).css));
    assert.deepEqual(requests.slice().sort(), pages.slice().sort(), 'the pages themselves and nothing else');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    assert.equal(looks.length, CSS_ATTACKS.length);
    looks.forEach((look, n) => assert.deepEqual(lookOf(look), SEE_THROUGH, CSS_ATTACKS[n][0]));
    assert.ok(looks.filter((look) => look.rules > 0).length > CSS_ATTACKS.length / 2, 'the browser read what was written');
  });

  it('does the same when the style sheets are written with the addresses the overlay loads the design\'s files from', async () => {
    const resolve = (ref) => `${ASSETS}${ref}?v=1&design=Store%20League`;
    const { requests, pages } = await visit(CSS_ATTACKS.map(([, text]) => CSS.sanitizeCss(text, { resolve }).css));
    assert.deepEqual(requests.slice().sort(), pages.slice().sort());
  });

  it('sees what the same pages do with the style sheets as they were given: they load from elsewhere, run a script and paint the page', async () => {
    const given = CSS_ATTACKS.filter(([name]) => name !== 'a 300 KB file');
    const { requests, dialogs, looks } = await visit(given.map(([, text]) => text));
    for (const url of ['https://e.x/a.css', 'https://e.x/b.css', 'https://e.x/c.css', 'https://e.x/d.css', 'https://e.x/g', 'http://e.x/h', 'https://e.x/i', 'https://e.x/j',
      'http://e.x/k', 'https://e.x/m', 'https://e.x/n', 'https://e.x/o', 'https://e.x/v.woff2', 'http://e.x/aa', 'http://e.x/ab', 'http://e.x/ac', 'http://e.x/ao']) {
      assert.ok(requests.includes(url), `the browser went to ${url}`);
    }
    assert.ok(requests.includes(`${ORIGIN}/api/packages/export`), 'and to a page of OTO itself');
    assert.ok(dialogs.length > 0 && dialogs.every((message) => message === '1'), 'the text as it was given ends the <style> element and runs a script');
    const look = (name) => lookOf(looks[given.findIndex((attack) => attack[0] === name)]);
    assert.notDeepEqual(look('body').body, SEE_THROUGH.body, 'it paints the page');
    assert.equal(look('html').html[1], '0');
    assert.notEqual(look('a pseudo-element of the page').html[2], 'none');
    assert.equal(look('!important in a layer').secret, 'block', 'and !important in a layer beats the producer\'s [hidden]: it shows what was switched off');
  });

  it('loads the design\'s own files, and only those, for style sheets a designer would write', async () => {
    const resolve = (ref) => `${ASSETS}${ref}?v=1`;
    const { requests, errors, looks, pages } = await visit(CSS_SHEETS.map((sheet) => CSS.sanitizeCss(sheet.css, { strict: true, resolve }).css));
    assert.deepEqual(requests.filter((url) => !pages.includes(url) && !url.startsWith(ASSETS)), []);
    assert.ok(requests.includes(`${ASSETS}images/css-sun.png?v=1`), `the picture of the logo was loaded: ${requests.join(', ')}`);
    assert.deepEqual(errors, []);
    for (const look of looks) assert.deepEqual(lookOf(look), SEE_THROUGH);
  });
});
