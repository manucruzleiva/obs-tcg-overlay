/**
 * The decks that are played the most, from Limitless TCG (src/services/limitless.js): reading the page, keeping the list, and handing it to the pages.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { LimitlessDecks, LimitlessError, parseDecks, cleanDecks, render, pokedexOf, slugOf } = require('../../src/services/limitless');
const { startServer, startMockImageHost } = require('../support/harness');

const icon = (slug) => `<img class="pokemon" src="https://r2.limitlesstcg.net/pokemon/gen9/${slug}.png" alt="${slug}">`;
const row = (rank, icons, nameHtml, points, share, id = 100 + rank) => `
        <tr>
            <td>${rank}</td>
            <td>${icons.map(icon).join('')}</td>
            <td><a href="/decks/${id}">${nameHtml}</a></td>
            <td>${points}</td>
            <td>${share}%</td>
        </tr>`;

// The page as Limitless writes it: a table with a rank, the sprites, the name (with an annotation), the points and the share
const PAGE = (rows) => `<html><body><table class="data-table striped">
    <tr><th>#</th><th></th><th>Deck</th><th>Points</th><th>Share</th></tr>${rows.join('')}
</table><ul class="pagination"><li>1</li></ul></body></html>`;

const SAMPLE = [
  row(1, ['dragapult'], 'Dragapult <span class="annotation">ex</span>', 1806, '33.43'),
  row(2, ['zoroark'], 'N&#039;s Zoroark <span class="annotation">ex</span>', 505, '9.35'),
  row(3, ['ogerpon', 'clefairy'], 'Basic Box <span class="annotation"></span>', 423, '7.83'),
  row(4, ['lopunny-mega'], 'Mega Lopunny <span class="annotation">ex</span>', 200, '3.96'),
  row(5, ['ogerpon-wellspring'], 'Tera Box &amp; Friends <span class="annotation">Memory</span>', 100, '0.15')
];

describe('reading the page of the decks', () => {
  it('takes the name, the share and the Pokémon of the icon of each deck, most played first', () => {
    const decks = parseDecks(PAGE(SAMPLE));
    assert.deepEqual(decks.map((deck) => deck.name), ['Dragapult ex', "N's Zoroark ex", 'Basic Box', 'Mega Lopunny ex', 'Tera Box & Friends Memory']);
    assert.deepEqual(decks.map((deck) => deck.share), [33.43, 9.35, 7.83, 3.96, 0.15]);
    assert.deepEqual(decks[0], { name: 'Dragapult ex', share: 33.43, pokemon: [887], icons: ['dragapult'] });
    assert.deepEqual(decks[2].pokemon, [1017, 35], 'two Pokémon on the icon: Ogerpon and Clefairy');
    assert.deepEqual(decks[2].icons, ['ogerpon', 'clefairy']);
  });

  it('knows the Pokémon of an icon that is of a form (Mega, a mask of Ogerpon)', () => {
    assert.equal(pokedexOf('lopunny-mega'), 428);
    assert.equal(pokedexOf('ogerpon-wellspring'), 1017);
    assert.equal(pokedexOf('raging-bolt'), 1021, 'a name with a hyphen that is the Pokémon\'s own');
    assert.equal(pokedexOf('charizard-mega-x'), 6);
    assert.equal(pokedexOf('not-a-pokemon'), 0);
    assert.equal(slugOf('https://r2.limitlesstcg.net/pokemon/gen9/ogerpon.png'), 'ogerpon');
    assert.equal(slugOf('https://x.test/<script>.png'), '');
    assert.equal(slugOf(undefined), '');
  });

  it('leaves out a row that has no icon, no link, or a name that came before, and keeps a deck whose icon is not a Pokémon it knows', () => {
    const rows = [
      ...SAMPLE.slice(0, 2),
      '<tr><td>3</td><td></td><td><a href="/decks/9">No Icon</a></td><td>1</td><td>1%</td></tr>',
      '<tr><td>4</td><td>' + icon('dragapult') + '</td><td>Not a link</td><td>1</td><td>1%</td></tr>',
      row(5, ['dragapult'], 'Dragapult <span class="annotation">ex</span>', 1, '1'),
      row(6, ['brand-new-pokemon'], 'Future Deck', 1, '0.5')
    ];
    const decks = parseDecks(PAGE(rows));
    assert.deepEqual(decks.map((deck) => deck.name), ['Dragapult ex', "N's Zoroark ex", 'Future Deck']);
    assert.deepEqual(decks[2], { name: 'Future Deck', share: 0.5, pokemon: [], icons: ['brand-new-pokemon'] });
  });

  it('takes nothing from a page that is not a list of decks, and never runs what is on it', () => {
    assert.deepEqual(parseDecks('<html><body>nothing here</body></html>'), []);
    assert.deepEqual(parseDecks(''), []);
    const hostile = PAGE([row(1, ['dragapult'], '<script>alert(1)</script>Evil <span class="annotation">ex</span>', 1, '1')]);
    const [deck] = parseDecks(hostile);
    assert.doesNotMatch(deck.name, /[<>]/);
  });
});

describe('the list as it is kept and handed to the pages', () => {
  it('is cleaned to the shape that is wanted: names, shares, Pokémon that exist, plain sprite names', () => {
    const cleaned = cleanDecks([
      { name: '  Good   Deck ', share: 12.3456, pokemon: [25, 0, 99999, 1.5, 'x', 6], icons: ['pikachu', 'Bad Name', '../x', 'ok-2'], extra: 'dropped' },
      { name: 'good deck', share: 1 },
      { name: '', share: 1 },
      { name: 'Wild', share: 'many', pokemon: 'no', icons: 7 },
      null,
      'text'
    ]);
    assert.deepEqual(cleaned, [
      { name: 'Good Deck', share: 12.35, pokemon: [25, 6], icons: ['pikachu', 'ok-2'] },
      { name: 'Wild', share: 0, pokemon: [], icons: [] }
    ]);
    assert.deepEqual(cleanDecks('not a list'), []);
  });

  it('becomes the file the pages load, which works as the module of the snapshot does, and can be given a newer list', () => {
    const text = render([{ name: "N's Zoroark ex", share: 9.35, pokemon: [571], icons: ['zoroark'] }, { name: 'Basic Box', share: 7.8, pokemon: [1017, 35], icons: ['ogerpon', 'clefairy'] }], { date: '2026-10-06' });
    const module = { exports: {} };
    new Function('module', 'self', text)(module, undefined);
    const popular = module.exports;
    assert.deepEqual(popular.NAMES, ["N's Zoroark ex", 'Basic Box']);
    assert.deepEqual(popular.find('ns zoroark EX').pokemon, [571], 'however it is written');
    assert.equal(popular.find('Dragapult ex'), null);
    assert.equal(popular.SOURCE.date, '2026-10-06');

    popular.replace([{ name: 'Dragapult ex', share: 33, pokemon: [887], icons: ['dragapult'] }], { date: '2026-10-07' });
    assert.deepEqual(popular.NAMES, ['Dragapult ex']);
    assert.deepEqual(popular.find('dragapult ex').pokemon, [887]);
    assert.equal(popular.find('Basic Box'), null);
    assert.equal(popular.SOURCE.date, '2026-10-07');
    popular.replace([]);
    assert.deepEqual(popular.NAMES, ['Dragapult ex'], 'an empty list changes nothing');
  });

  it('cannot carry code in a name', () => {
    const text = render([{ name: '"; process.exit(1); //', share: 1, pokemon: [25], icons: [] }]);
    const module = { exports: {} };
    new Function('module', 'self', text)(module, undefined);
    assert.deepEqual(module.exports.NAMES, ['"; process.exit(1); //']);
  });
});

describe('the service that keeps the list', () => {
  const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oto-limitless-'));
  const answering = (html, status = 200) => async (url, options) => ({ ok: status < 400, status, text: async () => html, url, options });

  it('starts with the snapshot that comes with the app, and reads the page when asked, keeping what it found', async () => {
    const dir = folder();
    const asked = [];
    const service = new LimitlessDecks({ dir, fetchImpl: async (url, options) => { asked.push([url, options.headers['User-Agent']]); return { ok: true, status: 200, text: async () => PAGE(SAMPLE) }; } });
    assert.equal(service.load(), null);
    const first = service.status();
    assert.equal(first.builtIn, true);
    assert.ok(first.count >= 20, `${first.count} decks come with the app`);
    assert.match(service.script(), /OTO_DECK_POPULAR/);

    const read = await service.refresh();
    assert.equal(read.builtIn, false);
    assert.equal(read.count, 5);
    assert.match(asked[0][0], /^https:\/\/limitlesstcg\.com\/decks\?show=100$/, 'it asks for a long list');
    assert.match(asked[0][1], /^obs-tcg-overlay\/.* \(\+https:\/\/github\.com\/manucruzleiva\/obs-tcg-overlay\)$/, 'it says what it is');
    assert.match(service.script(), /Tera Box & Friends Memory/);

    // another start of the app: the list is still there
    const again = new LimitlessDecks({ dir });
    assert.equal(again.load().decks.length, 5);
    assert.equal(again.status().builtIn, false);

    // and back to the snapshot
    assert.equal(again.clear().builtIn, true);
    assert.equal(fs.existsSync(path.join(dir, 'popular-decks.json')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the list it has when the page cannot be read, and says why', async () => {
    const dir = folder();
    const good = new LimitlessDecks({ dir, fetchImpl: answering(PAGE(SAMPLE)) });
    await good.refresh();
    for (const [what, fetchImpl, message] of [
      ['an error from the site', answering('', 503), /answered 503/],
      ['a page that is not a list', answering('<html>maintenance</html>'), /did not look like the list of decks/],
      ['no network', async () => { throw new Error('getaddrinfo ENOTFOUND'); }, /could not be reached: getaddrinfo ENOTFOUND/],
      ['a page far too big', answering('x'.repeat(3 * 1024 * 1024 + 1)), /far bigger than a list of decks/]
    ]) {
      const broken = new LimitlessDecks({ dir, fetchImpl });
      broken.load();
      await assert.rejects(() => broken.refresh(), (error) => error instanceof LimitlessError && message.test(error.message), what);
      assert.equal(broken.status().count, 5, `${what}: what it had stays`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shares one read between two askers, and ignores a file that was damaged', async () => {
    const dir = folder();
    let reads = 0;
    const service = new LimitlessDecks({ dir, fetchImpl: async () => { reads++; await new Promise((resolve) => setTimeout(resolve, 20)); return { ok: true, status: 200, text: async () => PAGE(SAMPLE) }; } });
    await Promise.all([service.refresh(), service.refresh()]);
    assert.equal(reads, 1);

    fs.writeFileSync(path.join(dir, 'popular-decks.json'), '{ not json');
    assert.equal(new LimitlessDecks({ dir }).load(), null);
    fs.writeFileSync(path.join(dir, 'popular-decks.json'), JSON.stringify({ version: 1, decks: [{ name: 'Only One', share: 1, pokemon: [1], icons: [] }] }));
    assert.equal(new LimitlessDecks({ dir }).load(), null, 'a list that short is not the list of decks');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the list of decks through the server', () => {
  let page; // the page of Limitless
  let pageServer;
  let images;
  let server;
  let producer;
  let served = PAGE(SAMPLE);
  let status = 200;

  const call = async (method, route) => {
    const response = await fetch(`${server.base}${route}`, { method });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text, type: response.headers.get('content-type') };
  };

  before(async () => {
    pageServer = http.createServer((req, res) => {
      page = req.url;
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/html');
      res.end(served);
    });
    await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
    images = await startMockImageHost();
    server = await startServer({
      label: 'limitless',
      env: { OTO_LIMITLESS_URL: `http://127.0.0.1:${pageServer.address().port}/decks`, OTO_DECKICON_BASE: images.url }
    });
    producer = server.client({ clientId: 'decks-producer', name: 'Maya' });
    await producer.ready();
  });

  after(async () => {
    if (server) await server.stop();
    await Promise.all([images && images.close(), pageServer && new Promise((resolve) => { pageServer.closeAllConnections(); pageServer.close(resolve); })]);
  });

  it('gives the pages the snapshot that comes with the app until a producer reads the page again', async () => {
    const before = await call('GET', '/api/decks/popular');
    assert.equal(before.status, 200);
    assert.equal(before.json.builtIn, true);
    const script = await call('GET', '/js/deck-popular.js');
    assert.match(script.type, /javascript/);
    assert.match(script.text, /Dragapult ex/);
    assert.doesNotMatch(script.text, /Tera Box & Friends/);
  });

  it('reads the page when a producer asks, tells every page, and the pages load the new list', async () => {
    const told = producer.expect('decks:changed', () => true, 4000);
    const read = await call('POST', '/api/decks/popular/refresh');
    assert.equal(read.status, 200);
    assert.deepEqual([read.json.builtIn, read.json.count], [false, 5]);
    await told;
    assert.match(page, /^\/decks\?show=100$/);

    const open = await call('GET', '/api/decks/popular');
    assert.deepEqual(open.json.decks.map((deck) => deck.name), ['Dragapult ex', "N's Zoroark ex", 'Basic Box', 'Mega Lopunny ex', 'Tera Box & Friends Memory']);
    const script = await call('GET', '/js/deck-popular.js');
    assert.match(script.text, /Tera Box & Friends Memory/);
    assert.match(script.text, /icons: \["ogerpon","clefairy"\]/);
  });

  it('keeps the list when the page cannot be read, and says so', async () => {
    status = 503;
    const failed = await call('POST', '/api/decks/popular/refresh');
    assert.equal(failed.status, 502);
    assert.match(failed.json.error, /answered 503/);
    status = 200;
    assert.equal((await call('GET', '/api/decks/popular')).json.count, 5);
  });

  it('goes back to the snapshot when a producer says so', async () => {
    const told = producer.expect('decks:changed', () => true, 4000);
    const back = await call('DELETE', '/api/decks/popular');
    assert.equal(back.json.builtIn, true);
    await told;
    assert.match((await call('GET', '/js/deck-popular.js')).text, /Dragapult ex/);
  });

  it('keeps a deck\'s sprite on this computer the first time it is asked for, and serves only plain names', async () => {
    images.requests.length = 0;
    const first = await fetch(`${server.base}/img/deckicon/ogerpon.png`);
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type'), /image\/png/);
    assert.equal(images.requests.length, 1);
    assert.equal((await fetch(`${server.base}/img/deckicon/ogerpon.png`)).status, 200);
    assert.equal(images.requests.length, 1, 'the second time it is kept');
    for (const bad of ['Ogerpon.png', '..%2Fx.png', 'a b.png', 'ogerpon.gif', `${'a'.repeat(41)}.png`]) {
      assert.equal((await fetch(`${server.base}/img/deckicon/${bad}`)).status, 404, bad);
    }
  });
});
