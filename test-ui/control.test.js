/**
 * The control panel in a real browser: the keyboard shortcuts, the dialogs and the live behavior.
 * Run with: npm run test:ui
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, startMockCardApi, wait } = require('../test-support/harness');
const { findBrowser, launch, openPage } = require('./browser');

const skip = findBrowser() ? false : 'no Chrome or Edge found (set BROWSER_PATH to use another)';
const IMG = '/art/test.svg';
const ART = (name) => `https://images.test/art/${name}.svg`;

describe('control panel', { skip }, () => {
  let browser;
  let server;
  let api;
  let producer; // another producer, used to change things "from elsewhere"
  let page;
  let extra = [];

  before(async () => {
    const pokemon = { id: 'sv-1', name: 'Pikachu ex', supertype: 'Pokémon', subtypes: ['Basic'], hp: '200', number: '1', rarity: 'Rare', types: ['Lightning'], set: { id: 'sv', name: 'Test' }, images: { small: ART('pikachu-ex'), large: ART('pikachu-ex') } };
    const stadium = { id: 'sv-2', name: 'Area Zero', supertype: 'Trainer', subtypes: ['Stadium'], number: '2', rarity: 'Uncommon', set: { id: 'sv', name: 'Test' }, images: { small: ART('area-zero'), large: ART('area-zero') } };
    api = await startMockCardApi({
      '/cards/sv-1': { data: { ...pokemon, abilities: [{ name: 'Resolute Heart' }] } },
      // a Stadium search answers with a Stadium, anything else with the Pokémon
      '/cards?': (url) => ({ data: [decodeURIComponent(url).includes('subtypes:"Stadium"') ? stadium : pokemon], totalCount: 1, page: 1, pageSize: 20 })
    });
    server = await startServer({ label: 'ui-control', env: { POKEMONTCG_API_URL: api.url } });
    producer = server.client({ clientId: 'ui-other-producer', name: 'Maya' });
    await producer.ready();
    browser = await launch();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    if (api) await api.close();
  });

  const live = async () => (await fetch(`${server.base}/api/state`)).json();

  // Wait for something about the live game to become true, and fail showing what it was instead.
  // Then wait for the page to show that same game, so the next key press never acts on old news.
  async function expectLive(read, expected, message) {
    const deadline = Date.now() + 4000;
    let snapshot;
    for (;;) {
      snapshot = await live();
      try {
        assert.deepEqual(read(snapshot), expected);
        break;
      } catch (error) {
        if (Date.now() > deadline) {
          const said = await page.locator('.toast').allTextContents().catch(() => []);
          throw new assert.AssertionError({
            message: `${message || 'the live game'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(read(snapshot))}`
              + `${said.length ? `\n  the page said: ${said.join(' | ')}` : ''}${page.problems.length ? `\n  console: ${page.problems.join(' | ')}` : ''}`,
            actual: read(snapshot),
            expected
          });
        }
      }
      await wait(50);
    }
    await page.waitForFunction((revision) => window.oto.conn.live.revision >= revision, snapshot.revision);
  }

  const modal = () => page.locator('.modal');
  // Dialogs close once the server has answered, a moment after the game changes
  const dialogClosed = () => page.waitForFunction(() => !document.querySelector('.modal'));
  const press = (key) => page.keyboard.press(key);
  const prizeNumber = (side = 'a') => page.locator(`.trainer-panel.side-${side} .prize-number`);
  const toasts = () => page.locator('.toast').allTextContents();

  // Put the game in a known position, then open a fresh control panel
  beforeEach(async () => {
    await producer.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
    await producer.act('action:trainerA', { action: 'setName', name: 'Ash' });
    await producer.act('action:trainerB', { action: 'setName', name: 'Gary' });
    await producer.act('action:trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 100, abilities: ['Static'] });
    await producer.act('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-2', name: 'Eevee', image: IMG, hp: 60 });
    await producer.act('action:trainerB', { action: 'setActive', cardId: 'b-1', name: 'Charizard', image: IMG, hp: 150 });
    await producer.act('action:match', { action: 'toggleTurn' }); // Ash has the turn

    page = await openPage(browser, `${server.base}/control`);
    await page.waitForSelector('.trainer-panel.side-a .mon-card');
    await page.waitForSelector('.trainer-panel.side-b .mon-card');
  });

  afterEach(async () => {
    for (const context of [page.context(), ...extra]) await context.close();
    extra = [];
  });

  it('shows the match, with no complaints from the browser', async () => {
    assert.equal(await page.locator('.trainer-panel.side-a .identity input').first().inputValue(), 'Ash');
    assert.equal(await page.locator('.trainer-panel.side-b .identity input').first().inputValue(), 'Gary');
    assert.equal((await prizeNumber('a').textContent()).trim(), '6');
    assert.match(await page.locator('.trainer-panel.side-a .mon-name').first().textContent(), /Pikachu/);
    assert.equal(await page.locator('.conn-pill').textContent(), 'Connected');
    assert.equal(await page.locator('.trainer-panel.side-a .mon-art img').count(), 2, 'card art is shown for the Active Pokémon and the one on the bench');
    assert.deepEqual(page.problems, []);
  });

  it('shows who else is producing and what they do', async () => {
    await producer.act('action:trainerB', { action: 'prizeMinus' });
    await page.waitForFunction(() => document.querySelector('.feed').textContent.includes('(5 left)'));
    assert.match(await page.locator('.feed').textContent(), /Maya.*Gary prizes −1 \(5 left\)/);
    assert.match(await page.locator('.people').textContent(), /Maya/);
  });

  it('keeps two producers\' pages in step', async () => {
    const second = await openPage(browser, `${server.base}/control`);
    extra.push(second.context());
    await second.waitForSelector('.trainer-panel.side-a .mon-card');
    await page.waitForFunction(() => document.querySelectorAll('.people .person').length >= 3); // Maya and both pages

    await press('ArrowDown');
    await second.waitForFunction(() => document.querySelector('.trainer-panel.side-a .prize-number').textContent.trim() === '5');
    await second.keyboard.press('i');
    await page.waitForFunction(() => [...document.querySelectorAll('.trainer-panel.side-a .switch input')].some((box) => box.checked));
    assert.match(await second.locator('.feed').textContent(), /prizes −1/);
  });

  it('follows the turn with the shortcut focus, and lets 1 and 2 choose', async () => {
    assert.match(await page.locator('.trainer-panel.side-a').getAttribute('class'), /is-focus/);
    await press('2');
    await page.waitForSelector('.trainer-panel.side-b.is-focus');
    await press('1');
    await page.waitForSelector('.trainer-panel.side-a.is-focus');

    await press('Space'); // the turn passes to Gary and the focus goes with it
    await page.waitForSelector('.trainer-panel.side-b.is-focus');
    await expectLive((state) => state.trainerB.isTurn, true);
  });

  it('changes prizes, locks and the supporter with the keyboard', async () => {
    await press('ArrowDown');
    await expectLive((state) => state.trainerA.prizes.count, 5);
    await press('Shift+ArrowDown');
    await expectLive((state) => state.trainerB.prizes.count, 5);
    await press('ArrowUp');
    await expectLive((state) => state.trainerA.prizes.count, 6);

    await press('i');
    await expectLive((state) => state.trainerA.locks.itemLock, true);
    await press('v');
    await expectLive((state) => state.trainerA.locks.evoLock, true);
    await press('i');
    await expectLive((state) => state.trainerA.locks.itemLock, false);

    await press('Shift+S');
    await expectLive((state) => state.trainerA.resources.supporterPerTurn.used, 1);
    await press('Shift+S');
    await expectLive((state) => state.trainerA.resources.supporterPerTurn.used, 0);
    assert.equal(await modal().count(), 0, 'Shift+S is the supporter, not the stadium picker');
  });

  it('ignores shortcuts while you type in a box', async () => {
    await page.locator('.trainer-panel.side-a .identity input').first().click();
    await page.keyboard.type('keds');
    await wait(200);
    assert.equal(await modal().count(), 0, 'typing k, e, d and s opened no dialog');
  });

  it('does not overwrite a name while you are typing it', async () => {
    const name = page.locator('.trainer-panel.side-a .identity input').first();
    await name.fill('Typing in progre');
    await producer.act('action:trainerA', { action: 'prizeMinus' }); // someone else changes something
    await page.waitForFunction(() => document.querySelector('.trainer-panel.side-a .prize-number').textContent.trim() === '5');
    assert.equal(await name.inputValue(), 'Typing in progre');

    await name.fill('Ash Ketchum');
    await press('Enter');
    await expectLive((state) => state.trainerA.name, 'Ash Ketchum');
  });

  it('knocks out a Pokémon with K: prizes, announcement, and straight on to the next', async () => {
    await press('k');
    await page.waitForSelector('.modal');
    await modal().locator('.choice', { hasText: 'Pikachu' }).click();
    await modal().locator('.seg', { hasText: '2 prizes' }).click();
    await modal().locator('.modal-foot button.danger').click();

    await expectLive((state) => state.trainerB.prizes.count, 4);
    await expectLive((state) => state.trainerA.active.name, '');
    await page.waitForFunction(() => document.querySelector('.feed').textContent.includes('Pikachu knocked out (Gary takes 2 prizes)'));
    // the Active Pokémon is gone, so the dialog for the next one opens by itself
    await page.waitForSelector('.modal[aria-label="Deploy the Active Pokémon · Ash"]');
    await page.locator('.from-bench .choice', { hasText: 'Eevee' }).click();
    await expectLive((state) => state.trainerA.active.name, 'Eevee');
    await page.waitForFunction(() => !document.querySelector('.modal'));
  });

  it('applies damage and heals with D and H', async () => {
    await press('d'); // damage lands on the trainer who is not attacking: Gary's Active Pokémon
    await page.waitForSelector('.modal');
    await modal().locator('.amount-input').fill('40');
    assert.match(await modal().locator('.preview-row').textContent(), /Charizard.*150 → 110/);
    await modal().locator('.modal-foot .primary').click();
    await expectLive((state) => state.trainerB.active.hp.current, 110);
    await dialogClosed();

    await press('2');
    await press('h');
    await page.waitForSelector('.modal');
    await modal().locator('.amount-input').fill('25');
    await press('Enter');
    await expectLive((state) => state.trainerB.active.hp.current, 135);
  });

  it('edits the HP by clicking it, and a forgotten edit does not linger', async () => {
    await page.locator('.trainer-panel.side-a .hp-value').first().click();
    const current = page.locator('.trainer-panel.side-a .hp-editor input[aria-label="Current HP"]');
    await current.waitFor();
    await current.fill('37');
    await press('Enter');
    await expectLive((state) => state.trainerA.active.hp.current, 37);
    await page.waitForSelector('.trainer-panel.side-a .hp-editor', { state: 'detached' });

    // click away without saving: the box closes and nothing changes
    await page.locator('.trainer-panel.side-a .hp-value').first().click();
    await current.waitFor();
    await current.fill('5');
    await page.locator('.brand-name').click();
    await page.waitForSelector('.trainer-panel.side-a .hp-editor', { state: 'detached' });
    await expectLive((state) => state.trainerA.active.hp.current, 37);

    // and a Pokémon on the bench works the same way
    await page.locator('.trainer-panel.side-a .mon-card.compact .hp-value').click();
    await page.locator('.trainer-panel.side-a .hp-editor input[aria-label="Maximum HP"]').fill('90');
    await page.locator('.trainer-panel.side-a .hp-editor button[aria-label="Save HP"]').click();
    await expectLive((state) => state.trainerA.bench[0].hp.max, 90);
  });

  it('attaches energy with E, as the turn\'s attachment or as a special one', async () => {
    await press('e');
    await page.waitForSelector('.modal');
    await modal().locator('.energy-pick', { hasText: 'Fire' }).click();
    await modal().locator('.energy-pick', { hasText: 'Fire' }).click();
    assert.match(await modal().locator('.hint-line').textContent(), /Uses up the turn's attachment/);
    await modal().locator('.modal-foot .primary', { hasText: 'Attach 2 energy' }).click();
    await expectLive((state) => [state.trainerA.active.energies, state.trainerA.resources.energyPerTurn.used], [['fire', 'fire'], 1]);
    await dialogClosed();

    await press('e');
    await page.waitForSelector('.modal');
    assert.match(await modal().locator('.hint-line').textContent(), /already attached this turn/);
    await modal().locator('.switch.inline').click(); // not the turn's attachment
    assert.match(await modal().locator('.hint-line').textContent(), /A special attachment/);
    await modal().locator('.energy-pick', { hasText: 'Water' }).click();
    await modal().locator('.modal-foot .primary', { hasText: 'Attach 1 energy' }).click();
    await expectLive((state) => [state.trainerA.active.energies, state.trainerA.resources.energyPerTurn.used], [['fire', 'fire', 'water'], 1]);
  });

  it('manages ability tokens with X, and from the Pokémon itself', async () => {
    await page.locator('.trainer-panel.side-a .ability-chip').first().click();
    await expectLive((state) => state.trainerA.active.abilities[0].used, true);
    await page.waitForSelector('.trainer-panel.side-a .ability-chip.used .used-tag');

    await press('x');
    await page.waitForSelector('.modal');
    await modal().locator('.add-token input[type=text]').fill('VSTAR Power');
    await modal().locator('.add-token select').nth(1).selectOption('game');
    await modal().locator('.add-token button').click();
    await expectLive((state) => state.trainerA.active.abilities.map((ability) => [ability.name, ability.scope, ability.used]),
      [['Static', 'turn', true], ['VSTAR Power', 'game', false]]);

    await modal().locator('button', { hasText: 'All ready' }).click();
    await expectLive((state) => state.trainerA.active.abilities.map((ability) => ability.used), [false, false]);
  });

  it('finds a card with A, and takes its HP and abilities', async () => {
    await press('a');
    await page.locator('.search-input').fill('pika');
    await page.waitForSelector('.card-tile');
    await press('Enter');
    await expectLive((state) => [state.trainerA.active.name, state.trainerA.active.hp, state.trainerA.active.abilities.map((ability) => ability.name)],
      ['Pikachu ex', { max: 200, current: 200 }, ['Resolute Heart']]);
    await page.waitForFunction(() => !document.querySelector('.modal'));
  });

  it('puts a stadium in play with S, searching for stadiums only', async () => {
    await press('s');
    await page.locator('.search-input').fill('area');
    await page.waitForSelector('.card-tile');
    await press('Enter');
    await expectLive((state) => [state.stadium.inPlay, state.stadium.name], [true, 'Area Zero']);
    await page.waitForFunction(() => document.querySelector('.stadium-name').textContent === 'Area Zero');
    const asked = api.requests.map((url) => decodeURIComponent(url)).find((url) => url.includes('area'));
    assert.match(asked, /supertype:"Trainer"/);
    assert.match(asked, /subtypes:"Stadium"/);
  });

  it('edits the bench with B', async () => {
    await press('b');
    await page.waitForSelector('.bench-list');
    assert.match(await modal().locator('.bench-list').textContent(), /Eevee/);
    await modal().locator('.bench-row', { hasText: 'Eevee' }).locator('button', { hasText: 'Switch in' }).click();
    await expectLive((state) => [state.trainerA.active.name, state.trainerA.bench[0].name], ['Eevee', 'Pikachu']);
  });

  it('announces an attack with C, and can apply the damage too', async () => {
    const heard = producer.expect('announce', (announcement) => announcement.type === 'attack');
    await press('c');
    await page.waitForSelector('.modal');
    await modal().locator('input[type=text]').fill('Thunderbolt');
    await modal().locator('input[type=number]').fill('60');
    await modal().locator('.modal-foot .danger').click();
    assert.equal((await heard).title, 'Thunderbolt');
    await expectLive((state) => state.trainerB.active.hp.current, 90);
  });

  it('fires the hype shortcuts T and P', async () => {
    const topdeck = producer.expect('announce', (announcement) => announcement.type === 'topdeck');
    await press('t');
    assert.equal((await topdeck).side, 'trainerA');
    const passed = producer.expect('announce', (announcement) => announcement.type === 'passturn');
    await press('p');
    await passed;
  });

  it('undoes with Ctrl+Z and redoes with Ctrl+Y', async () => {
    await press('ArrowDown');
    await expectLive((state) => state.trainerA.prizes.count, 5);
    await press('Control+z');
    await expectLive((state) => state.trainerA.prizes.count, 6);
    await press('Control+y');
    await expectLive((state) => state.trainerA.prizes.count, 5);
    await press('Control+z');
    await expectLive((state) => state.trainerA.prizes.count, 6);
    await press('Control+Shift+z');
    await expectLive((state) => state.trainerA.prizes.count, 5);
  });

  it('lists every shortcut with ?', async () => {
    await press('?');
    await page.waitForSelector('.modal');
    const text = await modal().textContent();
    for (const label of ['Deploy a new Active Pokémon', 'Edit the bench', 'Knock out', 'Stadium', 'Abilities', 'Redo', 'Announce an attack']) {
      assert.match(text, new RegExp(label));
    }
    await press('Escape');
    assert.equal(await modal().count(), 0);
  });

  it('refuses a click that another producer already made, and says so', async () => {
    const seen = (await live()).revision;
    await producer.act('action:trainerA', { action: 'prizeMinus' }); // Maya takes the prize first
    await page.waitForFunction((revision) => window.oto.conn.live.revision > revision, seen);
    // pretend this page has not heard about it yet, as when an update is slow to arrive
    await page.evaluate((revision) => { window.oto.conn.live.revision = revision; }, seen);

    await page.locator('.trainer-panel.side-a .prize-row .round-btn').first().click();
    await page.waitForSelector('.toast-warning');
    assert.match((await toasts()).join(' '), /Maya just changed this/);
    await wait(250);
    assert.equal((await live()).trainerA.prizes.count, 5, 'taken once, not twice');
  });

  it('keeps a draft private until it is sent', async () => {
    await page.locator('.draft-toggle').click();
    await page.waitForSelector('.draft-banner:not([hidden])');
    await press('ArrowDown');
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('2 changes'));
    assert.equal((await prizeNumber('a').textContent()).trim(), '4', 'the page shows the draft');
    assert.equal((await live()).trainerA.prizes.count, 6, 'the live game is untouched');

    await page.locator('.draft-banner button', { hasText: 'Send to overlay' }).click();
    await expectLive((state) => state.trainerA.prizes.count, 4);
    await page.waitForFunction(() => document.querySelector('.draft-banner').hidden);
    await page.waitForSelector('.toast-success');
    assert.match((await toasts()).join(' '), /Sent 2 changes to the overlay/);
    assert.match(await page.locator('.feed').textContent(), /Sent 2 changes/);
  });

  it('sends a draft with Ctrl+Enter', async () => {
    await page.locator('.draft-toggle').click();
    await page.waitForSelector('.draft-banner:not([hidden])');
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
    await press('Control+Enter');
    await expectLive((state) => state.trainerA.prizes.count, 5);
  });

  it('can throw a draft away', async () => {
    await page.locator('.draft-toggle').click();
    await page.waitForSelector('.draft-banner:not([hidden])');
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
    await page.locator('.draft-banner button', { hasText: 'Discard' }).click();
    await page.locator('.modal button', { hasText: 'Discard' }).click();
    await page.waitForFunction(() => document.querySelector('.draft-banner').hidden);
    assert.equal((await live()).trainerA.prizes.count, 6);
    await page.waitForFunction(() => document.querySelector('.trainer-panel.side-a .prize-number').textContent.trim() === '6');
  });

  it('says so when it is not connected', async () => {
    await page.evaluate(() => window.oto.conn.socket.disconnect());
    await page.waitForFunction(() => document.querySelector('.conn-pill').textContent.includes('Reconnecting'));
    await press('ArrowDown');
    await page.waitForSelector('.toast-error');
    assert.match((await toasts()).join(' '), /Not connected/);
    assert.equal((await live()).trainerA.prizes.count, 6);

    await page.evaluate(() => window.oto.conn.socket.connect());
    await page.waitForFunction(() => document.querySelector('.conn-pill').textContent === 'Connected');
  });
});
