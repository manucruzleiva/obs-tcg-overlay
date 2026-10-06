/**
 * Card pictures kept on this computer.
 *
 * The pages ask this server for /img/<set>/<file>. The first time a picture is needed it is fetched
 * from the card image host (from Scrydex for the newest sets, from TCGdex for the cards of that service) and
 * saved; from then on it is served from disk, so a card that has been shown once still shows when the venue's
 * internet is down. The pictures of Pokémon that go next to a deck on the overlay (/img/sprite/<Pokédex number>.png) are kept the same way.
 */

const fs = require('node:fs');
const path = require('node:path');
const POKEDEX = require('../../public/js/pokedex');

const IMAGE_BASE = (process.env.OTO_IMAGE_BASE || 'https://images.pokemontcg.io').replace(/\/+$/, '');
// The newest sets (Ascended Heroes onwards) have their pictures on Scrydex instead: <host>/pokemon/<card id>/<size>
const SCRYDEX_BASE = (process.env.OTO_SCRYDEX_IMAGE_BASE || 'https://images.scrydex.com').replace(/\/+$/, '');
// TCGdex's pictures: <host>/<language>/<series>/<set>/<number>/<quality>.<webp|png|jpg>
const TCGDEX_BASE = (process.env.OTO_TCGDEX_ASSETS || 'https://assets.tcgdex.net').replace(/\/+$/, '');
// The official artwork of a Pokémon, from the PokeAPI sprites repository: <host>/<Pokédex number>.png
const SPRITE_BASE = (process.env.OTO_SPRITE_BASE || 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork').replace(/\/+$/, '');

// The sprite that Limitless TCG puts on a deck (the icon of its Pokémon): <host>/<name>.png, as in "ogerpon.png"
const DECKICON_BASE = (process.env.OTO_DECKICON_BASE || 'https://r2.limitlesstcg.net/pokemon/gen9').replace(/\/+$/, '');

// Only plain names are served, so a request can never reach outside the picture folder or the image hosts
const SET_ID = /^[\w-]{1,40}$/;
const FILE_NAME = /^[\w-]{1,80}\.(png|jpe?g|webp)$/i;

// A Scrydex picture is kept as scrydex/<card id>_<size>.png: no card set is called "scrydex", so it cannot clash
const SCRYDEX_SET = 'scrydex';
const SCRYDEX_FILE = /^([A-Za-z0-9-]{1,60})_(small|medium|large)\.png$/;
const SCRYDEX_PICTURE = /^([A-Za-z0-9-]{1,60})\/(small|medium|large)$/;

// A TCGdex picture is kept as tcgdex/<language>__<series>__<set>__<number>__<quality>.<ext>: the parts have no underscore, so
// the two of them can be told apart again, and no card set is called "tcgdex"
const TCGDEX_SET = 'tcgdex';
const TCGDEX_FILE = /^([A-Za-z0-9-]{1,10})__([A-Za-z0-9-]{1,40})__([A-Za-z0-9-]{1,40})__([A-Za-z0-9-]{1,40})__(low|high)\.(webp|png|jpe?g)$/;
const TCGDEX_PICTURE = /^([A-Za-z0-9-]{1,10})\/([A-Za-z0-9-]{1,40})\/([A-Za-z0-9-]{1,40})\/([A-Za-z0-9-]{1,40})\/(low|high)\.(webp|png|jpe?g)$/;

// A Pokémon's picture is kept as sprite/<Pokédex number>.png: no card set is called "sprite". Only the numbers of Pokémon that exist.
const SPRITE_SET = 'sprite';
const SPRITE_FILE = /^([1-9]\d{0,3})\.png$/;
const isSprite = (file) => {
  const match = SPRITE_FILE.exec(file);
  return Boolean(match) && Number(match[1]) <= POKEDEX.COUNT;
};

// A deck's sprite is kept as deckicon/<name>.png (no card set is called "deckicon"). Only plain lowercase names.
const DECKICON_SET = 'deckicon';
const DECKICON_FILE = /^[a-z0-9-]{1,40}\.png$/;

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const STATS_FRESH_MS = 5000;

// { set, file } for a picture address on one of the card image hosts, or null for anything else
function pictureOf(url, base = IMAGE_BASE, scrydexBase = SCRYDEX_BASE, tcgdexBase = TCGDEX_BASE) {
  if (typeof url !== 'string') return null;
  if (url.startsWith(`${scrydexBase}/pokemon/`)) {
    const match = SCRYDEX_PICTURE.exec(url.slice(scrydexBase.length + '/pokemon/'.length));
    return match ? { set: SCRYDEX_SET, file: `${match[1]}_${match[2]}.png` } : null;
  }
  if (url.startsWith(`${tcgdexBase}/`)) {
    const match = TCGDEX_PICTURE.exec(url.slice(tcgdexBase.length + 1));
    return match ? { set: TCGDEX_SET, file: `${match[1]}__${match[2]}__${match[3]}__${match[4]}__${match[5]}.${match[6]}` } : null;
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
  constructor({ dir, base = IMAGE_BASE, scrydexBase = SCRYDEX_BASE, tcgdexBase = TCGDEX_BASE, spriteBase = SPRITE_BASE, deckIconBase = DECKICON_BASE, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS }) {
    this.dir = dir;
    this.base = base;
    this.scrydexBase = scrydexBase;
    this.tcgdexBase = tcgdexBase;
    this.spriteBase = spriteBase;
    this.deckIconBase = deckIconBase;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // pictures being fetched right now, so two requests share one download
    this.statsCache = null;
  }

  static isValid(set, file) {
    // a TCGdex picture has a name of its own shape (see TCGDEX_FILE), which is longer than the others, and a Pokémon's is a number
    if (!SET_ID.test(set)) return false;
    if (set === SPRITE_SET) return isSprite(file);
    if (set === DECKICON_SET) return DECKICON_FILE.test(file);
    return set === TCGDEX_SET ? TCGDEX_FILE.test(file) : FILE_NAME.test(file);
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

  // Where a picture is fetched from. The names are checked, so this can only ever be one of the image hosts.
  sourceOf(set, file) {
    if (set === SPRITE_SET) return isSprite(file) ? `${this.spriteBase}/${file}` : null;
    if (set === DECKICON_SET) return DECKICON_FILE.test(file) ? `${this.deckIconBase}/${file}` : null;
    if (set === SCRYDEX_SET) {
      const match = SCRYDEX_FILE.exec(file);
      return match ? `${this.scrydexBase}/pokemon/${match[1]}/${match[2]}` : null;
    }
    if (set === TCGDEX_SET) {
      const match = TCGDEX_FILE.exec(file);
      return match ? `${this.tcgdexBase}/${match[1]}/${match[2]}/${match[3]}/${match[4]}/${match[5]}.${match[6]}` : null;
    }
    return `${this.base}/${set}/${file}`;
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

module.exports = { ImageCache, localImageUrl, pictureOf, IMAGE_BASE, SPRITE_BASE };
