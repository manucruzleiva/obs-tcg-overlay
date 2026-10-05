/**
 * The cards producers use most, and the cards already saved on this computer: what the card picker starts from.
 * Uses the real database code, in memory.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const SQL = require('sql.js/dist/sql-asm.js');

const DatabaseService = require('../src/db/database');
const CacheService = require('../src/services/cache');
const { CardUsage, summaryOf } = require('../src/services/card-usage');
const { localImageUrl } = require('../src/services/images');

async function memoryDb() {
  const db = new DatabaseService();
  const sql = await SQL();
  db.db = new sql.Database();
  db.runSchema();
  return db;
}

const card = (id, name, extra = {}) => ({
  id, name, setName: 'Base', setId: 'base1', number: id.split('-')[1] || '1', rarity: 'Common', types: 'Fire', hp: '60',
  supertype: 'Pokémon', subtypes: 'Basic', images: { small: `/img/base1/${id}.png`, large: `/img/base1/${id}_hires.png` }, ...extra
});

describe('card usage', () => {
  let db;
  let usage;
  beforeEach(async () => {
    db = await memoryDb();
    usage = new CardUsage({ db, localize: (item) => ({ ...item, images: Object.fromEntries(Object.entries(item.images || {}).map(([size, url]) => [size, localImageUrl(url)])) }) });
  });

  it('lists the most used cards first, and among equals the latest', () => {
    const at = (id, uses, when) => { for (let i = 0; i < uses; i++) db.recordCardUse(id, card(id, `Card ${id}`), when + i); };
    at('base1-1', 1, 1000);
    at('base1-2', 3, 2000);
    at('base1-3', 3, 3000);
    at('base1-4', 2, 4000);
    const { cards, totalCount, source, used } = usage.popular();
    assert.deepEqual(cards.map((entry) => entry.id), ['base1-3', 'base1-2', 'base1-4', 'base1-1']);
    assert.equal(totalCount, 4);
    assert.equal(used, 4);
    assert.equal(source, 'used');
  });

  it('counts a card each time it is picked, and keeps the latest look of it', () => {
    assert.equal(usage.record(card('base1-5', 'Old name')), true);
    assert.equal(usage.record(card('base1-5', 'New name')), true);
    const [only] = db.usedCards();
    assert.equal(only.uses, 2);
    assert.equal(only.card.name, 'New name');
  });

  it('keeps only what a card is: a safe id, a name, secure pictures, known kinds', () => {
    for (const bad of [null, 'card', 5, [], {}, { id: 'a b', name: 'x' }, { id: '../x', name: 'x' }, { id: 'x'.repeat(41), name: 'x' }, { id: 'ok-1', name: '   ' }, { id: 'ok-1' }]) {
      assert.equal(usage.record(bad), false, JSON.stringify(bad));
    }
    assert.deepEqual(db.usedCards(), []);

    const clean = summaryOf({
      id: 'sv1-1', name: ' Pikachu ', hp: 70, number: 25, supertype: 'Spell', subtypes: 'Basic', setName: 'S'.repeat(300),
      images: { small: 'javascript:alert(1)', large: 'http://insecure.test/x.png' }, evil: '<script>', rarity: ''
    });
    assert.equal(clean.name, 'Pikachu');
    assert.equal(clean.hp, '70');
    assert.equal(clean.number, '25');
    assert.equal(clean.supertype, '', 'a kind the game does not have is nothing');
    assert.equal(clean.setName.length, 100);
    assert.deepEqual(clean.images, { small: '', large: '' }, 'neither a script nor an unsecured address is a picture');
    assert.equal(clean.rarity, 'Unknown');
    assert.equal('evil' in clean, false);
    assert.deepEqual(summaryOf({ id: 'x-1', name: 'x', images: { small: '//other.test/x.png', large: 'https://ok.test/x.png' } }).images, { small: '', large: 'https://ok.test/x.png' });
  });

  it('narrows the list to what the picker is looking for', () => {
    const pikachu = card('base1-1', 'Pikachu');
    const stadium = card('base1-2', 'Area Zero', { supertype: 'Trainer', subtypes: 'Stadium' });
    const supporter = card('base1-3', 'Iono', { supertype: 'Trainer', subtypes: 'Supporter' });
    const turbo = card('base1-4', 'Double Turbo Energy', { supertype: 'Energy', subtypes: 'Special' });
    const evolved = card('base1-5', 'Raichu ex', { subtypes: 'Stage 1, ex' });
    [pikachu, stadium, supporter, turbo, evolved].forEach((item) => usage.record(item));

    const names = (filters) => usage.popular(filters).cards.map((entry) => entry.name).sort();
    assert.deepEqual(names({ supertype: 'Pokémon' }), ['Pikachu', 'Raichu ex']);
    assert.deepEqual(names({ supertype: 'Trainer', subtype: 'Stadium' }), ['Area Zero']);
    assert.deepEqual(names({ supertype: 'Energy', subtype: 'Special' }), ['Double Turbo Energy']);
    assert.deepEqual(names({ supertype: 'Pokémon', subtype: 'ex' }), ['Raichu ex'], 'one of several kinds');
    assert.deepEqual(names({ supertype: 'Pokémon', subtype: 'Stage' }), [], 'a part of a kind is not the kind');
    assert.equal(names({}).length, 5);
  });

  it('pages the list', () => {
    for (let i = 1; i <= 45; i++) usage.record(card(`base1-${i}`, `Card ${i}`));
    const first = usage.popular({ page: 1 });
    assert.equal(first.cards.length, 20);
    assert.equal(first.totalCount, 45);
    assert.equal(first.pageSize, 20);
    assert.equal(usage.popular({ page: 3 }).cards.length, 5);
    assert.equal(usage.popular({ page: 4 }).cards.length, 0);
    assert.deepEqual(new Set([...usage.popular({ page: 1 }).cards, ...usage.popular({ page: 2 }).cards, ...usage.popular({ page: 3 }).cards].map((entry) => entry.id)).size, 45, 'every card once');
  });

  it('adds the cards already saved by earlier lookups and searches after the ones used', async () => {
    const cache = new CacheService(db);
    await cache.setCard('base1-9', 'pokemontcg', { ...card('base1-9', 'Looked Up'), images: { small: 'https://images.pokemontcg.io/base1/9.png', large: 'https://images.pokemontcg.io/base1/9_hires.png' } });
    await cache.setSearch('pokemontcg', 'name:"char*"', 1, { cards: [card('base1-4', 'Charizard'), card('base1-9', 'Looked Up again')], totalCount: 2 });
    usage.record(card('base1-4', 'Charizard'));

    const { cards, source, used, totalCount } = usage.popular();
    assert.deepEqual(cards.map((entry) => entry.id), ['base1-4', 'base1-9'], 'used first, then saved; a card is listed once');
    assert.equal(cards[1].name, 'Looked Up', 'the lookup of the card itself is the first one listed');
    assert.equal(cards[1].images.small, '/img/base1/9.png', 'its picture is the copy this app keeps');
    assert.equal(source, 'mixed');
    assert.equal(used, 1);
    assert.equal(totalCount, 2);
  });

  it('is made of the saved cards alone when nothing was used yet', async () => {
    const cache = new CacheService(db);
    await cache.setSearch('pokemontcg', 'name:"pika*"', 1, { cards: [card('base1-1', 'Pikachu'), card('base1-2', 'Area Zero', { supertype: 'Trainer', subtypes: 'Stadium' })], totalCount: 2 });
    const all = usage.popular();
    assert.equal(all.source, 'cache');
    assert.equal(all.used, 0);
    assert.deepEqual(all.cards.map((entry) => entry.name).sort(), ['Area Zero', 'Pikachu']);
    assert.deepEqual(usage.popular({ supertype: 'Trainer', subtype: 'Stadium' }).cards.map((entry) => entry.name), ['Area Zero']);
  });

  it('leaves out saved lookups that have run out, and rows that are not cards', async () => {
    const cache = new CacheService(db);
    db.setCard('base1-1', 'pokemontcg', card('base1-1', 'Stale'), -1000); // already expired
    db.setSearch('k1', 'pokemontcg', 'q', 1, { cards: [card('base1-2', 'Fresh'), { nonsense: true }, null] });
    db.db.run('INSERT INTO card_cache (card_id, provider, data_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', ['bad', 'x', '{not json', Date.now(), Date.now() + 100000]);
    assert.deepEqual(usage.popular().cards.map((entry) => entry.name), ['Fresh']);
    assert.ok(cache);
  });

  it('is empty when there is nothing', () => {
    assert.deepEqual(usage.popular(), { cards: [], totalCount: 0, page: 1, pageSize: 20, source: 'cache', used: 0 });
  });

  it('forgets what was used, and clearing the lookup cache leaves the usage alone', async () => {
    const cache = new CacheService(db);
    usage.record(card('base1-1', 'Pikachu'));
    await cache.setCard('base1-2', 'pokemontcg', card('base1-2', 'Saved'));
    cache.clearAll();
    assert.deepEqual(usage.popular().cards.map((entry) => entry.name), ['Pikachu'], 'the saved lookups are gone for good, not just in memory');
    usage.clear();
    assert.deepEqual(usage.popular().cards, []);
  });

  it('really clears the lookup cache from the disk side too', async () => {
    const cache = new CacheService(db);
    await cache.setCard('base1-1', 'pokemontcg', card('base1-1', 'Saved'));
    await cache.setSearch('pokemontcg', 'q', 1, { cards: [card('base1-2', 'Found')] });
    db.setETag('https://x.test/cards', 'W/"1"');
    cache.clearAll();
    assert.equal(db.getCard('base1-1'), null);
    assert.equal(await cache.getCard('base1-1'), null);
    assert.equal(await cache.getSearch('pokemontcg', 'q', 1), null);
    assert.equal(db.getETag('https://x.test/cards'), null);
  });
});
