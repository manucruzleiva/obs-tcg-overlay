/**
 * Card pictures kept on this computer.
 *
 * The pages ask this server for /img/<set>/<file>. The first time a picture is needed it is fetched
 * from the card image host (or from Scrydex, for the newest sets) and saved; from then on it is served
 * from disk, so a card that has been shown once still shows when the venue's internet is down.
 */

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_BASE = (process.env.OTO_IMAGE_BASE || 'https://images.pokemontcg.io').replace(/\/+$/, '');
// The newest sets (Ascended Heroes onwards) have their pictures on Scrydex instead: <host>/pokemon/<card id>/<size>
const SCRYDEX_BASE = (process.env.OTO_SCRYDEX_IMAGE_BASE || 'https://images.scrydex.com').replace(/\/+$/, '');

// Only plain names are served, so a request can never reach outside the picture folder or the image hosts
const SET_ID = /^[\w-]{1,40}$/;
const FILE_NAME = /^[\w-]{1,80}\.(png|jpe?g|webp)$/i;

// A Scrydex picture is kept as scrydex/<card id>_<size>.png: no card set is called "scrydex", so it cannot clash
const SCRYDEX_SET = 'scrydex';
const SCRYDEX_FILE = /^([A-Za-z0-9-]{1,60})_(small|medium|large)\.png$/;
const SCRYDEX_PICTURE = /^([A-Za-z0-9-]{1,60})\/(small|medium|large)$/;

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const STATS_FRESH_MS = 5000;

// { set, file } for a picture address on one of the card image hosts, or null for anything else
function pictureOf(url, base = IMAGE_BASE, scrydexBase = SCRYDEX_BASE) {
  if (typeof url !== 'string') return null;
  if (url.startsWith(`${scrydexBase}/pokemon/`)) {
    const match = SCRYDEX_PICTURE.exec(url.slice(scrydexBase.length + '/pokemon/'.length));
    return match ? { set: SCRYDEX_SET, file: `${match[1]}_${match[2]}.png` } : null;
  }
  if (!url.startsWith(`${base}/`)) return null;
  const [set, file, ...rest] = url.slice(base.length + 1).split('/');
  return rest.length === 0 && ImageCache.isValid(set, file) ? { set, file } : null;
}

// The address the pages should use for a picture: ours when it comes from a card image host
function localImageUrl(url, base = IMAGE_BASE) {
  const picture = pictureOf(url, base);
  return picture ? `/img/${picture.set}/${picture.file}` : url;
}

class ImageCache {
  constructor({ dir, base = IMAGE_BASE, scrydexBase = SCRYDEX_BASE, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS }) {
    this.dir = dir;
    this.base = base;
    this.scrydexBase = scrydexBase;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // pictures being fetched right now, so two requests share one download
    this.statsCache = null;
  }

  static isValid(set, file) {
    return SET_ID.test(set) && FILE_NAME.test(file);
  }

  pathOf(set, file) {
    return path.join(this.dir, set, file);
  }

  has(set, file) {
    return ImageCache.isValid(set, file) && fs.existsSync(this.pathOf(set, file));
  }

  // The file on disk for a picture, fetching it first when it is not there yet (null if it cannot be had)
  async ensure(set, file) {
    if (!ImageCache.isValid(set, file)) return null;
    const target = this.pathOf(set, file);
    if (fs.existsSync(target)) return target;

    const key = `${set}/${file}`;
    if (!this.pending.has(key)) {
      this.pending.set(key, this.fetchToDisk(set, file, target).finally(() => this.pending.delete(key)));
    }
    return this.pending.get(key);
  }

  // Where a picture is fetched from. The names are checked, so this can only ever be one of the two image hosts.
  sourceOf(set, file) {
    if (set !== SCRYDEX_SET) return `${this.base}/${set}/${file}`;
    const match = SCRYDEX_FILE.exec(file);
    return match ? `${this.scrydexBase}/pokemon/${match[1]}/${match[2]}` : null;
  }

  async fetchToDisk(set, file, target) {
    const source = this.sourceOf(set, file);
    if (!source) return null;
    try {
      const response = await this.fetch(source, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok || !String(response.headers.get('content-type') || '').startsWith('image/')) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;

      fs.mkdirSync(path.dirname(target), { recursive: true });
      // written beside the target and renamed, so a half-written picture is never served
      const temp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, target);
      this.statsCache = null;
      return target;
    } catch {
      return null;
    }
  }

  // Fetch many pictures, a few at a time. `onProgress({ done, failed, total })` after each one.
  async prefetch(items, { concurrency = 4, onProgress = () => {}, shouldStop = () => false } = {}) {
    const total = items.length;
    let done = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < total && !shouldStop()) {
        const item = items[next++];
        const file = await this.ensure(item.set, item.file);
        if (!file) failed++;
        done++;
        onProgress({ done, failed, total });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    return { done, failed, total, stopped: done < total };
  }

  // How many pictures are saved and how much room they take
  stats() {
    if (this.statsCache && Date.now() - this.statsCache.at < STATS_FRESH_MS) return this.statsCache.value;
    let count = 0;
    let bytes = 0;
    const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
    for (const folder of list(this.dir)) {
      if (!folder.isDirectory()) continue;
      for (const entry of list(path.join(this.dir, folder.name))) {
        if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
        try {
          bytes += fs.statSync(path.join(this.dir, folder.name, entry.name)).size;
          count++;
        } catch {
          // removed while counting
        }
      }
    }
    const value = { count, bytes };
    this.statsCache = { at: Date.now(), value };
    return value;
  }

  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.statsCache = null;
  }
}

module.exports = { ImageCache, localImageUrl, pictureOf, IMAGE_BASE };
