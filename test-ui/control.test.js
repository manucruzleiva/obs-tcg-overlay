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
    producer.emit('draft:discard'); // a draft is shared: one that a test left open would be there for the next page
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

  // A penalty is set on the panel of the trainer who has it; the prize pips of the OTHER trainer are red (they count it as taken, as the
  // overlay shows)
  it('sets a penalty with the stepper next to the prize cards, shown in red on the prize pips of the other trainer', async () => {
    const stepper = page.locator('.trainer-panel.side-a .penalty-row');
    const number = () => stepper.locator('.penalty-number');
    const redPips = (side = 'b') => page.locator(`.trainer-panel.side-${side} .pip.penalty`).count();
    assert.equal((await number().textContent()).trim(), '0');
    assert.equal(await redPips(), 0);

    await stepper.getByRole('button', { name: 'Penalty: one more' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 1);
    await stepper.getByRole('button', { name: 'Penalty: one more' }).click();
    await stepper.getByRole('button', { name: 'Penalty: one more' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 3);
    assert.equal((await number().textContent()).trim(), '3');
    assert.equal(await redPips(), 3, 'the first three of the other trainer\'s prize cards are red');
    assert.match(await number().getAttribute('class'), /\bon\b/);
    assert.equal(await redPips('a'), 0, 'the trainer who has the penalty is not marked');

    await stepper.getByRole('button', { name: 'Penalty: one less' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 2);

    // never below none and never above six
    for (let i = 0; i < 4; i++) await stepper.getByRole('button', { name: 'Penalty: one less' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 0);
    assert.doesNotMatch(await number().getAttribute('class'), /\bon\b/);
    for (let i = 0; i < 8; i++) await stepper.getByRole('button', { name: 'Penalty: one more' }).click();
    await expectLive((state) => state.trainerA.prizes.penalty, 6);

    // a prize card that has been taken cannot be red
    await producer.act('action:trainerB', { action: 'prizeSet', count: 2 });
    await page.waitForFunction(() => document.querySelectorAll('.trainer-panel.side-b .pip.penalty').length === 2);
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

  // The deck of a trainer is typed under the name, with a picture box and a preview of what the overlay shows next to it
  describe('the deck', () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8Dwn4EBDAAZ6gH/8gKh1gAAAABJRU5ErkJggg==', 'base64');
    const deck = (side = 'a') => page.locator(`.trainer-panel.side-${side} input[aria-label$=" deck"]`);
    const picture = (side = 'a') => page.locator(`.trainer-panel.side-${side} input[aria-label$=" deck picture"]`);
    const preview = (side = 'a') => page.$eval(`.trainer-panel.side-${side} .deck-preview`, (img) => (img.hidden ? null : { src: img.getAttribute('src'), title: img.title }));
    const hint = (side = 'a') => page.locator(`.trainer-panel.side-${side} .deck-hint`).textContent();

    beforeEach(async () => {
      await page.route('**/img/sprite/*.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    });

    it('has a deck box and a picture box for each trainer, with what the overlay will show while it is typed', async () => {
      assert.equal(await deck('a').getAttribute('aria-label'), 'Trainer A deck');
      assert.equal(await picture('b').getAttribute('aria-label'), 'Trainer B deck picture');
      assert.equal(await picture('a').getAttribute('placeholder'), 'Automatic');
      assert.equal(await preview('a'), null);
      assert.equal(await hint('a'), '');

      await deck('a').fill('Charizard ex');
      assert.deepEqual(await preview('a'), { src: '/img/sprite/6.png', title: 'Charizard' });
      assert.equal(await hint('a'), 'Picture: Charizard (named by the deck).');
      assert.equal((await live()).trainerA.deck, '', 'nothing is sent while typing');

      await deck('a').press('Enter');
      await expectLive((state) => state.trainerA.deck, 'Charizard ex');
      assert.match(await page.locator('.feed').textContent(), /Ash deck → Charizard ex/);
      assert.deepEqual(page.problems, []);
    });

    it('takes the picture from the picture box, says when that names nothing, and none is no picture', async () => {
      await deck('a').fill('Control');
      assert.equal(await hint('a'), 'No picture: write a Pokémon or an energy type in the Picture box to add one.');
      await picture('a').fill('Gardevoir');
      assert.deepEqual(await preview('a'), { src: '/img/sprite/282.png', title: 'Gardevoir' });
      assert.equal(await hint('a'), 'Picture: Gardevoir.');

      await picture('a').fill('Agumon');
      assert.equal(await preview('a'), null);
      assert.equal(await hint('a'), '"Agumon" is not a Pokémon or an energy type: no picture.');
      assert.equal(await page.locator('.trainer-panel.side-a .deck-hint').evaluate((node) => node.classList.contains('warn')), true);

      await picture('a').fill('none');
      assert.equal(await preview('a'), null);
      assert.equal(await hint('a'), 'No picture next to the deck.');

      await picture('a').fill('Water');
      assert.deepEqual(await preview('a'), { src: '/assets/energy/water.png', title: 'Water energy' });
      await picture('a').press('Enter');
      await deck('a').focus();
      await deck('a').press('Enter');
      await expectLive((state) => [state.trainerA.deck, state.trainerA.deckIcon], ['Control', 'Water']);
    });

    it('shows a deck another producer sets, without touching what is being typed', async () => {
      await producer.act('action:trainerB', { action: 'setDeck', deck: 'Lightning GLC' });
      await page.waitForFunction(() => document.querySelector('.trainer-panel.side-b input[aria-label$=" deck"]').value === 'Lightning GLC');
      assert.deepEqual(await preview('b'), { src: '/assets/energy/lightning.png', title: 'Lightning energy' });

      await deck('b').fill('Typing');
      await producer.act('action:trainerB', { action: 'setDeck', deck: 'Something else' });
      await page.waitForFunction(() => window.oto.conn.live.trainerB.deck === 'Something else');
      assert.equal(await deck('b').inputValue(), 'Typing', 'the box being typed in is left alone');
    });

    it('offers the energy types and every Pokémon while typing, and none for the picture', async () => {
      const names = await page.$$eval('#deck-names option', (options) => options.map((option) => option.value));
      assert.deepEqual(names.slice(0, 3), ['Grass', 'Fire', 'Water']);
      assert.ok(names.includes('Charizard') && names.includes('Pecharunt'));
      assert.ok(names.length > 1030);
      assert.equal(await page.$eval('#deck-pictures option', (option) => option.value), 'none');
      assert.equal(await deck('a').getAttribute('list'), 'deck-names');
      assert.equal(await picture('a').getAttribute('list'), 'deck-pictures');
    });
  });

  // The cards that are the prizes of a trainer are chosen in a dialog with the card selector, and set all at once
  describe('the cards on the prizes', () => {
    const panel = (side = 'a') => page.locator(`.trainer-panel.side-${side}`);
    const setButton = (side = 'a') => panel(side).getByRole('button', { name: 'Set prizes', exact: true });
    const dialog = () => page.locator('.modal[aria-label^="Prize cards"]');
    const selector = () => page.locator('.modal[aria-label^="Prize card "]');
    const slot = (index) => dialog().locator('.prize-slot').nth(index);
    const apply = () => dialog().getByRole('button', { name: 'Set prizes', exact: true });
    const cardsOf = (side = 'trainerA') => (state) => state[side].prizes.cards.map((card) => card && [card.cardId, card.name, card.image]);
    const PIKACHU = ['sv-1', 'Pikachu ex', ART('pikachu-ex')];

    // choose the card of one prize card by searching for it
    async function choose(index, text = 'pikachu') {
      await slot(index).locator('.prize-pick').click();
      await selector().waitFor();
      await selector().locator('input[type="search"]').fill(text);
      await selector().locator('.card-pick').first().click();
      await selector().waitFor({ state: 'detached' });
    }

    it('has a Set prizes button with the prize cards of each trainer, which opens the six prize cards of that trainer', async () => {
      assert.equal(await setButton('a').count(), 1);
      assert.equal(await setButton('b').count(), 1);
      await setButton('a').click();
      await dialog().waitFor();
      assert.equal(await dialog().getAttribute('aria-label'), 'Prize cards · Ash');
      assert.equal(await dialog().locator('.prize-slot').count(), 6);
      assert.equal(await dialog().locator('.prize-slot.filled').count(), 0, 'no card chosen yet');
      assert.deepEqual(await dialog().locator('.prize-slot-name').allTextContents(), ['Prize 1', 'Prize 2', 'Prize 3', 'Prize 4', 'Prize 5', 'Prize 6']);
      assert.equal(await apply().isDisabled(), true, 'nothing to set yet');
      assert.equal(await dialog().getByRole('button', { name: 'Clear all' }).isDisabled(), true);
      assert.match(await dialog().textContent(), /Choose the card of each prize/);

      await press('Escape');
      await dialogClosed();
      await setButton('b').click();
      await dialog().waitFor();
      assert.equal(await dialog().getAttribute('aria-label'), 'Prize cards · Gary');
      assert.deepEqual(page.problems, []);
    });

    it('chooses the card of a prize card with the card selector, over the dialog, and sets the cards all at once', async () => {
      await setButton('a').click();
      await dialog().waitFor();
      await slot(0).locator('.prize-pick').click();
      await selector().waitFor();
      assert.equal(await selector().getAttribute('aria-label'), 'Prize card 1 · Ash');
      assert.equal(await page.locator('.modal').count(), 2, 'it opens over the dialog, which stays');
      assert.equal(await selector().locator('.filter-chips .chip').count(), 4, 'any kind of card can be a prize: All, Pokémon, Trainer and Energy');

      await selector().locator('input[type="search"]').fill('pikachu');
      await selector().locator('.card-pick').first().click();
      await selector().waitFor({ state: 'detached' });
      assert.equal(await page.locator('.modal').count(), 1, 'only the selector is closed');
      assert.equal(await slot(0).locator('img').getAttribute('src'), ART('pikachu-ex'));
      assert.equal(await slot(0).locator('.prize-slot-name').textContent(), 'Pikachu ex');
      assert.equal(await slot(0).evaluate((node) => node.classList.contains('filled')), true);
      assert.deepEqual((await live()).trainerA.prizes.cards, [null, null, null, null, null, null], 'nothing is sent until the prizes are set');

      await choose(2);
      assert.equal(await dialog().locator('.prize-slot.filled').count(), 2);
      assert.equal(await apply().isDisabled(), false);
      await apply().click();
      await expectLive(cardsOf(), [PIKACHU, null, PIKACHU, null, null, null]);
      await dialogClosed();
      assert.deepEqual((await live()).trainerB.prizes.cards, [null, null, null, null, null, null], 'the other trainer has none');
      assert.match(await page.locator('.feed').textContent(), /Ash prize cards set \(2\)/);
      assert.deepEqual(page.problems, []);
    });

    it('shows the cards on the prize pips of that trainer, grayed out when taken and red under a penalty, and a pip still sets the prizes that are left', async () => {
      await producer.act('action:trainerA', { action: 'prizeCardsSet', cards: [PIKACHU, null, PIKACHU].map((card) => card && { cardId: card[0], name: card[1], image: card[2] }) });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-panel.side-a .pip.has-card').length === 2);
      const pips = panel('a').locator('.pip');
      assert.deepEqual(await pips.evaluateAll((nodes) => nodes.map((node) => node.classList.contains('has-card'))), [true, false, true, false, false, false]);
      assert.equal(await pips.nth(0).locator('img.pip-face').isVisible(), true);
      assert.equal(await pips.nth(0).locator('img.pip-face').getAttribute('src'), ART('pikachu-ex'));
      assert.equal(await pips.nth(0).getAttribute('title'), 'Pikachu ex');
      assert.equal(await pips.nth(1).locator('img.pip-face').isVisible(), false, 'a prize card without a card is as it was');
      assert.equal(await panel('b').locator('.pip.has-card').count(), 0);

      await producer.act('action:trainerA', { action: 'prizeSet', count: 2 }); // the last four are taken
      await page.waitForFunction(() => document.querySelectorAll('.trainer-panel.side-a .pip.on').length === 2);
      assert.equal(await pips.nth(2).evaluate((node) => getComputedStyle(node).filter), 'grayscale(1)', 'a taken one is gray');
      assert.equal(await pips.nth(0).evaluate((node) => getComputedStyle(node).filter), 'none');

      await producer.act('action:trainerB', { action: 'prizePenaltySet', count: 1 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-panel.side-a .pip.penalty').length === 1);
      assert.equal(await pips.nth(0).evaluate((node) => getComputedStyle(node, '::after').backgroundColor !== 'rgba(0, 0, 0, 0)'), true, 'the penalty is a red mask on the card');

      await pips.nth(3).click();
      await expectLive((state) => state.trainerA.prizes.count, 4);
      assert.deepEqual((await live()).trainerA.prizes.cards.map((card) => card && card.name), ['Pikachu ex', null, 'Pikachu ex', null, null, null], 'the cards stay');
      assert.deepEqual(page.problems, []);
    });

    it('sets nothing when it is cancelled, and a card chosen but not set is not kept', async () => {
      await setButton('a').click();
      await dialog().waitFor();
      await choose(1);
      await dialog().getByRole('button', { name: 'Cancel' }).click();
      await dialogClosed();
      assert.deepEqual((await live()).trainerA.prizes.cards, [null, null, null, null, null, null]);
      await setButton('a').click();
      await dialog().waitFor();
      assert.equal(await dialog().locator('.prize-slot.filled').count(), 0, 'the next time it starts from what is set');
    });

    it('starts from the cards that are set, clears one or all of them, and sets what is left', async () => {
      await producer.act('action:trainerA', { action: 'prizeCardsSet', cards: [{ cardId: 'a', name: 'First', image: ART('first') }, null, { cardId: 'c', name: 'Third', image: ART('third') }] });
      await setButton('a').click();
      await dialog().waitFor();
      assert.deepEqual(await dialog().locator('.prize-slot-name').allTextContents(), ['First', 'Prize 2', 'Third', 'Prize 4', 'Prize 5', 'Prize 6']);
      assert.equal(await apply().isDisabled(), true, 'as it is set');

      await slot(0).getByRole('button', { name: 'Clear prize card 1' }).click();
      assert.equal(await slot(0).evaluate((node) => node.classList.contains('filled')), false);
      assert.equal(await apply().isDisabled(), false);
      await apply().click();
      await expectLive((state) => state.trainerA.prizes.cards.map((card) => card && card.name), [null, null, 'Third', null, null, null]);
      await dialogClosed();

      await setButton('a').click();
      await dialog().waitFor();
      await dialog().getByRole('button', { name: 'Clear all' }).click();
      assert.equal(await dialog().locator('.prize-slot.filled').count(), 0);
      await apply().click();
      await expectLive((state) => state.trainerA.prizes.cards, [null, null, null, null, null, null]);
    });

    it('shows the prize cards that are taken faded, as the overlay does', async () => {
      await producer.act('action:trainerA', { action: 'prizeSet', count: 4 });
      await page.waitForFunction(() => document.querySelectorAll('.trainer-panel.side-a .pip.on').length === 4);
      await setButton('a').click();
      await dialog().waitFor();
      assert.deepEqual(await dialog().locator('.prize-slot').evaluateAll((nodes) => nodes.map((node) => node.classList.contains('taken'))), [false, false, false, false, true, true]);
    });

    it('is for the trainer whose button it is, the other one is left alone', async () => {
      await setButton('b').click();
      await dialog().waitFor();
      await choose(5, 'pikachu');
      await apply().click();
      await expectLive((state) => state.trainerB.prizes.cards.map((card) => card && card.name), [null, null, null, null, null, 'Pikachu ex']);
      assert.deepEqual((await live()).trainerA.prizes.cards, [null, null, null, null, null, null]);
    });

    it('can be used with the keyboard: Tab to a prize card and Enter opens the card selector, Escape comes back to the dialog', async () => {
      await setButton('a').focus();
      await press('Enter');
      await dialog().waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.className.includes('prize-pick')), true, 'the first prize card has the focus');
      await press('Enter');
      await selector().waitFor();
      await press('Escape');
      await selector().waitFor({ state: 'detached' });
      assert.equal(await dialog().count(), 1, 'the dialog is still there');
    });
  });

  describe('the bench size', () => {
    it('goes back to 5 slots with the button next to Edit bench, with Shift+B, and in the bench dialog', async () => {
      const panel = (side) => page.locator(`.trainer-panel.side-${side}`);
      const slots = (side) => panel(side).locator('.bench-size').textContent();
      const reset = panel('a').getByRole('button', { name: /^Reset to 5/ });
      assert.equal(await reset.isDisabled(), true, 'it is 5 already');
      assert.match(await reset.getAttribute('title'), /usual 5 slots/);

      await producer.act('action:trainerA', { action: 'benchSizePlus' });
      await producer.act('action:trainerA', { action: 'benchSizePlus' });
      await page.waitForFunction(() => document.querySelector('.trainer-panel.side-a .bench-size').textContent === '7 slots');
      assert.equal(await reset.isDisabled(), false);
      await reset.click();
      await expectLive((state) => state.trainerA.benchSize, 5);
      assert.equal(await slots('a'), '5 slots');

      await producer.act('action:trainerB', { action: 'benchSizePlus' });
      await page.waitForFunction(() => document.querySelector('.trainer-panel.side-b .bench-size').textContent === '6 slots');
      await press('2'); // the shortcuts are for Trainer B now
      await press('Shift+B');
      await expectLive((state) => state.trainerB.benchSize, 5);

      await producer.act('action:trainerA', { action: 'benchSizeMinus' });
      await page.waitForFunction(() => document.querySelector('.trainer-panel.side-a .bench-size').textContent === '4 slots');
      await press('1');
      await press('b');
      await modal().waitFor();
      await modal().getByRole('button', { name: 'Reset to 5' }).click();
      await expectLive((state) => state.trainerA.benchSize, 5);
      assert.deepEqual(page.problems, []);
    });
  });

  describe('dragging a Pokémon', () => {
    const slot = (index, side = 'a') => page.locator(`.trainer-panel.side-${side} [data-slot="${index}"]`);
    const names = (state, side = 'trainerA') => [state[side].active.name, ...state[side].bench.slice(0, 3).map((pokemon) => pokemon.name)];

    it('moves a Pokémon of the bench to an empty slot', async () => {
      await slot(0).dragTo(slot(2), { sourcePosition: { x: 12, y: 12 } });
      await expectLive((state) => names(state), ['Pikachu', '', '', 'Eevee']);
      assert.match(await page.locator('.feed').textContent(), /Eevee/);
    });

    it('changes places with the Pokémon it is dropped on, the Active one too', async () => {
      await slot(0).dragTo(slot(-1), { sourcePosition: { x: 12, y: 12 } });
      await expectLive((state) => names(state), ['Eevee', 'Pikachu', '', '']);
      // and back, from the Active spot to the bench
      await slot(-1).dragTo(slot(0), { sourcePosition: { x: 12, y: 12 } });
      await expectLive((state) => names(state), ['Pikachu', 'Eevee', '', '']);
    });

    it('does nothing when it is dropped where it was, or on the other trainer', async () => {
      const before = (await live()).revision;
      await slot(0).dragTo(slot(0, 'b'), { sourcePosition: { x: 12, y: 12 } });
      await slot(0).dragTo(slot(0), { sourcePosition: { x: 12, y: 12 }, targetPosition: { x: 30, y: 30 } });
      await wait(300);
      const after = await live();
      assert.deepEqual(names(after), ['Pikachu', 'Eevee', '', '']);
      assert.equal(after.trainerB.bench[0].name, '', 'Gary\'s bench is as it was');
      assert.equal(after.revision, before, 'nothing was sent');
      assert.equal(await page.locator('.drop-target, .dragging').count(), 0, 'and nothing stays highlighted');
    });
  });

  it('attaches another energy of the same type with a right click on an energy, as the turn\'s attachment while it is free', async () => {
    await producer.act('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'lightning', count: 1, countsAsTurn: false });
    const chip = () => page.locator('.trainer-panel.side-a .mon-card[data-slot="-1"] .energy-chip[data-energy="lightning"]').first();
    await chip().waitFor();
    assert.match(await chip().getAttribute('title'), /right-click to add another/);
    await chip().click({ button: 'right' });
    await expectLive((state) => [state.trainerA.active.energies, state.trainerA.resources.energyPerTurn.used], [['lightning', 'lightning'], 1]);
    await chip().click({ button: 'right' });
    await expectLive((state) => [state.trainerA.active.energies.length, state.trainerA.resources.energyPerTurn.used], [3, 1], 'the next one is a special attachment');
    await chip().click();
    await expectLive((state) => state.trainerA.active.energies.length, 2, 'a click still takes one off');
    assert.deepEqual(page.problems, []);
  });

  it('puts a Stadium in play with the Stadium play of the player whose turn it is, of the other player, or of nobody', async () => {
    const used = (state) => [state.trainerA.resources.stadiumPerTurn.used, state.trainerB.resources.stadiumPerTurn.used];
    const picker = page.locator('.modal[aria-label="Stadium"]');
    await press('s');
    await picker.waitFor();
    assert.match(await picker.locator('.stadium-play').textContent(), /Played by/);
    assert.equal(await picker.locator('.stadium-play .side-tab.on').textContent(), 'Ash', 'whoever has the turn');
    assert.match(await picker.locator('.stadium-play .hint-line').textContent(), /Uses up the turn's Stadium play/);
    await picker.locator('input[type="search"]').fill('area');
    await picker.locator('.card-pick').first().click();
    await expectLive((state) => [state.stadium.name, ...used(state)], ['Area Zero', 1, 0]);
    await dialogClosed();

    await press('s');
    await picker.waitFor();
    assert.match(await picker.locator('.stadium-play .hint-line').textContent(), /already played a Stadium this turn/);
    await picker.locator('.stadium-play .side-tab', { hasText: 'Gary' }).click();
    assert.match(await picker.locator('.stadium-play .switch-label').textContent(), /Uses Gary's Stadium play/);
    await picker.locator('input[type="search"]').fill('area');
    await picker.locator('.card-pick').first().click();
    await expectLive((state) => used(state), [1, 1]);
    await dialogClosed();

    await producer.act('action:trainerB', { action: 'stadiumReset' });
    await press('s');
    await picker.waitFor();
    await picker.locator('.stadium-play .switch').click(); // a correction: no Stadium play is used
    assert.match(await picker.locator('.stadium-play .hint-line').textContent(), /stays available/);
    await picker.locator('input[type="search"]').fill('area');
    await picker.locator('.card-pick').first().click();
    await dialogClosed();
    assert.deepEqual(used(await live()), [1, 0]);
  });

  it('shows the art of the Pokémon cards, or the whole card, as this browser is set to, and remembers it', async () => {
    assert.equal(await page.locator('.trainer-panel .mon-art').count(), 3);
    assert.equal(await page.locator('.trainer-panel .mon-art.cropped').count(), 3, 'just the art at first');
    await page.locator('button[aria-label="Settings"]').click();
    await page.locator('.tab', { hasText: 'General' }).click();
    const choice = page.locator('.segmented[aria-label="What the Pokémon cards show in this control panel"]');
    assert.equal(await choice.locator('button.on').textContent(), 'Art only');
    await choice.getByRole('button', { name: 'Whole card' }).click();
    assert.equal(await choice.locator('button[aria-pressed="true"]').textContent(), 'Whole card');
    await press('Escape');
    await dialogClosed();
    assert.equal(await page.locator('.trainer-panel .mon-art.cropped').count(), 0);
    assert.equal(await page.evaluate(() => window.localStorage.getItem('oto-card-view')), 'full');
    assert.equal((await live()).settings.display.activePokemon, true, 'the overlay is not touched');

    await page.reload();
    await page.waitForSelector('.trainer-panel.side-a .mon-card');
    assert.equal(await page.locator('.trainer-panel .mon-art.cropped').count(), 0, 'this browser remembers it');
    await page.evaluate(() => window.oto.setCardView('art'));
    assert.equal(await page.locator('.trainer-panel .mon-art.cropped').count(), 3);
  });

  describe('the Stadium and the feature cards', () => {
    const FEATURES = '.feature-block';
    const names = () => page.locator(`${FEATURES} .feature-item`).evaluateAll((items) => items.map((item) => (item.querySelector('.sign') || item.querySelector('.feature-text')).textContent));
    const stadiumBox = () => page.locator('.stadium-art').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const image = node.querySelector('img');
      const picture = image && image.getBoundingClientRect();
      return { w: rect.width, h: rect.height, cropped: node.classList.contains('cropped'), image: picture && { w: picture.width, h: picture.height, left: picture.left - rect.left, top: picture.top - rect.top } };
    });

    it('are two blocks of their own, and the Stadium is not part of the feature cards', async () => {
      assert.equal(await page.locator('.table-block').count(), 0);
      assert.equal(await page.locator('.stadium-block .block-title').textContent(), 'Stadium');
      assert.match(await page.locator(`${FEATURES} .block-title`).textContent(), /^Feature cards/);
      assert.equal(await page.locator('.stadium-block .feature-list').count(), 0);
      assert.equal(await page.locator(`${FEATURES} .stadium-row`).count(), 0);
      assert.deepEqual(page.problems, []);
    });

    it('shows just the art of the Stadium card, as the overlay does, and the whole card when this browser is set to it', async () => {
      await producer.act('action:card', { action: 'setStadium', cardId: 'sv-2', name: 'Area Zero', image: ART('area-zero') });
      await expectLive((state) => state.stadium.name, 'Area Zero');
      await page.waitForSelector('.stadium-art img');
      const art = await stadiumBox();
      assert.ok(art.cropped, 'the art only, at first');
      assert.ok(art.w > art.h, `the window of the picture is wide (${art.w} x ${art.h})`);
      // the card is drawn bigger than the window, and moved so that only the picture of it shows
      assert.ok(art.image.w > art.w * 1.1 && art.image.h > art.h * 2, JSON.stringify(art));
      assert.ok(art.image.left < 0 && art.image.top < 0, 'the frame of the card is out of the window');

      await page.evaluate(() => window.oto.setCardView('full'));
      const whole = await stadiumBox();
      assert.equal(whole.cropped, false);
      assert.ok(whole.h > whole.w, 'the whole card is taller than it is wide');
      assert.ok(whole.h > art.h, 'and taller than its art');
      await page.evaluate(() => window.oto.setCardView('art'));
      assert.equal((await stadiumBox()).cropped, true);
      assert.deepEqual(page.problems, []);
    });

    it('lists the featured cards in the order they were added, with the signs between them, and removes either', async () => {
      const add = (name) => producer.act('action:card', { action: 'addFeatureCard', cardId: name, name, image: IMG });
      await add('Boss Orders');
      await producer.act('action:card', { action: 'addFeatureSeparator', symbol: '+' });
      await add('Ultra Ball');
      await expectLive((state) => state.featureCards.length, 3);
      assert.deepEqual(await names(), ['Boss Orders', '+', 'Ultra Ball']);

      // the buttons add a sign after the last card
      const signs = page.locator(`${FEATURES} .sign-btn`);
      assert.deepEqual(await signs.allTextContents(), ['+', '→', '=', 'or']);
      await signs.nth(1).click();
      await expectLive((state) => state.featureCards.map((entry) => entry.separator || entry.name), ['Boss Orders', '+', 'Ultra Ball', '→']);
      assert.deepEqual(await names(), ['Boss Orders', '+', 'Ultra Ball', '→']);
      assert.equal(await page.locator(`${FEATURES} .feature-sign`).count(), 2);

      await page.locator(`${FEATURES} .feature-sign`).first().getByRole('button', { name: 'Remove the sign +' }).click();
      await expectLive((state) => state.featureCards.map((entry) => entry.separator || entry.name), ['Boss Orders', 'Ultra Ball', '→']);
      await page.locator(`${FEATURES} .feature-item`).first().getByRole('button', { name: 'Remove Boss Orders' }).click();
      await expectLive((state) => state.featureCards.map((entry) => entry.separator || entry.name), ['Ultra Ball', '→']);
      assert.deepEqual(page.problems, []);
    });
  });

  it('shows who else is producing and what they do', async () => {
    await producer.act('action:trainerB', { action: 'prizeMinus' });
    await page.waitForFunction(() => document.querySelector('.feed').textContent.includes('(5 left)'));
    assert.match(await page.locator('.feed').textContent(), /Maya.*Gary prizes −1 \(5 left\)/);
    assert.match(await page.locator('.people').textContent(), /Maya/);
  });

  describe('the producers at the top', () => {
    const person = (name) => page.locator('.people .person', { hasText: name });
    const myName = () => page.evaluate(() => window.oto.conn.you.name);

    it('rename you with a double click on your name: Enter keeps it, Escape leaves it', async () => {
      const mine = page.locator('.people .person.me');
      await mine.dblclick();
      const box = page.locator('.people .person-edit');
      await box.waitFor();
      assert.equal(await box.inputValue(), await myName());
      await box.fill('Nova');
      await box.press('Escape');
      assert.equal(await page.locator('.people .person-edit').count(), 0);
      assert.notEqual(await myName(), 'Nova', 'Escape leaves the name as it was');

      await page.locator('.people .person.me').dblclick();
      await page.locator('.people .person-edit').fill('Nova');
      await page.locator('.people .person-edit').press('Enter');
      await page.waitForFunction(() => window.oto.conn.you.name === 'Nova');
      assert.match(await page.locator('.people .person.me .person-name').textContent(), /Nova/);
      assert.equal(await page.evaluate(() => window.localStorage.getItem('oto-producer-name')), 'Nova', 'and it is remembered');
      await page.evaluate(() => window.oto.conn.rename('Producer 1'));
      assert.deepEqual(page.problems, []);
    });

    it('lets the host rename the others and remove them, and tells the one who is removed', async () => {
      const guest = server.client({ clientId: 'ui-guest-producer', name: 'Guest', guest: true });
      await guest.ready();
      await person('Guest').waitFor();
      assert.equal(await person('Guest').locator('.kick-btn').count(), 1, 'the host can remove them');
      assert.equal(await person('Maya').locator('.kick-btn').count(), 0, 'but not the other pages of the computer that runs OTO');

      const told = guest.expect('you', (you) => you.name === 'Sam');
      await person('Guest').dblclick();
      await page.locator('.people .person-edit').fill('Sam');
      await page.locator('.people .person-edit').press('Enter');
      await told;
      await person('Sam').waitFor();

      const gone = guest.expect('kicked');
      await person('Sam').locator('.kick-btn').click();
      const ask = page.locator('.modal[aria-label="Remove Sam?"]');
      await ask.waitFor();
      await ask.getByRole('button', { name: 'Cancel' }).click();
      assert.equal(guest.socket.connected, true, 'asked first, and Cancel leaves them');
      await person('Sam').locator('.kick-btn').click();
      await ask.getByRole('button', { name: 'Remove', exact: true }).click();
      assert.equal((await gone).by.length > 0, true);
      await page.waitForFunction(() => ![...document.querySelectorAll('.people .person-name')].some((node) => node.textContent === 'Sam'));
      assert.match(await page.locator('.forgive-btn').textContent(), /Let 1 removed back in/);
      await page.locator('.forgive-btn').click();
      await page.waitForFunction(() => document.querySelector('.forgive-btn').hidden);
      assert.deepEqual(page.problems, []);
    });

    it('offers nothing about the others to a page that is not the host', async () => {
      await page.evaluate(() => {
        const me = window.oto.conn.you;
        window.oto.topbar.updatePresence({ viewers: 0, kicked: 0, producers: [{ clientId: me.clientId, name: me.name, host: false }, { clientId: 'someone-else-1', name: 'Other', host: true }, { clientId: 'someone-else-2', name: 'Third', host: false }] }, { ...me, host: false });
      });
      assert.equal(await page.locator('.people .kick-btn').count(), 0, 'no remove buttons');
      await person('Other').dblclick();
      assert.equal(await page.locator('.people .person-edit').count(), 0, 'and no renaming of the others');
      await page.locator('.people .person.me').dblclick();
      assert.equal(await page.locator('.people .person-edit').count(), 1, 'but your own name');
      await page.locator('.people .person-edit').press('Escape');
    });

    it('shows a page that was removed what happened, and stops it', async () => {
      await page.evaluate(() => window.oto.conn.emit('kicked', { by: 'Host' }));
      assert.match(await page.locator('.kicked-screen h2').textContent(), /You were removed from this session/);
      assert.equal(await page.locator('.topbar').count(), 0, 'the control panel is gone');
    });
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

  it('sends the prize arrows to the player who has the turn, and Shift to the other one', async () => {
    // Ash has the turn: the arrows are Ash's, Shift is Gary's
    await press('ArrowDown');
    await expectLive((state) => state.trainerA.prizes.count, 5);
    await press('Shift+ArrowDown');
    await expectLive((state) => state.trainerB.prizes.count, 5);

    await press('Space'); // the turn passes to Gary: now the arrows are his, and Shift is Ash's
    await expectLive((state) => state.trainerB.isTurn, true);
    await press('ArrowDown');
    await expectLive((state) => state.trainerB.prizes.count, 4);
    await press('Shift+ArrowDown');
    await expectLive((state) => state.trainerA.prizes.count, 4);
    await press('ArrowUp');
    await expectLive((state) => state.trainerB.prizes.count, 5);
    await press('Shift+ArrowUp');
    await expectLive((state) => state.trainerA.prizes.count, 5);
    assert.deepEqual(await toasts(), [], 'nothing was refused');
  });

  it('keeps the prize arrows working before anybody has the turn: Trainer A, and Trainer B with Shift', async () => {
    await producer.act('action:reset', { action: 'full', confirm: 'FULL_RESET' }); // a new match: nobody has the turn
    await expectLive((state) => [state.trainerA.isTurn, state.trainerB.isTurn], [false, false]);
    await press('ArrowDown');
    await expectLive((state) => state.trainerA.prizes.count, 5);
    await press('Shift+ArrowDown');
    await expectLive((state) => state.trainerB.prizes.count, 5);
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

  it('has one Winner button in the hype, for the player whose turn it is, and no victory button for each: whoever takes the last prize card wins by itself', async () => {
    assert.equal(await page.locator('.hype-grid button', { hasText: 'Victory' }).count(), 0);
    assert.equal(await page.locator('.hype-grid button', { hasText: 'Game start' }).count(), 1);
    const winner = page.locator('.hype-grid button', { hasText: 'Winner' });
    assert.equal(await winner.count(), 1);

    // Ash has the turn: the victory is Ash's
    let banner = producer.expect('announce', (announcement) => announcement.type === 'win');
    await winner.click();
    assert.equal((await banner).side, 'trainerA');
    // and when the turn passes, it is Gary's
    await producer.act('action:match', { action: 'toggleTurn' });
    await expectLive((state) => state.trainerB.isTurn, true);
    banner = producer.expect('announce', (announcement) => announcement.type === 'win');
    await winner.click();
    assert.equal((await banner).side, 'trainerB');
    assert.equal((await live()).trainerA.prizes.count, 6, 'it is only the banner: nothing about the game changes');
    assert.deepEqual(page.problems, []);

    // (Ash has the turn again for the rest)
    await producer.act('action:match', { action: 'toggleTurn' });
    await expectLive((state) => state.trainerA.isTurn, true);

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

    it('keeps the attacks of the benched Pokémon in a list that is closed until it is wanted, and takes one like any other attack', async () => {
      const list = () => modal().locator('.bench-attacks');
      await press('c');
      await page.waitForSelector('.modal');
      assert.equal(await list().count(), 0, 'no Pokémon on the bench has attacks on file');
      await press('Escape');
      await dialogClosed();

      await producer.act('action:trainerA', { action: 'setBench', slot: 0, cardId: 'a-2', name: 'Eevee', image: IMG, hp: 60, attacks: [{ name: 'Rear Kick', damage: '30' }, { name: 'Tail Whip', damage: '10+' }] });
      await producer.act('action:trainerA', { action: 'setBench', slot: 1, cardId: 'a-3', name: 'Raichu', image: IMG, hp: 120, attacks: [{ name: 'Volt Tackle', damage: '120' }] });
      await expectLive((state) => state.trainerA.bench[1].attacks.map((attack) => attack.name), ['Volt Tackle']);
      await press('c');
      await page.waitForSelector('.modal');

      // closed at first: the Active Pokémon's attacks are the ones that show, with the numbers
      assert.equal(await list().evaluate((node) => node.open), false);
      assert.match(await list().locator('summary').textContent(), /Attacks of the benched Pokémon\s*2 Pokémon/);
      assert.equal(await modal().locator('.bench-pick').first().isVisible(), false);
      assert.deepEqual(await modal().locator('.attack-pick:not(.ability):not(.bench-pick) .attack-name').allTextContents(), ['Gnaw', 'Thunder Jolt']);
      assert.equal(await modal().locator('.bench-pick kbd').count(), 0, 'the benched ones have no number key');
      assert.equal(await modal().locator('.attack-pick.ability kbd').textContent(), '3', 'the numbers of the others do not change');

      // it opens from the keyboard without announcing anything
      await list().locator('summary').focus();
      await press('Enter');
      await page.waitForFunction(() => document.querySelector('.bench-attacks').open);
      assert.equal(await modal().count(), 1, 'Enter on the list opens it: it does not announce');
      assert.deepEqual(await list().locator('.bench-attack-owner').allTextContents(), ['Eevee · Bench 1', 'Raichu · Bench 2']);
      assert.deepEqual(await list().locator('.attack-name').allTextContents(), ['Rear Kick', 'Tail Whip', 'Volt Tackle']);
      assert.deepEqual(await list().locator('.attack-damage').allTextContents(), ['30', '10+', '120']);

      // picking one fills in the name and the damage of the card, and the list stays open
      await list().locator('.bench-pick', { hasText: 'Tail Whip' }).click();
      assert.equal(await modal().locator('input[aria-label="Attack name"]').inputValue(), 'Tail Whip');
      assert.equal(await damageBox().inputValue(), '10', 'the damage of the attack, by default');
      assert.match(await modal().locator('.from-bench').textContent(), /The attack of Eevee \(Bench 1\), on the bench\./);
      assert.match(await modal().locator('.hint-line:not(.from-bench)').textContent(), /The card says 10\+: and more with some conditions/);
      assert.equal(await list().evaluate((node) => node.open), true);
      assert.equal(await list().locator('.bench-pick.on .attack-name').textContent(), 'Tail Whip');

      // ...and the producer changes it
      await damageBox().fill('40');
      await damageBox().press('Tab');
      const heard = producer.expect('announce', (announcement) => announcement.type === 'attack');
      await modal().locator('.modal-foot .danger').click();
      const announced = await heard;
      assert.equal(announced.title, 'Tail Whip');
      assert.equal(announced.subtitle, '40 damage');
      assert.equal(announced.data.source, 'trainerA');
      await expectLive((state) => state.trainerB.active.hp.current, 110);
      await dialogClosed();
      assert.deepEqual(page.problems, []);
    });

    it('is not shown the benched attacks of the other trainer, until that trainer is the one who attacks', async () => {
      await producer.act('action:trainerB', { action: 'setBench', slot: 0, cardId: 'b-2', name: 'Pidgey', image: IMG, hp: 50, attacks: [{ name: 'Gust', damage: '20' }] });
      await expectLive((state) => state.trainerB.bench[0].attacks.map((attack) => attack.name), ['Gust']);
      await press('c');
      await page.waitForSelector('.modal');
      assert.equal(await modal().locator('.bench-attacks').count(), 0, 'Ash attacks: Gary\'s bench is not listed');
      await modal().locator('.side-tab', { hasText: 'Gary' }).click();
      assert.deepEqual(await modal().locator('.bench-attacks .attack-name').allTextContents(), ['Gust']);
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

  it('shows the retreat cost of every Pokémon and changes it with a stepper', async () => {
    const active = '.trainer-panel.side-a .mon-card:not(.compact)';
    const bench = '.trainer-panel.side-a .mon-card.compact';
    const number = (where) => page.locator(`${where} .retreat-number`).textContent();
    assert.equal(await page.locator('.trainer-panel.side-a .retreat-line').count(), 2, 'one for the Active Pokémon, one for the bench');
    assert.equal(await number(active), '0');
    assert.equal(await page.locator(`${active} button[aria-label="Retreat cost one less"]`).isDisabled(), true, 'it cannot go below nothing');

    await page.locator(`${active} button[aria-label="Retreat cost one more"]`).click();
    await expectLive((state) => state.trainerA.active.retreat, 1);
    await page.waitForFunction((where) => document.querySelector(`${where} .retreat-number`).textContent === '1', active);
    await page.locator(`${active} button[aria-label="Retreat cost one more"]`).click();
    await expectLive((state) => state.trainerA.active.retreat, 2);
    await page.locator(`${active} button[aria-label="Retreat cost one less"]`).click();
    await expectLive((state) => state.trainerA.active.retreat, 1);

    // the bench has its own, and the other trainer's is not touched
    await page.locator(`${bench} button[aria-label="Retreat cost one more"]`).click();
    await expectLive((state) => [state.trainerA.active.retreat, state.trainerA.bench[0].retreat, state.trainerB.active.retreat], [1, 1, 0]);

    // six is the most the overlay draws
    for (let cost = 2; cost <= 6; cost++) {
      await page.locator(`${bench} button[aria-label="Retreat cost one more"]`).click();
      await expectLive((state) => state.trainerA.bench[0].retreat, cost);
    }
    assert.equal(await page.locator(`${bench} button[aria-label="Retreat cost one more"]`).isDisabled(), true);

    // someone else changes it: the number follows
    await producer.act('action:trainerA', { action: 'setRetreat', slot: -1, cost: 3 });
    await page.waitForFunction((where) => document.querySelector(`${where} .retreat-number`).textContent === '3', active);
    assert.deepEqual(page.problems, []);
  });

  it('marks the GX attack and the VSTAR Power used with their own tokens (only while the overlay shows them), and a new game gives them back', async () => {
    const token = (side, name) => page.locator(`.trainer-panel.side-${side} .token-btn`, { hasText: name });
    // the overlay does not show them at first, so the control panel does not offer them
    assert.equal(await token('a', 'GX attack').isHidden(), true);
    assert.equal(await token('a', 'VSTAR Power').isHidden(), true);
    await producer.act('action:settings', { action: 'update', display: { gxMarker: true } });
    await page.waitForFunction(() => !document.querySelector('.trainer-panel.side-a .token-btn.once-game').hidden);
    assert.equal(await token('a', 'VSTAR Power').isHidden(), true, 'only the one that is switched on');
    await producer.act('action:settings', { action: 'update', display: { gxMarker: true, vstarMarker: true } });
    await page.waitForFunction(() => [...document.querySelectorAll('.trainer-panel.side-a .token-btn.once-game')].every((node) => !node.hidden));
    assert.match(await token('a', 'GX attack').getAttribute('title'), /Once per game/);
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

    // the next game gives them all back
    await page.getByRole('button', { name: 'Next game' }).click();
    await expectLive((state) => [state.trainerA.resources.gxPerGame.used, state.trainerB.resources.vstarPerGame.used], [0, 0]);
    await page.waitForFunction(() => document.querySelectorAll('.token-btn.used').length === 0);

    // so does a new match
    await token('a', 'GX attack').click();
    await expectLive((state) => state.trainerA.resources.gxPerGame.used, 1);
    await page.getByRole('button', { name: 'New match' }).click();
    await expectLive((state) => state.trainerA.resources.gxPerGame.used, 0);
    assert.deepEqual(page.problems, []);
  });

  it('starts the next game without touching the score or the names: prizes, penalties and the markers start again', async () => {
    await producer.act('action:match', { action: 'trainerAMatchWinPlus' });
    await producer.act('action:trainerA', { action: 'prizeSet', count: 2 });
    await producer.act('action:trainerA', { action: 'prizePenaltySet', count: 1 });
    await producer.act('action:trainerB', { action: 'prizeSet', count: 3 });
    await expectLive((state) => [state.trainerA.prizes.count, state.trainerB.prizes.count, state.matchScore.trainerAWins], [2, 3, 1]);

    await page.getByRole('button', { name: 'Next game' }).click();
    await expectLive((state) => [state.trainerA.prizes.count, state.trainerB.prizes.count, state.trainerA.prizes.penalty], [6, 6, 0]);
    const kept = await live();
    assert.equal(kept.matchScore.trainerAWins, 1, 'the score stays');
    assert.deepEqual([kept.trainerA.name, kept.trainerB.name], ['Ash', 'Gary'], 'and the names');
    assert.equal(kept.trainerA.active.name, 'Pikachu', 'and what is on the table');
    assert.match(await page.locator('.feed').textContent(), /Next game \(score 1–0\)/);

    // a new match is the whole thing again, the score too
    await page.getByRole('button', { name: 'New match' }).click();
    await expectLive((state) => state.matchScore.trainerAWins, 0);
  });

  it('pauses the game with the button or P, and the button says what it does next', async () => {
    const button = page.locator('.hype-block .btn.hype.amber');
    assert.match(await button.textContent(), /Pause game/);
    assert.equal(await button.getAttribute('aria-pressed'), 'false');

    await button.click();
    await expectLive((state) => state.paused, true);
    await page.waitForFunction(() => /Resume game/.test(document.querySelector('.hype-block .btn.hype.amber').textContent));
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('.feed').textContent(), /Game paused/);

    const resumed = producer.expect('announce', (announcement) => announcement.type === 'resume', 6000);
    await press('p');
    await expectLive((state) => state.paused, false);
    assert.equal((await resumed).title, 'GAME RESUMED');
    await page.waitForFunction(() => /Pause game/.test(document.querySelector('.hype-block .btn.hype.amber').textContent));

    // there is no Pass turn button in the Hype box: Space passes the turn (and announces it)
    assert.equal(await page.locator('.hype-grid button', { hasText: 'Pass turn' }).count(), 0);
    const passed = producer.expect('announce', (announcement) => announcement.type === 'passturn');
    await press('Space');
    await passed;
    assert.equal((await live()).paused, false);
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
      await page.locator('.feature-block .block-title').getByRole('button', { name: 'Add' }).click();
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

    it('has a star on every card that shows, works, follows other producers, and lists the cards with a star first', async () => {
      const star = (name) => page.locator('.modal .card-tile', { hasText: name }).locator('.star-btn');
      const lit = (name) => star(name).evaluate((node) => node.classList.contains('on'));

      await openFeature();
      await page.locator('.search-input').fill('pika');
      await page.waitForSelector('.modal .card-tile');
      assert.equal(await star('Pikachu ex').getAttribute('aria-pressed'), 'false');
      assert.ok(Number(await star('Pikachu ex').evaluate((node) => getComputedStyle(node).opacity)) > 0.4, 'it can be seen without pointing at the card');

      // the star is drawn (it used to be an empty button), and a right click on the card does what a click on the star does
      assert.ok(await star('Pikachu ex').locator('svg').count() > 0, 'the star has its icon');
      const drawn = await star('Pikachu ex').boundingBox();
      assert.ok(drawn.width >= 20 && drawn.height >= 20, `big enough to click: ${drawn.width} x ${drawn.height}`);
      await page.locator('.modal .card-tile', { hasText: 'Pikachu ex' }).locator('.card-pick').click({ button: 'right' });
      await expectLive((state) => state.favoriteCardIds, ['sv-1']);
      await page.waitForFunction(() => document.querySelector('.modal .star-btn').classList.contains('on'));
      await page.locator('.modal .card-tile', { hasText: 'Pikachu ex' }).locator('.card-pick').click({ button: 'right' });
      await expectLive((state) => state.favoriteCardIds, []);
      assert.equal(await page.locator('.modal').count(), 1, 'the picker stays open: a right click does not pick the card');

      await star('Pikachu ex').click();
      await expectLive((state) => state.favoriteCardIds, ['sv-1']);
      await page.waitForFunction(() => document.querySelector('.modal .star-btn').classList.contains('on'));
      assert.equal(await star('Pikachu ex').getAttribute('aria-pressed'), 'true');
      assert.match(await star('Pikachu ex').getAttribute('title'), /A favorite/);

      // another producer takes the star off, and puts it back: this page follows
      await producer.act('action:card', { action: 'favorite', cardId: 'sv-1' });
      await page.waitForFunction(() => !document.querySelector('.modal .star-btn').classList.contains('on'));
      await producer.act('action:card', { action: 'favorite', cardId: 'sv-1' });
      await page.waitForFunction(() => document.querySelector('.modal .star-btn').classList.contains('on'));
      assert.deepEqual(page.problems, [], 'nothing went wrong behind the scenes');
      await press('Escape');
      await dialogClosed();

      // a Stadium that is only used, not starred
      await press('s');
      await page.locator('.search-input').fill('area');
      await page.waitForSelector('.modal .card-tile');
      await press('Enter');
      await expectLive((state) => state.stadium.name, 'Area Zero');
      await dialogClosed();
      await usedCount(1);

      // with nothing typed, the star comes first although the Stadium was used later
      await openFeature();
      await page.waitForSelector('.modal .card-tile');
      assert.deepEqual(await tiles(), ['Pikachu ex', 'Area Zero']);
      assert.equal(await lit('Pikachu ex'), true);
      assert.equal(await lit('Area Zero'), false);
      assert.match(await status(), /^Your favorite cards, then your most used cards \(2\)\./);

      // a star here puts the card first from now on (the latest star first)
      await star('Area Zero').click();
      await expectLive((state) => state.favoriteCardIds, ['sv-1', 'sv-2']);
      await press('Escape');
      await dialogClosed();
      await openFeature();
      await page.waitForSelector('.modal .card-tile');
      assert.deepEqual(await tiles(), ['Area Zero', 'Pikachu ex']);
      assert.match(await status(), /^Your favorite cards \(2\)\./);
      assert.deepEqual(page.problems, []);
      await press('Escape');
      await dialogClosed();
      await producer.act('action:card', { action: 'favorite', cardId: 'sv-1' });
      await producer.act('action:card', { action: 'favorite', cardId: 'sv-2' });
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

  it('fires the hype shortcut T, and P pauses', async () => {
    const topdeck = producer.expect('announce', (announcement) => announcement.type === 'topdeck');
    await press('t');
    assert.equal((await topdeck).side, 'trainerA');
    await press('p');
    await expectLive((state) => state.paused, true);
    await press('p');
    await expectLive((state) => state.paused, false);
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

  it('says what was undone and what was done again in the toast', async () => {
    await press('ArrowDown');
    await expectLive((state) => state.trainerA.prizes.count, 5);
    await press('Control+z');
    await expectLive((state) => state.trainerA.prizes.count, 6);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((toast) => /^Undid: Ash prizes −1 \(5 left\)/.test(toast.textContent)));

    await press('Control+y');
    await expectLive((state) => state.trainerA.prizes.count, 5);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((toast) => /^Redid: Ash prizes −1 \(5 left\)/.test(toast.textContent)));
    assert.ok(!(await toasts()).some((text) => /^Redone/.test(text)), 'not just "Redone"');
  });

  it('lists every shortcut with ?', async () => {
    await press('?');
    await page.waitForSelector('.modal');
    const text = await modal().textContent();
    for (const label of ['Deploy a new Active Pokémon', 'Edit the bench', 'Knock out', 'Stadium', 'Abilities', 'Redo', 'Announce an attack']) {
      assert.match(text, new RegExp(label));
    }
    // the prize arrows say whom they are for: the player whose turn it is, and with Shift the other one
    assert.match(text, /The player whose turn it is takes \/ gives back a prize card/);
    assert.match(text, /The same for the player who does not have the turn/);
    assert.doesNotMatch(text, /Trainer A takes/);
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

  it('keeps a draft off the overlay until it is sent', async () => {
    await page.locator('.draft-toggle').click();
    await page.waitForSelector('.draft-banner:not([hidden])');
    await press('ArrowDown');
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('2 changes'));
    assert.equal((await prizeNumber('a').textContent()).trim(), '4', 'the page shows the draft');
    assert.equal((await live()).trainerA.prizes.count, 6, 'the live game is untouched');

    await page.locator('.draft-banner button', { hasText: 'Send to overlay' }).click();
    await expectLive((state) => state.trainerA.prizes.count, 4);
    await page.waitForSelector('.toast-success');
    assert.match((await toasts()).join(' '), /Sent 2 changes to the overlay/);
    assert.match(await page.locator('.feed').textContent(), /Sent 2 changes/);

    // draft mode does not turn off: the banner stays, empty, and the next change waits in it
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('No changes waiting'));
    assert.equal(await page.locator('.draft-banner').isVisible(), true);
    assert.match(await page.locator('.draft-toggle').textContent(), /Draft mode: on/);
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change waiting'));
    assert.equal((await live()).trainerA.prizes.count, 4, 'the overlay did not move');
    assert.equal((await prizeNumber('a').textContent()).trim(), '3', 'the page shows the draft');
  });

  it('turns draft mode on and off with Shift+Enter, and asks what to do with changes that are waiting', async () => {
    assert.equal(await page.locator('.draft-banner').isHidden(), true);
    await press('Shift+Enter');
    await page.waitForSelector('.draft-banner:not([hidden])');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('No changes waiting'));
    assert.equal(await page.locator('.draft-banner button', { hasText: 'Send to overlay' }).isDisabled(), true, 'nothing to send yet');
    assert.equal(await page.locator('.draft-banner button', { hasText: 'Throw changes away' }).isDisabled(), true);

    // nothing waiting: leaves at once
    await press('Shift+Enter');
    await page.waitForFunction(() => document.querySelector('.draft-banner').hidden);
    assert.match(await page.locator('.draft-toggle').textContent(), /^\s*Draft mode\s*$/);

    // with changes waiting it asks: stay, throw them away and leave, or send and leave
    await press('Shift+Enter');
    await page.waitForSelector('.draft-banner:not([hidden])');
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
    await press('Shift+Enter');
    const ask = page.locator('.modal[aria-label="You are in draft mode"]');
    await ask.waitFor();
    await ask.getByRole('button', { name: 'Stay in draft mode' }).click();
    await dialogClosed();
    assert.equal(await page.locator('.draft-banner').isVisible(), true);

    await press('Shift+Enter');
    await ask.waitFor();
    await ask.getByRole('button', { name: 'Throw them away and leave' }).click();
    await dialogClosed();
    await page.waitForFunction(() => document.querySelector('.draft-banner').hidden);
    assert.equal((await live()).trainerA.prizes.count, 6, 'nothing was sent');

    await press('Shift+Enter');
    await page.waitForSelector('.draft-banner:not([hidden])');
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
    await press('Shift+Enter');
    await ask.waitFor();
    await ask.getByRole('button', { name: 'Send and leave' }).click();
    await expectLive((state) => state.trainerA.prizes.count, 5);
    await page.waitForFunction(() => document.querySelector('.draft-banner').hidden);
    assert.deepEqual(page.problems, []);
  });

  it('opens the overlay in the browser when Preview is clicked with Shift, and shows it in a window otherwise', async () => {
    const popup = page.waitForEvent('popup');
    await page.locator('.preview-btn').click({ modifiers: ['Shift'] });
    const opened = await popup;
    assert.match(opened.url(), /\/overlay$/);
    assert.equal(await page.locator('.modal').count(), 0, 'no window of this page');
    await opened.close();
    await page.locator('.preview-btn').click();
    await page.waitForSelector('.modal .preview-frame');
    await press('Escape');
  });

  it('sends a draft with Ctrl+Enter', async () => {
    await page.locator('.draft-toggle').click();
    await page.waitForSelector('.draft-banner:not([hidden])');
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
    await press('Control+Enter');
    await expectLive((state) => state.trainerA.prizes.count, 5);
  });

  it('can throw the changes of a draft away and stay in draft mode', async () => {
    await page.locator('.draft-toggle').click();
    await page.waitForSelector('.draft-banner:not([hidden])');
    await press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
    await page.locator('.draft-banner button', { hasText: 'Throw changes away' }).click();
    await page.locator('.modal button', { hasText: 'Throw away' }).click();
    await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('No changes waiting'));
    assert.equal(await page.locator('.draft-banner').isVisible(), true, 'still in draft mode');
    assert.equal((await live()).trainerA.prizes.count, 6);
    await page.waitForFunction(() => document.querySelector('.trainer-panel.side-a .prize-number').textContent.trim() === '6');
  });

  describe('the draft the producers share', () => {
    const youAre = (target) => target.evaluate(() => window.oto.conn.you.name);
    async function secondPage() {
      const second = await openPage(browser, `${server.base}/control`);
      extra.push(second.context());
      await second.waitForSelector('.trainer-panel.side-a .mon-card');
      await page.waitForFunction(() => document.querySelectorAll('.people .person').length >= 3);
      return second;
    }

    it('is followed by the other producer\'s page, with who made each change, and either of them can send it', async () => {
      const second = await secondPage();
      await page.locator('.draft-toggle').click();
      await second.waitForSelector('.draft-banner:not([hidden])');
      await second.waitForSelector('.toast');
      assert.match((await second.locator('.toast').allTextContents()).join(' '), new RegExp(`${await youAre(page)} turned draft mode on`));
      assert.match(await second.locator('.draft-toggle').textContent(), /Draft mode: on/);
      assert.match(await second.locator('.draft-title').textContent(), /shared with the other producers/);

      await press('ArrowDown'); // from this page
      await second.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
      await second.keyboard.press('ArrowDown'); // and from the other
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('2 changes'));
      await second.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('2 changes'));
      const mine = await youAre(page);
      const theirs = await youAre(second);
      assert.deepEqual(await page.locator('.draft-changes .draft-by').allTextContents(), [`${mine}: `, `${theirs}: `]);
      assert.equal((await second.locator('.trainer-panel.side-a .prize-number').textContent()).trim(), '4', 'the other page shows the same draft');
      assert.equal((await prizeNumber('a').textContent()).trim(), '4');
      assert.equal((await live()).trainerA.prizes.count, 6, 'and the live game is untouched');

      await second.locator('.draft-banner button', { hasText: 'Send to overlay' }).click();
      await expectLive((state) => state.trainerA.prizes.count, 4);
      // (the draft is empty again, for everybody, and still open)
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('No changes waiting'));
      await second.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('No changes waiting'));
      assert.equal(await second.locator('.draft-banner').isVisible(), true);
      await page.waitForFunction((name) => [...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes(`${name} sent 2 changes to the overlay`)), theirs);
      assert.deepEqual(page.problems, []);
    });

    it('is thrown away for everybody when one producer does it, and the others are told', async () => {
      const second = await secondPage();
      await page.locator('.draft-toggle').click();
      await second.waitForSelector('.draft-banner:not([hidden])');
      await second.locator('.draft-toggle').click(); // nothing in it yet, so no question
      await page.waitForFunction(() => document.querySelector('.draft-banner').hidden);
      await second.waitForFunction(() => document.querySelector('.draft-banner').hidden);
      await page.waitForFunction((name) => [...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes(`${name} left draft mode`)), await youAre(second));
      assert.equal((await live()).trainerA.prizes.count, 6);
    });

    it('shows a producer who joins while there is a draft the same draft', async () => {
      await page.locator('.draft-toggle').click();
      await page.waitForSelector('.draft-banner:not([hidden])');
      await press('ArrowDown');
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
      const late = await secondPage();
      await late.waitForSelector('.draft-banner:not([hidden])');
      await late.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
      assert.equal((await late.locator('.trainer-panel.side-a .prize-number').textContent()).trim(), '5');
    });

    it('opens again when the send of a draft is redone, with the changes that were sent, to change before they are sent once more', async () => {
      await page.locator('.draft-toggle').click();
      await page.waitForSelector('.draft-banner:not([hidden])');
      await press('ArrowDown');
      await press('ArrowDown');
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('2 changes'));
      await page.locator('.draft-banner button', { hasText: 'Send to overlay' }).click();
      await expectLive((state) => state.trainerA.prizes.count, 4);
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('No changes waiting'));

      await press('Control+z');
      await expectLive((state) => state.trainerA.prizes.count, 6);
      await page.waitForFunction(() => document.querySelector('.trainer-panel.side-a .prize-number').textContent.trim() === '6');

      await press('Control+y');
      await page.waitForSelector('.draft-banner:not([hidden])');
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('2 changes'));
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((toast) => /The draft is open again with its 2 changes/.test(toast.textContent)));
      assert.equal((await live()).trainerA.prizes.count, 6, 'not on the overlay: it is a draft again');
      assert.equal((await prizeNumber('a').textContent()).trim(), '4', 'the page shows the draft');
      assert.match(await page.locator('.feed').textContent(), /Redid: 2 sent changes, opened again as a draft/);

      await press('ArrowDown'); // changed before it goes
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('3 changes'));
      await press('Control+Enter');
      await expectLive((state) => state.trainerA.prizes.count, 3);
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('No changes waiting'));
    });

    it('opens again for the other producers too', async () => {
      const second = await secondPage();
      await page.locator('.draft-toggle').click();
      await page.waitForSelector('.draft-banner:not([hidden])');
      await press('ArrowDown');
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
      await press('Control+Enter');
      await expectLive((state) => state.trainerA.prizes.count, 5);
      await second.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('No changes waiting'));
      await press('Control+z');
      await expectLive((state) => state.trainerA.prizes.count, 6);
      await second.waitForFunction(() => document.querySelector('.trainer-panel.side-a .prize-number').textContent.trim() === '6');
      await second.keyboard.press('Control+y');
      await page.waitForSelector('.draft-banner:not([hidden])');
      await second.waitForSelector('.draft-banner:not([hidden])');
      await page.waitForFunction(() => document.querySelector('.draft-count').textContent.includes('1 change'));
    });
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
