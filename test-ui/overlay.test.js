/**
 * The overlay in a real browser: what viewers see, as the producers change the game.
 * Run with: npm run test:ui
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wait } = require('../test-support/harness');
const { findBrowser, launch, openPage } = require('./browser');

const skip = findBrowser() ? false : 'no Chrome or Edge found (set BROWSER_PATH to use another)';
const IMG = '/art/test.svg';
const require_blocks = () => require('../public/js/theme-options').BLOCK_KEYS;

describe('overlay', { skip }, () => {
  let browser;
  let server;
  let producer;
  let page;

  before(async () => {
    server = await startServer({ label: 'ui-overlay' });
    producer = server.client({ clientId: 'ui-overlay-producer', name: 'Maya' });
    await producer.ready();
    browser = await launch();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  });

  const send = (event, payload) => producer.act(event, payload);
  const live = async () => (await fetch(`${server.base}/api/state`)).json();

  beforeEach(async () => {
    await send('action:reset', { action: 'full', confirm: 'FULL_RESET' });
    await send('action:trainerA', { action: 'setName', name: 'Ash' });
    await send('action:trainerB', { action: 'setName', name: 'Gary' });
    await send('action:trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 100 });
    await send('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'fire', count: 2 });
    await send('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'water', count: 1 });
    page = await openPage(browser, `${server.base}/overlay`);
    await page.waitForSelector('.trainer-a .active .mon:not([hidden])');
  });

  afterEach(async () => { await page.context().close(); });

  describe('a penalty', () => {
    const reds = (side = 'a') => page.$$eval(`.trainer-${side} .prize`, (nodes) => nodes.map((node) => node.classList.contains('penalty')));
    const flag = (side = 'a') => page.locator(`.trainer-${side} .prize-flag`).textContent();

    it('marks that many prize cards in red', async () => {
      assert.deepEqual(await reds(), [false, false, false, false, false, false]);
      assert.equal(await flag(), '');

      await send('action:trainerA', { action: 'prizePenaltySet', count: 2 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.penalty').length === 2);
      assert.deepEqual(await reds(), [true, true, false, false, false, false]);
      assert.equal(await flag(), 'PENALTY');
      assert.deepEqual(await reds('b'), [false, false, false, false, false, false], 'the other trainer is not marked');

      await send('action:trainerA', { action: 'prizePenaltyPlus' });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.penalty').length === 3);
      await send('action:trainerA', { action: 'prizePenaltySet', count: 0 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.penalty').length === 0);
      assert.equal(await flag(), '');
    });

    it('looks red', async () => {
      await send('action:trainerA', { action: 'prizePenaltySet', count: 1 });
      await page.waitForSelector('.trainer-a .prize.penalty');
      const looks = await page.evaluate(() => {
        const danger = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
        const probe = document.createElement('i');
        probe.style.color = danger;
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        const card = document.querySelector('.trainer-a .prize.penalty');
        const plain = document.querySelector('.trainer-a .prize:not(.penalty)');
        return {
          expected,
          border: getComputedStyle(card).borderTopColor,
          tint: getComputedStyle(card, '::before').backgroundColor,
          tintShown: getComputedStyle(card, '::before').content !== 'none',
          plainTint: getComputedStyle(plain, '::before').content
        };
      });
      assert.equal(looks.border, looks.expected, 'a red border');
      assert.equal(looks.tint, looks.expected, 'a red tint over the card back');
      assert.equal(looks.tintShown, true);
      assert.equal(looks.plainTint, 'none', 'the other prize cards stay as they are');
    });

    it('only marks prize cards that are still there', async () => {
      await send('action:trainerA', { action: 'prizePenaltySet', count: 4 });
      await send('action:trainerA', { action: 'prizeSet', count: 2 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.taken').length === 4);
      assert.deepEqual(await reds(), [true, true, false, false, false, false], 'two are left, so two can be red');
      assert.equal((await live()).trainerA.prizes.penalty, 4, 'the penalty itself is kept');

      await send('action:trainerA', { action: 'prizeSet', count: 6 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.penalty').length === 4);
    });

    it('pulses unless the penalty animation is switched off', async () => {
      await send('action:trainerA', { action: 'prizePenaltySet', count: 1 });
      await page.waitForSelector('.trainer-a .prizes.pulse');
      await send('action:settings', { action: 'update', showPenaltyAnimation: false });
      await page.waitForFunction(() => !document.querySelector('.trainer-a .prizes.pulse'));
      assert.equal(await page.locator('.trainer-a .prize.penalty').count(), 1, 'still marked, only still');
    });
  });

  describe('energy', () => {
    it('shows the type icons', async () => {
      const chips = await page.$$eval('.trainer-a .active .energy', (nodes) => nodes.map((node) => ({
        type: node.className.replace('energy ', ''),
        image: getComputedStyle(node).backgroundImage,
        color: getComputedStyle(node).backgroundColor,
        border: getComputedStyle(node).borderTopWidth
      })));
      assert.deepEqual(chips.map((chip) => chip.type), ['energy-fire', 'energy-fire', 'energy-water']);
      assert.match(chips[0].image, /\/assets\/energy\/fire\.png/);
      assert.match(chips[2].image, /\/assets\/energy\/water\.png/);
      assert.equal(chips[0].color, 'rgba(0, 0, 0, 0)', 'the picture, not a colored disc');
      assert.equal(chips[0].border, '0px');

      // and the pictures really load
      const sizes = await page.evaluate(async () => Promise.all(window.OTO_GAME.ENERGY_TYPES.map(async (type) => {
        const image = new Image();
        image.src = type.icon;
        await image.decode();
        return [type.key, image.naturalWidth, image.naturalHeight];
      })));
      assert.equal(sizes.length, 11);
      for (const [key, width, height] of sizes) assert.deepEqual([width, height], [30, 30], key);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('no-energy-icons')), false);
      assert.deepEqual(page.problems, []);
    });

    it('draws plain colored discs when the icon files are not there', async () => {
      const bare = await openPage(browser, 'about:blank');
      await bare.route('**/assets/energy/*', (route) => route.fulfill({ status: 404, body: 'gone' }));
      await bare.goto(`${server.base}/overlay`);
      await bare.waitForSelector('.trainer-a .active .energy');
      await bare.waitForFunction(() => document.documentElement.classList.contains('no-energy-icons'));
      const disc = await bare.$eval('.trainer-a .active .energy-fire', (node) => ({ image: getComputedStyle(node).backgroundImage, color: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderTopWidth }));
      assert.equal(disc.image, 'none');
      assert.notEqual(disc.color, 'rgba(0, 0, 0, 0)');
      assert.equal(disc.border, '2px');
      await bare.context().close();
    });

    describe('a Special Energy card', () => {
      // a card whose picture window is green and everything else blue, so what the circle shows can be told by color
      const GREEN = '32,208,64';
      const BLUE = '32,48,208';
      const flatCard = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="418"><rect width="300" height="418" fill="#2030d0"/><rect x="21" y="48.07" width="258" height="160.93" fill="#20d040"/></svg>';
      const api = async (method, route, body) => {
        const response = await fetch(`${server.base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return response.json().catch(() => null);
      };
      const wear = async (design) => {
        await api('PUT', `/api/themes/${encodeURIComponent(design.name)}`, design);
        await api('POST', '/api/theme/active', { name: design.name });
        await page.waitForFunction((name) => fetch('/api/theme', { cache: 'no-store' }).then((r) => r.json()).then((d) => d.name === name), design.name);
        await page.evaluate(() => window.oto.loadTheme());
      };
      afterEach(async () => {
        await api('POST', '/api/theme/active', { name: null });
        for (const name of (await api('GET', '/api/themes')).names) await api('DELETE', `/api/themes/${encodeURIComponent(name)}`);
      });

      beforeEach(async () => {
        await page.route('**/art/flat-energy.svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: flatCard }));
        await send('action:trainerA', { action: 'attachSpecialEnergy', slot: -1, cardId: 'sv-e1', name: 'Flat Energy', image: '/art/flat-energy.svg', countsAsTurn: false });
        await page.waitForSelector('.trainer-a .active .energy-special img');
        await page.waitForFunction(() => { const img = document.querySelector('.trainer-a .active .energy-special img'); return img && img.complete && img.naturalWidth > 0; });
      });

      // the colors under five points of the chip: the middle and four points well inside the circle
      const seen = () => page.evaluate(() => {
        const chip = document.querySelector('.trainer-a .active .energy-special');
        const img = chip.querySelector('img');
        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 418;
        const context = canvas.getContext('2d');
        context.drawImage(img, 0, 0, 300, 418);
        const box = chip.getBoundingClientRect();
        const imgBox = img.getBoundingClientRect();
        const colorAt = (fx, fy) => {
          const px = ((box.left + box.width * fx - imgBox.left) / imgBox.width) * 300;
          const py = ((box.top + box.height * fy - imgBox.top) / imgBox.height) * 418;
          return Array.from(context.getImageData(Math.min(299, Math.max(0, Math.floor(px))), Math.min(417, Math.max(0, Math.floor(py))), 1, 1).data).slice(0, 3).join(',');
        };
        return [colorAt(0.5, 0.5), colorAt(0.3, 0.3), colorAt(0.7, 0.3), colorAt(0.3, 0.7), colorAt(0.7, 0.7)];
      });

      it('is drawn as a circle cut out of the picture window, next to the basic energy', async () => {
        const chips = await page.$$eval('.trainer-a .active .energies .energy', (nodes) => nodes.map((node) => node.className));
        assert.deepEqual(chips, ['energy energy-fire', 'energy energy-fire', 'energy energy-water', 'energy energy-special']);
        const look = await page.$eval('.trainer-a .active .energy-special', (node) => {
          const style = getComputedStyle(node);
          const img = node.querySelector('img').getBoundingClientRect();
          const box = node.getBoundingClientRect();
          return { w: box.width, h: box.height, radius: style.borderTopLeftRadius, overflow: style.overflow, imgW: img.width, imgLeft: img.left - box.left - 2, imgTop: img.top - box.top - 2, title: node.title };
        });
        assert.equal(look.w, 30);
        assert.equal(look.h, 30);
        assert.equal(look.radius, '50%');
        assert.equal(look.overflow, 'hidden');
        assert.equal(look.title, 'Flat Energy');
        // 26 pixels inside the border show 0.536 of the card's width
        assert.ok(Math.abs(look.imgW - 26 / 0.536) < 0.5, `picture ${look.imgW} px wide`);
        assert.ok(Math.abs(look.imgLeft - 26 * (0.5 - 0.5 / 0.536)) < 0.6, `picture left ${look.imgLeft}`);
        assert.ok(Math.abs(look.imgTop - 26 * (0.5 - 0.3075 * 1.3933 / 0.536)) < 0.6, `picture top ${look.imgTop}`);
        assert.deepEqual([...new Set(await seen())], [GREEN], 'only the picture window shows in the circle');
      });

      it('is smaller on the bench, and one is shown for each card, up to four', async () => {
        await send('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-2', name: 'Eevee', image: IMG, hp: 60 });
        await send('action:trainerA', { action: 'attachSpecialEnergy', slot: 0, cardId: 'sv-e2', name: 'Other Energy', image: '/art/flat-energy.svg', countsAsTurn: false });
        await page.waitForSelector('.trainer-a .bench .energy-special');
        const size = await page.$eval('.trainer-a .bench .energy-special', (node) => [node.getBoundingClientRect().width, node.getBoundingClientRect().height]);
        assert.deepEqual(size, [15, 15]);
        for (const n of [3, 4, 5]) await send('action:trainerA', { action: 'attachSpecialEnergy', slot: -1, cardId: `sv-e${n}`, name: `Energy ${n}`, image: '/art/flat-energy.svg', countsAsTurn: false });
        await page.waitForFunction(() => document.querySelectorAll('.trainer-a .active .energy-special').length === 4);
        assert.equal(await page.locator('.trainer-a .active .energy-special').count(), 4, 'the fifth was refused');
        // and one with no picture is a plain disc, not a broken image
        await send('action:trainerB', { action: 'setActive', cardId: 'b-1', name: 'Gary Mon', image: IMG, hp: 80 });
        await send('action:trainerB', { action: 'attachSpecialEnergy', slot: -1, cardId: 'sv-e9', name: 'No Picture', image: '', countsAsTurn: false });
        await page.waitForSelector('.trainer-b .active .energy-special');
        assert.equal(await page.locator('.trainer-b .active .energy-special img').count(), 0);
        assert.equal(await page.$eval('.trainer-b .active .energy-special', (node) => getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)'), true);
      });

      it('shows the circle a design chooses, and goes back to the usual one without it', async () => {
        // a circle over the blue part of the card
        await wear({ name: 'Round', crop: { energy: { x: 0.35, y: 0.62, w: 0.3 } } });
        await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ed').trim() !== '');
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ed').trim()), '0.3');
        assert.ok(Math.abs(Number(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ex'))) - 0.5) < 0.001);
        assert.deepEqual([...new Set(await seen())], [BLUE], 'now it shows the lower part of the card');

        await api('POST', '/api/theme/active', { name: null });
        await page.evaluate(() => window.oto.loadTheme());
        await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ed').trim() === '');
        assert.deepEqual([...new Set(await seen())], [GREEN], 'the usual circle is back');
      });

      it('goes away with the card it was attached to, and when it is taken off', async () => {
        await send('action:trainerA', { action: 'removeSpecialEnergy', slot: -1, index: 0 });
        await page.waitForFunction(() => !document.querySelector('.trainer-a .active .energy-special'));
        assert.equal(await page.locator('.trainer-a .active .energies').isHidden(), false, 'the basic energy is still there');
      });
    });

    it('lets a design replace the icons with its own strip', async () => {
      await page.evaluate(() => {
        document.getElementById('stage').classList.add('has-energy-sprite');
        document.documentElement.style.setProperty('--energySymbols', 'url("/logo.gif")');
      });
      const image = await page.$eval('.trainer-a .active .energy-fire', (node) => getComputedStyle(node).backgroundImage);
      assert.match(image, /logo\.gif/, 'the design wins over the built-in icon');
    });
  });

  describe('the GX and VSTAR markers', () => {
    const marker = (side, name) => page.locator(`.trainer-${side} .token.marker`, { hasText: name });
    const shown = async (side, name) => (await marker(side, name).count()) > 0 && marker(side, name).isVisible();

    it('are not shown until the producer asks for them; then they show ready or used, and come back when a game is won', async () => {
      assert.equal(await shown('a', 'GX'), false);
      assert.equal(await shown('b', 'VSTAR'), false);
      assert.equal((await live()).settings.display.gxMarker, false);

      await send('action:settings', { action: 'update', display: { gxMarker: true, vstarMarker: true } });
      await page.waitForFunction(() => [...document.querySelectorAll('.trainer-a .token.marker')].every((node) => node.offsetParent !== null));
      for (const side of ['a', 'b']) for (const name of ['GX', 'VSTAR']) assert.equal(await shown(side, name), true, `${side} ${name}`);
      assert.equal(await page.locator('.token.marker.used').count(), 0, 'nothing used yet');

      await send('action:trainerA', { action: 'gxPlus' });
      await page.waitForSelector('.trainer-a .token.marker.used');
      assert.equal(await page.locator('.trainer-a .token.marker.used .token-label').textContent(), 'GX');
      assert.equal(await page.locator('.trainer-b .token.marker.used').count(), 0, 'the other trainer still has theirs');
      await send('action:trainerB', { action: 'vstarPlus' });
      await page.waitForSelector('.trainer-b .token.marker.used');
      assert.equal(await page.locator('.trainer-b .token.marker.used .token-label').textContent(), 'VSTAR');

      // the used one is crossed out, the ready one is not
      const lines = await page.$$eval('.token.marker .token-label', (nodes) => nodes.map((node) => getComputedStyle(node).textDecorationLine));
      assert.equal(lines.filter((line) => line === 'line-through').length, 2);

      // a game is won: both trainers have both again
      await send('action:match', { action: 'trainerAMatchWin' });
      await page.waitForFunction(() => document.querySelectorAll('.token.marker.used').length === 0);
      assert.deepEqual(page.problems, []);
    });

    it('come back at the start of a new game, and the energy, stadium and supporter tokens are untouched by it', async () => {
      await send('action:settings', { action: 'update', display: { gxMarker: true, vstarMarker: true } });
      await send('action:trainerA', { action: 'vstarPlus' });
      await send('action:trainerA', { action: 'energyPlus' });
      await page.waitForSelector('.trainer-a .token.marker.used');
      await send('action:match', { action: 'startGame' });
      await page.waitForFunction(() => document.querySelectorAll('.token.marker.used').length === 0);
      assert.equal(await page.locator('.trainer-a .token.used').count(), 1, 'only the energy attachment of this turn is still used');
    });

    it('hide with the other switches', async () => {
      await send('action:settings', { action: 'update', display: { gxMarker: true } });
      await page.waitForFunction(() => document.querySelector('.trainer-a .token.marker').offsetParent !== null);
      await send('action:settings', { action: 'update', display: { gxMarker: false } });
      await page.waitForFunction(() => document.querySelector('.trainer-a .token.marker').offsetParent === null);
    });
  });

  describe('status conditions', () => {
    const chips = (side = 'a') => page.$$eval(`.trainer-${side} .active .status-chip`, (nodes) => nodes.map((node) => node.textContent));

    it('shows the conditions of the Active Pokémon, each in its own color, and Trapped says what it means', async () => {
      assert.deepEqual(await chips(), []);
      assert.equal(await page.locator('.trainer-a .active .statuses').isVisible(), false, 'nothing to show, nothing shown');

      await send('action:trainerA', { action: 'toggleStatus', condition: 'trapped', enabled: true });
      await send('action:trainerA', { action: 'toggleStatus', condition: 'poisoned', enabled: true });
      await send('action:trainerA', { action: 'toggleStatus', condition: 'asleep', enabled: true });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .active .status-chip').length === 3);
      assert.deepEqual(await chips(), ['Asleep', 'Poisoned', 'Trapped']);
      assert.deepEqual(await chips('b'), []);

      const looks = await page.$$eval('.trainer-a .active .status-chip', (nodes) => nodes.map((node) => ({ key: node.dataset.status, color: getComputedStyle(node).backgroundColor, title: node.title })));
      assert.equal(new Set(looks.map((look) => look.color)).size, 3, 'each condition has a color of its own');
      assert.equal(looks.find((look) => look.key === 'trapped').title, 'Can\'t retreat');

      // a second Asleep-like condition takes the place of the first
      await send('action:trainerA', { action: 'toggleStatus', condition: 'paralyzed', enabled: true });
      await page.waitForFunction(() => document.querySelector('.trainer-a .active .status-chip[data-status="paralyzed"]'));
      assert.deepEqual(await chips(), ['Paralyzed', 'Poisoned', 'Trapped']);

      await send('action:trainerA', { action: 'clearStatus' });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .active .status-chip').length === 0);
      assert.deepEqual(page.problems, []);
    });

    it('can be switched off with the other Pokémon details', async () => {
      await send('action:trainerA', { action: 'toggleStatus', condition: 'burned', enabled: true });
      await page.waitForSelector('.trainer-a .active .status-chip');
      assert.equal(await page.locator('.trainer-a .active .statuses').isVisible(), true);
      await send('action:settings', { action: 'update', display: { statusConditions: false } });
      await page.waitForFunction(() => document.querySelector('.trainer-a .active .statuses').offsetParent === null);
      await send('action:settings', { action: 'update', display: { statusConditions: true } });
    });
  });

  describe('announcements', () => {
    it('shows a banner for two seconds unless told otherwise, then takes it away', async () => {
      assert.equal((await live()).settings.toastSeconds, 2);
      const asked = Date.now();
      await send('action:toast', { action: 'attack', attackName: 'Thunderbolt', damage: 120 });
      await page.waitForSelector('.toast');
      assert.match(await page.locator('.toast').first().textContent(), /Thunderbolt|ATTACK/i);
      await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 6000 });
      const shown = Date.now() - asked;
      assert.ok(shown >= 1700 && shown <= 3600, `the banner was there for ${shown} ms`);
    });

    it('keeps it up for as long as the producer chooses', async () => {
      await send('action:settings', { action: 'update', toastSeconds: 4 });
      const asked = Date.now();
      await send('action:toast', { action: 'topDeck', target: 'trainerB' });
      await page.waitForSelector('.toast');
      await wait(2600);
      assert.equal(await page.locator('.toast').count() > 0, true, 'still there after the old two seconds');
      await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 6000 });
      assert.ok(Date.now() - asked >= 3700);
    });

    it('shows nothing when banners are switched off', async () => {
      await send('action:settings', { action: 'update', display: { toasts: false } });
      await send('action:toast', { action: 'passTurn' });
      await wait(700);
      assert.equal(await page.locator('.toast').count(), 0);
    });
  });

  describe('sound', () => {
    const cues = () => page.evaluate(() => window.oto.sfx.log.map((entry) => entry.cue));

    it('plays the supporter sound when a supporter is used, and not when it is given back', async () => {
      await send('action:settings', { action: 'update', sound: { enabled: true } });
      await page.waitForFunction(() => window.oto.state && window.oto.state.settings.sound.enabled);

      await send('action:trainerA', { action: 'supporterPlus' });
      await page.waitForFunction(() => window.oto.sfx.log.some((entry) => entry.cue === 'supporter'));
      assert.deepEqual((await cues()).filter((cue) => cue === 'supporter'), ['supporter']);

      await send('action:trainerA', { action: 'supporterMinus' });
      await wait(400);
      assert.deepEqual((await cues()).filter((cue) => cue === 'supporter'), ['supporter'], 'giving it back is silent');

      await send('action:settings', { action: 'update', sound: { events: { supporter: { enabled: false } } } });
      await page.waitForFunction(() => window.oto.state.settings.sound.events.supporter.enabled === false);
      await send('action:trainerA', { action: 'supporterPlus' });
      await wait(400);
      assert.equal((await cues()).filter((cue) => cue === 'supporter').length, 1, 'switched off for that moment');
    });
  });

  describe('a design', () => {
    const api = async (method, route, body) => {
      const response = await fetch(`${server.base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return response.json().catch(() => null);
    };
    const wear = async (design) => {
      await api('PUT', `/api/themes/${encodeURIComponent(design.name)}`, design);
      await api('POST', '/api/theme/active', { name: design.name });
      // the overlay is told, and fetches the design again
      await page.waitForFunction((name) => fetch('/api/theme', { cache: 'no-store' }).then((r) => r.json()).then((d) => d.name === name), design.name);
      await page.evaluate(() => window.oto.loadTheme());
    };
    afterEach(async () => {
      await api('POST', '/api/theme/active', { name: null });
      for (const name of (await api('GET', '/api/themes')).names) await api('DELETE', `/api/themes/${encodeURIComponent(name)}`);
    });

    const transformOf = (selector) => page.$eval(selector, (node) => getComputedStyle(node).transform);

    it('moves and resizes the pieces of the overlay it names, and only those', async () => {
      assert.equal(await transformOf('.scoreboard'), 'none', 'nothing moves without a design');
      await wear({ name: 'Moved', layout: { scoreboard: { x: 0, y: 40, scale: 1.1 }, 'trainerA.prizes': { x: -30, y: 10, scale: 1 }, toasts: { x: 0, y: -100, scale: 1 } } });
      await page.waitForSelector('.scoreboard.moved');
      assert.equal(await transformOf('.scoreboard'), 'matrix(1.1, 0, 0, 1.1, 0, 40)');
      assert.equal(await transformOf('.trainer-a .prizes'), 'matrix(1, 0, 0, 1, -30, 10)');
      assert.equal(await transformOf('.trainer-b .prizes'), 'none', 'the other trainer stays where it was');
      assert.equal(await transformOf('.trainer-a'), 'none', 'and so does the trainer around it');
      assert.equal(await page.$$eval('.toast-slot.moved', (nodes) => nodes.length), 3, 'a piece with several nodes moves them all');

      // the scoreboard really sits 40 pixels lower than before
      const top = await page.$eval('.scoreboard', (node) => node.getBoundingClientRect().top);
      await api('POST', '/api/theme/active', { name: null });
      await page.evaluate(() => window.oto.loadTheme());
      await page.waitForFunction(() => !document.querySelector('.scoreboard.moved'));
      const before = await page.$eval('.scoreboard', (node) => node.getBoundingClientRect().top);
      assert.ok(top - before > 30 && top - before < 60, `moved ${top - before} px`);
      assert.equal(await page.$$eval('.moved', (nodes) => nodes.length), 0, 'every piece is back');
      assert.equal(await page.$eval('.scoreboard', (node) => node.style.getPropertyValue('--lx')), '', 'and nothing is left behind');
    });

    it('lets what is inside a moved piece be moved too', async () => {
      await wear({ name: 'Nested', layout: { trainerA: { x: 10, y: 0, scale: 1 }, 'trainerA.bench': { x: 0, y: 25, scale: 1 } } });
      await page.waitForSelector('.trainer-a.moved');
      const bench = await page.$eval('.trainer-a .bench', (node) => ({ transform: getComputedStyle(node).transform, left: node.getBoundingClientRect().left }));
      assert.equal(bench.transform, 'matrix(1, 0, 0, 1, 0, 25)');
      const plain = await page.$eval('.trainer-a .active', (node) => node.getBoundingClientRect().left);
      assert.ok(Math.abs(bench.left - plain) < 2, 'the bench is inside the trainer, so it moved sideways with it');
    });

    describe('with a crop', () => {
      const ART = { x: 0.07, y: 0.115, w: 0.86, h: 0.385 };
      const mon = (side, where) => page.$eval(`.trainer-${side} ${where} .art`, (art) => {
        const rect = art.getBoundingClientRect();
        const img = art.querySelector('img').getBoundingClientRect();
        return { w: rect.width, h: rect.height, imgW: img.width, imgH: img.height, left: img.left - rect.left, top: img.top - rect.top };
      });
      const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual} is not ${expected}`);

      beforeEach(async () => {
        await send('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-2', name: 'Eevee', image: IMG, hp: 60 });
        await page.waitForSelector('.trainer-a .bench .mon:not([hidden])');
      });

      it('shows the whole card until the design says otherwise', async () => {
        const full = await mon('a', '.active');
        near(full.w, 300, 'width');
        near(full.h, 418, 'height');
        near(full.imgW, 300, 'picture width');
        near(full.imgH, 418, 'picture height');
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('has-crop-active')), false);
      });

      it('shows only the art of the Active Pokémon and takes the shape of it', async () => {
        await wear({ name: 'Art', crop: { active: ART } });
        await page.waitForSelector('html.has-crop-active');
        const active = await mon('a', '.active');
        near(active.w, 300, 'the width stays');
        near(active.h, 300 * 1.3933 * ART.h / ART.w, 'the height follows the part that is shown');
        near(active.imgW, 300 / ART.w, 'the picture is larger than the box, so only a part shows');
        near(active.imgH, active.h / ART.h, 'picture height');
        near(active.left, -300 * ART.x / ART.w, 'moved left to start at the art');
        near(active.top, -active.h * ART.y / ART.h, 'moved up to start at the art');
        const bench = await mon('a', '.bench');
        near(bench.w, 104, 'the bench is not cropped by an Active crop');
        near(bench.h, 145, 'bench height');
      });

      it('crops the bench on its own', async () => {
        await wear({ name: 'Bench', crop: { bench: { x: 0.2, y: 0.2, w: 0.6, h: 0.5 } } });
        await page.waitForSelector('html.has-crop-bench');
        const bench = await mon('a', '.bench');
        near(bench.w, 104, 'width');
        near(bench.h, 104 * 1.3933 * 0.5 / 0.6, 'height');
        near(bench.imgW, 104 / 0.6, 'picture width');
        near(bench.left, -104 * 0.2 / 0.6, 'left');
        const active = await mon('a', '.active');
        near(active.h, 418, 'the Active Pokémon keeps its whole card');
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('has-crop-active')), false);
      });

      it('shows exactly the chosen part of the card picture', async () => {
        // a card whose art window is green and everything else blue, so the crop can be checked by color
        const card = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="418"><rect width="300" height="418" fill="#2030d0"/><rect x="21" y="48.07" width="258" height="160.93" fill="#20d040"/></svg>';
        await page.route('**/art/flat.svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: card }));
        await send('action:trainerA', { action: 'setActive', cardId: 'a-9', name: 'Flat', image: '/art/flat.svg', hp: 60 });
        await wear({ name: 'Flat Art', crop: { active: ART } });
        await page.waitForSelector('html.has-crop-active');
        await page.waitForFunction(() => { const img = document.querySelector('.trainer-a .active .art-img'); return img && img.complete && img.naturalWidth > 0 && img.getAttribute('src').includes('flat'); });
        const colors = await page.evaluate(() => {
          const art = document.querySelector('.trainer-a .active .art');
          const img = art.querySelector('img');
          const rect = art.getBoundingClientRect();
          const canvas = document.createElement('canvas');
          canvas.width = 300; canvas.height = 418;
          const context = canvas.getContext('2d');
          context.drawImage(img, 0, 0, 300, 418);
          // where each corner and the middle of the visible box falls on the picture itself
          const imgRect = img.getBoundingClientRect();
          const sample = (fx, fy) => {
            const px = ((rect.left + rect.width * fx - imgRect.left) / imgRect.width) * 300;
            const py = ((rect.top + rect.height * fy - imgRect.top) / imgRect.height) * 418;
            return Array.from(context.getImageData(Math.floor(px), Math.floor(py), 1, 1).data).slice(0, 3).join(',');
          };
          return [sample(0.03, 0.03), sample(0.97, 0.03), sample(0.03, 0.97), sample(0.97, 0.97), sample(0.5, 0.5)];
        });
        assert.deepEqual([...new Set(colors)], ['32,208,64'], 'only the green art window is in the box: ' + colors.join(' | '));
      });
    });
  });

  describe('inside the design editor', () => {
    let editor;
    beforeEach(async () => {
      editor = await openPage(browser, `${server.base}/overlay?editor=1`);
      await editor.waitForFunction(() => window.oto);
    });
    afterEach(async () => { await editor.context().close(); });
    const tell = (message) => editor.evaluate((m) => window.postMessage(m, window.location.origin), message);
    const noGame = async () => { await wait(300); };

    it('talks to no server: it draws what it is sent', async () => {
      assert.equal(await editor.evaluate(() => window.oto.editor), true);
      assert.equal(await editor.evaluate(() => Boolean(window.oto.socket)), false, 'no connection to the match');
      assert.equal(await editor.locator('.sb-name').first().textContent(), '', 'nothing is shown until it is sent');
      const sample = await live();
      sample.trainerA.name = 'Sample Ash';
      await tell({ kind: 'state', state: sample });
      await editor.waitForFunction(() => document.querySelector('.sb-name').textContent === 'Sample Ash');
      await tell({ kind: 'design', theme: { name: 'Draft', colors: { '--accent': '#ff0000' }, images: {}, layout: { scoreboard: { x: 0, y: 50, scale: 1 } } } });
      await editor.waitForSelector('.scoreboard.moved');
      assert.equal(await editor.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#ff0000');
      await tell({ kind: 'design', theme: null });
      await editor.waitForFunction(() => !document.querySelector('.scoreboard.moved'));
      await noGame();
    });

    it('ignores messages that do not come from the page around it', async () => {
      await editor.evaluate(() => {
        const frame = document.createElement('iframe');
        document.body.appendChild(frame);
        frame.contentWindow.postMessage({ kind: 'design', theme: { name: 'x', layout: { scoreboard: { x: 0, y: 99, scale: 1 } } } }, '*');
      });
      await wait(300);
      assert.equal(await editor.$$eval('.moved', (nodes) => nodes.length), 0);
    });

    it('measures where each piece is, in stage pixels, with the stage at its real size', async () => {
      const sample = await live();
      sample.trainerA.locks.itemLock = true;
      await tell({ kind: 'state', state: sample });
      await editor.waitForFunction(() => window.oto.state);
      const rects = await editor.evaluate(() => window.oto.blockRects());
      assert.deepEqual(Object.keys(rects).sort(), [...require_blocks()].sort());
      assert.ok(rects.scoreboard.w > 1000 && rects.scoreboard.h > 80 && rects.scoreboard.y < 60, 'the scoreboard is a wide strip at the top');
      assert.ok(rects['trainerA.locks'].w > 0, 'a lock that is on is a piece');
      assert.equal(rects['trainerB.locks'], null, 'and one that is off is not');
      assert.equal(rects.logo, null, 'a logo that is not there is not');
      assert.ok(rects.trainerA.x < rects.trainerB.x && rects.trainerA.w > 300, 'the trainers are on their own sides');
      assert.ok(rects.trainerA.x >= 0 && rects.trainerB.x + rects.trainerB.w <= 1920);

      await tell({ kind: 'design', theme: { name: 'Moved', layout: { scoreboard: { x: 0, y: 200, scale: 0.5 } } } });
      await editor.waitForSelector('.scoreboard.moved');
      const moved = await editor.evaluate(() => window.oto.blockRects().scoreboard);
      assert.ok(Math.abs(moved.w - rects.scoreboard.w / 2) < 3, 'measured as it looks, so it is half as wide');
      assert.ok(moved.y > rects.scoreboard.y + 150, 'and lower');
    });

    it('can show a banner that stays, and take it away', async () => {
      await tell({ kind: 'banner', show: true });
      await editor.waitForSelector('.toast');
      await wait(2600);
      assert.equal(await editor.locator('.toast').count(), 1, 'it does not go away by itself');
      await tell({ kind: 'banner', show: false });
      await editor.waitForFunction(() => !document.querySelector('.toast'));
    });
  });
});
