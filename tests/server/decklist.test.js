/**
 * The decklist of a trainer (read from what Pokémon TCG Live exports, and found in the card library on this computer), and the discard pile
 * and the Lost Zone: the state, the actions, and the cards of a knocked out Pokémon going to one of them.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DECKLIST = require('../../public/js/decklist');
const DISPLAY = require('../../public/js/display-options');
const GameStateService = require('../../src/services/gamestate');
const { CatalogService } = require('../../src/services/catalog');
const actions = require('../../src/actions');

const LIST = `Pokémon: 7
4 Dreepy TWM 128
2 Dragapult ex TWM 130
1 Mew ex SVP 53

Trainer: 6
4 Arven SVI 166
2 Pokégear 3.0 SVI 186

Energy: 5
3 Basic {R} Energy SVE 2
2 Luminous Energy PAL 191

Total Cards: 18`;

// A card of the library as the card search gives it
const libraryCard = (id, name, setId, number, supertype = 'Pokémon', subtypes = ['Basic']) => ({
  id, name, setId, number, supertype, subtypes, images: { small: `/img/${setId}/${number}.png`, large: `/img/${setId}/${number}_hires.png` }
});
const LIBRARY = [
  libraryCard('sv6-128', 'Dreepy', 'sv6', '128'),
  libraryCard('sv6-130', 'Dragapult ex', 'sv6', '130', 'Pokémon', ['Stage 2', 'ex']),
  libraryCard('svp-53', 'Mew ex', 'svp', '53'),
  libraryCard('sv1-166', 'Arven', 'sv1', '166', 'Trainer', ['Supporter']),
  // the same name and number in two sets: the set of the line says which
  libraryCard('sv4pt5-235', 'Arven', 'sv4pt5', '166', 'Trainer', ['Supporter']),
  libraryCard('sve-2', 'Basic Fire Energy', 'sve', '2', 'Energy', ['Basic'])
];
const fakeCatalog = { named: (name) => LIBRARY.filter((card) => DECKLIST.nameKey(card.name) === DECKLIST.nameKey(name)) };

const makeGame = ({ saved = null, catalog = fakeCatalog } = {}) => new GameStateService({
  loadGameState: () => saved, saveGameState() {}, saveMatch() {}, addFavorite() {}, removeFavorite() {}
}, { selectBestImageUrl: (card) => (card.images && card.images.large) || '', catalog });

const run = (gs, event, payload) => {
  const spec = actions.resolve(event, payload);
  assert.ok(spec, `${event} ${payload.action} is an action`);
  spec.run(gs);
  return spec;
};

describe('reading a decklist', () => {
  it('reads the export of Pokémon TCG Live: the count, the name, the set and the number of each card, under its heading', () => {
    const { cards, skipped } = DECKLIST.parse(LIST);
    assert.deepEqual(skipped, []);
    assert.equal(cards.length, 7);
    assert.deepEqual(cards[0], { count: 4, name: 'Dreepy', set: 'TWM', number: '128', section: 'Pokémon' });
    assert.deepEqual(cards[2], { count: 1, name: 'Mew ex', set: 'SVP', number: '53', section: 'Pokémon' });
    assert.deepEqual(cards[4], { count: 2, name: 'Pokégear 3.0', set: 'SVI', number: '186', section: 'Trainer' });
    assert.deepEqual(cards[5], { count: 3, name: 'Fire Energy', set: 'SVE', number: '2', section: 'Energy' }, 'a basic Energy is called by its type');
    assert.equal(DECKLIST.total(cards), 18);
  });

  it('reads the other ways a list is written, and says which lines it could not read', () => {
    const { cards, skipped } = DECKLIST.parse([
      '##Pokémon - 2', '* 1 Pikachu ex SSP 57', '1 Iron Hands ex PAR 70', '##Trainer Cards - 1', '4x Iono', 'Some notes about the deck',
      '##Energy - 2', '2 Basic Psychic Energy', '1 Darkness Energy 7'
    ].join('\r\n'));
    assert.deepEqual(cards.map((card) => [card.count, card.name, card.set, card.number, card.section]), [
      [1, 'Pikachu ex', 'SSP', '57', 'Pokémon'],
      [1, 'Iron Hands ex', 'PAR', '70', 'Pokémon'],
      [4, 'Iono', '', '', 'Trainer'],
      [2, 'Psychic Energy', '', '', 'Energy'],
      [1, 'Darkness Energy 7', '', '', 'Energy']
    ]);
    assert.deepEqual(skipped, ['Some notes about the deck']);
    assert.deepEqual(DECKLIST.parse('').cards, []);
    assert.deepEqual(DECKLIST.parse(undefined).cards, []);
  });

  it('knows a basic Energy however it is written, and nothing else as one', () => {
    for (const [name, key] of [['Basic {R} Energy', 'fire'], ['Basic {P} Energy', 'psychic'], ['{Y} Energy', 'fairy'], ['Basic Water Energy', 'water'], ['Metal Energy', 'metal']]) {
      assert.equal(DECKLIST.basicEnergyOf(name), key, name);
    }
    for (const name of ['Luminous Energy', 'Double Turbo Energy', 'Energy Retrieval', 'Basic {X} Energy']) assert.equal(DECKLIST.basicEnergyOf(name), null, name);
  });

  it('keeps a list within bounds: a card at most 60 times, 80 different cards', () => {
    const many = Array.from({ length: 100 }, (_, index) => `1 Card ${index} SVI ${index + 1}`).join('\n');
    const { cards, skipped } = DECKLIST.parse(`99 Fire Energy SVE 2\n${many}`);
    assert.equal(cards[0].count, 60);
    assert.equal(cards.length, DECKLIST.MAX_LINES);
    assert.equal(skipped.length, 101 - DECKLIST.MAX_LINES);
  });

  it('finds the card of a line: the same set and number, then the same number, then the newest of that name', () => {
    const arvens = fakeCatalog.named('Arven');
    assert.equal(DECKLIST.pickCard({ name: 'Arven', set: 'SVI', number: '166' }, arvens).id, 'sv1-166');
    assert.equal(DECKLIST.pickCard({ name: 'Arven', set: 'PAF', number: '166' }, arvens).id, 'sv4pt5-235');
    assert.equal(DECKLIST.pickCard({ name: 'Arven', set: 'XYZ', number: '166' }, arvens).id, 'sv1-166', 'an unknown set: the number');
    assert.equal(DECKLIST.pickCard({ name: 'Arven', set: '', number: '' }, arvens).id, 'sv1-166', 'nothing else: the first (the newest)');
    assert.equal(DECKLIST.pickCard({ name: 'Arven' }, []), null);
  });

  it('says which cards fit a picker: by what the library says they are, or by their heading when it did not find them', () => {
    const tool = { name: 'Bravery Charm', supertype: 'Trainer', subtypes: ['Pokémon Tool'], cardId: 'x' };
    const lost = { name: 'Some Stadium', section: 'Trainer', subtypes: [], cardId: '' };
    assert.ok(DECKLIST.fits(tool, 'Trainer', 'Pokémon Tool'));
    assert.ok(!DECKLIST.fits(tool, 'Trainer', 'Stadium'));
    assert.ok(!DECKLIST.fits(tool, 'Pokémon'));
    assert.ok(DECKLIST.fits(lost, 'Trainer', 'Stadium'), 'not found: offered wherever its heading fits');
    assert.ok(DECKLIST.fits(tool, ''), 'any card for a picker that takes any');
  });
});

describe('the decklist in the game', () => {
  it('starts with none, and is read and found in the card library when it is set', () => {
    const gs = makeGame();
    assert.deepEqual(gs.state.trainerA.decklist, { text: '', cards: [] });
    gs.state.trainerA.name = 'Ash';
    const spec = run(gs, 'action:trainerA', { action: 'setDecklist', text: `${LIST}\nnot a card` });
    const { cards, text } = gs.state.trainerA.decklist;
    assert.ok(text.startsWith('Pokémon: 7'));
    assert.equal(cards.length, 7);
    const byName = Object.fromEntries(cards.map((card) => [card.name, card]));
    assert.equal(byName['Dragapult ex'].cardId, 'sv6-130');
    assert.deepEqual(byName['Dragapult ex'].subtypes, ['Stage 2', 'ex']);
    assert.equal(byName['Dragapult ex'].images.small, '/img/sv6/130.png');
    assert.equal(byName.Arven.cardId, 'sv1-166', 'the set of the line decides between two of the same name and number');
    assert.equal(byName['Fire Energy'].cardId, 'sve-2', 'a basic Energy is found as "Basic Fire Energy" too');
    assert.equal(byName['Pokégear 3.0'].cardId, '', 'a card the library has not got stays, by its name');
    assert.equal(byName['Pokégear 3.0'].section, 'Trainer');
    assert.equal(spec.label(gs), 'Ash decklist: 18 cards (2 not in the card library) · 1 line not read');
    assert.equal(gs.state.trainerB.decklist.cards.length, 0, 'the other trainer has none');
  });

  it('works without a card library: every card is kept by its name', () => {
    const gs = makeGame({ catalog: null });
    run(gs, 'action:trainerB', { action: 'setDecklist', text: LIST });
    assert.equal(gs.state.trainerB.decklist.cards.length, 7);
    assert.ok(gs.state.trainerB.decklist.cards.every((card) => card.cardId === ''));
  });

  it('refuses text with no cards in it, and takes the decklist away when it is emptied', () => {
    const gs = makeGame();
    run(gs, 'action:trainerA', { action: 'setDecklist', text: LIST });
    assert.throws(() => run(gs, 'action:trainerA', { action: 'setDecklist', text: 'hello there' }), /No cards were found/);
    assert.throws(() => run(gs, 'action:trainerA', { action: 'setDecklist', text: 42 }), actions.ActionError);
    assert.equal(gs.state.trainerA.decklist.cards.length, 7, 'a list that could not be read changes nothing');
    const spec = run(gs, 'action:trainerA', { action: 'setDecklist', text: '  ' });
    assert.deepEqual(gs.state.trainerA.decklist, { text: '', cards: [] });
    assert.equal(spec.label(gs), 'Trainer A decklist removed');
  });

  it('is one thing two producers can collide on', () => {
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'setDecklist', text: LIST }).targets(), ['trainerA.decklist']);
  });

  it('stays for the next game and a new match, and comes back from a save (cleaned)', () => {
    const gs = makeGame();
    run(gs, 'action:trainerA', { action: 'setDecklist', text: LIST });
    gs.nextGame();
    gs.startGame();
    assert.equal(gs.state.trainerA.decklist.cards.length, 7);

    const saved = JSON.parse(JSON.stringify(gs.state));
    saved.trainerA.decklist.cards.push({ name: 5 }, null, { name: 'Odd', count: 500, section: 'Bogus', images: 'x' });
    delete saved.trainerB.decklist;
    const again = makeGame({ saved });
    assert.equal(again.state.trainerA.decklist.cards.length, 8);
    assert.deepEqual(again.state.trainerA.decklist.cards[7], {
      count: 60, name: 'Odd', set: '', number: '', section: '', cardId: '', supertype: '', subtypes: [], images: { small: '', large: '' }
    });
    assert.deepEqual(again.state.trainerB.decklist, { text: '', cards: [] }, 'a game saved before decklists has none');
  });
});

describe('the card library finds cards by name', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oto-decklist-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('whatever the accents, case and punctuation, newest first, and nothing without a library', () => {
    const settings = {};
    const catalog = new CatalogService({ dir, db: { getSetting: (key, fallback) => settings[key] ?? fallback, setSetting: (key, value) => { settings[key] = value; } }, baseUrl: 'http://127.0.0.1:1' });
    catalog.init();
    assert.deepEqual(catalog.named('Arven'), []);
    const record = (id, name, setId, released, number) => ({
      id, name, supertype: 'Trainer', subtypes: ['Supporter'], hp: '', types: [], number, rarity: '', setId, setName: setId, released, mark: 'G',
      abilities: [], evolvesFrom: '', attacks: [], retreat: 0, images: { small: `${setId}/${number}.png`, large: `${setId}/${number}_hires.png` }
    });
    catalog.writeLibrary('standard', [record('sv1-166', 'Arven', 'sv1', '2023/03/31', '166'), record('sv4pt5-235', 'Arven', 'sv4pt5', '2024/01/26', '235'), record('sv2-185', 'Iono', 'sv2', '2023/06/09', '185')]);
    catalog.setActive('standard');
    const found = catalog.named('  ARVEN ');
    assert.deepEqual(found.map((card) => card.id), ['sv4pt5-235', 'sv1-166']);
    assert.deepEqual(found[0].subtypes, ['Supporter']);
    assert.equal(found[0].setId, 'sv4pt5');
    assert.equal(found[0].images.small, '/img/sv4pt5/235.png');
    assert.deepEqual(catalog.named('Arv'), [], 'the whole name, not the start of it');
  });
});

describe('the discard pile and the Lost Zone', () => {
  const card = (name, extra = {}) => ({ cardId: `id-${name}`, name, image: `/img/x/${name}.png`, ...extra });

  it('start empty, and take cards on top, which can be taken out again or moved to the other pile', () => {
    const gs = makeGame();
    assert.deepEqual([gs.state.trainerA.discard, gs.state.trainerA.lostZone], [[], []]);
    gs.state.trainerA.name = 'Ash';
    const add = run(gs, 'action:trainerA', { action: 'pileAdd', pile: 'discard', ...card('Arven') });
    assert.equal(add.label(gs), "Arven → Ash's discard pile");
    const two = run(gs, 'action:trainerA', { action: 'pileAdd', pile: 'discard', ...card('Fire Energy'), energy: 'fire', count: 2 });
    assert.equal(two.label(gs), "2 × Fire Energy → Ash's discard pile");
    const pile = gs.state.trainerA.discard;
    assert.deepEqual(pile.map((one) => one.name), ['Arven', 'Fire Energy', 'Fire Energy']);
    assert.equal(pile[1].energy, 'fire');
    assert.equal(new Set(pile.map((one) => one.id)).size, 3, 'each copy has an id of its own');

    const moved = run(gs, 'action:trainerA', { action: 'pileMove', from: 'discard', to: 'lostZone', id: pile[0].id });
    assert.equal(moved.label(gs), "Arven → Ash's Lost Zone");
    assert.deepEqual(gs.state.trainerA.lostZone.map((one) => one.name), ['Arven']);
    assert.deepEqual(gs.state.trainerA.discard.map((one) => one.name), ['Fire Energy', 'Fire Energy']);

    const gone = gs.state.trainerA.discard[0].id;
    run(gs, 'action:trainerA', { action: 'pileRemove', pile: 'discard', id: gone });
    assert.equal(gs.state.trainerA.discard.length, 1);
    assert.throws(() => run(gs, 'action:trainerA', { action: 'pileRemove', pile: 'discard', id: gone }), /no longer in the discard pile/);

    run(gs, 'action:trainerA', { action: 'pileClear', pile: 'lostZone' });
    assert.deepEqual(gs.state.trainerA.lostZone, []);
    assert.equal(gs.state.trainerB.discard.length, 0, 'each trainer has their own');
  });

  it('refuses what is not a card or not a pile, and a pile holds 60 cards at most', () => {
    const gs = makeGame();
    for (const payload of [
      { pile: 'hand', name: 'Arven' }, { pile: 'discard', name: '' }, { pile: 'discard', name: 'Arven', image: 'javascript:x' },
      { pile: 'discard', name: 'Arven', energy: 'plasma' }, { pile: 'discard', name: 'Arven', count: 0 }
    ]) {
      assert.throws(() => run(gs, 'action:trainerA', { action: 'pileAdd', ...payload }), actions.ActionError, JSON.stringify(payload));
    }
    assert.throws(() => run(gs, 'action:trainerA', { action: 'pileMove', from: 'discard', to: 'discard', id: 'x' }), /same pile/);
    for (let i = 0; i < 3; i++) run(gs, 'action:trainerA', { action: 'pileAdd', pile: 'lostZone', name: 'Comfey', count: 20 });
    assert.equal(gs.state.trainerA.lostZone.length, GameStateService.MAX_PILE);
    assert.throws(() => run(gs, 'action:trainerA', { action: 'pileAdd', pile: 'lostZone', name: 'Comfey' }), /Lost Zone is full/);
  });

  it('are safe for two producers: adding never collides, taking a card out collides only on that card', () => {
    assert.equal(actions.resolve('action:trainerA', { action: 'pileAdd', pile: 'discard', name: 'x' }).targets(), null);
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'pileRemove', pile: 'discard', id: 'c1' }).targets(), ['trainerA.discard.c1']);
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'pileMove', from: 'discard', to: 'lostZone', id: 'c1' }).targets(), ['trainerA.discard.c1']);
    assert.deepEqual(actions.resolve('action:trainerA', { action: 'pileClear', pile: 'discard' }).targets(), ['trainerA.discard']);
  });

  it('take the cards of a knocked out Pokémon: its earlier stages, itself, its tools and its Energy', () => {
    const gs = makeGame();
    run(gs, 'action:trainerA', { action: 'setDecklist', text: LIST });
    gs.setPokemon('trainerB', -1, { cardId: 'sv6-128', name: 'Dreepy', image: '/img/dreepy.png', hp: 70 });
    gs.setPokemon('trainerB', -1, { cardId: 'sv6-130', name: 'Dragapult ex', image: '/img/dragapult.png', hp: 320 }, { keep: true });
    gs.attachTool('trainerB', -1, card('Bravery Charm'));
    gs.attachSpecialEnergy('trainerB', -1, card('Luminous Energy'));
    gs.attachEnergy('trainerB', -1, 'fire');
    gs.attachEnergy('trainerB', -1, 'psychic');
    // (and trainer A, with the decklist, has a picture for its Fire Energy)
    gs.setPokemon('trainerA', 0, { cardId: 'sv6-128', name: 'Dreepy', image: '/img/dreepy.png', hp: 70 });
    gs.attachEnergy('trainerA', 0, 'fire');

    run(gs, 'action:trainerB', { action: 'knockOut', slot: -1, prizes: 2 });
    assert.deepEqual(gs.state.trainerB.discard.map((one) => one.name), ['Dreepy', 'Dragapult ex', 'Bravery Charm', 'Luminous Energy', 'Fire Energy', 'Psychic Energy']);
    assert.deepEqual(gs.state.trainerB.discard.slice(4).map((one) => [one.energy, one.image]), [['fire', ''], ['psychic', '']], 'basic Energy: the type, no picture without a decklist');
    assert.equal(gs.state.trainerB.active.name, '', 'and it is off the table');

    const ko = run(gs, 'action:trainerA', { action: 'knockOut', slot: 0, pile: 'lostZone' });
    assert.match(ko.label(gs), /to the Lost Zone$/);
    assert.deepEqual(gs.state.trainerA.lostZone.map((one) => one.name), ['Dreepy', 'Fire Energy']);
    assert.equal(gs.state.trainerA.lostZone[1].image, '/img/sve/2.png', 'the picture of the decklist\'s Fire Energy');
    assert.equal(gs.state.trainerA.discard.length, 0);
  });

  it('take nothing when the Pokémon stays on the table or the producer says none, and the same for several knocked out at once', () => {
    const gs = makeGame();
    gs.setPokemon('trainerA', -1, card('Pikachu'));
    run(gs, 'action:trainerA', { action: 'knockOut', slot: -1, clear: false });
    assert.equal(gs.state.trainerA.discard.length, 0);
    run(gs, 'action:trainerA', { action: 'knockOut', slot: -1, pile: 'none' });
    assert.equal(gs.state.trainerA.discard.length, 0);
    assert.throws(() => run(gs, 'action:trainerA', { action: 'knockOut', slot: -1, pile: 'hand' }), actions.ActionError);

    gs.setPokemon('trainerA', -1, card('Pikachu'));
    gs.setPokemon('trainerA', 1, card('Raichu'));
    gs.setPokemon('trainerB', 2, card('Comfey'));
    run(gs, 'action:match', { action: 'knockOutMany', knockouts: [{ side: 'trainerA', slot: -1 }, { side: 'trainerA', slot: 1 }] });
    assert.deepEqual(gs.state.trainerA.discard.map((one) => one.name), ['Pikachu', 'Raichu']);
    run(gs, 'action:match', { action: 'knockOutMany', knockouts: [{ side: 'trainerB', slot: 2 }], pile: 'lostZone' });
    assert.deepEqual(gs.state.trainerB.lostZone.map((one) => one.name), ['Comfey']);
  });

  it('are emptied for the next game and a new match, and come back from a save (cleaned)', () => {
    const gs = makeGame();
    gs.addToPile('trainerA', 'discard', card('Arven'));
    gs.addToPile('trainerB', 'lostZone', card('Comfey'));
    const saved = JSON.parse(JSON.stringify(gs.state));
    saved.trainerA.discard.push({ name: '' }, 'x', { name: 'Odd', energy: 'plasma', image: 7 });
    delete saved.trainerB.discard;
    const again = makeGame({ saved });
    assert.deepEqual(again.state.trainerA.discard.map((one) => one.name), ['Arven', 'Odd']);
    assert.equal(again.state.trainerA.discard[0].id, gs.state.trainerA.discard[0].id, 'the ids stay');
    assert.ok(again.state.trainerA.discard[1].id, 'and a card without one gets one');
    assert.equal(again.state.trainerA.discard[1].energy, undefined);
    assert.deepEqual(again.state.trainerB.discard, []);
    assert.equal(again.state.trainerB.lostZone.length, 1);

    gs.nextGame();
    assert.deepEqual([gs.state.trainerA.discard, gs.state.trainerB.lostZone], [[], []]);
    gs.addToPile('trainerA', 'discard', card('Arven'));
    gs.startGame();
    assert.deepEqual(gs.state.trainerA.discard, []);
  });

  it('show on the overlay unless the producer switches them off', () => {
    assert.equal(DISPLAY.DEFAULTS.discardPile, true);
    assert.equal(DISPLAY.DEFAULTS.lostZone, true);
  });
});
