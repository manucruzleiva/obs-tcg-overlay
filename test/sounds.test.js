/**
 * Sound effects: which actions make which sound, the settings, and uploading your own sounds.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const SOUND = require('../public/js/sound-options');
const GameStateService = require('../src/services/gamestate');
const actions = require('../src/actions');
const { SoundStore, SoundError, sniff, MAX_SOUND_BYTES } = require('../src/services/sounds');
const { startServer, wait } = require('../test-support/harness');

// A tiny, valid WAV file
function wav(seconds = 0.05) {
  const rate = 8000;
  const data = Buffer.alloc(Math.floor(rate * seconds) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]);

describe('the sound catalogue', () => {
  it('lists every cue once, in groups, and starts silent', () => {
    assert.equal(new Set(SOUND.KEYS).size, SOUND.KEYS.length);
    for (const key of ['damage', 'heal', 'deploy', 'attack', 'topdeck', 'ko', 'win', 'turn']) {
      assert.ok(SOUND.KEYS.includes(key), key);
    }
    assert.equal(SOUND.DEFAULTS.enabled, false, 'no surprise noises on a live stream');
    assert.deepEqual(Object.keys(SOUND.DEFAULTS.events), SOUND.KEYS);
  });
});

describe('sound settings', () => {
  let gs;
  beforeEach(() => {
    gs = new GameStateService({ loadGameState: () => null, saveGameState() {} }, {});
  });

  it('merges changes, clamping volumes and ignoring anything unknown', () => {
    gs.updateSettings({
      sound: {
        enabled: true,
        volume: 250,
        events: { damage: { enabled: false, volume: -20 }, heal: { volume: 40.6 }, bogus: { enabled: false }, ko: 'loud' }
      }
    });
    const { sound } = gs.state.settings;
    assert.equal(sound.enabled, true);
    assert.equal(sound.volume, 100);
    assert.deepEqual(sound.events.damage, { enabled: false, volume: 0 });
    assert.deepEqual(sound.events.heal, { enabled: true, volume: 41 });
    assert.equal('bogus' in sound.events, false);
    assert.deepEqual(sound.events.ko, { enabled: true, volume: 100 }, 'a malformed entry changes nothing');

    gs.updateSettings({ sound: { volume: 'loud', enabled: 'yes' } });
    assert.equal(sound.volume, 100);
    assert.equal(sound.enabled, true);
  });

  it('keeps earlier choices when only one cue changes', () => {
    gs.updateSettings({ sound: { events: { damage: { volume: 10 } } } });
    gs.updateSettings({ sound: { events: { heal: { enabled: false } } } });
    assert.equal(gs.state.settings.sound.events.damage.volume, 10);
    assert.equal(gs.state.settings.sound.events.heal.enabled, false);
  });

  it('does not share its defaults between games', () => {
    gs.updateSettings({ sound: { events: { damage: { volume: 5 } } } });
    assert.equal(SOUND.DEFAULTS.events.damage.volume, 100);
    const other = new GameStateService({ loadGameState: () => null, saveGameState() {} }, {});
    assert.equal(other.state.settings.sound.events.damage.volume, 100);
  });
});

describe('which sound each action makes', () => {
  const cues = (event, payload) => {
    const spec = actions.resolve(event, payload);
    assert.ok(spec, JSON.stringify(payload));
    return spec.cues();
  };

  it('maps game actions to cues', () => {
    assert.deepEqual(cues('action:trainerA', { action: 'activeDamage', amount: 30 }), ['damage']);
    assert.deepEqual(cues('action:trainerA', { action: 'activeDamage', amount: -30 }), ['heal']);
    assert.deepEqual(cues('action:trainerB', { action: 'benchDamage', slot: 1, amount: 10 }), ['damage']);
    assert.deepEqual(cues('action:trainerB', { action: 'benchDamage', slot: 1, amount: -10 }), ['heal']);
    assert.deepEqual(cues('action:trainerA', { action: 'activeHeal' }), ['heal']);
    assert.deepEqual(cues('action:trainerA', { action: 'setActive', cardId: 'x', name: 'x' }), ['deploy']);
    assert.deepEqual(cues('action:trainerA', { action: 'swapWithActive', slot: 0 }), ['deploy']);
    assert.deepEqual(cues('action:trainerA', { action: 'setBench', slot: 0, cardId: 'x', name: 'x' }), ['bench']);
    assert.deepEqual(cues('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'fire' }), ['energy']);
    assert.deepEqual(cues('action:trainerA', { action: 'attachSpecialEnergy', slot: -1, cardId: 'e', name: 'E' }), ['energy']);
    assert.deepEqual(cues('action:trainerA', { action: 'removeSpecialEnergy', slot: -1, index: 0 }), []);
    assert.deepEqual(cues('action:trainerA', { action: 'prizeMinus' }), ['prize']);
    assert.deepEqual(cues('action:trainerA', { action: 'knockOut', slot: -1 }), ['ko']);
    assert.deepEqual(cues('action:match', { action: 'toggleTurn' }), ['turn']);
    assert.deepEqual(cues('action:match', { action: 'trainerAMatchWinPlus' }), ['point']);
  });

  it('makes a sound for an ability only when it becomes used', () => {
    assert.deepEqual(cues('action:trainerA', { action: 'setAbilityUsed', slot: -1, index: 0, used: true }), ['ability']);
    assert.deepEqual(cues('action:trainerA', { action: 'setAbilityUsed', slot: -1, index: 0, used: false }), []);
  });

  it('makes a sound when the supporter is used, and none when it is given back', () => {
    assert.deepEqual(cues('action:trainerA', { action: 'supporterPlus' }), ['supporter']);
    assert.deepEqual(cues('action:trainerB', { action: 'supporterPlus' }), ['supporter']);
    assert.deepEqual(cues('action:trainerA', { action: 'supporterMinus' }), []);
    assert.deepEqual(cues('action:trainerA', { action: 'supporterReset' }), []);
    assert.ok(SOUND.KEYS.includes('supporter'), 'it can be switched on and off and given its own sound like any other');
  });

  it('picks the cue from the card target', () => {
    assert.deepEqual(cues('action:card', { action: 'select', target: 'trainerA-active' }), ['deploy']);
    assert.deepEqual(cues('action:card', { action: 'select', target: 'trainerB-bench-2' }), ['bench']);
    assert.deepEqual(cues('action:card', { action: 'select', target: 'stadium' }), ['stadium']);
    assert.deepEqual(cues('action:card', { action: 'setStadium', cardId: 's1', name: 'Arena' }), ['stadium']);
    assert.deepEqual(cues('action:card', { action: 'setStadium', cardId: '', name: '' }), [], 'clearing the stadium is silent');
  });

  it('gives every hype announcement its own sound', () => {
    assert.deepEqual(cues('action:toast', { action: 'topDeck' }), ['topdeck']);
    assert.deepEqual(cues('action:toast', { action: 'attack' }), ['attack']);
    assert.deepEqual(cues('action:toast', { action: 'startGame' }), ['startgame']);
    assert.deepEqual(cues('action:toast', { action: 'trainerAWin' }), ['win']);
    assert.deepEqual(cues('action:toast', { action: 'trainerBWin' }), ['win']);
    assert.deepEqual(cues('action:toast', { action: 'passTurn' }), ['turn']);
    assert.deepEqual(cues('action:toast', { action: 'trainerAKO' }), ['ko']);
  });

  it('is silent for changes that are not events', () => {
    assert.deepEqual(cues('action:trainerA', { action: 'setName', name: 'x' }), []);
    assert.deepEqual(cues('action:settings', { action: 'update' }), []);
    assert.deepEqual(cues('action:trainerA', { action: 'energyPlus' }), []);
  });

  it('only uses cues that exist', () => {
    const everything = [
      ['action:trainerA', { action: 'activeDamage', amount: 1 }], ['action:trainerA', { action: 'activeHeal' }],
      ['action:toast', { action: 'topDeck' }], ['action:toast', { action: 'passTurn' }], ['action:toast', { action: 'trainerAWin' }],
      ['action:match', { action: 'toggleTurn' }], ['action:card', { action: 'select', target: 'stadium' }]
    ];
    for (const [event, payload] of everything) {
      for (const cue of cues(event, payload)) assert.ok(SOUND.KEYS.includes(cue), cue);
    }
  });
});

describe('SoundStore', () => {
  const dir = path.join(__dirname, '..', '.local', 'test', 'sounds-unit');
  let store;
  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    store = new SoundStore(dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('recognises audio by what is in the file, not by what it claims to be', () => {
    assert.equal(sniff(wav()).mime, 'audio/wav');
    assert.equal(sniff(OGG).mime, 'audio/ogg');
    assert.equal(sniff(MP3).mime, 'audio/mpeg');
    assert.equal(sniff(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(20)])).mime, 'audio/mpeg');
    assert.equal(sniff(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(20)])).mime, 'audio/mp4');
    assert.equal(sniff(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)])).mime, 'audio/webm');
    assert.equal(sniff(Buffer.from('<html><script>alert(1)</script></html>')), null);
    assert.equal(sniff(Buffer.from('MZ' + 'x'.repeat(30))), null);
    assert.equal(sniff(Buffer.alloc(4)), null);
  });

  it('saves, lists, reads and removes a sound', () => {
    assert.deepEqual(store.list(), {});
    const saved = store.save('damage', wav());
    assert.equal(saved.mime, 'audio/wav');

    const list = store.list();
    assert.deepEqual(Object.keys(list), ['damage']);
    assert.equal(list.damage.mime, 'audio/wav');
    assert.ok(list.damage.version > 0);

    const read = store.read('damage');
    assert.equal(read.mime, 'audio/wav');
    assert.ok(read.buffer.equals(wav()));
    assert.equal(store.read('heal'), null);

    assert.equal(store.remove('damage'), true);
    assert.equal(store.remove('damage'), false);
    assert.deepEqual(store.list(), {});
  });

  it('keeps one file per cue, replacing it even when the type changes', () => {
    store.save('heal', wav());
    store.save('heal', OGG);
    assert.equal(store.list().heal.mime, 'audio/ogg');
    assert.deepEqual(fs.readdirSync(dir).filter((file) => file.startsWith('heal.')), ['heal.ogg']);
  });

  it('refuses unknown cues, non-audio, empty and oversized files', () => {
    assert.throws(() => store.save('made-up', wav()), SoundError);
    assert.throws(() => store.save('../etc/passwd', wav()), SoundError);
    assert.throws(() => store.save('damage', Buffer.from('not audio at all, just text')), /not a supported audio file/);
    assert.throws(() => store.save('damage', Buffer.alloc(0)), /No audio/);
    assert.throws(() => store.save('damage', 'a string'), SoundError);
    assert.throws(() => store.save('damage', Buffer.concat([wav(), Buffer.alloc(MAX_SOUND_BYTES)])), /too large/);
    assert.deepEqual(store.list(), {});
    assert.equal(store.read('../etc/passwd'), null);
  });
});

// A request with full control over its headers and body
function request(base, { method = 'GET', path: route, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString(), json: () => JSON.parse(buffer.toString()) });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('sound effects through the server', () => {
  let server;
  let producer;
  let overlay;

  before(async () => {
    server = await startServer({ label: 'sounds' });
    producer = server.client({ clientId: 'sound-producer-1' });
    overlay = server.client({ role: 'overlay', clientId: 'sound-overlay-01' });
    await Promise.all([producer.ready(), overlay.ready()]);
  });
  after(() => server.stop());

  beforeEach(async () => {
    await producer.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
    await wait(30);
  });

  // Run an action and collect the cues the overlay is told to play
  async function cuesFor(event, payload) {
    const before = (overlay.events.sfx || []).length;
    const result = await producer.act(event, payload);
    assert.equal(result.ok, true, JSON.stringify(result.rejected));
    await wait(60);
    return (overlay.events.sfx || []).slice(before).map((message) => message.cue);
  }

  it('tells the overlay which sound to play for each action', async () => {
    await producer.act('action:trainerA', { action: 'setActive', cardId: 'a', name: 'Pikachu', image: 'https://i.test/a.png', hp: 60 });
    await wait(80); // let the overlay receive the "deploy" sound before measuring the next ones
    assert.deepEqual(await cuesFor('action:trainerA', { action: 'activeDamage', amount: 20 }), ['damage']);
    assert.deepEqual(await cuesFor('action:trainerA', { action: 'activeDamage', amount: -10 }), ['heal']);
    assert.deepEqual(await cuesFor('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'fire' }), ['energy']);
    assert.deepEqual(await cuesFor('action:trainerB', { action: 'prizeMinus' }), ['prize']);
    assert.deepEqual(await cuesFor('action:match', { action: 'toggleTurn' }), ['turn']);
    assert.deepEqual(await cuesFor('action:trainerB', { action: 'setBench', slot: 0, cardId: 'b', name: 'Eevee', image: 'https://i.test/b.png', hp: 50 }), ['bench']);
    assert.deepEqual(await cuesFor('action:trainerA', { action: 'setName', name: 'quiet' }), []);
  });

  it('makes the hype sounds even when the banner and the animation are switched off', async () => {
    await producer.act('action:settings', { action: 'update', enableTopDeckToast: false, enableTopDeckAnimation: false });
    const announcements = (overlay.events.announce || []).length;
    assert.deepEqual(await cuesFor('action:toast', { action: 'topDeck', target: 'trainerA' }), ['topdeck']);
    assert.equal((overlay.events.announce || []).length, announcements, 'no banner or effect');
  });

  it('sends a sent draft\'s sounds once per kind', async () => {
    await producer.act('action:trainerA', { action: 'setActive', cardId: 'a', name: 'Pikachu', image: 'https://i.test/a.png', hp: 200 });
    await wait(80);
    const before = (overlay.events.sfx || []).length;

    producer.emit('draft:start');
    await producer.expect('draft:state', (d) => d.active);
    for (let i = 0; i < 3; i++) await producer.draftAct('action:trainerA', { action: 'activeDamage', amount: 10 });
    await producer.draftAct('action:trainerA', { action: 'attachEnergy', slot: -1, energyType: 'fire' });
    assert.equal((overlay.events.sfx || []).length, before, 'a draft is silent until it is sent');

    const sent = producer.expect('draft:sent');
    producer.emit('draft:send', {});
    await sent;
    await wait(80);
    assert.deepEqual((overlay.events.sfx || []).slice(before).map((m) => m.cue).sort(), ['damage', 'energy']);
  });

  it('lets a producer set the volume and switches, with sane limits', async () => {
    // overlay screens receive the settings too, since they decide whether to play
    const overlayHears = overlay.expect('state:update', (update) => update.settings.sound.events.damage.volume === 35);
    const { state } = await producer.act('action:settings', {
      action: 'update',
      sound: { enabled: true, volume: 400, events: { damage: { volume: 35, enabled: false } } }
    });
    assert.equal(state.settings.sound.enabled, true);
    assert.equal(state.settings.sound.volume, 100);
    assert.deepEqual(state.settings.sound.events.damage, { enabled: false, volume: 35 });
    assert.equal((await overlayHears).settings.sound.volume, 100);
  });

  it('uploads, serves, replaces and removes a custom sound', async () => {
    assert.deepEqual((await (await fetch(`${server.base}/api/sounds`)).json()).custom, {});

    const changed = overlay.expect('sounds:changed');
    const up = await request(server.base, { method: 'PUT', path: '/api/sounds/damage', headers: { 'content-type': 'audio/wav' }, body: wav() });
    assert.equal(up.status, 200);
    assert.equal(up.json().mime, 'audio/wav');
    await changed;

    const list = (await (await fetch(`${server.base}/api/sounds`)).json()).custom;
    assert.deepEqual(Object.keys(list), ['damage']);

    // the overlay can fetch it without signing in
    const file = await request(server.base, { path: '/api/sounds/damage' });
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'audio/wav');
    assert.ok(file.buffer.equals(wav()));
    assert.equal((await request(server.base, { path: '/api/sounds/heal' })).status, 404);

    // replacing it with another type leaves one file
    const replaced = await request(server.base, { method: 'PUT', path: '/api/sounds/damage', headers: { 'content-type': 'audio/ogg' }, body: OGG });
    assert.equal(replaced.json().mime, 'audio/ogg');
    assert.equal((await request(server.base, { path: '/api/sounds/damage' })).headers['content-type'], 'audio/ogg');
    assert.deepEqual(fs.readdirSync(path.join(server.dir, 'sounds')).filter((f) => f.startsWith('damage.')), ['damage.ogg']);

    const removed = overlay.expect('sounds:changed');
    assert.equal((await request(server.base, { method: 'DELETE', path: '/api/sounds/damage' })).status, 200);
    await removed;
    assert.equal((await request(server.base, { method: 'DELETE', path: '/api/sounds/damage' })).status, 404);
    assert.deepEqual((await (await fetch(`${server.base}/api/sounds`)).json()).custom, {});
  });

  it('refuses uploads that are not usable sounds', async () => {
    const put = (cue, body, type = 'audio/wav') => request(server.base, { method: 'PUT', path: `/api/sounds/${cue}`, headers: { 'content-type': type }, body });

    const unknown = await put('made-up', wav());
    assert.equal(unknown.status, 400);
    assert.match(unknown.json().error, /Unknown sound/);

    const text = await put('damage', Buffer.from('<html>definitely not audio</html>'), 'audio/wav');
    assert.equal(text.status, 400);
    assert.match(text.json().error, /not a supported audio file/);

    assert.equal((await put('damage', Buffer.alloc(0))).status, 400);

    const huge = await put('damage', Buffer.concat([wav(), Buffer.alloc(MAX_SOUND_BYTES + 4096)]));
    assert.equal(huge.status, 413, 'a file that is too big is the sender\'s mistake, not a server error');
    assert.match(huge.json().error, /too large/);

    assert.deepEqual((await (await fetch(`${server.base}/api/sounds`)).json()).custom, {});
  });

  it('reports malformed JSON as a bad request, not a server error', async () => {
    const res = await request(server.base, { method: 'POST', path: '/api/settings', headers: { 'content-type': 'application/json' }, body: '{ not json' });
    assert.equal(res.status, 400);
  });
});

describe('sound uploads and the password', () => {
  let server;
  before(async () => {
    server = await startServer({ label: 'sounds-auth', env: { OTO_PASSWORD: 'secret' } });
  });
  after(() => server.stop());

  it('lets anyone fetch sounds (the overlay needs them) but only signed-in producers change them', async () => {
    assert.equal((await request(server.base, { path: '/api/sounds' })).status, 200);

    const refused = await request(server.base, { method: 'PUT', path: '/api/sounds/damage', headers: { 'content-type': 'audio/wav' }, body: wav() });
    assert.equal(refused.status, 401);

    const login = await request(server.base, { method: 'POST', path: '/api/login', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const accepted = await request(server.base, { method: 'PUT', path: '/api/sounds/damage', headers: { 'content-type': 'audio/wav', cookie }, body: wav() });
    assert.equal(accepted.status, 200);

    assert.equal((await request(server.base, { path: '/api/sounds/damage' })).status, 200, 'still open to the overlay');
    assert.equal((await request(server.base, { method: 'DELETE', path: '/api/sounds/damage' })).status, 401);
  });
});
