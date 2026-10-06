/**
 * Countries and their flags: what a trainer's nationality turns into when the overlay shows flags.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const COUNTRIES = require('../public/js/countries');
const DISPLAY = require('../public/js/display-options');

const { flagOf, nameOf } = COUNTRIES;

// the two letters of a flag, as the characters a flag is made of
const pair = (code) => String.fromCodePoint(...[...code].map((letter) => 0x1F1E6 + letter.charCodeAt(0) - 65));

describe('the flag of a country', () => {
  it('comes from the two-letter code, in any case', () => {
    assert.equal(flagOf('US'), pair('US'));
    assert.equal(flagOf('cl'), pair('CL'));
    assert.equal(flagOf(' Jp '), pair('JP'));
  });

  it('comes from the three-letter code the control panel offers', () => {
    assert.equal(flagOf('USA'), pair('US'));
    assert.equal(flagOf('chl'), pair('CL'));
    assert.equal(flagOf('KOR'), pair('KR'));
    assert.equal(flagOf('DEU'), pair('DE'));
    assert.equal(flagOf('GBR'), pair('GB'));
  });

  it('knows every code the control panel offers, and says which country it is', () => {
    assert.equal(COUNTRIES.COMMON.length, 39);
    for (const code of COUNTRIES.COMMON) {
      assert.match(flagOf(code), /^[\u{1F1E6}-\u{1F1FF}]{2}$/u, code);
      assert.ok(nameOf(code).length > 2, code);
    }
    assert.equal(nameOf('CHL'), 'Chile');
    assert.equal(nameOf('USA'), 'United States');
  });

  it('knows all the countries of the ISO list, each with a flag of two letters', () => {
    const codes = Object.entries(COUNTRIES.ALPHA3);
    assert.ok(codes.length >= 249);
    for (const [three, two] of codes) {
      assert.equal(flagOf(three), pair(two), three);
      assert.equal(flagOf(two), pair(two), two);
    }
  });

  it('comes from the name of the country in English, as it is said or as ISO writes it', () => {
    assert.equal(flagOf('Chile'), pair('CL'));
    assert.equal(flagOf('  united states  '), pair('US'));
    assert.equal(flagOf('South Korea'), pair('KR'));
    assert.equal(flagOf('Russia'), pair('RU'));
    assert.equal(flagOf('Czech Republic'), pair('CZ'));
    assert.equal(flagOf("Côte d'Ivoire"), pair('CI'));
    assert.equal(flagOf('cote d ivoire'), pair('CI'));
    assert.equal(flagOf('Hong Kong'), pair('HK'));
    assert.equal(flagOf('Japan'), pair('JP'));
    assert.equal(nameOf('south korea'), 'South Korea');
  });

  it('understands the codes sports use that are not the ISO ones', () => {
    assert.equal(flagOf('GER'), pair('DE'));
    assert.equal(flagOf('CHI'), pair('CL'), 'CHI is Chile, as in the Olympic list');
    assert.equal(flagOf('SUI'), pair('CH'));
    assert.equal(flagOf('NED'), pair('NL'));
    assert.equal(flagOf('UK'), pair('GB'));
    assert.equal(flagOf('UAE'), pair('AE'));
  });

  it('has flags for England, Scotland and Wales, which are not countries of the ISO list', () => {
    const tag = (text) => String.fromCodePoint(0x1F3F4, ...[...text].map((letter) => 0xE0000 + letter.charCodeAt(0)), 0xE007F);
    assert.equal(flagOf('ENG'), tag('gbeng'));
    assert.equal(flagOf('Scotland'), tag('gbsct'));
    assert.equal(flagOf('wal'), tag('gbwls'));
    assert.equal(nameOf('ENG'), 'England');
  });

  it('keeps a flag that was pasted as it is', () => {
    assert.equal(flagOf('🇨🇱'), '🇨🇱');
    assert.equal(flagOf('Team 🇧🇷'), '🇧🇷');
    assert.equal(flagOf(flagOf('ENG')), flagOf('ENG'));
  });

  it('is empty for what is not a country, so the overlay keeps the text', () => {
    for (const text of ['', '   ', 'XYZ', 'ZZ', 'Narnia', '12', 'U S A', 'Team Rocket', 'a'.repeat(100), null, undefined, 42, {}, ['US']]) {
      assert.equal(flagOf(text), '', JSON.stringify(text));
      assert.equal(nameOf(text), '', JSON.stringify(text));
    }
  });
});

describe('showing the nationality as a flag is a choice of the overlay', () => {
  it('is off to begin with, and is a way of drawing the nationality, not a piece to show or hide', () => {
    assert.equal(DISPLAY.DEFAULTS.nationalityFlag, false, 'the text stays unless someone chooses flags');
    assert.deepEqual(DISPLAY.STYLE_KEYS, ['nationalityFlag', 'benchRow', 'toolNames'], 'the other ways of drawing something are the bench in a row and the tools by name');
    assert.ok(DISPLAY.KEYS.includes('nationalityFlag'));
    const group = DISPLAY.GROUPS.find((entry) => entry.options.some((option) => option.key === 'nationalityFlag'));
    assert.equal(group.id, 'trainer');
    const keys = group.options.map((option) => option.key);
    assert.equal(keys.indexOf('nationalityFlag'), keys.indexOf('nationality') + 1, 'next to the nationality');
  });
});
