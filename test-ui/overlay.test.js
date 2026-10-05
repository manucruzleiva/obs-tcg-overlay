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

    it('lets a design replace the icons with its own strip', async () => {
      await page.evaluate(() => {
        document.getElementById('stage').classList.add('has-energy-sprite');
        document.documentElement.style.setProperty('--energySymbols', 'url("/logo.gif")');
      });
      const image = await page.$eval('.trainer-a .active .energy-fire', (node) => getComputedStyle(node).backgroundImage);
      assert.match(image, /logo\.gif/, 'the design wins over the built-in icon');
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
});
