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
  pingTimeout: 5000
});

const PORT = process.env.PORT || DEFAULT_PORT;
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
  pokemonTCG.setProvider('pokemontcg', state.settings.apiKey || '');
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
    baseUrl: () => pokemonTCG.providers[pokemonTCG.currentProvider].baseUrl,
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

  const { publicRouter, protectedRouter } = require('./api/routes')({
    db, cache, pokemonTCG, gameState, session, auth, themes, sounds, catalog, packages, io
  });
  app.use('/api', publicRouter);
  app.use('/api', gate, protectedRouter);

  // The control panel (page and files) sits behind the gate
  app.get('/control', gate, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'control', 'index.html')));
  app.use('/control', gate, express.static(path.join(PUBLIC_DIR, 'control'), { index: false }));

  // Everything else in /public (overlay, sign-in page, scripts, styles) is open
  // redirect: false so /overlay and /login are served directly rather than bounced to a trailing slash
  app.use(express.static(PUBLIC_DIR, { index: false, redirect: false }));

  // The project logo lives at the project root (it is also the README picture)
  app.get('/logo.gif', (req, res) => res.sendFile(path.join(__dirname, '..', 'logo.gif')));

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

module.exports = { app, server, io, getGameState: () => gameState, shutdown };
