/**
 * Cache Service - Multi-layer caching (Memory + Disk + HTTP Conditional)
 */

const crypto = require('crypto');

class CacheService {
  constructor(db) {
    this.db = db;
    this.memoryCache = new Map();
    this.maxMemoryEntries = 500;
    this.memoryTTL = 60 * 60 * 1000; // 1 hour
  }

  // Search caching
  async getSearch(provider, query, page = 1) {
    const key = this.makeSearchKey(provider, query, page);

    // L1: Memory
    const memEntry = this.memoryCache.get(key);
    if (memEntry && memEntry.expires > Date.now()) {
      return memEntry.data;
    }

    // L2: Disk
    const diskData = this.db.getSearch(key);
    if (diskData) {
      this.promoteToMemory(key, diskData, this.memoryTTL);
      return diskData;
    }

    return null;
  }

  async setSearch(provider, query, page, data) {
    const key = this.makeSearchKey(provider, query, page);
    const ttl = 24 * 60 * 60 * 1000; // 24 hours

    this.promoteToMemory(key, data, this.memoryTTL);
    this.db.setSearch(key, provider, query, page, data, ttl);
  }

  // Card detail caching
  async getCard(cardId) {
    const key = `card:${cardId}`;

    const memEntry = this.memoryCache.get(key);
    if (memEntry && memEntry.expires > Date.now()) {
      return memEntry.data;
    }

    const diskData = this.db.getCard(cardId);
    if (diskData) {
      this.promoteToMemory(key, diskData, this.memoryTTL);
      return diskData;
    }

    return null;
  }

  async setCard(cardId, provider, data) {
    const key = `card:${cardId}`;
    const ttl = 7 * 24 * 60 * 60 * 1000; // 7 days

    this.promoteToMemory(key, data, this.memoryTTL);
    this.db.setCard(cardId, provider, data, ttl);
  }

  // Image caching
  async getImagePath(cardId, size) {
    return this.db.getImagePath(cardId, size);
  }

  async setImagePath(cardId, size, filePath, etag) {
    this.db.setImagePath(cardId, size, filePath, etag);
  }

  // ETag support
  getETag(url) {
    return this.db.getETag(url);
  }

  setETag(url, etag) {
    this.db.setETag(url, etag);
  }

  // Favorites
  getFavorites() {
    return this.db.getFavorites();
  }

  addFavorite(cardId) {
    this.db.addFavorite(cardId);
  }

  removeFavorite(cardId) {
    this.db.removeFavorite(cardId);
  }

  isFavorite(cardId) {
    return this.db.isFavorite(cardId);
  }

  // Prefetching
  async prefetchFavorites() {
    const favorites = this.getFavorites();
    // Would trigger background prefetch
    return favorites;
  }

  async prefetchMatchState(state) {
    // Prefetch active/bench cards for both players
    const cardIds = new Set();

    if (state.player?.active?.cardId) cardIds.add(state.player.active.cardId);
    if (state.opponent?.active?.cardId) cardIds.add(state.opponent.active.cardId);

    for (const slot of state.player?.bench || []) {
      if (slot.cardId) cardIds.add(slot.cardId);
    }
    for (const slot of state.opponent?.bench || []) {
      if (slot.cardId) cardIds.add(slot.cardId);
    }

    if (state.stadium?.cardId) cardIds.add(state.stadium.cardId);

    return Array.from(cardIds);
  }

  // Maintenance
  cleanup() {
    this.db.cleanupExpired();
    // Clean memory cache
    const now = Date.now();
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expires < now) {
        this.memoryCache.delete(key);
      }
    }
  }

  clearAll() {
    this.memoryCache.clear();
    // Disk cache cleared via direct DB calls if needed
  }

  // Helpers
  makeSearchKey(provider, query, page) {
    const hash = crypto.createHash('sha256')
      .update(`${provider}:${query}:${page}`)
      .digest('hex');
    return `search:${hash}`;
  }

  promoteToMemory(key, data, ttl) {
    // Evict if over limit
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }

    this.memoryCache.set(key, {
      data,
      expires: Date.now() + ttl
    });
  }

  getStats() {
    return {
      memoryEntries: this.memoryCache.size,
      maxMemoryEntries: this.maxMemoryEntries
    };
  }
}

module.exports = CacheService;