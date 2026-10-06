/**
 * More overlays for one controller: the list of screens and what is kept of it, the design each wears (and its files), and who is told when that
 * design changes.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const DISPLAY = require('../../public/js/display-options');
const GameStateService = require('../../src/services/gamestate');
const { startServer, wait } = require('../support/harness');
const S = require('../support/samples');

const makeGame = (saved = null) => new GameStateService({
  loadGameState: () => saved, saveGameState() {}, saveMatch() {}, addFavorite() {}, removeFavorite() {}
}, { selectBestImageUrl: () => '' });

describe('the screens of the overlay (the list)', () => {
  it('is empty at first, at most three, and each screen has an id, a name, a design, its own switches and whether it plays sounds', () => {
    assert.deepEqual(makeGame().state.settings.screens, []);
    assert.equal(DISPLAY.SCREEN_LIMITS.max, 3);
    const kept = DISPLAY.cleanScreens([{ id: 'vertical', name: ' Vertical ', design: ' Phone ', display: { scoreboard: false, notAnOption: true, hpBars: 'no' }, sound: true }]);
    assert.deepEqual(kept, [{ id: 'vertical', name: 'Vertical', design: 'Phone', display: { scoreboard: false }, sound: true }]);
  });

  it('drops what cannot be kept: a bad or repeated id, something that is not a screen, more than three, and gives a name and a design the usual way', () => {
    const many = ['one', 'two', 'three', 'four'].map((id) => ({ id }));
    assert.deepEqual(DISPLAY.cleanScreens(many).map((screen) => screen.id), ['one', 'two', 'three']);
    assert.deepEqual(DISPLAY.cleanScreens([{ id: 'ok' }, { id: 'ok' }, { id: 'Bad Id' }, { id: '' }, { id: 7 }, { name: 'no id' }, null, 'text', []]).map((screen) => screen.id), ['ok']);
    assert.deepEqual(DISPLAY.cleanScreens([{ id: 'plain' }]), [{ id: 'plain', name: 'plain', design: null, display: {}, sound: false }]);
    assert.deepEqual(DISPLAY.cleanScreens([{ id: 'a', name: 'x'.repeat(40), design: '   ', sound: 'yes' }])[0], { id: 'a', name: 'x'.repeat(24), design: null, display: {}, sound: false });
    for (const nothing of [undefined, null, 'screens', 5, {}]) assert.deepEqual(DISPLAY.cleanScreens(nothing), []);
  });

  it('makes an id from a name, that nobody has', () => {
    assert.equal(DISPLAY.screenId('Vertical stream'), 'vertical-stream');
    assert.equal(DISPLAY.screenId('  Móvil!! '), 'movil');
    assert.equal(DISPLAY.screenId('Vertical', ['vertical']), 'vertical-2');
    assert.equal(DISPLAY.screenId('Vertical', ['vertical', 'vertical-2']), 'vertical-3');
    assert.equal(DISPLAY.screenId('!!!'), 'screen');
    assert.ok(DISPLAY.SCREEN_LIMITS.idPattern.test(DISPLAY.screenId('x'.repeat(80))));
  });

  it('is kept by the game, replaced as a whole by an update, cleaned when a save is read, and never shared in a package', () => {
    const gs = makeGame();
    gs.updateSettings({ screens: [{ id: 'vertical', name: 'Vertical', design: null, display: { scoreboard: false }, sound: false }, { id: 'bad id' }] });
    assert.deepEqual(gs.state.settings.screens.map((screen) => screen.id), ['vertical']);
    gs.updateSettings({ screens: 'nonsense' });
    assert.deepEqual(gs.state.settings.screens, [], 'a list that is not one is nothing');
    const saved = makeGame().state;
    saved.settings.screens = [{ id: 'kept', name: 'Kept' }, { id: '???' }];
    assert.deepEqual(makeGame(saved).state.settings.screens.map((screen) => screen.id), ['kept']);
    assert.equal(makeGame({ ...saved, settings: { ...saved.settings, screens: undefined } }).state.settings.screens.length, 0);
  });
});

describe('the design each overlay wears', () => {
  let server;
  let producer;
  let viewer;
  const api = async (method, route, body, raw) => {
    const response = await fetch(`${server.base}${route}`, { method, headers: raw ? {} : { 'Content-Type': 'application/json' }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
    const type = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, json: type.includes('json') ? JSON.parse(buffer.toString('utf8')) : null, buffer };
  };
  const screens = (list) => producer.act('action:settings', { action: 'update', screens: list });

  before(async () => {
    server = await startServer({ label: 'screens' });
    producer = server.client({ clientId: 'screens-producer-01', name: 'Maya' });
    viewer = server.client({ clientId: 'screens-viewer-0001', role: 'overlay' });
    await Promise.all([producer.ready(), viewer.ready()]);
    await api('PUT', '/api/themes/Wide', { colors: { '--accent': '#112233' } });
    await api('PUT', '/api/themes/Phone', { colors: { '--accent': '#445566' }, orientation: 'portrait' });
    await api('PUT', '/api/themes/Phone/images/logoImage', undefined, S.PNG);
    await api('PUT', '/api/themes/Other', { colors: {} });
    await api('PUT', '/api/themes/Other/images/logoImage', undefined, S.PNG);
    await api('POST', '/api/theme/active', { name: 'Wide' });
  });
  after(() => server.stop());
  beforeEach(async () => { await screens([]); });

  it('is the one on air for the main overlay, and for a screen that has none of its own or that is not one', async () => {
    await screens([{ id: 'plain', name: 'Plain', design: null, display: {}, sound: false }]);
    assert.equal((await api('GET', '/api/theme')).json.name, 'Wide');
    assert.equal((await api('GET', '/api/theme?screen=plain')).json.name, 'Wide');
    assert.equal((await api('GET', '/api/theme?screen=nothing')).json.name, 'Wide');
    assert.equal((await api('GET', '/api/theme?screen[]=x')).json.name, 'Wide', 'whatever else is asked');
  });

  it('is the design the screen says, with the files of that design asked for by its name', async () => {
    await screens([{ id: 'vertical', name: 'Vertical', design: 'Phone', display: {}, sound: false }]);
    const { json } = await api('GET', '/api/theme?screen=vertical');
    assert.equal(json.name, 'Phone');
    assert.equal(json.theme.orientation, 'portrait');
    assert.equal(json.theme.colors['--accent'], '#445566');
    assert.match(json.theme.images.logoImage, /^\/api\/theme\/assets\/images\/logoImage\.png\?v=\d+&design=Phone$/);
    // the main overlay is as it was (its addresses name no design)
    assert.match((await api('GET', '/api/theme')).json.theme.colors['--accent'], /#112233/);
    assert.doesNotMatch(JSON.stringify((await api('GET', '/api/theme')).json.theme.images), /design=/);

    const file = await api('GET', json.theme.images.logoImage);
    assert.equal(file.status, 200);
    assert.deepEqual(file.buffer, S.PNG);
  });

  it('is the one on air when the design of a screen does not exist any more', async () => {
    await screens([{ id: 'gone', name: 'Gone', design: 'Deleted', display: {}, sound: false }]);
    assert.equal((await api('GET', '/api/theme?screen=gone')).json.name, 'Wide');
  });

  it('is only served, file by file, for the designs that are in use: the one on air and the ones a screen wears', async () => {
    await api('POST', '/api/theme/active', { name: 'Wide' });
    // Other is not in use: its files are not handed out without signing in, and what is asked for the one on air gets its own
    assert.equal((await api('GET', '/api/theme/assets/images/logoImage.png?design=Other')).status, 404, 'the one on air (Wide) has no logo');
    await screens([{ id: 'other', name: 'Other', design: 'Other', display: {}, sound: false }]);
    assert.equal((await api('GET', '/api/theme/assets/images/logoImage.png?design=Other')).status, 200, 'a screen wears it now');
    assert.equal((await api('GET', '/api/theme/assets/images/logoImage.png?design=Phone')).status, 404, 'but Phone is not worn by anybody');
    assert.equal((await api('GET', '/api/theme/assets/images/logoImage.png?design=../Phone')).status, 404);
    assert.equal((await api('GET', '/api/theme/assets/images/logoImage.png?design[]=Other')).status, 404);
  });

  it('tells every overlay to look again when a design that a screen wears is saved, and not when nobody wears it', async () => {
    await screens([{ id: 'vertical', name: 'Vertical', design: 'Phone', display: {}, sound: false }]);
    const told = viewer.expect('theme:changed', () => true, 1500);
    await api('PUT', '/api/themes/Phone', { colors: { '--accent': '#778899' } });
    await told;
    assert.equal((await api('GET', '/api/theme?screen=vertical')).json.theme.colors['--accent'], '#778899');

    let heard = false;
    const stop = viewer.watch('theme:changed', () => true, () => { heard = true; });
    await api('PUT', '/api/themes/Other', { colors: { '--accent': '#000001' } });
    await wait(300);
    stop();
    assert.equal(heard, false, 'Other is worn by nobody');
  });

  it('is told about by the settings: the list of screens is in the game everybody sees, so every overlay can read its own', async () => {
    await screens([{ id: 'vertical', name: 'Vertical', design: 'Phone', display: { scoreboard: false }, sound: true }]);
    const state = await (await fetch(`${server.base}/api/state`)).json();
    assert.deepEqual(state.settings.screens, [{ id: 'vertical', name: 'Vertical', design: 'Phone', display: { scoreboard: false }, sound: true }]);
    assert.match(producer.events.activity.at(-1).label, /Settings changed/);
  });
});
