/**
 * A small ZIP reader and writer: enough for .oto package files, with no dependencies.
 *
 * A .oto file is an ordinary ZIP under another name, so artists can open one with any zip tool, or
 * make one by zipping a folder. Reading is strict, because the file may come from anyone: sizes are
 * checked against what was declared, names that could point outside the package are refused, and
 * nothing is ever written to disk by name.
 */

const zlib = require('node:zlib');

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_NAMES = 0x0800;
const ENCRYPTED = 0x0001;

class ZipError extends Error {}

// ------------------------------------------------------------------------------------- CRC-32

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function slowCrc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Node 22.2 and later have it built in
const crc32 = typeof zlib.crc32 === 'function' ? (buffer) => zlib.crc32(buffer) >>> 0 : slowCrc32;

// ------------------------------------------------------------------------------------- writing

function dosStamp(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

// entries: [{ name, data: Buffer, compress?: boolean }] -> a ZIP file as a Buffer.
// Data is deflated unless that saves less than 5% (pictures and audio are usually compressed already).
function createZip(entries, { date = new Date() } = {}) {
  const { time, day } = dosStamp(date);
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const { name, data, compress = true } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    let method = 0;
    let body = data;
    if (compress && data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length * 0.95) { method = 8; body = deflated; }
    }
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CENTRAL, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(UTF8_NAMES, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

// ------------------------------------------------------------------------------------- reading

const MB = 1024 * 1024;

// The name as written in the file, tidied; null if it is not a name we are willing to read
function cleanName(raw) {
  let name = raw.replace(/\\/g, '/'); // some tools write Windows separators
  while (name.startsWith('./')) name = name.slice(2);
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || /[\u0000-\u001f]/.test(name)) return null;
  if (name.split('/').some((part) => part === '' || part === '..')) return null;
  return name;
}

// buffer -> Map of file name -> contents. `limits.entry(name)` is the most a file of that name may
// hold (return 0 to refuse it); `limits.total` and `limits.count` cap the whole package.
function readZip(buffer, limits = {}) {
  const maxCount = limits.count || 200;
  const maxTotal = limits.total || 64 * MB;
  const maxEntry = limits.entry || (() => 16 * MB);

  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ZipError('That is not a package file');

  // the end-of-archive record is at the very end, before an optional comment of up to 64 KB
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
    if (buffer.readUInt32LE(at) === END) { end = at; break; }
  }
  if (end < 0) throw new ZipError('That is not a package file (or it is damaged)');

  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipError('That package is too large');
  if (count > maxCount) throw new ZipError(`That package holds too many files (${count})`);
  if (start + size > end) throw new ZipError('That package is damaged');

  const files = new Map();
  let position = start;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== CENTRAL) throw new ZipError('That package is damaged');
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const packed = buffer.readUInt32LE(position + 20);
    const unpacked = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localAt = buffer.readUInt32LE(position + 42);
    const rawName = buffer.subarray(position + 46, position + 46 + nameLength);
    position += 46 + nameLength + extraLength + commentLength;
    if (position > end) throw new ZipError('That package is damaged');

    // A folder entry ("images/") holds nothing and is never created on disk: skip it before looking at its name
    if (rawName[rawName.length - 1] === 0x2f || rawName[rawName.length - 1] === 0x5c) continue;
    const name = cleanName(rawName.toString(flags & UTF8_NAMES ? 'utf8' : 'latin1'));
    if (name === null) throw new ZipError('That package has a file with an unsafe name');
    if (files.has(name)) throw new ZipError(`That package has two files called "${name}"`);

    if (flags & ENCRYPTED) throw new ZipError('That package is password protected, which is not supported');
    if (method !== 0 && method !== 8) throw new ZipError('That package uses a compression that is not supported');
    if (packed === 0xffffffff || unpacked === 0xffffffff) throw new ZipError('That package is too large');

    const allowed = maxEntry(name);
    if (unpacked > allowed) throw new ZipError(`"${name}" is too large${allowed ? ` (${Math.round(allowed / MB * 10) / 10} MB at most)` : ''}`);
    total += unpacked;
    if (total > maxTotal) throw new ZipError(`That package is too large (${Math.round(maxTotal / MB)} MB at most once unpacked)`);

    // where the data starts comes from the file's own header: its name and extra fields can differ in length
    if (localAt + 30 > start || buffer.readUInt32LE(localAt) !== LOCAL) throw new ZipError('That package is damaged');
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    if (dataAt + packed > start) throw new ZipError('That package is damaged');
    const raw = buffer.subarray(dataAt, dataAt + packed);

    let data;
    try {
      // the output can never be longer than declared: a "bomb" that claims to be small is cut off
      data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: unpacked + 1 });
    } catch {
      throw new ZipError(`"${name}" is damaged`);
    }
    if (data.length !== unpacked || crc32(data) !== crc) throw new ZipError(`"${name}" is damaged`);
    files.set(name, data);
  }
  return files;
}

module.exports = { createZip, readZip, ZipError, crc32, MB };
