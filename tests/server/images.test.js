const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ImageCache, localImageUrl, pictureOf } = require('../../src/services/images');
const { startMockImageHost, respond, ROOT } = require('../support/harness');

describe('card pictures kept on this computer', () => {
  let host;
  let dir;
  let cache;

  before(async () => {
    host = await startMockImageHost((url) => {
      if (url.includes('/missing/')) return respond(404, 'no such picture', { 'Content-Type': 'text/plain' });
      if (url.includes('/page/')) return respond(200, '<html>not a picture</html>', { 'Content-Type': 'text/html' });
      if (url.includes('/huge/')) return respond(200, Buffer.alloc(7 * 1024 * 1024), { 'Content-Type': 'image/png' });
      return null;
    });
  });
  after(() => host.close());

  beforeEach(() => {
    host.requests.length = 0;
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'images-'));
    cache = new ImageCache({ dir, base: host.url });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('saves a picture the first time it is needed and serves it from disk after that', async () => {
    const file = await cache.ensure('sv1', '1.png');
    assert.equal(file, path.join(dir, 'sv1', '1.png'));
    assert.deepEqual(fs.readFileSync(file), host.png);
    assert.equal(host.requests.length, 1);

    assert.equal(await cache.ensure('sv1', '1.png'), file);
    assert.equal(host.requests.length, 1, 'no second request');
    assert.equal(cache.has('sv1', '1.png'), true);
    assert.equal(cache.has('sv1', '2.png'), false);
  });

  it('asks the picture host once when several people want the same picture at once', async () => {
    const files = await Promise.all(Array.from({ length: 6 }, () => cache.ensure('sv1', '2.png')));
    assert.equal(new Set(files).size, 1);
    assert.equal(host.requests.length, 1);
  });

  it('only accepts plain names, so nothing outside the picture folder or the picture host can be reached', async () => {
    const bad = [
      ['..', '1.png'], ['sv1', '../1.png'], ['sv1/../..', '1.png'], ['a b', '1.png'], ['', '1.png'], ['sv1', ''],
      ['sv1', 'x.exe'], ['sv1', '1.png.tmp'], ['sv1', 'a/b.png'], ['sv1', '..\\..\\x.png'], ['x'.repeat(41), '1.png'], ['sv1', `${'x'.repeat(81)}.png`]
    ];
    for (const [set, name] of bad) {
      assert.equal(ImageCache.isValid(set, name), false, `${set} / ${name}`);
      assert.equal(await cache.ensure(set, name), null);
    }
    assert.equal(host.requests.length, 0, 'nothing was requested');
    assert.equal(ImageCache.isValid('swsh12pt5', 'TG01_hires.png'), true);
    assert.equal(ImageCache.isValid('base-1', '58.jpg'), true);
  });

  it('keeps nothing that is not a picture, or is missing, or is too big', async () => {
    assert.equal(await cache.ensure('missing', '1.png'), null);
    assert.equal(await cache.ensure('page', '1.png'), null);
    assert.equal(await cache.ensure('huge', '1.png'), null);
    assert.equal(cache.stats().count, 0);
    assert.deepEqual(fs.readdirSync(dir), [], 'not even a half-written file or an empty folder');
    // and a later good answer is not blocked by the earlier failure
    assert.ok(await cache.ensure('sv1', '3.png'));
  });

  it('survives the picture host being unreachable', async () => {
    const lost = new ImageCache({ dir, base: 'http://127.0.0.1:9', timeoutMs: 500 });
    assert.equal(await lost.ensure('sv1', '1.png'), null);
  });

  it('counts the pictures saved and can delete them all', async () => {
    await cache.ensure('sv1', '1.png');
    await cache.ensure('sv1', '1_hires.png');
    await cache.ensure('sv2', '5.png');
    assert.deepEqual(cache.stats(), { count: 3, bytes: host.png.length * 3 });
    cache.clear();
    assert.deepEqual(cache.stats(), { count: 0, bytes: 0 });
    assert.equal(cache.has('sv1', '1.png'), false);
  });

  it('saves many pictures a few at a time, counting the ones that failed', async () => {
    const items = [
      { set: 'sv1', file: '1.png' }, { set: 'sv1', file: '2.png' }, { set: 'missing', file: '3.png' },
      { set: 'sv1', file: '4.png' }, { set: 'sv1', file: '5.png' }, { set: 'sv1', file: '6.png' }
    ];
    const seen = [];
    const result = await cache.prefetch(items, { concurrency: 3, onProgress: (progress) => seen.push(progress) });
    assert.deepEqual(result, { done: 6, failed: 1, total: 6, stopped: false });
    assert.equal(seen.length, 6);
    assert.deepEqual(seen[seen.length - 1], { done: 6, failed: 1, total: 6 });
    assert.equal(cache.stats().count, 5);
  });

  it('can be told to stop part way', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ set: 'sv1', file: `${i + 1}.png` }));
    let stop = false;
    const result = await cache.prefetch(items, { concurrency: 2, shouldStop: () => stop, onProgress: ({ done }) => { if (done >= 4) stop = true; } });
    assert.equal(result.stopped, true);
    assert.ok(result.done >= 4 && result.done < 20, `stopped at ${result.done}`);
  });

  it('turns picture addresses from the card image host into addresses on this app', () => {
    const base = 'https://images.pokemontcg.io';
    assert.equal(localImageUrl(`${base}/sv1/1.png`, base), '/img/sv1/1.png');
    assert.equal(localImageUrl(`${base}/swsh12pt5/TG01_hires.png`, base), '/img/swsh12pt5/TG01_hires.png');
    // anything else is left alone
    assert.equal(localImageUrl('https://elsewhere.test/sv1/1.png', base), 'https://elsewhere.test/sv1/1.png');
    assert.equal(localImageUrl(`${base}/a/b/c.png`, base), `${base}/a/b/c.png`, 'nested paths are not ours');
    assert.equal(localImageUrl(`${base}/sv1/1.exe`, base), `${base}/sv1/1.exe`);
    assert.equal(localImageUrl('/art/test.svg', base), '/art/test.svg');
    assert.equal(localImageUrl(undefined, base), undefined);
    assert.equal(localImageUrl('', base), '');
  });
});

// The newest sets have their pictures on Scrydex, at <host>/pokemon/<card id>/<size>
describe('card pictures from Scrydex', () => {
  const SCRYDEX = 'https://images.scrydex.com';
  let host;
  let scrydex;
  let dir;
  let cache;

  before(async () => {
    host = await startMockImageHost();
    scrydex = await startMockImageHost((url) => (url.includes('/pokemon/gone-1/') ? respond(404, 'no such picture', { 'Content-Type': 'text/plain' }) : null));
  });
  after(async () => { await host.close(); await scrydex.close(); });

  beforeEach(() => {
    host.requests.length = 0;
    scrydex.requests.length = 0;
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'scrydex-'));
    cache = new ImageCache({ dir, base: host.url, scrydexBase: scrydex.url });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('recognises their picture addresses and turns them into addresses on this app', () => {
    assert.deepEqual(pictureOf(`${SCRYDEX}/pokemon/me2pt5-1/small`), { set: 'scrydex', file: 'me2pt5-1_small.png' });
    assert.deepEqual(pictureOf(`${SCRYDEX}/pokemon/swsh12pt5gg-GG01/large`), { set: 'scrydex', file: 'swsh12pt5gg-GG01_large.png' });
    assert.equal(localImageUrl(`${SCRYDEX}/pokemon/me5-117/small`), '/img/scrydex/me5-117_small.png');
    assert.equal(localImageUrl(`${SCRYDEX}/pokemon/me5-117/large`), '/img/scrydex/me5-117_large.png');
    // the old host keeps working next to it
    assert.deepEqual(pictureOf('https://images.pokemontcg.io/sv9/1.png'), { set: 'sv9', file: '1.png' });
  });

  it('leaves alone anything that is not exactly one of their card pictures', () => {
    for (const url of [
      `${SCRYDEX}/pokemon/me2pt5-1/huge`, `${SCRYDEX}/pokemon/me2pt5-1`, `${SCRYDEX}/pokemon/me2pt5-1/small/extra`, `${SCRYDEX}/pokemon/me2pt5-1/small?x=1`,
      `${SCRYDEX}/pokemon/../small`, `${SCRYDEX}/pokemon/a.b/small`, `${SCRYDEX}/pokemon/a_b/small`, `${SCRYDEX}/pokemon/${'x'.repeat(61)}/small`,
      `${SCRYDEX}/other/me2pt5-1/small`, `${SCRYDEX}.evil.test/pokemon/me2pt5-1/small`, 'http://images.scrydex.com/pokemon/me2pt5-1/small',
      'https://elsewhere.test/pokemon/me2pt5-1/small'
    ]) {
      assert.equal(pictureOf(url), null, url);
      assert.equal(localImageUrl(url), url, url);
    }
  });

  it('saves a picture from their host the first time it is needed, and serves it from disk after that', async () => {
    const file = await cache.ensure('scrydex', 'me2pt5-1_small.png');
    assert.equal(file, path.join(dir, 'scrydex', 'me2pt5-1_small.png'));
    assert.deepEqual(fs.readFileSync(file), scrydex.png);
    assert.deepEqual(scrydex.requests, ['/pokemon/me2pt5-1/small']);
    assert.equal(host.requests.length, 0, 'the other image host is not asked');

    assert.equal(await cache.ensure('scrydex', 'me2pt5-1_small.png'), file);
    assert.equal(scrydex.requests.length, 1, 'no second request');
    assert.ok(await cache.ensure('scrydex', 'me2pt5-1_large.png'));
    assert.deepEqual(scrydex.requests, ['/pokemon/me2pt5-1/small', '/pokemon/me2pt5-1/large']);
    assert.equal(cache.stats().count, 2);
  });

  it('asks nothing of anyone for a name that is not one of their pictures', async () => {
    for (const name of ['evil.png', 'me2pt5-1.png', 'me2pt5-1_huge.png', 'me2pt5-1_small.jpg', '_small.png', 'a.b_small.png', 'a_b_small.png', `${'x'.repeat(61)}_small.png`]) {
      assert.equal(await cache.ensure('scrydex', name), null, name);
    }
    assert.equal(scrydex.requests.length + host.requests.length, 0, 'nothing was requested');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('keeps nothing when their host does not have the picture', async () => {
    assert.equal(await cache.ensure('scrydex', 'gone-1_small.png'), null);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('saves their pictures in the same go as the others', async () => {
    const result = await cache.prefetch([{ set: 'sv1', file: '1.png' }, { set: 'scrydex', file: 'me3-5_small.png' }, { set: 'scrydex', file: 'gone-1_small.png' }]);
    assert.deepEqual(result, { done: 3, failed: 1, total: 3, stopped: false });
    assert.equal(host.requests.length, 1);
    assert.equal(scrydex.requests.length, 2);
  });
});

describe('the pictures of Pokémon kept on this computer (next to a deck on the overlay)', () => {
  let host;
  let dir;
  let cache;

  before(async () => {
    host = await startMockImageHost((url) => (url === '/404.png' ? respond(404, 'no such picture', { 'Content-Type': 'text/plain' }) : null));
  });
  after(() => host.close());

  beforeEach(() => {
    host.requests.length = 0;
    fs.mkdirSync(path.join(ROOT, '.local', 'test'), { recursive: true });
    dir = fs.mkdtempSync(path.join(ROOT, '.local', 'test', 'sprites-'));
    cache = new ImageCache({ dir, base: 'http://127.0.0.1:9', spriteBase: host.url });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('saves the picture of a Pokémon, by its Pokédex number, the first time it is needed, and serves it from disk after that', async () => {
    const file = await cache.ensure('sprite', '6.png');
    assert.equal(file, path.join(dir, 'sprite', '6.png'));
    assert.deepEqual(fs.readFileSync(file), host.png);
    assert.deepEqual(host.requests, ['/6.png'], 'the picture of that number, from the sprites host');

    assert.equal(await cache.ensure('sprite', '6.png'), file);
    assert.equal(host.requests.length, 1, 'no second request');
    assert.equal(cache.has('sprite', '6.png'), true);
    assert.ok(await cache.ensure('sprite', '1025.png'), 'the last one there is');
    assert.equal(cache.stats().count, 2);
  });

  it('asks nothing of anyone for a number that is not a Pokémon, or a name that is not a number', async () => {
    for (const name of ['0.png', '1026.png', '9999.png', '06.png', '-1.png', '1.5.png', 'x.png', '6.jpg', '6.webp', '6', '.png', '6.png.png', '12345.png', '../6.png']) {
      assert.equal(ImageCache.isValid('sprite', name), false, name);
      assert.equal(await cache.ensure('sprite', name), null, name);
    }
    assert.equal(ImageCache.isValid('sprite', '25.png'), true);
    assert.equal(cache.sourceOf('sprite', '25.png'), `${host.url}/25.png`);
    assert.equal(cache.sourceOf('sprite', '2500.png'), null);
    assert.equal(host.requests.length, 0, 'nothing was requested');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('keeps nothing when the host does not have the picture, and the other kinds of picture are as they were', async () => {
    assert.equal(await cache.ensure('sprite', '404.png'), null, 'a Pokémon whose picture the host does not have');
    const gone = new ImageCache({ dir, base: 'http://127.0.0.1:9', spriteBase: 'http://127.0.0.1:9', timeoutMs: 500 });
    assert.equal(await gone.ensure('sprite', '25.png'), null, 'a host that cannot be reached');
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(ImageCache.isValid('sv1', '25.png'), true);
    assert.equal(ImageCache.isValid('sv1', '2500.png'), true, 'a card picture can have any number');
    assert.equal(ImageCache.isValid('tcgdex', '25.png'), false);
  });

  it('has a host of its own, which can be changed with OTO_SPRITE_BASE, and is the PokeAPI sprites repository without it', () => {
    const { SPRITE_BASE } = require('../../src/services/images');
    assert.match(SPRITE_BASE, /^https?:\/\//);
    assert.ok(SPRITE_BASE === 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork' || process.env.OTO_SPRITE_BASE, SPRITE_BASE);
  });
});
