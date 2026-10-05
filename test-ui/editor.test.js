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
      assert.equal(await frame.locator('.trainer-a .prize.penalty').count(), 1, 'even a penalty, so it can be placed');
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
      assert.deepEqual(JSON.parse(text), { author: '', description: '', colors: {}, layout: {}, crop: {} });
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

  describe('the card crop selector', () => {
    beforeEach(async () => {
      await openEditorFor('Crop Test');
      await page.locator('.editor-side .tab', { hasText: 'Card crop' }).click();
    });
    const rectFields = async () => Object.fromEntries(await Promise.all(['Left', 'Top', 'Width', 'Height'].map(async (label) => [label, await page.locator(`.crop-field input[aria-label^="${label}"]`).inputValue()])));
    const cardBox = (side = 'a', where = '.active') => overlayFrame().evaluate(({ side, where }) => { const art = document.querySelector(`.trainer-${side} ${where} .art`).getBoundingClientRect(); return { w: art.width, h: art.height }; }, { side, where });

    it('starts with the whole card for both, and presets change what the overlay shows', async () => {
      assert.deepEqual(await rectFields(), { Left: '0', Top: '0', Width: '100', Height: '100' });
      assert.equal(await page.locator('.crop-panel .btn[data-preset="full"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.crop-panel input[aria-label="Use the same crop for the bench"]').isChecked(), true);
      assert.equal((await cardBox()).h, 418);

      await page.locator('.crop-panel .btn[data-preset="art"]').click();
      assert.deepEqual(await crop(), { active: { x: 0.07, y: 0.115, w: 0.86, h: 0.385 }, bench: { x: 0.07, y: 0.115, w: 0.86, h: 0.385 } }, 'the bench follows');
      await drawn();
      const active = await cardBox();
      assert.ok(Math.abs(active.h - 300 * 1.3933 * 0.385 / 0.86) < 1, `the Active Pokémon is as tall as its art: ${active.h}`);
      assert.ok(Math.abs((await cardBox('a', '.bench')).h - 104 * 1.3933 * 0.385 / 0.86) < 1, 'and so is the bench');
      assert.equal(await page.locator('.crop-panel .btn[data-preset="art"]').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await rectFields(), { Left: '7', Top: '11.5', Width: '86', Height: '38.5' });
      assert.match(await page.locator('.crop-summary').textContent(), /Shows 86% of the width and 38.5% of the height/);

      await page.locator('.crop-panel .btn[data-preset="full"]').click();
      assert.deepEqual(await crop(), {}, 'the whole card is the same as no crop');
      await drawn();
      assert.equal((await cardBox()).h, 418);
    });

    it('crops the bench on its own when the switch is off', async () => {
      await page.locator('.crop-panel .switch').click();
      await page.locator('.crop-panel .btn[data-preset="art"]').click();
      assert.deepEqual(await crop(), { active: { x: 0.07, y: 0.115, w: 0.86, h: 0.385 } });
      await page.locator('.crop-panel .seg', { hasText: 'Bench' }).click();
      assert.deepEqual(await rectFields(), { Left: '0', Top: '0', Width: '100', Height: '100' }, 'the bench has its own');
      await page.locator('.crop-panel .btn[data-preset="top"]').click();
      assert.deepEqual((await crop()).bench, { x: 0.02, y: 0.02, w: 0.96, h: 0.48 });
      assert.deepEqual((await crop()).active, { x: 0.07, y: 0.115, w: 0.86, h: 0.385 }, 'the Active Pokémon keeps its own');
      // turning it on again makes the bench like the one being looked at
      await page.locator('.crop-panel .switch').click();
      assert.deepEqual((await crop()).active, (await crop()).bench);
    });

    it('moves and resizes the rectangle on the card with the mouse', async () => {
      const stage = await page.locator('.crop-stage').boundingBox();
      const at = (fx, fy) => ({ x: stage.x + stage.width * fx, y: stage.y + stage.height * fy });

      // draw a new one
      await page.mouse.move(at(0.2, 0.2).x, at(0.2, 0.2).y);
      await page.mouse.down();
      await page.mouse.move(at(0.6, 0.5).x, at(0.6, 0.5).y, { steps: 5 });
      await page.mouse.up();
      let rect = (await crop()).active;
      assert.ok(Math.abs(rect.x - 0.2) < 0.01 && Math.abs(rect.y - 0.2) < 0.01 && Math.abs(rect.w - 0.4) < 0.01 && Math.abs(rect.h - 0.3) < 0.01, JSON.stringify(rect));

      // move it by its middle
      const middle = at(rect.x + rect.w / 2, rect.y + rect.h / 2);
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.down();
      await page.mouse.move(middle.x + stage.width * 0.1, middle.y + stage.height * 0.2, { steps: 5 });
      await page.mouse.up();
      const moved = (await crop()).active;
      assert.ok(Math.abs(moved.x - 0.3) < 0.01 && Math.abs(moved.y - 0.4) < 0.01 && Math.abs(moved.w - rect.w) < 0.001 && Math.abs(moved.h - rect.h) < 0.001, JSON.stringify(moved));

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
        assert.match(await page.locator('.crop-summary').textContent(), /A circle 53.6% as wide as the card, cut out of each Special Energy card/);
      });

      it('starts with the usual circle in the middle of the picture window, which is not written down', async () => {
        assert.deepEqual([await fieldValue('Left'), await fieldValue('Top'), await fieldValue('Width')], ['23.2', '11.5', '53.6']);
        assert.equal(await circle(), undefined, 'the usual circle is the same as nothing');
        assert.equal(await page.locator('.crop-circle-presets .btn').getAttribute('aria-pressed'), 'true');
      });

      it('grows from a corner, always a circle, and stays on the card', async () => {
        const handle = await page.locator('.crop-handle.se').boundingBox();
        const area = await stage();
        const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
        await dragTo(from, { x: from.x + area.width * 0.06, y: from.y + area.height * 0.06 });
        const bigger = await circle();
        assert.ok(bigger.w > 0.55, `wider than before: ${JSON.stringify(bigger)}`);
        assert.ok(Math.abs(bigger.w * 300 - bigger.h * 418) < 1, 'the same number of pixels across and down');
        assert.ok(Math.abs(bigger.x - 0.232) < 0.002 && Math.abs(bigger.y - 0.115) < 0.002, 'the corner it grew from stayed');
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
        const middle = { x: area.x + area.width * 0.5, y: area.y + area.height * 0.3075 };
        await dragTo(middle, { x: middle.x, y: middle.y + area.height * 0.3 });
        const moved = await circle();
        assert.ok(Math.abs(moved.y - 0.415) < 0.01 && Math.abs(moved.x - 0.232) < 0.002 && Math.abs(moved.w - 0.536) < 0.002, JSON.stringify(moved));

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
        assert.deepEqual([await fieldValue('Left'), await fieldValue('Top'), await fieldValue('Width')], ['23.2', '11.5', '53.6']);
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
      await page.locator('.crop-panel .btn[data-preset="art"]').click();
      assert.deepEqual((await api('GET', '/api/themes/Save%20Test')).json.layout, undefined, 'nothing is saved before Save');
      assert.equal(await overlay.locator('.moved').count(), 0, 'and the stream does not see it');

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.editor-status').textContent === 'Saved');
      const design = (await api('GET', '/api/themes/Save%20Test')).json;
      assert.deepEqual(design.layout, { scoreboard: { x: 0, y: 10, scale: 1 } });
      assert.deepEqual(design.crop.active, { x: 0.07, y: 0.115, w: 0.86, h: 0.385 });
      await overlay.waitForSelector('.scoreboard.moved');
      await overlay.waitForSelector('html.has-crop-active');
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
