/**
 * Custom sound effects: one uploaded audio file per sound cue, kept as plain files so they are easy
 * to find, back up or swap by hand. A cue without a file uses the built-in synthesized sound.
 */

const fs = require('fs');
const path = require('path');
const SOUND = require('../../public/js/sound-options');

const MAX_SOUND_BYTES = 1.5 * 1024 * 1024;

class SoundError extends Error {}

// What kind of audio a file really is, from its first bytes (the file name and the sender's
// claim are not trusted). Returns { ext, mime } or null.
function sniff(buffer) {
  if (buffer.length < 12) return null;
  const ascii = (from, to) => buffer.toString('latin1', from, to);

  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (ascii(0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (ascii(0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (ascii(4, 8) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm' };
  return null;
}

const EXTENSIONS = { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm' };

class SoundStore {
  constructor(dir) {
    this.dir = dir;
  }

  static isCue(key) {
    return SOUND.KEYS.includes(key);
  }

  fileFor(key) {
    if (!SoundStore.isCue(key)) return null;
    if (!fs.existsSync(this.dir)) return null;
    const name = fs.readdirSync(this.dir).find((file) => file.startsWith(`${key}.`) && EXTENSIONS[file.slice(key.length + 1)]);
    return name ? path.join(this.dir, name) : null;
  }

  // { cue: { mime, size, version } } for every cue that has an uploaded file
  list() {
    const custom = {};
    for (const key of SOUND.KEYS) {
      const file = this.fileFor(key);
      if (!file) continue;
      const stats = fs.statSync(file);
      custom[key] = { mime: EXTENSIONS[path.extname(file).slice(1)], size: stats.size, version: Math.round(stats.mtimeMs) };
    }
    return custom;
  }

  // { buffer, mime } or null
  read(key) {
    const file = this.fileFor(key);
    if (!file) return null;
    return { buffer: fs.readFileSync(file), mime: EXTENSIONS[path.extname(file).slice(1)] };
  }

  save(key, buffer) {
    if (!SoundStore.isCue(key)) throw new SoundError('Unknown sound');
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new SoundError('No audio was sent');
    if (buffer.length > MAX_SOUND_BYTES) throw new SoundError('That file is too large (1.5 MB at most)');
    const kind = sniff(buffer);
    if (!kind) throw new SoundError('That is not a supported audio file (use MP3, WAV, OGG, M4A or WebM)');

    fs.mkdirSync(this.dir, { recursive: true });
    this.remove(key); // an earlier upload may have had a different type
    const file = path.join(this.dir, `${key}.${kind.ext}`);
    fs.writeFileSync(`${file}.tmp`, buffer);
    fs.renameSync(`${file}.tmp`, file);
    return { mime: kind.mime, size: buffer.length };
  }

  remove(key) {
    const file = this.fileFor(key);
    if (!file) return false;
    fs.unlinkSync(file);
    return true;
  }
}

module.exports = { SoundStore, SoundError, MAX_SOUND_BYTES, sniff };
