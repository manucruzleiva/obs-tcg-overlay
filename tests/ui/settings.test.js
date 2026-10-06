/**
 * Settings in a real browser: designs (pictures, colors, sounds), .oto packages, and the card library.
 * Run with: npm run test:ui
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startServer, startMockCardApi, startMockImageHost, wait } = require('../support/harness');
const S = require('../support/samples');
const { createZip, readZip } = require('../../src/services/zip');
const SOUND = require('../../public/js/sound-options');
const THEME = require('../../public/js/theme-options');
const { findBrowser, launch, openPage } = require('./browser');

const skip = findBrowser() ? false : 'no Chrome or Edge found (set BROWSER_PATH to use another)';

describe('settings', { skip }, () => {
  let browser;
  let server;
  let api;
  let host;
  let decksPage; // a stand-in for the deck page of Limitless TCG
  let page;
  let extra = [];

  const card = (id, name, extra = {}) => {
    const [set, number] = id.split('-');
    return {
      id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp: '70', types: ['Lightning'], number, rarity: 'Common',
      set: { id: set, name: `Set ${set}`, releaseDate: '2024/05/01' },
      images: { small: `${host.url}/${set}/${number}.png`, large: `${host.url}/${set}/${number}_hires.png` },
      regulationMark: 'H', legalities: { expanded: 'Legal' }, ...extra
    };
  };

  before(async () => {
    host = await startMockImageHost();
    const deckRow = (rank, slug, name) => `<tr><td>${rank}</td><td><img class="pokemon" src="https://r2.limitlesstcg.net/pokemon/gen9/${slug}.png" alt="${slug}"></td><td><a href="/decks/${rank}">${name}</a></td><td>10</td><td>${20 - rank}%</td></tr>`;
    const decksHtml = `<table>${[['dragapult', 'Test Deck One'], ['zoroark', 'Test Deck Two'], ['slowking', 'Test Deck Three'], ['alakazam', 'Test Deck Four'], ['hydrapple', 'Test Deck Five']].map(([slug, name], index) => deckRow(index + 1, slug, name)).join('')}</table>`;
    decksPage = require('node:http').createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(decksHtml); });
    await new Promise((resolve) => decksPage.listen(0, '127.0.0.1', resolve));
    const pool = [
      card('sv4-1', 'Pikachu'), card('sv4-2', 'Raichu', { evolvesFrom: 'Pikachu' }), card('sv5-3', 'Eevee'),
      card('sv8-4', 'Iono', { supertype: 'Trainer', subtypes: ['Supporter'], hp: undefined })
    ];
    const withAttacks = (id) => {
      const found = pool.find((entry) => entry.id === id);
      return { data: { ...found, attacks: [{ name: `${found.name} Attack`, damage: '30', cost: ['Lightning'], convertedEnergyCost: 1 }], convertedRetreatCost: 2 } };
    };
    api = await startMockCardApi({
      '/cards/sv4-1': () => withAttacks('sv4-1'),
      '/cards/sv4-2': () => withAttacks('sv4-2'),
      '/cards/sv5-3': () => withAttacks('sv5-3'),
      '/cards?': (url) => {
        const params = new URL(url, 'http://mock').searchParams;
        const page = Number(params.get('page') || 1);
        const size = Number(params.get('pageSize') || 20);
        return { data: pool.slice((page - 1) * size, page * size), page, pageSize: size, totalCount: pool.length };
      }
    });
    server = await startServer({
      label: 'ui-settings',
      env: { POKEMONTCG_API_URL: api.url, OTO_IMAGE_BASE: host.url, OTO_CATALOG_PACE_MS: '0', OTO_CATALOG_RETRY_MS: '2', OTO_LIMITLESS_URL: `http://127.0.0.1:${decksPage.address().port}/decks` }
    });
    browser = await launch();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    await Promise.all([api && api.close(), host && host.close(), decksPage && new Promise((resolve) => { decksPage.closeAllConnections(); decksPage.close(resolve); })]);
  });

  // The server ignores an action it has already seen from the same client id and number, so each test producer needs its own id
  const freshProducer = async (name = 'Maya') => {
    const client = server.client({ clientId: `settings-${Math.random().toString(36).slice(2, 10)}`, name });
    await client.ready();
    return client;
  };

  const live = async () => (await fetch(`${server.base}/api/state`)).json();

  const call = async (method, route, body) => {
    const isJson = body !== undefined && !Buffer.isBuffer(body);
    const response = await fetch(`${server.base}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': isJson ? 'application/json' : 'application/octet-stream' },
      body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buffer.toString('utf8')); } catch { /* not JSON */ }
    return { status: response.status, json, buffer };
  };

  // Back to a clean slate: no designs, no sounds of the producer's own, no libraries, default settings
  async function cleanUp() {
    const { json: themes } = await call('GET', '/api/themes');
    await call('POST', '/api/theme/active', { name: null });
    for (const name of themes.names) await call('DELETE', `/api/themes/${encodeURIComponent(name)}`);
    for (const cue of SOUND.KEYS) await call('DELETE', `/api/sounds/${cue}`);
    let catalog = (await call('GET', '/api/catalog')).json;
    for (let waited = 0; catalog.job && !catalog.job.finished && waited < 40; waited++) { await wait(100); catalog = (await call('GET', '/api/catalog')).json; }
    for (const profile of catalog.profiles) if (profile.ready || profile.resumable) await call('DELETE', `/api/catalog/${profile.id}`);
    await call('DELETE', '/api/catalog/pictures');
    await call('PUT', '/api/catalog/active', { profile: null });
  }

  beforeEach(async () => {
    await cleanUp();
    const producer = await freshProducer();
    await producer.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
    producer.close();
    page = await openPage(browser, `${server.base}/control`);
    await page.waitForSelector('.trainer-panel.side-a');
  });

  afterEach(async () => {
    for (const context of [page.context(), ...extra]) await context.close();
    extra = [];
  });

  async function openSettings(tab) {
    await page.locator('button[aria-label="Settings"]').click();
    await page.waitForSelector('.modal .tabs');
    if (tab) await page.locator('.tab', { hasText: tab }).click();
  }

  const chooseFile = async (button, file) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
    await chooser.setFiles(file);
  };

  // a library's row, by its own name (the description of one can mention another)
  const library = (name) => page.locator('.library-row').filter({ has: page.locator('.library-name', { hasText: new RegExp(`^${name}$`) }) });

  const libraryReady = async (name) => {
    try {
      await library(name).locator('.library-state:has-text("saved")').waitFor({ timeout: 8000 });
    } catch (error) {
      const status = (await call('GET', '/api/catalog')).json;
      const toasts = await page.locator('.toast').allTextContents();
      throw new Error(`the ${name} library never showed as saved. Server: ${JSON.stringify(status.job)} ${JSON.stringify(status.profiles.map((p) => [p.id, p.ready, p.building]))}. Page: "${await library(name).textContent()}". Toasts: ${JSON.stringify(toasts)}`);
    }
  };

  const saved = () => page.waitForFunction(() => document.querySelector('.save-status')?.textContent.startsWith('Saved'));

  // "Create a design" asks for a name in a dialog of the app (the desktop app has no window.prompt),
  // then opens the editor on it. These tests are about the settings screen behind it, so the editor is closed again.
  async function makeDesign(name) {
    await page.locator('button', { hasText: 'Create a design' }).click();
    const ask = page.locator('.modal[aria-label="Create a design"]');
    await ask.locator('input').fill(name);
    await ask.getByRole('button', { name: 'Create', exact: true }).click();
    const editor = page.locator(`.modal[aria-label="Design: ${name}"]`);
    await editor.waitFor();
    await editor.locator('.modal-foot').getByRole('button', { name: 'Close', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await page.waitForSelector(`.theme-head h3:has-text("${name}")`);
  }

  describe('more overlays', () => {
    const cards = () => page.locator('.screen-card:not(.main)');
    const screensNow = async () => (await call('GET', '/api/state')).json.settings.screens;

    it('adds an overlay with an address of its own, and says how to use it', async () => {
      await openSettings('Overlay');
      assert.match(await page.locator('.screen-card.main code').textContent(), /\/overlay$/);
      assert.equal(await cards().count(), 0);
      await page.getByRole('button', { name: 'Add an overlay' }).click();
      const ask = page.locator('.modal[aria-label="Add an overlay"]');
      await ask.waitFor();
      await ask.locator('input').fill('Vertical stream');
      await ask.getByRole('button', { name: 'Add', exact: true }).click();
      await cards().first().waitFor();
      assert.deepEqual(await screensNow(), [{ id: 'vertical-stream', name: 'Vertical stream', design: null, display: {}, sound: false }]);
      assert.match(await cards().first().locator('code').textContent(), /\/overlay\?screen=vertical-stream$/);
      assert.equal(await cards().first().locator('select').inputValue(), '', 'the same design as the main overlay');
      assert.match(await cards().first().locator('.screen-options small').textContent(), /The same as the main overlay/);

      // a name that is taken is not added twice
      await page.getByRole('button', { name: 'Add an overlay' }).click();
      await ask.locator('input').fill('vertical STREAM');
      assert.match(await ask.locator('.prompt-complaint').textContent(), /already have an overlay with that name|You have an overlay with that name/);
      await ask.getByRole('button', { name: 'Cancel' }).click();
      assert.deepEqual(page.problems, []);
    });

    it('gives it a design, a name, the sounds, and what it shows differently, and takes it away again', async () => {
      await call('PUT', '/api/themes/Tall%20Look', { colors: {}, orientation: 'portrait' });
      await openSettings('Overlay');
      await page.getByRole('button', { name: 'Add an overlay' }).click();
      const ask = page.locator('.modal[aria-label="Add an overlay"]');
      await ask.locator('input').fill('Phone');
      await ask.getByRole('button', { name: 'Add', exact: true }).click();
      await cards().first().waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.screen-card select option')].some((option) => option.value === 'Tall Look'));

      await cards().first().locator('select').selectOption('Tall Look');
      await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).settings.screens[0].design === 'Tall Look');
      await cards().first().locator('input[type="text"]').fill('Mobile');
      await cards().first().locator('input[type="text"]').press('Tab');
      await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).settings.screens[0].name === 'Mobile');
      await cards().first().locator('.switch', { hasText: 'Plays the sound effects' }).click();
      await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).settings.screens[0].sound === true);
      assert.equal((await screensNow())[0].id, 'phone', 'the address does not change with the name');

      // what it shows
      await cards().first().getByRole('button', { name: 'What it shows' }).click();
      const dialog = page.locator('.modal[aria-label^="What"]');
      await dialog.waitFor();
      const option = (key) => dialog.locator(`select[data-option="${key}"]`);
      assert.match(await option('scoreboard').locator('option').first().textContent(), /Same as the main overlay \(shown\)/);
      await option('scoreboard').selectOption('hide');
      // (one change at a time, as a person makes them: the next one starts from what the page knows after the first)
      await page.waitForFunction(() => window.oto.conn.live.settings.screens[0].display.scoreboard === false);
      await option('hpBars').selectOption('show');
      await page.waitForFunction(async () => Object.keys((await (await fetch('/api/state')).json()).settings.screens[0].display).length === 2);
      assert.deepEqual((await screensNow())[0].display, { scoreboard: false, hpBars: true });
      await option('hpBars').selectOption('same');
      await page.waitForFunction(async () => Object.keys((await (await fetch('/api/state')).json()).settings.screens[0].display).length === 1);
      await dialog.getByRole('button', { name: 'Done' }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.match(await cards().first().locator('.screen-options button').textContent(), /What it shows \(1 different\)/);

      // it is taken away after asking
      await cards().first().getByRole('button', { name: 'Remove Mobile' }).click();
      await page.locator('.modal[aria-label^="Remove"]').getByRole('button', { name: 'Remove', exact: true }).click();
      await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).settings.screens.length === 0);
      assert.equal(await cards().count(), 0);
      assert.deepEqual(page.problems, []);
    });

    it('is at most three, and says so', async () => {
      await call('POST', '/api/theme/active', { name: null });
      const producer = await freshProducer();
      await producer.act('action:settings', { action: 'update', screens: ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase(), design: null, display: {}, sound: false })) });
      producer.close();
      await page.waitForFunction(() => window.oto.state.settings.screens.length === 3);
      await openSettings('Overlay');
      assert.equal(await cards().count(), 3);
      assert.equal(await page.getByRole('button', { name: 'Add an overlay' }).isDisabled(), true);
      assert.match(await page.locator('.screen-list small').last().textContent(), /Up to 3 more/);
    });
  });

  describe('a copy of the built-in look', () => {
    it('makes a design with every color and the usual fonts written out, to learn from, and opens it in the editor', async () => {
      await openSettings('Look');
      await page.locator('.theme-list').getByRole('button', { name: 'Copy of the built-in look' }).click();
      const ask = page.locator('.modal[aria-label="Copy of the built-in look"]');
      await ask.waitFor();
      assert.match(await ask.locator('.modal-body').textContent(), /Every color of the built-in look is written into the new design/);
      await ask.locator('input').fill('Learning');
      await ask.getByRole('button', { name: 'Create', exact: true }).click();
      const editor = page.locator('.modal[aria-label="Design: Learning"]');
      await editor.waitFor();

      const design = (await call('GET', '/api/themes/Learning')).json;
      assert.deepEqual(Object.keys(design.colors).sort(), THEME.COLOR_KEYS.slice().sort(), 'every color it can change');
      assert.equal(design.colors['--accent'], '#7c8cff');
      assert.equal(design.colors['--radius'], '14px');
      assert.match(design.fontFamilies.display, /^"Bahnschrift"/);
      assert.match(design.fontFamilies.text, /^"Segoe UI Variable Text"/);
      assert.equal(design.description, 'A copy of the built-in look');

      // the editor shows it as code, so it can be read and changed
      await editor.locator('.editor-side .tab', { hasText: 'Code' }).click();
      const code = JSON.parse(await editor.locator('.code-input').inputValue());
      assert.equal(code.colors['--accent'], '#7c8cff');
      assert.ok(code.fontFamilies.display);
      assert.deepEqual(page.problems, []);
    });
  });

  describe('designs', () => {
    it('makes a design, then colors, a picture, a font and a sound, each saved as it is chosen', async () => {
      await openSettings('Look');
      await makeDesign('Neon Night');

      await page.locator('.color-row').first().locator('input[type=text]').fill('#ff00aa');
      await saved();
      await page.locator('.theme-meta input[aria-label="Made by"]').fill('Mina');
      await page.locator('.theme-meta input[aria-label="About this design"]').fill('For Friday nights');
      await saved();

      await chooseFile(page.locator('.image-row', { hasText: 'Logo' }).locator('button', { hasText: 'Upload' }), { name: 'logo.png', mimeType: 'image/png', buffer: S.PNG });
      await page.waitForSelector('.image-row:has-text("Logo") img');
      assert.match(await page.locator('.image-row:has-text("Logo") img').getAttribute('src'), /^\/api\/themes\/Neon%20Night\/assets\/images\/logoImage\.png\?v=\d+$/);

      await chooseFile(page.locator('.image-row[data-role="display"]').locator('button', { hasText: 'Upload' }), { name: 'font.woff2', mimeType: 'font/woff2', buffer: S.WOFF2 });
      await page.waitForSelector('.image-row[data-role="display"] button:has-text("Remove")');

      await chooseFile(page.locator('.sound-row', { hasText: 'Damage' }).locator('button', { hasText: 'Upload' }), { name: 'hit.wav', mimeType: 'audio/wav', buffer: S.playableWav() });
      await page.waitForSelector('.sound-row:has-text("Damage") button:has-text("Remove")');

      const design = (await call('GET', '/api/themes/Neon%20Night')).json;
      assert.deepEqual(design.colors['--accent'], '#ff00aa');
      assert.equal(design.author, 'Mina');
      assert.equal(design.description, 'For Friday nights');
      assert.equal(design.images.logoImage, 'images/logoImage.png');
      assert.equal(design.font, 'fonts/font.woff2');
      assert.equal(design.sounds.damage, 'sounds/damage.wav');
      assert.deepEqual((await call('GET', '/api/themes/Neon%20Night/assets/images/logoImage.png')).buffer, S.PNG);
      assert.deepEqual(page.problems, []);
    });

    it('keeps a color being typed when a picture is uploaded at the same time', async () => {
      await openSettings('Look');
      await makeDesign('Quick Hands');
      await page.locator('.color-row').first().locator('input[type=text]').fill('#123456');
      // the upload finishes before the color has been saved by itself
      await chooseFile(page.locator('.image-row', { hasText: 'Logo' }).locator('button', { hasText: 'Upload' }), { name: 'logo.png', mimeType: 'image/png', buffer: S.PNG });
      await page.waitForSelector('.image-row:has-text("Logo") img');
      await saved();
      assert.equal((await call('GET', '/api/themes/Quick%20Hands')).json.colors['--accent'], '#123456');
      assert.equal(await page.locator('.color-row').first().locator('input[type=text]').inputValue(), '#123456');
    });

    it('explains a file it cannot use, and keeps what the design had', async () => {
      await openSettings('Look');
      await makeDesign('Careful');
      await chooseFile(page.locator('.image-row', { hasText: 'Logo' }).locator('button', { hasText: 'Upload' }), { name: 'logo.png', mimeType: 'image/png', buffer: S.PNG });
      await page.waitForSelector('.image-row:has-text("Logo") img');

      await chooseFile(page.locator('.image-row', { hasText: 'Logo' }).locator('button', { hasText: 'Replace' }), { name: 'evil.png', mimeType: 'image/png', buffer: S.HTML });
      await page.waitForSelector('.toast-error');
      assert.match(await page.locator('.toast-error').first().textContent(), /not a supported picture/);
      assert.equal((await call('GET', '/api/themes/Careful')).json.images.logoImage, 'images/logoImage.png');
    });

    it('shows the design on the overlay as it is put on air, and as it is edited', async () => {
      await openSettings('Look');
      await makeDesign('On Air');
      await page.locator('.color-row').first().locator('input[type=text]').fill('#ff00aa');
      await chooseFile(page.locator('.image-row', { hasText: 'Logo' }).locator('button', { hasText: 'Upload' }), { name: 'logo.png', mimeType: 'image/png', buffer: S.PNG });
      await page.waitForSelector('.image-row:has-text("Logo") img');
      await chooseFile(page.locator('.sound-row', { hasText: 'Damage' }).locator('button', { hasText: 'Upload' }), { name: 'hit.wav', mimeType: 'audio/wav', buffer: S.playableWav() });
      await page.waitForSelector('.sound-row:has-text("Damage") button:has-text("Remove")');
      await saved();

      const overlay = await openPage(browser, `${server.base}/overlay`);
      extra.push(overlay.context());
      await overlay.waitForSelector('#stage');
      assert.equal(await overlay.evaluate(() => document.documentElement.classList.contains('has-logo')), false, 'not on air yet');
      assert.equal(await overlay.evaluate(() => window.oto.sfx.buffers.has('damage')), false, 'and its sound is not loaded yet');

      await page.locator('button', { hasText: 'Put on the overlay' }).click();
      await overlay.waitForFunction(() => document.documentElement.classList.contains('has-logo'));
      // the design's sound has been fetched and decoded by the overlay's audio engine, ready to play
      await overlay.waitForFunction(() => window.oto.sfx.buffers.has('damage'));
      assert.equal(await overlay.evaluate(() => document.documentElement.style.getPropertyValue('--accent')), '#ff00aa');
      const url = await overlay.evaluate(() => /url\("(.*)"\)/.exec(document.documentElement.style.getPropertyValue('--logoImage'))[1]);
      assert.match(url, /^\/api\/theme\/assets\/images\/logoImage\.png\?v=\d+$/);
      assert.equal(await overlay.evaluate((src) => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image.naturalWidth); image.onerror = () => resolve(0); image.src = src; }), url), 1, 'the picture really loads');

      // an edit shows up on the overlay by itself
      await page.locator('.color-row').first().locator('input[type=text]').fill('#00ffcc');
      await overlay.waitForFunction(() => document.documentElement.style.getPropertyValue('--accent') === '#00ffcc');

      await page.locator('.theme-item', { hasText: 'Built-in look' }).click();
      await overlay.waitForFunction(() => !document.documentElement.classList.contains('has-logo'));
      await overlay.waitForFunction(() => !window.oto.sfx.buffers.has('damage'));
      assert.deepEqual(overlay.problems, []);
    });

    it('lists the design\'s sounds on the Sounds tab, and lets the producer\'s own sound win', async () => {
      await call('PUT', '/api/themes/Sound%20Check', {});
      await call('PUT', '/api/themes/Sound%20Check/sounds/damage', S.playableWav());
      await call('POST', '/api/theme/active', { name: 'Sound Check' });

      await openSettings('Sounds');
      const row = page.locator('.cue-row', { hasText: 'Damage' });
      await row.locator('.custom-badge').waitFor();
      assert.equal(await row.locator('.custom-badge').textContent(), 'From the design');
      assert.equal(await row.locator('button', { hasText: 'Remove' }).count(), 0, 'the design\'s sound is not the producer\'s to remove here');
      assert.equal(await row.locator('button', { hasText: 'Use my own' }).count(), 1);

      await chooseFile(row.locator('button', { hasText: 'Use my own' }), { name: 'mine.wav', mimeType: 'audio/wav', buffer: S.playableWav(200) });
      await page.waitForFunction(() => document.querySelector('.cue-row .custom-badge')?.textContent === 'Your sound');
      assert.equal((await call('GET', '/api/sounds')).json.custom.damage.source, 'custom');

      await row.locator('button', { hasText: 'Remove' }).click();
      await page.waitForFunction(() => document.querySelector('.cue-row .custom-badge')?.textContent === 'From the design');
      assert.equal((await call('GET', '/api/sounds')).json.custom.damage.source, 'design');
    });

    it('has a sound for the supporter being used, with its own switch, volume and test', async () => {
      await openSettings('Sounds');
      const row = page.locator('.cue-row', { hasText: 'Supporter used' });
      await row.waitFor();
      assert.equal(await row.locator('input[type="checkbox"]').isChecked(), true);
      assert.equal(await row.locator('input[type="range"]').inputValue(), '100');
      assert.equal(await row.locator('button', { hasText: 'Use my own' }).count(), 1);

      // auditioning works even while sound is switched off
      assert.equal((await call('GET', '/api/state')).json.settings.sound.enabled, false);
      await row.locator('button', { hasText: 'Test' }).click();
      await page.waitForFunction(() => window.oto.sfx.log.some((entry) => entry.cue === 'supporter' && entry.force));

      // the switch is saved for that moment only
      await row.locator('.switch').click();
      await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).settings.sound.events.supporter.enabled === false);
      assert.equal((await call('GET', '/api/state')).json.settings.sound.events.damage.enabled, true);
    });

    it('still shows the sound settings when the server has not sent any', async () => {
      // an older server, or a damaged save: the screen must not stay empty
      await page.evaluate(() => { delete window.oto.state.settings.sound; delete window.oto.state.settings.toastSeconds; });
      await openSettings('Sounds');
      await page.locator('.cue-row', { hasText: 'Supporter used' }).waitFor();
      assert.ok(await page.locator('.cue-row').count() >= 15, 'every moment is listed');
      assert.equal(await page.locator('.cue-row').first().locator('input[type="range"]').inputValue(), '100');
      await page.locator('.tab', { hasText: 'Overlay' }).click();
      assert.equal(await page.locator('.slider', { hasText: 'Banner stays for' }).locator('output').textContent(), '2 s', 'the usual two seconds');
      assert.deepEqual(page.problems, []);
    });
  });

  describe('.oto packages', () => {
    // A finished design on the overlay, and some control settings, to save as a package
    async function setUp() {
      await call('PUT', '/api/themes/Neon%20Night', { colors: { '--accent': '#ff00aa' }, author: 'Mina' });
      await call('PUT', '/api/themes/Neon%20Night/images/logoImage', S.PNG);
      await call('PUT', '/api/themes/Neon%20Night/sounds/damage', S.playableWav());
      await call('POST', '/api/theme/active', { name: 'Neon Night' });
      const producer = await freshProducer();
      await producer.act('action:settings', { action: 'update', toastSeconds: 8, display: { nationality: false } });
      producer.close();
    }

    const save = async (open) => {
      await open();
      await page.waitForSelector('.modal[aria-label="Save a package"]');
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.modal[aria-label="Save a package"] button', { hasText: 'Save the file' }).click()]);
      return { name: download.suggestedFilename(), bytes: fs.readFileSync(await download.path()) };
    };

    it('saves the design with its sounds and the control settings as one .oto file', async () => {
      await setUp();
      await openSettings('Look');
      const file = await save(() => page.locator('button', { hasText: 'Save as .oto' }).click());
      assert.equal(file.name, 'neon-night.oto');
      const entries = readZip(file.bytes);
      assert.deepEqual([...entries.keys()].sort(), ['controls.json', 'design.json', 'images/logoImage.png', 'manifest.json', 'sounds/damage.wav']);
      const controls = JSON.parse(entries.get('controls.json')).settings;
      assert.equal(controls.toastSeconds, 8);
      assert.equal(controls.display.nationality, false);
      assert.equal(JSON.parse(entries.get('design.json')).author, 'Mina');
      await page.waitForSelector('.toast-success');
    });

    it('can leave the control settings out', async () => {
      await setUp();
      await openSettings('Look');
      await page.locator('button', { hasText: 'Save as .oto' }).click();
      await page.waitForSelector('.modal[aria-label="Save a package"]');
      await page.locator('.modal[aria-label="Save a package"] .switch', { hasText: 'My control settings' }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.modal[aria-label="Save a package"] button', { hasText: 'Save the file' }).click()]);
      assert.equal(readZip(fs.readFileSync(await download.path())).has('controls.json'), false);
    });

    it('saves the whole setup from the General tab', async () => {
      await setUp();
      await openSettings('General');
      const file = await save(() => page.locator('button', { hasText: 'Save my setup as .oto' }).click());
      assert.equal(file.name, 'neon-night.oto');
      assert.ok(readZip(file.bytes).has('controls.json'));
    });

    it('installs a package: shows what is in it, then adds the design and applies the settings, which can be undone', async () => {
      await setUp();
      await openSettings('Look');
      const file = await save(() => page.locator('button', { hasText: 'Save as .oto' }).click());
      await page.keyboard.press('Escape');

      // change the settings, so applying the package is visible
      const producer = await freshProducer();
      await producer.act('action:settings', { action: 'update', toastSeconds: 2, display: { nationality: true } });

      await page.waitForSelector('.modal', { state: 'detached' });
      await openSettings('General');
      await chooseFile(page.locator('button', { hasText: 'Install a .oto file' }), { name: file.name, mimeType: 'application/octet-stream', buffer: file.bytes });
      await page.waitForSelector('.modal[aria-label="Install \\"Neon Night\\""]');
      const dialog = page.locator('.modal[aria-label="Install \\"Neon Night\\""]');
      const text = await dialog.textContent();
      assert.match(text, /by Mina/);
      assert.match(text, /1 picture/);
      assert.match(text, /1 sound/);
      assert.match(text, /You already have a design called "Neon Night"/);
      assert.match(text, /Hides: Nationality/);
      assert.match(text, /banners stay 8 s/);

      await dialog.locator('button', { hasText: 'Install' }).click();
      await page.waitForSelector('.toast-success');
      assert.match(await page.locator('.toast-success', { hasText: 'Installed' }).first().textContent(), /Installed "Neon Night 2" and put it on the overlay; control settings applied/);

      assert.deepEqual((await call('GET', '/api/themes')).json, { active: 'Neon Night 2', names: ['Neon Night', 'Neon Night 2'] });
      let settings = (await call('GET', '/api/state')).json.settings;
      assert.equal(settings.toastSeconds, 8);
      assert.equal(settings.display.nationality, false);

      // (the Settings dialog is still open: the activity is read once it is closed)
      await page.locator('.modal-backdrop').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.match(await feedText(), /Settings from "Neon Night"/);

      // the producers can take the settings back
      await page.keyboard.press('Control+z');
      await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).settings.toastSeconds === 2);
      settings = (await call('GET', '/api/state')).json.settings;
      assert.equal(settings.display.nationality, true);
      producer.close();
    });

    it('installs a package dropped on the window, and says what it will change before it does', async () => {
      const controlsOnly = createZip([{ name: 'controls.json', data: Buffer.from(JSON.stringify({ version: 1, settings: { toastSeconds: 9, animationSeconds: 2, display: { record: false, nationality: false }, sound: { enabled: true, volume: 40, events: { damage: { enabled: false } } }, enableAttackToast: false, apiKey: 'sk-steal' } })) }]);
      await page.evaluate((bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], 'show-settings.oto', { type: 'application/octet-stream' }));
        for (const type of ['dragenter', 'dragover', 'drop']) document.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, [...controlsOnly]);

      await page.waitForSelector('.modal[aria-label="Install \\"OTO package\\""]');
      const dialog = page.locator('.modal[aria-label="Install \\"OTO package\\""]');
      const lines = await dialog.locator('.package-lines li').allTextContents();
      assert.deepEqual(lines, [
        'Hides: Nationality, Tournament record (W/L/T)',
        'Announcements: banners stay 9 s, full-screen effects 2 s',
        '1 announcement switched off',
        'Sound effects on at 40%',
        'Muted sounds: Damage'
      ]);
      assert.equal(await dialog.locator('text=Design').count(), 0, 'there is no design in it');
      assert.equal((await call('GET', '/api/state')).json.settings.toastSeconds, 2, 'nothing has changed yet');

      await dialog.locator('button', { hasText: 'Install' }).click();
      await page.waitForSelector('.toast-success');
      const settings = (await call('GET', '/api/state')).json.settings;
      assert.equal(settings.toastSeconds, 9);
      assert.equal(settings.sound.events.damage.enabled, false);
      assert.equal(settings.apiKeySet, false, 'a key hidden in the package was ignored');
    });

    it('turns away a file that is not a package, and a drop that is not a .oto at all', async () => {
      await openSettings('General');
      await chooseFile(page.locator('button', { hasText: 'Install a .oto file' }), { name: 'notes.oto', mimeType: 'application/octet-stream', buffer: Buffer.from('these are only some words, nothing more than that') });
      await page.waitForSelector('.toast-error');
      assert.match(await page.locator('.toast-error').first().textContent(), /not a package file/);

      await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['x'], 'picture.png', { type: 'image/png' }));
        document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() => [...document.querySelectorAll('.toast-info')].some((node) => /Drop a \.oto file/.test(node.textContent)));
    });

    it('installs a design from a file made by the older version', async () => {
      const legacy = { name: 'Old League', colors: { '--accent': '#ff0000' }, images: { logoImage: `data:image/png;base64,${S.PNG.toString('base64')}` } };
      await openSettings('Look');
      await chooseFile(page.locator('button', { hasText: 'Install a .oto' }).first(), { name: 'old-league.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
      await page.waitForSelector('.theme-head h3:has-text("Old League")');
      assert.equal((await call('GET', '/api/themes/Old%20League')).json.images.logoImage, 'images/logoImage.png');
    });
  });

  describe('what the overlay shows', () => {
    const option = (label) => page.locator('.option-group label.switch', { hasText: label }).locator('input');

    it('lists the GX and VSTAR markers, off to begin with, and shows them when asked', async () => {
      await openSettings('Overlay');
      await page.waitForSelector('.option-group');
      assert.equal(await option('GX attack marker (once per game)').isChecked(), false);
      assert.equal(await option('VSTAR Power marker (once per game)').isChecked(), false);
      assert.equal(await option('Supporter play counter').isChecked(), true, 'the supporter counter has its switch now too');
      assert.equal(await option('Energy attachment counter').isChecked(), true);

      await page.locator('.option-group label.switch', { hasText: 'GX attack marker (once per game)' }).click(); // the box itself is under its track
      for (let waited = 0; waited < 40 && !(await live()).settings.display.gxMarker; waited++) await wait(50);
      assert.equal((await live()).settings.display.gxMarker, true);
      assert.equal((await live()).settings.display.vstarMarker, false);

      await page.getByRole('button', { name: 'Show everything' }).click();
      for (let waited = 0; waited < 40 && !(await live()).settings.display.vstarMarker; waited++) await wait(50);
      assert.equal((await live()).settings.display.vstarMarker, true, 'everything means everything');
      assert.deepEqual(page.problems, []);
    });
  });

  // The activity of the producers is in a popup: open it, read it and close it
  const feedText = async (from = page) => {
    await from.getByRole('button', { name: 'Activity' }).click();
    const feed = from.locator('.modal[aria-label="Activity"] .feed');
    await feed.waitFor();
    const text = await feed.textContent();
    await from.keyboard.press('Escape');
    await from.waitForSelector('.modal[aria-label="Activity"]', { state: 'detached' });
    return text;
  };

  // Waits until reading the live game gives what is expected, and fails showing what it gave
  const until = async (read, expected) => {
    for (let waited = 0; waited < 80; waited++) {
      if (JSON.stringify(await read()) === JSON.stringify(expected)) return;
      await wait(50);
    }
    assert.deepEqual(await read(), expected);
  };

  describe('the flag for a nationality', () => {
    it('is an option that is off to begin with, and "Show everything" and "Minimal" leave it as it is', async () => {
      await openSettings('Overlay');
      const flag = page.locator('.option-group label.switch', { hasText: 'Nationality as a flag emoji' });
      assert.equal(await flag.locator('input').isChecked(), false);

      await flag.click();
      await until(async () => (await live()).settings.display.nationalityFlag, true);
      await page.getByRole('button', { name: /^Minimal/ }).click();
      await until(async () => (await live()).settings.display.nationality, false);
      assert.equal((await live()).settings.display.nationalityFlag, true, 'a way of drawing the nationality is not a piece that Minimal hides');

      await page.getByRole('button', { name: 'Show everything' }).click();
      await until(async () => (await live()).settings.display.nationality, true);
      assert.equal((await live()).settings.display.nationalityFlag, true, 'and Show everything does not choose it either');
      assert.deepEqual(page.problems, []);
    });
  });

  describe('the popular decks', () => {
    it('start from the list that comes with OTO, are read again from Limitless TCG when asked, and every deck box suggests the new names at once', async () => {
      await openSettings('Cards');
      const box = page.locator('.decks-box');
      await box.waitFor();
      await box.locator('.library-state[data-built-in="true"]').waitFor();
      assert.match(await box.textContent(), /the list that comes with OTO/);
      assert.equal(await box.getByRole('button', { name: 'Use the list that comes with OTO' }).count(), 0, 'nothing to go back from');
      assert.equal(await page.evaluate(() => Boolean(window.OTO_DECK_POPULAR.find('Test Deck One'))), false);

      await box.getByRole('button', { name: 'Update from Limitless TCG' }).click();
      await box.locator('.library-state[data-built-in="false"]').waitFor();
      assert.match(await box.textContent(), /5 decks from Limitless TCG, read on/);
      assert.match(await box.textContent(), /The most played: Test Deck One, Test Deck Two, Test Deck Three, Test Deck Four, Test Deck Five/);
      await page.locator('.toast-success', { hasText: 'The list of decks is up to date: 5 decks' }).waitFor();

      // the page has the new list without being reloaded: the suggestions of the deck boxes, and the picture of a deck that is named by it
      assert.equal(await page.evaluate(() => window.OTO_DECK_POPULAR.find('test deck one').pokemon[0]), 887);
      await page.waitForFunction(() => [...document.querySelectorAll('#deck-names option')].some((option) => option.value === 'Test Deck Three'));
      assert.equal(await page.evaluate(() => document.querySelector('#deck-names option').value), 'Test Deck One', 'the most played first');

      await box.getByRole('button', { name: 'Use the list that comes with OTO' }).click();
      await box.locator('.library-state[data-built-in="true"]').waitFor();
      await page.waitForFunction(() => ![...document.querySelectorAll('#deck-names option')].some((option) => option.value === 'Test Deck Three'));
      assert.deepEqual(page.problems, []);
    });
  });

  describe('the card data check', () => {
    it('finds the Pokémon of a library that lack their attacks, mends them with Repair, and finds nothing wrong afterwards', async () => {
      // (a library whose cards were listed short, with no attacks: Standard)
      const status = (await call('GET', '/api/catalog')).json;
      if (!status.profiles[0].ready) {
        await call('POST', '/api/catalog/standard/download', {});
        for (let waited = 0; waited < 100 && !(await call('GET', '/api/catalog')).json.profiles[0].ready; waited++) await wait(50);
      }
      await openSettings('Cards');
      const box = page.locator('.health-box');
      await box.waitFor();
      await box.locator('.library-state', { hasText: 'Not checked yet' }).waitFor();
      assert.equal(await box.getByRole('button', { name: 'Repair' }).isDisabled(), true, 'nothing to mend before it has looked');

      await box.getByRole('button', { name: 'Check now' }).click();
      const standard = box.locator('.health-list li[data-store="standard"]');
      await standard.waitFor();
      assert.equal(await standard.evaluate((node) => node.classList.contains('bad')), true);
      assert.match(await standard.textContent(), /Standard library\s*4 cards, 3 Pokémon: 3 with no attacks and no abilities/);
      assert.match(await box.locator('.health-report .library-state').first().textContent(), /3 cards lack some of it/);
      assert.match(await box.locator('.health-list li[data-store="table"]').textContent(), /every Pokémon has what its card says/);
      assert.equal(await box.getByRole('button', { name: 'Repair' }).isEnabled(), true);

      await box.getByRole('button', { name: 'Repair' }).click();
      await box.locator('.library-state', { hasText: /Done: 3 library cards mended/ }).waitFor();
      assert.equal(await standard.evaluate((node) => node.classList.contains('good')), true);
      assert.match(await standard.textContent(), /all have their data/);
      assert.equal(await box.getByRole('button', { name: 'Repair' }).isDisabled(), true, 'nothing left to mend');

      // the card lookup has the attacks now
      const found = (await call('GET', '/api/cards/sv4-1')).json;
      assert.deepEqual([found.attacks.map((attack) => attack.name), found.retreat], [['Pikachu Attack'], 2]);
      assert.deepEqual(page.problems, []);
    });
  });

  describe('the Pokémon Tools', () => {
    it('are shown as pictures of their cards to begin with, by name only when asked, and the presets leave the way of drawing them alone', async () => {
      await openSettings('Overlay');
      const pictures = page.locator('.option-group label.switch', { hasText: 'Pokémon Tools as pictures of their cards' });
      const names = page.locator('.option-group label.switch', { hasText: 'Pokémon Tools by name' });
      assert.equal(await pictures.locator('input').isChecked(), true);
      assert.equal(await names.locator('input').isChecked(), false, 'the text is not the usual, but it is there for the designs that want it');
      assert.equal(await page.locator('.option-group label.switch', { hasText: 'Attached energy' }).count(), 1, 'the attachments are the energy: the tools have their own switches');

      await names.click();
      await until(async () => (await live()).settings.display.toolNames, true);
      await page.getByRole('button', { name: 'Show everything' }).click();
      await until(async () => (await live()).settings.display.toolCards, true);
      assert.equal((await live()).settings.display.toolNames, true, 'Show everything does not choose how the tools are drawn');
      await page.getByRole('button', { name: /^Minimal/ }).click();
      await until(async () => (await live()).settings.display.toolCards, false);
      assert.equal((await live()).settings.display.toolNames, true, 'and neither does Minimal');
      assert.deepEqual(page.problems, []);
    });
  });

  describe('the announcements table', () => {
    const box = (label) => page.getByRole('checkbox', { name: label, exact: true });
    const flags = async () => Object.fromEntries(Object.entries((await live()).settings).filter(([key]) => /^enable[A-Za-z_]*(Toast|Animation)$/.test(key)));
    const banners = async () => Object.entries(await flags()).filter(([key]) => /Toast$/.test(key));
    // (the effect for a bench KO is a column of its own)
    const effects = async () => Object.entries(await flags()).filter(([key]) => /Animation$/.test(key) && !/_OOC_/.test(key));
    const mixed = (label) => box(label).evaluate((input) => input.indeterminate);

    beforeEach(async () => {
      await openSettings('Overlay');
      await page.waitForSelector('.grid-table');
    });

    it('has an All column, a row that switches a whole column, and a row for the game pause that only has a banner', async () => {
      assert.deepEqual(await page.locator('.grid-table thead th').allTextContents(), ['Moment', 'Banner', 'Effect', 'Effect for a bench KO', 'All']);
      assert.equal(await page.locator('.grid-table tbody tr').first().locator('th').textContent(), 'All moments');
      const pause = page.locator('.grid-table tbody tr', { hasText: 'Game pause' });
      assert.equal(await pause.locator('input[type="checkbox"]').count(), 2, 'its banner, and the All of its row');
      assert.equal(await box('Game pause: banner').isChecked(), true);
      assert.equal(await box('Game pause: everything').isChecked(), true);
      assert.equal(await box('All: everything').isChecked(), true);
      assert.equal(await mixed('All: everything'), false);
    });

    it('switches every banner at once, and every effect at once, with the row of all moments', async () => {
      await box('All: banner').click();
      await until(async () => (await banners()).every(([, shown]) => shown === false), true);
      assert.ok((await banners()).length >= 9, 'all of them, the pause one too');
      assert.equal((await effects()).every(([, shown]) => shown === true), true, 'the effects are as they were');
      assert.equal(await box('All: banner').isChecked(), false);
      assert.equal(await box('Top Deck: banner').isChecked(), false);
      assert.equal(await box('Top Deck: effect').isChecked(), true);
      assert.equal(await mixed('All: everything'), true, 'some are on, some are off');
      assert.equal(await mixed('Top Deck: everything'), true);

      await box('All: effect').click();
      await until(async () => (await effects()).every(([, shown]) => shown === false), true);
      assert.equal(await box('All: everything').isChecked(), false);
      assert.equal(await mixed('All: everything'), true, 'the effects for a bench KO are a column of their own, and are still on');

      await box('All: effect for a bench ko').click();
      await until(async () => (await live()).settings.enableTrainerAKO_OOC_Animation, false);
      assert.equal(await mixed('All: everything'), false, 'nothing is on now');
      assert.equal(await box('All: everything').isChecked(), false);

      await box('All: banner').click();
      await until(async () => (await banners()).every(([, shown]) => shown === true), true);
      assert.equal((await effects()).every(([, shown]) => shown === false), true);
    });

    it('switches a whole moment with the All of its row, bench effect included', async () => {
      await box('Knock out · Trainer A: everything').click();
      await until(async () => (await live()).settings.enableTrainerAKOToast, false);
      const settings = (await live()).settings;
      assert.deepEqual([settings.enableTrainerAKOToast, settings.enableTrainerAKOAnimation, settings.enableTrainerAKO_OOC_Animation], [false, false, false]);
      assert.equal(settings.enableTrainerBKOToast, true, 'the other moments are as they were');
      assert.equal(await box('Knock out · Trainer A: effect for a bench ko').isChecked(), false);
      assert.equal(await mixed('All: banner'), true, 'one banner is off, the others are on');

      await box('Knock out · Trainer A: everything').click();
      await until(async () => (await live()).settings.enableTrainerAKO_OOC_Animation, true);
      assert.equal(await box('All: banner').isChecked(), true);
    });

    it('turns a row, a column or everything on from the dash that says some are off', async () => {
      await box('Top Deck: banner').click();
      await until(async () => (await live()).settings.enableTopDeckToast, false);
      assert.equal(await mixed('Top Deck: everything'), true);
      await box('Top Deck: everything').click();
      await until(async () => (await live()).settings.enableTopDeckToast, true);
      assert.equal(await mixed('Top Deck: everything'), false);
      assert.equal(await box('Top Deck: everything').isChecked(), true);

      await box('All: everything').click();
      await until(async () => Object.values(await flags()).every((shown) => shown === false), true);
      await box('All: everything').click();
      await until(async () => Object.values(await flags()).every((shown) => shown === true), true);
      assert.deepEqual(page.problems, []);
    });

    it('keeps what was chosen when the settings are opened again', async () => {
      await box('Pass turn: everything').click();
      await until(async () => (await live()).settings.enablePassTurnToast, false);
      await page.keyboard.press('Escape');
      await openSettings('Overlay');
      assert.equal(await box('Pass turn: banner').isChecked(), false);
      assert.equal(await box('Pass turn: effect').isChecked(), false);
      assert.equal(await box('Pass turn: everything').isChecked(), false);
    });
  });

  describe('what the card picker remembers', () => {
    const listed = async () => (await call('GET', '/api/cards/popular')).json;

    it('forgets the most used cards on their own, and the saved searches on their own', async () => {
      await call('GET', '/api/cards/search?q=pika'); // saves what it finds
      await call('POST', '/api/cards/used', { id: 'sv5-3', name: 'Eevee', supertype: 'Pokémon', subtypes: 'Basic', images: {} });
      assert.deepEqual([(await listed()).used, (await listed()).totalCount], [1, 4], 'Eevee was used and is one of the four the search saved: listed once');

      await openSettings('Cards');
      assert.match(await page.locator('.modal').textContent(), /The card picker starts from the cards you use most/);
      await page.getByRole('button', { name: 'Forget', exact: true }).click();
      const forget = page.locator('.modal[aria-label="Forget the most used cards?"]');
      await forget.waitFor();
      await forget.getByRole('button', { name: 'Forget', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.toast-success')?.textContent === 'Forgotten');
      assert.deepEqual([(await listed()).used, (await listed()).totalCount], [0, 4], 'what was saved stays');

      await page.locator('.modal[aria-label="Settings"]').getByRole('button', { name: 'Clear', exact: true }).click();
      await page.locator('.modal[aria-label="Clear remembered searches?"]').getByRole('button', { name: 'Clear', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.toast-success')].some((toast) => toast.textContent === 'Cleared'));
      assert.deepEqual((await listed()).totalCount, 0, 'and now that is gone too');
      assert.deepEqual(page.problems, []);
    });

    it('does not forget a thing when told no', async () => {
      await call('POST', '/api/cards/used', { id: 'sv5-3', name: 'Eevee', supertype: 'Pokémon', subtypes: 'Basic', images: {} });
      await openSettings('Cards');
      await page.getByRole('button', { name: 'Forget', exact: true }).click();
      await page.locator('.modal[aria-label="Forget the most used cards?"]').getByRole('button', { name: 'Cancel' }).click();
      await wait(200);
      assert.equal((await listed()).used, 1);
    });
  });

  describe('the keys of the card services', () => {
    const row = (setting) => page.locator(`.credential-row[data-setting="${setting}"]`);
    const KEY = '3f9a1c52-8d44-4e07-9b6e-0a1d2c3b4e5f';

    it('saves a key, shows only its ends, and changes or removes it', async () => {
      await openSettings('Cards');
      await row('apiKey').locator('input[type="password"]').fill(KEY);
      await row('apiKey').getByRole('button', { name: 'Save', exact: true }).click();
      await row('apiKey').locator('.secret-mask').waitFor();
      assert.equal(await row('apiKey').locator('.secret-mask').textContent(), '3f9***4e5f');
      assert.equal((await page.content()).includes(KEY), false, 'the key is nowhere on the page');

      await row('apiKey').getByRole('button', { name: /^Change the / }).click();
      assert.equal(await row('apiKey').locator('input[type="password"]').count(), 1);
      await row('apiKey').getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await row('apiKey').locator('.secret-mask').textContent(), '3f9***4e5f', 'nothing changed');

      await row('apiKey').getByRole('button', { name: /^Remove the / }).click();
      await row('apiKey').locator('input[type="password"]').waitFor();
      assert.equal((await call('GET', '/api/settings')).json.keys.apiKey, '');
      assert.deepEqual(page.problems, []);
    });

    it('refuses what cannot be a key, and says why', async () => {
      await openSettings('Cards');
      await row('apiKey').locator('input[type="password"]').fill('has a space');
      await row('apiKey').getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForSelector('.toast-error');
      assert.match(await page.locator('.toast-error').first().textContent(), /does not look like a key/);
      assert.equal(await row('apiKey').locator('.secret-mask').count(), 0);
      assert.equal((await call('GET', '/api/settings')).json.keys.apiKey, '');
    });

    it('cannot build the libraries from Scrydex until its key and team are saved', async () => {
      await openSettings('Cards');
      const option = page.locator('select[aria-label="Build the libraries from"] option[value="scrydex"]');
      assert.equal(await option.evaluate((node) => node.disabled), true);
      assert.match(await option.textContent(), /needs its key/);
      assert.equal(await page.locator('select[aria-label="Build the libraries from"] option[value="tcgdex"]').evaluate((node) => node.disabled), false, 'TCGdex needs none');
    });
  });

  describe('card library', () => {
    it('shows the libraries, downloads one in the background and uses it for searching', async () => {
      await openSettings('Cards');
      await page.waitForSelector('.library-row:has-text("Standard")');
      assert.equal(await page.locator('.library-row').count(), 4, 'online only, and the three libraries');
      assert.equal(await page.locator('.library-row:has-text("Search online only") input').isChecked(), true);
      assert.match(await library('Standard').textContent(), /Not downloaded · about 3,000 cards/);
      assert.match(await library('Standard').textContent(), /no regulation mark but are legal in Standard/, 'the cards that have no mark are part of it');

      await library('Standard').locator('button', { hasText: 'Download' }).click();
      await libraryReady('Standard');
      assert.match(await library('Standard').textContent(), /4 cards · .* MB · saved/);
      assert.doesNotMatch(await library('Standard').textContent(), /Update to add/, 'a library that was just saved is not out of date');
      assert.equal(await library('Standard').locator('input').isChecked(), true, 'the first library downloaded is the one in use');
      await page.waitForSelector('.toast-success');
      assert.match(await page.locator('.toast-success').first().textContent(), /Standard is ready: 4 cards/);

      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal', { state: 'detached' });
      await page.keyboard.press('a');
      await page.locator('.search-input').fill('pika');
      await page.waitForSelector('.card-tile');
      assert.match(await page.locator('.picker-status').textContent(), /1 cards found in your Standard library/);
      assert.match(await page.locator('.card-tile img').first().getAttribute('src'), /^\/img\/sv4\/1\.png$/);
      await page.keyboard.press('Escape');
    });

    it('asks first before a big download, and does nothing if told no', async () => {
      await openSettings('Cards');
      await library('Expanded').locator('button', { hasText: 'Download' }).click();
      await page.waitForSelector('.modal[aria-label="Download the Expanded library?"]');
      assert.match(await page.locator('.modal[aria-label="Download the Expanded library?"]').textContent(), /about 15,000 cards/);
      await page.locator('.modal[aria-label="Download the Expanded library?"] button', { hasText: 'Cancel' }).click();
      const status = (await call('GET', '/api/catalog')).json;
      assert.equal(status.profiles[2].ready, false);
      assert.equal(status.profiles[2].building, false, 'nothing was started');

      await library('Expanded').locator('button', { hasText: 'Download' }).click();
      await page.locator('.modal[aria-label="Download the Expanded library?"] button', { hasText: 'Download' }).click();
      await libraryReady('Expanded');
      assert.match(await library('Expanded').textContent(), /4 cards/);
    });

    it('updates a library without asking first, bringing only what is new, and says how it went', async () => {
      await call('POST', '/api/catalog/expanded/download', { confirm: true });
      await openSettings('Cards');
      await libraryReady('Expanded');
      assert.match(await library('Expanded').textContent(), /saved .* · from Pokémon TCG API/);
      const update = library('Expanded').locator('button', { hasText: 'Update' });
      assert.equal(await update.getAttribute('title'), 'Brings only the cards that are new');
      await update.click();
      // (the message of the download that made the library is still there until the update says how it went: wait for that one)
      await library('Expanded').locator('.library-done', { hasText: 'up to date' }).waitFor();
      assert.equal(await library('Expanded').locator('.library-done').textContent(), 'Expanded is up to date: 4 cards. Nothing new.');
      assert.equal(await page.locator('.modal[aria-label="Download the Expanded library?"]').count(), 0, 'no question: it is not a big download');
    });

    it('says when Update will download a library again from another service, and which libraries only the Pokémon TCG API builds', async () => {
      await call('POST', '/api/catalog/standard/download', {});
      await openSettings('Cards');
      await libraryReady('Standard');
      assert.equal(await library('Expanded').locator('.library-note').count(), 0, 'nothing to say while the Pokémon TCG API is chosen');
      await page.locator('select[aria-label="Build the libraries from"]').selectOption('tcgdex');
      await library('Standard').locator('.library-new', { hasText: 'Update downloads it again from TCGdex' }).waitFor();
      assert.equal(await library('Standard').locator('button', { hasText: 'Update' }).getAttribute('title'), 'Downloads the whole library again from TCGdex');
      assert.match(await library('Expanded').locator('.library-note').textContent(), /Built from Pokémon TCG API: it is the only service that says what is legal in Expanded/);
      assert.equal(await library('Standard').locator('.library-note').count(), 0, 'Standard can come from TCGdex');
      assert.deepEqual(page.problems, []);
    });

    it('switches between a library and the online search, and removes a library', async () => {
      await call('POST', '/api/catalog/standard/download', {});
      await openSettings('Cards');
      await libraryReady('Standard');
      await page.locator('.library-row:has-text("Search online only") input').check();
      await page.waitForFunction(() => document.querySelector('.library-row.on')?.textContent.includes('Search online only'));
      assert.equal((await call('GET', '/api/catalog')).json.active, null);
      await library('Standard').locator('input').check();
      await page.waitForFunction(() => document.querySelector('.library-row.on')?.textContent.includes('Standard'));

      await library('Standard').locator('button', { hasText: 'Remove' }).click();
      await page.locator('.modal[aria-label="Remove the Standard library?"] button', { hasText: 'Remove' }).click();
      await library('Standard').locator('button:has-text("Download")').waitFor();
      assert.equal((await call('GET', '/api/catalog')).json.active, null);
    });

    it('saves the pictures ahead of time and counts them', async () => {
      await call('POST', '/api/catalog/standard/download', {});
      await openSettings('Cards');
      await libraryReady('Standard');
      assert.match(await page.locator('.library-pictures').textContent(), /0 pictures saved/);

      await page.locator('.library-pictures label', { hasText: 'Small pictures (what the card search shows)' }).click();
      await page.locator('.library-pictures button', { hasText: 'Save pictures' }).click();
      await page.waitForFunction(() => /4 pictures saved/.test(document.querySelector('.library-pictures')?.textContent || ''));
      assert.equal(host.requests.filter((url) => !url.includes('hires')).length >= 4, true);

      await page.locator('.library-pictures button', { hasText: 'Delete saved pictures' }).click();
      await page.locator('.modal[aria-label="Delete the saved pictures?"] button', { hasText: 'Delete' }).click();
      await page.waitForFunction(() => /0 pictures saved/.test(document.querySelector('.library-pictures')?.textContent || ''));
    });
  });
});
