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
    const special = { id: 'sv-3', name: 'Double Turbo Energy', supertype: 'Energy', subtypes: ['Special'], number: '3', rarity: 'Uncommon', set: { id: 'sv', name: 'Test' }, images: { small: ART('double-turbo'), large: ART('double-turbo') } };
    const stadium = { id: 'sv-2', name: 'Area Zero', supertype: 'Trainer', subtypes: ['Stadium'], number: '2', rarity: 'Uncommon', set: { id: 'sv', name: 'Test' }, images: { small: ART('area-zero'), large: ART('area-zero') } };
    api = await startMockCardApi({
      '/cards/sv-1': { data: { ...pokemon, abilities: [{ name: 'Resolute Heart' }] } },
      // a Stadium search answers with a Stadium, a Special Energy search with a Special Energy card, anything else with the Pokémon
      '/cards?': (url) => ({ data: [decodeURIComponent(url).includes('subtypes:"Stadium"') ? stadium : decodeURIComponent(url).includes('subtypes:"Special"') ? special : pokemon], totalCount: 1, page: 1, pageSize: 20 })
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

  it('sets a penalty with the stepper next to the prize cards, shown in red on the prize pips', async () => {
    const stepper = page.locator('.trainer-panel.side-a .penalty-row');
    const number = () => stepper.locator('.penalty-number');
    const redPips = () => page.locator('.trainer-panel.side-a .pip.penalty').count();
    assert.equal((await number().textContent()).trim(), '0');
    assert.equal(await redPips(), 0);

    await stepper.getByRole('button', { name: 'One more prize card in red' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 1);
    await stepper.getByRole('button', { name: 'One more prize card in red' }).click();
    await stepper.getByRole('button', { name: 'One more prize card in red' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 3);
    assert.equal((await number().textContent()).trim(), '3');
    assert.equal(await redPips(), 3, 'the first three of the prize cards are red');
    assert.match(await number().getAttribute('class'), /\bon\b/);
    assert.equal(await page.locator('.trainer-panel.side-b .pip.penalty').count(), 0, 'the other trainer is not marked');

    await stepper.getByRole('button', { name: 'One prize card less in red' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 2);

    // never below none and never above six
    for (let i = 0; i < 4; i++) await stepper.getByRole('button', { name: 'One prize card less in red' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 0);
    assert.doesNotMatch(await number().getAttribute('class'), /\bon\b/);
    for (let i = 0; i < 8; i++) await stepper.getByRole('button', { name: 'One more prize card in red' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 6);

    // a prize card that has been taken cannot be red
    await producer.act('action:trainerA', { action: 'prizeSet', count: 2 });
    await page.waitForFunction(() => document.querySelectorAll('.trainer-panel.side-a .pip.penalty').length === 2);
  });

  it('shows the energy icons on a Pokémon and in the energy editor', async () => {
    await producer.act('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'psychic', count: 2 });
    await page.waitForSelector('.trainer-panel.side-a .energy-chip');
    const chip = await page.$eval('.trainer-panel.side-a .energy-chip', (node) => ({ image: getComputedStyle(node).backgroundImage, border: getComputedStyle(node).borderTopWidth }));
    assert.match(chip.image, /\/assets\/energy\/psychic\.png/);
    assert.equal(chip.border, '0px');

    await press('e');
    await modal().waitFor();
    const dots = await page.$$eval('.energy-pick .energy-dot', (nodes) => nodes.map((node) => getComputedStyle(node).backgroundImage));
    assert.equal(dots.length, 11);
    assert.ok(dots.every((image) => /\/assets\/energy\/[a-z]+\.png/.test(image)), 'a picture for every type');
    assert.equal(new Set(dots).size, 11, 'each its own');
    assert.deepEqual(page.problems, []);
  });

  it('attaches a Special Energy card from the energy editor, found by search, shown as a circle of the card', async () => {
    await press('e');
    await modal().waitFor();
    assert.match(await modal().textContent(), /Special Energy cards.*Shown as a circle cut out of the card/);
    await page.getByRole('button', { name: 'Add a Special Energy card…' }).click();
    const picker = page.locator('.modal[aria-label^="Special Energy"]');
    await picker.waitFor();
    assert.match(await picker.getAttribute('aria-label'), /Special Energy · Ash/);
    assert.equal(await page.locator('.modal').count(), 2, 'it opens over the energy editor, which stays');

    await picker.locator('input[type="search"]').fill('turbo');
    await picker.locator('.card-pick').first().waitFor();
    assert.match(await picker.locator('.card-name').first().textContent(), /Double Turbo Energy/);
    assert.equal(await picker.locator('.filter-chips').count(), 0, 'only Special Energy cards are searched, so no choice of kind');
    const asked = api.requests.map((url) => decodeURIComponent(url)).filter((url) => url.includes('Special'));
    assert.ok(asked.length > 0 && asked.every((url) => /supertype:"Energy"/.test(url) && /subtypes:"Special"/.test(url)), asked.join(' | '));

    await picker.locator('.card-pick').first().click();
    await expectLive((state) => state.trainerA.active.specialEnergies.map((card) => [card.cardId, card.name, card.image]), [['sv-3', 'Double Turbo Energy', ART('double-turbo')]]);
    await expectLive((state) => state.trainerA.resources.energyPerTurn.used, 1, 'it used the turn\'s attachment');
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1);
    assert.equal(await modal().locator('.energy-chip.special').count(), 1, 'the energy editor shows it as attached');
    assert.equal(await page.locator('.trainer-panel.side-a .mon-card .energy-chip.special img').count(), 1, 'and so does the Pokémon');
    const geometry = await page.$eval('.trainer-panel.side-a .mon-card .energy-chip.special', (chip) => ({ w: chip.offsetWidth, overflow: getComputedStyle(chip).overflow, radius: getComputedStyle(chip).borderTopLeftRadius }));
    assert.deepEqual(geometry, { w: 24, overflow: 'hidden', radius: '50%' });

    // a special attachment does not use the turn's attachment up again, and a card is taken off by clicking it
    await modal().locator('.switch', { hasText: "Counts as this turn's energy attachment" }).click();
    await page.getByRole('button', { name: 'Add a Special Energy card…' }).click();
    await page.locator('.modal[aria-label^="Special Energy"] input[type="search"]').fill('turbo');
    await page.locator('.modal[aria-label^="Special Energy"] .card-pick').first().click();
    await expectLive((state) => state.trainerA.active.specialEnergies.length, 2);
    await expectLive((state) => state.trainerA.resources.energyPerTurn.used, 1, 'a special attachment leaves it alone');

    await modal().locator('.energy-chip.special').first().click();
    await expectLive((state) => state.trainerA.active.specialEnergies.length, 1);
    await press('Escape'); // the panel behind the dialog is out of reach while it is open
    await dialogClosed();
    await page.locator('.trainer-panel.side-a .mon-card .energy-chip.special').click();
    await expectLive((state) => state.trainerA.active.specialEnergies.length, 0);
    assert.deepEqual(page.problems, []);
  });

  it('keeps the Special Energy button for a Pokémon that is there', async () => {
    await press('2'); // Gary's Charizard is out; take it away, and then there is nothing to attach to
    await producer.act('action:trainerB', { action: 'clearSlot', slot: -1 });
    await page.waitForFunction(() => !document.querySelector('.trainer-panel.side-b .mon-card'));
    await press('e');
    await modal().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add a Special Energy card…' }).isDisabled(), true);
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
    // damage and healing come in tens: 25 is taken as the nearest ten
    await modal().locator('.amount-input').fill('25');
    assert.match(await modal().locator('.preview-row').textContent(), /Charizard.*110 → 140/);
    await press('Enter');
    await expectLive((state) => state.trainerB.active.hp.current, 140);
  });

  it('brings a damage typed in to the nearest ten when the box is left', async () => {
    await press('d');
    await page.waitForSelector('.modal');
    await modal().locator('.amount-input').fill('44');
    await modal().locator('.amount-input').press('Tab');
    assert.equal(await modal().locator('.amount-input').inputValue(), '40');
    assert.match(await modal().textContent(), /In tens: 10, 20, 30/);
    await modal().locator('.amount-input').fill('7');
    await modal().locator('.amount-input').press('Tab');
    assert.equal(await modal().locator('.amount-input').inputValue(), '10');
  });

  it('has no victory buttons in the hype: whoever takes the last prize card wins by itself', async () => {
    assert.equal(await page.locator('.hype-grid button', { hasText: 'Victory' }).count(), 0);
    assert.equal(await page.locator('.hype-grid button', { hasText: 'Game start' }).count(), 1);

    await producer.act('action:trainerA', { action: 'prizeSet', count: 1 });
    await expectLive((state) => state.trainerA.prizes.count, 1);
    const won = producer.expect('announce', (announcement) => announcement.type === 'win');
    await press('ArrowDown'); // Ash takes the last one
    const victory = await won;
    assert.equal(victory.side, 'trainerA');
    assert.match(victory.subtitle, /Ash wins/);
    await expectLive((state) => state.trainerA.prizes.count, 0);
  });

  describe('the attack dialog', () => {
    const picks = () => modal().locator('.attack-pick:not(.ability)');
    const damageBox = () => modal().locator('.amount-input');

    beforeEach(async () => {
      await producer.act('action:trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: IMG, hp: 100, abilities: ['Static'], attacks: [{ name: 'Gnaw', damage: '20' }, { name: 'Thunder Jolt', damage: '30+' }] });
      await expectLive((state) => state.trainerA.active.attacks.map((attack) => attack.name), ['Gnaw', 'Thunder Jolt']);
    });

    it('lists what the card can do, takes the damage of the attack as the base, and lets it be changed in tens', async () => {
      await press('c');
      await page.waitForSelector('.modal');
      assert.match(await modal().locator('.modal-sub').textContent(), /Ash attacks Gary/);
      assert.deepEqual(await picks().locator('.attack-name').allTextContents(), ['Gnaw', 'Thunder Jolt']);
      assert.deepEqual(await picks().locator('.attack-damage').allTextContents(), ['20', '30+']);
      assert.deepEqual(await picks().locator('kbd').allTextContents(), ['1', '2']);
      assert.match(await modal().locator('.attack-pick.ability').textContent(), /Static/);
      assert.equal(await modal().locator('.attack-pick.ability kbd').textContent(), '3');

      await press('2');
      assert.equal(await modal().locator('input[aria-label="Attack name"]').inputValue(), 'Thunder Jolt');
      assert.equal(await damageBox().inputValue(), '30');
      assert.match(await modal().locator('.hint-line').textContent(), /The card says 30\+: and more with some conditions/);
      assert.equal(await modal().locator('.attack-pick.on .attack-name').textContent(), 'Thunder Jolt');

      // the stepper moves in tens, and Base brings the card's damage back
      await modal().getByRole('button', { name: '10 more' }).click();
      await modal().getByRole('button', { name: '10 more' }).click();
      assert.equal(await damageBox().inputValue(), '50');
      await modal().getByRole('button', { name: 'Base 30' }).click();
      assert.equal(await damageBox().inputValue(), '30');
      assert.equal(await modal().getByRole('button', { name: 'Base 30' }).isVisible(), false, 'nothing to go back to');
      await modal().getByRole('button', { name: '10 less' }).click();
      assert.equal(await damageBox().inputValue(), '20');

      // a number typed in is taken to the nearest ten
      await damageBox().fill('64');
      await damageBox().press('Tab');
      assert.equal(await damageBox().inputValue(), '60');

      const heard = producer.expect('announce', (announcement) => announcement.type === 'attack');
      await modal().locator('.modal-foot .danger').click();
      const announced = await heard;
      assert.equal(announced.title, 'Thunder Jolt');
      assert.equal(announced.subtitle, '60 damage');
      assert.equal(announced.data.source, 'trainerA');
      await expectLive((state) => state.trainerB.active.hp.current, 90);
      await dialogClosed();
    });

    it('announces with the keyboard alone: C, the number of the attack, Enter', async () => {
      const heard = producer.expect('announce', (announcement) => announcement.type === 'attack');
      await press('c');
      await page.waitForSelector('.modal');
      await press('1');
      await press('Enter');
      const announced = await heard;
      assert.equal(announced.title, 'Gnaw');
      assert.equal(announced.subtitle, '20 damage');
      await expectLive((state) => state.trainerB.active.hp.current, 130);
      await dialogClosed();
    });

    it('can leave the damage off the Pokémon', async () => {
      await press('c');
      await page.waitForSelector('.modal');
      await press('1');
      await modal().locator('.switch', { hasText: 'Also apply the damage' }).click();
      const heard = producer.expect('announce', (announcement) => announcement.type === 'attack');
      await press('Enter');
      assert.equal((await heard).subtitle, '20 damage');
      await dialogClosed();
      assert.equal((await live()).trainerB.active.hp.current, 150, 'announced, not applied');
    });

    it('announces an ability the same way, and marks its token used', async () => {
      await press('c');
      await page.waitForSelector('.modal');
      await modal().locator('.attack-pick.ability').click();
      assert.match(await modal().locator('.modal-body').textContent(), /Mark Static as used/);
      assert.equal(await damageBox().count(), 0, 'an ability has no damage');
      assert.equal(await modal().locator('.modal-foot .danger').textContent(), 'Announce ability');
      const heard = producer.expect('announce', (announcement) => announcement.type === 'attack' && announcement.data && announcement.data.ability === true);
      await modal().locator('.modal-foot .danger').click();
      const announced = await heard;
      assert.equal(announced.title, 'Static');
      assert.equal(announced.subtitle, 'ABILITY USED');
      assert.equal(announced.side, 'trainerA', 'the trainer who uses it');
      await expectLive((state) => state.trainerA.active.abilities.map((ability) => ability.used), [true]);
      assert.equal((await live()).trainerB.active.hp.current, 150, 'nobody is damaged by an ability');
      await dialogClosed();

      // one that is already used is announced again without being marked twice
      await press('c');
      await page.waitForSelector('.modal');
      assert.match(await modal().locator('.attack-pick.ability').textContent(), /USED/);
      await modal().locator('.attack-pick.ability').click();
      assert.equal(await modal().locator('.switch input').isChecked(), false);
      await modal().locator('.modal-foot .danger').click();
      await dialogClosed();
    });

    it('lists the abilities of the Pokémon on the bench too', async () => {
      await producer.act('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-2', name: 'Eevee', image: IMG, hp: 60, abilities: ['Adaptability'] });
      await expectLive((state) => state.trainerA.bench[0].abilities.map((ability) => ability.name), ['Adaptability']);
      await press('c');
      await page.waitForSelector('.modal');
      assert.deepEqual(await modal().locator('.attack-pick.ability .attack-name').allTextContents(), ['Static Pikachu · Active', 'Adaptability Eevee · Bench 1']);
      await modal().locator('.attack-pick.ability', { hasText: 'Adaptability' }).click();
      const heard = producer.expect('announce', (announcement) => announcement.data && announcement.data.ability === true);
      await modal().locator('.modal-foot .danger').click();
      assert.equal((await heard).title, 'Adaptability');
      await expectLive((state) => [state.trainerA.active.abilities[0].used, state.trainerA.bench[0].abilities[0].used], [false, true]);
    });

    it('lets the other trainer attack, and the announcement says so', async () => {
      await producer.act('action:trainerB', { action: 'setActive', cardId: 'b-1', name: 'Charizard', image: IMG, hp: 150, attacks: [{ name: 'Flamethrower', damage: '90' }] });
      await expectLive((state) => state.trainerB.active.attacks.map((attack) => attack.name), ['Flamethrower']);
      await press('c');
      await page.waitForSelector('.modal');
      await modal().locator('.side-tab', { hasText: 'Gary' }).click();
      assert.match(await modal().locator('.modal-sub').textContent(), /Gary attacks Ash/);
      assert.deepEqual(await picks().locator('.attack-name').allTextContents(), ['Flamethrower']);
      await modal().locator('.attack-pick').first().click();
      const heard = producer.expect('announce', (announcement) => announcement.type === 'attack');
      await modal().locator('.modal-foot .danger').click();
      const announced = await heard;
      assert.equal(announced.data.source, 'trainerB', 'even though it is Ash\'s turn');
      assert.equal(announced.data.target, 'trainerA');
      await expectLive((state) => state.trainerA.active.hp.current, 10);
    });

    it('says so when the card lists no attacks, and still takes one typed in', async () => {
      await press('c');
      await page.waitForSelector('.modal');
      await modal().locator('.side-tab', { hasText: 'Gary' }).click();
      assert.match(await modal().locator('.empty').textContent(), /no attacks on file/);
      assert.equal(await modal().locator('.attack-pick').count(), 0);
      await modal().locator('input[aria-label="Attack name"]').fill('Hyper Beam');
      await damageBox().fill('120');
      const heard = producer.expect('announce', (announcement) => announcement.type === 'attack');
      await press('Enter');
      assert.equal((await heard).title, 'Hyper Beam');
      await expectLive((state) => state.trainerA.active.hp.current, 0);
    });
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

  it('marks the GX attack and the VSTAR Power used with their own tokens, and a new game gives them back', async () => {
    const token = (side, name) => page.locator(`.trainer-panel.side-${side} .token-btn`, { hasText: name });
    assert.match(await page.locator('.trainer-panel.side-a .block-title.sub', { hasText: 'This game' }).textContent(), /back when the game ends/);
    assert.match(await token('a', 'GX attack').textContent(), /ready/);
    assert.match(await token('a', 'VSTAR Power').textContent(), /ready/);

    await token('a', 'GX attack').click();
    await expectLive((state) => [state.trainerA.resources.gxPerGame.used, state.trainerA.resources.vstarPerGame.used], [1, 0]);
    await page.waitForSelector('.trainer-panel.side-a .token-btn.used:has-text("GX attack")');
    assert.match(await token('a', 'GX attack').textContent(), /used/);
    assert.match(await token('b', 'GX attack').textContent(), /ready/, 'the other trainer has theirs');

    await token('b', 'VSTAR Power').click();
    await expectLive((state) => state.trainerB.resources.vstarPerGame.used, 1);

    // clicking a used one gives it back
    await token('a', 'GX attack').click();
    await expectLive((state) => state.trainerA.resources.gxPerGame.used, 0);
    await token('a', 'GX attack').click();
    await expectLive((state) => state.trainerA.resources.gxPerGame.used, 1);

    // a new game gives them all back
    await page.getByRole('button', { name: 'New game' }).click();
    await expectLive((state) => [state.trainerA.resources.gxPerGame.used, state.trainerB.resources.vstarPerGame.used], [0, 0]);
    await page.waitForFunction(() => document.querySelectorAll('.token-btn.used').length === 0);
    assert.deepEqual(page.problems, []);
  });

  it('puts special conditions and Trapped on the Active Pokémon with the chips under it', async () => {
    const chip = (side, key) => page.locator(`.trainer-panel.side-${side} .condition-chip[data-condition="${key}"]`);
    assert.deepEqual(await page.locator('.trainer-panel.side-a .condition-chip').allTextContents(), ['Asleep', 'Burned', 'Confused', 'Paralyzed', 'Poisoned', 'Trapped']);
    assert.equal(await page.locator('.trainer-panel.side-a .mon-card.compact .condition-chip').count(), 0, 'the bench has none: only the Active Pokémon is asleep, burned or poisoned');
    assert.match(await chip('a', 'trapped').getAttribute('title'), /can't retreat/i);
    assert.equal(await chip('a', 'poisoned').getAttribute('aria-pressed'), 'false');

    await chip('a', 'poisoned').click();
    await expectLive((state) => state.trainerA.active.status, ['poisoned']);
    await page.waitForSelector('.trainer-panel.side-a .condition-chip[data-condition="poisoned"].on');
    assert.equal(await chip('a', 'poisoned').getAttribute('aria-pressed'), 'true');

    await chip('a', 'asleep').click();
    await expectLive((state) => state.trainerA.active.status, ['asleep', 'poisoned']);
    await chip('a', 'paralyzed').click();
    await expectLive((state) => state.trainerA.active.status, ['paralyzed', 'poisoned']);
    await page.waitForSelector('.trainer-panel.side-a .condition-chip[data-condition="paralyzed"].on');
    assert.equal(await page.locator('.trainer-panel.side-a .condition-chip[data-condition="asleep"].on').count(), 0, 'paralyzed took the place of asleep');

    await chip('a', 'trapped').click();
    await expectLive((state) => state.trainerA.active.status, ['paralyzed', 'poisoned', 'trapped']);
    await chip('a', 'poisoned').click();
    await expectLive((state) => state.trainerA.active.status, ['paralyzed', 'trapped']);
    await expectLive((state) => state.trainerB.active.status, [], 'the other trainer is untouched');

    // someone else cures it: the chips follow
    await producer.act('action:trainerA', { action: 'clearStatus' });
    await page.waitForFunction(() => document.querySelectorAll('.trainer-panel.side-a .condition-chip.on').length === 0);

    // it ends when the Pokémon goes to the bench
    await chip('a', 'burned').click();
    await expectLive((state) => state.trainerA.active.status, ['burned']);
    await producer.act('action:trainerA', { action: 'swapWithActive', slot: 0 });
    await expectLive((state) => [state.trainerA.active.name, state.trainerA.bench[0].status], ['Eevee', []]);
    assert.deepEqual(page.problems, []);
  });

  describe('the card picker with nothing typed', () => {
    const ask = (method, path) => fetch(`${server.base}${path}`, { method });
    const popular = async () => (await ask('GET', '/api/cards/popular')).json();
    const tiles = () => page.locator('.modal .card-tile .card-name').allTextContents();
    const status = () => page.locator('.modal .picker-status').textContent();
    const openFeature = async () => {
      await page.locator('.block-title.sub', { hasText: 'Feature cards' }).getByRole('button', { name: 'Add' }).click();
      await page.waitForSelector('.modal .search-input');
    };
    const usedCount = async (count) => {
      for (let i = 0; i < 60 && (await popular()).used !== count; i++) await wait(50);
      assert.equal((await popular()).used, count, 'the cards used so far');
    };

    beforeEach(async () => {
      await ask('DELETE', '/api/cards/used');
      await ask('POST', '/api/cache/clear');
    });

    it('lists the cards that are already saved on this computer, in the feature picker too', async () => {
      // nothing has been seen yet, and it says so
      await openFeature();
      await page.waitForFunction(() => /listed here next time/.test(document.querySelector('.modal .picker-status').textContent));
      assert.deepEqual(await tiles(), []);

      // a search saves what it finds...
      await page.locator('.search-input').fill('pika');
      await page.waitForSelector('.modal .card-tile');
      await press('Escape');
      await dialogClosed();

      // ...and the next time the picker opens it is there before anything is typed
      await openFeature();
      await page.waitForSelector('.modal .card-tile');
      assert.deepEqual(await tiles(), ['Pikachu ex']);
      assert.match(await status(), /^Cards saved on this computer \(1\)\. Type a card name to search for others\./);

      // Enter with nothing typed does not choose from a suggestion
      await press('Enter');
      await wait(300);
      assert.equal(await page.locator('.modal').count(), 1);
      assert.deepEqual((await live()).featureCards, []);

      // a click does, and the card is counted
      await page.locator('.modal .card-pick').first().click();
      await expectLive((state) => state.featureCards.map((entry) => entry.name), ['Pikachu ex']);
      await dialogClosed();
      await usedCount(1);
      assert.deepEqual(page.problems, []);
    });

    it('puts the most used cards first, for each kind of picker', async () => {
      // one Pokémon for the feature picker, one Stadium
      await openFeature();
      await page.locator('.search-input').fill('pika');
      await page.waitForSelector('.modal .card-tile');
      await press('Enter');
      await dialogClosed();
      await usedCount(1);
      await press('s');
      await page.locator('.search-input').fill('area');
      await page.waitForSelector('.modal .card-tile');
      await press('Enter');
      await expectLive((state) => state.stadium.name, 'Area Zero');
      await dialogClosed();
      await usedCount(2);

      // the Stadium picker offers Stadiums only, the most used ones
      await press('s');
      await page.waitForSelector('.modal .card-tile');
      assert.deepEqual(await tiles(), ['Area Zero']);
      assert.match(await status(), /^Your most used cards \(1\)/);
      await press('Escape');
      await dialogClosed();

      // the Active picker offers Pokémon only
      await press('a');
      await page.waitForSelector('.modal .card-tile');
      assert.deepEqual(await tiles(), ['Pikachu ex']);
      await press('Escape');
      await dialogClosed();

      // the feature picker offers everything (the latest use first among equals), and its chips narrow it
      await openFeature();
      await page.waitForSelector('.modal .card-tile');
      assert.deepEqual(await tiles(), ['Area Zero', 'Pikachu ex']);
      const chip = (name) => page.locator('.modal .filter-chips .chip', { hasText: name });
      await chip('Pokémon').click();
      await page.waitForFunction(() => document.querySelectorAll('.modal .card-tile').length === 1);
      assert.deepEqual(await tiles(), ['Pikachu ex']);
      await chip('Trainer').click();
      await page.waitForFunction(() => document.querySelector('.modal .card-tile .card-name').textContent === 'Area Zero');
      await chip('Energy').click();
      await page.waitForFunction(() => document.querySelectorAll('.modal .card-tile').length === 0);
      assert.match(await status(), /listed here next time/);
      await chip('All').click();
      await page.waitForFunction(() => document.querySelectorAll('.modal .card-tile').length === 2);

      // typing takes the suggestions away at once, and an empty box brings them back
      await page.locator('.search-input').fill('pika');
      assert.deepEqual(await tiles(), [], 'no suggestion is left to be chosen by mistake');
      await page.waitForSelector('.modal .card-tile');
      assert.deepEqual(await tiles(), ['Pikachu ex']);
      assert.match(await status(), /1 cards found/);
      await page.locator('.search-input').fill('');
      await page.waitForFunction(() => /^Your most used cards/.test(document.querySelector('.modal .picker-status').textContent));
      assert.deepEqual(await tiles(), ['Area Zero', 'Pikachu ex']);
      assert.deepEqual(page.problems, []);
    });
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
