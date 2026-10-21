/**
 * The overlay in a real browser: what viewers see, as the producers change the game.
 * Run with: npm run test:ui
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wait } = require('../support/harness');
const { findBrowser, launch, openPage } = require('./browser');

const skip = findBrowser() ? false : 'no Chrome or Edge found (set BROWSER_PATH to use another)';
const IMG = '/art/test.svg';
const require_blocks = () => require('../../public/js/theme-options').BLOCK_KEYS;

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

  // Every moment a page plays (see "moments"), written down as it starts with what it says: a test that looks for one later, when the
  // machine is busy, may find it over already
  const recordMoments = (target) => target.evaluate(() => {
    window.played = [];
    new MutationObserver((changes) => {
      const now = []; // (a moment that starts again is taken off and put back at once: it is written down once)
      changes.forEach((change) => {
        const node = change.target;
        const before = (change.oldValue || '').split(/\s+/);
        Array.prototype.forEach.call(node.classList, (name) => {
          if (name.indexOf('moment-') !== 0 || before.indexOf(name) !== -1 || now.some((entry) => entry.node === node && entry.name === name)) return;
          // (the number of a moment is in data-<kind> and --moment-<kind>: data-damage for moment-damage...)
          const kind = name.slice('moment-'.length);
          const numbered = ['damage', 'heal', 'energy'].indexOf(kind) !== -1;
          now.push({
            node, name, amount: numbered ? node.getAttribute(`data-${kind}`) : null, variable: numbered ? node.style.getPropertyValue(`--moment-${kind}`) : '', status: node.getAttribute('data-status'),
            // and how the piece looks then
            hidden: node.hidden, opacity: getComputedStyle(node).opacity, text: node.querySelector('.mon-name') ? node.querySelector('.mon-name').textContent : null
          });
        });
      });
      window.played.push(...now);
    }).observe(document.getElementById('stage'), { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['class'] });
  });
  // waits until the moment `name` has played on a piece that `selector` finds (with that amount or status, when they are given)
  const playedOn = (target, selector, name, extra = {}) => target.waitForFunction(([where, wanted, more]) => window.played.some((entry) => entry.name === wanted
    && entry.node.matches(where) && (more.amount === undefined || entry.amount === String(more.amount)) && (more.status === undefined || entry.status === more.status)),
  [selector, name, extra], { timeout: 5000 });
  // the moments that have played on the pieces `selector` finds, by name
  const playedThere = (target, selector) => target.evaluate((where) => window.played.filter((entry) => entry.node.matches(where)).map((entry) => entry.name).sort(), selector);

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

  // The penalty of a trainer (set on their own panel) is that many prize cards the OTHER trainer counts as taken: those are marked red on
  // the other trainer's side, and that trainer needs that many fewer to win.
  describe('a penalty', () => {
    const reds = (side = 'b') => page.$$eval(`.trainer-${side} .prize`, (nodes) => nodes.map((node) => node.classList.contains('penalty')));
    const flag = (side = 'b') => page.locator(`.trainer-${side} .prize-flag`).textContent();

    it('marks that many prize cards of the other trainer in red', async () => {
      assert.deepEqual(await reds(), [false, false, false, false, false, false]);
      assert.equal(await flag(), '');

      await send('action:trainerA', { action: 'prizePenaltySet', count: 2 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-b .prize.penalty').length === 2);
      assert.deepEqual(await reds(), [true, true, false, false, false, false]);
      assert.equal(await flag(), 'PENALTY');
      assert.deepEqual(await reds('a'), [false, false, false, false, false, false], 'the trainer who has the penalty is not marked');
      assert.equal(await flag('a'), '');

      await send('action:trainerA', { action: 'prizePenaltyPlus' });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-b .prize.penalty').length === 3);
      await send('action:trainerA', { action: 'prizePenaltySet', count: 0 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-b .prize.penalty').length === 0);
      assert.equal(await flag(), '');
    });

    it('works both ways: the penalty of the second trainer marks the cards of the first', async () => {
      await send('action:trainerB', { action: 'prizePenaltySet', count: 1 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.penalty').length === 1);
      assert.deepEqual(await reds('a'), [true, false, false, false, false, false]);
      assert.deepEqual(await reds('b'), [false, false, false, false, false, false]);
    });

    it('looks red', async () => {
      await send('action:trainerA', { action: 'prizePenaltySet', count: 1 });
      await page.waitForSelector('.trainer-b .prize.penalty');
      const looks = await page.evaluate(() => {
        const danger = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
        const probe = document.createElement('i');
        probe.style.color = danger;
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        const card = document.querySelector('.trainer-b .prize.penalty');
        const plain = document.querySelector('.trainer-b .prize:not(.penalty)');
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
      await send('action:trainerB', { action: 'prizeSet', count: 2 }); // two left is already enough to win with that penalty
      await page.waitForFunction(() => document.querySelectorAll('.trainer-b .prize.taken').length === 4);
      assert.deepEqual(await reds(), [true, true, false, false, false, false], 'two are left, so two can be red');
      assert.equal((await live()).trainerA.prizes.penalty, 4, 'the penalty itself is kept');

      await send('action:trainerB', { action: 'prizeSet', count: 6 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-b .prize.penalty').length === 4);
    });

    it('pulses unless the penalty animation is switched off', async () => {
      await send('action:trainerA', { action: 'prizePenaltySet', count: 1 });
      await page.waitForSelector('.trainer-b .prizes.pulse');
      await send('action:settings', { action: 'update', showPenaltyAnimation: false });
      await page.waitForFunction(() => !document.querySelector('.trainer-b .prizes.pulse'));
      assert.equal(await page.locator('.trainer-b .prize.penalty').count(), 1, 'still marked, only still');
    });
  });

  // The bench is stacked down the edge of the screen, with the name and the abilities of each Pokémon on the side toward the middle
  describe('the bench', () => {
    const looks = (side) => page.$$eval(`.trainer-${side} .bench .mon.mini:not([hidden])`, (nodes) => nodes.map((node) => {
      const rect = (selector) => { const found = node.querySelector(selector); const box = found.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; };
      const box = node.getBoundingClientRect();
      return { box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, art: rect('.art'), details: rect('.details'), name: rect('.mon-name'), abilities: node.querySelector('.abilities').hidden ? null : rect('.abilities') };
    }));
    const names = ['Eevee', 'Pichu', 'Raichu', 'Mew', 'Snorlax', 'Gengar', 'Absol', 'Alakazam'];
    const fill = async (side, count, size = 8) => {
      for (let i = 0; i < size - 5; i++) await send(`action:${side}`, { action: 'benchSizePlus' });
      for (let slot = 0; slot < count; slot++) {
        await send(`action:${side}`, { action: 'setBench', slot, cardId: `${side}-${slot}`, name: names[slot], image: IMG, hp: 60, abilities: ['Static', 'Cursed Eye'], retreat: 1 });
      }
      await page.waitForFunction(([which, wanted]) => document.querySelectorAll(`.trainer-${which} .bench .mon.mini:not([hidden])`).length === wanted, [side === 'trainerA' ? 'a' : 'b', count]);
    };

    it('is stacked down the edge of the screen, one Pokémon under the other, for each trainer', async () => {
      await fill('trainerA', 3, 5);
      await fill('trainerB', 3, 5);
      const a = await looks('a');
      const b = await looks('b');
      assert.deepEqual([...new Set(a.map((mon) => Math.round(mon.box.left)))], [36], 'at the left edge, all in one column');
      assert.deepEqual([...new Set(b.map((mon) => Math.round(mon.box.right)))], [1884], 'at the right edge for the other trainer');
      for (const column of [a, b]) {
        assert.ok(column.every((mon, index) => index === 0 || mon.box.top >= column[index - 1].box.bottom), 'each one under the one before');
        assert.ok(column.every((mon) => mon.box.bottom <= 1080 - 36 + 1), 'inside the screen');
      }
      const active = await page.$eval('.trainer-a .active', (node) => node.getBoundingClientRect().bottom);
      assert.ok(a[0].box.top >= active, 'the first one is under the Active Pokémon');
    });

    it('shows the name and the abilities of each on the side toward the middle of the screen', async () => {
      await fill('trainerA', 2, 5);
      await fill('trainerB', 2, 5);
      for (const mon of await looks('a')) {
        assert.ok(mon.details.left >= mon.art.right, 'the details are to the right of the picture, toward the middle');
        assert.ok(mon.abilities && mon.abilities.left >= mon.art.right && mon.name.left >= mon.art.right, 'with the name and the abilities in them');
      }
      for (const mon of await looks('b')) {
        assert.ok(mon.details.right <= mon.art.left, 'the other trainer\'s are to the left of the picture, toward the middle');
        assert.ok(mon.abilities && mon.abilities.right <= mon.art.left && mon.name.right <= mon.art.left);
      }
      assert.equal(await page.$eval('.trainer-b .bench .mon.mini .mon-name', (node) => getComputedStyle(node).textAlign), 'right');
      assert.match(await page.$eval('.trainer-a .bench .mon.mini .mon-name', (node) => getComputedStyle(node).textAlign), /^(left|start)$/);
    });

    it('starts a second column, toward the middle, when there are more than fit under the Active Pokémon', async () => {
      // (with an Active Pokémon each, as in a game: the bench starts under it)
      await send('action:trainerB', { action: 'setActive', cardId: 'b-act', name: 'Charizard', image: IMG, hp: 150 });
      await fill('trainerA', 8);
      await fill('trainerB', 8);
      for (const [side, column] of [['a', await looks('a')], ['b', await looks('b')]]) {
        const lefts = [...new Set(column.map((mon) => Math.round(mon.box.left)))].sort((x, y) => x - y);
        assert.equal(lefts.length, 2, `${side}: two columns`);
        assert.ok(column.every((mon) => mon.box.bottom <= 1080 - 36 + 1), `${side}: nothing goes below the screen`);
        const first = column.filter((mon) => Math.round(mon.box.left) === lefts[side === 'a' ? 0 : 1]);
        assert.ok(first.length >= 5, `${side}: the column at the edge holds the most: ${first.length}`);
      }
    });

    it('does not show the retreat cost, which is for the Active Pokémon', async () => {
      await fill('trainerA', 2, 5);
      assert.equal(await page.locator('.trainer-a .bench .mon.mini .retreat:visible').count(), 0);
      assert.equal(await page.locator('.trainer-a .bench .mon.mini .retreat .energy').count(), 0);
      await send('action:trainerA', { action: 'setRetreat', slot: -1, cost: 2 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .active .retreat .energy').length === 2);
      assert.equal(await page.locator('.trainer-a .active .retreat:visible').count(), 1);
    });

    it('can show the attacks of each benched Pokémon, the name and the damage, when the option is on (it is off at first)', async () => {
      await send('action:trainerA', { action: 'benchSizePlus' });
      await send('action:trainerA', { action: 'benchSizeReset' });
      await send('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-0', name: 'Eevee', image: IMG, hp: 60, attacks: [{ name: 'Rear Kick', damage: '30' }, { name: 'Tail Whip', damage: '10+' }, { name: 'Splash', damage: '' }] });
      await send('action:trainerA', { action: 'setBench', slot: 1, cardId: 'a-1', name: 'Pichu', image: IMG, hp: 40 });
      await send('action:trainerB', { action: 'setBench', slot: 0, cardId: 'b-0', name: 'Charmander', image: IMG, hp: 70, attacks: [{ name: 'Ember', damage: '30' }] });
      await page.waitForFunction(() => document.querySelectorAll('.bench .mon.mini:not([hidden])').length === 3);
      const lines = (side) => page.$$eval(`.trainer-${side} .bench .mon.mini:not([hidden])`, (nodes) => nodes.map((node) => [...node.querySelectorAll('.attack-line')].map((line) => line.textContent)));
      const shown = () => page.locator('.bench .attacks:visible').count();

      assert.equal(await shown(), 0, 'nothing is shown at first');
      assert.equal((await live()).settings.display.benchAttacks, false);
      await send('action:settings', { action: 'update', display: { benchAttacks: true } });
      await page.waitForFunction(() => [...document.querySelectorAll('.bench .attacks')].some((node) => node.offsetParent !== null));
      assert.deepEqual(await lines('a'), [['Rear Kick30', 'Tail Whip10+', 'Splash'], []], 'name and damage, as the card says; a Pokémon with none shows none');
      assert.deepEqual(await lines('b'), [['Ember30']]);
      assert.equal(await shown(), 2, 'only for the Pokémon that have attacks');

      // they are in the details of the Pokémon, toward the middle of the screen, under the name
      const places = await page.$eval('.trainer-a .bench .mon.mini .attacks', (node) => {
        const mon = node.closest('.mon');
        const art = mon.querySelector('.art').getBoundingClientRect();
        const name = mon.querySelector('.mon-name').getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return { right: box.left >= art.right, under: box.top >= name.bottom, inside: box.bottom <= mon.getBoundingClientRect().bottom + 1 };
      });
      assert.deepEqual(places, { right: true, under: true, inside: true });
      assert.equal(await page.locator('.trainer-a .active .attacks:visible').count(), 0, 'the Active Pokémon is as it always was');

      await send('action:settings', { action: 'update', display: { benchAttacks: false } });
      await page.waitForFunction(() => ![...document.querySelectorAll('.bench .attacks')].some((node) => node.offsetParent !== null));
      assert.deepEqual(page.problems, []);
    });

    it('can be a row under the Active Pokémon again, with the name and abilities under each picture', async () => {
      await fill('trainerA', 3, 5);
      assert.equal(await page.$eval('#stage', (node) => node.classList.contains('bench-row')), false);
      await send('action:settings', { action: 'update', display: { benchRow: true } });
      await page.waitForFunction(() => document.querySelector('#stage.bench-row'));
      const row = await looks('a');
      assert.deepEqual([...new Set(row.map((mon) => Math.round(mon.box.top)))].length, 1, 'side by side');
      assert.ok(row.every((mon, index) => index === 0 || mon.box.left >= row[index - 1].box.right), 'one next to the other');
      assert.ok(row.every((mon) => Math.abs(mon.box.right - mon.box.left - 104) < 1), 'each 104 pixels wide');
      assert.ok(row.every((mon) => mon.details.top >= mon.art.bottom), 'with the name and the abilities under the picture');
      assert.equal(await page.$eval('.trainer-a .bench .mon.mini .mon-name', (node) => getComputedStyle(node).textAlign), 'center');

      await send('action:settings', { action: 'update', display: { benchRow: false } });
      await page.waitForFunction(() => !document.querySelector('#stage.bench-row'));
      assert.deepEqual([...new Set((await looks('a')).map((mon) => Math.round(mon.box.left)))], [36]);
    });

    it('says how many places it has and how many hold a Pokémon, and each Pokémon its place, so a design can lay out a bigger bench', async () => {
      const hooks = (side) => page.$eval(`.trainer-${side} .bench`, (node) => ({
        size: node.dataset.size, count: node.dataset.count, slots: [...node.querySelectorAll('.mon.mini')].map((mon) => mon.dataset.slot).join(' ')
      }));
      const counted = (side, size, count) => page.waitForFunction(([which, wanted]) => {
        const bench = document.querySelector(`.trainer-${which} .bench`);
        return `${bench.dataset.size}/${bench.dataset.count}` === wanted;
      }, [side, `${size}/${count}`]);
      assert.deepEqual(await hooks('a'), { size: '5', count: '0', slots: '0 1 2 3 4 5 6 7' }, 'the places are counted as the game counts them, from 0');
      await fill('trainerA', 6, 8);
      await counted('a', 8, 6);
      assert.equal(await page.$eval('.trainer-a .bench .mon.mini[data-slot="5"] .mon-name', (node) => node.textContent), 'Gengar', 'the sixth place is 5');
      assert.deepEqual(await hooks('b'), { size: '5', count: '0', slots: '0 1 2 3 4 5 6 7' }, 'each trainer has its own');

      // a Pokémon that leaves the bench, and a bench that is made smaller (the Pokémon of the places that go are gone with them)
      await send('action:trainerA', { action: 'clearSlot', slot: 1 });
      await counted('a', 8, 5);
      await send('action:trainerA', { action: 'benchSizeReset' });
      await counted('a', 5, 4);
      assert.deepEqual(page.problems, []);
    });
  });

  describe('the locks', () => {
    const locks = (side) => page.$$eval(`.trainer-${side} .lock`, (nodes) => nodes.map((node) => `${node.dataset.lock}:${node.textContent}`));

    it('say which lock each is, whatever its text, so a design can draw each its own way', async () => {
      assert.equal(await page.locator('.trainer-a .locks').isHidden(), true);
      await send('action:trainerA', { action: 'toggleItemLock' });
      await send('action:trainerA', { action: 'toggleEvoLock' });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .lock').length === 2);
      assert.deepEqual(await locks('a'), ['item:ITEM LOCK', 'evolution:EVOLUTION LOCK']);
      assert.deepEqual(await locks('b'), []);
      await send('action:trainerA', { action: 'toggleItemLock' });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .lock').length === 1);
      assert.deepEqual(await locks('a'), ['evolution:EVOLUTION LOCK']);
    });
  });

  describe('what is used each turn', () => {
    const state = () => page.$$eval('.trainer-a .token, .trainer-b .token', (nodes) => nodes.map((node) => `${node.closest('.trainer').classList.contains('trainer-a') ? 'a' : 'b'}:${node.querySelector('.token-label').textContent}:${getComputedStyle(node).visibility}`));
    const room = (side) => page.$eval(`.trainer-${side} .tokens`, (node) => { const box = node.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; });

    it('shows the energy, Stadium and Supporter trackers only for the player whose turn it is', async () => {
      await send('action:trainerA', { action: 'setTurn', isTurn: true });
      await page.waitForFunction(() => document.querySelector('.trainer-a.is-turn'));
      const mine = await state();
      for (const label of ['ENERGY', 'STADIUM', 'SUPPORTER']) {
        assert.ok(mine.includes(`a:${label}:visible`), `${label} for the one with the turn`);
        assert.ok(mine.includes(`b:${label}:hidden`), `${label} hidden for the other`);
      }

      await send('action:trainerB', { action: 'setTurn', isTurn: true });
      await page.waitForFunction(() => document.querySelector('.trainer-b.is-turn'));
      const theirs = await state();
      for (const label of ['ENERGY', 'STADIUM', 'SUPPORTER']) {
        assert.ok(theirs.includes(`b:${label}:visible`) && theirs.includes(`a:${label}:hidden`), `${label} follows the turn`);
      }
    });

    it('keeps the GX and VSTAR markers, which are for the game, and nothing moves when the turn passes', async () => {
      await send('action:settings', { action: 'update', display: { gxMarker: true, vstarMarker: true } });
      await send('action:trainerA', { action: 'setTurn', isTurn: true });
      await page.waitForFunction(() => document.querySelector('.trainer-a.is-turn'));
      const before = [await room('a'), await room('b')];
      const marks = await state();
      for (const side of ['a', 'b']) assert.ok(marks.includes(`${side}:GX:visible`) && marks.includes(`${side}:VSTAR:visible`), `${side} keeps its markers`);
      await send('action:trainerB', { action: 'setTurn', isTurn: true });
      await page.waitForFunction(() => document.querySelector('.trainer-b.is-turn'));
      assert.deepEqual([await room('a'), await room('b')], before, 'the trackers keep their room: the rows are as big as they were');
      await send('action:settings', { action: 'update', display: { gxMarker: false, vstarMarker: false } });
    });

    it('shows none for either player before anybody has the turn', async () => {
      const none = await state();
      assert.ok(none.filter((entry) => /:(ENERGY|STADIUM|SUPPORTER):/.test(entry)).every((entry) => entry.endsWith(':hidden')));
    });
  });

  // The deck of a trainer next to the name on the scoreboard, with the picture of what it names
  describe('the deck', () => {
    // a picture of a Pokémon, so no test needs the internet
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8Dwn4EBDAAZ6gH/8gKh1gAAAABJRU5ErkJggg==', 'base64');
    const pill = (side = 'a') => page.locator(`.sb-${side} .sb-deck`);
    const read = (side = 'a') => page.$eval(`.sb-${side} .sb-deck`, (node) => {
      const icon = node.querySelector('.sb-deck-icon');
      return {
        shown: !node.hidden && getComputedStyle(node).display !== 'none',
        text: node.querySelector('.sb-deck-text').textContent,
        icon: icon.hidden || getComputedStyle(icon).display === 'none' ? null : icon.getAttribute('src'),
        kind: icon.dataset.kind || null,
        title: icon.title
      };
    });

    beforeEach(async () => {
      await page.route('**/img/sprite/*.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    });

    it('shows nothing until a trainer has a deck', async () => {
      assert.equal((await read('a')).shown, false);
      assert.equal((await read('b')).shown, false);
    });

    it('shows the deck next to the nationality and the record, with the Pokémon it names in front of it', async () => {
      await send('action:trainerA', { action: 'setDeck', deck: 'Charizard ex' });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck-text').textContent === 'Charizard ex');
      assert.deepEqual(await read('a'), { shown: true, text: 'Charizard ex', icon: '/img/sprite/6.png', kind: 'pokemon', title: 'Charizard' });
      assert.deepEqual(await page.$$eval('.sb-a .sb-meta > *', (nodes) => nodes.map((node) => node.className.split(' ')[0])), ['sb-nat', 'sb-record', 'sb-deck']);
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck-icon').complete);
      assert.equal(await page.$eval('.sb-a .sb-deck-icon', (img) => img.naturalWidth > 0), true, 'the picture loaded');
      assert.equal((await read('b')).shown, false, 'the other trainer has none');
      assert.deepEqual(page.problems, []);
    });

    it('shows the icon of the energy type a deck names, from the assets folder', async () => {
      await send('action:trainerB', { action: 'setDeck', deck: 'Lightning GLC' });
      await page.waitForFunction(() => document.querySelector('.sb-b .sb-deck-text').textContent === 'Lightning GLC');
      assert.deepEqual(await read('b'), { shown: true, text: 'Lightning GLC', icon: '/assets/energy/lightning.png', kind: 'energy', title: 'Lightning energy' });
    });

    it('shows the text alone when the deck names nothing, what the picture box names, or no picture when it says none', async () => {
      await send('action:trainerA', { action: 'setDeck', deck: 'Lost Zone Box' });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck-text').textContent === 'Lost Zone Box');
      assert.deepEqual(await read('a'), { shown: true, text: 'Lost Zone Box', icon: null, kind: null, title: '' });

      await send('action:trainerA', { action: 'setDeckIcon', icon: 'Comfey' });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck-icon').getAttribute('src') === '/img/sprite/764.png');
      assert.equal((await read('a')).title, 'Comfey');

      await send('action:trainerA', { action: 'setDeckIcon', icon: 'none' });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck-icon').hidden);
      assert.deepEqual(await read('a'), { shown: true, text: 'Lost Zone Box', icon: null, kind: 'pokemon', title: '' });
      assert.equal(await pill('a').evaluate((node) => node.classList.contains('has-icon')), false);

      await send('action:trainerA', { action: 'setDeck', deck: '' });
      await send('action:trainerA', { action: 'setDeckIcon', icon: 'Fire' });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck-icon').getAttribute('src') === '/assets/energy/fire.png');
      const alone = await read('a');
      assert.equal(alone.shown, true, 'a picture without a deck text');
      assert.equal(alone.text, '');
      assert.equal(await pill('a').evaluate((node) => node.classList.contains('no-text')), true);
      await send('action:trainerA', { action: 'setDeckIcon', icon: '' });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck').hidden);
    });

    it('can switch off the deck, or just its picture, in the overlay settings', async () => {
      await send('action:trainerA', { action: 'setDeck', deck: 'Gardevoir ex' });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck-icon').getAttribute('src') === '/img/sprite/282.png');
      await send('action:settings', { action: 'update', display: { deckIcon: false } });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck-icon').hidden);
      assert.deepEqual(await read('a'), { shown: true, text: 'Gardevoir ex', icon: null, kind: 'pokemon', title: '' });

      await send('action:settings', { action: 'update', display: { deckType: false, deckIcon: true } });
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-deck').classList.contains('opt-off'));
      assert.equal((await read('a')).shown, false);
      await send('action:settings', { action: 'update', display: { deckType: true } });
      await page.waitForFunction(() => !document.querySelector('.sb-a .sb-deck').classList.contains('opt-off'));
      assert.equal((await read('a')).icon, '/img/sprite/282.png');
    });

    it('keeps the text when the picture of the Pokémon cannot be had (no internet), and keeps a long deck on one line', async () => {
      await page.unroute('**/img/sprite/*.png');
      await page.route('**/img/sprite/*.png', (route) => route.fulfill({ status: 204 }));
      await send('action:trainerB', { action: 'setDeck', deck: 'Dragapult ex with a very long name here' });
      await page.waitForFunction(() => document.querySelector('.sb-b .sb-deck-text').textContent.startsWith('Dragapult'));
      await page.waitForFunction(() => document.querySelector('.sb-b .sb-deck-icon').hidden);
      const state = await read('b');
      assert.equal(state.shown, true);
      assert.equal(state.icon, null, 'no broken picture');
      const box = await pill('b').evaluate((node) => ({ height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width, wraps: getComputedStyle(node).whiteSpace }));
      assert.ok(box.height < 40, `one line (${box.height})`);
      assert.ok(box.width <= 340, `not wider than the room it has (${box.width})`);
      assert.deepEqual(page.problems, []);
    });
  });

  // The cards chosen for the prizes of a trainer show on their prize cards
  describe('the cards on the prizes', () => {
    const art = (name) => `/art/${name}.svg`;
    const card = (name) => ({ cardId: `t-${name}`, name, image: art(name) });
    const prize = (side, index) => page.locator(`.trainer-${side} .prize`).nth(index);
    const faces = (side = 'a') => page.$$eval(`.trainer-${side} .prize`, (nodes) => nodes.map((node) => node.classList.contains('has-face')));
    // the picture painted in front of a prize card (the card chosen for it), or none
    const front = (side, index) => prize(side, index).evaluate((node) => { const style = getComputedStyle(node, '::after'); return style.content === 'none' ? 'none' : style.backgroundImage; });
    const waitFaces = (side, count) => page.waitForFunction(([which, wanted]) => document.querySelectorAll(`.trainer-${which} .prize.has-face`).length === wanted, [side, count]);
    const shot = async (side, index) => { await wait(350); return prize(side, index).screenshot(); };

    // (the prize cards are face down until they are shown: these show them)
    beforeEach(async () => {
      for (const side of ['trainerA', 'trainerB']) await send(`action:${side}`, { action: 'togglePrizeHidden', enabled: false });
      await page.waitForFunction(() => !document.querySelector('.prizes.is-hidden'));
    });

    it('starts face down: the cards that are chosen do not show until the prizes are shown', async () => {
      for (const side of ['trainerA', 'trainerB']) await send(`action:${side}`, { action: 'togglePrizeHidden', enabled: true });
      await page.waitForFunction(() => document.querySelectorAll('.prizes.is-hidden').length === 2);
      await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('one')] });
      await waitFaces('a', 1);
      assert.equal(await front('a', 0), 'none', 'face down: no card shows');
      assert.equal(await prize('a', 0).evaluate((node) => getComputedStyle(node, '::after').content), 'none', 'nothing is written on it: it is just the back');
      await send('action:trainerA', { action: 'togglePrizeHidden', enabled: false });
      await page.waitForFunction(() => !document.querySelector('.trainer-a .prizes.is-hidden'));
      assert.match(await front('a', 0), /\/art\/one\.svg/);
    });

    it('shows the card chosen for a prize card on that prize card, and nothing on the others', async () => {
      assert.deepEqual(await faces('a'), [false, false, false, false, false, false], 'no card is chosen at first');
      await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('one'), card('two'), null, card('four')] });
      await waitFaces('a', 3);
      assert.deepEqual(await faces('a'), [true, true, false, true, false, false]);
      assert.deepEqual(await faces('b'), [false, false, false, false, false, false], 'the other trainer has none');
      assert.match(await front('a', 0), /\/art\/one\.svg/);
      assert.match(await front('a', 1), /\/art\/two\.svg/);
      assert.equal(await front('a', 2), 'none');
      assert.match(await front('a', 3), /\/art\/four\.svg/);
      assert.equal(await prize('a', 0).evaluate((node) => node.style.getPropertyValue('--prize-face')), 'url("/art/one.svg")');
      assert.equal(await prize('a', 2).evaluate((node) => node.style.getPropertyValue('--prize-face')), '', 'a prize card without one has nothing left behind');
      assert.deepEqual(page.problems, []);
    });

    it('loads the picture of the card, and paints it over the card back, which stays the same underneath', async () => {
      const backBefore = await prize('a', 0).evaluate((node) => getComputedStyle(node).backgroundImage);
      const without = await shot('a', 0);
      await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('one')] });
      await waitFaces('a', 1);
      const width = await page.evaluate((url) => new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth);
        image.onerror = () => resolve(0);
        image.src = url;
      }), art('one'));
      assert.equal(width, 300, 'the picture of the card loads');
      assert.equal(await prize('a', 0).evaluate((node) => getComputedStyle(node).backgroundImage), backBefore, 'the card back is not touched');
      assert.ok(!(await shot('a', 0)).equals(without), 'and the card is what shows');
      // the same size as the prize card, so it covers the back
      const sizes = await prize('a', 0).evaluate((node) => { const after = getComputedStyle(node, '::after'); return [after.width, after.height, getComputedStyle(node).width, getComputedStyle(node).height]; });
      assert.deepEqual(sizes.slice(0, 2).map(parseFloat).map(Math.round), [38, 54], 'inside the 1 pixel border of the 40 by 56 prize card');
      assert.deepEqual(sizes.slice(2).map(parseFloat), [40, 56]);
    });

    it('turns them face down with a question mark while the prizes are hidden, and face up again when they are not', async () => {
      await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('one'), card('two')] });
      await waitFaces('a', 2);
      const faceUp = await shot('a', 0);
      await send('action:trainerA', { action: 'togglePrizeHidden', enabled: true });
      await page.waitForFunction(() => document.querySelector('.trainer-a .prizes.is-hidden'));
      assert.equal(await prize('a', 0).evaluate((node) => getComputedStyle(node, '::after').content), 'none', 'no question mark, and not the card');
      assert.equal(await prize('a', 0).evaluate((node) => getComputedStyle(node, '::after').backgroundImage), 'none');
      assert.ok(!(await shot('a', 0)).equals(faceUp), 'face down');
      assert.deepEqual(await faces('a'), [true, true, false, false, false, false], 'the cards are still chosen');

      await send('action:trainerA', { action: 'togglePrizeHidden', enabled: false });
      await page.waitForFunction(() => !document.querySelector('.trainer-a .prizes.is-hidden'));
      assert.match(await front('a', 0), /\/art\/one\.svg/);
    });

    it('does not give the pictures of the cards to the prize cards while the prizes are hidden, so no design can show them', async () => {
      const pictures = (side = 'a') => page.$$eval(`.trainer-${side} .prize`, (nodes) => nodes.map((node) => node.style.getPropertyValue('--prize-face')));
      await send('action:trainerA', { action: 'togglePrizeHidden', enabled: true });
      await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('one'), card('two')] });
      await waitFaces('a', 2);
      assert.deepEqual(await pictures(), ['', '', '', '', '', ''], 'face down: the pictures are not there');
      // (a design's style sheet that would paint them on the prize cards has nothing to paint)
      await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, css: '#stage .prize.has-face::after{content:"";background-image:var(--prize-face)}' }));
      assert.equal(await prize('a', 0).evaluate((node) => getComputedStyle(node, '::after').backgroundImage), 'none');

      await send('action:trainerA', { action: 'togglePrizeHidden', enabled: false });
      await page.waitForFunction(() => document.querySelector('.trainer-a .prize').style.getPropertyValue('--prize-face') !== '');
      assert.deepEqual(await pictures(), ['url("/art/one.svg")', 'url("/art/two.svg")', '', '', '', '']);
      await send('action:trainerA', { action: 'togglePrizeHidden', enabled: true });
      await page.waitForFunction(() => document.querySelector('.trainer-a .prizes.is-hidden'));
      assert.deepEqual(await pictures(), ['', '', '', '', '', ''], 'and gone again when they are hidden again');
      await page.evaluate(() => window.oto.applyTheme(null));
    });

    it('fades the ones that are taken with their card still on them, and keeps the red mask of a penalty over the card', async () => {
      await send('action:trainerA', { action: 'prizeCardsSet', cards: ['one', 'two', 'three', 'four', 'five', 'six'].map(card) });
      await send('action:trainerA', { action: 'prizeSet', count: 3 });
      await send('action:trainerB', { action: 'prizePenaltySet', count: 1 });
      await waitFaces('a', 6);
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.taken').length === 3 && document.querySelectorAll('.trainer-a .prize.penalty').length === 1);
      await page.waitForFunction(() => { const taken = getComputedStyle(document.querySelector('.trainer-a .prize.taken')); return taken.filter === 'grayscale(1)' && Number(taken.opacity) < 0.3; });
      assert.deepEqual(await faces('a'), [true, true, true, true, true, true]);
      assert.match(await front('a', 5), /\/art\/six\.svg/, 'a taken prize card keeps its card');
      assert.equal(await prize('a', 0).evaluate((node) => node.classList.contains('penalty')), true);
      const layers = await prize('a', 0).evaluate((node) => [getComputedStyle(node, '::before').zIndex, getComputedStyle(node, '::after').zIndex, getComputedStyle(node, '::before').backgroundColor]);
      assert.equal(layers[0], '1', 'the red mask is over the card');
      assert.equal(layers[1], 'auto');
      assert.notEqual(layers[2], 'rgba(0, 0, 0, 0)');
    });

    it('goes with the picture of the design on the back of the prize cards: the card is over it', async () => {
      await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('one')] });
      await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, sounds: [], prizeStyle: 'japanese' }));
      await waitFaces('a', 1);
      assert.match(await prize('a', 0).evaluate((node) => getComputedStyle(node).backgroundImage), /cardbacks\/japanese/);
      assert.match(await front('a', 0), /\/art\/one\.svg/);
      assert.equal(await front('a', 1), 'none');
      assert.match(await prize('a', 1).evaluate((node) => getComputedStyle(node).backgroundImage), /cardbacks\/japanese/, 'the others show that back');
    });

    it('takes them away when the cards are cleared, and for the next game', async () => {
      await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('one'), card('two')] });
      await send('action:trainerB', { action: 'prizeCardsSet', cards: [card('three')] });
      await waitFaces('a', 2);
      await waitFaces('b', 1);
      await send('action:trainerA', { action: 'prizeCardsSet', cards: [] });
      await waitFaces('a', 0);
      assert.equal(await prize('a', 0).evaluate((node) => node.style.getPropertyValue('--prize-face')), '');
      await waitFaces('b', 1);
      await send('action:match', { action: 'nextGame' });
      await waitFaces('b', 0);
      assert.deepEqual(page.problems, []);
    });

    it('reads a game saved before the cards existed, and a state that has none', async () => {
      const sample = await live();
      for (const side of ['trainerA', 'trainerB']) delete sample[side].prizes.cards;
      await page.evaluate((state) => window.oto.update(state), sample);
      assert.deepEqual(await faces('a'), [false, false, false, false, false, false]);
      assert.deepEqual(page.problems, []);
    });
  });

  describe('the Stadium', () => {
    const box = () => page.$eval('.stadium-art', (node) => { const rect = node.getBoundingClientRect(); return { w: rect.width, h: rect.height }; });

    it('shows the picture window of the Stadium card, with its name below, and the whole card when a design asks for it', async () => {
      await send('action:card', { action: 'setStadium', cardId: 'sv-2', name: 'Area Zero', image: '/art/area-zero.svg', consume: false });
      await page.waitForSelector('.stadium:not([hidden])');
      await page.waitForFunction(() => document.querySelector('.stadium-img').complete);
      const art = await box();
      assert.ok(Math.abs(art.w - 300) < 1, `width ${art.w}`);
      assert.ok(Math.abs(art.h - 300 * 1.393333 * 0.37 / 0.836) < 1, `the shape of the picture window: ${art.h}`);
      assert.equal(await page.locator('.stadium-name').textContent(), 'Area Zero');
      const below = await page.$eval('.stadium', (node) => node.querySelector('.stadium-name').getBoundingClientRect().top >= node.querySelector('.stadium-art').getBoundingClientRect().bottom);
      assert.equal(below, true, 'the name is under the picture');

      await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, sounds: [], crop: { stadium: { x: 0, y: 0, w: 1, h: 1 } } }));
      await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--sa-w') === '1');
      const whole = await box();
      assert.ok(Math.abs(whole.h - 300 * 1.393333) < 1, `the whole card: ${whole.h}`);
      await page.evaluate(() => window.oto.applyTheme(null));
      await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--sa-w') === '');
      assert.ok(Math.abs((await box()).h - 300 * 1.393333 * 0.37 / 0.836) < 1, 'back to the picture window');
      assert.deepEqual(page.problems, []);
    });

    it('is not there while no Stadium is in play', async () => {
      assert.equal(await page.locator('.stadium').isHidden(), true);
    });
  });

  describe('the feature cards', () => {
    const add = (name) => send('action:card', { action: 'addFeatureCard', cardId: name, name, image: `/art/${name.toLowerCase().replace(/ /g, '-')}.svg` });
    const sign = (symbol) => send('action:card', { action: 'addFeatureSeparator', symbol });
    // the cards (by the name of their picture) and the signs, in order
    const shown = () => page.$$eval('.features .feature, .features .feature-sep', (nodes) => nodes.map((node) => (node.classList.contains('feature-sep') ? node.textContent : node.querySelector('.feature-img').alt)));
    // and how they are grouped: a stack of so many cards, or a card on its own
    const groups = () => page.$$eval('.features > *', (nodes) => nodes.map((node) => (node.classList.contains('feature-stack')
      ? `stack of ${node.dataset.cards}: ${[...node.children].map((child) => (child.classList.contains('feature-sep') ? child.textContent : child.querySelector('img').alt)).join(' ')}`
      : node.classList.contains('feature-sep') ? node.textContent : node.querySelector('img').alt)));
    const cardWidth = () => page.$eval('.features .feature', (node) => node.getBoundingClientRect().width);
    const rect = (selector) => page.$eval(selector, (node) => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; });
    const looks = () => page.evaluate(() => ({
      over: document.querySelector('.features').parentElement.className,
      on: ['a', 'b'].filter((side) => document.querySelector(`.trainer-${side}`).classList.contains('features-on')),
      stage: ['a', 'b'].filter((side) => document.getElementById('stage').classList.contains(`features-on-${side}`)),
      benches: ['a', 'b'].map((side) => getComputedStyle(document.querySelector(`.trainer-${side} .bench`)).display),
      hidden: document.querySelector('.features').hidden
    }));
    const benchOf = async (side) => {
      for (let slot = 0; slot < 2; slot++) await send(`action:${side}`, { action: 'setBench', slot, cardId: `${side}-${slot}`, name: `Mon ${slot}`, image: IMG, hp: 60 });
    };

    it('are hidden until there is one, and show the last three in the order they were added, as their pictures without their names', async () => {
      assert.equal(await page.locator('.features').isHidden(), true);
      await add('Boss Orders');
      await page.waitForSelector('.features:not([hidden])');
      assert.deepEqual(await shown(), ['Boss Orders']);
      for (const name of ['Ultra Ball', 'Iono', 'Switch']) await add(name);
      await page.waitForFunction(() => document.querySelectorAll('.features .feature').length === 3 && document.querySelector('.features .feature-img').alt === 'Ultra Ball');
      assert.deepEqual(await shown(), ['Ultra Ball', 'Iono', 'Switch'], 'the oldest one makes room');
      assert.equal(await page.$eval('.features .feature-img', (node) => node.getAttribute('src')), '/art/ultra-ball.svg');
      assert.equal(await page.locator('.features figcaption, .features .feature-name, .features .feature-caption').count(), 0, 'no names on the cards');
      assert.equal(await page.$eval('.features', (node) => node.innerText.trim()), '');
      assert.equal(await page.$eval('.features', (node) => node.classList.contains('combo')), false);
      assert.ok(Math.abs((await cardWidth()) - 176) < 1);
      assert.deepEqual(page.problems, []);
    });

    it('cover the bench of Trainer A to begin with, and that of Trainer B when the producer says so', async () => {
      await benchOf('trainerA');
      await benchOf('trainerB');
      await add('Boss Orders');
      await page.waitForSelector('.features:not([hidden])');
      assert.deepEqual(await looks(), { over: 'trainer trainer-a features-on', on: ['a'], stage: ['a'], benches: ['none', 'flex'], hidden: false });
      // where the bench was: under the Active Pokémon, in the trainer's column, inside the screen
      const cards = await rect('.features');
      assert.ok(cards.top >= (await rect('.trainer-a .active')).bottom, 'under the Active Pokémon');
      assert.ok(cards.left >= 36 && cards.right <= 36 + 620 && cards.bottom <= 1080, `in the column of Trainer A: ${JSON.stringify(cards)}`);

      await send('action:card', { action: 'setFeatureSide', side: 'trainerB' });
      await page.waitForFunction(() => document.querySelector('.features').parentElement.classList.contains('trainer-b'));
      assert.deepEqual(await looks(), { over: 'trainer trainer-b features-on', on: ['b'], stage: ['b'], benches: ['flex', 'none'], hidden: false });
      const there = await rect('.features');
      assert.ok(Math.abs(there.right - (1920 - 36)) < 1, 'at the right edge of the screen, like the bench of Trainer B');
      assert.ok(there.top >= (await rect('.trainer-b .active')).bottom);
      assert.deepEqual(page.problems, []);
    });

    it('can be hidden, and the bench is back; nothing covers it while there is no card, or while the cards are switched off', async () => {
      await benchOf('trainerA');
      await add('Boss Orders');
      await page.waitForSelector('.features:not([hidden])');
      await send('action:card', { action: 'toggleFeatures', enabled: false });
      await page.waitForFunction(() => document.querySelector('.features').hidden);
      assert.deepEqual(await looks(), { over: 'trainer trainer-a', on: [], stage: [], benches: ['flex', 'flex'], hidden: true });
      await send('action:card', { action: 'toggleFeatures', enabled: true });
      await page.waitForFunction(() => !document.querySelector('.features').hidden);
      assert.deepEqual((await looks()).on, ['a']);

      await send('action:settings', { action: 'update', display: { featureCards: false } });
      await page.waitForFunction(() => document.querySelector('.features').classList.contains('opt-off'));
      assert.deepEqual(await looks(), { over: 'trainer trainer-a', on: [], stage: [], benches: ['flex', 'flex'], hidden: false }, 'switched off: the bench shows');
      await send('action:settings', { action: 'update', display: { featureCards: true } });
      await page.waitForFunction(() => document.querySelector('.trainer-a').classList.contains('features-on'));

      await send('action:card', { action: 'clearFeatureCards' });
      await page.waitForFunction(() => document.querySelector('.features').hidden);
      assert.deepEqual(await looks(), { over: 'trainer trainer-a', on: [], stage: [], benches: ['flex', 'flex'], hidden: true });
      assert.equal((await live()).featureView.visible, true, 'shown still: the next card shows at once');
    });

    it('stack the cards joined by a sign, one over the other, with the sign between them, and each can be seen', async () => {
      await add('Boss Orders');
      await sign('+');
      await add('Ultra Ball');
      await sign('→');
      await add('Iono');
      await page.waitForFunction(() => document.querySelectorAll('.features .feature').length === 3);
      assert.deepEqual(await shown(), ['Boss Orders', '+', 'Ultra Ball', '→', 'Iono']);
      assert.deepEqual(await groups(), ['stack of 3: Boss Orders + Ultra Ball → Iono']);
      assert.equal(await page.$eval('.features', (node) => node.classList.contains('combo')), true);
      const cards = await page.$$eval('.feature-stack .feature', (nodes) => nodes.map((node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }));
      for (let i = 1; i < cards.length; i++) {
        assert.ok(cards[i].left < cards[i - 1].right, `card ${i + 1} is over the card before it`);
        assert.ok(cards[i].left - cards[i - 1].left > 60, `and the card before it can still be seen: ${cards[i].left - cards[i - 1].left}px of it`);
      }
      const signs = await page.$$eval('.feature-stack .feature-sep', (nodes) => nodes.map((node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, z: getComputedStyle(node).zIndex }; }));
      signs.forEach((one, i) => {
        assert.ok(one.left < cards[i + 1].left && one.right > cards[i + 1].left, `sign ${i + 1} is on the edge where the next card starts`);
        assert.ok(one.top >= cards[i].top && one.bottom <= cards[i].bottom, 'in the middle of the cards, not above or below them');
        assert.equal(one.z, '1', 'over the cards');
      });
      assert.ok((await rect('.features')).right <= 36 + 620, 'the stack fits in the column');
      assert.deepEqual(page.problems, []);
    });

    it('keep a card on its own apart from a stack', async () => {
      await add('Arven');
      await add('Rare Candy');
      await sign('+');
      await add('Charizard');
      await page.waitForFunction(() => document.querySelectorAll('.features .feature').length === 3);
      assert.deepEqual(await groups(), ['Arven', 'stack of 2: Rare Candy + Charizard']);
      const [alone, stacked] = [await rect('.features > .feature'), await rect('.features > .feature-stack')];
      assert.ok(alone.right <= stacked.left, 'side by side, not over each other');
    });

    it('never start with a sign, and keep one that waits for the next card', async () => {
      for (const name of ['One', 'Two', 'Three']) {
        await add(name);
        await sign('=');
      }
      await add('Four');
      await sign('or');
      await page.waitForFunction(() => document.querySelector('.features .feature-img').alt === 'Two');
      assert.deepEqual(await shown(), ['Two', '=', 'Three', '=', 'Four', 'or'], 'the sign before the oldest card shown is left out, the last one stays');
      assert.deepEqual(await groups(), ['stack of 3: Two = Three = Four or']);
    });

    it('stay hidden when there are only signs, and a card with no sign is as it always was', async () => {
      await sign('+');
      await page.waitForFunction(() => document.querySelector('.features').hidden === true);
      assert.deepEqual(await shown(), []);
      assert.deepEqual((await looks()).on, [], 'nothing covers the bench');
      await add('Boss Orders');
      await page.waitForFunction(() => document.querySelectorAll('.features .feature').length === 1);
      assert.deepEqual(await groups(), ['Boss Orders'], 'a sign before the first card is not shown');
      assert.equal(await page.$eval('.features', (node) => node.classList.contains('combo')), false);
    });

    it('are not drawn again when something else changes, so their pictures do not flash', async () => {
      await add('Boss Orders');
      await page.waitForSelector('.features:not([hidden])');
      await page.$eval('.features .feature-img', (node) => { node.dataset.mark = 'first'; });
      await send('action:trainerA', { action: 'activeDamage', amount: 10 });
      await send('action:card', { action: 'setFeatureSide', side: 'trainerB' });
      await page.waitForFunction(() => document.querySelector('.features').parentElement.classList.contains('trainer-b'));
      assert.equal(await page.$eval('.features .feature-img', (node) => node.dataset.mark), 'first', 'the same picture, moved with its box');
      await add('Iono');
      await page.waitForFunction(() => document.querySelectorAll('.features .feature').length === 2);
      assert.deepEqual(await shown(), ['Boss Orders', 'Iono']);
    });
  });

  describe('a mobile screen (a design with orientation portrait)', () => {
    const portrait = (extra = {}) => page.evaluate((more) => window.oto.applyTheme({ name: 'phone', colors: {}, images: {}, sounds: [], orientation: 'portrait', ...more }), extra);
    // (the stage is scaled in its frame, which is where the stage is on the page: see fit in overlay.js)
    const stage = () => page.$eval('#stage', (node) => ({
      w: node.offsetWidth, h: node.offsetHeight, portrait: node.classList.contains('portrait'), benchRow: node.classList.contains('bench-row'), transform: node.style.transform,
      frame: ['left', 'top', 'width', 'height'].map((side) => node.parentElement.style[side]).join(' ')
    }));
    const box = (selector) => page.$eval(selector, (node) => { const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; });
    const fill = async () => {
      await send('action:trainerB', { action: 'setActive', cardId: 'b-act', name: 'Charizard', image: IMG, hp: 150 });
      for (const side of ['trainerA', 'trainerB']) await send(`action:${side}`, { action: 'benchSizePlus' }); // six on the bench
      for (let slot = 0; slot < 6; slot++) {
        await send('action:trainerA', { action: 'setBench', slot, cardId: `a-${slot}`, name: `Mon ${slot}`, image: IMG, hp: 60 });
        await send('action:trainerB', { action: 'setBench', slot, cardId: `b-${slot}`, name: `Foe ${slot}`, image: IMG, hp: 60 });
      }
      await page.waitForFunction(() => document.querySelectorAll('.bench .mon.mini:not([hidden])').length === 12);
    };

    it('is the wide 1920 x 1080 stage unless the design says otherwise', async () => {
      assert.deepEqual(await stage(), { w: 1920, h: 1080, portrait: false, benchRow: false, transform: 'scale(1)', frame: '0px 0px 1920px 1080px' });
    });

    it('is a tall 1080 x 1920 stage, fitted to the screen, and goes back to the wide one with the design', async () => {
      await portrait();
      const tall = await stage();
      assert.deepEqual([tall.w, tall.h, tall.portrait], [1080, 1920, true]);
      await page.setViewportSize({ width: 540, height: 960 });
      await page.waitForFunction(() => document.getElementById('stage').style.transform === 'scale(0.5)');
      assert.equal((await stage()).frame, '0px 0px 540px 960px', 'half the size on a screen half the size');
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.waitForFunction(() => document.getElementById('stage').style.transform === 'scale(0.5625)');
      assert.equal((await stage()).frame, '656.25px 0px 607.5px 1080px', 'a tall stage is centered on a wide screen');

      await page.evaluate(() => window.oto.applyTheme(null));
      assert.deepEqual(await stage(), { w: 1920, h: 1080, portrait: false, benchRow: false, transform: 'scale(1)', frame: '0px 0px 1920px 1080px' });
      assert.deepEqual(page.problems, []);
    });

    it('puts the trainers one above the other with the middle between them, inside the screen, and the bench in a row', async () => {
      await page.setViewportSize({ width: 1080, height: 1920 });
      await fill();
      await portrait();
      assert.equal((await stage()).benchRow, true, 'there is no room for the bench at the side');
      const [board, a, b, center] = [await box('.scoreboard'), await box('.trainer-a'), await box('.trainer-b'), await box('.center')];
      for (const [name, rect] of Object.entries({ board, a, b, center })) {
        assert.ok(rect.left >= 0 && rect.right <= 1080 && rect.top >= 0 && rect.bottom <= 1920, `${name} is inside the screen: ${JSON.stringify(rect)}`);
      }
      assert.ok(board.bottom <= a.top, 'the scoreboard is on top');
      assert.ok(a.bottom <= center.top && center.bottom <= b.top, 'Trainer A, the middle, then Trainer B');
      assert.ok(a.right - a.left > 900 && b.right - b.left > 900, 'each trainer has the whole width');
      for (const side of ['a', 'b']) {
        const row = await page.$$eval(`.trainer-${side} .bench .mon.mini:not([hidden])`, (nodes) => nodes.map((node) => { const rect = node.getBoundingClientRect(); return { top: Math.round(rect.top), right: rect.right, left: rect.left }; }));
        assert.equal(row.length, 6);
        assert.deepEqual([...new Set(row.map((mon) => mon.top))].length, 1, `${side}: the whole bench in one row`);
        assert.ok(row.every((mon) => mon.left >= 0 && mon.right <= 1080));
      }
      // the feature cards take the place of a bench, and stay out of the middle
      await send('action:card', { action: 'addFeatureCard', cardId: 'f-1', name: 'Iono', image: IMG });
      await send('action:card', { action: 'addFeatureSeparator', symbol: '+' });
      await send('action:card', { action: 'addFeatureCard', cardId: 'f-2', name: 'Arven', image: IMG });
      await page.waitForSelector('.trainer-a.features-on');
      const middle = await box('.center');
      let cards = await box('.features');
      assert.ok(cards.left >= 0 && cards.right <= 1080 && cards.top >= (await box('.trainer-a .active')).bottom && cards.bottom <= middle.top, `over Trainer A's bench, above the middle: ${JSON.stringify(cards)}`);
      await send('action:card', { action: 'setFeatureSide', side: 'trainerB' });
      await page.waitForSelector('.trainer-b.features-on');
      cards = await box('.features');
      assert.ok(cards.left >= 0 && cards.right <= 1080 && cards.top >= middle.bottom && cards.bottom <= 1920, `over Trainer B's bench, below the middle: ${JSON.stringify(cards)}`);
      assert.deepEqual(page.problems, []);
    });

    it('is at the bottom for the second trainer, and moves everything down below a logo', async () => {
      await page.setViewportSize({ width: 1080, height: 1920 });
      await portrait();
      const noLogo = [await box('.scoreboard'), await box('.trainer-a')];
      assert.ok(Math.abs((await box('.trainer-b')).bottom - (1920 - 36)) < 1, 'Trainer B ends at the bottom edge, with the usual margin');
      await portrait({ images: { logoImage: '/art/logo.svg' } });
      await page.waitForFunction(() => document.documentElement.classList.contains('has-logo'));
      const logo = await box('.logo');
      const withLogo = [await box('.scoreboard'), await box('.trainer-a')];
      assert.ok(logo.bottom <= withLogo[0].top, 'the logo has the first row');
      assert.ok(logo.left >= 0 && logo.right <= 1080, 'inside the screen');
      assert.ok(Math.abs(withLogo[0].top - noLogo[0].top - 110) < 1 && Math.abs(withLogo[1].top - noLogo[1].top - 110) < 1, 'what is under it moves down by the same amount');
      assert.ok(Math.abs((await box('.trainer-b')).bottom - (1920 - 36)) < 1, 'Trainer B stays where it was');
    });

    it('keeps the toast banners inside the screen', async () => {
      await page.setViewportSize({ width: 1080, height: 1920 });
      await portrait();
      await send('action:toast', { action: 'topDeck', target: 'trainerA' });
      await page.waitForSelector('.toast-slot .toast.in');
      const slot = await box('.toast-slot');
      assert.ok(slot.left >= 0 && slot.right <= 1080 && slot.bottom <= 1920, JSON.stringify(slot));
    });
  });

  describe('another overlay for the same controller', () => {
    const api = (method, route, body) => fetch(`${server.base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const screens = (list) => send('action:settings', { action: 'update', screens: list });
    const screen = (extra = {}) => ({ id: 'vertical', name: 'Vertical', design: null, display: {}, sound: false, ...extra });
    const stage = (target) => target.$eval('#stage', (node) => ({ w: node.offsetWidth, h: node.offsetHeight, portrait: node.classList.contains('portrait') }));
    let second;
    afterEach(async () => { if (second) await second.context().close(); second = null; });
    const open = async (id = 'vertical', viewport = { width: 1080, height: 1920 }) => {
      second = await openPage(browser, `${server.base}/overlay?screen=${id}`, { viewport });
      await second.waitForSelector('.trainer-a .active .mon:not([hidden])');
      return second;
    };

    it('shows the same game, with the design of its own, while the main overlay keeps its look', async () => {
      await api('PUT', '/api/themes/Phone%20Screen', { colors: { '--accent': '#445566' }, orientation: 'portrait' });
      await screens([screen({ design: 'Phone Screen' })]);
      const phone = await open();
      assert.deepEqual(await stage(phone), { w: 1080, h: 1920, portrait: true });
      assert.equal(await phone.evaluate(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--accent').trim()), '#445566');
      assert.equal(await phone.locator('.trainer-a .sb-name, .sb-a .sb-name').first().textContent(), 'Ash', 'the same game');
      // the main overlay is as it was
      assert.deepEqual(await stage(page), { w: 1920, h: 1080, portrait: false });
      assert.equal(await page.evaluate(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--accent').trim()), '');

      // what the game does, both show
      await send('action:trainerA', { action: 'setName', name: 'Misty' });
      await phone.waitForFunction(() => document.querySelector('.sb-a .sb-name').textContent === 'Misty');
      await page.waitForFunction(() => document.querySelector('.sb-a .sb-name').textContent === 'Misty');
      assert.deepEqual(page.problems, []);
      assert.deepEqual(phone.problems, []);
    });

    it('is the design on air while the screen has none of its own, and follows the one on air when that changes', async () => {
      await api('PUT', '/api/themes/On%20Air', { colors: { '--accent': '#112233' } });
      await screens([screen()]);
      const other = await open('vertical', { width: 1280, height: 720 });
      assert.equal(await other.evaluate(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--accent').trim()), '');
      await api('POST', '/api/theme/active', { name: 'On Air' });
      await other.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--accent').trim() === '#112233');
      await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--accent').trim() === '#112233');
      await api('POST', '/api/theme/active', { name: null });
      await other.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--accent').trim() === '');
    });

    it('changes its design when the settings say so, without being reloaded, and goes back when the design is taken off', async () => {
      await api('PUT', '/api/themes/Tall', { colors: {}, orientation: 'portrait' });
      await screens([screen()]);
      const phone = await open();
      assert.equal((await stage(phone)).portrait, false);
      await screens([screen({ design: 'Tall' })]);
      await phone.waitForFunction(() => document.getElementById('stage').classList.contains('portrait'));
      await screens([screen({ design: null })]);
      await phone.waitForFunction(() => !document.getElementById('stage').classList.contains('portrait'));
    });

    it('has its own switches: what it says is shown or hidden there, and the rest is the main overlay\'s', async () => {
      await screens([screen({ display: { scoreboard: false, hpBars: false } })]);
      const phone = await open('vertical', { width: 1280, height: 720 });
      const hidden = (target, selector) => target.$eval(selector, (node) => Boolean(node.closest('.opt-off')));
      await phone.waitForFunction(() => document.querySelector('.scoreboard').classList.contains('opt-off'));
      assert.equal(await hidden(phone, '.scoreboard'), true);
      assert.equal(await hidden(page, '.scoreboard'), false, 'the main overlay still has its scoreboard');
      assert.equal(await phone.$eval('.trainer-a .active .hp', (node) => Boolean(node.closest('.opt-off') || node.classList.contains('opt-off'))), true);

      // the main overlay's own switch for something else reaches the screen, and what the screen says wins
      await send('action:settings', { action: 'update', display: { activePokemon: false, scoreboard: true } });
      await phone.waitForFunction(() => document.querySelector('.trainer-a .active').classList.contains('opt-off'));
      assert.equal(await hidden(phone, '.scoreboard'), true, 'the screen says hidden, whatever the main one says');
      await page.waitForFunction(() => document.querySelector('.trainer-a .active').classList.contains('opt-off'));
    });

    it('plays no sound unless its settings say it does (the main overlay does), and a screen that is not there is silent', async () => {
      await screens([screen()]);
      const phone = await open('vertical', { width: 800, height: 450 });
      const plays = (target) => target.evaluate(() => window.oto.playsSound(window.oto.state));
      assert.equal(await plays(phone), false);
      assert.equal(await plays(page), true);
      await screens([screen({ sound: true })]);
      await phone.waitForFunction(() => window.oto.playsSound(window.oto.state));
      await screens([]);
      await phone.waitForFunction(() => !window.oto.playsSound(window.oto.state));
      // and with no screen of that name it is the main overlay's look, with the main overlay's switches
      assert.equal(await phone.$eval('.scoreboard', (node) => node.classList.contains('opt-off')), false);
    });
  });

  describe('a font for each group of text', () => {
    const wear = (extra) => page.evaluate((more) => window.oto.applyTheme({ name: 'type', colors: {}, images: {}, sounds: [], ...more }), extra);
    const family = (selector) => page.$eval(selector, (node) => getComputedStyle(node).fontFamily);
    const variable = (name) => page.evaluate((key) => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue(key).trim(), name);

    it('is the main font for every group, until a design says otherwise', async () => {
      const main = await family('.sb-name');
      for (const selector of ['.sb-wins', '.mon-name']) assert.equal(await family(selector), main, selector);
      assert.match(main, /Bahnschrift/);
    });

    it('gives each group the fonts a design lists for it, and what has none keeps the main font', async () => {
      await send('action:trainerA', { action: 'setActive', cardId: 'a-9', name: 'Pikachu', image: IMG, hp: 100 });
      await wear({ fontFamilies: { names: 'Impact, sans-serif', numbers: 'Georgia', labels: '"Courier New"', banners: 'Verdana', subtitles: 'Tahoma', text: 'Arial' } });
      assert.match(await family('.sb-name'), /^Impact/);
      assert.match(await family('.mon-name'), /^Impact/, 'the names of the Pokémon are names too');
      assert.match(await family('.sb-wins'), /^Georgia/);
      assert.match(await family('.hp-text'), /^Georgia/, 'and the HP is a number');
      assert.match(await family('.turn-tag'), /Courier New/);
      assert.match(await variable('--font-banners'), /^Verdana/);
      assert.match(await variable('--font-subtitles'), /^Tahoma/);
      assert.match(await variable('--font-body'), /^Arial/);
      assert.equal(await variable('--font-display'), '', 'the main font was not touched');

      // only the main font: the groups that have none follow it
      await wear({ fontFamilies: { display: 'Georgia' } });
      assert.match(await family('.sb-name'), /^Georgia/);
      assert.match(await family('.sb-wins'), /^Georgia/);
      assert.equal(await variable('--font-names'), '');

      // a design that is taken away takes its fonts with it
      await page.evaluate(() => window.oto.applyTheme(null));
      assert.match(await family('.sb-name'), /Bahnschrift/);
      assert.equal(await variable('--font-display'), '');
      assert.deepEqual(page.problems, []);
    });

    it('loads the font file of a group, and puts it first in the list of fonts of that group', async () => {
      // (a font that is part of the app: the flag font)
      await wear({ fonts: { names: '/assets/fonts/TwemojiCountryFlags.woff2' }, fontFamilies: { names: 'Georgia' } });
      await page.waitForFunction(() => /OTO Theme names/.test(document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--font-names')));
      assert.match(await variable('--font-names'), /^"OTO Theme names", Georgia, var\(--font-display\)$/);
      assert.equal(await page.evaluate(() => [...document.fonts].some((face) => face.family.replace(/"/g, '') === 'OTO Theme names')), true);
      await page.evaluate(() => window.oto.applyTheme(null));
      assert.equal(await page.evaluate(() => [...document.fonts].some((face) => face.family.replace(/"/g, '') === 'OTO Theme names')), false, 'the font goes with the design');
    });

    it('keeps the fonts that were listed when the font file cannot be had, and the main font when nothing was', async () => {
      await wear({ fonts: { names: '/api/theme/assets/fonts/missing.woff2' }, fontFamilies: { names: 'Georgia' } });
      await page.waitForFunction(() => /^Georgia/.test(document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--font-names')));
      assert.match(await family('.sb-name'), /^Georgia/);
      await wear({ fonts: { numbers: '/api/theme/assets/fonts/missing.woff2' } });
      await wait(400);
      assert.equal(await variable('--font-numbers'), '', 'no list and no file: the main font');
    });

    it('is not mixed up when the design changes while a font is still on its way', async () => {
      await wear({ fonts: { names: '/assets/fonts/TwemojiCountryFlags.woff2' } });
      await wear({ fontFamilies: { names: 'Georgia' } });
      await wait(500);
      assert.match(await variable('--font-names'), /^Georgia/, 'the last design is the one that counts');
    });
  });

  describe('the colors of the kinds of card', () => {
    // an ability is red, a Pokémon Tool purple, a Stadium green and a Supporter orange: from the variables a design can change
    const colorOf = (name) => page.evaluate((variable) => { const probe = document.createElement('span'); probe.style.color = `var(${variable})`; document.body.appendChild(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; }, name);

    it('have a color each, as the variables of the page say', async () => {
      const colors = { ability: await colorOf('--ability'), tool: await colorOf('--tool'), stadium: await colorOf('--stadium'), supporter: await colorOf('--supporter') };
      assert.equal(new Set(Object.values(colors)).size, 4, JSON.stringify(colors));

      await send('action:trainerA', { action: 'setActive', cardId: 'c1', name: 'Pikachu', image: IMG, hp: 60, abilities: ['Static'] });
      await send('action:trainerA', { action: 'attachTool', slot: -1, cardId: 't1', name: 'Charm', image: IMG });
      await send('action:card', { action: 'setStadium', cardId: 's', name: 'Area Zero', image: IMG }).catch(() => {});
      await send('action:card', { action: 'select', target: 'stadium', cardId: 's', cardData: { id: 's', name: 'Area Zero', hp: '', images: { small: IMG, large: IMG }, abilities: [], attacks: [], retreat: 0 } });
      await page.waitForSelector('.trainer-a .ability');
      await page.waitForSelector('.trainer-a .tool-card');
      await page.waitForSelector('.stadium-name');
      assert.equal(await page.$eval('.trainer-a .ability', (node) => getComputedStyle(node).borderTopColor), colors.ability, 'an ability');
      assert.equal(await page.$eval('.trainer-a .ability', (node) => getComputedStyle(node, '::before').backgroundColor), colors.ability, 'and its diamond');
      assert.ok((await page.$eval('.trainer-a .tool-card', (node) => getComputedStyle(node).boxShadow)).includes(colors.tool), 'a tool');
      assert.equal(await page.$eval('.stadium-name', (node) => getComputedStyle(node).borderTopColor), colors.stadium, 'the Stadium');
      assert.equal(await page.$eval('.token[data-kind="stadium"]', (node) => getComputedStyle(node).borderTopColor), colors.stadium, 'its play counter');
      assert.equal(await page.$eval('.token[data-kind="supporter"]', (node) => getComputedStyle(node).borderTopColor), colors.supporter, 'and the Supporter counter');
    });

    it('follow a design that changes them', async () => {
      await send('action:trainerA', { action: 'setActive', cardId: 'c1', name: 'Pikachu', image: IMG, hp: 60, abilities: ['Static'] });
      await page.waitForSelector('.trainer-a .ability');
      await page.evaluate(() => window.oto.applyTheme({ name: 'colors', colors: { '--ability': '#00ff00' }, images: {}, sounds: [] }));
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.trainer-a .ability')).borderTopColor === 'rgb(0, 255, 0)');
      await page.evaluate(() => window.oto.applyTheme(null));
    });
  });

  describe('Pokémon Tools', () => {
    const cards = (side) => page.$$eval(`.trainer-${side} .tool-cards:not([hidden]) .tool-card`, (nodes) => nodes.map((node) => ({
      text: node.textContent, plain: node.classList.contains('plain'), image: node.querySelector('img') ? node.querySelector('img').getAttribute('src') : null, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height
    })));
    const names = (side) => page.$$eval(`.trainer-${side} .tools:not([hidden]) .tool`, (nodes) => nodes.map((node) => node.textContent));
    const visible = (selector) => page.$$eval(selector, (nodes) => nodes.filter((node) => node.offsetParent !== null).length);

    it('are shown as the pictures of their cards, and not by name unless that is asked for', async () => {
      assert.equal(await visible('.tool-cards'), 0, 'nothing is shown until there is a tool');
      await send('action:trainerA', { action: 'attachTool', slot: -1, cardId: 't1', name: 'Bravery Charm', image: IMG });
      await send('action:trainerA', { action: 'setBench', slot: 0, cardId: 'b0', name: 'Eevee', image: IMG, hp: 60 });
      await send('action:trainerA', { action: 'attachTool', slot: 0, cardId: 't2', name: 'Float Stone', image: IMG });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .tool-cards:not([hidden]) .tool-card').length === 2);
      const [active, bench] = await cards('a');
      assert.deepEqual([active.image, active.plain, active.text], [IMG, false, ''], 'the picture of the card, and nothing written on it');
      assert.deepEqual([bench.image, bench.plain, bench.text], [IMG, false, '']);
      assert.ok(Math.abs(active.width - 104) < 1 && Math.abs(bench.width - 64) < 1, `the Active Pokémon's is bigger: ${active.width} and ${bench.width}`);
      assert.ok(Math.abs(active.height - 104 * 1.393333 * 0.37 / 0.836) < 1, `the shape of the picture window of the card: ${active.height}`);
      assert.equal(await page.locator('.trainer-a .active .hp-text').textContent(), '100/100', 'a tool leaves the HP of the Pokémon alone');
      assert.equal(await visible('.tools'), 0, 'the names are not shown unless a design or a producer asks for them');

      // the names, as text, for the ones who want them
      await send('action:settings', { action: 'update', display: { toolNames: true } });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .tools:not([hidden]) .tool').length === 2);
      assert.deepEqual(await names('a'), ['Bravery Charm', 'Float Stone']);
      await send('action:settings', { action: 'update', display: { toolCards: false } });
      await page.waitForFunction(() => ![...document.querySelectorAll('.tool-cards')].some((node) => node.offsetParent !== null));
      assert.equal(await visible('.tools'), 2, 'the names stay');
      await send('action:settings', { action: 'update', display: { toolCards: true, toolNames: false } });
      await page.waitForFunction(() => [...document.querySelectorAll('.tool-cards')].some((node) => node.offsetParent !== null) && ![...document.querySelectorAll('.tools')].some((node) => node.offsetParent !== null));

      await send('action:trainerA', { action: 'removeTool', slot: -1, index: 0 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .tool-cards:not([hidden]) .tool-card').length === 1);
      assert.deepEqual(page.problems, []);
    });

    it('are not drawn again when something else changes, so their pictures do not flash', async () => {
      await send('action:trainerA', { action: 'attachTool', slot: -1, cardId: 't1', name: 'Bravery Charm', image: IMG });
      await page.waitForSelector('.trainer-a .active .tool-card img');
      await page.evaluate(() => { document.querySelector('.trainer-a .active .tool-card').dataset.same = 'yes'; });
      await send('action:trainerA', { action: 'activeDamage', amount: 10 });
      await send('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'fire', count: 1 });
      await page.waitForFunction(() => document.querySelector('.trainer-a .active .hp-text').textContent === '90/100');
      assert.equal(await page.$eval('.trainer-a .active .tool-card', (node) => node.dataset.same), 'yes', 'the same picture is still there');
      await send('action:trainerA', { action: 'attachTool', slot: -1, cardId: 't3', name: 'Another', image: IMG });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .active .tool-card').length === 2);
    });

    it('is a chip with the name when the tool has no picture (put there by hand)', async () => {
      await send('action:trainerA', { action: 'attachTool', slot: -1, cardId: '', name: 'Lucky Helmet', image: '' });
      await page.waitForSelector('.trainer-a .active .tool-card.plain');
      const [plain] = await cards('a');
      assert.deepEqual([plain.plain, plain.image, plain.text], [true, null, 'Lucky Helmet']);
    });

    it('show the part of the card that the design says (the picture of a Trainer card unless it asks for the whole card)', async () => {
      await send('action:trainerA', { action: 'attachTool', slot: -1, cardId: 't1', name: 'Bravery Charm', image: IMG });
      await page.waitForSelector('.trainer-a .active .tool-card img');
      const height = () => page.$eval('.trainer-a .active .tool-card', (node) => node.getBoundingClientRect().height);
      assert.ok(Math.abs(await height() - 104 * 1.393333 * 0.37 / 0.836) < 1);
      await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, sounds: [], crop: { tool: { x: 0, y: 0, w: 1, h: 1 } } }));
      await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--ct-w') === '1');
      assert.ok(Math.abs(await height() - 104 * 1.393333) < 1, 'the whole card');
      await page.evaluate(() => window.oto.applyTheme(null));
      await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--ct-w') === '');
      assert.ok(Math.abs(await height() - 104 * 1.393333 * 0.37 / 0.836) < 1, 'back to the usual');
      assert.deepEqual(page.problems, []);
    });
  });

  describe('the reserved spaces of a design', () => {
    const wear = (spaces, images = {}, extra = {}) => page.evaluate(([list, pictures, more]) => window.oto.applyTheme({ name: 'spaces', colors: {}, images: pictures, sounds: [], spaces: list, ...more }), [spaces, images, extra]);
    const spaces = () => page.$$eval('.space', (nodes) => nodes.map((node) => {
      const style = getComputedStyle(node);
      return { shape: node.className.replace('space ', ''), left: node.offsetLeft, top: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight, radius: style.borderTopLeftRadius, border: style.borderTopWidth, image: style.backgroundImage, visible: node.offsetParent !== null };
    }));

    it('are nothing at all unless a design has some', async () => {
      assert.equal(await page.locator('.space').count(), 0);
      await wear([]);
      assert.equal(await page.locator('.space').count(), 0);
    });

    it('are an outline of their shape where the design says, behind everything else, and nothing is drawn inside', async () => {
      await wear([
        { id: 1, name: 'Camera', shape: 'rect', x: 100, y: 200, w: 480, h: 270 },
        { id: 2, shape: 'rounded', x: 700, y: 300, w: 400, h: 225 },
        { id: 3, shape: 'circle', x: 1300, y: 250, w: 300, h: 300 }
      ]);
      const [rect, rounded, circle] = await spaces();
      assert.deepEqual([rect.left, rect.top, rect.w, rect.h], [100, 200, 480, 270]);
      assert.deepEqual([rounded.left, rounded.top, rounded.w, rounded.h], [700, 300, 400, 225]);
      assert.equal(rect.radius, '0px');
      assert.equal(rounded.radius, '30px');
      assert.equal(circle.radius, '50%', 'a circle (or an oval, when it is not as wide as it is tall)');
      assert.ok([rect, rounded, circle].every((space) => space.border === '4px' && space.image === 'none'));
      assert.equal(await page.locator('.space *').count(), 0, 'the inside is for what shows through');
      const behind = await page.evaluate(() => { const layer = document.querySelector('.spaces'); const logo = document.querySelector('.logo'); return Boolean(layer.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING) && getComputedStyle(layer).pointerEvents === 'none'; });
      assert.equal(behind, true, 'under the logo and the pieces of the overlay, and the clicks go through');
    });

    it('show the picture the design has for them, instead of the outline, each its own', async () => {
      await wear([{ id: 2, shape: 'rounded', x: 50, y: 60, w: 320, h: 180 }, { id: 4, shape: 'rect', x: 500, y: 60, w: 200, h: 200 }], { spaceFrame2: '/art/frame-two.svg' });
      const [first, second] = await spaces();
      assert.match(first.image, /frame-two\.svg/);
      assert.equal(first.border, '0px', 'no outline over a picture');
      assert.equal(second.image, 'none', 'the other has none: the outline');
      assert.equal(second.border, '4px');
      assert.equal(await page.locator('.space.has-frame').count(), 1);
      assert.equal(await page.$eval('.space.has-frame', (node) => getComputedStyle(node).backgroundSize), '100% 100%');
    });

    it('can be switched off, and are left out when they are not right', async () => {
      await wear([
        { id: 1, shape: 'blob', x: 10, y: 10, w: 100, h: 100 },
        { id: 2, shape: 'rect', x: 'left', y: 10, w: 100, h: 100 },
        null, 'text', { id: 3, shape: 'rect', x: 20, y: 20, w: 100 }
      ]);
      const kept = await spaces();
      assert.equal(kept.length, 1, 'only the one that can be drawn');
      assert.equal(kept[0].shape, 'shape-rect', 'a shape nobody knows is a rectangle');

      assert.equal(kept[0].visible, true);
      await send('action:settings', { action: 'update', display: { spaces: false } });
      await page.waitForFunction(() => !document.querySelector('.space').offsetParent);
      assert.equal((await spaces())[0].visible, false);
      await send('action:settings', { action: 'update', display: { spaces: true } });
      await page.waitForFunction(() => document.querySelector('.space').offsetParent !== null);
    });

    it('go with the design: another design, or none, takes them away', async () => {
      await wear([{ id: 1, shape: 'rect', x: 10, y: 10, w: 100, h: 100 }]);
      assert.equal(await page.locator('.space').count(), 1);
      await wear([{ id: 1, shape: 'rect', x: 10, y: 10, w: 100, h: 100 }, { id: 2, shape: 'rect', x: 200, y: 10, w: 100, h: 100 }]);
      assert.equal(await page.locator('.space').count(), 2, 'not added to the last design\'s');
      await page.evaluate(() => window.oto.applyTheme(null));
      assert.equal(await page.locator('.space').count(), 0);
    });
  });

  describe('a paused game', () => {
    const paused = () => page.$eval('#stage', (node) => node.classList.contains('is-paused'));

    it('shows a PAUSED banner in the middle, and grays out everything else until the game is resumed', async () => {
      assert.equal(await page.locator('.pause-banner').isHidden(), true);
      await send('action:match', { action: 'togglePause', enabled: true });
      await page.waitForSelector('.pause-banner:not([hidden])');
      assert.match(await page.locator('.pause-banner').textContent(), /GAME PAUSED/);
      assert.equal(await paused(), true);
      assert.match(await page.$eval('.scoreboard', (node) => getComputedStyle(node).filter), /grayscale\(1\)/);
      assert.match(await page.$eval('.trainer-a', (node) => getComputedStyle(node).filter), /grayscale\(1\)/);
      assert.equal(await page.$eval('.pause-banner', (node) => getComputedStyle(node).filter), 'none', 'the banner itself is not grayed');
      const middle = await page.$eval('.pause-banner', (node) => { const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
      assert.ok(Math.abs(middle.x - 960) < 4 && Math.abs(middle.y - 540) < 60, `in the middle: ${JSON.stringify(middle)}`);
      await wait(3000);
      assert.equal(await page.locator('.pause-banner').isVisible(), true, 'it stays: it is not a toast that goes by itself');

      await send('action:match', { action: 'togglePause', enabled: false });
      await page.waitForSelector('.pause-banner', { state: 'hidden' });
      assert.equal(await paused(), false);
      assert.equal(await page.$eval('.scoreboard', (node) => getComputedStyle(node).filter), 'none');
      await page.waitForFunction(() => /GAME RESUMED/.test(document.querySelector('.toasts').textContent));
      assert.deepEqual(page.problems, []);
    });

    it('is not shown when the game pause banner, or the banners, are switched off', async () => {
      await send('action:settings', { action: 'update', enablePauseToast: false });
      await send('action:match', { action: 'togglePause', enabled: true });
      await wait(300);
      assert.equal(await page.locator('.pause-banner').isHidden(), true);
      assert.equal(await paused(), false);

      await send('action:settings', { action: 'update', enablePauseToast: true });
      await page.waitForSelector('.pause-banner:not([hidden])');
      await send('action:settings', { action: 'update', display: { toasts: false } });
      await page.waitForSelector('.pause-banner', { state: 'hidden' });
      assert.equal(await paused(), false);
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
      // a card whose art window (that of a Special Energy card) is green and everything else blue, so what the circle shows can be told by color
      const GREEN = '32,208,64';
      const BLUE = '32,48,208';
      const ART = require('../../public/js/theme-options').ENERGY_ART;
      const CIRCLE = require('../../public/js/theme-options').ENERGY_CIRCLE;
      const flatCard = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="418"><rect width="300" height="418" fill="#2030d0"/><rect x="${ART.x * 300}" y="${ART.y * 418}" width="${ART.w * 300}" height="${ART.h * 418}" fill="#20d040"/></svg>`;
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
        // 26 pixels inside the border show the width of the circle, which is as wide as the art is tall, from the middle of the art
        assert.ok(Math.abs(look.imgW - 26 / CIRCLE.w) < 0.5, `picture ${look.imgW} px wide`);
        assert.ok(Math.abs(look.imgLeft - 26 * (0.5 - (CIRCLE.x + CIRCLE.w / 2) / CIRCLE.w)) < 0.6, `picture left ${look.imgLeft}`);
        assert.ok(Math.abs(look.imgTop - 26 * (0.5 - (CIRCLE.y + CIRCLE.h / 2) * 1.3933 / CIRCLE.w)) < 0.6, `picture top ${look.imgTop}`);
        assert.ok(Math.abs(CIRCLE.h - ART.h) < 0.002 && Math.abs(CIRCLE.x + CIRCLE.w / 2 - (ART.x + ART.w / 2)) < 0.002, 'the circle is the height of the art, in the middle of it');
        assert.deepEqual([...new Set(await seen())], [GREEN], 'only the art window shows in the circle');
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

  describe('a Pokémon\'s tile', () => {
    const box = (selector) => page.$eval(selector, (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
    const within = (inner, outer, label, slack = 14) => {
      assert.ok(inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1, `${label} is inside the picture: ${JSON.stringify(inner)} in ${JSON.stringify(outer)}`);
      return slack;
    };

    beforeEach(async () => {
      await send('action:trainerA', { action: 'setRetreat', slot: -1, cost: 2 });
      await send('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-2', name: 'Eevee', image: IMG, hp: 60, retreat: 1 });
      await send('action:trainerA', { action: 'attachEnergy', slot: 0, energyType: 'water', count: 2, countsAsTurn: false });
      await page.waitForSelector('.trainer-a .active .retreat .energy');
      await page.waitForSelector('.trainer-a .bench .mon:not([hidden]) .energy');
    });

    it('has the HP bar on top of the art, the energy at its bottom left and the retreat cost at its bottom right', async () => {
      const art = await box('.trainer-a .active .art');
      const bar = await box('.trainer-a .active .art .hp');
      const energies = await box('.trainer-a .active .art .energies');
      const retreat = await box('.trainer-a .active .art .retreat');
      within(bar, art, 'the HP bar');
      within(energies, art, 'the energy');
      within(retreat, art, 'the retreat cost');
      assert.ok(bar.top - art.top < 14, `the HP bar is at the top: ${bar.top - art.top}`);
      assert.ok(bar.width > art.width * 0.9, 'and spans the picture');
      assert.ok(art.bottom - energies.bottom < 14 && energies.left - art.left < 14, 'the energy is in the bottom left corner');
      assert.ok(art.bottom - retreat.bottom < 14 && art.right - retreat.right < 14, 'the retreat cost is in the bottom right corner');
      assert.ok(energies.right < retreat.left, 'they do not overlap');

      // the numbers are on the bar
      const text = await box('.trainer-a .active .art .hp-text');
      within(text, bar, 'the numbers');
      assert.equal(await page.locator('.trainer-a .active .art .hp-text').textContent(), '100/100');
      assert.equal(await page.locator('.trainer-a .active .details .hp').count(), 0, 'nothing of it is left under the picture');

      // the name stays beside the picture, and the picture is the art of the card, not the whole card
      assert.ok(art.height < 200, `just the art: ${art.height}`);
      assert.equal(await page.locator('.trainer-a .active .details .mon-name').textContent(), 'Pikachu');
    });

    it('draws the retreat cost as that many colorless Energy', async () => {
      assert.equal(await page.locator('.trainer-a .active .retreat .energy-colorless').count(), 2);
      assert.equal(await page.locator('.trainer-a .active .retreat').getAttribute('title'), 'Retreat cost 2');
      const image = await page.$eval('.trainer-a .active .retreat .energy-colorless', (node) => getComputedStyle(node).backgroundImage);
      assert.match(image, /\/assets\/energy\/colorless\.png/);

      await send('action:trainerA', { action: 'setRetreat', slot: -1, cost: 4 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .active .retreat .energy-colorless').length === 4);
      await send('action:trainerA', { action: 'setRetreat', slot: -1, cost: 0 });
      await page.waitForFunction(() => document.querySelector('.trainer-a .active .retreat').hidden);
      assert.equal(await page.locator('.trainer-a .active .retreat').isVisible(), false, 'a free retreat shows nothing');
    });

    it('does the same on the bench, with the small thin bar and at most six Energy and the count of the rest, and no retreat cost (that is for the Active Pokémon)', async () => {
      const art = await box('.trainer-a .bench .mon.mini:not([hidden]) .art');
      const bar = await box('.trainer-a .bench .mon.mini:not([hidden]) .art .hp');
      within(bar, art, 'the HP bar');
      assert.ok(bar.height <= 17 && bar.top - art.top < 6, `a thin bar on top: ${bar.height}`);
      assert.equal(await page.locator('.trainer-a .bench .mon.mini:not([hidden]) .retreat .energy').count(), 0);
      assert.equal(await page.locator('.trainer-a .bench .mon.mini:not([hidden]) .art .retreat').count(), 0);

      await send('action:trainerA', { action: 'attachEnergy', slot: 0, energyType: 'fire', count: 7, countsAsTurn: false });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .bench .mon.mini:not([hidden]) .art .energies .energy').length === 6);
      assert.equal(await page.locator('.trainer-a .bench .mon.mini:not([hidden]) .art .energies .energy-more').textContent(), '+3', 'nine are attached, six are drawn');
    });

    it('crosses the retreat cost out while the Pokémon cannot retreat', async () => {
      assert.equal(await page.locator('.trainer-a .active .retreat.blocked').count(), 0);
      await send('action:trainerA', { action: 'toggleStatus', condition: 'trapped', enabled: true });
      await page.waitForSelector('.trainer-a .active .retreat.blocked');
      assert.equal(await page.locator('.trainer-a .active .retreat').getAttribute('title'), "Can't retreat");
      const line = await page.$eval('.trainer-a .active .retreat', (node) => { const style = getComputedStyle(node, '::after'); return { content: style.content, color: style.backgroundColor, height: style.height }; });
      assert.equal(line.content, '""');
      assert.notEqual(line.color, 'rgba(0, 0, 0, 0)', 'a red line across it');
      await send('action:trainerA', { action: 'clearStatus' });
      await page.waitForFunction(() => !document.querySelector('.trainer-a .active .retreat.blocked'));
    });

    it('can be switched off with its own switch, and the rest of the tile stays', async () => {
      await send('action:settings', { action: 'update', display: { retreatCost: false } });
      await page.waitForFunction(() => document.querySelector('.trainer-a .active .retreat').offsetParent === null);
      assert.equal(await page.locator('.trainer-a .active .art .energies').isVisible(), true);
      assert.equal(await page.locator('.trainer-a .active .art .hp').isVisible(), true);
      await send('action:settings', { action: 'update', display: { retreatCost: true } });
      await page.waitForFunction(() => document.querySelector('.trainer-a .active .retreat').offsetParent !== null);
    });

    it('does not draw anything over the picture when there is nothing to show', async () => {
      await send('action:trainerA', { action: 'clearSlot', slot: 0 });
      await send('action:trainerB', { action: 'setActive', cardId: 'b-1', name: 'Charizard', image: IMG, hp: 150 });
      await page.waitForSelector('.trainer-b .active .mon:not([hidden])');
      // no energy, no retreat cost, no abilities: the bands are empty and take no room
      const art = await box('.trainer-b .active .art');
      assert.equal(await page.locator('.trainer-b .active .art .energies').isVisible(), false);
      assert.equal(await page.locator('.trainer-b .active .art .retreat').isVisible(), false);
      assert.ok(art.height < 200);
      assert.deepEqual(page.problems, []);
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

      // the used one is grayed out, the ready one is in color
      const filters = await page.$$eval('.token.marker .marker-icon', (nodes) => nodes.map((node) => getComputedStyle(node).filter));
      assert.equal(filters.filter((filter) => filter.includes('grayscale')).length, 2);
      assert.equal(filters.filter((filter) => filter === 'none').length, 2, 'the two that are still ready');

      // a game is won: both trainers have both again
      await send('action:match', { action: 'trainerAMatchWin' });
      await page.waitForFunction(() => document.querySelectorAll('.token.marker.used').length === 0);
      assert.deepEqual(page.problems, []);
    });

    it('are the pictures of the GX attack and the VSTAR Power, which show their name only when a picture is missing', async () => {
      await send('action:settings', { action: 'update', display: { gxMarker: true, vstarMarker: true } });
      await page.waitForSelector('.trainer-a .token.marker .marker-icon');
      assert.deepEqual(await page.$$eval('.trainer-a .token.marker .marker-icon', (nodes) => nodes.map((node) => node.getAttribute('src'))), ['/assets/markers/gx', '/assets/markers/vstar']);
      await page.waitForFunction(() => [...document.querySelectorAll('.trainer-a .token.marker .marker-icon')].every((node) => node.complete && node.naturalWidth > 0));
      const box = await page.locator('.trainer-a .token.marker .marker-icon').first().boundingBox();
      assert.ok(box.height > 30 && box.height < 70, `a picture, not a pill: ${box.height}px`);
      assert.equal(await page.locator('.trainer-a .token.marker .token-label').first().isVisible(), false, 'the name is not written over it');
      assert.equal(await page.locator('.trainer-a .token.marker').first().evaluate((node) => node.classList.contains('no-icon')), false);

      // used: grayed out and fainter; ready again: in color
      await send('action:trainerA', { action: 'gxPlus' });
      await page.waitForSelector('.trainer-a .token.marker.used .marker-icon');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.trainer-a .token.marker.used .marker-icon')).filter === 'grayscale(1)'); // (it fades)
      const used = await page.$eval('.trainer-a .token.marker.used .marker-icon', (node) => ({ filter: getComputedStyle(node).filter, opacity: getComputedStyle(node).opacity }));
      assert.match(used.filter, /grayscale\(1\)/);
      assert.ok(Number(used.opacity) < 0.9);
      await send('action:settings', { action: 'update', display: { gxMarker: false, vstarMarker: false } });
      assert.deepEqual(page.problems, []);
    });

    it('is a pill with its name when there is no picture of it', async () => {
      const bare = await page.context().newPage();
      await bare.route('**/assets/markers/*', (route) => route.fulfill({ status: 204, body: '' }));
      await bare.goto(`${server.base}/overlay`);
      await send('action:settings', { action: 'update', display: { gxMarker: true, vstarMarker: true } });
      await bare.waitForSelector('.trainer-a .token.marker.no-icon');
      assert.equal(await bare.locator('.trainer-a .token.marker .token-label').first().isVisible(), true, 'the name shows');
      assert.equal(await bare.locator('.trainer-a .token.marker .marker-icon').first().isVisible(), false);
      await bare.close();
      await send('action:settings', { action: 'update', display: { gxMarker: false, vstarMarker: false } });
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

      // each is an icon (the pictures of the assets folder) on the picture of the card, at the top right, and its name is in its title
      const looks = await page.$$eval('.trainer-a .active .status-chip', (nodes) => nodes.map((node) => ({
        key: node.dataset.status, icon: node.querySelector('.status-icon').style.getPropertyValue('--icon'), title: node.title, onArt: Boolean(node.closest('.art')), label: getComputedStyle(node.querySelector('.status-label')).display
      })));
      assert.equal(new Set(looks.map((look) => look.icon)).size, 3, 'each condition has an icon of its own');
      assert.match(looks.find((look) => look.key === 'poisoned').icon, /\/assets\/status\/poison\.png/);
      assert.match(looks.find((look) => look.key === 'trapped').title, /Can't retreat/);
      assert.ok(looks.every((look) => look.onArt && look.label === 'none'), 'on the picture, with no room taken by their names');

      // a second Asleep-like condition takes the place of the first
      await send('action:trainerA', { action: 'toggleStatus', condition: 'paralyzed', enabled: true });
      await page.waitForFunction(() => document.querySelector('.trainer-a .active .status-chip[data-status="paralyzed"]'));
      assert.deepEqual(await chips(), ['Paralyzed', 'Poisoned', 'Trapped']);

      await send('action:trainerA', { action: 'clearStatus' });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .active .status-chip').length === 0);
      assert.deepEqual(page.problems, []);
    });

    it('draws a disc with a letter for a condition whose icon file is not there (the folder can be deleted), and a picture for the others', async () => {
      await send('action:trainerA', { action: 'toggleStatus', condition: 'confused', enabled: true });
      await send('action:trainerA', { action: 'toggleStatus', condition: 'burned', enabled: true });
      // a screen where the server has no picture for Confused: it answers "nothing here", as it does for an icon that is known but has no file
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const without = await context.newPage();
      await without.route('**/assets/status/confused.png', (route) => route.fulfill({ status: 204 }));
      try {
        await without.goto(`${server.base}/overlay`);
        await without.waitForSelector('.trainer-a .active .status-chip[data-status="confused"] .status-icon.no-icon');
        const disc = await without.locator('.trainer-a .active .status-chip[data-status="confused"] .status-icon').evaluate((node) => ({ glyph: node.dataset.glyph, image: getComputedStyle(node).backgroundImage, after: getComputedStyle(node, '::after').content, color: getComputedStyle(node).backgroundColor }));
        assert.equal(disc.glyph, '?');
        assert.equal(disc.image, 'none', 'no picture to show');
        assert.match(disc.after, /\?/, 'the letter is drawn on it');
        assert.notEqual(disc.color, 'rgba(0, 0, 0, 0)', 'a colored disc');
        assert.equal(await without.locator('.trainer-a .active .status-chip[data-status="burned"] .status-icon.no-icon').count(), 0, 'the others have their picture');
      } finally {
        await context.close();
      }
    });

    it('shows the picture of every condition when all six icons are there', async () => {
      // (Confused and Asleep do not go together: Burned does)
      for (const condition of ['confused', 'burned']) await send('action:trainerA', { action: 'toggleStatus', condition, enabled: true });
      await page.waitForSelector('.trainer-a .active .status-chip[data-status="confused"] .status-icon');
      await wait(400); // the icons are checked as the page opens
      assert.equal(await page.locator('.trainer-a .active .status-icon.no-icon').count(), 0, 'none is drawn as a disc');
      const image = await page.locator('.trainer-a .active .status-chip[data-status="confused"] .status-icon').evaluate((node) => getComputedStyle(node).backgroundImage);
      assert.match(image, /\/assets\/status\/confused\.png/);
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
      const WHOLE = { x: 0, y: 0, w: 1, h: 1 };
      const mon = (side, where) => page.$eval(`.trainer-${side} ${where} .art`, (art) => {
        const rect = art.getBoundingClientRect();
        const img = art.querySelector('img').getBoundingClientRect();
        return { w: rect.width, h: rect.height, imgW: img.width, imgH: img.height, left: img.left - rect.left, top: img.top - rect.top };
      });
      const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual} is not ${expected}`);
      const cropped = (variable, value) => page.waitForFunction(([name, wanted]) => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue(name) === wanted, [variable, value]);

      beforeEach(async () => {
        await send('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-2', name: 'Eevee', image: IMG, hp: 60 });
        await page.waitForSelector('.trainer-a .bench .mon:not([hidden])');
      });

      it('shows just the art of the card, for the Active Pokémon and the bench, until the design says otherwise', async () => {
        const active = await mon('a', '.active');
        near(active.w, 300, 'the width stays');
        near(active.h, 300 * 1.3933 * ART.h / ART.w, 'the height follows the part that is shown');
        near(active.imgW, 300 / ART.w, 'the picture is larger than the box, so only a part shows');
        near(active.imgH, active.h / ART.h, 'picture height');
        near(active.left, -300 * ART.x / ART.w, 'moved left to start at the art');
        near(active.top, -active.h * ART.y / ART.h, 'moved up to start at the art');
        const bench = await mon('a', '.bench');
        near(bench.w, 104, 'the bench is cropped the same way');
        near(bench.h, 104 * 1.3933 * ART.h / ART.w, 'bench height');
        near(bench.imgW, 104 / ART.w, 'bench picture width');
      });

      it('shows the whole card when the design asks for it', async () => {
        await wear({ name: 'Full Cards', crop: { active: WHOLE, bench: WHOLE } });
        await cropped('--ca-w', '1');
        const full = await mon('a', '.active');
        near(full.w, 300, 'width');
        near(full.h, 418, 'height');
        near(full.imgW, 300, 'picture width');
        near(full.imgH, 418, 'picture height');
        const bench = await mon('a', '.bench');
        near(bench.w, 104, 'bench width');
        near(bench.h, 145, 'bench height');
      });

      it('crops the bench on its own', async () => {
        await wear({ name: 'Bench', crop: { bench: { x: 0.2, y: 0.2, w: 0.6, h: 0.5 } } });
        await cropped('--cb-w', '0.6');
        const bench = await mon('a', '.bench');
        near(bench.w, 104, 'width');
        near(bench.h, 104 * 1.3933 * 0.5 / 0.6, 'height');
        near(bench.imgW, 104 / 0.6, 'picture width');
        near(bench.left, -104 * 0.2 / 0.6, 'left');
        const active = await mon('a', '.active');
        near(active.h, 300 * 1.3933 * ART.h / ART.w, 'the Active Pokémon keeps the art');
        assert.equal(await page.evaluate(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--ca-w')), '', 'and is not given numbers of its own');
      });

      it('goes back to the art when the design on air is taken away', async () => {
        await wear({ name: 'Full Again', crop: { active: WHOLE } });
        await cropped('--ca-w', '1');
        near((await mon('a', '.active')).h, 418, 'whole card');
        await page.evaluate(() => fetch('/api/theme/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) }));
        await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--ca-w') === '');
        near((await mon('a', '.active')).h, 300 * 1.3933 * ART.h / ART.w, 'the art again');
      });

      it('shows exactly the part of the card picture that is chosen, and the artwork window by default', async () => {
        // a card whose art window is green and everything else blue, so the crop can be checked by color
        const card = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="418"><rect width="300" height="418" fill="#2030d0"/><rect x="21" y="48.07" width="258" height="160.93" fill="#20d040"/></svg>';
        await page.route('**/art/flat.svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: card }));
        await send('action:trainerA', { action: 'setActive', cardId: 'a-9', name: 'Flat', image: '/art/flat.svg', hp: 60 });
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

    describe('with a tile', () => {
      beforeEach(async () => {
        await send('action:trainerA', { action: 'setRetreat', slot: -1, cost: 2 });
        await send('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-2', name: 'Eevee', image: IMG, hp: 60, retreat: 1 });
        await page.waitForSelector('.trainer-a .bench .mon:not([hidden])');
      });
      const parentOf = (selector) => page.$eval(selector, (node) => node.parentElement.className);

      it('puts every part under the picture when the design says so, as it used to be', async () => {
        await wear({ name: 'Below', tile: { active: { hp: 'below', energy: 'below', retreat: 'below', status: 'below' } }, crop: { active: { x: 0, y: 0, w: 1, h: 1 } } });
        await page.waitForSelector('.trainer-a .active .details .hp');
        assert.equal(await page.locator('.trainer-a .active .art .hp').count(), 0);
        assert.equal(await page.locator('.trainer-a .active .art .energies').count(), 0);
        assert.equal(await page.locator('.trainer-a .active .art .retreat').count(), 0);
        assert.equal(await page.locator('.trainer-a .active .art .statuses').count(), 0);
        // in their old order: the name, the HP, the energy, the retreat cost, the abilities (and the attacks of a benched Pokémon, which are not shown here)
        assert.deepEqual(await page.$$eval('.trainer-a .active .details > *', (nodes) => nodes.map((node) => node.className.split(' ')[0])), ['mon-name', 'hp', 'energies', 'retreat', 'abilities', 'tool-cards', 'tools', 'attacks', 'statuses']);
        const hp = await page.$eval('.trainer-a .active .details .hp-text', (node) => ({ position: getComputedStyle(node).position, margin: getComputedStyle(node).marginTop }));
        assert.equal(hp.position, 'static', 'the numbers are under the bar again');
        const art = await page.$eval('.trainer-a .active .art', (node) => node.getBoundingClientRect().height);
        assert.ok(Math.abs(art - 418) < 0.1, 'the whole card, as the design asked');
        const bench = await page.$$eval('.trainer-a .bench .mon.mini:not([hidden]) .art .hp', (nodes) => nodes.length);
        assert.equal(bench, 1, 'the bench keeps the usual tile');
      });

      it('puts parts in the corner and the edge of the picture that the design chooses', async () => {
        await wear({ name: 'Corners', tile: { active: { hp: 'bottom', energy: 'top-right', retreat: 'top-left' } } });
        await page.waitForSelector('.trainer-a .active .band-bottom .band-bar .hp');
        assert.equal(await parentOf('.trainer-a .active .art .energies'), 'corner corner-right');
        assert.equal(await parentOf('.trainer-a .active .art .retreat'), 'corner corner-left');
        const art = await page.$eval('.trainer-a .active .art', (node) => node.getBoundingClientRect().toJSON());
        const bar = await page.$eval('.trainer-a .active .art .hp', (node) => node.getBoundingClientRect().toJSON());
        const energies = await page.$eval('.trainer-a .active .art .energies', (node) => node.getBoundingClientRect().toJSON());
        const retreat = await page.$eval('.trainer-a .active .art .retreat', (node) => node.getBoundingClientRect().toJSON());
        assert.ok(art.bottom - bar.bottom < 14, 'the HP bar is at the bottom');
        assert.ok(energies.top - art.top < 14 && art.right - energies.right < 14, 'the energy is at the top right');
        assert.ok(retreat.top - art.top < 14 && retreat.left - art.left < 14, 'the retreat cost is at the top left');
      });

      it('stacks two parts that share a corner, one under the other', async () => {
        await wear({ name: 'Together', tile: { active: { retreat: 'bottom-left' } } });
        await page.waitForSelector('.trainer-a .active .corner-left .retreat');
        const energies = await page.$eval('.trainer-a .active .art .energies', (node) => node.getBoundingClientRect().toJSON());
        const retreat = await page.$eval('.trainer-a .active .art .retreat', (node) => node.getBoundingClientRect().toJSON());
        assert.ok(retreat.top >= energies.bottom - 1 || energies.top >= retreat.bottom - 1, 'they do not cover each other');
      });

      it('does the bench on its own, and goes back to the usual places when the design is taken away', async () => {
        await wear({ name: 'Bench Tile', tile: { bench: { hp: 'bottom', energy: 'below' } } });
        await page.waitForSelector('.trainer-a .bench .band-bottom .band-bar .hp');
        assert.equal(await page.locator('.trainer-a .active .band-top .band-bar .hp').count(), 1, 'the Active Pokémon is as before');
        assert.equal(await page.locator('.trainer-a .bench .mon.mini:not([hidden]) .details .energies').count(), 1, 'the bench energy is below');

        await page.evaluate(() => fetch('/api/theme/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) }));
        await page.waitForSelector('.trainer-a .bench .band-top .band-bar .hp');
        assert.equal(await page.locator('.trainer-a .bench .mon.mini:not([hidden]) .art .energies').count(), 1, 'back on the picture');
      });

      it('ignores a place it does not know, whatever a hand-written design says', async () => {
        await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, sounds: [], tile: { active: { hp: 'sideways', energy: 'below' }, bench: 'nope' } }));
        await page.waitForSelector('.trainer-a .active .details .energies');
        assert.equal(await page.locator('.trainer-a .active .band-top .band-bar .hp').count(), 1, 'the HP bar stays where it usually is');
        assert.deepEqual(page.problems, []);
      });
    });

    describe('with a layout for the prize cards', () => {
      const spots = (side = 'a') => page.$$eval(`.trainer-${side} .prize`, (nodes) => nodes.map((node) => ({ left: node.offsetLeft, top: node.offsetTop }))); // (where they are laid out: the ones that are taken are drawn a little smaller)
      const rootLayout = () => page.evaluate(() => [...document.documentElement.classList].filter((name) => name.startsWith('prize-layout-')));
      const distinct = (list, key) => [...new Set(list.map((spot) => spot[key]))].length;

      it('is a row of six unless the design says otherwise', async () => {
        const row = await spots();
        assert.equal(row.length, 6);
        assert.equal(distinct(row, 'top'), 1, 'side by side');
        assert.equal(distinct(row, 'left'), 6);
        assert.deepEqual(await rootLayout(), []);
      });

      for (const [layout, columns, rows] of [['column', 1, 6], ['two-rows', 3, 2], ['three-rows', 2, 3]]) {
        it(`puts them in ${rows} row${rows === 1 ? '' : 's'} of ${columns} when the design says "${layout}", for both trainers`, async () => {
          await wear({ name: `Layout ${layout}`, prizeLayout: layout });
          await page.waitForFunction((name) => document.documentElement.classList.contains(`prize-layout-${name}`), layout);
          for (const side of ['a', 'b']) {
            const spot = await spots(side);
            assert.equal(distinct(spot, 'left'), columns, `${side}: ${columns} across`);
            assert.equal(distinct(spot, 'top'), rows, `${side}: ${rows} down`);
          }
          assert.deepEqual(await rootLayout(), [`prize-layout-${layout}`], 'one at a time');
          assert.deepEqual(page.problems, []);
        });
      }

      it('keeps the taken ones, the penalty and the cards in the same places, and goes back to a row when the design is taken away', async () => {
        await send('action:trainerA', { action: 'prizeSet', count: 4 });
        await send('action:trainerB', { action: 'prizePenaltySet', count: 1 });
        await wear({ name: 'Two rows', prizeLayout: 'two-rows' });
        await page.waitForFunction(() => document.documentElement.classList.contains('prize-layout-two-rows'));
        const flags = await page.$$eval('.trainer-a .prize', (nodes) => nodes.map((node) => [node.classList.contains('taken'), node.classList.contains('penalty')]));
        assert.deepEqual(flags, [[false, true], [false, false], [false, false], [false, false], [true, false], [true, false]], 'in order: the last ones are taken');
        assert.ok(await page.$eval('.trainer-a .prize-flag', (node) => node.getBoundingClientRect().width > 0), 'with the penalty tag');

        await page.evaluate(() => fetch('/api/theme/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) }));
        await page.waitForFunction(() => !document.documentElement.classList.contains('prize-layout-two-rows'));
        assert.equal(distinct(await spots(), 'top'), 1);
      });

      it('ignores a layout it does not know, whatever a hand-written design says', async () => {
        await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, sounds: [], prizeLayout: 'diagonal' }));
        assert.deepEqual(await rootLayout(), []);
        await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, sounds: [], prizeLayout: 'column' }));
        assert.deepEqual(await rootLayout(), ['prize-layout-column']);
        await page.evaluate(() => window.oto.applyTheme({ name: 'y', colors: {}, images: {}, sounds: [] }));
        assert.deepEqual(await rootLayout(), [], 'one design after another does not leave the last one behind');
        assert.deepEqual(page.problems, []);
      });
    });

    describe('with a crop for the cards on the prize cards', () => {
      const card = (name) => ({ cardId: `t-${name}`, name, image: `/art/${name}.svg` });
      const size = () => page.$eval('.trainer-a .prize', (node) => { const box = node.getBoundingClientRect(); return [Math.round(box.width * 100) / 100, Math.round(box.height * 100) / 100]; });
      const face = () => page.$eval('.trainer-a .prize', (node) => { const style = getComputedStyle(node, '::after'); return { size: style.backgroundSize, position: style.backgroundPosition }; });
      const px = (text) => text.split(' ').map(parseFloat);

      beforeEach(async () => {
        await send('action:trainerA', { action: 'togglePrizeHidden', enabled: false });
        await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('one')] });
        await page.waitForSelector('.trainer-a .prize.has-face');
      });

      it('shows the whole card, on a prize card of the usual size, unless the design says otherwise', async () => {
        assert.deepEqual(await size(), [40, 56]);
        const shown = await face();
        assert.ok(Math.abs(px(shown.size)[0] - 38) < 0.01, shown.size);
        assert.deepEqual(px(shown.position), [-0, -0].map(Math.abs), shown.position);
      });

      it('shows just the part of the card the design chooses, and the prize card takes the shape of it', async () => {
        await wear({ name: 'Art prizes', crop: { prize: { x: 0.07, y: 0.115, w: 0.86, h: 0.385 } } });
        await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--cp-w') === '0.86');
        const [width, height] = await size();
        assert.equal(width, 40);
        assert.ok(Math.abs(height - (56 * 0.385) / 0.86) < 0.1, `as tall as the part that shows: ${height}`);
        const shown = await face();
        assert.ok(Math.abs(px(shown.size)[0] - 38 / 0.86) < 0.05, `the picture is larger than the box: ${shown.size}`);
        assert.ok(Math.abs(px(shown.position)[0] - (-38 * 0.07) / 0.86) < 0.05 && Math.abs(px(shown.position)[1] - (-53.2 * 0.115) / 0.86) < 0.05, `and moved to the part: ${shown.position}`);
        // the back of the prize cards, the other trainer's included, is as big as the part too
        assert.ok(Math.abs((await page.$eval('.trainer-b .prize', (node) => node.getBoundingClientRect().height)) - height) < 0.1);
        await page.evaluate(() => fetch('/api/theme/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) }));
        await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--cp-w') === '');
        assert.deepEqual(await size(), [40, 56]);
      });

      it('shows exactly the part of the card picture that is chosen', async () => {
        // a card whose art window is green and everything else blue: the prize card, cropped to the art window, shows only green
        const flat = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="418"><rect width="300" height="418" fill="#2030d0"/><rect x="21" y="48.07" width="258" height="160.93" fill="#20d040"/></svg>';
        await page.route('**/art/flat-prize.svg', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: flat }));
        await send('action:trainerA', { action: 'prizeCardsSet', cards: [card('flat-prize')] });
        await wear({ name: 'Art prizes', crop: { prize: { x: 0.07, y: 0.115, w: 0.86, h: 0.385 } } });
        await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--cp-w') === '0.86');
        await wait(500);
        const shot = await page.locator('.trainer-a .prize').first().screenshot();
        // the picture is a PNG: read its middle pixel and a pixel near each corner inside the border, in the page
        const colors = await page.evaluate(async (base64) => {
          const image = new Image();
          await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = `data:image/png;base64,${base64}`; });
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          const at = (fx, fy) => Array.from(context.getImageData(Math.floor(canvas.width * fx), Math.floor(canvas.height * fy), 1, 1).data).slice(0, 3).join(',');
          return [at(0.5, 0.5), at(0.2, 0.3), at(0.8, 0.3), at(0.2, 0.7), at(0.8, 0.7)];
        }, shot.toString('base64'));
        assert.deepEqual([...new Set(colors)], ['32,208,64'], `only the art window shows: ${colors.join(' | ')}`);
      });
    });

    describe('with a picture on the prize cards', () => {
      const backs = (side = 'a') => page.$$eval(`.trainer-${side} .prize`, (nodes) => nodes.map((node) => ({ taken: node.classList.contains('taken'), image: getComputedStyle(node).backgroundImage, size: getComputedStyle(node).backgroundSize })));
      const rootClass = () => page.evaluate(() => [...document.documentElement.classList].filter((name) => name.startsWith('prize-')));
      // what is painted on the first prize card of the other trainer that is still there, as a picture (so two looks can be told apart)
      const paint = async () => { await wait(450); return page.locator('.trainer-b .prize:not(.taken)').first().screenshot(); };
      // the pictures the stylesheet asks for as the back of a prize card: the file of the assets folder, then the drawing under it
      const layers = () => page.$eval('.trainer-b .prize', (node) => [...getComputedStyle(node).backgroundImage.matchAll(/url\("([^"]+)"\)/g)].map((found) => found[1]));
      // how wide a picture is once it has loaded (0 when it does not load)
      const loadedWidth = (url) => page.evaluate((src) => new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth);
        image.onerror = () => resolve(0);
        image.src = src;
      }), url);
      const styled = (style) => page.waitForFunction((name) => document.documentElement.classList.contains(`prize-${name}`), style);
      // whether the assets folder has the card back (the maintainer adds them): 200 when it does, 204 when it does not
      const fileStatus = (style) => page.evaluate((name) => fetch(`/assets/cardbacks/${name}`).then((response) => response.status), style);

      beforeEach(async () => {
        await send('action:trainerA', { action: 'prizeSet', count: 4 });
        await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.taken').length === 2);
      });

      it('shows the English card back, unless the design has a card back of its own or asks for another', async () => {
        assert.deepEqual(await rootClass(), ['prize-english'], 'with no design');
        const usual = await backs();
        assert.equal(usual.length, 6);
        assert.ok(usual.every((prize) => prize.image.includes('/assets/cardbacks/english')), 'the English card back is asked for');
        await wear({ name: 'Plain Prizes', colors: { '--accent': '#336699' } });
        await page.waitForFunction(() => document.getElementById('oto-design-vars').sheet.cssRules[0].style.getPropertyValue('--accent') === '#336699');
        assert.deepEqual(await rootClass(), ['prize-english'], 'a design that says nothing');

        // a design with a prize card back picture of its own: that one
        await page.evaluate(() => window.oto.applyTheme({ name: 'own', colors: {}, images: { prizeCardBack: '/art/own-back.svg' }, sounds: [] }));
        assert.deepEqual(await rootClass(), []);
        assert.ok((await backs()).every((prize) => prize.image.includes('/art/own-back.svg') && !prize.image.includes('cardbacks')), 'its own picture');
        await page.evaluate(() => window.oto.applyTheme({ name: 'own', colors: {}, images: { cardBackImage: '/art/own-back.svg' }, sounds: [] }));
        assert.deepEqual(await rootClass(), [], 'the card back picture of a design is its own too');
        // and when the design asks for another, that one
        await page.evaluate(() => window.oto.applyTheme({ name: 'own', colors: {}, images: { prizeCardBack: '/art/own-back.svg' }, sounds: [], prizeStyle: 'japanese' }));
        assert.deepEqual(await rootClass(), ['prize-japanese']);
        await page.evaluate(() => window.oto.applyTheme({ name: 'own', colors: {}, images: { prizeCardBack: '/art/own-back.svg' }, sounds: [], prizeStyle: 'current' }));
        assert.deepEqual(await rootClass(), [], 'or says "the design\'s own"');
        await page.evaluate(() => window.oto.applyTheme({ name: 'none', colors: {}, images: {}, sounds: [], prizeStyle: 'current' }));
        assert.deepEqual(await rootClass(), ['prize-english'], 'which is the English one when it has none');
      });

      for (const style of ['english', 'japanese', 'pokeball']) {
        it(`prints the ${style} one on every prize card, the taken ones too (they only go gray)`, async () => {
          await wear({ name: `Prizes ${style}`, prizeStyle: style });
          await styled(style);
          assert.deepEqual(await rootClass(), [`prize-${style}`]);

          const all = [...await backs('a'), ...await backs('b')];
          assert.equal(all.length, 12);
          for (const prize of all) {
            assert.match(prize.image, new RegExp(`^url\\("[^"]*/assets/cardbacks/${style}"\\), url\\("data:image/svg\\+xml`), `the picture of the assets folder first, a drawing under it: ${prize.image.slice(0, 120)}`);
            assert.equal(prize.size, 'cover, cover');
          }
          const mine = await backs('a');
          assert.deepEqual(mine.map((prize) => prize.taken), [false, false, false, false, true, true]);
          // they fade over 0.4 s when they are taken: wait for the end of it
          await page.waitForFunction(() => { const taken = getComputedStyle(document.querySelector('.trainer-a .prize.taken')); return taken.filter === 'grayscale(1)' && Number(taken.opacity) < 0.3; });
          assert.equal(await page.$eval('.trainer-a .prize.taken', (node) => getComputedStyle(node).filter), 'grayscale(1)');
          assert.ok(Number(await page.$eval('.trainer-a .prize.taken', (node) => getComputedStyle(node).opacity)) < 0.3, 'and faded');
          assert.deepEqual(page.problems, []);
        });
      }

      it('shows the card back that is in the assets folder (the file the maintainer added), and the drawing of its own for one that is not', async () => {
        for (const style of ['english', 'japanese', 'pokeball']) {
          await wear({ name: `Files ${style}`, prizeStyle: style });
          await styled(style);
          const [file, drawing] = await layers();
          const status = await fileStatus(style);
          assert.ok([200, 204].includes(status), `${style}: the file is there or it is not (${status})`);
          assert.equal(await loadedWidth(file) > 0, status === 200, `${style}: the picture loads when the file is there`);
          assert.ok(await loadedWidth(drawing) > 0, `${style}: the drawing under it always loads`);
        }
        assert.deepEqual(page.problems, [], 'a card back that is not there is no error');
      });

      it('draws a card back of its own for each when the file is not there, three different ones, without an error anywhere', async () => {
        // as if the assets folder had none of them (the real folder may)
        await page.route('**/assets/cardbacks/*', (route) => route.fulfill({ status: 204 }));
        const looks = {};
        for (const style of ['english', 'japanese', 'pokeball']) {
          await wear({ name: `Drawn ${style}`, prizeStyle: style });
          await styled(style);
          looks[style] = await paint();
        }
        assert.ok(!looks.english.equals(looks.japanese) && !looks.english.equals(looks.pokeball) && !looks.japanese.equals(looks.pokeball), 'a blue one, a red one and a ball');

        await page.evaluate(() => fetch('/api/theme/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) }));
        await page.waitForFunction(() => [...document.documentElement.classList].filter((name) => name.startsWith('prize-')).join() === 'prize-english');
        const usual = await paint();
        assert.ok(usual.equals(looks.english), 'with no design it is the English one');
        for (const style of ['japanese', 'pokeball']) assert.ok(!usual.equals(looks[style]), `and not the ${style} one`);
        assert.deepEqual(page.problems, []);
      });

      it('paints the file over the drawing when the file is there', async () => {
        const status = await fileStatus('english');
        if (status !== 200) return; // nothing to compare with: there is no English card back in the assets folder
        // this page is told there is no file; another one, that opens afterwards, gets it (a page keeps what it learned of a picture, so a file
        // that is added is there for the pages opened after that, which is what refreshing the overlay in OBS does)
        await page.route('**/assets/cardbacks/english', (route) => route.fulfill({ status: 204 }));
        await page.reload(); // (the English card back is the usual one: this page has the file already, until it is loaded again)
        await page.waitForSelector('.trainer-b .prize');
        await wear({ name: 'Drawn English', prizeStyle: 'english' });
        await styled('english');
        const drawn = await paint();

        const second = await openPage(browser, `${server.base}/overlay`);
        try {
          await second.waitForFunction(() => document.documentElement.classList.contains('prize-english'));
          await second.waitForFunction(() => { const prize = document.querySelector('.trainer-b .prize:not(.taken)'); return prize && prize.getBoundingClientRect().width > 0; });
          await wait(450);
          const file = await second.locator('.trainer-b .prize:not(.taken)').first().screenshot();
          assert.ok(!file.equals(drawn), 'the picture of the file, not the drawing');
          assert.deepEqual(second.problems, []);
        } finally {
          await second.context().close();
        }
        assert.deepEqual(page.problems, []);
      });

      it('shows a different drawing for each, and goes back to the usual look when the design is taken away', async () => {
        const seen = {};
        for (const style of ['english', 'japanese', 'pokeball']) {
          await wear({ name: `Look ${style}`, prizeStyle: style });
          await styled(style);
          seen[style] = (await backs('b'))[0].image.split('), url(').pop();
        }
        assert.equal(new Set(Object.values(seen)).size, 3, 'three different drawings');

        await page.evaluate(() => fetch('/api/theme/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) }));
        await page.waitForFunction(() => [...document.documentElement.classList].filter((name) => name.startsWith('prize-')).join() === 'prize-english');
        assert.ok((await backs('b')).every((prize) => prize.image.includes('/assets/cardbacks/english')), 'the English card back again');
      });

      it('keeps the red mask of a penalty and the question mark of hidden prizes on top of the picture', async () => {
        await wear({ name: 'Marked', prizeStyle: 'japanese' });
        await styled('japanese');
        await send('action:trainerB', { action: 'prizePenaltySet', count: 2 });
        await page.waitForFunction(() => document.querySelectorAll('.trainer-a .prize.penalty').length === 2);
        const mask = await page.$eval('.trainer-a .prize.penalty', (node) => getComputedStyle(node, '::before').backgroundColor);
        assert.notEqual(mask, 'rgba(0, 0, 0, 0)', 'the red mask is still drawn');
        await send('action:trainerA', { action: 'togglePrizeHidden', enabled: true });
        await page.waitForFunction(() => document.querySelector('.trainer-a .prizes.is-hidden'));
        assert.equal(await page.$eval('.trainer-a .prize', (node) => getComputedStyle(node, '::after').content), 'none');
      });

      it('ignores a picture it does not know, whatever a hand-written design says', async () => {
        await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, sounds: [], prizeStyle: 'spanish' }));
        await wait(100);
        assert.deepEqual(await rootClass(), ['prize-english'], 'the English one, as when a design says nothing');
        await page.evaluate(() => window.oto.applyTheme({ name: 'x', colors: {}, images: {}, sounds: [], prizeStyle: 'pokeball' }));
        assert.deepEqual(await rootClass(), ['prize-pokeball']);
        await page.evaluate(() => window.oto.applyTheme({ name: 'y', colors: {}, images: {}, sounds: [], prizeStyle: 'current' }));
        assert.deepEqual(await rootClass(), ['prize-english'], 'and one design after another does not leave the last one behind');
        assert.deepEqual(page.problems, []);
      });
    });
  });

  // A design can bring a style sheet of its own (checked by the server or the editor before it is sent): it is put in the page as it comes
  describe('the style sheet of a design', () => {
    const sheet = () => page.evaluate(() => {
      const node = document.getElementById('oto-design-css');
      return { text: node.textContent, count: document.querySelectorAll('#oto-design-css').length, last: document.head.lastElementChild === node, tag: node.tagName };
    });
    const spacing = () => page.$eval('.sb-a .sb-name', (node) => getComputedStyle(node).letterSpacing);
    const wear = (css, extra = {}) => page.evaluate(([text, more]) => window.oto.applyTheme({ name: 'Styled', colors: {}, images: {}, css: text, ...more }), [css, extra]);

    it('is put in the page after the built-in style sheets, and taken away with the design', async () => {
      const plain = await spacing();
      assert.deepEqual(await sheet(), { text: '', count: 1, last: true, tag: 'STYLE' }, 'there is none without a design');
      await wear('#stage .sb-name{letter-spacing:7px}');
      assert.deepEqual(await sheet(), { text: '#stage .sb-name{letter-spacing:7px}', count: 1, last: true, tag: 'STYLE' });
      assert.equal(await spacing(), '7px');

      // another design, without one
      await page.evaluate(() => window.oto.applyTheme({ name: 'Plain', colors: {}, images: {} }));
      assert.equal((await sheet()).text, '');
      assert.equal(await spacing(), plain);
      // no design at all
      await wear('#stage .sb-name{letter-spacing:3px}');
      assert.equal(await spacing(), '3px');
      await page.evaluate(() => window.oto.applyTheme(null));
      assert.deepEqual(await sheet(), { text: '', count: 1, last: true, tag: 'STYLE' });
      assert.equal(await spacing(), plain);
      assert.deepEqual(page.problems, []);
    });

    it('is written again only when it changed, so what it animates does not start over at every change of the design', async () => {
      await wear('#stage .sb-name{animation:oto-glow 6s linear infinite}@keyframes oto-glow{to{opacity:.4}}');
      await page.evaluate(() => {
        window.sheetWrites = 0;
        new MutationObserver((changes) => { window.sheetWrites += changes.length; })
          .observe(document.getElementById('oto-design-css'), { childList: true, characterData: true, subtree: true });
      });
      const glow = () => page.evaluate(() => document.getAnimations().filter((animation) => animation.animationName === 'oto-glow').map((animation) => animation.currentTime));
      await wait(400);
      const before = await glow();
      assert.equal(before.length, 2, 'it runs on both names');
      // (the design editor sends the design again at every step of a drag)
      for (let y = 10; y <= 30; y += 10) {
        await wear('#stage .sb-name{animation:oto-glow 6s linear infinite}@keyframes oto-glow{to{opacity:.4}}', { layout: { scoreboard: { x: 0, y, scale: 1 } } });
      }
      await page.waitForSelector('.scoreboard.moved');
      const after = await glow();
      assert.equal(await page.evaluate(() => window.sheetWrites), 0, 'not written again');
      assert.ok(after[0] > before[0], `the animation went on (${before[0]} ms, then ${after[0]} ms)`);

      await wear('#stage .sb-name{animation:oto-glow 6s linear infinite}@keyframes oto-glow{to{opacity:.2}}');
      assert.ok(await page.evaluate(() => window.sheetWrites) > 0, 'a change is written');
      await page.evaluate(() => window.oto.applyTheme(null));
    });

    it('comes after the design\'s own colors and pictures, so a rule for :root changes them', async () => {
      const looks = () => page.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), getComputedStyle(document.querySelector('.scoreboard')).outlineColor,
        getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim()]);
      const colors = { '--accent': '#ff0000', '--bg-panel': '#123456' };
      await wear(':root { --accent: #ff00aa; }\n.scoreboard { outline: 4px solid var(--accent); }', { colors });
      assert.deepEqual(await looks(), ['#ff00aa', 'rgb(255, 0, 170)', '#123456'], 'what the style sheet names is its own, the rest stays the design\'s');
      await wear(':root.has-logo, :root { --accent: #00ff00; }\n.scoreboard { outline: 4px solid var(--accent); }', { colors });
      assert.deepEqual(await looks(), ['#00ff00', 'rgb(0, 255, 0)', '#123456']);
      await wear('.scoreboard { outline: 4px solid var(--accent); }', { colors });
      assert.deepEqual(await looks(), ['#ff0000', 'rgb(255, 0, 0)', '#123456'], 'without such a rule, the design\'s colors');
      // (a value stays a value: it cannot end its rule and start another one)
      await page.evaluate(() => window.oto.applyTheme({ name: 'Odd', colors: { '--accent': 'red}body{background:#000' }, images: {} }));
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
      await page.evaluate(() => window.oto.applyTheme(null));
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim() !== '#123456'), true, 'and they go with the design');
      assert.deepEqual(page.problems, []);
    });

    // OBS needs the page around the stage see-through: it is there whenever the browser source is not the shape of the stage. Designs
    // saved and put on air the way a producer does (each checked by the server), on a square page, with the stage across its middle.
    it('cannot paint the page around the stage, whatever it does to the stage and what is in it', async () => {
      const api = async (method, route, body) => {
        const response = await fetch(`${server.base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 200, `${method} ${route}: ${await response.text()}`);
      };
      const OUTSIDE = [[500, 20], [500, 980], [5, 5], [995, 995], [500, 205], [500, 795]];
      const square = await openPage(browser, `${server.base}/overlay`, { viewport: { width: 1000, height: 1000 } });
      // what a screenshot with a see-through background shows at these points: 0 is see-through, 255 opaque
      const alphaAt = async (points) => {
        const shot = (await square.screenshot({ omitBackground: true })).toString('base64');
        const probe = await square.context().newPage();
        try {
          return await probe.evaluate(async ([data, where]) => {
            const picture = new Image();
            picture.src = `data:image/png;base64,${data}`;
            await picture.decode();
            const canvas = document.createElement('canvas');
            canvas.width = picture.width;
            canvas.height = picture.height;
            const context = canvas.getContext('2d');
            context.drawImage(picture, 0, 0);
            return where.map(([x, y]) => context.getImageData(x, y, 1, 1).data[3]);
          }, [shot, points]);
        } finally {
          await probe.close();
        }
      };
      const designs = [
        ['a shadow of the stage', '#stage { box-shadow: 0 0 0 100vmax #000; }'],
        ['an outline of the stage', '#stage { outline: 2000px solid #000; }'],
        ['a pseudo-element of the stage', '#stage::before { content: ""; position: absolute; inset: -3000px; background: #000; }'],
        ['a piece bigger than the stage', '.backdrop { inset: -3000px; background: #000; }'],
        ['the shadow of a piece', '.spaces { box-shadow: 0 0 0 5000px #000; }'],
        ['filters', '#stage { filter: drop-shadow(0 -900px 0 #000) drop-shadow(0 900px 0 #000); background: #000; }'],
        ['the stage scaled', '#stage { scale: 4; background: #000; }'],
        ['the stage moved', '#stage { left: -300px; top: -300px; } .backdrop { background: #000; }'],
        ['the stage zoomed', '#stage { zoom: 3; background: #000; }'],
        ['another origin', '#stage { transform-origin: 50% 50%; background: #000; }'],
        ['an animation of the stage', '#stage { background: #000; animation: big .1s forwards; } @keyframes big { to { transform: translate(0px, 0px) scale(4); } }'],
        ['a fixed piece, with the scaling of the stage taken away', '.spaces { position: fixed; inset: -3000px; background: #000; } #stage { animation: flat .1s forwards; } @keyframes flat { to { transform: none; } }']
      ];
      try {
        await square.waitForSelector('.trainer-a .active .mon:not([hidden])');
        const tile = await square.$eval('.trainer-a .active .mon .art', (node) => { const rect = node.getBoundingClientRect(); return [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)]; });
        assert.deepEqual(await alphaAt([...OUTSIDE, tile]), [0, 0, 0, 0, 0, 0, 255], 'without a design: see-through around the stage, the Active Pokémon in it');
        for (const [name, css] of designs) {
          await api('PUT', `/api/themes/${encodeURIComponent(`Opaque ${name}`)}`, { colors: {}, css });
          await api('POST', '/api/theme/active', { name: `Opaque ${name}` });
          await square.waitForFunction((wanted) => document.getElementById('oto-design-css').textContent.includes(wanted), css.includes('backdrop') ? '.backdrop' : '#stage');
          await square.waitForFunction((text) => document.getElementById('oto-design-css').textContent === text, (await (await fetch(`${server.base}/api/theme`)).json()).theme.css);
          await wait(250); // (the animations are over)
          assert.deepEqual(await alphaAt(OUTSIDE), OUTSIDE.map(() => 0), name);
        }
        // the colors of a design, the older way: a shadow with another one behind it
        await api('PUT', '/api/themes/Opaque%20colors', { colors: { '--shadow': 'rgba(0,0,0,.5), 0 0 0 4000px #f80' } });
        await api('POST', '/api/theme/active', { name: 'Opaque colors' });
        await square.waitForFunction(() => document.documentElement.textContent !== null && getComputedStyle(document.documentElement).getPropertyValue('--shadow').includes('4000px'));
        await wait(100);
        assert.deepEqual(await alphaAt(OUTSIDE), OUTSIDE.map(() => 0), 'a shadow in the colors');
        // and what a design paints inside the stage is there
        await api('PUT', '/api/themes/Opaque%20inside', { colors: {}, css: '.backdrop { background: #000; }' });
        await api('POST', '/api/theme/active', { name: 'Opaque inside' });
        await square.waitForFunction(() => document.getElementById('oto-design-css').textContent.includes('backdrop'));
        await wait(100);
        assert.deepEqual(await alphaAt([[500, 20], [500, 230], [500, 770], [10, 500], [990, 500]]), [0, 255, 255, 255, 255]);
        assert.deepEqual(square.problems, []);
      } finally {
        await api('POST', '/api/theme/active', { name: null });
        await square.context().close();
      }
    });

    // (the check of a style sheet refuses allow-discrete: this is what the overlay does about one that would get here all the same)
    it('cannot keep a piece the producer switched off on the stage with a transition of display, which beats !important', async () => {
      const pieces = ['.scoreboard', '.trainer-a .active', '.trainer-a .prizes'];
      const shown = () => page.evaluate((selectors) => selectors.map((selector) => getComputedStyle(document.querySelector(selector)).display), pieces);
      await wear(`${pieces.map((selector) => `#stage ${selector}`).join(',')}{transition:display 100000s step-end allow-discrete}`);
      assert.ok((await shown()).every((display) => display !== 'none'), 'they are there to begin with');
      try {
        await send('action:settings', { action: 'update', display: { scoreboard: false, activePokemon: false, prizes: false } });
        await page.waitForFunction(() => document.querySelector('.scoreboard').classList.contains('opt-off'));
        await wait(200);
        assert.deepEqual(await shown(), ['none', 'none', 'none'], 'switched off at once');
        // and still, after the next change of the game
        await send('action:trainerA', { action: 'activeDamage', amount: 10 });
        await page.waitForFunction(() => document.querySelector('.trainer-a .active .hp-text').textContent === '90/100');
        await wait(200);
        assert.deepEqual(await shown(), ['none', 'none', 'none']);
        assert.equal(await page.evaluate(() => document.querySelector('.scoreboard').checkVisibility()), false);
      } finally {
        await send('action:settings', { action: 'update', display: { scoreboard: true, activePokemon: true, prizes: true } });
        await page.evaluate(() => window.oto.applyTheme(null));
      }
    });
  });

  // What happens in the game is marked for a while on the piece it happened to ("moments": classes a design's style sheet can animate), and
  // on the stage with its kind and side
  describe('moments', () => {
    const MS = 700; // (how long they last, as the design says)
    const wear = (css = '') => page.evaluate((text) => window.oto.applyTheme({ name: 'Moments', colors: {}, images: {}, css: text }), `:root{--oto-moment-ms:${MS}}${css}`);
    beforeEach(async () => {
      await page.evaluate(() => window.oto.loadTheme()); // (the page has asked for the design on air: that answer is in before this design is put on)
      await wear();
      await recordMoments(page);
    });
    const played = (selector, name, extra) => playedOn(page, selector, name, extra);
    const there = (selector) => playedThere(page, selector);
    const forget = () => page.evaluate(() => { window.played = []; });
    const nothing = async () => assert.deepEqual(await page.evaluate(() => window.played.map((entry) => entry.name)), []);
    const over = () => page.waitForSelector('[class*="moment-"]', { state: 'detached', timeout: MS * 6 });
    // How long something is on the stage, as the page sees it: `watch` before what makes it happen, then `lasted` answers once it is gone
    const watch = (selector) => page.evaluate((wanted) => {
      window.lasted = new Promise((resolve) => {
        let from = null;
        const observer = new MutationObserver(() => {
          const shown = Boolean(document.querySelector(wanted));
          if (shown && from === null) from = performance.now();
          if (!shown && from !== null) {
            observer.disconnect();
            resolve(Math.round(performance.now() - from));
          }
        });
        observer.observe(document.getElementById('stage'), { attributes: true, subtree: true, attributeFilter: ['class', 'hidden'] });
      });
    }, selector);
    const lasted = () => page.evaluate(() => window.lasted);
    // the animations of the design that start, by name
    const starts = () => page.evaluate(() => {
      window.started = [];
      document.addEventListener('animationstart', (event) => {
        if (event.animationName === 'oto-hit') window.started.push({ name: event.animationName, at: performance.now(), mon: event.target.classList.contains('mon') });
      });
    });
    const hpText = (text) => page.waitForFunction((wanted) => document.querySelector('.trainer-a .active .hp-text').textContent === wanted, text);
    const bench = (slot, name, extra = {}) => send('action:trainerA', { action: 'setBench', slot, cardId: `b-${slot}`, name, image: IMG, hp: 60, ...extra });
    // a Pokémon on the bench, once its moment is over (and forgotten)
    const benched = async (slot, name) => {
      await bench(slot, name);
      await played(`.trainer-a .bench .mon:nth-child(${slot + 1})`, 'moment-enter');
      await over();
      await forget();
    };

    it('mark a Pokémon that takes damage, with how much, and the stage with the side, for as long as the design says', async () => {
      const tile = '.trainer-a .active .mon';
      await watch(`${tile}.moment-damage`);
      await send('action:trainerA', { action: 'activeDamage', amount: 30 });
      await played(tile, 'moment-damage', { amount: 30 });
      assert.deepEqual(await page.evaluate(() => window.played.filter((entry) => entry.name === 'moment-damage').map((entry) => entry.variable)), ['30'], 'and in --moment-damage');
      assert.deepEqual(await there('#stage'), ['moment-damage-a']);
      const stayed = await lasted();
      assert.ok(stayed > MS - 100 && stayed < MS + 1000, `it stayed ${stayed} ms`);
      await over(); // (the stage's too)
      assert.equal(await page.$eval(tile, (node) => node.hasAttribute('data-damage') || node.style.getPropertyValue('--moment-damage') !== ''), false, 'the number goes with it');
      assert.deepEqual(page.problems, []);
    });

    it('give each number a name of its own, so damage and energy in one change, or one after the other, each say theirs', async () => {
      await wear('#stage .mon.moment-damage::after{content:"-" attr(data-damage)}#stage .mon.moment-energy::before{content:"+" attr(data-energy) " energy"}:root{--oto-moment-ms:4000}');
      const tile = '.trainer-a .active .mon';
      const labels = () => page.$eval(tile, (node) => [node.dataset.damage, node.dataset.energy, node.style.getPropertyValue('--moment-damage'), node.style.getPropertyValue('--moment-energy'),
        getComputedStyle(node, '::after').content, getComputedStyle(node, '::before').content]);
      const started = producer.expect('draft:state', (draft) => draft.active);
      producer.emit('draft:start');
      await started;
      try {
        await producer.draftAct('action:trainerA', { action: 'activeDamage', amount: 50 });
        await producer.draftAct('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'fire', count: 2 });
        producer.emit('draft:send', {});
        await played(tile, 'moment-damage', { amount: 50 });
        await played(tile, 'moment-energy', { amount: 2 });
        assert.deepEqual(await labels(), ['50', '2', '50', '2', '"-50"', '"+2 energy"']);
      } finally {
        const closed = producer.expect('draft:state', (draft) => !draft.active, 2000).catch(() => null);
        producer.emit('draft:discard');
        await closed;
      }
      await page.waitForSelector(`${tile}.moment-damage`, { state: 'detached', timeout: 8000 });
      assert.deepEqual((await labels()).slice(0, 4), [undefined, undefined, '', ''], 'each goes with its moment');

      await send('action:trainerA', { action: 'activeDamage', amount: 30 });
      await played(tile, 'moment-damage', { amount: 30 });
      await send('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'water', count: 1 });
      await played(tile, 'moment-energy', { amount: 1 });
      assert.deepEqual(await labels(), ['30', '1', '30', '1', '"-30"', '"+1 energy"'], 'the energy does not take the number of the hit');
    });

    it('mark a heal, and damage on the bench, on the tile it happened to', async () => {
      await send('action:trainerA', { action: 'activeDamage', amount: 40 });
      await played('.trainer-a .active .mon', 'moment-damage', { amount: 40 });
      await send('action:trainerA', { action: 'activeDamage', amount: -10 });
      await played('.trainer-a .active .mon', 'moment-heal', { amount: 10 });
      assert.deepEqual(await there('#stage'), ['moment-damage-a', 'moment-heal-a']);

      await bench(1, 'Eevee');
      await played('.trainer-a .bench .mon:nth-child(2)', 'moment-enter');
      await send('action:trainerB', { action: 'setActive', cardId: 'g-1', name: 'Gengar', image: IMG, hp: 120 });
      await send('action:trainerA', { action: 'benchDamage', slot: 1, amount: 20 });
      await played('.trainer-a .bench .mon:nth-child(2)', 'moment-damage', { amount: 20 });
      await send('action:trainerB', { action: 'activeHeal' }); // (nothing to heal: nothing plays)
      await send('action:trainerB', { action: 'activeDamage', amount: 50 });
      await played('.trainer-b .active .mon', 'moment-damage', { amount: 50 });
      assert.deepEqual(await there('.trainer-b .mon'), ['moment-damage', 'moment-enter']);
      assert.ok((await there('#stage')).includes('moment-damage-b'));
      assert.deepEqual(await there('.trainer-a .active .mon'), ['moment-damage', 'moment-heal'], 'only on the Pokémon that took it');
    });

    it('do not take a change of the maximum HP for a hit', async () => {
      await send('action:trainerA', { action: 'setMaxHP', slot: -1, max: 130 });
      await hpText('100/130');
      await wait(100);
      await nothing();
    });

    it('start again when the same thing happens again before they are over, and last their whole time again', async () => {
      const long = 1500;
      await wear(`#stage .mon.moment-damage{animation:oto-hit 5s linear}@keyframes oto-hit{from{opacity:.5}to{opacity:1}}:root{--oto-moment-ms:${long}}`);
      const tile = '.trainer-a .active .mon';
      await starts();
      await watch(`${tile}.moment-damage`);
      await send('action:trainerA', { action: 'activeDamage', amount: 10 });
      await page.waitForFunction(() => window.started.length === 1);
      await wait(600);
      await send('action:trainerA', { action: 'activeDamage', amount: 20 });
      await played(tile, 'moment-damage', { amount: 20 });
      await page.waitForFunction(() => window.started.length === 2);
      const started = await page.evaluate(() => window.started);
      assert.deepEqual(started.map((entry) => [entry.name, entry.mon]), [['oto-hit', true], ['oto-hit', true]]);
      assert.ok(started[1].at - started[0].at >= 550, `the animation started over (${Math.round(started[1].at - started[0].at)} ms after it first did)`);
      const stayed = await lasted();
      assert.ok(stayed >= long + 450, `and the moment lasted its whole time again: ${stayed} ms in all`);
      assert.equal(await page.$eval(tile, (node) => node.getAttribute('data-damage')), null);
    });

    it('run the animations of the design on them', async () => {
      await wear('#stage .mon.moment-damage{animation:oto-hit 1s}@keyframes oto-hit{from{opacity:.5}to{opacity:1}}');
      const tile = '.trainer-a .active .mon';
      assert.equal(await page.$eval(tile, (node) => getComputedStyle(node).animationName), 'none');
      await starts();
      await send('action:trainerA', { action: 'activeDamage', amount: 10 });
      await page.waitForFunction(() => window.started.length === 1);
      assert.deepEqual(await page.evaluate(() => window.started.map((entry) => [entry.name, entry.mon])), [['oto-hit', true]]);
      assert.deepEqual(page.problems, []);
    });

    it('mark a Pokémon that comes into play, on the bench or in the Active spot, and one that takes the place of another', async () => {
      await bench(0, 'Eevee');
      await played('.trainer-a .bench .mon:nth-child(1)', 'moment-enter');
      assert.deepEqual(await there('#stage'), ['moment-enter-a']);
      await send('action:trainerA', { action: 'setActive', cardId: 'a-9', name: 'Mew', image: IMG, hp: 70 });
      await played('.trainer-a .active .mon', 'moment-enter');
      assert.equal(await page.locator('.trainer-a .active .mon .mon-name').textContent(), 'Mew');
      // moved to a slot that was empty: it comes into that one, and nothing plays where it was
      await forget();
      await send('action:trainerA', { action: 'moveSlot', from: 0, to: 2 });
      await played('.trainer-a .bench .mon:nth-child(3)', 'moment-enter');
      assert.deepEqual(await there('.mon'), ['moment-enter']);
    });

    it('mark both Pokémon of a switch', async () => {
      await benched(0, 'Eevee');
      await send('action:trainerA', { action: 'swapWithActive', slot: 0 });
      await played('.trainer-a .active .mon', 'moment-switch');
      await played('.trainer-a .bench .mon:nth-child(1)', 'moment-switch');
      assert.deepEqual(await there('#stage'), ['moment-switch-a'], 'nobody came into play');
      assert.equal(await page.locator('.trainer-a .active .mon .mon-name').textContent(), 'Eevee');
    });

    it('tell two copies of the same card apart: they change places, nobody is hit or healed', async () => {
      const copy = (slot) => send('action:trainerA', { action: 'setBench', slot, cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 100 });
      await send('action:trainerA', { action: 'activeDamage', amount: 50 });
      await copy(0);
      await copy(1);
      await page.waitForFunction(() => document.querySelectorAll('.trainer-a .bench .mon:not([hidden])').length === 2);
      await over();
      await forget();

      await send('action:trainerA', { action: 'swapWithActive', slot: 0 });
      await played('.trainer-a .active .mon', 'moment-switch');
      await played('.trainer-a .bench .mon:nth-child(1)', 'moment-switch');
      await hpText('100/100');
      await wait(100);
      assert.deepEqual(await there('.mon'), ['moment-switch', 'moment-switch'], 'no damage, heal or energy');
      assert.deepEqual(await there('#stage'), ['moment-switch-a']);

      // two copies on the bench change places: each comes into the other's slot
      await over();
      await forget();
      await send('action:trainerA', { action: 'moveSlot', from: 0, to: 1 });
      await played('.trainer-a .bench .mon:nth-child(1)', 'moment-enter');
      await played('.trainer-a .bench .mon:nth-child(2)', 'moment-enter');
      await wait(100);
      assert.deepEqual(await there('.mon'), ['moment-enter', 'moment-enter']);

      // and the same card played again in a slot is another Pokémon, at full HP: it comes in, it is not healed
      await over();
      await forget();
      await send('action:trainerA', { action: 'activeDamage', amount: 20 });
      await played('.trainer-a .active .mon', 'moment-damage', { amount: 20 });
      await forget();
      await send('action:trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 100 });
      await played('.trainer-a .active .mon', 'moment-enter');
      await wait(100);
      assert.deepEqual(await there('.mon'), ['moment-enter']);
    });

    it('mark an evolution, and going back', async () => {
      await send('action:card', { action: 'select', target: 'trainerA-active', cardId: 'a-2', evolve: true, cardData: { id: 'a-2', name: 'Raichu', hp: '120', images: { small: IMG, large: IMG }, abilities: [], attacks: [], retreat: 1 } });
      await played('.trainer-a .active .mon', 'moment-evolve');
      assert.deepEqual(await there('#stage'), ['moment-evolve-a'], 'not a Pokémon that came into play');
      await send('action:trainerA', { action: 'devolve', slot: -1 });
      await played('.trainer-a .active .mon', 'moment-devolve');
      assert.equal(await page.locator('.trainer-a .active .mon .mon-name').textContent(), 'Pikachu');
    });

    it('mark energy that is attached (how many), a tool, a status condition (which) and an ability that is used', async () => {
      const tile = '.trainer-a .active .mon';
      await send('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'grass', count: 2 });
      await played(tile, 'moment-energy', { amount: 2 });
      await send('action:trainerA', { action: 'attachTool', slot: -1, name: 'Choice Belt' });
      await played(tile, 'moment-tool');
      await send('action:trainerA', { action: 'toggleStatus', condition: 'poisoned', enabled: true });
      await played(tile, 'moment-status', { status: 'poisoned' });
      assert.deepEqual(await there('#stage'), ['moment-energy-a', 'moment-status-a', 'moment-tool-a']);
      await page.waitForSelector(`${tile}[data-status]`, { state: 'detached', timeout: MS * 6 });
      assert.equal(await page.locator('.trainer-a .active .status-chip[data-status="poisoned"]').count(), 1, 'the condition itself stays');

      await bench(0, 'Pichu', { abilities: ['Baby Rush'] });
      await played('.trainer-a .bench .mon:nth-child(1)', 'moment-enter');
      await send('action:trainerA', { action: 'setAbilityUsed', slot: 0, index: 0, used: true });
      await played('.trainer-a .bench .mon:nth-child(1)', 'moment-ability');
      await forget();
      await send('action:trainerA', { action: 'setAbilityUsed', slot: 0, index: 0, used: false });
      await page.waitForSelector('.trainer-a .bench .ability:not(.used)');
      await wait(100);
      await nothing(); // (getting it back is not using it)
    });

    it('mark the prize cards that are taken, the turn that starts, what is used, a Stadium that comes into play and a game won', async () => {
      await send('action:trainerA', { action: 'prizeMinus' });
      await played('.trainer-a .prize:nth-child(6)', 'moment-taken');
      assert.deepEqual(await there('.prize'), ['moment-taken']);
      await send('action:trainerB', { action: 'prizeSet', count: 3 });
      await page.waitForFunction(() => window.played.filter((entry) => entry.node.matches('.trainer-b .prize')).length === 3);
      assert.deepEqual(await page.$$eval('.trainer-b .prize', (nodes) => nodes.map((node) => window.played.some((entry) => entry.node === node))), [false, false, false, true, true, true]);
      assert.deepEqual(await there('#stage'), ['moment-taken-a', 'moment-taken-b']);

      await send('action:match', { action: 'toggleTurn' });
      await played('.trainer-a', 'moment-turn');
      assert.deepEqual(await there('.trainer-b'), []);
      await send('action:trainerA', { action: 'supporterPlus' });
      await played('.trainer-a .token[data-kind="supporter"]', 'moment-used');
      await send('action:card', { action: 'setStadium', cardId: 's-1', name: 'Area Zero', image: IMG });
      await played('.stadium', 'moment-enter');
      await played('.trainer-a .token[data-kind="stadium"]', 'moment-used');
      await played('#stage', 'moment-enter-a'); // (played by the trainer whose turn it is)
      await send('action:match', { action: 'trainerBMatchWin' });
      await played('.sb-b .sb-wins', 'moment-point');
      await played('#stage', 'moment-point-b');
      assert.deepEqual(await there('.sb-a .sb-wins'), []);
    });

    describe('for a knock out', () => {
      const tile = '.trainer-a .active .mon';
      const KO_MS = 3000; // (time enough to look at the tile while it is still there, even on a busy machine)
      const animated = () => wear(`#stage .mon.moment-ko{opacity:.5}:root{--oto-moment-ms:${KO_MS}}`);
      beforeEach(async () => {
        await benched(0, 'Eevee'); // (so the trainer still has a Pokémon)
      });

      it('keep the Pokémon on its tile, as it was, while the design animates it, and hide it then', async () => {
        await animated();
        await watch(`${tile}.moment-ko:not([hidden])`);
        await send('action:trainerA', { action: 'knockOut', slot: -1 });
        await played(tile, 'moment-ko');
        const looked = await page.evaluate(() => window.played.filter((entry) => entry.name === 'moment-ko').map((entry) => [entry.hidden, entry.text, entry.opacity]));
        assert.deepEqual(looked, [[false, 'Pikachu', '0.5']], 'shown as it was, as the design animates it');
        assert.equal((await live()).trainerA.active.name, '', 'though the slot is empty');
        await played('.trainer-b .prize:nth-child(6)', 'moment-taken');
        assert.deepEqual(await there('#stage'), ['moment-ko-a', 'moment-taken-b']);

        // something else changes meanwhile: the tile stays
        await send('action:trainerB', { action: 'setName', name: 'Misty' });
        assert.deepEqual(await page.evaluate(() => new Promise((resolve) => {
          const check = () => {
            if (document.querySelector('.sb-b .sb-name').textContent !== 'Misty') return window.requestAnimationFrame(check);
            const node = document.querySelector('.trainer-a .active .mon');
            return resolve([node.hidden, node.classList.contains('moment-ko')]);
          };
          check();
        })), [false, true]);
        const stayed = await lasted();
        assert.ok(stayed > KO_MS - 100 && stayed < KO_MS + 1000, `it stayed ${stayed} ms`);
        assert.deepEqual(await page.$eval(tile, (node) => [node.hidden, node.classList.contains('moment-ko')]), [true, false], 'hidden, and the moment is over');
        await wait(300);
        assert.equal(await page.locator(tile).isHidden(), true, 'and stays hidden');
        assert.deepEqual(page.problems, []);
      });

      it('mark the stage when the knock out comes in one change with the Pokémon that takes the Active spot (a draft), and the tile plays the newcomer', async () => {
        await animated();
        const started = producer.expect('draft:state', (draft) => draft.active);
        producer.emit('draft:start');
        await started;
        try {
          await producer.draftAct('action:trainerA', { action: 'knockOut', slot: -1 });
          await producer.draftAct('action:trainerA', { action: 'swapWithActive', slot: 0 });
          producer.emit('draft:send', {});
          await played(tile, 'moment-enter');
          await played('#stage', 'moment-ko-a');
          await played('.trainer-b .prize:nth-child(6)', 'moment-taken');
          assert.deepEqual(await there(tile), ['moment-enter'], 'the tile plays the newcomer, not the knock out');
          assert.equal(await page.locator(`${tile} .mon-name`).textContent(), 'Eevee');
        } finally {
          const closed = producer.expect('draft:state', (draft) => !draft.active, 2000).catch(() => null);
          producer.emit('draft:discard');
          await closed;
        }
      });

      it('let a Pokémon that comes into the slot take the tile at once', async () => {
        await animated();
        await send('action:trainerA', { action: 'knockOut', slot: -1 });
        await page.waitForSelector(`${tile}.moment-ko`);
        await send('action:trainerA', { action: 'setActive', cardId: 'a-7', name: 'Raichu', image: IMG, hp: 120 });
        await page.waitForFunction(() => document.querySelector('.trainer-a .active .mon-name').textContent === 'Raichu');
        assert.deepEqual(await page.$eval(tile, (node) => [node.hidden, node.classList.contains('moment-ko'), getComputedStyle(node).opacity]), [false, false, '1']);
        await played(tile, 'moment-enter');
        assert.equal(await page.locator(`${tile} .hp-text`).textContent(), '120/120');
        await wait(KO_MS + 300);
        assert.equal(await page.locator(tile).isVisible(), true, 'the knock out does not hide the newcomer');
        assert.equal(await page.locator(`${tile} .mon-name`).textContent(), 'Raichu');
      });

      it('hide the tile at once when the design does not animate a knock out, and when a Pokémon is only taken off the table', async () => {
        await send('action:trainerA', { action: 'knockOut', slot: -1 });
        await played(tile, 'moment-ko'); // (the moment is there all the same)
        assert.equal(await page.locator(tile).isHidden(), true, 'nothing would show it');

        await over();
        await animated();
        await forget();
        await send('action:trainerA', { action: 'clearSlot', slot: 0 });
        await page.waitForSelector('.trainer-a .bench .mon:nth-child(1)', { state: 'hidden' });
        await wait(100);
        assert.deepEqual(await there('.mon'), [], 'no prize card was taken: it was not knocked out');
      });
    });

    it('play nothing for the game sent whole when the page reconnects, nor for the same state drawn again', async () => {
      await page.evaluate(() => window.oto.socket.disconnect());
      await send('action:trainerA', { action: 'activeDamage', amount: 30 });
      await send('action:trainerB', { action: 'prizeMinus' });
      await bench(0, 'Eevee');
      await page.evaluate(() => window.oto.socket.connect());
      await hpText('70/100');
      await wait(150);
      await nothing(); // (what happened while the page was away is not played)
      await page.evaluate(() => window.oto.update(window.oto.state));
      await nothing();
      // and the next change plays
      await send('action:trainerA', { action: 'activeDamage', amount: 10 });
      await played('.trainer-a .active .mon', 'moment-damage', { amount: 10 });
    });

    it('play nothing for a configuration that is imported: it is another game, drawn as it is, and no Pokémon of the last one stays', async () => {
      await wear(':root{--oto-moment-ms:2000}#stage .mon.moment-ko{opacity:.6}');
      await benched(0, 'Eevee');
      const config = await live();
      config.trainerA.active = { ...config.trainerA.active, cardId: '', name: '', image: '' };
      config.trainerA.bench = config.trainerA.bench.map((slot) => ({ ...slot, cardId: '', name: '', image: '' }));
      config.trainerB.prizes = { ...config.trainerB.prizes, count: 3 };
      config.trainerB.isTurn = true;
      for (const importing of [
        () => send('action:settings', { action: 'import', config }),
        () => fetch(`${server.base}/api/config/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })
      ]) {
        await importing();
        await page.waitForFunction(() => window.oto.state.trainerA.active.name === '' && window.oto.state.trainerB.prizes.count === 3);
        assert.equal(await page.locator('.trainer-a .active .mon').isHidden(), true, 'the tile goes at once');
        await wait(150);
        await nothing();
        await send('action:reset', { action: 'full', confirm: 'FULL_RESET' });
        await send('action:trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 100 });
        await benched(0, 'Eevee');
      }
      await nothing();
    });

    it('play nothing while the design animations are switched off, on the overlay or on one screen', async () => {
      assert.equal(await page.evaluate(() => window.OTO_DISPLAY.DEFAULTS.moments), true, 'they are on unless switched off');
      await send('action:settings', { action: 'update', display: { moments: false } });
      await page.waitForFunction(() => window.oto.state.settings.display.moments === false);
      await send('action:trainerA', { action: 'activeDamage', amount: 30 });
      await hpText('70/100');
      await wait(150);
      await nothing();

      await send('action:settings', { action: 'update', display: { moments: true } });
      await send('action:settings', { action: 'update', screens: [{ id: 'quiet', name: 'Quiet', display: { moments: false } }] });
      const quiet = await openPage(browser, `${server.base}/overlay?screen=quiet`, { viewport: { width: 960, height: 540 } });
      try {
        await quiet.waitForSelector('.trainer-a .active .mon:not([hidden])');
        await recordMoments(quiet);
        await send('action:trainerA', { action: 'activeDamage', amount: 10 });
        await played('.trainer-a .active .mon', 'moment-damage', { amount: 10 });
        await quiet.waitForFunction(() => document.querySelector('.trainer-a .active .hp-text').textContent === '60/100');
        await wait(150);
        assert.deepEqual(await playedThere(quiet, '*'), [], 'the screen that switched them off plays none');
      } finally {
        await quiet.context().close();
      }
    });

    it('play nothing about a piece the producer switched off, so no design can show what it would have shown', async () => {
      const off = { hpBars: false, statusConditions: false, turnIndicator: false, matchScore: false, attachments: false, abilityTokens: false, toolCards: false, prizes: false, energyCounter: false, stadiumCounter: false, supporterCounter: false, stadium: false };
      const noTrace = () => page.evaluate(() => ({
        classes: Array.from(document.querySelectorAll('[class*="moment-"]')).map((node) => node.className),
        numbers: Array.from(document.querySelectorAll('[data-damage], [data-heal], [data-energy], .mon[data-status]')).map((node) => node.className)
      }));
      await bench(0, 'Pichu', { abilities: ['Baby Rush'] });
      await played('.trainer-a .bench .mon:nth-child(1)', 'moment-enter');
      await over();
      await forget();
      try {
        await send('action:settings', { action: 'update', display: off });
        await page.waitForFunction(() => document.querySelector('.trainer-a .active .hp').classList.contains('opt-off'));
        await send('action:trainerA', { action: 'activeDamage', amount: 30 });
        await send('action:trainerA', { action: 'toggleStatus', condition: 'poisoned', enabled: true });
        await send('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'grass', count: 1 });
        await send('action:trainerA', { action: 'attachTool', slot: -1, name: 'Choice Belt' });
        await send('action:trainerA', { action: 'setAbilityUsed', slot: 0, index: 0, used: true });
        await send('action:match', { action: 'toggleTurn' });
        await send('action:trainerA', { action: 'supporterPlus' });
        await send('action:trainerB', { action: 'prizeMinus' });
        await send('action:card', { action: 'setStadium', cardId: 's-1', name: 'Area Zero', image: IMG });
        await send('action:match', { action: 'trainerBMatchWin' });
        await hpText('70/100');
        await page.waitForFunction(() => window.oto.state.matchScore.trainerBWins === 1 && window.oto.state.stadium.inPlay);
        await wait(150);
        await nothing();
        assert.deepEqual(await noTrace(), { classes: [], numbers: [] }, 'nothing on the tiles, the trainers or the stage');

        // what is still shown plays: a Pokémon that comes in, and a knock out
        await bench(1, 'Eevee');
        await played('.trainer-a .bench .mon:nth-child(2)', 'moment-enter');
        // and the Active Pokémon and the bench switched off take theirs with them
        await over();
        await forget();
        await send('action:settings', { action: 'update', display: { activePokemon: false, benchPokemon: false } });
        await page.waitForFunction(() => document.querySelector('.trainer-a .active').classList.contains('opt-off'));
        await send('action:trainerA', { action: 'setActive', cardId: 'a-9', name: 'Mew', image: IMG, hp: 70 });
        await send('action:trainerA', { action: 'knockOut', slot: 1 });
        await page.waitForFunction(() => window.oto.state.trainerA.active.name === 'Mew' && !window.oto.state.trainerA.bench[1].name);
        await wait(150);
        await nothing();
      } finally {
        await send('action:settings', { action: 'update', display: Object.assign(Object.fromEntries(Object.keys(off).map((key) => [key, true])), { activePokemon: true, benchPokemon: true }) });
      }
    });

    it('last as long as the design says, between a fifth of a second and ten seconds, and a second and a half when it says nothing', async () => {
      const lasting = (value) => page.evaluate((text) => {
        const root = document.documentElement;
        if (text === null) root.style.removeProperty('--oto-moment-ms');
        else root.style.setProperty('--oto-moment-ms', text);
        const ms = window.oto.momentDuration();
        root.style.removeProperty('--oto-moment-ms');
        return ms;
      }, value);
      assert.equal(await lasting('2500'), 2500);
      assert.equal(await lasting('1.2s'), 1200);
      assert.equal(await lasting('800ms'), 800);
      assert.equal(await lasting('50'), 200);
      assert.equal(await lasting('60000'), 10000);
      assert.equal(await lasting('soon'), 1500);
      await page.evaluate(() => window.oto.applyTheme(null));
      assert.equal(await lasting(null), 1500);
    });

    it('can be played on a piece as if they had happened, without hiding a knocked out Pokémon', async () => {
      assert.equal(await page.evaluate(() => window.oto.playMoment('damage', 'a', 'active', 60)), true);
      await played('.trainer-a .active .mon', 'moment-damage', { amount: 60 });
      assert.deepEqual(await there('#stage'), ['moment-damage-a']);
      assert.equal(await page.evaluate(() => window.oto.playMoment('taken', 'b', 'prize2')), true);
      await played('.trainer-b .prize:nth-child(3)', 'moment-taken');
      assert.equal(await page.evaluate(() => window.oto.playMoment('enter', 'b', 'stadium')), true);
      await played('.stadium', 'moment-enter');
      assert.equal(await page.evaluate(() => window.oto.playMoment('used', 'a', 'token-supporter')), true);
      await played('.trainer-a .token[data-kind="supporter"]', 'moment-used');
      assert.equal(await page.evaluate(() => window.oto.playMoment('ko', 'a', 'active')), true);
      await played('.trainer-a .active .mon', 'moment-ko');
      await over();
      assert.equal(await page.locator('.trainer-a .active .mon').isVisible(), true, 'the tile stays');
      await forget();
      for (const [moment, side, target] of [['boom', 'a', 'active'], ['damage', 'c', 'active'], ['damage', 'a', 'bench9'], ['damage', 'a', 'toString']]) {
        assert.equal(await page.evaluate((args) => window.oto.playMoment(...args), [moment, side, target]), false, `${moment} ${side} ${target}`);
      }
      await nothing();
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

    it('plays a moment it is asked for on the piece it names, as if it had happened, and says when it has', async () => {
      await editor.evaluate(() => {
        window.drawn = 0;
        window.addEventListener('message', (event) => { if (event.data && event.data.kind === 'drawn') window.drawn++; });
      });
      await tell({ kind: 'state', state: await live() });
      await tell({ kind: 'design', theme: { name: 'Draft', colors: {}, images: {}, css: ':root{--oto-moment-ms:2500}#stage .mon.moment-ko{opacity:.3}' } });
      await editor.waitForSelector('.trainer-a .active .mon:not([hidden])');
      await editor.waitForFunction(() => window.drawn === 2);
      await recordMoments(editor);

      await tell({ kind: 'moment', moment: 'damage', side: 'a', target: 'active', amount: 60 });
      await playedOn(editor, '.trainer-a .active .mon', 'moment-damage', { amount: 60 });
      await playedOn(editor, '#stage', 'moment-damage-a');
      await editor.waitForFunction(() => window.drawn === 3);

      // a knock out plays on the tile as it is, and the tile stays (the made-up match is not changed)
      await tell({ kind: 'moment', moment: 'ko', side: 'a', target: 'active' });
      await editor.waitForSelector('.trainer-a .active .mon.moment-ko');
      assert.equal(await editor.$eval('.trainer-a .active .mon', (node) => getComputedStyle(node).opacity), '0.3');
      await editor.waitForSelector('.moment-ko', { state: 'detached' });
      await wait(200);
      assert.equal(await editor.locator('.trainer-a .active .mon').isVisible(), true);

      await tell({ kind: 'moment', moment: 'status', side: 'b', target: 'trainer' });
      await playedOn(editor, '.trainer-b', 'moment-status', { status: 'asleep' });
      assert.deepEqual(editor.problems, []);
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
