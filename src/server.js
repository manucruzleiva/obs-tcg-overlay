/**
 * OTO (obs-tcg-overlay) server
 * Serves the control panel and the overlay, and keeps the game state in sync in real time
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const winston = require('winston');
const fs = require('fs');

const Database = require('./db/database');
const PokemonTCGService = require('./services/pokemon-tcg');
const CacheService = require('./services/cache');
const { CardUsage } = require('./services/card-usage');
const GameStateService = require('./services/gamestate');
const { Auth } = require('./services/auth');
const { ThemeStore } = require('./services/themes');
const { SoundStore } = require('./services/sounds');
const { ImageCache } = require('./services/images');
const { CatalogService } = require('./services/catalog');
const { PackageService } = require('./services/package');
const { Session, PRODUCERS } = require('./session');
const { getLanAddresses, isShared } = require('./services/network');
const { DEFAULT_PORT } = require('./config');
const { checkPort } = require('./services/port-check');

const PUBLIC_DIR = path.join(__dirname, '../public');

// Lazy logger initialization - creates logger on first use with current env vars
let logger = null;
function getLogger() {
  if (logger) return logger;

  // Determine log directory (use LOG_DIR env var for Electron packaged app, fallback to local logs)
  const logDir = process.env.LOG_DIR || path.join(__dirname, '../logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: 'obs-tcg-overlay' },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      }),
      new winston.transports.File({
        filename: path.join(logDir, 'error.log'),
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5,
        flush: true
      }),
      new winston.transports.File({
        filename: path.join(logDir, 'combined.log'),
        maxsize: 5242880, // 5MB
        maxFiles: 5,
        flush: true
      })
    ]
  });

  return logger;
}

// A browser page from another site must not be able to drive the overlay: if a request names an
// origin, it has to be this server. Scripts and other tools send no Origin and are unaffected.
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  allowRequest: (req, callback) => callback(null, isSameOrigin(req)),
  pingInterval: 10000,
  // (the tests raise it: with a few browsers and servers running at once, a page can miss an answer for longer than a viewer ever would)
  pingTimeout: Number(process.env.OTO_PING_TIMEOUT_MS) || 5000
});

const PORT = process.env.PORT || DEFAULT_PORT;
// Different on every run: it tells this server apart from any other program answering on the same port
const INSTANCE_ID = require('node:crypto').randomBytes(8).toString('hex');
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Card pictures and theme images come from the card API, the web, or uploads embedded in a theme
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      // The app is used over plain http on a local network, so never upgrade requests to https
      upgradeInsecureRequests: null
    }
  },
  hsts: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(express.json({ limit: '12mb' }));

// Refuse state-changing requests that come from a page on another site
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isSameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-site request refused' });
  }
  next();
});

// Custom request logging for API calls (errors only)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      getLogger().warn('HTTP Request Error', {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration: `${Date.now() - start}ms`,
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
    }
  });
  next();
});

// Services (created in initialize())
const db = new Database();
const cache = new CacheService(db);
const pokemonTCG = new PokemonTCGService(cache);
let gameState = null;
let session = null;

// The card API key is a setting; keep the API client in step with it
function applyApiSettings(state) {
  pokemonTCG.setProvider(state.settings.apiProvider, state.settings.apiKey || '', state.settings.cardLanguage);
  pokemonTCG.setCredentials({ scrydexKey: state.settings.scrydexKey, scrydexTeam: state.settings.scrydexTeam });
}

async function initialize() {
  await db.init();
  gameState = new GameStateService(db, pokemonTCG);
  applyApiSettings(gameState.state);

  const auth = new Auth(db);
  if (auth.resetIfRequested()) getLogger().warn('The control panel password was removed (OTO_RESET_PASSWORD=1)');
  const dataDir = path.dirname(db.dbPath);
  const themes = new ThemeStore(path.join(dataDir, 'themes'), db);
  const sounds = new SoundStore(path.join(dataDir, 'sounds'));
  session = new Session({ io, gameState, log: getLogger(), afterChange: applyApiSettings });

  // Designs saved by an earlier version are turned into folders of files
  const converted = themes.init();
  if (converted.converted.length || converted.failed.length) getLogger().info('Designs brought up to date', converted);

  // .oto packages: a design with its sounds, plus the control settings
  const packages = new PackageService({
    themes, sounds, gameState, session,
    emit: (event) => io.emit(event),
    appVersion: require('../package.json').version
  });

  // Card pictures and the card library are kept on disk beside the database
  const images = new ImageCache({ dir: path.join(dataDir, 'images') });
  const catalog = new CatalogService({
    dir: path.join(dataDir, 'catalog'),
    db,
    images,
    // the Pokémon TCG API, and the other services a library can be built from (the one chosen in the settings builds it)
    baseUrl: () => pokemonTCG.providers.pokemontcg.baseUrl,
    scrydex: pokemonTCG.scrydex,
    tcgdex: pokemonTCG.tcgdex,
    librarySource: () => gameState.state.settings.librarySource,
    apiKey: () => pokemonTCG.apiKey,
    // the tests make downloads quick
    paceMs: process.env.OTO_CATALOG_PACE_MS === undefined ? undefined : Number(process.env.OTO_CATALOG_PACE_MS),
    retryDelayMs: process.env.OTO_CATALOG_RETRY_MS === undefined ? undefined : Number(process.env.OTO_CATALOG_RETRY_MS),
    log: (level, message, meta) => getLogger()[level](message, meta)
  });
  catalog.init();
  pokemonTCG.setCatalog(catalog);
  catalog.on('progress', (status) => io.to(PRODUCERS).emit('catalog:progress', status));

  getLogger().info('Server initialized', { logDir: process.env.LOG_DIR || path.join(__dirname, '../logs') });

  // Anyone may open the overlay and the sign-in page; everything else needs the password (when one is set)
  const gate = (req, res, next) => {
    if (auth.isAuthorized(req.headers.cookie)) return next();
    // A person opening a page is sent to sign in; programs calling the API get a plain 401
    const isPage = req.method === 'GET' && !req.originalUrl.startsWith('/api/') && req.accepts('html');
    if (isPage) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return res.status(401).json({ error: 'Password required' });
  };

  // The cards used most, for the card picker to start from; and expired lookups are cleared away now and then
  const cardUsage = new CardUsage({ db, localize: (card) => pokemonTCG.localize(card) });
  cache.cleanup();
  setInterval(() => cache.cleanup(), 60 * 60 * 1000).unref();

  const { publicRouter, protectedRouter } = require('./api/routes')({
    db, cache, pokemonTCG, cardUsage, gameState, session, auth, themes, sounds, catalog, packages, io, instanceId: INSTANCE_ID
  });
  app.use('/api', publicRouter);
  app.use('/api', gate, protectedRouter);

  // The control panel (page and files) sits behind the gate
  app.get('/control', gate, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'control', 'index.html')));
  app.use('/control', gate, express.static(path.join(PUBLIC_DIR, 'control'), { index: false }));

  // Everything else in /public (overlay, sign-in page, scripts, styles) is open
  // redirect: false so /overlay and /login are served directly rather than bounced to a trailing slash
  app.use(express.static(PUBLIC_DIR, { index: false, redirect: false }));

  // The project logo, the energy icons and the status icons live in the assets folder at the project root
  // (the logo is also the README picture). The tab icon is asked for by every page, and browsers
  // ask for /favicon.ico by themselves.
  // (OTO_ASSETS_DIR is for the tests: a folder with some of the pictures missing)
  const ASSETS_DIR = process.env.OTO_ASSETS_DIR || path.join(__dirname, '..', 'assets');
  app.get('/logo.gif', (req, res) => res.sendFile(path.join(ASSETS_DIR, 'logo.gif')));
  app.get(['/logo.ico', '/favicon.ico'], (req, res) => res.sendFile(path.join(ASSETS_DIR, 'logo.ico')));
  // The icons of the energy types and of the special conditions are files that may not be there: the folders can be deleted, and an icon
  // may not be made yet (Confused). The pages draw a plain disc for one that is missing. For the name of an icon that is known but has no
  // file the answer is 204 (nothing here), which tells them just the same without an error in the browser's console and a warning in the
  // log on every page load, as a 404 would. Anything else that is not in the folder is a 404.
  const GAME = require('../public/js/game-data');
  const THEME_OPTIONS = require('../public/js/theme-options');
  const iconFolder = (route, folder, icons) => {
    app.use(route, express.static(path.join(ASSETS_DIR, folder), { index: false }));
    const known = new Set(icons.map((icon) => path.basename(icon)));
    app.get(`${route}/:file`, (req, res, next) => (known.has(req.params.file) ? res.status(204).end() : next()));
  };
  iconFolder('/assets/energy', 'energy', GAME.ENERGY_TYPES.map((type) => type.icon));
  iconFolder('/assets/status', 'status', GAME.STATUS_CONDITIONS.map((condition) => condition.icon));
  // The prize card backs (English, Japanese, a Poké Ball) are put there by the maintainer, as whatever kind of picture they have (a PNG, a JPG or
  // a WebP): they are asked for by name alone, and the file that is there is sent. With none the answer is 204 like for the icons, and the
  // overlay draws a card back of its own.
  const CARD_BACKS = new Set(THEME_OPTIONS.PRIZE_STYLES.filter((style) => style.picture).map((style) => style.key));
  app.get('/assets/cardbacks/:name', (req, res, next) => {
    if (!CARD_BACKS.has(req.params.name)) return next();
    const file = THEME_OPTIONS.PRIZE_PICTURE_TYPES.map((type) => path.join(ASSETS_DIR, 'cardbacks', `${req.params.name}.${type}`)).find((found) => fs.existsSync(found));
    return file ? res.sendFile(file) : res.status(204).end();
  });
  app.use('/assets/fonts', express.static(path.join(ASSETS_DIR, 'fonts'), { index: false }));

  // Card pictures: saved on this computer the first time they are needed, then served from disk.
  // Open like the overlay itself, since OBS loads them without signing in.
  app.get('/img/:set/:file', async (req, res) => {
    const file = await images.ensure(req.params.set, req.params.file);
    if (!file) return res.status(404).type('text/plain').send('Picture not available');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    // Sent relative to the picture folder: the folders above it (the user's profile, a hidden
    // ".config" or the like) are none of the dotfile check's business
    res.sendFile(path.join(req.params.set, req.params.file), { root: images.dir, dotfiles: 'deny' }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });
  app.get('/login', (req, res) => {
    if (!auth.isEnabled() || auth.isAuthorized(req.headers.cookie)) return res.redirect('/control');
    res.sendFile(path.join(PUBLIC_DIR, 'login', 'index.html'));
  });
  app.get('/overlay', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'overlay', 'index.html'));
  });
  app.get('/', (req, res) => {
    res.redirect('/control');
  });

  // Error handling middleware (must come after the routes it covers)
  app.use((err, req, res, next) => {
    // Mistakes by the sender (a body that is too large, malformed JSON) are 4xx, not server faults
    const status = err.status || err.statusCode;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.type === 'entity.too.large' ? 'That is too large' : 'The request could not be read' });
    }
    getLogger().error('Unhandled error', {
      error: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      ip: req.ip
    });
    res.status(500).json({ error: 'Internal server error' });
  });

  // Decide, for every new socket, whether it is a control panel that may change the game
  io.use((socket, next) => {
    const hello = socket.handshake.auth || {};
    const clientId = typeof hello.clientId === 'string' && /^[\w-]{8,64}$/.test(hello.clientId) ? hello.clientId : socket.id;
    const authorized = auth.isAuthorized(socket.handshake.headers.cookie);
    socket.data = { clientId, name: hello.name, canControl: hello.role === 'control' && authorized };
    next();
  });

  io.on('connection', (socket) => {
    getLogger().info('Client connected', {
      socketId: socket.id,
      ip: socket.handshake.address,
      canControl: socket.data.canControl
    });
    session.attach(socket);

    socket.on('disconnect', (reason) => {
      getLogger().info('Client disconnected', { socketId: socket.id, reason });
    });
    socket.on('error', (error) => {
      getLogger().error('Socket error', { socketId: socket.id, error: error.message, stack: error.stack });
    });
  });
}

// Save the game and the database (called when the app is closing)
function shutdown() {
  try {
    if (gameState) gameState.destroy();
    db.close();
  } catch (error) {
    getLogger().error('Shutdown failed', { error: error.message });
  }
}

// Resolves once OTO has asked its own port who answers: { ok: true }, or what is wrong (the desktop app shows it)
let resolvePortCheck;
const portCheck = new Promise((resolve) => { resolvePortCheck = resolve; });

// Start listening only once everything is ready, so no request can slip past the password gate
initialize()
  .then(() => {
    server.listen(PORT, HOST, () => {
      const lan = isShared(HOST) ? getLanAddresses() : [];
      const hosts = ['localhost', ...lan.map((a) => a.address)];
      getLogger().info('Server started', {
        port: PORT,
        host: HOST,
        controlPanel: hosts.map((h) => `http://${h}:${PORT}/control`),
        overlay: `http://localhost:${PORT}/overlay`
      });
      checkPort({ port: PORT, host: HOST, instanceId: INSTANCE_ID }).then((result) => {
        if (!result.ok) getLogger().warn('Port check', { port: PORT, reason: result.reason, message: result.message });
        resolvePortCheck(result);
      });
    });
  })
  .catch((err) => {
    getLogger().error('Failed to initialize', { error: err.message, stack: err.stack });
    process.exit(1);
  });

// Running from the command line: save before exiting on Ctrl+C or a stop signal
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}

module.exports = { app, server, io, getGameState: () => gameState, shutdown, portCheck };
