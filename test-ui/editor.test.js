/**
 * The design editor in a real browser: creating a design, the canvas (drag, resize, snap, zoom, pan, pinch),
 * the code view, the card crop selector, and saving.
 * Run with: npm run test:ui
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wait } = require('../test-support/harness');
const S = require('../test-support/samples');
const { findBrowser, launch, openPage } = require('./browser');

const skip = findBrowser() ? false : 'no Chrome or Edge found (set BROWSER_PATH to use another)';
const THEME_OPTIONS = require('../public/js/theme-options');

describe('design editor', { skip }, () => {
  let browser;
  let server;
  let page;
  let nativeDialogs;

  before(async () => {
    server = await startServer({ label: 'ui-editor' });
    browser = await launch();
  });
  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  });

  const api = async (method, route, body, raw) => {
    const response = await fetch(`${server.base}${route}`, { method, headers: raw ? {} : { 'Content-Type': 'application/json' }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  beforeEach(async () => {
    const { json } = await api('GET', '/api/themes');
    await api('POST', '/api/theme/active', { name: null });
    for (const name of json.names) await api('DELETE', `/api/themes/${encodeURIComponent(name)}`);
    page = await openPage(browser, `${server.base}/control`, { viewport: { width: 1700, height: 960 } });
    nativeDialogs = [];
    page.on('dialog', async (dialog) => { nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`); await dialog.dismiss(); });
    await page.waitForSelector('.trainer-panel.side-a');
  });
  afterEach(async () => {
    assert.deepEqual(nativeDialogs, [], 'nothing asked through the browser\'s own dialogs (the desktop app has none)');
    await page.context().close();
  });

  // ---- helpers
  const editorModal = (name) => page.locator(`.modal[aria-label="Design: ${name}"]`);
  const overlayFrame = () => page.frames().find((frame) => frame.url().includes('editor=1'));
  const editor = (read) => page.evaluate(read);
  const layout = () => page.evaluate(() => JSON.parse(JSON.stringify(window.oto.designEditor.model.draft.layout)));
  const crop = () => page.evaluate(() => JSON.parse(JSON.stringify(window.oto.designEditor.model.draft.crop)));
  const zoom = () => page.evaluate(() => window.oto.designEditor.canvas.view.zoom);
  const view = () => page.evaluate(() => ({ ...window.oto.designEditor.canvas.view }));
  const box = (key) => page.locator(`.editor-box[data-key="${key}"]`);
  // wait until the overlay in the frame has drawn the design the editor holds
  const drawn = async () => { await wait(120); await page.waitForFunction(() => Object.keys(window.oto.designEditor.canvas.rects).length > 0); };

  async function openEditorFor(name, design = {}) {
    await api('PUT', `/api/themes/${encodeURIComponent(name)}`, { colors: {}, ...design });
    await page.locator('button[aria-label="Settings"]').click();
    await page.locator('.tab', { hasText: 'Look' }).click();
    await page.locator('.theme-item', { hasText: name }).click();
    await page.locator('button', { hasText: 'Layout and crop' }).click();
    await editorModal(name).waitFor();
    await page.waitForFunction(() => window.oto.designEditor && Object.keys(window.oto.designEditor.canvas.rects).length > 0);
    await wait(150);
  }

  // drag from the middle of a piece by (dx, dy) screen pixels
  async function dragPiece(key, dx, dy, { alt = false, steps = 6 } = {}) {
    const rect = await box(key).boundingBox();
    const from = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await page.mouse.move(from.x, from.y);
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps });
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
    await wait(80);
  }

  describe('making a design', () => {
    it('asks for the name in the app, refuses a bad or used one, and opens the editor on the new design', async () => {
      await api('PUT', '/api/themes/Taken', { colors: {} });
      await page.locator('button[aria-label="Settings"]').click();
      await page.locator('.tab', { hasText: 'Look' }).click();
      await page.locator('.theme-list').getByRole('button', { name: 'New', exact: true }).click();
      const ask = page.locator('.modal[aria-label="Create a design"]');
      await ask.waitFor();
      const create = ask.getByRole('button', { name: 'Create', exact: true });

      assert.equal(await create.isDisabled(), true, 'nothing to create yet');
      await ask.locator('input').fill('taken');
      assert.match(await ask.locator('.prompt-complaint').textContent(), /already have a design with that name/);
      assert.equal(await create.isDisabled(), true);
      await ask.locator('input').fill('!!!');
      assert.match(await ask.locator('.prompt-complaint').textContent(), /at least one letter or digit/);
      await ask.locator('input').fill('Friday Night');
      assert.equal(await ask.locator('.prompt-complaint').isHidden(), true);
      assert.equal(await create.isDisabled(), false);

      await ask.locator('input').press('Enter');
      await editorModal('Friday Night').waitFor();
      assert.deepEqual((await api('GET', '/api/themes')).json.names, ['Friday Night', 'Taken']);
      assert.equal(await page.locator('.theme-head h3').textContent(), 'Friday Night', 'and it is the one chosen behind the editor');
      assert.deepEqual(page.problems, []);
    });

    it('can be cancelled, with Escape or the button, and creates nothing', async () => {
      await page.locator('button[aria-label="Settings"]').click();
      await page.locator('.tab', { hasText: 'Look' }).click();
      await page.locator('button', { hasText: 'Create a design' }).click();
      const ask = page.locator('.modal[aria-label="Create a design"]');
      await ask.locator('input').fill('Nope');
      await page.keyboard.press('Escape');
      await ask.waitFor({ state: 'detached' });
      await page.locator('button', { hasText: 'Create a design' }).click();
      await page.locator('.modal[aria-label="Create a design"]').getByRole('button', { name: 'Cancel' }).click();
      assert.deepEqual((await api('GET', '/api/themes')).json.names, []);
      assert.equal(await page.locator('.modal[aria-label="Settings"]').count(), 1, 'the settings are still open behind it');
    });
  });

  describe('the canvas', () => {
    beforeEach(async () => { await openEditorFor('Canvas Test'); });

    it('draws the real overlay at full size, with a handle for every piece that is showing', async () => {
      const frame = overlayFrame();
      assert.ok(frame, 'the overlay is in a frame');
      assert.deepEqual(await frame.evaluate(() => [document.getElementById('stage').getBoundingClientRect().width, window.oto.editor]), [1920, true]);
      assert.equal(await page.$eval('.editor-frame', (node) => `${node.offsetWidth}x${node.offsetHeight}`), '1920x1080');

      const shown = await page.$$eval('.editor-box:not([hidden])', (nodes) => nodes.map((node) => node.dataset.key).sort());
      assert.ok(shown.includes('scoreboard') && shown.includes('trainerA.active') && shown.includes('trainerB.bench') && shown.includes('stadium') && shown.includes('features'), shown.join(' '));
      assert.ok(!shown.includes('logo'), 'a design with no logo has no logo to move');
      assert.equal(await page.locator('.editor-box[data-key="logo"]').isHidden(), true);
      // each box is where the overlay really has the piece
      const frameRects = await frame.evaluate(() => window.oto.blockRects());
      const scoreboard = await page.$eval('.editor-box[data-key="scoreboard"]', (node) => ({ x: parseFloat(node.style.left), y: parseFloat(node.style.top), w: parseFloat(node.style.width), h: parseFloat(node.style.height) }));
      assert.deepEqual(scoreboard, { x: frameRects.scoreboard.x, y: frameRects.scoreboard.y, w: frameRects.scoreboard.w, h: frameRects.scoreboard.h });
      // the made-up match fills everything
      assert.equal(await frame.locator('.sb-name').first().textContent(), 'Ash');
      assert.equal(await frame.locator('.trainer-b .prize.penalty').count(), 1, 'even a penalty (Ash has one: Gary\'s prize card is red), so it can be placed');
      assert.deepEqual(page.problems, []);
    });

    it('fits the whole stage in the window, and keeps it fitted when the window changes', async () => {
      const first = await view();
      const area = await page.$eval('.editor-viewport', (node) => ({ w: node.clientWidth, h: node.clientHeight }));
      assert.ok(first.zoom > 0.3 && first.zoom < 1.2 && 1920 * first.zoom <= area.w && 1080 * first.zoom <= area.h, `zoom ${first.zoom} in ${area.w}x${area.h}`);
      assert.ok(Math.abs(first.x - (area.w - 1920 * first.zoom) / 2) < 1, 'centred');
      await page.setViewportSize({ width: 1300, height: 800 });
      await wait(250);
      assert.ok((await zoom()) < first.zoom, 'smaller window, smaller picture');
    });

    it('moves a piece by dragging it, keeps it in the code, and undoes it', async () => {
      const before = (await overlayFrame().evaluate(() => window.oto.blockRects().scoreboard));
      const z = await zoom();
      await dragPiece('scoreboard', 0, 90, { alt: true }); // Alt: no snapping, so the numbers are plain
      const moved = (await layout()).scoreboard;
      assert.ok(Math.abs(moved.y - 90 / z) <= 2, `moved ${moved.y} stage pixels for 90 screen pixels at ${z}`);
      assert.equal(moved.x, 0);
      assert.equal(moved.scale, 1);

      await drawn();
      const after = await overlayFrame().evaluate(() => window.oto.blockRects().scoreboard);
      assert.ok(Math.abs(after.y - before.y - moved.y) < 1.5, 'the overlay in the frame moved the same');
      assert.equal(await overlayFrame().locator('.scoreboard.moved').count(), 1);

      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
      assert.deepEqual(JSON.parse(await page.locator('.code-input').inputValue()).layout, { scoreboard: moved }, 'and the code says so');
      assert.match(await page.locator('.editor-status').textContent(), /Unsaved changes/);

      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+z');
      await drawn();
      assert.deepEqual(await layout(), {}, 'one undo takes the whole drag back');
      await page.keyboard.press('Control+y');
      assert.deepEqual((await layout()).scoreboard, moved, 'and redo brings it back');
    });

    it('selects a piece on a click, and the piece at the front when they overlap', async () => {
      await box('trainerA.active').click();
      assert.equal(await page.evaluate(() => window.oto.designEditor.canvas.selected), 'trainerA.active');
      assert.equal(await page.locator('.editor-selection').isVisible(), true);
      assert.match(await page.locator('.editor-selection-label').textContent(), /Trainer A: Active Pokémon/);
      assert.equal(await page.locator('.block-item.on').textContent(), 'Trainer A: Active Pokémon');

      // a click on the empty part of the canvas lets go
      const empty = await page.$eval('.editor-viewport', (node) => { const r = node.getBoundingClientRect(); return { x: r.left + 8, y: r.top + 8 }; });
      await page.mouse.click(empty.x, empty.y);
      assert.equal(await page.evaluate(() => window.oto.designEditor.canvas.selected), null);
      assert.equal(await page.locator('.editor-selection').isHidden(), true);
      assert.equal(await page.locator('.block-fields').isHidden(), true);

      // the list works too, and a piece that is not showing can still be chosen there
      await page.locator('.block-item', { hasText: 'Logo' }).click();
      assert.equal(await page.evaluate(() => window.oto.designEditor.canvas.selected), 'logo');
      assert.equal(await page.locator('.block-item', { hasText: 'Logo' }).getAttribute('title'), 'Not showing right now (it is empty)');
    });

    it('resizes a piece from a corner, about its centre', async () => {
      await box('stadium').click();
      const rect = await overlayFrame().evaluate(() => window.oto.blockRects().stadium);
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const handle = await page.locator('.editor-handle.se').boundingBox();
      const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      const z = await zoom();
      const toward = { x: from.x + (rect.w / 2) * z, y: from.y + (rect.h / 2) * z }; // twice as far from the centre
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(toward.x, toward.y, { steps: 6 });
      await page.mouse.up();
      await drawn();
      const entry = (await layout()).stadium;
      assert.ok(entry.scale > 1.8 && entry.scale < 2.2, `scale ${entry.scale}`);
      const grown = await overlayFrame().evaluate(() => window.oto.blockRects().stadium);
      assert.ok(Math.abs(grown.x + grown.w / 2 - center.x) < 2 && Math.abs(grown.y + grown.h / 2 - center.y) < 2, 'it grew about its middle');
      assert.ok(Math.abs(grown.w / rect.w - entry.scale) < 0.05);
    });

    it('moves a piece with the arrow keys, ten at a time with Shift, and puts it back with Delete', async () => {
      await box('scoreboard').click();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      assert.deepEqual((await layout()).scoreboard, { x: 2, y: 1, scale: 1 });
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowUp');
      assert.deepEqual((await layout()).scoreboard, { x: -8, y: -9, scale: 1 });
      await wait(650); // a run of key presses is one step
      await page.keyboard.press('Control+z');
      assert.deepEqual(await layout(), {}, 'all five presses were one step');
      await page.keyboard.press('Control+y');
      assert.deepEqual((await layout()).scoreboard, { x: -8, y: -9, scale: 1 });
      await page.keyboard.press('Delete');
      assert.deepEqual(await layout(), {}, 'back where it was');
    });

    it('lines pieces up with the middle and the edges of the stage, and shows the line while it does', async () => {
      // the scoreboard is centred; nudge it a few pixels away and it pulls back onto the line
      const z = await zoom();
      const rect = await box('scoreboard').boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width / 2 + 6 * z, rect.y + rect.height / 2, { steps: 4 });
      assert.equal(await page.locator('.editor-guide.x').count(), 1, 'a line shows while it is lined up');
      await page.mouse.up();
      assert.equal(await page.locator('.editor-guide').count(), 0, 'and goes when it is let go');
      assert.deepEqual(await layout(), {}, 'snapped back onto the centre, which is where it was');

      // with Alt it does not snap
      await dragPiece('scoreboard', 6 * z, 0, { alt: true });
      assert.equal((await layout()).scoreboard.x, 6);

      // and the switch turns it off for good
      await page.keyboard.press('Control+z');
      await page.locator('.switch', { hasText: 'Snap to lines' }).click();
      await dragPiece('scoreboard', 6 * z, 0);
      assert.equal((await layout()).scoreboard.x, 6);
    });

    it('zooms with the mouse wheel around the pointer, with a pinch, and with the buttons and keys', async () => {
      const area = await page.locator('.editor-viewport').boundingBox();
      const at = { x: area.x + area.width * 0.3, y: area.y + area.height * 0.4 };
      const stagePoint = () => page.evaluate(({ x, y }) => window.oto.designEditor.canvas.toStage(x, y), at);
      const before = await stagePoint();
      const z0 = await zoom();

      await page.mouse.move(at.x, at.y);
      await page.mouse.wheel(0, -100); // one notch of a mouse wheel, toward the screen: zoom in
      await wait(60);
      const z1 = await zoom();
      assert.ok(z1 > z0 * 1.1 && z1 < z0 * 1.2, `zoomed in from ${z0} to ${z1}`);
      const after = await stagePoint();
      assert.ok(Math.abs(after.x - before.x) < 0.5 && Math.abs(after.y - before.y) < 0.5, 'the point under the pointer stays under it');
      assert.equal(await page.locator('.zoom-readout').textContent(), `${Math.round(z1 * 100)}%`);

      await page.mouse.wheel(0, 100); // and out again
      await wait(60);
      assert.ok(Math.abs((await zoom()) - z0) < 0.001);

      // a pinch on a trackpad arrives as a wheel turn with Ctrl held
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -50);
      await page.keyboard.up('Control');
      await wait(60);
      assert.ok((await zoom()) > z0 * 1.4, 'a pinch zooms a good deal more smoothly');

      await page.locator('.toolbar-group button[title="Show the whole overlay (0)"]').click();
      assert.ok(Math.abs((await zoom()) - z0) < 0.001, 'Fit');
      await page.locator('.toolbar-group button[title="One pixel is one pixel (1)"]').click();
      assert.equal(await zoom(), 1, '100%');
      await page.locator('.editor-viewport').focus();
      await page.keyboard.press('-');
      assert.ok(Math.abs((await zoom()) - 1 / 1.2) < 0.001);
      await page.keyboard.press('0');
      assert.ok(Math.abs((await zoom()) - z0) < 0.001);
      assert.ok(Math.abs(await page.locator('.zoom-readout').evaluate((node) => parseFloat(node.textContent)) - Math.round(z0 * 100)) < 1);

      // never wildly far in or out
      for (let i = 0; i < 40; i++) await page.locator('button[title="Zoom in (+)"]').click({ delay: 0 });
      assert.equal(await zoom(), 4);
      for (let i = 0; i < 60; i++) await page.locator('button[title="Zoom out (-)"]').click({ delay: 0 });
      assert.equal(await zoom(), 0.1);
    });

    it('pans with Space and a drag, with the middle button, and with a two-finger scroll', async () => {
      const area = await page.locator('.editor-viewport').boundingBox();
      const start = await view();
      await page.locator('.editor-viewport').focus();
      await page.mouse.move(area.x + 200, area.y + 200);
      await page.keyboard.down(' ');
      await page.mouse.down();
      await page.mouse.move(area.x + 260, area.y + 230, { steps: 4 });
      await page.mouse.up();
      await page.keyboard.up(' ');
      let now = await view();
      assert.ok(Math.abs(now.x - start.x - 60) < 1 && Math.abs(now.y - start.y - 30) < 1, `panned ${now.x - start.x},${now.y - start.y}`);
      assert.equal(await page.$eval('.editor-viewport', (node) => node.classList.contains('panning')), false);

      // the middle button
      await page.mouse.move(area.x + 300, area.y + 300);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(area.x + 280, area.y + 330, { steps: 3 });
      await page.mouse.up({ button: 'middle' });
      const after = await view();
      assert.ok(Math.abs(after.x - now.x + 20) < 1 && Math.abs(after.y - now.y - 30) < 1);

      // two fingers sliding on a trackpad: small, fractional wheel turns
      now = await view();
      await page.evaluate(() => {
        const node = document.querySelector('.editor-viewport');
        node.dispatchEvent(new WheelEvent('wheel', { deltaX: 12.5, deltaY: 7.25, deltaMode: 0, bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
      });
      const slid = await view();
      assert.ok(Math.abs(slid.x - now.x + 12.5) < 0.01 && Math.abs(slid.y - now.y + 7.25) < 0.01);
      assert.equal(slid.zoom, now.zoom, 'sliding does not zoom');
      assert.equal(await box('scoreboard').count(), 1, 'a click on nothing after a pan does not matter');
    });

    it('zooms and pans with two fingers on a touch screen', async () => {
      const client = await page.context().newCDPSession(page);
      const area = await page.locator('.editor-viewport').boundingBox();
      const cx = area.x + area.width / 2;
      const cy = area.y + area.height / 2;
      const z0 = await zoom();
      const touch = (type, points) => client.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
      await touch('touchStart', [[cx - 50, cy], [cx + 50, cy]]);
      for (let step = 1; step <= 6; step++) await touch('touchMove', [[cx - 50 - step * 10, cy], [cx + 50 + step * 10, cy]]);
      await touch('touchEnd', []);
      await wait(100);
      const z1 = await zoom();
      assert.ok(z1 > z0 * 1.8 && z1 < z0 * 2.6, `fingers moved from 100 to 220 apart: zoom ${z0} -> ${z1}`);
      assert.equal(await page.evaluate(() => window.oto.designEditor.canvas.pinch), null, 'it lets go when the fingers lift');
    });
  });

  describe('the layout panel', () => {
    beforeEach(async () => { await openEditorFor('Panel Test', { layout: { scoreboard: { x: 0, y: 30, scale: 1 } } }); });

    it('lists the pieces, marks the ones that have moved, and edits numbers', async () => {
      assert.equal(await page.locator('.block-item').count(), 17, 'all 17 pieces');
      assert.equal(await page.locator('.block-item.moved').count(), 1);
      assert.equal(await page.locator('.block-item.moved').textContent(), 'Scoreboard');

      await page.locator('.block-item', { hasText: 'Stadium' }).click();
      const fields = page.locator('.block-fields');
      assert.equal(await fields.locator('strong').textContent(), 'Stadium');
      await fields.locator('input[aria-label="Across"]').fill('40');
      await fields.locator('input[aria-label="Across"]').press('Tab');
      await fields.locator('input[aria-label="Down"]').fill('-25');
      await fields.locator('input[aria-label="Down"]').press('Tab');
      await fields.locator('input[aria-label="Size"]').fill('1.5');
      await fields.locator('input[aria-label="Size"]').press('Tab');
      assert.deepEqual((await layout()).stadium, { x: 40, y: -25, scale: 1.5 });
      await drawn();
      assert.equal(await page.locator('.block-item.moved').count(), 2);

      // numbers outside what is allowed are brought back inside
      await fields.locator('input[aria-label="Size"]').fill('99');
      await fields.locator('input[aria-label="Size"]').press('Tab');
      assert.equal((await layout()).stadium.scale, 4);

      await fields.getByRole('button', { name: 'Put it back' }).click();
      assert.equal('stadium' in (await layout()), false);
      await page.getByRole('button', { name: 'Put everything back' }).click();
      assert.deepEqual(await layout(), {});
      assert.equal(await page.getByRole('button', { name: 'Put everything back' }).isDisabled(), true);
    });
  });

  describe('the code view', () => {
    beforeEach(async () => {
      await openEditorFor('Code Test');
      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
    });
    const input = () => page.locator('.code-input');
    const type = async (text) => { await input().fill(text); await wait(450); };

    it('shows the design as text, with line numbers', async () => {
      const text = await input().inputValue();
      assert.deepEqual(JSON.parse(text), { author: '', description: '', colors: {}, layout: {}, crop: {}, tile: {} });
      assert.equal(await page.locator('.code-gutter').textContent(), Array.from({ length: text.split('\n').length }, (_, i) => i + 1).join('\n'));
    });

    it('moves the overlay as you type, and says what is wrong while it is not valid', async () => {
      await type(JSON.stringify({ layout: { scoreboard: { x: 0, y: 120, scale: 1 } } }, null, 2));
      assert.equal((await layout()).scoreboard.y, 120);
      await drawn();
      assert.equal(await overlayFrame().locator('.scoreboard.moved').count(), 1);
      assert.equal(await page.locator('.code-status').textContent(), 'Applied.');

      await type('{\n  "layout": {\n    "scoreboard": { "x": 5, "y": 5 "scale": 1 }\n  }\n}');
      assert.match(await page.locator('.code-status').textContent(), /^Line 3, column \d+: .*The overlay keeps the last version that made sense/);
      assert.equal(await input().getAttribute('aria-invalid'), 'true');
      assert.equal((await layout()).scoreboard.y, 120, 'nothing changed');

      await type(JSON.stringify({ layout: { scoreboard: { x: 5000, y: 0, scale: 1 } } }));
      assert.match(await page.locator('.code-status').textContent(), /between -1920 and 1920/);
      await type(JSON.stringify({ layout: { nowhere: { x: 1 } } }));
      assert.match(await page.locator('.code-status').textContent(), /no piece of the overlay called "nowhere"/);
      await type(JSON.stringify({ crop: { active: { x: 0.9, y: 0, w: 0.5, h: 0.5 } } }));
      assert.match(await page.locator('.code-status').textContent(), /inside the card/);
      await type('[1, 2]');
      assert.match(await page.locator('.code-status').textContent(), /must be an object/);
      await type(JSON.stringify({ colors: { '--accent': 'red; background: url(http://evil)' } }));
      assert.match(await page.locator('.code-status').textContent(), /Invalid value for --accent/);
      assert.equal((await layout()).scoreboard.y, 120, 'still the last good version');

      await type(JSON.stringify({ author: 'Mina', colors: { '--accent': '#ff00aa' }, mystery: 1 }));
      assert.match(await page.locator('.code-status').textContent(), /Not used: mystery/);
      assert.deepEqual(await layout(), {}, 'what the text does not mention is cleared');
      assert.equal(await page.evaluate(() => window.oto.designEditor.model.draft.author), 'Mina');
      await drawn();
      assert.equal(await overlayFrame().evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#ff00aa');
    });

    it('writes what the mouse does back into the text, and formats it', async () => {
      await page.locator('.editor-side .tab', { hasText: 'Layout' }).click();
      await page.locator('.block-item', { hasText: 'Feature cards' }).click();
      await page.keyboard.press('ArrowDown');
      await wait(100);
      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
      assert.deepEqual(JSON.parse(await input().inputValue()).layout, { features: { x: 0, y: 1, scale: 1 } });

      await type('{"layout":{"features":{"x":0,"y":1,"scale":1}},   "author":"A"}');
      await page.getByRole('button', { name: 'Format' }).click();
      const formatted = await input().inputValue();
      assert.match(formatted, /^\{\n  "author": "A",\n/);
      assert.equal(await page.locator('.code-status').textContent(), 'Formatted.');
    });

    it('lets Tab write two spaces instead of leaving the box', async () => {
      await input().click();
      await input().press('Control+End');
      const before = await input().inputValue();
      await input().press('Tab');
      assert.equal(await input().inputValue(), `${before}  `);
      assert.equal(await page.evaluate(() => document.activeElement.className.includes('code-input')), true);
    });
  });

  describe('the tile panel', () => {
    beforeEach(async () => {
      await openEditorFor('Tile Test');
      await page.locator('.editor-side .tab', { hasText: 'Tile' }).click();
    });
    const tile = () => page.evaluate(() => JSON.parse(JSON.stringify(window.oto.designEditor.model.draft.tile)));
    const choose = (group, part, place) => page.locator(`select[aria-label="${group}: ${part}"]`).selectOption(place);
    const value = (group, part) => page.locator(`select[aria-label="${group}: ${part}"]`).inputValue();
    const where = (selector) => overlayFrame().locator(selector).count();

    it('starts with the usual places: the HP bar on top, the energy at the bottom left and the retreat cost at the bottom right', async () => {
      assert.deepEqual([await value('Active Pokémon', 'HP bar'), await value('Active Pokémon', 'Attached energy'), await value('Active Pokémon', 'Retreat cost')], ['top', 'bottom-left', 'bottom-right']);
      assert.deepEqual([await value('Bench', 'HP bar'), await value('Bench', 'Attached energy')], ['top', 'bottom-left']);
      assert.equal(await page.locator('select[aria-label="Bench: Retreat cost"]').count(), 0, 'the bench does not show the retreat cost, so there is none to place');
      assert.deepEqual(await tile(), {});
      assert.equal(await page.getByRole('button', { name: 'Use the usual places' }).isDisabled(), true, 'nothing to put back');
      assert.deepEqual(await page.locator('select[aria-label="Active Pokémon: HP bar"] option').allTextContents(), ['On the picture, at the top', 'On the picture, at the bottom', 'Below the picture']);
      assert.equal(await page.locator('select[aria-label="Active Pokémon: Retreat cost"] option').count(), 5, 'the four corners and below');
      await drawn();
      assert.equal(await where('.trainer-a .active .band-top .band-bar .hp'), 1);
      assert.equal(await where('.trainer-a .active .band-bottom .corner-left .energies'), 1);
      assert.equal(await where('.trainer-a .active .band-bottom .corner-right .retreat'), 1);
      assert.equal(await where('.trainer-a .bench .mon.mini:not([hidden]) .retreat:not([hidden])'), 0, 'and none on the bench');
    });

    it('moves a part as soon as it is chosen, for the Active Pokémon and the bench on their own', async () => {
      await choose('Active Pokémon', 'HP bar', 'below');
      await choose('Active Pokémon', 'Attached energy', 'top-right');
      await choose('Bench', 'Attached energy', 'top-left');
      assert.deepEqual(await tile(), { active: { hp: 'below', energy: 'top-right' }, bench: { energy: 'top-left' } });
      await drawn();
      assert.equal(await where('.trainer-a .active .art .hp'), 0, 'not on the picture any more');
      assert.equal(await where('.trainer-a .active .details .hp'), 1, 'but under it');
      assert.equal(await where('.trainer-a .active .band-top .corner-right .energies'), 1);
      assert.equal(await where('.trainer-a .active .band-bottom .corner-right .retreat'), 1, 'the retreat cost of the Active Pokémon stays');
      assert.equal(await where('.trainer-a .bench .mon.mini:not([hidden]) .band-top .corner-left .energies'), 3);
      assert.equal(await where('.trainer-a .bench .mon.mini:not([hidden]) .band-top .band-bar .hp'), 3, 'the bench keeps its HP bar');
    });

    it('forgets a choice that is the usual place again, and puts everything back with one button', async () => {
      await choose('Active Pokémon', 'HP bar', 'bottom');
      assert.deepEqual(await tile(), { active: { hp: 'bottom' } });
      await choose('Active Pokémon', 'HP bar', 'top');
      assert.deepEqual(await tile(), {}, 'the usual is not written down');

      await choose('Active Pokémon', 'Retreat cost', 'below');
      await choose('Bench', 'HP bar', 'bottom');
      await page.getByRole('button', { name: 'Use the usual places' }).click();
      assert.deepEqual(await tile(), {});
      assert.equal(await value('Active Pokémon', 'Retreat cost'), 'bottom-right');
      assert.equal(await value('Bench', 'HP bar'), 'top');
    });

    it('undoes with Ctrl+Z, and shows in the code view', async () => {
      await choose('Bench', 'Attached energy', 'bottom-right');
      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
      assert.deepEqual(JSON.parse(await page.locator('.code-input').inputValue()).tile, { bench: { energy: 'bottom-right' } });
      await page.locator('.editor-side .tab', { hasText: 'Tile' }).click();
      await page.locator('.editor-toolbar').getByRole('button', { name: /^Undo/ }).click();
      assert.deepEqual(await tile(), {});
      assert.equal(await value('Bench', 'Attached energy'), 'bottom-left');
    });

    it('can be typed in the code view, and a place that does not exist is refused with its line', async () => {
      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
      await page.locator('.code-input').fill(JSON.stringify({ tile: { active: { hp: 'below' } } }, null, 2));
      await wait(450);
      assert.equal(await page.locator('.code-status').textContent(), 'Applied.');
      assert.deepEqual(await tile(), { active: { hp: 'below' } });
      await page.locator('.code-input').fill(JSON.stringify({ tile: { active: { hp: 'sideways' } } }));
      await wait(450);
      assert.match(await page.locator('.code-status').textContent(), /"hp" can go in one of these places: top, bottom, below/);
      assert.deepEqual(await tile(), { active: { hp: 'below' } }, 'the last good version stays');
      await page.locator('.editor-side .tab', { hasText: 'Tile' }).click();
      assert.equal(await value('Active Pokémon', 'HP bar'), 'below');
    });

    describe('the picture on the prize cards', () => {
      const prize = () => page.locator('select[aria-label="Picture on the prize cards"]');
      const style = () => page.evaluate(() => window.oto.designEditor.model.draft.prizeStyle);
      const backOf = () => overlayFrame().evaluate(() => getComputedStyle(document.querySelector('.trainer-a .prize:not(.taken)')).backgroundImage);

      it('offers the design\'s own card back, an English or a Japanese one and a Poké Ball, and starts with the design\'s own (the English one when it has none)', async () => {
        assert.deepEqual(await prize().locator('option').allTextContents(), ['The design\'s own card back', 'English Pokémon card back', 'Japanese Pokémon card back', 'A Poké Ball']);
        assert.equal(await prize().inputValue(), 'current');
        assert.equal(await style(), '');
        assert.match(await page.locator('.prize-help').textContent(), /own prize card back or card back picture, or the English card back when it has none/);
        await drawn();
        assert.equal(await overlayFrame().evaluate(() => [...document.documentElement.classList].filter((name) => name.startsWith('prize-')).join()), 'prize-english');
      });

      it('changes the prize cards on the canvas as soon as one is chosen, and says which file the picture is', async () => {
        await drawn();
        await prize().selectOption('japanese');
        assert.equal(await style(), 'japanese');
        assert.match(await page.locator('.prize-help').textContent(), /assets\/cardbacks\/japanese/);
        await page.waitForFunction(() => document.querySelector('iframe[src*="editor=1"]').contentDocument.documentElement.classList.contains('prize-japanese'));
        assert.match(await backOf(), /cardbacks\/japanese/);
        assert.match(await backOf(), /data:image\/svg\+xml/, 'with a drawing under the file, for when it is not there');

        await prize().selectOption('pokeball');
        await page.waitForFunction(() => document.querySelector('iframe[src*="editor=1"]').contentDocument.documentElement.classList.contains('prize-pokeball'));
        assert.equal(await overlayFrame().evaluate(() => document.documentElement.classList.contains('prize-japanese')), false, 'one at a time');
        assert.match(await backOf(), /cardbacks\/pokeball/);

        await prize().selectOption('current');
        assert.equal(await style(), '', 'the usual is not written down');
        await page.waitForFunction(() => document.querySelector('iframe[src*="editor=1"]').contentDocument.documentElement.classList.contains('prize-english'));
        assert.equal(await overlayFrame().evaluate(() => document.documentElement.classList.contains('prize-pokeball')), false);
      });

      it('keeps the taken prize cards grayed out whatever is printed on them', async () => {
        await prize().selectOption('english');
        await drawn();
        await page.waitForFunction(() => document.querySelector('iframe[src*="editor=1"]').contentDocument.documentElement.classList.contains('prize-english'));
        const taken = await overlayFrame().evaluate(() => {
          const node = document.querySelector('.trainer-a .prize.taken');
          const style = node && getComputedStyle(node);
          return node ? { opacity: style.opacity, filter: style.filter, back: style.backgroundImage } : null;
        });
        assert.ok(taken, 'the sample match has prize cards that are taken');
        assert.ok(Number(taken.opacity) < 0.3, 'faded');
        assert.match(taken.filter, /grayscale/);
        assert.match(taken.back, /cardbacks\/english/, 'but still the same card back');
      });

      describe('the layout', () => {
        const layout = () => page.locator('select[aria-label="Layout of the prize cards"]');
        const chosen = () => page.evaluate(() => window.oto.designEditor.model.draft.prizeLayout);
        const rootLayout = () => overlayFrame().evaluate(() => [...document.documentElement.classList].filter((name) => name.startsWith('prize-layout-')));

        it('offers a row, a column, two rows of three and three rows of two, and starts with the row', async () => {
          assert.deepEqual(await layout().locator('option').allTextContents(), ['A row of six', 'A column of six', 'Two rows of three', 'Three rows of two']);
          assert.equal(await layout().inputValue(), 'row');
          assert.equal(await chosen(), '');
        });

        it('lays the prize cards of the canvas out as soon as one is chosen, and does not write down the usual row', async () => {
          await drawn();
          await layout().selectOption('three-rows');
          assert.equal(await chosen(), 'three-rows');
          await page.waitForFunction(() => document.querySelector('iframe[src*="editor=1"]').contentDocument.documentElement.classList.contains('prize-layout-three-rows'));
          const columns = await overlayFrame().evaluate(() => new Set([...document.querySelectorAll('.trainer-a .prize')].map((node) => node.offsetLeft)).size);
          assert.equal(columns, 2);
          await layout().selectOption('row');
          assert.equal(await chosen(), '');
          await page.waitForFunction(() => !document.querySelector('iframe[src*="editor=1"]').contentDocument.documentElement.className.includes('prize-layout-'));
        });

        it('goes into the code view, is read back from it with a mistake refused, and is saved with the design', async () => {
          await layout().selectOption('column');
          await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
          assert.equal(JSON.parse(await page.locator('.code-input').inputValue()).prizeLayout, 'column');
          await page.locator('.code-input').fill(JSON.stringify({ prizeLayout: 'two-rows' }));
          await wait(450);
          assert.equal(await chosen(), 'two-rows');
          await page.locator('.code-input').fill(JSON.stringify({ prizeLayout: 'diagonal' }));
          await wait(450);
          assert.match(await page.locator('.code-status').textContent(), /The prize cards can be laid out as: "row", "column", "two-rows", "three-rows"/);
          assert.equal(await chosen(), 'two-rows', 'the last good version stays');
          await page.locator('.editor-side .tab', { hasText: 'Tile' }).click();
          assert.equal(await layout().inputValue(), 'two-rows');
          await page.locator('.modal[aria-label="Design: Tile Test"]').getByRole('button', { name: 'Save', exact: true }).click();
          await page.waitForFunction(() => !window.oto.designEditor.model.dirty);
          assert.equal((await api('GET', '/api/themes/Tile%20Test')).json.prizeLayout, 'two-rows');
          await layout().selectOption('row');
          await page.locator('.modal[aria-label="Design: Tile Test"]').getByRole('button', { name: 'Save', exact: true }).click();
          await page.waitForFunction(() => !window.oto.designEditor.model.dirty);
          assert.equal('prizeLayout' in (await api('GET', '/api/themes/Tile%20Test')).json, false);
          assert.deepEqual(page.problems, []);
        });
      });

      it('goes into the code view, and is read back from it, with a mistake refused and its choices listed', async () => {
        await prize().selectOption('english');
        await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
        assert.equal(JSON.parse(await page.locator('.code-input').inputValue()).prizeStyle, 'english');

        await page.locator('.code-input').fill(JSON.stringify({ prizeStyle: 'japanese' }));
        await wait(450);
        assert.equal(await page.locator('.code-status').textContent(), 'Applied.');
        assert.equal(await style(), 'japanese');

        await page.locator('.code-input').fill(JSON.stringify({ prizeStyle: 'spanish' }));
        await wait(450);
        assert.match(await page.locator('.code-status').textContent(), /The prize cards can show: "current", "english", "japanese", "pokeball"/);
        assert.equal(await style(), 'japanese', 'the last good version stays');

        await page.locator('.code-input').fill(JSON.stringify({ author: 'Mina' }));
        await wait(450);
        assert.equal(await style(), '', 'what the text does not mention is cleared');
        assert.equal('prizeStyle' in JSON.parse(await page.locator('.code-input').inputValue()), false);
        await page.locator('.editor-side .tab', { hasText: 'Tile' }).click();
        assert.equal(await prize().inputValue(), 'current');
      });

      it('undoes with Ctrl+Z and is saved with the design', async () => {
        await prize().selectOption('pokeball');
        await page.locator('.editor-toolbar').getByRole('button', { name: /^Undo/ }).click();
        assert.equal(await style(), '');
        assert.equal(await prize().inputValue(), 'current');
        await page.locator('.editor-toolbar').getByRole('button', { name: /^Redo/ }).click();
        assert.equal(await prize().inputValue(), 'pokeball');

        await page.locator('.modal[aria-label="Design: Tile Test"]').getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForFunction(() => !window.oto.designEditor.model.dirty);
        assert.equal((await api('GET', '/api/themes/Tile%20Test')).json.prizeStyle, 'pokeball');
        assert.equal((await api('GET', '/api/theme')).json.theme, null, 'it is not on the overlay unless it is the chosen design');

        await prize().selectOption('current');
        await page.locator('.modal[aria-label="Design: Tile Test"]').getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForFunction(() => !window.oto.designEditor.model.dirty);
        assert.equal('prizeStyle' in (await api('GET', '/api/themes/Tile%20Test')).json, false, 'going back to the usual forgets it');
        assert.deepEqual(page.problems, []);
      });
    });
  });

  describe('the card crop selector', () => {
    beforeEach(async () => {
      await openEditorFor('Crop Test');
      await page.locator('.editor-side .tab', { hasText: 'Card crop' }).click();
    });
    const rectFields = async () => Object.fromEntries(await Promise.all(['Left', 'Top', 'Width', 'Height'].map(async (label) => [label, await page.locator(`.crop-field input[aria-label^="${label}"]`).inputValue()])));
    const cardBox = (side = 'a', where = '.active') => overlayFrame().evaluate(({ side, where }) => { const art = document.querySelector(`.trainer-${side} ${where} .art`).getBoundingClientRect(); return { w: art.width, h: art.height }; }, { side, where });

    const ART = { x: 0.07, y: 0.115, w: 0.86, h: 0.385 };
    const WHOLE = { x: 0, y: 0, w: 1, h: 1 };

    it('starts with the art of the card for both, and presets change what the overlay shows', async () => {
      assert.deepEqual(await rectFields(), { Left: '7', Top: '11.5', Width: '86', Height: '38.5' });
      assert.equal(await page.locator('.crop-panel .btn[data-preset="art"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.crop-panel input[aria-label="Use the same crop for the bench"]').isChecked(), true);
      assert.ok(Math.abs((await cardBox()).h - 300 * 1.3933 * 0.385 / 0.86) < 1, 'the Active Pokémon is as tall as its art');
      assert.deepEqual(await crop(), {}, 'the usual is not written down');

      await page.locator('.crop-panel .btn[data-preset="full"]').click();
      assert.deepEqual(await crop(), { active: WHOLE, bench: WHOLE }, 'the whole card is a choice, so it is written down; the bench follows');
      await drawn();
      assert.ok(Math.abs((await cardBox()).h - 418) < 0.1, 'the whole card is as tall as a card (the browser works in 64ths of a pixel)');
      assert.ok(Math.abs((await cardBox('a', '.bench')).h - 145) < 1, 'and so is the bench');
      assert.equal(await page.locator('.crop-panel .btn[data-preset="full"]').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await rectFields(), { Left: '0', Top: '0', Width: '100', Height: '100' });

      await page.locator('.crop-panel .btn[data-preset="top"]').click();
      assert.deepEqual((await crop()).active, { x: 0.02, y: 0.02, w: 0.96, h: 0.48 });
      await page.locator('.crop-panel .btn[data-preset="art"]').click();
      assert.deepEqual(await crop(), {}, 'the art is the same as no crop');
      await drawn();
      assert.ok(Math.abs((await cardBox()).h - 300 * 1.3933 * 0.385 / 0.86) < 1);
      assert.match(await page.locator('.crop-summary').textContent(), /Shows 86% of the width and 38.5% of the height/);
    });

    it('crops the bench on its own when the switch is off', async () => {
      await page.locator('.crop-panel .switch').click();
      await page.locator('.crop-panel .btn[data-preset="full"]').click();
      assert.deepEqual(await crop(), { active: WHOLE });
      await page.locator('.crop-panel .seg', { hasText: 'Bench' }).click();
      assert.deepEqual(await rectFields(), { Left: '7', Top: '11.5', Width: '86', Height: '38.5' }, 'the bench has its own: the art');
      await page.locator('.crop-panel .btn[data-preset="top"]').click();
      assert.deepEqual((await crop()).bench, { x: 0.02, y: 0.02, w: 0.96, h: 0.48 });
      assert.deepEqual((await crop()).active, WHOLE, 'the Active Pokémon keeps its own');
      // turning it on again makes the bench like the one being looked at
      await page.locator('.crop-panel .switch').click();
      assert.deepEqual((await crop()).active, (await crop()).bench);
    });

    it('moves and resizes the rectangle on the card with the mouse', async () => {
      const stage = await page.locator('.crop-stage').boundingBox();
      const at = (fx, fy) => ({ x: stage.x + stage.width * fx, y: stage.y + stage.height * fy });

      // draw a new one, starting outside the part that shows now (the art, in the top half of the card)
      await page.mouse.move(at(0.05, 0.55).x, at(0.05, 0.55).y);
      await page.mouse.down();
      await page.mouse.move(at(0.45, 0.85).x, at(0.45, 0.85).y, { steps: 5 });
      await page.mouse.up();
      let rect = (await crop()).active;
      assert.ok(Math.abs(rect.x - 0.05) < 0.01 && Math.abs(rect.y - 0.55) < 0.01 && Math.abs(rect.w - 0.4) < 0.01 && Math.abs(rect.h - 0.3) < 0.01, JSON.stringify(rect));

      // move it by its middle
      const middle = at(rect.x + rect.w / 2, rect.y + rect.h / 2);
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.down();
      await page.mouse.move(middle.x + stage.width * 0.1, middle.y + stage.height * 0.1, { steps: 5 });
      await page.mouse.up();
      const moved = (await crop()).active;
      assert.ok(Math.abs(moved.x - 0.15) < 0.01 && Math.abs(moved.y - 0.65) < 0.01 && Math.abs(moved.w - rect.w) < 0.001 && Math.abs(moved.h - rect.h) < 0.001, JSON.stringify(moved));

      // resize it by a corner, then by an edge; it never leaves the card or gets smaller than 5%
      const corner = await page.locator('.crop-handle.se').boundingBox();
      await page.mouse.move(corner.x + 6, corner.y + 6);
      await page.mouse.down();
      await page.mouse.move(stage.x + stage.width * 1.3, stage.y + stage.height * 1.4, { steps: 5 });
      await page.mouse.up();
      rect = (await crop()).active;
      assert.ok(Math.abs(rect.x + rect.w - 1) < 0.002 && Math.abs(rect.y + rect.h - 1) < 0.002, `stopped at the edge of the card: ${JSON.stringify(rect)}`);
      const edge = await page.locator('.crop-handle.w').boundingBox();
      await page.mouse.move(edge.x + 6, edge.y + 6);
      await page.mouse.down();
      await page.mouse.move(stage.x + stage.width * 2, edge.y + 6, { steps: 5 });
      await page.mouse.up();
      rect = (await crop()).active;
      assert.ok(Math.abs(rect.w - 0.05) < 0.002, `no smaller than 5%: ${JSON.stringify(rect)}`);
      assert.deepEqual((await crop()).bench, (await crop()).active, 'the bench follows the Active Pokémon');
    });

    it('takes numbers, and complains about ones that are not on the card', async () => {
      const field = (label) => page.locator(`.crop-field input[aria-label^="${label}"]`);
      await field('Left').fill('10'); await field('Left').press('Tab');
      await field('Top').fill('20'); await field('Top').press('Tab');
      await field('Width').fill('50'); await field('Width').press('Tab');
      await field('Height').fill('40'); await field('Height').press('Tab');
      assert.deepEqual((await crop()).active, { x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
      assert.equal(await page.locator('.crop-panel .prompt-complaint').isHidden(), true);

      await field('Width').fill('95'); await field('Width').press('Tab');
      assert.equal(await page.locator('.crop-panel .prompt-complaint').isVisible(), true);
      assert.match(await page.locator('.crop-panel .prompt-complaint').textContent(), /not on the card/);
      assert.deepEqual((await crop()).active, { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, 'nothing changed');
      await field('Width').fill('3'); await field('Width').press('Tab');
      assert.match(await page.locator('.crop-panel .prompt-complaint').textContent(), /at least 5%/);
    });

    it('moves the rectangle with the arrow keys', async () => {
      await page.locator('.crop-panel .btn[data-preset="top"]').click();
      await page.locator('.crop-rect').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowDown');
      const rect = (await crop()).active;
      assert.ok(Math.abs(rect.x - 0.03) < 0.001 && Math.abs(rect.y - 0.07) < 0.001, JSON.stringify(rect));
    });

    describe('the crop of the prize cards', () => {
      beforeEach(async () => { await page.locator('.crop-panel .seg', { hasText: 'Prize cards' }).click(); });
      const prizeCrop = () => crop().then((all) => all.prize);
      const WHOLE_CARD = { x: 0, y: 0, w: 1, h: 1 };

      it('is a tab of its own, with the whole card as the usual, which is not written down, and no bench to share it with', async () => {
        assert.equal(await page.locator('.crop-panel .switch').isHidden(), true, 'nothing to share with the bench');
        assert.deepEqual(await rectFields(), { Left: '0', Top: '0', Width: '100', Height: '100' });
        assert.equal(await page.locator('.crop-panel .btn[data-preset="full"]').getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await page.locator('.crop-presets .btn').allTextContents(), ['Full card', 'Art only']);
        assert.equal(await prizeCrop(), undefined);
      });

      it('shows just the art on the prize cards of the canvas when asked, written down, and goes back to the whole card', async () => {
        await page.locator('.crop-panel .btn[data-preset="art"]').click();
        assert.deepEqual(await prizeCrop(), ART);
        await drawn();
        await page.waitForFunction(() => document.querySelector('iframe[src*="editor=1"]').contentDocument.documentElement.style.getPropertyValue('--cp-w') === '0.86');
        const height = await overlayFrame().evaluate(() => document.querySelector('.trainer-a .prize').getBoundingClientRect().height);
        assert.ok(Math.abs(height - (56 * 0.385) / 0.86) < 0.1, `the prize card is as tall as the art: ${height}`);
        assert.deepEqual(await crop(), { prize: ART }, 'and the Pokémon are as they were');
        await page.locator('.crop-panel .btn[data-preset="full"]').click();
        assert.equal(await prizeCrop(), undefined, 'the whole card is the usual here');
      });
    });

    describe('the crop of the Pokémon Tools', () => {
      beforeEach(async () => { await page.locator('.crop-panel .seg', { hasText: 'Tools' }).click(); });
      const toolCrop = () => crop().then((all) => all.tool);
      const USUAL = { x: 0.082, y: 0.145, w: 0.836, h: 0.37 };

      it('is a tab of its own, with the picture window of a Trainer card as the usual, which is not written down, and no bench to share it with', async () => {
        assert.equal(await page.locator('.crop-panel .switch').isHidden(), true, 'nothing to share with the bench');
        assert.deepEqual(await rectFields(), { Left: '8.2', Top: '14.5', Width: '83.6', Height: '37' });
        assert.equal(await page.locator('.crop-panel .btn[data-preset="art"]').getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await page.locator('.crop-presets .btn').allTextContents(), ['Full card', 'Art only', 'Name and art']);
        assert.equal(await toolCrop(), undefined);
        assert.match(await page.locator('.crop-card-field option').first().textContent(), /sample Pokémon Tool card/);
      });

      it('shows the whole card on the tools of the canvas when asked, written down, and goes back to the picture', async () => {
        await page.locator('.crop-panel .btn[data-preset="full"]').click();
        assert.deepEqual(await toolCrop(), { x: 0, y: 0, w: 1, h: 1 });
        await page.waitForFunction(() => document.querySelector('iframe[src*="editor=1"]').contentDocument.documentElement.style.getPropertyValue('--ct-w') === '1');
        const height = await overlayFrame().evaluate(() => document.querySelector('.trainer-a .active .tool-card').getBoundingClientRect().height);
        assert.ok(Math.abs(height - 104 * 1.393333) < 1, `the tool is as tall as the whole card: ${height}`);
        assert.deepEqual(await crop(), { tool: { x: 0, y: 0, w: 1, h: 1 } }, 'and the Pokémon are as they were');
        await page.locator('.crop-panel .btn[data-preset="art"]').click();
        assert.equal(await toolCrop(), undefined, 'the picture is the usual');
        assert.deepEqual(USUAL, { x: 0.082, y: 0.145, w: 0.836, h: 0.37 });
      });

      it('has a sample tool on the canvas, shown as a picture of its card', async () => {
        assert.equal(await overlayFrame().evaluate(() => document.querySelectorAll('.trainer-a .active .tool-card img').length), 1);
        assert.equal(await overlayFrame().evaluate(() => document.querySelector('.trainer-a .active .tool-card-hp').textContent), '+50');
      });
    });

    describe('the circle for Special Energy', () => {
      beforeEach(async () => { await page.locator('.crop-panel .seg', { hasText: 'Special energy' }).click(); });
      const circle = () => crop().then((all) => all.energy);
      const fieldValue = (label) => page.locator(`.crop-field input[aria-label^="${label}"]`).inputValue();
      const stage = () => page.locator('.crop-stage').boundingBox();
      const dragTo = async (from, to) => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();
      };

      it('is a circle: no choice of bench, one preset, no height, and no handles on the sides', async () => {
        assert.equal(await page.locator('.crop-panel .switch').isHidden(), true, 'nothing to share with the bench');
        assert.equal(await page.locator('.crop-presets').isHidden(), true);
        assert.equal(await page.locator('.crop-circle-presets .btn').textContent(), 'The usual circle');
        assert.equal(await page.locator('.crop-field', { hasText: 'Height' }).isHidden(), true);
        assert.equal(await page.locator('.crop-field', { hasText: 'Size' }).isVisible(), true);
        assert.equal(await page.locator('.crop-rect').evaluate((node) => node.classList.contains('circle') && getComputedStyle(node).borderTopLeftRadius === '50%'), true);
        for (const side of ['n', 'e', 's', 'w']) assert.equal(await page.locator(`.crop-handle.${side}`).isHidden(), true, side);
        for (const corner of ['nw', 'ne', 'se', 'sw']) assert.equal(await page.locator(`.crop-handle.${corner}`).isVisible(), true, corner);
        assert.match(await page.locator('.crop-card-field option').first().textContent(), /sample Special Energy card/);
        assert.match(await page.locator('.crop-summary').textContent(), /A circle 71.3% as wide as the card, cut out of each Special Energy card/);
      });

      it('starts with the usual circle, centered on the art of the card and as wide as the art is tall, which is not written down', async () => {
        assert.deepEqual([await fieldValue('Left'), await fieldValue('Top'), await fieldValue('Width')], ['14.4', '13.6', '71.3']);
        assert.equal(await circle(), undefined, 'the usual circle is the same as nothing');
        assert.equal(await page.locator('.crop-circle-presets .btn').getAttribute('aria-pressed'), 'true');
      });

      it('grows from a corner, always a circle, and stays on the card', async () => {
        const handle = await page.locator('.crop-handle.se').boundingBox();
        const area = await stage();
        const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
        await dragTo(from, { x: from.x + area.width * 0.06, y: from.y + area.height * 0.06 });
        const bigger = await circle();
        assert.ok(bigger.w > THEME_OPTIONS.ENERGY_CIRCLE.w, `wider than before: ${JSON.stringify(bigger)}`);
        assert.ok(Math.abs(bigger.w * 300 - bigger.h * 418) < 1, 'the same number of pixels across and down');
        assert.ok(Math.abs(bigger.x - THEME_OPTIONS.ENERGY_CIRCLE.x) < 0.002 && Math.abs(bigger.y - THEME_OPTIONS.ENERGY_CIRCLE.y) < 0.002, 'the corner it grew from stayed');
        assert.equal(await page.locator('.crop-circle-presets .btn').getAttribute('aria-pressed'), 'false');

        // far beyond the card: it stops at the edge
        const corner = await page.locator('.crop-handle.se').boundingBox();
        await dragTo({ x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, { x: area.x + area.width * 2, y: area.y + area.height * 2 });
        const edge = await circle();
        assert.ok(edge.x + edge.w <= 1.0005 && edge.y + edge.h <= 1.0005, JSON.stringify(edge));

        // and from another corner the opposite one stays
        const start = await circle();
        const nw = await page.locator('.crop-handle.nw').boundingBox();
        await dragTo({ x: nw.x + nw.width / 2, y: nw.y + nw.height / 2 }, { x: area.x + area.width * (start.x + start.w * 0.4), y: area.y + area.height * (start.y + start.h * 0.4) });
        const smaller = await circle();
        assert.ok(smaller.w < start.w);
        assert.ok(Math.abs(smaller.x + smaller.w - (start.x + start.w)) < 0.003 && Math.abs(smaller.y + smaller.h - (start.y + start.h)) < 0.003, 'the opposite corner did not move');
      });

      it('moves, is drawn anew, takes numbers and goes back to the usual one', async () => {
        const area = await stage();
        const middle = { x: area.x + area.width * 0.5, y: area.y + area.height * (THEME_OPTIONS.ENERGY_CIRCLE.y + THEME_OPTIONS.ENERGY_CIRCLE.h / 2) };
        await dragTo(middle, { x: middle.x, y: middle.y + area.height * 0.3 });
        const moved = await circle();
        assert.ok(Math.abs(moved.y - (THEME_OPTIONS.ENERGY_CIRCLE.y + 0.3)) < 0.01 && Math.abs(moved.x - THEME_OPTIONS.ENERGY_CIRCLE.x) < 0.002 && Math.abs(moved.w - THEME_OPTIONS.ENERGY_CIRCLE.w) < 0.002, JSON.stringify(moved));

        // drawing on an empty part of the card makes a new one from where the drag began
        await dragTo({ x: area.x + area.width * 0.05, y: area.y + area.height * 0.8 }, { x: area.x + area.width * 0.3, y: area.y + area.height * 0.95 });
        const made = await circle();
        assert.ok(Math.abs(made.x - 0.05) < 0.01 && Math.abs(made.y - 0.8) < 0.01 && made.w > 0.2 && Math.abs(made.w * 300 - made.h * 418) < 1, JSON.stringify(made));

        const field = (label) => page.locator(`.crop-field input[aria-label^="${label}"]`);
        await field('Left').fill('30'); await field('Left').press('Tab');
        await field('Top').fill('20'); await field('Top').press('Tab');
        await field('Width').fill('40'); await field('Width').press('Tab');
        assert.deepEqual(await circle(), { x: 0.3, y: 0.2, w: 0.4, h: 0.287 });
        await field('Width').fill('90'); await field('Width').press('Tab');
        assert.match(await page.locator('.crop-panel .prompt-complaint').textContent(), /circle is not on the card/);
        assert.deepEqual(await circle(), { x: 0.3, y: 0.2, w: 0.4, h: 0.287 }, 'nothing changed');

        await page.locator('.crop-circle-presets .btn').click();
        assert.equal(await circle(), undefined);
        assert.deepEqual([await fieldValue('Left'), await fieldValue('Top'), await fieldValue('Width')], ['14.4', '13.6', '71.3']);
      });

      it('shows the circle on the Special Energy cards in the overlay, saves it, and writes it in the code', async () => {
        const field = (label) => page.locator(`.crop-field input[aria-label^="${label}"]`);
        await field('Left').fill('25'); await field('Left').press('Tab');
        await field('Top').fill('10'); await field('Top').press('Tab');
        await field('Width').fill('50'); await field('Width').press('Tab');
        await drawn();
        const frame = overlayFrame();
        const variable = (name) => frame.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
        assert.equal(await variable('--ed'), '0.5');
        assert.ok(Math.abs(Number(await variable('--ex')) - 0.5) < 0.001, 'its middle is where the circle is');
        assert.ok(Math.abs(Number(await variable('--ey')) - (0.1 + 0.359 / 2)) < 0.001);
        assert.ok(await frame.locator('.trainer-a .active .energy-special').count() >= 2, 'the sample match has Special Energy on Pikachu');

        await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
        assert.deepEqual(JSON.parse(await page.locator('.code-input').inputValue()).crop, { energy: { x: 0.25, y: 0.1, w: 0.5, h: 0.359 } });
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.editor-status').textContent === 'Saved');
        assert.deepEqual((await api('GET', '/api/themes/Crop%20Test')).json.crop, { energy: { x: 0.25, y: 0.1, w: 0.5, h: 0.359 } });
      });
    });

    it('can show the crop on a card from the match', async () => {
      assert.equal(await page.locator('.crop-card-field option').count(), 1, 'only the sample while nobody has a Pokémon out');
      const producer = server.client({ clientId: 'ui-editor-producer', name: 'Maya' });
      await producer.ready();
      await producer.act('action:trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: '/art/test.svg', hp: 100 });
      await page.waitForFunction(() => window.oto.state.trainerA.active.name === 'Pikachu');
      await page.locator('.crop-panel .btn[data-preset="art"]').click(); // refreshes the list
      assert.equal(await page.locator('.crop-card-field option').count(), 2);
      assert.match(await page.locator('.crop-card-field option').nth(1).textContent(), /Pikachu/);
      await page.locator('.crop-card-field select').selectOption({ index: 1 });
      assert.match(await page.locator('.crop-card').getAttribute('src'), /art\/test\.svg/);
      producer.close();
    });
  });

  describe('saving', () => {
    beforeEach(async () => { await openEditorFor('Save Test'); });
    const closeButton = () => editorModal('Save Test').locator('.modal-foot').getByRole('button', { name: 'Close', exact: true });

    it('saves the layout and the crop in the design, and tells the overlay when the design is on air', async () => {
      await api('POST', '/api/theme/active', { name: 'Save Test' });
      const overlay = await openPage(browser, `${server.base}/overlay`);
      await overlay.waitForSelector('.scoreboard');
      assert.equal(await overlay.locator('.moved').count(), 0);

      await box('scoreboard').click();
      await page.keyboard.press('Shift+ArrowDown');
      await page.locator('.editor-side .tab', { hasText: 'Card crop' }).click();
      await page.locator('.crop-panel .btn[data-preset="full"]').click();
      await page.locator('.editor-side .tab', { hasText: 'Tile' }).click();
      await page.locator('select[aria-label="Active Pokémon: HP bar"]').selectOption('bottom');
      assert.deepEqual((await api('GET', '/api/themes/Save%20Test')).json.layout, undefined, 'nothing is saved before Save');
      assert.equal(await overlay.locator('.moved').count(), 0, 'and the stream does not see it');

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.editor-status').textContent === 'Saved');
      const design = (await api('GET', '/api/themes/Save%20Test')).json;
      assert.deepEqual(design.layout, { scoreboard: { x: 0, y: 10, scale: 1 } });
      assert.deepEqual(design.crop.active, { x: 0, y: 0, w: 1, h: 1 });
      assert.deepEqual(design.tile, { active: { hp: 'bottom' } });
      await overlay.waitForSelector('.scoreboard.moved');
      await overlay.waitForFunction(() => document.documentElement.style.getPropertyValue('--ca-w') === '1');
      await overlay.waitForSelector('.trainer-a .active .band-bottom .band-bar .hp', { state: 'attached' });
      assert.match(await page.locator('.toast-success').first().textContent(), /on the overlay, so you see it on stream/);
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'nothing left to save');
      await overlay.context().close();
    });

    it('asks before closing with changes that are not saved, and lets go when there are none', async () => {
      await box('scoreboard').click();
      await page.keyboard.press('ArrowDown');
      await wait(600);
      await closeButton().click();
      const ask = page.locator('.modal[aria-label="Close without saving?"]');
      await ask.waitFor();
      await ask.getByRole('button', { name: 'Cancel' }).click();
      assert.equal(await editorModal('Save Test').count(), 1, 'still open');

      await page.keyboard.press('Escape'); // Escape and the X ask the same question
      await ask.waitFor();
      await ask.getByRole('button', { name: 'Cancel' }).click();
      await editorModal('Save Test').locator('.modal-head').getByRole('button', { name: 'Close' }).click();
      await ask.waitFor();
      await ask.getByRole('button', { name: 'Close without saving' }).click();
      await editorModal('Save Test').waitFor({ state: 'detached' });
      assert.equal((await api('GET', '/api/themes/Save%20Test')).json.layout, undefined, 'nothing was saved');
      assert.equal(await page.locator('.modal[aria-label="Settings"]').count(), 1, 'back in the settings');
    });

    it('closes at once when nothing changed, and undoes all changes with one button', async () => {
      await box('stadium').click();
      await page.keyboard.press('ArrowRight');
      await wait(600);
      assert.equal(await page.getByRole('button', { name: 'Undo all changes' }).isDisabled(), false);
      await page.getByRole('button', { name: 'Undo all changes' }).click();
      assert.deepEqual(await layout(), {});
      assert.match(await page.locator('.editor-status').textContent(), /Saved/);
      await closeButton().click();
      await editorModal('Save Test').waitFor({ state: 'detached' });
    });

    it('refuses to save what the server refuses, and says why', async () => {
      await page.evaluate(() => window.oto.designEditor.model.update({ layout: { scoreboard: { x: 99999, y: 0, scale: 1 } } }, { source: 'test' }));
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForSelector('.toast-error');
      assert.match(await page.locator('.toast-error').first().textContent(), /between -1920 and 1920/);
      assert.match(await page.locator('.editor-status').textContent(), /Unsaved changes/);
    });

    it('saves with Ctrl+S', async () => {
      await box('trainerB.bench').click();
      await page.keyboard.press('ArrowUp');
      await wait(600);
      await page.keyboard.press('Control+s');
      await page.waitForFunction(() => document.querySelector('.editor-status').textContent === 'Saved');
      assert.deepEqual((await api('GET', '/api/themes/Save%20Test')).json.layout, { 'trainerB.bench': { x: 0, y: -1, scale: 1 } });
    });
  });

  describe('a design with pictures', () => {
    it('draws them in the canvas, so the logo can be placed', async () => {
      await api('PUT', '/api/themes/Pictures', { colors: { '--accent': '#ff00aa' } });
      const png = await fetch(`${server.base}/api/themes/Pictures/images/logoImage`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: S.PNG });
      assert.equal(png.status, 200);
      await openEditorFor('Pictures', { colors: { '--accent': '#ff00aa' } });
      const frame = overlayFrame();
      assert.match(await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--logoImage')), /\/api\/themes\/Pictures\/assets\/images\/logoImage\.png\?v=\d+/);
      assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#ff00aa');
      await page.waitForFunction(() => !window.oto.designEditor.canvas.boxes.get('logo').hidden);
      await dragPiece('logo', 30, 20, { alt: true });
      assert.ok((await layout()).logo.x > 0);
    });
  });

  describe('the screen of the design', () => {
    const screen = () => page.locator('select[aria-label="The screen of the design"]');
    const world = () => page.evaluate(() => { const node = document.querySelector('.editor-world'); const frame = document.querySelector('.editor-frame'); return { w: node.offsetWidth, h: node.offsetHeight, frameW: frame.offsetWidth, frameH: frame.offsetHeight }; });
    const stageOf = () => overlayFrame().evaluate(() => { const stage = document.getElementById('stage'); return { w: stage.offsetWidth, h: stage.offsetHeight, portrait: stage.classList.contains('portrait') }; });

    it('is a wide screen at first, and can be a mobile one: the stage, the canvas and the overlay in it follow', async () => {
      await openEditorFor('Phone');
      assert.deepEqual(await screen().locator('option').allTextContents(), ['Horizontal screen', 'Mobile screen']);
      assert.equal(await screen().inputValue(), 'landscape');
      assert.deepEqual(await world(), { w: 1920, h: 1080, frameW: 1920, frameH: 1080 });
      const wide = await zoom();

      await screen().selectOption('portrait');
      assert.equal(await editor(() => window.oto.designEditor.model.draft.orientation), 'portrait');
      assert.deepEqual(await world(), { w: 1080, h: 1920, frameW: 1080, frameH: 1920 });
      await page.waitForFunction(() => document.querySelector('.editor-frame').contentDocument.getElementById('stage').classList.contains('portrait'));
      assert.deepEqual(await stageOf(), { w: 1080, h: 1920, portrait: true });
      const tall = await zoom();
      assert.ok(tall < wide, `the whole tall stage fits on the canvas: ${tall} against ${wide}`);
      const canvas = await page.locator('.editor-viewport').boundingBox();
      assert.ok(1920 * tall <= canvas.height + 1 && 1080 * tall <= canvas.width + 1, 'inside the canvas');
      await drawn();
      // the pieces are where the mobile arrangement puts them, inside the tall stage
      const rects = await editor(() => JSON.parse(JSON.stringify(window.oto.designEditor.canvas.rects)));
      assert.ok(rects.trainerB.y > rects.trainerA.y + rects.trainerA.h - 1, 'one trainer above the other');
      assert.ok(rects.scoreboard.x + rects.scoreboard.w <= 1080);

      // it is part of the design: the code view says so, undo takes it back, and the usual screen is not written down
      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
      assert.match(await page.locator('.code-input').inputValue(), /"orientation": "portrait"/);
      await page.keyboard.press('Escape'); // (nothing is picked: the first Escape would let go of a piece)
      await editor(() => window.oto.designEditor.model.undo());
      assert.equal(await screen().inputValue(), 'landscape', 'undo');
      assert.deepEqual(await world(), { w: 1920, h: 1080, frameW: 1920, frameH: 1080 });
      assert.doesNotMatch(await page.locator('.code-input').inputValue(), /orientation/);
      await editor(() => window.oto.designEditor.model.redo());
      assert.equal(await screen().inputValue(), 'portrait', 'redo');
      assert.deepEqual(page.problems, []);
    });

    it('is saved with the design, read again when the editor opens, and can be typed in the code view', async () => {
      await openEditorFor('Phone');
      await screen().selectOption('portrait');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.editor-status').textContent === 'Saved');
      assert.equal((await api('GET', '/api/themes/Phone')).json.orientation, 'portrait');

      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
      await page.locator('.code-input').fill(JSON.stringify({ orientation: 'landscape' }));
      await page.waitForFunction(() => document.querySelector('.editor-frame').contentDocument.getElementById('stage').offsetWidth === 1920);
      assert.equal(await screen().inputValue(), 'landscape');
      await page.locator('.code-input').fill(JSON.stringify({ orientation: 'sideways' }));
      await page.waitForFunction(() => /The screen can be/.test(document.querySelector('.code-status').textContent));
      assert.equal(await screen().inputValue(), 'landscape', 'what does not make sense changes nothing');

      await editorModal('Phone').locator('.modal-foot').getByRole('button', { name: 'Close', exact: true }).click();
      await page.locator('.modal[aria-label="Close without saving?"]').getByRole('button', { name: 'Close without saving' }).click();
      await page.locator('button', { hasText: 'Layout and crop' }).click();
      await page.waitForFunction(() => window.oto.designEditor && Object.keys(window.oto.designEditor.canvas.rects).length > 0);
      assert.equal(await screen().inputValue(), 'portrait', 'the design as it was saved');
      assert.deepEqual((await world()).w, 1080);
    });
  });

  describe('the grid', () => {
    const toolbar = () => page.locator('.editor-toolbar');
    const gridSwitch = () => toolbar().locator('.switch', { hasText: /^Grid$/ });
    const snapSwitch = () => toolbar().locator('.switch', { hasText: 'Snap to grid' });
    const size = () => toolbar().locator('input[aria-label="Size of the grid squares, in pixels"]');
    const gridShown = () => page.$eval('.editor-grid', (node) => ({ shown: !node.hidden && getComputedStyle(node).display !== 'none', size: node.style.getPropertyValue('--grid'), image: getComputedStyle(node).backgroundImage.includes('linear-gradient') }));
    const lineUp = (value, step) => Math.min(value % step, step - (value % step));

    it('is a mask over the canvas that can be shown, with squares of the size the designer chooses, and is remembered', async () => {
      await openEditorFor('Grid Test');
      assert.deepEqual(await gridShown(), { shown: false, size: '40px', image: true });
      assert.equal(await size().inputValue(), '40');
      await gridSwitch().click();
      assert.deepEqual(await gridShown(), { shown: true, size: '40px', image: true });
      await size().fill('100');
      await size().press('Tab');
      assert.equal((await gridShown()).size, '100px');
      await size().fill('3');
      await size().press('Tab');
      assert.equal(await size().inputValue(), '8', 'not smaller than 8');
      await size().fill('9000');
      await size().press('Tab');
      assert.equal(await size().inputValue(), '480', 'and not bigger than 480');
      await size().fill('60');
      await size().press('Tab');
      const box = await page.locator('.editor-grid').boundingBox();
      const world = await page.locator('.editor-world').boundingBox();
      assert.ok(Math.abs(box.width - world.width) < 1 && Math.abs(box.height - world.height) < 1, 'over the whole stage');
      assert.equal(await page.$eval('.editor-grid', (node) => getComputedStyle(node).pointerEvents), 'none', 'and the clicks go through');
      assert.deepEqual(await page.evaluate(() => JSON.parse(window.localStorage.getItem('oto-editor-grid'))), { show: true, snap: false, size: 60 });
      assert.equal((await api('GET', '/api/themes/Grid%20Test')).json.grid, undefined, 'it is not part of the design');

      // a new editor has the grid as it was left
      await editorModal('Grid Test').locator('.modal-foot').getByRole('button', { name: 'Close', exact: true }).click();
      await page.locator('button', { hasText: 'Layout and crop' }).click();
      await page.waitForFunction(() => window.oto.designEditor && Object.keys(window.oto.designEditor.canvas.rects).length > 0);
      assert.deepEqual(await gridShown(), { shown: true, size: '60px', image: true });
      assert.equal(await size().inputValue(), '60');
      assert.deepEqual(page.problems, []);
    });

    it('makes a piece jump onto its lines when asked to, and leaves it alone when not', async () => {
      await openEditorFor('Grid Snap');
      await toolbar().locator('.switch', { hasText: 'Snap to lines' }).click(); // (the lines of the other pieces would pull too)
      await gridSwitch().click();
      await size().fill('100');
      await size().press('Tab');
      const start = (await layout()).scoreboard;
      assert.equal(start, undefined);
      const before = (await editor(() => JSON.parse(JSON.stringify(window.oto.designEditor.canvas.rects.scoreboard)))).x;
      const scale = await zoom();
      // 63 pixels of the stage to the right: 3 pixels past a line, with the scoreboard's left edge at 340
      await dragPiece('scoreboard', 63 * scale, 0, { steps: 4 });
      assert.equal((await layout()).scoreboard.x, 63, 'free: where it was dropped, to the pixel');

      await editor(() => window.oto.designEditor.model.undo());
      await snapSwitch().click();
      await dragPiece('scoreboard', 63 * scale, 0, { steps: 4 });
      const moved = (await layout()).scoreboard;
      assert.equal(moved.x, 60, `snapped: the left edge (${before}) lands on the line at 400`);
      assert.deepEqual(await page.evaluate(() => JSON.parse(window.localStorage.getItem('oto-editor-grid'))), { show: true, snap: true, size: 100 });
      assert.equal(lineUp(before + moved.x, 100), 0);

      // Alt drops it exactly where the mouse is, as with the lines
      await editor(() => window.oto.designEditor.model.undo());
      await dragPiece('scoreboard', 63 * scale, 0, { steps: 4, alt: true });
      assert.equal((await layout()).scoreboard.x, 63);
      assert.deepEqual(page.problems, []);
    });
  });

  describe('the reserved spaces', () => {
    const tab = () => page.locator('.editor-side .tab[data-tab="spaces"]');
    const draftSpaces = () => page.evaluate(() => JSON.parse(JSON.stringify(window.oto.designEditor.model.draft.spaces)));
    const add = (shape) => page.locator(`.spaces-panel [data-add="${shape}"]`).click();
    const cards = () => page.locator('.space-card');
    const spaceBox = (index) => page.locator(`.editor-space[data-space="${index}"]`);
    const overlaySpaces = () => overlayFrame().$$eval('.space', (nodes) => nodes.map((node) => ({ left: node.offsetLeft, top: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight, shape: node.className.replace('space ', ''), frame: node.classList.contains('has-frame') })));
    const selected = () => page.evaluate(() => window.oto.designEditor.canvas.selected);

    async function dragBox(index, dx, dy, steps = 5) {
      const rect = await spaceBox(index).boundingBox();
      const from = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + dx, from.y + dy, { steps });
      await page.mouse.up();
      await wait(80);
    }

    it('have a tab of their own that starts empty, and three ways to add one, in the middle of the stage', async () => {
      await openEditorFor('Spaces Test');
      await tab().click();
      assert.match(await page.locator('.spaces-panel .empty').textContent(), /No reserved spaces yet/);
      assert.equal(await page.locator('.spaces-panel .section-label .hint').textContent(), '0 of 6');
      assert.deepEqual(await page.locator('.spaces-panel [data-add]').allTextContents(), ['A camera feed', 'Rounded', 'A circle']);
      assert.equal(await overlayFrame().locator('.space').count(), 0);

      await add('rect');
      assert.deepEqual(await draftSpaces(), [{ id: 1, name: 'Camera', shape: 'rect', x: 720, y: 405, w: 480, h: 270 }]);
      await add('circle');
      const [first, circle] = await draftSpaces();
      assert.deepEqual([circle.id, circle.name, circle.shape, circle.w, circle.h], [2, 'Round', 'circle', 320, 320]);
      assert.ok(circle.x !== first.x || circle.y !== first.y, 'not on top of the first');

      await page.waitForFunction(() => document.querySelector('.editor-frame').contentDocument.querySelectorAll('.space').length === 2);
      const [one, two] = await overlaySpaces();
      assert.deepEqual([one.left, one.top, one.w, one.h, one.shape], [720, 405, 480, 270, 'shape-rect']);
      assert.equal(two.shape, 'shape-circle');
      assert.equal(await page.locator('.editor-space').count(), 2, 'and a box for each, to pick it up by');
      assert.equal(await cards().count(), 2);
      assert.equal(await page.locator('.spaces-panel .section-label .hint').textContent(), '2 of 6');
      assert.deepEqual(page.problems, []);
    });

    it('stop at six, and a new one takes the lowest number that is free', async () => {
      await openEditorFor('Spaces Six', { spaces: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, shape: 'rect', x: 20 + i * 30, y: 20, w: 100, h: 100 })) });
      await tab().click();
      assert.equal(await cards().count(), 5);
      await cards().nth(1).getByRole('button', { name: 'Remove space 2' }).click();
      await add('rounded');
      assert.deepEqual((await draftSpaces()).map((space) => space.id), [1, 3, 4, 5, 2], 'the number that was free');
      assert.equal(await page.locator('.spaces-panel [data-add]').first().isDisabled(), false);
      await add('rect');
      assert.equal((await draftSpaces()).length, 6);
      assert.equal(await page.locator('.spaces-panel .section-label .hint').textContent(), '6 of 6');
      for (const button of await page.locator('.spaces-panel [data-add]').all()) assert.equal(await button.isDisabled(), true, 'no more');
    });

    it('are moved by dragging them on the canvas, nudged with the arrow keys, and taken away with Delete', async () => {
      await openEditorFor('Spaces Move', { spaces: [{ id: 1, name: 'Camera', shape: 'rect', x: 700, y: 400, w: 480, h: 270 }] });
      const scale = await zoom();
      await dragBox(0, 100 * scale, 50 * scale);
      const [moved] = await draftSpaces();
      assert.ok(Math.abs(moved.x - 800) <= 12 && Math.abs(moved.y - 450) <= 12, `moved by about (100, 50): ${moved.x}, ${moved.y}`);
      assert.equal(await selected(), 'space:0');
      assert.equal(await page.locator('.editor-side .tab[data-tab="spaces"]').getAttribute('aria-selected'), 'true', 'its tab came up');
      const selection = await page.locator('.editor-selection').boundingBox();
      const body = await spaceBox(0).boundingBox();
      assert.ok(Math.abs(selection.x - body.x) < 2 && Math.abs(selection.width - body.width) < 2, 'with handles around it');
      assert.match(await page.locator('.editor-selection-label').textContent(), /Camera/);

      await page.locator('.editor-viewport').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowDown');
      await wait(650);
      const [nudged] = await draftSpaces();
      assert.deepEqual([nudged.x - moved.x, nudged.y - moved.y], [1, 10]);
      await page.waitForFunction(([x, y]) => [...document.querySelector('.editor-frame').contentDocument.querySelectorAll('.space')].some((node) => node.offsetLeft === x && node.offsetTop === y), [nudged.x, nudged.y]);

      await page.keyboard.press('Delete');
      assert.deepEqual(await draftSpaces(), []);
      await page.waitForFunction(() => document.querySelector('.editor-frame').contentDocument.querySelectorAll('.space').length === 0);
      assert.equal(await page.locator('.editor-selection').isHidden(), true);
      await editor(() => window.oto.designEditor.model.undo());
      assert.equal((await draftSpaces()).length, 1, 'undo brings it back');
      assert.deepEqual(page.problems, []);
    });

    it('are resized by a corner, the corner opposite staying where it is, to a size that is not smaller than 40', async () => {
      await openEditorFor('Spaces Resize', { spaces: [{ id: 1, shape: 'rect', x: 760, y: 520, w: 400, h: 200 }] });
      await spaceBox(0).click();
      const handle = page.locator('.editor-handle.se');
      const scale = await zoom();
      const drag = async (dx, dy, shift = false) => {
        const at = await handle.boundingBox();
        await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
        if (shift) await page.keyboard.down('Shift');
        await page.mouse.down();
        await page.mouse.move(at.x + at.width / 2 + dx, at.y + at.height / 2 + dy, { steps: 5 });
        await page.mouse.up();
        if (shift) await page.keyboard.up('Shift');
        await wait(80);
      };
      await drag(100 * scale, 50 * scale);
      let [space] = await draftSpaces();
      assert.deepEqual([space.x, space.y], [760, 520], 'the top left corner stays');
      assert.ok(Math.abs(space.w - 500) <= 12 && Math.abs(space.h - 250) <= 12, `bigger by about (100, 50): ${space.w} x ${space.h}`);

      // from the other corner the bottom right one stays
      const bottomRight = { x: space.x + space.w, y: space.y + space.h };
      const north = page.locator('.editor-handle.nw');
      const at = await north.boundingBox();
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await page.mouse.down();
      await page.mouse.move(at.x + at.width / 2 - 60 * scale, at.y + at.height / 2 - 30 * scale, { steps: 5 });
      await page.mouse.up();
      await wait(80);
      [space] = await draftSpaces();
      assert.deepEqual([space.x + space.w, space.y + space.h], [bottomRight.x, bottomRight.y], 'the bottom right corner stays');
      assert.ok(space.x < 760 && space.y < 520);

      // not smaller than 40, and Shift keeps the shape
      await drag(-3000 * scale, -3000 * scale);
      [space] = await draftSpaces();
      assert.deepEqual([space.w, space.h], [40, 40]);
      await editor(() => window.oto.designEditor.model.update({ spaces: [{ id: 1, shape: 'rect', x: 760, y: 520, w: 400, h: 200 }] }));
      await page.waitForFunction(() => document.querySelector('.editor-selection') && !document.querySelector('.editor-selection').hidden);
      await drag(100 * scale, 0, true);
      [space] = await draftSpaces();
      assert.ok(Math.abs(space.w / space.h - 2) < 0.05, `still twice as wide as high: ${space.w} x ${space.h}`);
      assert.deepEqual(page.problems, []);
    });

    it('can be typed: the name, the shape and where it is and how big, each kept to what is allowed', async () => {
      await openEditorFor('Spaces Fields', { spaces: [{ id: 1, name: 'Camera', shape: 'rect', x: 100, y: 100, w: 300, h: 200 }] });
      await tab().click();
      const card = cards().first();
      const field = (label) => card.locator(`input[aria-label="${label} (space 1)"]`);
      assert.deepEqual(await Promise.all(['Across', 'Down', 'Wide', 'High'].map((label) => field(label).inputValue())), ['100', '100', '300', '200']);

      await field('Across').fill('250');
      await field('Across').press('Tab');
      await field('Wide').fill('5');
      await field('Wide').press('Tab');
      await field('High').fill('99999');
      await field('High').press('Tab');
      await card.locator('input[aria-label="Name of space 1"]').fill('Face cam');
      await card.locator('input[aria-label="Name of space 1"]').press('Tab');
      await card.locator('select[aria-label="Shape of space 1"]').selectOption('circle');
      assert.deepEqual((await draftSpaces())[0], { id: 1, name: 'Face cam', shape: 'circle', x: 250, y: 100, w: 40, h: 3840 });
      await page.waitForFunction(() => document.querySelector('.editor-frame').contentDocument.querySelector('.space.shape-circle'));
      assert.equal(await field('Wide').inputValue(), '40', 'the box shows what was kept');
      assert.equal((await page.locator('.editor-space-label').textContent()), 'Face cam');

      await card.locator('input[aria-label="Name of space 1"]').fill('');
      await card.locator('input[aria-label="Name of space 1"]').press('Tab');
      assert.equal('name' in (await draftSpaces())[0], false);
      assert.equal(await page.locator('.editor-space-label').textContent(), 'Space 1', 'and a space with no name is called by its number');
    });

    it('go with the overlay: picking one on the list picks it on the canvas, and picking a piece goes back to the pieces', async () => {
      await openEditorFor('Spaces Pick', { spaces: [{ id: 1, shape: 'rect', x: 700, y: 400, w: 300, h: 200 }, { id: 2, name: 'Second', shape: 'rounded', x: 100, y: 700, w: 300, h: 200 }] });
      await tab().click();
      assert.equal(await selected(), null);
      await cards().nth(1).locator('.space-head').click({ position: { x: 5, y: 5 } });
      assert.equal(await selected(), 'space:1');
      assert.equal(await cards().nth(1).evaluate((node) => node.classList.contains('on')), true);
      assert.match(await page.locator('.editor-selection-label').textContent(), /Second/);
      assert.equal(await page.locator('.block-fields').isHidden(), true, 'the layout fields are for the pieces');

      await box('scoreboard').click();
      assert.equal(await selected(), 'scoreboard');
      assert.equal(await page.locator('.editor-side .tab[data-tab="layout"]').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('.block-fields').isVisible(), true);
      assert.equal(await editor(() => window.oto.designEditor.canvas.selectedSpace), null, 'no space is picked any more');
    });

    it('can have a picture each, put on from the tab and taken off again, and the overlay draws it over the space', async () => {
      await openEditorFor('Spaces Frames', { spaces: [{ id: 1, shape: 'rounded', x: 700, y: 400, w: 400, h: 225 }] });
      await tab().click();
      assert.equal(await cards().first().locator('.space-frame .image-preview').textContent(), 'None');
      const chooser = page.waitForEvent('filechooser');
      await cards().first().getByRole('button', { name: 'Upload' }).click();
      await (await chooser).setFiles({ name: 'frame.png', mimeType: 'image/png', buffer: S.PNG });
      await page.waitForFunction(() => document.querySelector('.space-frame .image-preview img'));
      assert.ok((await api('GET', '/api/themes/Spaces%20Frames')).json.images.spaceFrame1, 'saved at once, with the design\'s pictures');
      assert.match(await page.locator('.space-frame .image-preview img').getAttribute('src'), /\/api\/themes\/Spaces%20Frames\/assets\/images\/spaceFrame1\.png\?v=\d+/);
      await page.waitForFunction(() => document.querySelector('.editor-frame').contentDocument.querySelector('.space.has-frame'));
      assert.match(await overlayFrame().$eval('.space', (node) => getComputedStyle(node).backgroundImage), /spaceFrame1\.png/);
      assert.equal(await cards().first().getByRole('button', { name: 'Replace' }).count(), 1);

      await cards().first().getByRole('button', { name: 'Remove', exact: true }).last().click();
      await page.waitForFunction(() => !document.querySelector('.space-frame .image-preview img'));
      assert.equal((await api('GET', '/api/themes/Spaces%20Frames')).json.images.spaceFrame1, undefined);
      await page.waitForFunction(() => !document.querySelector('.editor-frame').contentDocument.querySelector('.space.has-frame'));

      // a picture that is too big is not sent
      const big = page.waitForEvent('filechooser');
      await cards().first().getByRole('button', { name: 'Upload' }).click();
      await (await big).setFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024) });
      await page.waitForFunction(() => /larger than 4.5 MB/.test(document.querySelector('.toast').textContent));
      assert.equal((await api('GET', '/api/themes/Spaces%20Frames')).json.images.spaceFrame1, undefined);
      assert.deepEqual(nativeDialogs, []);
    });

    it('are saved with the design, listed as code, read again, and the list of pictures in the settings has a slot for each', async () => {
      await openEditorFor('Spaces Saved');
      await tab().click();
      await add('rounded');
      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
      assert.match(await page.locator('.code-input').inputValue(), /"spaces": \[\s*\{\s*"id": 1,\s*"name": "Camera",\s*"shape": "rounded"/);
      // another space, typed as code
      const code = JSON.parse(await page.locator('.code-input').inputValue());
      code.spaces.push({ id: 3, shape: 'circle', x: 10, y: 10, w: 100, h: 100 });
      await page.locator('.code-input').fill(JSON.stringify(code));
      await page.waitForFunction(() => document.querySelectorAll('.editor-space').length === 2);
      await page.locator('.code-input').fill(JSON.stringify({ spaces: [{ shape: 'blob', x: 1, y: 1, w: 100, h: 100 }] }));
      await page.waitForFunction(() => /Space 1: the shape can be/.test(document.querySelector('.code-status').textContent));
      assert.equal(await page.locator('.editor-space').count(), 2, 'a mistake changes nothing');
      await page.locator('.code-input').fill(JSON.stringify(code));
      await page.waitForFunction(() => /Applied/.test(document.querySelector('.code-status').textContent));

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.editor-status').textContent === 'Saved');
      const saved = (await api('GET', '/api/themes/Spaces%20Saved')).json;
      assert.deepEqual(saved.spaces.map((space) => space.id), [1, 3]);
      await editorModal('Spaces Saved').locator('.modal-foot').getByRole('button', { name: 'Close', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.modal[aria-label="Design: Spaces Saved"]'));
      await page.waitForFunction(() => [...document.querySelectorAll('.image-row .image-info strong')].some((node) => node.textContent === 'Space 1: frame'));
      const slots = await page.locator('.image-row .image-info strong').allTextContents();
      assert.ok(slots.includes('Space 1: frame') && slots.includes('Space 3: frame'), `a slot for each space: ${slots.join(', ')}`);
      assert.ok(!slots.includes('Space 2: frame') && !slots.includes('Space 4: frame'), 'and none for the others');
    });
  });

  describe('the fonts of the groups of text', () => {
    const tab = () => page.locator('.editor-side .tab[data-tab="fonts"]');
    const row = (role) => page.locator(`.font-row[data-role="${role}"]`);
    const draftFamilies = () => page.evaluate(() => JSON.parse(JSON.stringify(window.oto.designEditor.model.draft.fontFamilies)));
    const frameVar = (name) => overlayFrame().evaluate((key) => document.documentElement.style.getPropertyValue(key).trim(), name);

    it('has a row for the main font and for each group of text, with what each is for', async () => {
      await openEditorFor('Type Test');
      await tab().click();
      assert.deepEqual(await page.locator('.font-row .font-info strong').allTextContents(), ['Main font', 'Names', 'Numbers', 'Labels and tags', 'Announcement titles', 'Announcement subtitles', 'Small text']);
      assert.match(await row('names').locator('small').textContent(), /Trainers, Pokémon, feature cards and the Stadium/);
      assert.equal(await row('names').locator('[data-remove]').isHidden(), true, 'no font file to take off');
      assert.deepEqual(page.problems, []);
    });

    it('puts the fonts that are typed on the overlay as they are typed, and leaves what is not a list of fonts out', async () => {
      await openEditorFor('Type Test');
      await tab().click();
      await row('names').locator('input').fill('Impact, "Arial Black", sans-serif');
      assert.deepEqual(await draftFamilies(), { names: 'Impact, "Arial Black", sans-serif' });
      await page.waitForFunction(() => /^Impact/.test(document.querySelector('.editor-frame').contentDocument.documentElement.style.getPropertyValue('--font-names')));
      assert.match(await overlayFrame().$eval('.sb-name', (node) => getComputedStyle(node).fontFamily), /^Impact/);

      await row('numbers').locator('input').fill('url(http://x.example/f.woff)');
      assert.match(await row('numbers').locator('.prompt-complaint').textContent(), /The fonts for "numbers" can use letters, digits/);
      assert.equal(await row('numbers').locator('input').getAttribute('aria-invalid'), 'true');
      assert.deepEqual(await draftFamilies(), { names: 'Impact, "Arial Black", sans-serif' }, 'the design keeps what could be used');
      await row('numbers').locator('input').fill('Georgia');
      assert.equal(await row('numbers').locator('.prompt-complaint').isHidden(), true);

      // it is in the code, and emptying the box goes back to the main font
      await page.locator('.editor-side .tab', { hasText: 'Code' }).click();
      assert.match(await page.locator('.code-input').inputValue(), /"fontFamilies": \{\s*"names": "Impact, \\"Arial Black\\", sans-serif",\s*"numbers": "Georgia"/);
      await tab().click();
      await row('names').locator('input').fill('');
      assert.deepEqual(await draftFamilies(), { numbers: 'Georgia' });
      assert.equal(await frameVar('--font-names'), '');
    });

    it('takes a font file for a group, saved at once, and takes it off again', async () => {
      await openEditorFor('Type Test');
      await tab().click();
      const chooser = page.waitForEvent('filechooser');
      await row('labels').locator('[data-upload]').click();
      await (await chooser).setFiles({ name: 'tags.woff2', mimeType: 'font/woff2', buffer: S.WOFF2 });
      await page.waitForFunction(() => document.querySelector('.font-row[data-role="labels"] .font-file').textContent === 'labels.woff2');
      assert.equal((await api('GET', '/api/themes/Type%20Test')).json.fonts.labels, 'fonts/labels.woff2');
      assert.equal(await row('labels').locator('[data-upload]').textContent(), 'Replace the font file');
      assert.equal(await row('labels').locator('[data-remove]').isVisible(), true);

      // the main font is the design's own "font"
      const main = page.waitForEvent('filechooser');
      await row('display').locator('[data-upload]').click();
      await (await main).setFiles({ name: 'main.woff2', mimeType: 'font/woff2', buffer: S.WOFF2 });
      await page.waitForFunction(() => document.querySelector('.font-row[data-role="display"] .font-file').textContent === 'font.woff2');
      assert.equal((await api('GET', '/api/themes/Type%20Test')).json.font, 'fonts/font.woff2');

      await row('labels').locator('[data-remove]').click();
      await page.waitForFunction(() => document.querySelector('.font-row[data-role="labels"] .font-file').textContent === '');
      assert.equal((await api('GET', '/api/themes/Type%20Test')).json.fonts, undefined);

      // too big, or not a font
      const big = page.waitForEvent('filechooser');
      await row('names').locator('[data-upload]').click();
      await (await big).setFiles({ name: 'huge.woff2', mimeType: 'font/woff2', buffer: Buffer.alloc(5 * 1024 * 1024) });
      await page.waitForFunction(() => /larger than 4.5 MB/.test(document.querySelector('.toast').textContent));
      const wrong = page.waitForEvent('filechooser');
      await row('names').locator('[data-upload]').click();
      await (await wrong).setFiles({ name: 'tags.png', mimeType: 'image/png', buffer: S.PNG });
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((toast) => /not a supported font/.test(toast.textContent)));
      assert.equal((await api('GET', '/api/themes/Type%20Test')).json.fonts, undefined);
      assert.deepEqual(nativeDialogs, []);
    });

    it('is saved with the design and read again', async () => {
      await openEditorFor('Type Test');
      await tab().click();
      await row('banners').locator('input').fill('Verdana');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.editor-status').textContent === 'Saved');
      assert.deepEqual((await api('GET', '/api/themes/Type%20Test')).json.fontFamilies, { banners: 'Verdana' });
    });
  });

  describe('the live match', () => {
    it('can draw the match as it really is', async () => {
      const producer = server.client({ clientId: 'ui-editor-live', name: 'Maya' });
      await producer.ready();
      await producer.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
      await producer.act('action:trainerA', { action: 'setName', name: 'Real Ash' });
      await openEditorFor('Live Test');
      assert.equal(await overlayFrame().locator('.sb-name').first().textContent(), 'Ash', 'a sample match to begin with');
      await page.locator('select[aria-label="The match to draw"]').selectOption('live');
      await page.waitForFunction(() => document.querySelector('.editor-frame').contentDocument.querySelector('.sb-name').textContent === 'Real Ash');
      await producer.act('action:trainerA', { action: 'setName', name: 'Newer Ash' });
      await page.waitForFunction(() => document.querySelector('.editor-frame').contentDocument.querySelector('.sb-name').textContent === 'Newer Ash');
      producer.close();
    });
  });
});
