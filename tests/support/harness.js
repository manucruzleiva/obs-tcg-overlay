/**
 * Test harness: boots the real server with a throwaway database and gives tests socket clients
 * that remember what they were sent.
 *
 * Lives in tests/support, apart from the folders that hold the tests (tests/server, tests/ui, tests/desktop): Node's test runner runs every
 * file that matches the pattern of those folders, and this is not one.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..', '..');
const SCRATCH = path.join(ROOT, '.local', 'test');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A route function can answer with something other than 200: return respond(500, body, { 'Retry-After': '1' })
const respond = (status, body = {}, headers = {}) => ({ __response: true, status, body, headers });

// A stand-in for the card API. `routes` maps a path prefix to a JSON body or a function (url) => body.
// It records every request URL (`requests`) and its headers (`headers`).
async function startMockCardApi(routes = {}) {
  const requests = [];
  const headers = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    headers.push(req.headers);
    const match = Object.keys(routes).find((prefix) => req.url.startsWith(prefix));
    if (!match) {
      res.statusCode = 404;
      return res.end('{}');
    }
    // (a route may answer later: it returns a promise)
    const answer = await (typeof routes[match] === 'function' ? routes[match](req.url) : routes[match]);
    res.setHeader('Content-Type', 'application/json');
    if (answer && answer.__response) {
      res.statusCode = answer.status;
      for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
      return res.end(JSON.stringify(answer.body));
    }
    res.end(JSON.stringify(answer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    headers,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
}

// A stand-in for TCGdex. `cards` are cards in TCGdex's own words ({ id, localId, name, category, image, hp, types, stage,
// suffix, evolveFrom, rarity, set: { id, name }, trainerType, energyType, attacks, abilities, retreat... }). It answers
// the GraphQL search (English) and the list of sets (`sets`: { id, releaseDate }), the list and the details of a card for each
// language, and records what was asked. `behave(request)` may return respond(...) to answer differently (an error), or { hang: true }.
async function startMockTcgdex({ cards = [], sets = [], behave = () => null } = {}) {
  const requests = [];
  const bodies = [];
  const lower = (text) => String(text || '').toLowerCase();
  const matches = (card, filters = {}) => {
    if (filters.name && !lower(card.name).includes(lower(filters.name))) return false;
    if (filters.regulationMark && card.regulationMark !== filters.regulationMark) return false;
    if (filters.category && card.category !== filters.category) return false;
    if (filters.trainerType && card.trainerType !== filters.trainerType) return false;
    if (filters.energyType && card.energyType !== filters.energyType) return false;
    if (filters.stage && card.stage !== filters.stage) return false;
    if (filters.suffix && card.suffix !== filters.suffix) return false;
    if (filters.evolveFrom && card.evolveFrom !== filters.evolveFrom) return false;
    if (filters.rarity && card.rarity !== filters.rarity) return false;
    return true;
  };
  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      bodies.push(body);
      const special = behave({ method: req.method, url: req.url, body });
      if (special && special.hang) return; // never answers
      if (special && special.__response) return send(res, special.status, special.body);

      const url = new URL(req.url, 'http://mock');
      const parts = url.pathname.split('/').filter(Boolean); // v2, graphql | <lang>, cards, <id>
      if (req.method === 'POST' && parts[1] === 'graphql') {
        if (body && /\bsets\b/.test(String(body.query)) && !/\bcards\b/.test(String(body.query))) return send(res, 200, { data: { sets } });
        const { filters = {}, pagination = {} } = (body && body.variables) || {};
        const page = pagination.page || 1;
        const size = pagination.itemsPerPage || 20;
        const found = cards.filter((card) => matches(card, filters));
        return send(res, 200, { data: { cards: found.slice((page - 1) * size, page * size) } });
      }
      if (req.method === 'GET' && parts[2] === 'cards' && parts.length === 3) {
        const filters = Object.fromEntries([...url.searchParams.entries()]);
        const page = Number(filters['pagination:page'] || 1);
        const size = Number(filters['pagination:itemsPerPage'] || 20);
        const found = cards.filter((card) => matches(card, filters) && (!filters['set.id'] || card.set.id === filters['set.id']));
        return send(res, 200, found.slice((page - 1) * size, page * size).map((card) => ({ id: card.id, localId: card.localId, name: card.name, ...(card.image ? { image: card.image } : {}) })));
      }
      if (req.method === 'GET' && parts[2] === 'cards' && parts.length === 4) {
        const card = cards.find((item) => item.id === decodeURIComponent(parts[3]));
        return card ? send(res, 200, card) : send(res, 404, { error: 'not found' });
      }
      return send(res, 404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v2`,
    requests,
    bodies,
    cards,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
}

// A stand-in for Scrydex, made from its documentation: GET /pokemon/v1/cards (q, page, page_size, casing) and
// GET /pokemon/v1/cards/<id>, answered only to the right API key and team ID, as the real one does. `cards` are cards as it gives
// them with casing=camel ({ id, name, supertype, subtypes, hp, types, number, rarity, expansion: { id, name, releaseDate },
// images: [{ type, small, medium, large }], evolvesFrom: [], regulationMark, attacks, abilities, convertedRetreatCost... }).
// It records the URLs (`requests`) and the headers (`headers`). `behave(request)` may return respond(...) or { hang: true }.
async function startMockScrydex({ cards = [], key = 'test-key-0123456789', team = 'test-team-0123', behave = () => null } = {}) {
  const requests = [];
  const headers = [];
  const lower = (text) => String(text || '').toLowerCase();
  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  // the part of the query language the app uses: name:word, name:word*, field:"phrase", field:word
  const matches = (card, q) => {
    const terms = String(q || '').match(/[\w.]+:"[^"]*"|[\w.]+:\S+/g) || [];
    return terms.every((term) => {
      const [name, ...rest] = term.split(':');
      const value = rest.join(':').replace(/"/g, '');
      switch (name) {
        // a name is words, the way a search engine reads it: "Mr. Mime" is "mr" and "mime"
        case 'name': {
          const nameWords = lower(card.name).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
          return value.endsWith('*') ? nameWords.some((word) => word.startsWith(lower(value.slice(0, -1)))) : nameWords.includes(lower(value));
        }
        case 'supertype': return card.supertype === value;
        case 'subtypes': return (card.subtypes || []).includes(value);
        case 'rarity': return card.rarity === value;
        case 'expansion.id': return card.expansion && card.expansion.id === value;
        case 'evolves_from': return (card.evolvesFrom || []).includes(value);
        case 'regulation_mark': return card.regulationMark === value;
        default: throw new Error(`the mock does not understand ${term}`);
      }
    });
  };
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    headers.push(req.headers);
    const special = behave({ method: req.method, url: req.url });
    if (special && special.hang) return;
    if (special && special.__response) return send(res, special.status, special.body);
    if (req.headers['x-api-key'] !== key || req.headers['x-team-id'] !== team) return send(res, 401, { error: 'Unauthorized' });

    const url = new URL(req.url, 'http://mock');
    const parts = url.pathname.split('/').filter(Boolean); // pokemon, v1, cards, <id>
    if (parts[0] !== 'pokemon' || parts[1] !== 'v1' || parts[2] !== 'cards') return send(res, 404, { error: 'not found' });
    if (parts.length === 3) {
      const page = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('page_size') || 100);
      const found = cards.filter((card) => matches(card, url.searchParams.get('q')));
      const data = found.slice((page - 1) * pageSize, page * pageSize);
      return send(res, 200, { data, page, pageSize, count: data.length, totalCount: found.length });
    }
    const card = cards.find((item) => item.id === decodeURIComponent(parts[3]));
    return card ? send(res, 200, { data: card }) : send(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/pokemon/v1`,
    requests,
    headers,
    cards,
    key,
    team,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
}

class Client {
  // `guest`: connect the way another device on the network does (to the computer's network address, not to a local one), so the page
  // is not the host's
  constructor(base, { clientId, name, role = 'control', cookie, guest = false } = {}) {
    this.seq = 0;
    this.state = null;
    this.events = {};
    this.watchers = new Set();
    this.connectError = null;

    const headers = { ...(cookie ? { cookie } : {}), ...(guest ? { Host: '192.168.1.50:6767' } : {}) };
    this.socket = io(base, {
      transports: ['websocket'],
      auth: { role, clientId, name },
      extraHeaders: Object.keys(headers).length ? headers : undefined,
      reconnection: false
    });
    this.socket.on('connect_error', (error) => { this.connectError = error.message; });

    for (const event of [
      'state:full', 'state:update', 'action:applied', 'action:rejected', 'announce', 'presence', 'activity',
      'activity:history', 'you', 'draft:state', 'draft:sent', 'draft:closed', 'draft:conflicts', 'theme:changed',
      'sfx', 'sounds:changed', 'catalog:progress', 'health:progress', 'decks:changed', 'kicked'
    ]) {
      this.socket.on(event, (data) => this.record(event, data));
    }
  }

  record(event, data) {
    (this.events[event] ||= []).push(data);
    if (event === 'state:full' || event === 'state:update') this.state = data;
    for (const watcher of [...this.watchers]) {
      if (watcher.event === event && watcher.predicate(data)) watcher.handler(data);
    }
  }

  // Call handler for each matching event until the returned function is called
  watch(event, predicate, handler) {
    const watcher = { event, predicate, handler };
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  // Resolves with the next matching event (register this BEFORE doing what causes it)
  expect(event, predicate = () => true, ms = 8000) {
    return new Promise((resolve, reject) => {
      const stop = this.watch(event, predicate, (data) => {
        stop();
        clearTimeout(timer);
        resolve(data);
      });
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`timed out waiting for "${event}"`));
      }, ms);
    });
  }

  async ready() {
    if (this.state) return this;
    await this.expect('state:full');
    return this;
  }

  get revision() {
    return this.state.revision;
  }

  // Wait for the server's answer to the action with this sequence number: applied, or rejected
  answerTo(seq, ms = 8000) {
    return new Promise((resolve, reject) => {
      const stops = [];
      const finish = (value) => {
        stops.forEach((stop) => stop());
        clearTimeout(timer);
        resolve(value);
      };
      stops.push(this.watch('action:applied', (a) => a.seq === seq, (applied) => finish({ ok: true, applied, state: this.state })));
      stops.push(this.watch('action:rejected', (r) => r.seq === seq, (rejected) => finish({ ok: false, rejected })));
      const timer = setTimeout(() => {
        stops.forEach((stop) => stop());
        reject(new Error(`no answer to action #${seq}`));
      }, ms);
    });
  }

  // Send an action the way the control panel does (with the revision it last saw and a sequence number)
  // and report the answer: { ok: true, state } or { ok: false, rejected }.
  async act(event, payload, { baseRevision = this.revision, seq = ++this.seq } = {}) {
    const answer = this.answerTo(seq);
    this.socket.emit(event, { ...payload, meta: { baseRevision, seq } });
    return answer;
  }

  // Send an action into this producer's draft; resolves with the draft as the server now has it
  async draftAct(event, payload) {
    const seq = ++this.seq;
    const answer = Promise.race([
      this.expect('draft:state', (d) => d.ack === seq).then((draft) => ({ ok: true, draft })),
      this.answerTo(seq).then((result) => (result.ok ? new Promise(() => {}) : result))
    ]);
    this.socket.emit(event, { ...payload, meta: { draft: true, baseRevision: this.revision, seq } });
    return answer;
  }

  // Emit something that is not expected to produce a response
  emit(event, payload) {
    this.socket.emit(event, payload);
  }

  last(event) {
    const list = this.events[event] || [];
    return list[list.length - 1];
  }

  close() {
    this.socket.close();
  }
}

// `prepare(dir)` runs before the server starts, to put files in its data folder (a design from an older version, say)
// `appRoot` is the folder the app is started from (the project, unless a test puts a copy somewhere else)
async function startServer({ env = {}, label = 'srv', prepare, appRoot = ROOT } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, `${label}-`));
  if (prepare) prepare(dir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';

  const child = spawn(process.execPath, [path.join(appRoot, 'src', 'server.js')], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_PATH: path.join(ROOT, 'node_modules'), // (a copy of the app finds the packages of the project)
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: path.join(dir, 'overlay.sqlite'),
      LOG_DIR: path.join(dir, 'logs'),
      // Never reach the real card services from a test (a refused connection fails fast)
      POKEMONTCG_API_URL: 'http://127.0.0.1:9',
      OTO_TCGDEX_URL: 'http://127.0.0.1:9/v2',
      OTO_TCGDEX_ASSETS: 'http://127.0.0.1:9',
      OTO_SPRITE_BASE: 'http://127.0.0.1:9',
      OTO_TCGDEX_RETRY_MS: '1',
      OTO_SCRYDEX_API_URL: 'http://127.0.0.1:9/pokemon/v1',
      OTO_SCRYDEX_RETRY_MS: '1',
      OTO_PASSWORD: '',
      // A machine busy with several servers and browsers at once can leave a socket unanswered for longer than the usual 5 seconds, and a
      // test client does not reconnect: give it room, so a slow moment does not turn into a cascade of "no answer" failures
      OTO_PING_TIMEOUT_MS: '60000',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}):\n${logs}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${logs}`);
    await wait(100);
  }

  const clients = [];
  return {
    base,
    appRoot,
    port,
    dir,
    logs: () => logs,

    // Open a socket client; `await client.ready()` before using it
    client(options) {
      const client = new Client(base, options);
      clients.push(client);
      return client;
    },

    async stop() {
      for (const client of clients) client.close();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

// A stand-in for the card image host: serves a tiny PNG for /<set>/<file>, and records what was asked.
// `behave(url)` may return respond(...) to answer differently (a 404, a wrong content type).
async function startMockImageHost(behave = () => null) {
  const requests = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const special = behave(req.url);
    if (special && special.__response) {
      res.statusCode = special.status;
      for (const [name, value] of Object.entries(special.headers)) res.setHeader(name, value);
      return res.end(special.body);
    }
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    png,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
}

module.exports = { startServer, startMockCardApi, startMockTcgdex, startMockScrydex, startMockImageHost, respond, wait, ROOT };
