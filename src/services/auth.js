/**
 * Optional password for the control panel.
 *
 * The password is a plain string with no complexity rules. It is stored hashed (scrypt) in the
 * local database, or can be supplied through the OTO_PASSWORD environment variable, which wins.
 *
 * Signing in sets a signed cookie. The cookie is bound to the current password, so changing or
 * removing the password signs everyone out. The overlay never needs a password: it only receives
 * the game state and cannot send actions.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'oto_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PASSWORD_LENGTH = 128;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 30 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

// Compare two strings without leaking how many leading characters matched
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

class Auth {
  constructor(db, env = process.env) {
    this.db = db;
    this.env = env;
    this.failures = new Map(); // ip -> { count, lockedUntil }
  }

  // ---- state

  envPassword() {
    return this.env.OTO_PASSWORD ? String(this.env.OTO_PASSWORD) : '';
  }

  stored() {
    return this.db.getSetting('auth', null);
  }

  isEnabled() {
    return Boolean(this.envPassword() || this.stored());
  }

  // Where the password comes from: 'environment', 'stored' or null (no password)
  source() {
    if (this.envPassword()) return 'environment';
    return this.stored() ? 'stored' : null;
  }

  // ---- password

  verifyPassword(candidate) {
    if (typeof candidate !== 'string' || candidate.length > MAX_PASSWORD_LENGTH) return false;

    const fromEnv = this.envPassword();
    if (fromEnv) return safeEqual(fromEnv, candidate);

    const stored = this.stored();
    if (!stored) return false;
    const hash = crypto.scryptSync(candidate, Buffer.from(stored.salt, 'base64'), 32);
    return crypto.timingSafeEqual(hash, Buffer.from(stored.hash, 'base64'));
  }

  // Forgot the password? Start OTO once with OTO_RESET_PASSWORD=1 and it is removed. Anyone who can start
  // the program on this computer can read its files anyway, so this gives nothing away. Returns whether it did.
  resetIfRequested() {
    if (this.env.OTO_RESET_PASSWORD !== '1' || !this.stored()) return false;
    this.db.setSetting('auth', null);
    return true;
  }

  // An empty password removes it. Not allowed while the environment variable controls it.
  setPassword(password) {
    if (this.envPassword()) throw new Error('The password is set by the OTO_PASSWORD environment variable');
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`The password must be text of at most ${MAX_PASSWORD_LENGTH} characters`);
    }

    if (password === '') {
      this.db.setSetting('auth', null);
      return;
    }
    const salt = crypto.randomBytes(16);
    this.db.setSetting('auth', {
      salt: salt.toString('base64'),
      hash: crypto.scryptSync(password, salt, 32).toString('base64'),
      // Part of every session token: a new password invalidates all existing sessions
      epoch: crypto.randomBytes(8).toString('hex')
    });
  }

  // ---- sessions

  secret() {
    let secret = this.db.getSetting('authSecret', null);
    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64');
      this.db.setSetting('authSecret', secret);
    }
    return secret;
  }

  // Identifies the current password inside session tokens
  credentialId() {
    const fromEnv = this.envPassword();
    if (fromEnv) return sha256(fromEnv).toString('hex');
    const stored = this.stored();
    return stored ? stored.epoch : '';
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.secret()).update(`${payload}.${this.credentialId()}`).digest('base64url');
  }

  issueToken() {
    const payload = `${Date.now() + SESSION_MS}.${crypto.randomBytes(8).toString('hex')}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token) {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [expires, nonce, signature] = parts;
    if (!(Number(expires) > Date.now())) return false;
    return safeEqual(this.sign(`${expires}.${nonce}`), signature);
  }

  // ---- cookies and requests

  tokenFromCookies(header) {
    if (!header) return null;
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE_NAME) return rest.join('=');
    }
    return null;
  }

  sessionCookie(token) {
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
  }

  clearedCookie() {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  // Whether a request (given its Cookie header) may use the control panel
  isAuthorized(cookieHeader) {
    if (!this.isEnabled()) return true;
    return this.verifyToken(this.tokenFromCookies(cookieHeader));
  }

  // ---- brute-force protection

  // Seconds until this address may try again (0 when it may try now)
  lockedFor(ip) {
    const entry = this.failures.get(ip);
    if (!entry || entry.lockedUntil <= Date.now()) return 0;
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  }

  recordFailure(ip) {
    const entry = this.failures.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
      entry.count = 0;
    }
    this.failures.set(ip, entry);
  }

  recordSuccess(ip) {
    this.failures.delete(ip);
  }
}

module.exports = { Auth, COOKIE_NAME, MAX_PASSWORD_LENGTH };
