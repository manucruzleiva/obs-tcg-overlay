/**
 * Database Service - SQL.js (asm.js - pure JavaScript, no WASM needed)
 */

const fs = require('fs');
const path = require('path');
const SQL = require('sql.js/dist/sql-asm.js');

class DatabaseService {
  constructor() {
    this.db = null;
    // Use DB_PATH env var for Electron packaged app, fallback to local data directory
    this.dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/overlay.sqlite');
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Load or create database
    let filebuffer;
    if (fs.existsSync(this.dbPath)) {
      filebuffer = fs.readFileSync(this.dbPath);
    }

    // Initialize SQL.js with asm.js (pure JavaScript, no WASM needed)
    const sql = await SQL();

    this.db = filebuffer ? new sql.Database(filebuffer) : new sql.Database();

    // Run schema
    this.runSchema();
    this.initialized = true;

    // Auto-save every 5 seconds
    setInterval(() => this.save(), 5000);

    console.log('Database initialized (SQL.js)');
  }

  runSchema() {
    const statements = [
      // Settings table
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );`,

      // Game state table (for autosave)
      `CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`,

      // Cache tables
      `CREATE TABLE IF NOT EXISTS card_cache (
        card_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_card_expires ON card_cache(expires_at);`,

      `CREATE TABLE IF NOT EXISTS search_cache (
        cache_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        query TEXT NOT NULL,
        page INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_search_expires ON search_cache(expires_at);`,

      `CREATE TABLE IF NOT EXISTS image_cache (
        card_id TEXT NOT NULL,
        size TEXT NOT NULL,
        file_path TEXT NOT NULL,
        etag TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (card_id, size)
      );`,
      `CREATE INDEX IF NOT EXISTS idx_image_expires ON image_cache(expires_at);`,

      `CREATE TABLE IF NOT EXISTS etag_cache (
        url TEXT PRIMARY KEY,
        etag TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`,

      // Favorites
      `CREATE TABLE IF NOT EXISTS favorites (
        card_id TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      );`,

      // Match history
      `CREATE TABLE IF NOT EXISTS match_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_name TEXT,
        opponent_name TEXT,
        player_wins INTEGER,
        opponent_wins INTEGER,
        best_of INTEGER,
        winner TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        state_json TEXT
      );`
    ];

    for (const stmt of statements) {
      this.db.run(stmt);
    }
  }

  save() {
    if (this.db) {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    }
  }

  close() {
    this.save();
    this.db = null;
    this.initialized = false;
  }

  // Settings
  getSetting(key, defaultValue = null) {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    stmt.bind([key]);
    // step() moves to the matching row; without it there is nothing to read
    const found = stmt.step() ? JSON.parse(stmt.getAsObject().value) : defaultValue;
    stmt.free();
    return found;
  }

  setSetting(key, value) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    stmt.run([key, JSON.stringify(value)]);
    stmt.free();
  }

  getAllSettings() {
    const stmt = this.db.prepare('SELECT key, value FROM settings');
    const settings = {};
    while (stmt.step()) {
      const row = stmt.getAsObject();
      settings[row.key] = JSON.parse(row.value);
    }
    stmt.free();
    return settings;
  }

  setAllSettings(settings) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(settings)) {
      stmt.run([key, JSON.stringify(value)]);
    }
    stmt.free();
  }

  // Game state (autosave)
  saveGameState(state) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO game_state (id, state_json, updated_at) VALUES (1, ?, ?)'
    );
    stmt.run([JSON.stringify(state), Date.now()]);
    stmt.free();
  }

  loadGameState() {
    const stmt = this.db.prepare('SELECT state_json FROM game_state WHERE id = 1');
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return JSON.parse(row.state_json);
    }
    stmt.free();
    return null;
  }

  // Card cache
  getCard(cardId) {
    const stmt = this.db.prepare(
      'SELECT data_json FROM card_cache WHERE card_id = ? AND expires_at > ?'
    );
    stmt.bind([cardId, Date.now()]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return JSON.parse(row.data_json);
    }
    stmt.free();
    return null;
  }

  setCard(cardId, provider, data, ttlMs = 7 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO card_cache (card_id, provider, data_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run([cardId, provider, JSON.stringify(data), now, now + ttlMs]);
    stmt.free();
  }

  getSearch(cacheKey) {
    const stmt = this.db.prepare(
      'SELECT data_json FROM search_cache WHERE cache_key = ? AND expires_at > ?'
    );
    stmt.bind([cacheKey, Date.now()]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return JSON.parse(row.data_json);
    }
    stmt.free();
    return null;
  }

  setSearch(cacheKey, provider, query, page, data, ttlMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO search_cache (cache_key, provider, query, page, data_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run([cacheKey, provider, query, page, JSON.stringify(data), now, now + ttlMs]);
    stmt.free();
  }

  // Image cache
  getImagePath(cardId, size) {
    const stmt = this.db.prepare(
      'SELECT file_path FROM image_cache WHERE card_id = ? AND size = ? AND expires_at > ?'
    );
    stmt.bind([cardId, size, Date.now()]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      if (row && fs.existsSync(row.file_path)) {
        return row.file_path;
      }
    }
    stmt.free();
    return null;
  }

  setImagePath(cardId, size, filePath, etag, ttlMs = 30 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO image_cache (card_id, size, file_path, etag, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    stmt.run([cardId, size, filePath, etag || '', now, now + ttlMs]);
    stmt.free();
  }

  getETag(url) {
    const stmt = this.db.prepare('SELECT etag FROM etag_cache WHERE url = ?');
    stmt.bind([url]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row.etag;
    }
    stmt.free();
    return null;
  }

  setETag(url, etag) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO etag_cache (url, etag, updated_at) VALUES (?, ?, ?)'
    );
    stmt.run([url, etag, Date.now()]);
    stmt.free();
  }

  // Favorites
  getFavorites() {
    const stmt = this.db.prepare('SELECT card_id FROM favorites ORDER BY added_at DESC');
    const favorites = [];
    while (stmt.step()) {
      favorites.push(stmt.get()[0]);
    }
    stmt.free();
    return favorites;
  }

  addFavorite(cardId) {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO favorites (card_id, added_at) VALUES (?, ?)'
    );
    stmt.run([cardId, Date.now()]);
    stmt.free();
  }

  removeFavorite(cardId) {
    const stmt = this.db.prepare('DELETE FROM favorites WHERE card_id = ?');
    stmt.run([cardId]);
    stmt.free();
  }

  isFavorite(cardId) {
    const stmt = this.db.prepare('SELECT 1 FROM favorites WHERE card_id = ?');
    stmt.bind([cardId]);
    const result = stmt.step();
    stmt.free();
    return result;
  }

  // Match history
  saveMatch(match) {
    const stmt = this.db.prepare(`
      INSERT INTO match_history (player_name, opponent_name, player_wins, opponent_wins, best_of, winner, started_at, ended_at, state_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      match.playerName, match.opponentName,
      match.playerWins, match.opponentWins,
      match.bestOf, match.winner,
      match.startedAt, match.endedAt,
      JSON.stringify(match.state)
    ]);
    stmt.free();
    return stmt.getLastInsertId ? stmt.getLastInsertId() : null;
  }

  getMatchHistory(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM match_history ORDER BY ended_at DESC LIMIT ?
    `);
    stmt.bind([limit]);
    const matches = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      matches.push({
        ...row,
        state: JSON.parse(row.state_json)
      });
    }
    stmt.free();
    return matches;
  }

  // Cleanup
  cleanupExpired() {
    const now = Date.now();
    this.db.run('DELETE FROM card_cache WHERE expires_at < ?', [now]);
    this.db.run('DELETE FROM search_cache WHERE expires_at < ?', [now]);
    this.db.run('DELETE FROM image_cache WHERE expires_at < ?', [now]);
  }
}

module.exports = DatabaseService;