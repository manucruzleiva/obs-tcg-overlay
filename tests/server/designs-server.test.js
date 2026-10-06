/**
 * Designs, their sounds and .oto packages through the real server: what the control panel and the
 * overlay do with them.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, wait } = require('../support/harness');
const S = require('../support/samples');
const { readZip, createZip } = require('../../src/services/zip');

describe('designs and packages through the server', () => {
  let server;
  let producer;
  let overlay;

  const call = async (method, route, body, headers = {}, base = server.base) => {
    const isJson = body !== undefined && !Buffer.isBuffer(body);
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': isJson ? 'application/json' : 'application/octet-stream', ...headers },
      body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buffer.toString('utf8')); } catch { /* not JSON */ }
    return { status: response.status, json, buffer, headers: response.headers };
  };

  const quiet = async (client, event, ms = 250) => {
    const before = (client.events[event] || []).length;
    await wait(ms);
    return (client.events[event] || []).length === before;
  };

  before(async () => {
    server = await startServer({ label: 'designs' });
    producer = server.client({ clientId: 'design-producer', name: 'Maya' });
    overlay = server.client({ clientId: 'design-overlay', role: 'overlay' });
    await Promise.all([producer.ready(), overlay.ready()]);
  });
  after(() => server.stop());

  describe('making a design', () => {
    it('starts with the built-in look', async () => {
      assert.deepEqual((await call('GET', '/api/theme')).json, { name: null, theme: null });
      assert.deepEqual((await call('GET', '/api/themes')).json, { active: null, names: [] });
    });

    it('makes a design and reads it back', async () => {
      const saved = await call('PUT', '/api/themes/Store%20League', { colors: { '--accent': '#ff4d6d' }, author: 'Mina', description: 'Neon' });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.name, 'Store League');
      assert.equal(saved.json.author, 'Mina');
      assert.deepEqual((await call('GET', '/api/themes/Store%20League')).json.colors, { '--accent': '#ff4d6d' });
      assert.deepEqual((await call('GET', '/api/themes')).json.names, ['Store League']);
      assert.equal((await call('GET', '/api/themes/Nobody')).status, 404);
    });

    it('explains what is wrong with a design it cannot keep', async () => {
      const bad = await call('PUT', '/api/themes/Store%20League', { colors: { '--accent': 'red; background: url(x)' } });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /Invalid value for --accent/);
      assert.equal((await call('PUT', '/api/themes/!!!', {})).status, 400);
      assert.equal((await call('PUT', '/api/themes/Store%20League', 'text')).status, 400);
    });
  });

  describe('pictures, font and sounds', () => {
    it('takes a picture as the file itself', async () => {
      const saved = await call('PUT', '/api/themes/Store%20League/images/logoImage', S.PNG);
      assert.equal(saved.status, 200);
      assert.equal(saved.json.images.logoImage, 'images/logoImage.png');
      assert.deepEqual((await call('PUT', '/api/themes/Store%20League/images/backgroundImage', S.JPG)).json.images.backgroundImage, 'images/backgroundImage.jpg');
    });

    it('says why a file cannot be used, and keeps what was there', async () => {
      const html = await call('PUT', '/api/themes/Store%20League/images/logoImage', S.HTML);
      assert.equal(html.status, 400);
      assert.match(html.json.error, /not a supported picture/);
      assert.match((await call('PUT', '/api/themes/Store%20League/images/nonsense', S.PNG)).json.error, /no such picture slot/);
      assert.equal((await call('PUT', '/api/themes/Nobody/images/logoImage', S.PNG)).status, 404);
      assert.match((await call('PUT', '/api/themes/Store%20League/font', S.PNG)).json.error, /not a supported font/);
      assert.match((await call('PUT', '/api/themes/Store%20League/sounds/damage', S.PNG)).json.error, /not a supported audio file/);
      assert.match((await call('PUT', '/api/themes/Store%20League/sounds/applause', S.MP3)).json.error, /no such sound/);
      assert.equal((await call('PUT', '/api/themes/Store%20League/images/logoImage', Buffer.alloc(0))).status, 400);
      const tooBig = await call('PUT', '/api/themes/Store%20League/images/logoImage', S.bigPng(6.5 * 1024 * 1024));
      assert.equal(tooBig.status, 413);
      assert.equal((await call('GET', '/api/themes/Store%20League')).json.images.logoImage, 'images/logoImage.png');
    });

    it('takes a font and sounds', async () => {
      assert.equal((await call('PUT', '/api/themes/Store%20League/font', S.WOFF2)).json.font, 'fonts/font.woff2');
      assert.equal((await call('PUT', '/api/themes/Store%20League/sounds/damage', S.MP3)).json.sounds.damage, 'sounds/damage.mp3');
      const both = await call('PUT', '/api/themes/Store%20League/sounds/ko', S.OGG);
      assert.deepEqual(Object.keys(both.json.sounds), ['damage', 'ko']);
    });

    it('shows a design\'s files to the control panel for previews, and no other file', async () => {
      const picture = await call('GET', '/api/themes/Store%20League/assets/images/logoImage.png');
      assert.equal(picture.status, 200);
      assert.equal(picture.headers.get('content-type'), 'image/png');
      assert.deepEqual(picture.buffer, S.PNG);
      assert.match(picture.headers.get('content-security-policy'), /sandbox/);
      assert.equal(picture.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual((await call('GET', '/api/themes/Store%20League/assets/sounds/damage.mp3')).buffer, S.MP3);

      for (const route of [
        '/api/themes/Store%20League/assets/design.json', '/api/themes/Store%20League/assets/images/design.json',
        '/api/themes/Store%20League/assets/images/..%2Fdesign.json', '/api/themes/Store%20League/assets/images/logoImage.jpg',
        '/api/themes/Nobody/assets/images/logoImage.png', '/api/themes/Store%20League/assets/%2e%2e/%2e%2e/package.json'
      ]) {
        assert.equal((await call('GET', route)).status, 404, route);
      }
    });

    it('removes a picture, the font and a sound', async () => {
      await call('PUT', '/api/themes/Scratch', {});
      await call('PUT', '/api/themes/Scratch/images/logoImage', S.PNG);
      await call('PUT', '/api/themes/Scratch/font', S.TTF);
      await call('PUT', '/api/themes/Scratch/sounds/heal', S.WAV);
      assert.deepEqual((await call('DELETE', '/api/themes/Scratch/images/logoImage')).json.images, {});
      assert.equal((await call('DELETE', '/api/themes/Scratch/font')).json.font, undefined);
      assert.deepEqual((await call('DELETE', '/api/themes/Scratch/sounds/heal')).json.sounds, {});
      assert.equal((await call('DELETE', '/api/themes/Scratch/images/nonsense')).status, 400);
      assert.equal((await call('DELETE', '/api/themes/Scratch')).status, 200);
      assert.equal((await call('DELETE', '/api/themes/Scratch')).status, 404);
    });
  });

  describe('the design on air', () => {
    it('puts a design on the overlay and tells the screens to reload the look and the sounds', async () => {
      const look = overlay.expect('theme:changed');
      const sounds = overlay.expect('sounds:changed');
      const answer = await call('POST', '/api/theme/active', { name: 'Store League' });
      assert.deepEqual(answer.json, { active: 'Store League' });
      await Promise.all([look, sounds]);

      const theme = (await call('GET', '/api/theme')).json;
      assert.equal(theme.name, 'Store League');
      assert.deepEqual(theme.theme.colors, { '--accent': '#ff4d6d' });
      assert.match(theme.theme.images.logoImage, /^\/api\/theme\/assets\/images\/logoImage\.png\?v=\d+$/);
      assert.match(theme.theme.font, /^\/api\/theme\/assets\/fonts\/font\.woff2\?v=\d+$/);
      assert.deepEqual(theme.theme.sounds, ['damage', 'ko']);
    });

    it('serves the pictures and font of the design on air to the overlay, without signing in, and nothing else', async () => {
      const theme = (await call('GET', '/api/theme')).json.theme;
      const logo = await call('GET', theme.images.logoImage);
      assert.equal(logo.status, 200);
      assert.deepEqual(logo.buffer, S.PNG);
      assert.deepEqual((await call('GET', theme.font)).buffer, S.WOFF2);

      for (const route of ['/api/theme/assets/sounds/damage.mp3', '/api/theme/assets/design.json', '/api/theme/assets/images/..%2Fdesign.json', '/api/theme/assets/images/logoImage.jpg', '/api/theme/assets/fonts/font.ttf']) {
        assert.equal((await call('GET', route)).status, 404, route);
      }
    });

    it('updates the overlay at once when the design on air is edited, but not for another design', async () => {
      const edited = overlay.expect('theme:changed');
      await call('PUT', '/api/themes/Store%20League', { colors: { '--accent': '#00ff88' } });
      await edited;

      await call('PUT', '/api/themes/Arena', { colors: { '--accent': '#111111' } });
      assert.equal(await quiet(overlay, 'theme:changed'), true, 'a design that is not on air changes nothing on the overlay');
      const picture = overlay.expect('theme:changed');
      await call('PUT', '/api/themes/Store%20League/images/trainerAAvatar', S.PNG);
      await picture;
    });

    it('goes back to the built-in look when asked, and when the design on air is deleted', async () => {
      const back = overlay.expect('theme:changed');
      await call('POST', '/api/theme/active', { name: null });
      await back;
      assert.deepEqual((await call('GET', '/api/theme')).json, { name: null, theme: null });
      assert.equal((await call('GET', '/api/theme/assets/images/logoImage.png')).status, 404, 'nothing is served while the built-in look is on');
      assert.equal((await call('POST', '/api/theme/active', { name: 'Nobody' })).status, 404);

      await call('POST', '/api/theme/active', { name: 'Arena' });
      const gone = overlay.expect('theme:changed');
      await call('DELETE', '/api/themes/Arena');
      await gone;
      assert.equal((await call('GET', '/api/themes')).json.active, null);
    });
  });

  describe('sounds: the producer\'s own, the design\'s, and the built-in ones', () => {
    it('plays the design\'s sounds while it is on air, and none when it is not', async () => {
      assert.deepEqual((await call('GET', '/api/sounds')).json.custom, {});
      await call('POST', '/api/theme/active', { name: 'Store League' });

      const list = (await call('GET', '/api/sounds')).json.custom;
      assert.deepEqual(Object.keys(list), ['damage', 'ko']);
      assert.equal(list.damage.source, 'design');
      assert.equal(list.damage.mime, 'audio/mpeg');
      assert.equal(list.damage.size, S.MP3.length);
      const played = await call('GET', '/api/sounds/damage');
      assert.equal(played.status, 200);
      assert.equal(played.headers.get('content-type'), 'audio/mpeg');
      assert.deepEqual(played.buffer, S.MP3);
      assert.equal((await call('GET', '/api/sounds/heal')).status, 404);

      await call('POST', '/api/theme/active', { name: null });
      assert.deepEqual((await call('GET', '/api/sounds')).json.custom, {});
      assert.equal((await call('GET', '/api/sounds/damage')).status, 404);
      await call('POST', '/api/theme/active', { name: 'Store League' });
    });

    it('lets the producer\'s own upload win, and falls back to the design\'s when it is removed', async () => {
      const changed = overlay.expect('sounds:changed');
      assert.equal((await call('PUT', '/api/sounds/damage', S.WAV)).status, 200);
      await changed;
      const list = (await call('GET', '/api/sounds')).json.custom;
      assert.equal(list.damage.source, 'custom');
      assert.equal(list.ko.source, 'design');
      assert.deepEqual((await call('GET', '/api/sounds/damage')).buffer, S.WAV);

      await call('DELETE', '/api/sounds/damage');
      assert.equal((await call('GET', '/api/sounds')).json.custom.damage.source, 'design');
      assert.deepEqual((await call('GET', '/api/sounds/damage')).buffer, S.MP3);
    });

    it('does not let an odd cue name reach anything', async () => {
      for (const cue of ['__proto__', 'constructor', '..%2Fdesign', 'nonsense']) assert.equal((await call('GET', `/api/sounds/${cue}`)).status, 404, cue);
    });
  });

  describe('packages', () => {
    let exported;

    it('exports a design with its sounds and the control settings as one file', async () => {
      await producer.act('action:settings', { action: 'update', toastSeconds: 7, display: { nationality: false }, apiKey: 'sk-secret' });
      const file = await call('GET', '/api/packages/export?design=Store%20League&controls=1');
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-type'), 'application/octet-stream');
      assert.equal(file.headers.get('content-disposition'), 'attachment; filename="store-league.oto"');
      exported = file.buffer;

      const entries = readZip(exported);
      assert.deepEqual([...entries.keys()].sort(), [
        'controls.json', 'design.json', 'fonts/font.woff2', 'images/backgroundImage.jpg', 'images/logoImage.png', 'images/trainerAAvatar.png',
        'manifest.json', 'sounds/damage.mp3', 'sounds/ko.ogg'
      ]);
      const controls = JSON.parse(entries.get('controls.json')).settings;
      assert.equal(controls.toastSeconds, 7);
      assert.equal(controls.display.nationality, false);
      // checked file by file, since the text inside a package is compressed
      for (const [name, data] of entries) assert.ok(!data.toString('latin1').includes('sk-secret'), `the card API key must not be in ${name}`);
      assert.ok(exported.length < 20000, `${exported.length} bytes`);
    });

    it('only exports what exists and what was asked for', async () => {
      assert.equal((await call('GET', '/api/packages/export')).status, 400);
      assert.match((await call('GET', '/api/packages/export')).json.error, /Choose what to put in the package/);
      assert.equal((await call('GET', '/api/packages/export?design=Nobody')).status, 404);
      const settingsOnly = await call('GET', '/api/packages/export?controls=1');
      assert.equal(settingsOnly.headers.get('content-disposition'), 'attachment; filename="my-oto-setup.oto"');
      assert.deepEqual([...readZip(settingsOnly.buffer).keys()], ['manifest.json', 'controls.json']);

      await call('PUT', '/api/sounds/heal', S.WAV);
      const mine = readZip((await call('GET', '/api/packages/export?design=Store%20League&mySounds=1')).buffer);
      assert.ok(mine.has('sounds/heal.wav'), 'the producer\'s own sounds go in on request');
      assert.equal(readZip((await call('GET', '/api/packages/export?design=Store%20League')).buffer).has('sounds/heal.wav'), false);
      await call('DELETE', '/api/sounds/heal');
    });

    it('looks inside a package without changing anything', async () => {
      const before = (await call('GET', '/api/themes')).json;
      const info = await call('POST', '/api/packages/inspect', exported);
      assert.equal(info.status, 200);
      assert.equal(info.json.name, 'Store League');
      assert.equal(info.json.author, 'Mina');
      assert.deepEqual(info.json.design.images.sort(), ['backgroundImage', 'logoImage', 'trainerAAvatar']);
      assert.equal(info.json.design.font, true);
      assert.deepEqual(info.json.design.sounds, ['damage', 'ko']);
      assert.equal(info.json.design.exists, true);
      assert.deepEqual(info.json.controls.hidden, ['Nationality']);
      assert.equal(info.json.controls.toastSeconds, 7);
      assert.deepEqual((await call('GET', '/api/themes')).json, before);
    });

    it('installs it: a new design on the overlay, and settings the producers can undo', async () => {
      await producer.act('action:settings', { action: 'update', toastSeconds: 4, display: { nationality: true } });
      const reloaded = overlay.expect('theme:changed');
      const activity = producer.expect('activity', (entry) => /Settings from/.test(entry.label));

      const installed = await call('POST', '/api/packages/install', exported, { 'X-OTO-Client': 'design-producer', 'X-OTO-Name': encodeURIComponent('Maya Ñ') });
      assert.equal(installed.status, 200);
      assert.deepEqual(installed.json, { design: { name: 'Store League 2', replaced: false }, activated: true, controlsApplied: true });
      await reloaded;

      assert.equal((await call('GET', '/api/themes')).json.active, 'Store League 2');
      assert.deepEqual(Object.keys((await call('GET', '/api/themes/Store%20League%202')).json.sounds), ['damage', 'ko']);
      assert.deepEqual((await call('GET', '/api/sounds')).json.custom.damage.source, 'design');
      const state = (await call('GET', '/api/state')).json;
      assert.equal(state.settings.toastSeconds, 7);
      assert.equal(state.settings.display.nationality, false);
      assert.equal(state.settings.apiKeySet, true, 'the producer\'s own key was not touched');

      const entry = await activity;
      assert.equal(entry.label, 'Settings from "Store League"');
      assert.equal(entry.by.name, 'Maya Ñ');

      // one step of undo takes the settings back
      const undone = await producer.act('action:undo');
      assert.equal(undone.ok, true);
      const after = (await call('GET', '/api/state')).json;
      assert.equal(after.settings.toastSeconds, 4);
      assert.equal(after.settings.display.nationality, true);
    });

    it('can install only the settings, or only the design, or replace a design', async () => {
      const settingsOnly = await call('POST', '/api/packages/install?design=0', exported);
      assert.deepEqual(settingsOnly.json, { design: null, activated: false, controlsApplied: true });
      assert.equal((await call('GET', '/api/themes')).json.names.length, 2);

      await call('POST', '/api/theme/active', { name: null });
      const designOnly = await call('POST', '/api/packages/install?controls=0&activate=0', exported);
      assert.deepEqual(designOnly.json, { design: { name: 'Store League 3', replaced: false }, activated: false, controlsApplied: false });
      assert.equal((await call('GET', '/api/themes')).json.active, null);

      const replaced = await call('POST', '/api/packages/install?controls=0&replace=1', exported);
      assert.deepEqual(replaced.json.design, { name: 'Store League', replaced: true });
      assert.equal((await call('GET', '/api/themes')).json.active, 'Store League');
    });

    it('refuses files that are not packages, in plain words', async () => {
      const nothing = await call('POST', '/api/packages/install', Buffer.alloc(0));
      assert.equal(nothing.status, 400);
      assert.match(nothing.json.error, /No file was sent/);
      const text = await call('POST', '/api/packages/inspect', Buffer.from('this is not a package, it is only some words'));
      assert.equal(text.status, 400);
      assert.match(text.json.error, /not a package file/);
      const empty = await call('POST', '/api/packages/install', createZip([{ name: 'readme.txt', data: Buffer.from('hello') }]));
      assert.match(empty.json.error, /no design and no control settings/);
      const newer = await call('POST', '/api/packages/install', createZip([{ name: 'manifest.json', data: Buffer.from('{"format":"oto","version":99}') }, { name: 'design.json', data: Buffer.from('{"name":"x"}') }]));
      assert.match(newer.json.error, /newer version of OTO/);
    });

    it('refuses a package with something unsafe inside, and installs none of it', async () => {
      const before = (await call('GET', '/api/themes')).json.names;
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//evil.example")</script></svg>';
      const bad = createZip([
        { name: 'design.json', data: Buffer.from('{"name":"Evil"}') }, { name: 'images/logoImage.png', data: S.PNG }, { name: 'images/backgroundImage.svg', data: Buffer.from(svg) },
        { name: 'controls.json', data: Buffer.from('{"settings":{"toastSeconds":30}}') }
      ]);
      const answer = await call('POST', '/api/packages/install', bad);
      assert.equal(answer.status, 400);
      assert.match(answer.json.error, /scripts or links/);
      assert.deepEqual((await call('GET', '/api/themes')).json.names, before);
      assert.notEqual((await call('GET', '/api/state')).json.settings.toastSeconds, 30);

      const traversal = await call('POST', '/api/packages/install', createZip([{ name: 'design.json', data: Buffer.from('{"name":"x"}') }, { name: '../../evil.png', data: S.PNG }]));
      assert.equal(traversal.status, 400);
      assert.match(traversal.json.error, /unsafe name/);
    });

    it('refuses a package that is far too large', async () => {
      const big = await call('POST', '/api/packages/install', Buffer.alloc(49 * 1024 * 1024 + 4096, 1));
      assert.equal(big.status, 413);
    });
  });

  describe('designs from an earlier version', () => {
    it('accepts a design in the old format (one JSON with the pictures inside)', async () => {
      const legacy = { name: 'Old League', colors: { '--accent': '#ff0000' }, images: { logoImage: `data:image/png;base64,${S.PNG.toString('base64')}`, backgroundImage: 'https://example.com/b.jpg' } };
      const imported = await call('POST', '/api/themes', legacy);
      assert.equal(imported.status, 201);
      assert.equal(imported.json.name, 'Old League');
      assert.deepEqual(Object.keys(imported.json.images), ['logoImage']);
      assert.deepEqual((await call('GET', '/api/themes/Old%20League/assets/images/logoImage.png')).buffer, S.PNG);
      assert.equal((await call('POST', '/api/themes', { colors: {} })).status, 400);
    });

    it('turns designs saved by an earlier version into folders when the server starts', async () => {
      const old = await startServer({
        label: 'designs-legacy',
        prepare: (dir) => {
          fs.mkdirSync(path.join(dir, 'themes'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'themes', 'store-night.json'), JSON.stringify({
            name: 'Store Night', colors: { '--accent': '#8844ff' }, images: { logoImage: `data:image/png;base64,${S.PNG.toString('base64')}` }, font: `data:font/woff2;base64,${S.WOFF2.toString('base64')}`
          }));
        }
      });
      try {
        const list = (await call('GET', '/api/themes', undefined, {}, old.base)).json;
        assert.deepEqual(list.names, ['Store Night']);
        const design = (await call('GET', '/api/themes/Store%20Night', undefined, {}, old.base)).json;
        assert.deepEqual(design.colors, { '--accent': '#8844ff' });
        assert.equal(design.images.logoImage, 'images/logoImage.png');
        assert.equal(design.font, 'fonts/font.woff2');
        assert.ok(fs.existsSync(path.join(old.dir, 'themes', 'store-night.json.old')), 'the old file is kept as a backup');
      } finally {
        await old.stop();
      }
    });
  });

  describe('who may do what', () => {
    it('keeps designs, sounds and packages behind the password, and leaves the overlay\'s own files open', async () => {
      const locked = await startServer({ label: 'designs-locked', env: { OTO_PASSWORD: 'let-me-in' } });
      try {
        const get = (route, init) => fetch(`${locked.base}${route}`, init);
        for (const [method, route] of [
          ['GET', '/api/themes'], ['PUT', '/api/themes/x'], ['POST', '/api/themes'], ['DELETE', '/api/themes/x'], ['POST', '/api/theme/active'],
          ['PUT', '/api/themes/x/images/logoImage'], ['PUT', '/api/themes/x/font'], ['PUT', '/api/themes/x/sounds/damage'], ['GET', '/api/themes/x/assets/images/logoImage.png'],
          ['GET', '/api/packages/export?controls=1'], ['POST', '/api/packages/inspect'], ['POST', '/api/packages/install'], ['PUT', '/api/sounds/damage']
        ]) {
          assert.equal((await get(route, { method })).status, 401, `${method} ${route}`);
        }
        assert.equal((await get('/api/theme')).status, 200);
        assert.equal((await get('/api/sounds')).status, 200);
        assert.equal((await get('/api/theme/assets/images/logoImage.png')).status, 404, 'open, but there is nothing on air');
      } finally {
        await locked.stop();
      }
    });

    it('refuses a package install that comes from another website', async () => {
      const answer = await call('POST', '/api/packages/install', exportedDummy(), { Origin: 'https://evil.example' });
      assert.equal(answer.status, 403);
    });
  });
});

function exportedDummy() {
  return createZip([{ name: 'controls.json', data: Buffer.from('{"settings":{"toastSeconds":9}}') }]);
}
