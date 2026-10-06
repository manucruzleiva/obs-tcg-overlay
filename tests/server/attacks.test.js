/**
 * What a card says about its attacks and its retreat cost, as the game keeps it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseDamage, attackOf, attacksOf, retreatOf, MAX_ATTACKS } = require('../../src/services/attacks');

describe('the damage of an attack', () => {
  it('is the number on the card, and what came after it', () => {
    assert.deepEqual(parseDamage('30'), { damage: 30, mod: '' });
    assert.deepEqual(parseDamage('50+'), { damage: 50, mod: '+' });
    assert.deepEqual(parseDamage('20×'), { damage: 20, mod: '×' });
    assert.deepEqual(parseDamage('20x'), { damage: 20, mod: '×' });
    assert.deepEqual(parseDamage('10-'), { damage: 10, mod: '-' });
    assert.deepEqual(parseDamage(' 120 '), { damage: 120, mod: '' });
    assert.deepEqual(parseDamage(60), { damage: 60, mod: '' }, 'TCGdex sometimes sends a number');
  });

  it('is nothing for an attack that does something else', () => {
    for (const value of ['', undefined, null, 'Special', '+', {}, [], NaN, -5, '??']) {
      assert.deepEqual(parseDamage(value), { damage: 0, mod: '' }, String(value));
    }
    assert.equal(parseDamage(99999).damage, 9999, 'and never absurd');
  });
});

describe('an attack from card data', () => {
  it('has a name and a base damage', () => {
    assert.deepEqual(attackOf({ name: 'Thunderbolt', damage: '120', cost: ['Lightning'], text: 'Discard all Energy.' }), { name: 'Thunderbolt', damage: 120, mod: '' });
    assert.deepEqual(attackOf('Quick Attack'), { name: 'Quick Attack', damage: 0, mod: '' }, 'a bare name is fine');
    assert.deepEqual(attackOf({ name: '  Spaced  ', damage: 30, mod: '+' }), { name: 'Spaced', damage: 30, mod: '+' });
    assert.equal(attackOf({ name: 'x'.repeat(200) }).name.length, 60);
  });

  it('is nothing without a name', () => {
    for (const value of [null, undefined, {}, { damage: 10 }, { name: '' }, { name: '   ' }, { name: 5 }, 7, []]) assert.equal(attackOf(value), null, JSON.stringify(value));
  });

  it('makes a list of the ones that have names, up to four, and says "no information" for anything else', () => {
    assert.deepEqual(attacksOf([{ name: 'A', damage: '10' }, null, { name: '' }, 'B']), [{ name: 'A', damage: 10, mod: '' }, { name: 'B', damage: 0, mod: '' }]);
    assert.equal(attacksOf(Array.from({ length: 9 }, (_, i) => ({ name: `Attack ${i}` }))).length, MAX_ATTACKS);
    assert.deepEqual(attacksOf([]), []);
    for (const value of [undefined, null, 'Gnaw', {}, 5]) assert.equal(attacksOf(value), undefined, String(value));
  });
});

describe('the retreat cost', () => {
  it('is read from the number or the list of costs', () => {
    assert.equal(retreatOf({ convertedRetreatCost: 2 }), 2);
    assert.equal(retreatOf({ retreat: 3 }), 3);
    assert.equal(retreatOf({ retreatCost: ['Colorless', 'Colorless', 'Colorless'] }), 3);
    assert.equal(retreatOf({ retreat: 0 }), 0, 'free to retreat is a cost of its own');
    assert.equal(retreatOf({ retreat: '2' }), 2);
    assert.equal(retreatOf({ retreat: 40 }), 6, 'never more than six');
    assert.equal(retreatOf({ retreat: -3 }), 0);
  });

  it('is "no information" when the card says nothing', () => {
    for (const value of [undefined, null, {}, { retreat: null }, { retreat: 'free' }, 'x', 5]) assert.equal(retreatOf(value), undefined, JSON.stringify(value));
  });
});
