/**
 * Small files of each kind a design can hold, made of just enough real bytes to be recognised for what
 * they are (the server never trusts a file name or a claimed type), and style sheets: ones a designer
 * could write, and ones that try to make the overlay load something or paint outside its stage.
 */

const pad = (head, size = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(size)]);

// Style sheets a design could really have (each one passes the strict check). Between them they use gradients, keyframes, @media,
// @font-face with the design's own fonts, var(), calc(), attribute selectors, :not() and :nth-child(), and ::before with a string.
const CSS_SHEETS = [
  {
    name: 'neon',
    css: `/* Neon: the scoreboard glows, a hit shakes the Pokemon, a knocked out one fades */
:root {
  --oto-moment-ms: 1800;
  --glow: 0 0 12px rgba(124, 140, 255, .8);
}
.scoreboard {
  background: linear-gradient(135deg, rgba(10, 14, 24, .9) 0%, rgba(40, 20, 80, .85) 100%), var(--css-texture);
  box-shadow: var(--glow), inset 0 0 0 1px rgba(255,255,255,.1);
  border-radius: calc(var(--radius) * 2);
}
.mon.moment-damage { animation: shake .4s cubic-bezier(.36,.07,.19,.97) both; }
.mon.moment-ko .art { animation: fade-out calc(var(--oto-moment-ms) * 1ms) ease-in forwards; }
.mon[data-amount]::after { content: "-" attr(data-amount); position: absolute; top: -1em; right: 0; font: 700 28px/1 var(--font-numbers); color: #ff4d6d; }
@keyframes shake { 0%, 100% { transform: translateX(0) } 20% { transform: translateX(-6px) rotate(-1deg) } 40% { transform: translateX(6px) rotate(1deg) } }
@keyframes fade-out { from { opacity: 1; filter: none } to { opacity: 0; filter: grayscale(1) blur(2px) } }
@media (max-width: 1280px) and (orientation: landscape) { .scoreboard { transform: scale(.9) } }
`
  },
  {
    name: 'paper',
    css: `@font-face {
  font-family: "Paper Hand";
  src: url(fonts/names.woff2) format("woff2"), url("fonts/font.ttf") format("truetype"), local("Comic Sans MS");
  font-display: block;
  unicode-range: U+0000-00FF, U+0131, U+4??;
}
@layer base, theme;
@layer theme {
  .trainer:not(.is-turn, .is-paused) .name { opacity: .6; font-family: "Paper Hand", var(--font-names) }
  .bench .mon:nth-child(2n + 1) { transform: rotate(-1.5deg) }
  .bench .mon:nth-last-child(-n+2 of .mon) { transform: rotate(1.5deg) }
  .prize[data-taken="true" i] {
    background: radial-gradient(circle at 30% 30%, #fff 0 10%, transparent 11%), conic-gradient(from 90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  }
}
@supports (backdrop-filter: blur(4px)) and (not (display: none)) { .scoreboard { backdrop-filter: blur(4px) saturate(1.4) } }
:root.has-logo .logo { filter: drop-shadow(0 2px 6px #000) }
html.prize-pokeball .prize::before { content: "\\2605  \\"star\\""; }
.name::first-letter { text-transform: uppercase }
.features > .card + .card { margin-left: -12px }
.status ~ .status { margin-left: 2px }
@container (min-width: 400px) { .features { gap: 12px } }
@starting-style { .toast { opacity: 0 } }
`
  },
  {
    name: 'sunrise',
    css: `#stage { --sun: #ffb347; }
#stage.is-paused .board { filter: saturate(.3) }
:is(.trainer-a, .trainer-b) .hp-bar > .fill { transition: width .3s ease-out, background-color .3s; }
:where(.mon) .status[data-status="poisoned"] { color: lab(60% -40 40) }
.logo { background: url(images/css-sun.png) center / contain no-repeat, url(images/logoImage.png); width: clamp(80px, 10vw, 160px); }
.stadium.moment-enter { animation: rise 600ms steps(6, end) 1 }
@-webkit-keyframes rise { 0% { -webkit-transform: translateY(20px) } 100% { -webkit-transform: none } }
@keyframes rise { 0% { transform: translateY(20px) } 100% { transform: none } }
.sb-wins.moment-point::after { content: "+1"; color: var(--sun, orange); }
.token.moment-used { animation: pop 300ms linear(0, 1.2 50%, 1) }
@keyframes pop { 50% { scale: 1.3 } }
.name::selection { background: transparent }
.trainer-a .hp-bar { width: min(100%, max(120px, 20vw)); grid-template-columns: [start] 1fr repeat(2, minmax(0, 1fr)) [end]; }
.board { clip-path: polygon(0 0, 100% 0, 100% calc(100% - 20px), 0 100%); }
@media (prefers-reduced-motion: reduce) { .mon, .token { animation: none } }
`
  }
];

// Style sheets that try to load something (or to show what the producer switched off, or to paint outside the stage). Each element
// they style is on the page of the browser test (tests/ui/css-safety.test.js): .t (with data-x="abc"), .u, .v and a, inside #stage.
const CSS_ATTACKS = [
  ['@import url()', '@import url(https://e.x/a.css);'],
  ['@import with a string', '@import "https://e.x/b.css";'],
  ['@IMPORT', '@IMPORT "https://e.x/c.css";'],
  ['@import with an escape', '@\\69mport "https://e.x/d.css";'],
  ['@import cut by a comment', '@im/**/port "https://e.x/e.css";'],
  ['@import inside @media', '@media screen { @import "https://e.x/f.css"; .t { color: red } }'],
  ['url() to the web', '.t { background: url(https://e.x/g) }'],
  ['url() to another site, without a scheme', '.t { background: url(//e.x/h) }'],
  ['URL() in capitals', '.t { background: URL(https://e.x/i) }'],
  ['url() written with an escape', '.t { background: \\75 rl(https://e.x/j) }'],
  ['u\\rl()', '.t { background: u\\rl(//e.x/k) }'],
  ['u/**/rl()', '.t { background: u/**/rl(//e.x/l) }'],
  ['url() with a quoted address and spaces', '.t { background: url( "https://e.x/m" ) }'],
  ['url() with escapes in the address', '.t { background: url(https\\:\\/\\/e.x/n) }'],
  ['a data: address', '.t { background: url(data:image/png;base64,AAA) }'],
  ['a javascript: address', '.t { background: url(javascript:alert(1)) }'],
  ['a page of OTO itself', '.t { background: url(/api/packages/export) }'],
  ['a path out of the folder', '.t { background: url(images/../../x.png) }'],
  ['a question mark after a file', '.t { background: url(images/logoImage.png?x) }'],
  ['image-set() with a string', '.t { background: image-set("https://e.x/o" 1x) }'],
  ['-webkit-image-set()', '.t { background: -webkit-image-set(url(//e.x/p) 1x) }'],
  ['cross-fade()', '.t { background: cross-fade(url(//e.x/q), url(//e.x/r), 50%) }'],
  ['-webkit-cross-fade()', '.t { background: -webkit-cross-fade(url(//e.x/s), url(//e.x/t), 50%) }'],
  ['image() with a string', '.t { background: image("https://e.x/u") }'],
  ['element()', '.t { background: element(#x) }'],
  ['paint()', '.t { background: paint(x) }'],
  ['src()', '.t { background: src(var(--u)) }'],
  ['expression()', '.t { width: expression(alert(1)) }'],
  ['behavior', '.t { behavior: url(x.htc) }'],
  ['-moz-binding', '.t { -moz-binding: url(x.xml#b) }'],
  ['@font-face from the web', '@font-face { font-family: Web; src: url(https://e.x/v.woff2) } .t { font-family: Web }'],
  ['@font-face from the web after a local one', '@font-face { font-family: Mix; src: local(Nope), url(//e.x/w.woff2) } .t { font-family: Mix }'],
  ['@namespace', '@namespace url(https://e.x/ns);'],
  ['@charset', '@charset "utf-8";'],
  ['@property with a picture', '@property --x { syntax: "<image>"; inherits: false; initial-value: url(//e.x/x) } .t { background: var(--x) }'],
  ['@counter-style with a picture', '@counter-style pic { system: cyclic; symbols: url(//e.x/y); } .t { display: list-item; list-style: pic }'],
  ['@document', '@-moz-document url-prefix() { .t { background: url(//e.x/z) } }'],
  ['a custom property holding a url(), used later', '.t { --u: url(//e.x/aa); background: var(--u) }'],
  ['a url() in the fallback of var()', '.t { background: var(--nothing, url(//e.x/ab)) }'],
  ['attr() as an address', '.t::before { content: attr(data-x url) }'],
  ['an attribute selector that tells what an attribute holds', '[data-x^="a"] { background: url(//e.x/ac) }'],
  ['pictures in other properties', '.t { cursor: url(//e.x/ad), auto; mask: url(//e.x/ae); border-image: url(//e.x/af) 30; list-style: url(//e.x/ag); filter: url(//e.x/ah#f) } .t::after { content: url(//e.x/ai) }'],
  ['a picture in @keyframes', '@keyframes k { from { background: url(//e.x/aj) } } .t { animation: k 1s infinite }'],
  ['a condition with an address', '@supports (background: url(//e.x/ak)) { .t { color: red } } @media url(//e.x/al) { .t { color: red } }'],
  ['an old Internet Explorer filter', '.t { filter: progid:DXImageTransform.Microsoft.AlphaImageLoader(src="https://e.x/am") }'],
  ['an address that is not one url()', '.t { background: url(https://e.x/an more) }'],
  ['</style><script>', '.t::before { content: "</style><script>alert(1)</script>" } </style><script>alert(1)</script>'],
  ['<!-- and -->', '<!-- .t { color: red } -->'],
  ['!important', '.t { display: block!important } .u { display: block ! important } .v { display: block !IMPORTANT }'],
  ['!important in a layer', '@layer x { [hidden] { display: block !important } }'],
  ['body', 'body { background: #000 url(//e.x/ao) }'],
  [':root', ':root { background: #000 }'],
  ['html', 'html { opacity: 0 }'],
  ['a pseudo-element of the page', ':root::before { content: ""; position: fixed; inset: 0; background: #000 }'],
  ['what is next to the stage', '#stage ~ * { background: #000 } #stage + * { background: #000 } :root #stage ~ div { background: #000 }'],
  [':has()', '#stage:has(.t) { outline: 1px solid red }'],
  [':visited', 'a:visited { color: red }'],
  ['a rule inside a rule', '.t { color: red; .u { background: url(//e.x/ap) } } .v { & .u { color: blue } }'],
  ['a block not closed at the end', '.t { color: red; background: url(//e.x/aq)'],
  ['a string not closed at the end', '.t::before { content: "abc'],
  ['a 300 KB file', `.t { color: red }${' '.repeat(300 * 1024)}`],
  ['NUL bytes', '.t { color: red }\u0000.t { background: url(//e.x/ar) }'],
  ['brackets deep inside each other', `.t { width: ${'calc('.repeat(5000)}1px${')'.repeat(5000)} }`]
];

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
  bigWav: (bytes) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(bytes - 12)]),
  CSS_SHEETS,
  CSS_ATTACKS
};
