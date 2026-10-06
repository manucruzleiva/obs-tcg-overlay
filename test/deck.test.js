/**
 * The deck of a trainer: what a deck text names (a Pokémon or an energy type) and the picture that goes next to it, the Pokédex it is
 * looked up in, the state and the actions, and the pictures of Pokémon through the server.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const POKEDEX = require('../public/js/pokedex');
const DECK = require('../public/js/deck');
const GAME = require('../public/js/game-data');
const DISPLAY = require('../public/js/display-options');
const GameStateService = require('../src/services/gamestate');
const actions = require('../src/actions');
const { startServer, startMockImageHost, respond } = require('../test-support/harness');

const makeGame = (saved = null) => new GameStateService({
  loadGameState: () => saved, saveGameState() {}, saveMatch() {}, addFavorite() {}, removeFavorite() {}
}, { selectBestImageUrl: () => '' });

describe('the Pokédex', () => {
  it('has every Pokémon in Pokédex order, from Bulbasaur to the newest', () => {
    assert.ok(POKEDEX.COUNT >= 1025, `${POKEDEX.COUNT} Pokémon`);
    assert.equal(POKEDEX.NAMES.length, POKEDEX.COUNT);
    assert.equal(POKEDEX.nameOf(1), 'Bulbasaur');
    assert.equal(POKEDEX.nameOf(25), 'Pikachu');
    assert.equal(POKEDEX.nameOf(1025), 'Pecharunt');
    assert.equal(POKEDEX.nameOf(0), '');
    assert.equal(POKEDEX.nameOf(POKEDEX.COUNT + 1), '');
    assert.equal(new Set(POKEDEX.NAMES).size, POKEDEX.COUNT, 'each once');
  });

  it('finds the Pokémon a deck is named after, however it is written', () => {
    for (const [text, id] of [
      ['Charizard ex', 6], ['charizard EX', 6], ['  Pikachu  ', 25], ['Mr. Mime', 122], ["Farfetch'd", 83], ['Farfetch’d', 83], ['Nidoran♀', 29], ['Nidoran♂', 32],
      ['Type: Null', 772], ['Ho-Oh', 250], ['Ho Oh', 250], ['Tapu Koko', 785], ['Roaring Moon ex', 1005], ['Iron Hands ex', 992], ['Chien-Pao Baxcalibur', 1002],
      ['Flabébé', 669], ['Porygon-Z', 474], ['Mime Jr.', 439], ['Zacian V', 888], ['Raging Bolt ex', 1021]
    ]) {
      assert.equal(POKEDEX.idOf(text), id, text);
    }
  });

  it('looks a few words in, for a Pokémon that comes after its trainer, its region or what kind of deck it is', () => {
    for (const [text, id] of [["Team Rocket's Mewtwo ex", 150], ['Hisuian Zoroark', 571], ['Alolan Ninetales', 38], ['Mega Charizard X ex', 6], ['Lost Box Comfey', 764], ["Cynthia's Garchomp ex", 445]]) {
      assert.equal(POKEDEX.idOf(text), id, text);
    }
    assert.equal(POKEDEX.idOf('Charizard Pidgeot'), 6, 'the first one it names');
    assert.equal(POKEDEX.idOf('a deck with a long name before Pikachu'), 0, 'but not far in');
  });

  it('finds nothing in a deck that names no Pokémon, or in what is not text', () => {
    for (const nothing of ['Lost Zone Box', 'Lightning GLC', 'Control', '', '   ', 'ex', undefined, null, 25, {}]) assert.equal(POKEDEX.idOf(nothing), 0, String(nothing));
  });
});

describe('the picture next to a deck', () => {
  const pokemon = (id) => ({ kind: 'pokemon', id, name: POKEDEX.nameOf(id), src: `/img/sprite/${id}.png` });
  const energy = (key) => {
    const type = GAME.ENERGY_TYPES.find((item) => item.key === key);
    return { kind: 'energy', key, name: `${type.label} energy`, src: type.icon };
  };

  it('is the Pokémon the deck names, from the pictures this app keeps', () => {
    assert.deepEqual(DECK.pictureFor('Charizard ex', ''), pokemon(6));
    assert.deepEqual(DECK.pictureFor('Gardevoir ex'), pokemon(282));
    assert.equal(DECK.spriteUrl(25), '/img/sprite/25.png');
  });

  it('is the energy type the deck names when it names no Pokémon, also by the names people use', () => {
    assert.deepEqual(DECK.pictureFor('Lightning GLC', ''), energy('lightning'));
    assert.deepEqual(DECK.pictureFor('Water Box'), energy('water'));
    assert.deepEqual(DECK.pictureFor('Electric'), energy('lightning'));
    assert.deepEqual(DECK.pictureFor('dark'), energy('darkness'));
    assert.deepEqual(DECK.pictureFor('Steel GLC'), energy('metal'));
    assert.deepEqual(DECK.pictureFor('Normal'), energy('colorless'));
    for (const type of GAME.ENERGY_TYPES) assert.deepEqual(DECK.pictureFor(type.label), energy(type.key), type.label);
    assert.deepEqual(DECK.pictureFor('Dark Gardevoir'), pokemon(282), 'a Pokémon says more about a deck than its type');
  });

  it('is what the picture box names when it names something, and nothing when it says none', () => {
    assert.deepEqual(DECK.pictureFor('Control', 'Gardevoir'), pokemon(282));
    assert.deepEqual(DECK.pictureFor('Charizard ex', 'Fire'), energy('fire'), 'the picture box wins');
    assert.deepEqual(DECK.pictureFor('', 'Pikachu'), pokemon(25), 'a picture without a deck text');
    for (const none of ['none', 'None', ' NONE ']) assert.equal(DECK.pictureFor('Charizard ex', none), null, none);
    assert.equal(DECK.pictureFor('Charizard ex', 'Agumon'), null, 'a picture box that names nothing has no picture');
    assert.deepEqual(DECK.pictureFor('Charizard ex', '   '), pokemon(6), 'spaces are nothing written');
  });

  it('is nothing for a deck that names nothing', () => {
    for (const [deck, picture] of [['Lost Zone Box', ''], ['', ''], [undefined, undefined], [null, null], [7, 8]]) assert.equal(DECK.pictureFor(deck, picture), null, String(deck));
  });

  it('offers the energy types and every Pokémon while typing', () => {
    assert.deepEqual(DECK.energyNames(), GAME.ENERGY_TYPES.map((type) => type.label));
    const names = DECK.pokemonNames();
    assert.equal(names.length, POKEDEX.COUNT);
    assert.equal(names[5], 'Charizard');
    assert.ok(names.every((name) => POKEDEX.idOf(name) > 0), 'each of them is found again');
    assert.equal(DECK.MAX_LENGTH, 40);
    assert.equal(DECK.NO_PICTURE, 'none');
  });

  it('can be shown or hidden on the overlay, the text and the picture on their own, both shown at first', () => {
    assert.ok(DISPLAY.KEYS.includes('deckType'));
    assert.ok(DISPLAY.KEYS.includes('deckIcon'));
    assert.equal(DISPLAY.DEFAULTS.deckType, true);
    assert.equal(DISPLAY.DEFAULTS.deckIcon, true);
    assert.equal(DISPLAY.GROUPS.find((group) => group.id === 'trainer').options.some((option) => option.key === 'deckType'), true, 'with the trainers');
  });
});

describe('the deck in the game', () => {
  it('starts with none, and keeps what is set for each trainer', () => {
    const gs = makeGame();
    assert.deepEqual([gs.state.trainerA.deck, gs.state.trainerA.deckIcon, gs.state.trainerB.deck], ['', '', '']);
    gs.state.trainerA.name = 'Ash';
    const set = actions.resolve('action:trainerA', { action: 'setDeck', deck: '  Charizard ex  ' });
    set.run(gs);
    assert.equal(gs.state.trainerA.deck, 'Charizard ex');
    assert.equal(set.label(gs), 'Ash deck → Charizard ex');
    const picture = actions.resolve('action:trainerA', { action: 'setDeckIcon', icon: 'Pidgeot' });
    picture.run(gs);
    assert.equal(gs.state.trainerA.deckIcon, 'Pidgeot');
    assert.equal(picture.label(gs), 'Ash deck picture → Pidgeot');
    actions.resolve('action:trainerA', { action: 'setDeckIcon', icon: '' }).run(gs);
    assert.equal(actions.resolve('action:trainerA', { action: 'setDeckIcon', icon: '' }).label(gs), 'Ash deck picture → automatic');
    assert.equal(gs.state.trainerB.deck, '', 'the other trainer has none');
  });

  it('cuts what is too long, and refuses what is not text', () => {
    const gs = makeGame();
    actions.resolve('action:trainerB', { action: 'setDeck', deck: 'x'.repeat(80) }).run(gs);
    assert.equal(gs.state.trainerB.deck.length, 40);
    for (const payload of [{ action: 'setDeck', deck: 5 }, { action: 'setDeck', deck: ['a'] }, { action: 'setDeckIcon', icon: {} }]) {
      assert.throws(() => actions.resolve('action:trainerB', payload).run(gs), actions.ActionError, JSON.stringify(payload));
    }
    actions.resolve('action:trainerB', { action: 'setDeck' }).run(gs);
    assert.equal(gs.state.trainerB.deck, '', 'nothing sent is no deck');
  });

  it('is last writer wins, as the name is', () => {
    assert.equal(actions.resolve('action:trainerA', { action: 'setDeck', deck: 'x' }).targets(), null);
    assert.equal(actions.resolve('action:trainerA', { action: 'setDeckIcon', icon: 'x' }).targets(), null);
  });

  it('comes back from a saved game, and a game saved before the deck existed has none', () => {
    const gs = makeGame();
    gs.setDeck('trainerA', 'Gardevoir ex');
    gs.setDeckIcon('trainerA', 'none');
    const saved = JSON.parse(JSON.stringify(gs.state));
    const again = makeGame(saved);
    assert.deepEqual([again.state.trainerA.deck, again.state.trainerA.deckIcon], ['Gardevoir ex', 'none']);

    delete saved.trainerA.deck;
    delete saved.trainerA.deckIcon;
    saved.trainerB.deck = 42;
    saved.trainerB.deckIcon = 'y'.repeat(99);
    const old = makeGame(saved);
    assert.deepEqual([old.state.trainerA.deck, old.state.trainerA.deckIcon, old.state.trainerB.deck, old.state.trainerB.deckIcon.length], ['', '', '', 40]);
  });

  it('stays for the next game and a new match: it is the trainer\'s deck', () => {
    const gs = makeGame();
    gs.setDeck('trainerA', 'Charizard ex');
    gs.nextGame();
    gs.startGame();
    assert.equal(gs.state.trainerA.deck, 'Charizard ex');
  });
});

describe('the pictures of Pokémon through the server', () => {
  let sprites;
  let server;
  let producer;

  before(async () => {
    sprites = await startMockImageHost((url) => (url === '/151.png' ? respond(500, 'broken', { 'Content-Type': 'text/plain' }) : null));
    server = await startServer({ label: 'deck', env: { OTO_SPRITE_BASE: sprites.url } });
    producer = server.client({ clientId: 'deck-producer' });
    await producer.ready();
  });
  after(async () => {
    if (server) await server.stop();
    if (sprites) await sprites.close();
  });

  it('serves the picture of a Pokémon by its number, fetched once and kept after that, open like the overlay', async () => {
    const first = await fetch(`${server.base}/img/sprite/6.png`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), sprites.png);
    assert.equal((await fetch(`${server.base}/img/sprite/6.png`)).status, 200);
    assert.deepEqual(sprites.requests, ['/6.png'], 'the sprites host was asked once');
  });

  it('serves nothing for a number that is not a Pokémon, and says so when the picture cannot be had', async () => {
    for (const route of ['/img/sprite/0.png', '/img/sprite/1026.png', '/img/sprite/abc.png', '/img/sprite/6.jpg', '/img/sprite/..%2F6.png']) {
      assert.equal((await fetch(`${server.base}${route}`)).status, 404, route);
    }
    assert.equal((await fetch(`${server.base}/img/sprite/151.png`)).status, 404, 'the host failed');
    assert.ok(sprites.requests.every((url) => /^\/\d+\.png$/.test(url)), sprites.requests.join(' '));
  });

  it('keeps the deck of each trainer in the game everybody sees', async () => {
    await producer.act('action:trainerA', { action: 'setDeck', deck: 'Raging Bolt ex' });
    const result = await producer.act('action:trainerB', { action: 'setDeckIcon', icon: 'Water' });
    assert.equal(result.ok, true);
    const state = await (await fetch(`${server.base}/api/state`)).json();
    assert.deepEqual([state.trainerA.deck, state.trainerA.deckIcon, state.trainerB.deck, state.trainerB.deckIcon], ['Raging Bolt ex', '', '', 'Water']);
  });
});
