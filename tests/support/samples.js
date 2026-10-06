/**
 * Small files of each kind a design can hold, made of just enough real bytes to be recognised for what
 * they are (the server never trusts a file name or a claimed type).
 */

const pad = (head, size = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(size)]);

module.exports = {
  PNG: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  JPG: pad([0xff, 0xd8, 0xff, 0xe0], 32),
  GIF: pad('GIF89a', 32),
  WEBP: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]),
  SVG: Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'),
  WOFF2: pad('wOF2'),
  WOFF: pad('wOFF'),
  OTF: pad('OTTO'),
  TTF: pad([0, 1, 0, 0]),
  WAV: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]),
  MP3: pad('ID3'),
  OGG: pad('OggS'),
  // things that are not what they claim to be
  HTML: Buffer.from('<html><body><script>alert(1)</script></body></html>'),
  EXE: pad('MZ\x90\x00', 200),
  TEXT: Buffer.from('just some text, nothing more than that, long enough to count'),
  // a short silent sound a browser can really decode and play (8-bit mono, 8 kHz)
  playableWav: (ms = 120) => {
    const samples = Math.round((8000 * ms) / 1000);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + samples, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples, 40);
    return Buffer.concat([header, Buffer.alloc(samples, 0x80)]);
  },
  // a picture of the given size (a real PNG header, then filler)
  bigPng: (bytes) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8)]),
  bigWav: (bytes) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(bytes - 12)])
};
