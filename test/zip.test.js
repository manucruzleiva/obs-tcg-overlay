const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createZip, readZip, ZipError, crc32, MB } = require('../src/services/zip');

// A ZIP built by hand, one field at a time, so a test can write exactly what another tool (or an
// attacker) might: each file is { name, stored (the bytes as written), method, crc, packed, unpacked, flags, extra, localExtra }
function rawZip(files, { comment = Buffer.alloc(0), count } = {}) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, file.flags & 0x0800 ? 'utf8' : 'latin1');
    const data = file.data || Buffer.alloc(0);
    const method = file.method ?? 0;
    const stored = file.stored ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = file.crc ?? crc32(data);
    const packed = file.packed ?? stored.length;
    const unpacked = file.unpacked ?? data.length;
    const flags = file.flags ?? 0;
    const localExtra = file.localExtra || Buffer.alloc(0);
    const extra = file.extra || Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    // with a data descriptor the local header carries zeros and the real numbers follow the data
    if (!(flags & 0x08)) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed, 18); local.writeUInt32LE(unpacked, 22); }
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, nameBytes, localExtra, stored);
    let length = 30 + nameBytes.length + localExtra.length + stored.length;
    if (flags & 0x08) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed, 8);
      descriptor.writeUInt32LE(unpacked, 12);
      parts.push(descriptor);
      length += 16;
    }

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed, 20);
    entry.writeUInt32LE(unpacked, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(extra.length, 30);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes, extra);
    offset += length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count ?? files.length, 8);
  end.writeUInt16LE(count ?? files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, central, end, comment]);
}

const text = (value) => Buffer.from(value, 'utf8');
const refuses = (buffer, pattern, limits) => assert.throws(() => readZip(buffer, limits), (error) => error instanceof ZipError && pattern.test(error.message), String(pattern));

describe('CRC-32', () => {
  it('matches the standard check values', () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
    assert.equal(crc32(text('123456789')), 0xcbf43926);
    assert.equal(crc32(text('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  });
});

describe('writing and reading a package', () => {
  it('gives back exactly what was put in, names and all', () => {
    const entries = [
      { name: 'manifest.json', data: text('{"format":"oto"}') },
      { name: 'images/logoImage.png', data: crypto.randomBytes(5000) },
      { name: 'sounds/damage.mp3', data: crypto.randomBytes(100) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'notes/léame ✓.txt', data: text('hola') }
    ];
    const files = readZip(createZip(entries));
    assert.deepEqual([...files.keys()], entries.map((entry) => entry.name));
    for (const entry of entries) assert.deepEqual(files.get(entry.name), entry.data, entry.name);
  });

  it('compresses what compresses well, and stores what does not', () => {
    const json = text(JSON.stringify({ colors: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`--c${i}`, '#ff4d6d'])) }));
    const noise = crypto.randomBytes(20000);
    const zip = createZip([{ name: 'a.json', data: json }, { name: 'b.bin', data: noise }]);
    assert.ok(zip.length < json.length + noise.length, `${zip.length} bytes`);
    assert.ok(zip.length < noise.length + json.length / 3, 'the JSON shrank a lot');
    assert.ok(zip.length >= noise.length, 'random data cannot shrink');
    assert.deepEqual([...readZip(zip).values()].map((data) => data.length), [json.length, noise.length]);
  });

  it('can be told to leave a file uncompressed', () => {
    const data = Buffer.alloc(10000, 'a');
    assert.ok(createZip([{ name: 'a', data, compress: false }]).length > data.length);
    assert.ok(createZip([{ name: 'a', data }]).length < 300);
  });

  it('writes an empty package', () => {
    assert.equal(readZip(createZip([])).size, 0);
  });
});

describe('reading packages other tools made', () => {
  it('reads files whose sizes follow the data (a data descriptor), with extra fields and folders', () => {
    const body = text('hello from another zip tool '.repeat(20));
    const zip = rawZip([
      { name: 'images/', data: Buffer.alloc(0), method: 0 },
      { name: 'images/logo.txt', data: body, method: 8, flags: 0x08, localExtra: Buffer.from([0x55, 0x58, 0x04, 0x00, 1, 2, 3, 4]), extra: Buffer.alloc(0) },
      { name: 'plain.txt', data: text('stored'), method: 0, extra: Buffer.from([0x75, 0x70, 0x02, 0x00, 9, 9]) }
    ], { comment: text('made with something else') });
    const files = readZip(zip);
    assert.deepEqual([...files.keys()], ['images/logo.txt', 'plain.txt']);
    assert.deepEqual(files.get('images/logo.txt'), body);
    assert.deepEqual(files.get('plain.txt'), text('stored'));
  });

  it('reads Windows-style names, and names in the old DOS code page', () => {
    const files = readZip(rawZip([
      { name: 'images\\logo.txt', data: text('a') },
      { name: 'caf\xe9.txt', data: text('b') } // not marked as UTF-8
    ]));
    assert.deepEqual([...files.keys()], ['images/logo.txt', 'café.txt']);
  });

  it('ignores a leading "./"', () => {
    assert.deepEqual([...readZip(rawZip([{ name: './design.json', data: text('{}') }])).keys()], ['design.json']);
  });
});

describe('refusing what is not safe or not a package', () => {
  const good = () => createZip([{ name: 'design.json', data: text('{"name":"x"}') }]);

  it('refuses things that are not packages', () => {
    refuses(Buffer.alloc(0), /not a package/);
    refuses(text('this is just text, not a package at all'), /not a package/);
    refuses(crypto.randomBytes(5000), /not a package/);
    refuses(good().subarray(0, good().length - 10), /not a package/);
    assert.throws(() => readZip('a string'), ZipError);
    assert.throws(() => readZip(null), ZipError);
  });

  it('refuses names that could point outside the package', () => {
    for (const name of ['../evil.txt', 'images/../../evil.txt', '/etc/passwd', 'C:\\Windows\\evil.exe', 'c:evil.txt', '..\\evil.txt', 'a//b.txt', 'bad\u0000name.txt']) {
      refuses(rawZip([{ name, data: text('x') }]), /unsafe name/);
    }
  });

  it('refuses two files with the same name, even when written differently', () => {
    refuses(rawZip([{ name: 'a.txt', data: text('1') }, { name: 'a.txt', data: text('2') }]), /two files called "a.txt"/);
    refuses(rawZip([{ name: 'images/a.txt', data: text('1') }, { name: 'images\\a.txt', data: text('2') }]), /two files/);
  });

  it('refuses password-protected packages and unknown compression', () => {
    refuses(rawZip([{ name: 'a', data: text('x'), flags: 0x0001 }]), /password/);
    refuses(rawZip([{ name: 'a', data: text('x'), method: 12 }]), /compression/);
    refuses(rawZip([{ name: 'a', data: text('x'), method: 99 }]), /compression/);
  });

  it('refuses packages too large or too crowded, by what they declare', () => {
    const many = rawZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: text('x') })));
    refuses(many, /too many files/, { count: 4 });
    refuses(rawZip([{ name: 'big.bin', data: Buffer.alloc(3 * MB) }]), /"big.bin" is too large \(2 MB at most\)/, { entry: () => 2 * MB });
    refuses(rawZip([{ name: 'secret.bin', data: text('x') }]), /"secret.bin" is too large/, { entry: (name) => (name === 'secret.bin' ? 0 : MB) });
    refuses(rawZip([{ name: 'a', data: Buffer.alloc(2 * MB) }, { name: 'b', data: Buffer.alloc(2 * MB) }]), /too large \(3 MB at most once unpacked\)/, { total: 3 * MB });
    refuses(rawZip([{ name: 'a', data: text('x'), packed: 0xffffffff }]), /too large/);
    refuses(rawZip([{ name: 'a', data: text('x') }], { count: 0xffff }), /too large/);
  });

  it('is not fooled by a small declared size on a huge compressed file (a zip bomb)', () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(50 * MB, 0));
    assert.ok(bomb.length < 100 * 1024);
    const started = Date.now();
    refuses(rawZip([{ name: 'a.json', data: Buffer.alloc(0), stored: bomb, method: 8, packed: bomb.length, unpacked: 1000, crc: 0 }]), /"a.json" is damaged/);
    assert.ok(Date.now() - started < 2000, 'cut off early, not unpacked first');
  });

  it('notices damage: a changed byte, a wrong size, a wrong checksum, cut-off data', () => {
    const stored = rawZip([{ name: 'a.txt', data: text('hello world'), method: 0 }]);
    const flipped = Buffer.from(stored);
    flipped[30 + 'a.txt'.length] ^= 0xff; // the first byte of the data
    refuses(flipped, /"a.txt" is damaged/);

    refuses(rawZip([{ name: 'a.txt', data: text('hello world'), method: 0, unpacked: 5 }]), /damaged/);
    refuses(rawZip([{ name: 'a.txt', data: text('hello world'), method: 0, crc: 12345 }]), /damaged/);
    refuses(rawZip([{ name: 'a.txt', data: text('hello world'), method: 8, stored: Buffer.from([1, 2, 3, 4, 5]), packed: 5 }]), /damaged/);
    refuses(rawZip([{ name: 'a.txt', data: text('hello world'), method: 0, packed: 5000 }]), /damaged/);
  });

  it('refuses a directory that points outside the file', () => {
    const zip = Buffer.from(good());
    zip.writeUInt32LE(zip.length + 100, zip.length - 6); // directory offset past the end
    refuses(zip, /damaged/);
    const second = Buffer.from(good());
    second.writeUInt32LE(0x12345678, second.length - 22 + 16 - 0); // nonsense offset
    assert.throws(() => readZip(second), ZipError);
  });

  it('refuses a local header that is not where the directory says', () => {
    const zip = Buffer.from(good());
    zip.writeUInt32LE(0xdeadbeef, 0); // the first file's header
    refuses(zip, /damaged/);
  });
});
