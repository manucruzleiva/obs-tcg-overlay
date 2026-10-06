/**
 * The optional control panel password: the logic on its own, then through the real server.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { Auth, COOKIE_NAME, MAX_PASSWORD_LENGTH } = require('../../src/services/auth');
const { startServer } = require('../support/harness');

// In-memory stand-in for the settings table
function fakeDb() {
  const store = new Map();
  return {
    store,
    getSetting: (key, fallback = null) => (store.has(key) ? JSON.parse(store.get(key)) : fallback),
    setSetting: (key, value) => store.set(key, JSON.stringify(value))
  };
}

describe('Auth', () => {
  it('is off until a password is set', () => {
    const auth = new Auth(fakeDb(), {});
    assert.equal(auth.isEnabled(), false);
    assert.equal(auth.source(), null);
    assert.equal(auth.isAuthorized(undefined), true);
  });

  it('accepts any text as a password, with no complexity rules', () => {
    for (const password of ['a', '1234', 'hunter2', 'pässwörd 🔑', '   ', 'x'.repeat(MAX_PASSWORD_LENGTH)]) {
      const auth = new Auth(fakeDb(), {});
      auth.setPassword(password);
      assert.equal(auth.isEnabled(), true, JSON.stringify(password));
      assert.equal(auth.verifyPassword(password), true, JSON.stringify(password));
      assert.equal(auth.verifyPassword(`${password}!`), false);
    }
  });

  it('rejects wrong guesses, odd input and over-long passwords', () => {
    const auth = new Auth(fakeDb(), {});
    auth.setPassword('secret');
    assert.equal(auth.verifyPassword('Secret'), false);
    assert.equal(auth.verifyPassword(''), false);
    assert.equal(auth.verifyPassword(undefined), false);
    assert.equal(auth.verifyPassword({ toString: () => 'secret' }), false);
    assert.equal(auth.verifyPassword('s'.repeat(MAX_PASSWORD_LENGTH + 1)), false);
    assert.throws(() => auth.setPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)), /at most/);
    assert.throws(() => auth.setPassword(42), /text/);
  });

  it('stores only a salted hash, never the password', () => {
    const db = fakeDb();
    new Auth(db, {}).setPassword('correct horse');
    const saved = db.store.get('auth');
    assert.doesNotMatch(saved, /correct horse/);
    const { salt, hash, epoch } = JSON.parse(saved);
    assert.ok(salt && hash && epoch);

    // the same password gets a different hash each time
    const other = fakeDb();
    new Auth(other, {}).setPassword('correct horse');
    assert.notEqual(JSON.parse(other.store.get('auth')).hash, hash);
  });

  it('forgets a forgotten password when started with OTO_RESET_PASSWORD=1, and not otherwise', () => {
    const db = fakeDb();
    new Auth(db, {}).setPassword('secret');
    const token = new Auth(db, {}).issueToken();

    for (const env of [{}, { OTO_RESET_PASSWORD: '0' }, { OTO_RESET_PASSWORD: 'yes' }, { OTO_RESET_PASSWORD: '' }]) {
      const auth = new Auth(db, env);
      assert.equal(auth.resetIfRequested(), false, JSON.stringify(env));
      assert.equal(auth.isEnabled(), true);
    }

    const auth = new Auth(db, { OTO_RESET_PASSWORD: '1' });
    assert.equal(auth.resetIfRequested(), true);
    assert.equal(auth.isEnabled(), false);
    assert.equal(auth.verifyPassword('secret'), false);
    assert.equal(auth.isAuthorized(`${COOKIE_NAME}=${token}`), true, 'with no password everything is open');
    assert.equal(auth.resetIfRequested(), false, 'nothing left to remove');

    // a password chosen afterwards is a new one: the old sessions are not valid for it
    auth.setPassword('another');
    assert.equal(new Auth(db, {}).isAuthorized(`${COOKIE_NAME}=${token}`), false);
  });

  it('removes the password when set to an empty string', () => {
    const auth = new Auth(fakeDb(), {});
    auth.setPassword('secret');
    auth.setPassword('');
    assert.equal(auth.isEnabled(), false);
    assert.equal(auth.isAuthorized(undefined), true);
  });

  it('issues session tokens that can be checked, and spots forged or expired ones', () => {
    const auth = new Auth(fakeDb(), {});
    auth.setPassword('secret');
    const token = auth.issueToken();
    assert.equal(auth.verifyToken(token), true);

    const [expires, nonce, signature] = token.split('.');
    assert.equal(auth.verifyToken(`${Number(expires) + 1}.${nonce}.${signature}`), false, 'changed expiry');
    assert.equal(auth.verifyToken(`${expires}.${nonce}.${signature.slice(1)}x`), false, 'changed signature');
    assert.equal(auth.verifyToken('nonsense'), false);
    assert.equal(auth.verifyToken(undefined), false);

    const past = `${Date.now() - 1000}.abc`;
    assert.equal(auth.verifyToken(`${past}.${auth.sign(past)}`), false, 'expired but correctly signed');
  });

  it('signs everyone out when the password changes or is removed', () => {
    const db = fakeDb();
    const auth = new Auth(db, {});
    auth.setPassword('one');
    const token = auth.issueToken();
    assert.equal(auth.isAuthorized(`${COOKIE_NAME}=${token}`), true);

    auth.setPassword('two');
    assert.equal(auth.isAuthorized(`${COOKIE_NAME}=${token}`), false);

    auth.setPassword('');
    assert.equal(auth.isAuthorized(undefined), true, 'no password: everyone is in');
    auth.setPassword('three');
    assert.equal(auth.isAuthorized(`${COOKIE_NAME}=${token}`), false, 'the old token does not come back');
  });

  it('reads the session out of a Cookie header', () => {
    const auth = new Auth(fakeDb(), {});
    auth.setPassword('secret');
    const token = auth.issueToken();
    assert.equal(auth.isAuthorized(`theme=dark; ${COOKIE_NAME}=${token}; other=1`), true);
    assert.equal(auth.isAuthorized('theme=dark'), false);
    assert.match(auth.sessionCookie(token), /HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+/);
    assert.match(auth.clearedCookie(), /Max-Age=0/);
  });

  it('lets the OTO_PASSWORD environment variable take over', () => {
    const db = fakeDb();
    const auth = new Auth(db, { OTO_PASSWORD: 'from-env' });
    assert.equal(auth.isEnabled(), true);
    assert.equal(auth.source(), 'environment');
    assert.equal(auth.verifyPassword('from-env'), true);
    assert.equal(auth.verifyPassword('nope'), false);
    assert.throws(() => auth.setPassword('other'), /OTO_PASSWORD/);

    // sessions belong to that password
    const token = auth.issueToken();
    assert.equal(auth.verifyToken(token), true);
    assert.equal(new Auth(db, { OTO_PASSWORD: 'different' }).verifyToken(token), false);
  });

  it('slows down guessing: five wrong tries lock that address for a while', () => {
    const auth = new Auth(fakeDb(), {});
    auth.setPassword('secret');
    for (let i = 0; i < 4; i++) auth.recordFailure('1.2.3.4');
    assert.equal(auth.lockedFor('1.2.3.4'), 0);
    auth.recordFailure('1.2.3.4');
    assert.ok(auth.lockedFor('1.2.3.4') > 0);
    assert.equal(auth.lockedFor('9.9.9.9'), 0, 'other addresses are not affected');

    auth.failures.get('1.2.3.4').lockedUntil = Date.now() - 1;
    assert.equal(auth.lockedFor('1.2.3.4'), 0, 'the lock expires');

    auth.recordFailure('5.5.5.5');
    auth.recordSuccess('5.5.5.5');
    assert.equal(auth.failures.has('5.5.5.5'), false, 'signing in clears the count');
  });
});

// A request with full control over its headers (fetch will not let a script send an Origin)
function request(base, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cookieFrom = (res) => (res.headers['set-cookie'] || [])[0]?.split(';')[0];

describe('control panel password (through the server)', () => {
  let server;
  const html = { accept: 'text/html' };

  before(async () => {
    server = await startServer({ label: 'auth', env: { OTO_PASSWORD: 'secret' } });
  });

  after(() => server.stop());

  const login = (password) => request(server.base, { method: 'POST', path: '/api/login', body: { password } });

  it('sends visitors to the sign-in page and keeps the API closed', async () => {
    const page = await request(server.base, { path: '/control', headers: html });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/login?next=%2Fcontrol');

    const files = await request(server.base, { path: '/control/index.html', headers: html });
    assert.equal(files.status, 302, 'the page file is behind the password too');

    const api = await request(server.base, { path: '/api/state' });
    assert.equal(api.status, 401);
    assert.deepEqual(api.json(), { error: 'Password required' });

    const apiWithBrowserHeaders = await request(server.base, { path: '/api/state', headers: html });
    assert.equal(apiWithBrowserHeaders.status, 401, 'programs calling the API get a 401, not a login page');
  });

  it('leaves the overlay, the sign-in page and the health check open', async () => {
    for (const path of ['/overlay', '/login', '/api/health', '/api/theme', '/js/overlay.js', '/css/overlay.css', '/socket.io/socket.io.js']) {
      const res = await request(server.base, { path, headers: html });
      assert.equal(res.status, 200, path);
    }
    const status = await request(server.base, { path: '/api/auth/status' });
    assert.deepEqual(status.json(), { required: true, authenticated: false, source: 'environment' });
  });

  it('signs in with the right password and out again', async () => {
    const wrong = await login('nope');
    assert.equal(wrong.status, 401);
    assert.equal(cookieFrom(wrong), undefined);

    const right = await login('secret');
    assert.equal(right.status, 200);
    const cookie = cookieFrom(right);
    assert.match(cookie, new RegExp(`^${COOKIE_NAME}=`));
    assert.match(right.headers['set-cookie'][0], /HttpOnly/);

    const page = await request(server.base, { path: '/control', headers: { ...html, cookie } });
    assert.equal(page.status, 200);
    assert.equal((await request(server.base, { path: '/api/state', headers: { cookie } })).status, 200);
    assert.equal((await request(server.base, { path: '/login', headers: { ...html, cookie } })).status, 302, 'already signed in');
    assert.equal((await request(server.base, { path: '/api/auth/status', headers: { cookie } })).json().authenticated, true);

    const out = await request(server.base, { method: 'POST', path: '/api/logout', headers: { cookie } });
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  });

  it('lets only signed-in control panels change the game', async () => {
    const cookie = cookieFrom(await login('secret'));

    const guest = server.client({ clientId: 'guest-client-01' });
    const member = server.client({ clientId: 'member-client-1', cookie });
    await Promise.all([guest.ready(), member.ready()]);

    const refused = await guest.act('action:trainerA', { action: 'prizeMinus' });
    assert.equal(refused.ok, false);
    assert.equal(refused.rejected.reason, 'read-only');

    // the guest still sees the match, like an overlay does
    const seen = guest.expect('state:update', (s) => s.trainerA.prizes.count === 5);
    const allowed = await member.act('action:trainerA', { action: 'prizeMinus' });
    assert.equal(allowed.ok, true);
    await seen;
  });

  it('refuses the password change while an environment variable controls it', async () => {
    const cookie = cookieFrom(await login('secret'));
    const res = await request(server.base, { method: 'POST', path: '/api/auth/password', headers: { cookie }, body: { password: 'new' } });
    assert.equal(res.status, 409);
    assert.match(res.json().error, /OTO_PASSWORD/);
  });

  it('locks out an address after too many wrong passwords', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await login(`wrong-${i}`);
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers['retry-after']) > 0);
    // even the right password has to wait
    assert.equal((await login('secret')).status, 429);
  });
});

describe('setting the password from the control panel', () => {
  let server;
  before(async () => {
    server = await startServer({ label: 'auth-set' });
  });
  after(() => server.stop());

  const setPassword = (password, cookie) =>
    request(server.base, { method: 'POST', path: '/api/auth/password', headers: cookie ? { cookie } : {}, body: { password } });

  it('opens everything while there is no password', async () => {
    assert.equal((await request(server.base, { path: '/api/state' })).status, 200);
    assert.deepEqual((await request(server.base, { path: '/api/auth/status' })).json(), { required: false, authenticated: true, source: null });
  });

  it('sets, changes and removes a password, signing the person who did it back in', async () => {
    const first = await setPassword('one');
    assert.equal(first.status, 200);
    const cookieOne = cookieFrom(first);
    assert.ok(cookieOne, 'the person setting it stays signed in');

    assert.equal((await request(server.base, { path: '/api/state' })).status, 401);
    assert.equal((await request(server.base, { path: '/api/state', headers: { cookie: cookieOne } })).status, 200);

    // changing it signs out every other session
    const second = await setPassword('two', cookieOne);
    const cookieTwo = cookieFrom(second);
    assert.equal((await request(server.base, { path: '/api/state', headers: { cookie: cookieOne } })).status, 401);
    assert.equal((await request(server.base, { path: '/api/state', headers: { cookie: cookieTwo } })).status, 200);
    assert.equal((await request(server.base, { method: 'POST', path: '/api/login', body: { password: 'one' } })).status, 401);
    assert.equal((await request(server.base, { method: 'POST', path: '/api/login', body: { password: 'two' } })).status, 200);

    // only someone signed in can change or remove it
    assert.equal((await setPassword('hijack')).status, 401);
    const removed = await setPassword('', cookieTwo);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json(), { required: false });
    assert.equal((await request(server.base, { path: '/api/state' })).status, 200);
  });

  it('survives a restart of the password check (the hash is stored, not the session)', async () => {
    const cookie = cookieFrom(await setPassword('keep me'));
    assert.equal((await request(server.base, { path: '/api/state', headers: { cookie } })).status, 200);
    await setPassword('', cookie);
  });
});

describe('other websites cannot drive the app', () => {
  let server;
  before(async () => {
    server = await startServer({ label: 'origin' });
  });
  after(() => server.stop());

  const evil = { origin: 'http://evil.example' };

  it('refuses state-changing requests that name another origin', async () => {
    const res = await request(server.base, { method: 'POST', path: '/api/settings', headers: evil, body: { overlayOpacity: 10 } });
    assert.equal(res.status, 403);

    const same = await request(server.base, { method: 'POST', path: '/api/settings', headers: { origin: server.base }, body: { overlayOpacity: 10 } });
    assert.equal(same.status, 200);

    const noOrigin = await request(server.base, { method: 'POST', path: '/api/settings', body: { overlayOpacity: 20 } });
    assert.equal(noOrigin.status, 200, 'scripts and other tools send no Origin');
  });

  it('refuses a socket connection from another origin', async () => {
    const poll = (headers) => request(server.base, { path: '/socket.io/?EIO=4&transport=polling', headers });
    assert.equal((await poll(evil)).status, 403);
    assert.equal((await poll({ origin: server.base })).status, 200);
    assert.equal((await poll({})).status, 200);
  });
});
