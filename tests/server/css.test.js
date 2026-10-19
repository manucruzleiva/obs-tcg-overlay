/**
 * The style sheet of a design (public/js/theme-css.js): what it may hold, what is never let through, and how it is written out again.
 * Every check of what is let through looks at what is written: it is read again, token by token, as a browser would read it.
 * (Saved, packed and handed to the overlay: themes.test.js, package.test.js, designs-server.test.js; in a real browser, with every
 * request it makes recorded: tests/ui/css-safety.test.js.)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const CSS = require('../../public/js/theme-css');
const RULES = require('../../public/js/theme-rules');
const THEME = require('../../public/js/theme-options');
const { CSS_SHEETS, CSS_ATTACKS } = require('../support/samples');

const { sanitizeCss, checkValue, isOwnRef, tokenize, CssError } = CSS;
const strict = (text, options = {}) => sanitizeCss(text, { ...options, strict: true });
const lenient = (text, options = {}) => sanitizeCss(text, options);
const refuses = (text, pattern, options) => assert.throws(() => strict(text, options), (error) => error instanceof CssError && pattern.test(error.message), String(pattern));
const written = (text, options) => lenient(text, options).css;

// What the spec lets a design use, written here again so the tests check the file against it (not against itself)
const AT_RULES = ['media', 'supports', 'layer', 'keyframes', '-webkit-keyframes', 'font-face', 'container', 'starting-style'];
const FUNCTIONS = [
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
  'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log', 'exp',
  'var', 'env', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'matrix', 'matrix3d', 'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale', 'scalex', 'scaley', 'scalez', 'scale3d',
  'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx', 'skewy', 'perspective',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  'cubic-bezier', 'steps', 'linear', 'inset', 'circle', 'ellipse', 'polygon', 'path', 'rect', 'xywh', 'repeat', 'minmax', 'fit-content', 'counter', 'counters',
  'format', 'tech', 'local', 'attr', 'selector', 'url',
  // in selectors
  'not', 'is', 'where', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'lang', 'dir'
];
const allowedFunction = (name) => FUNCTIONS.includes(name) || (name.startsWith('-webkit-') && FUNCTIONS.includes(name.slice(8)) && name !== '-webkit-url');

// Split `text` at the characters in `at` that are not inside ( ), [ ] or a string
function splitTop(text, at) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && at.includes(c)) {
      parts.push({ text: text.slice(start, i), after: c });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), after: '' });
  return parts;
}

// Every rule of a written style sheet is for the stage: "#stage ...", or ":root.x #stage ...", or a rule for :root or html alone that
// only sets custom properties; nothing goes from #stage to what is next to it (+ or ~)
function assertOnStage(css) {
  if (css === '') return;
  let inKeyframes = false;
  for (const line of css.split('\n')) {
    if (line === '}') { inKeyframes = false; continue; }
    if (line.startsWith('@')) {
      if (/^@(-webkit-)?keyframes /.test(line) && line.endsWith('{')) inKeyframes = true;
      continue;
    }
    if (inKeyframes) {
      assert.match(line, /^((from|to|[\d.]+%),?)+\{/, line);
      continue;
    }
    const [prelude, ...rest] = splitTop(line, '{');
    assert.ok(rest.length, `a rule: ${line}`);
    const body = line.slice(prelude.text.length + 1, -1);
    for (const { text: selector } of splitTop(prelude.text, ',')) {
      const compounds = splitTop(selector, ' >+~');
      const isStage = (compound) => /^#stage(?![\w-])/.test(compound.text);
      if (isStage(compounds[0])) {
        assert.ok(!['+', '~'].includes(compounds[0].after), `nothing next to the stage: ${selector}`);
      } else {
        assert.match(compounds[0].text, /^(:root|html)(?![\w-])/i, `a rule for the stage: ${selector}`);
        if (compounds.length === 1) {
          for (const { text: declaration } of splitTop(body, ';')) if (declaration) assert.match(declaration, /^--/, `only custom properties for the root: ${line}`);
        } else {
          assert.equal(compounds[0].after, ' ', selector);
          assert.ok(isStage(compounds[1]) && !['+', '~'].includes(compounds[1].after), `the root, then the stage: ${selector}`);
        }
      }
    }
  }
}

// Nothing in a written style sheet can make a browser load anything but the design's own files (`own(address)` says which those
// are), nothing can show what the producer switched off, and nothing can step out of a <style> element
function assertSafe(css, own = isOwnRef) {
  assert.equal(typeof css, 'string');
  assert.doesNotMatch(css, /<\//, 'no "</" anywhere');
  assert.doesNotMatch(css, /<!--|-->/, 'no HTML comments');
  assert.doesNotMatch(css, /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/, 'no control characters');
  const tokens = tokenize(css);
  tokens.forEach((token, index) => {
    assert.ok(!['url', 'bad-url', 'bad-string', 'cdo', 'cdc'].includes(token.type), `no ${token.type} token in ${css}`);
    assert.ok(!(token.type === 'delim' && token.value === '!'), `no ! (so no !important) in ${css}`);
    assert.ok(!(token.type === 'ident' && token.value.toLowerCase() === 'allow-discrete'), `no allow-discrete (no transition of display) in ${css}`);
    if (token.type === 'at') assert.ok(AT_RULES.includes(token.value.toLowerCase()), `@${token.value} in ${css}`);
    if (token.type === 'function') {
      const name = token.value.toLowerCase();
      assert.ok(allowedFunction(name), `${name}() in ${css}`);
      if (name === 'url') {
        assert.deepEqual([tokens[index + 1].type, tokens[index + 2].type], ['string', ')'], 'url() holds one string');
        assert.ok(own(tokens[index + 1].value), `url(${tokens[index + 1].value}) is one of the design's own files`);
      }
      if (name === 'attr') {
        const inside = tokens.slice(index + 1, tokens.findIndex((other, at) => at > index && other.type === ')')).filter((other) => other.type !== 'ws');
        assert.ok(inside.length === 1 || (inside.length === 3 && inside[2].type === 'string'), `attr() takes a name: ${css}`);
      }
    }
    if (token.type === 'ident' && ['behavior', '-moz-binding'].includes(token.value.toLowerCase())) {
      const next = tokens.slice(index + 1).find((other) => other.type !== 'ws');
      assert.ok(!next || next.type !== ':', `no ${token.value}: in ${css}`);
    }
  });
  assertOnStage(css);
  // (what is written can be longer than what was given, with #stage in front of each selector: only that much can be read again)
  if (own === isOwnRef && Buffer.byteLength(css) <= THEME.CSS_MAX_BYTES) assert.deepEqual(lenient(css).dropped, [], `nothing in what was written is left out when it is read again: ${css.slice(0, 200)}`);
}

// The tokens of a text, the way to compare two: no white space, and each token as plain data
const plainTokens = (text) => tokenize(text).filter((token) => token.type !== 'ws').map(({ line, ...token }) => token);

describe('the style sheet of a design', () => {
  describe('reading it the way a browser does', () => {
    it('decodes escapes, drops comments, and reads url() and strings as CSS does', () => {
      const types = (text) => tokenize(text).map((token) => token.type);
      assert.deepEqual(tokenize('\\75 rl(https://e.x)').map(({ type, value }) => [type, value]), [['url', 'https://e.x']]);
      assert.deepEqual(tokenize('u\\rl(//e.x)').map(({ type, value }) => [type, value]), [['url', '//e.x']]);
      assert.deepEqual(tokenize('URL( "https://e.x" )').map(({ type, value }) => [type, value]).slice(0, 2), [['function', 'URL'], ['ws', undefined]]);
      assert.deepEqual(types('u/**/rl(//e.x)').slice(0, 2), ['ident', 'function'], 'a comment cuts a word in two');
      assert.deepEqual(tokenize('@\\69mport').map(({ type, value }) => [type, value]), [['at', 'import']]);
      assert.deepEqual(tokenize('@im/**/port').map(({ type, value }) => [type, value]), [['at', 'im'], ['ident', 'port']]);
      assert.deepEqual(tokenize('url(a b)').map((token) => token.type), ['bad-url']);
      assert.deepEqual(tokenize('"a\nb"').map((token) => token.type), ['bad-string', 'ws', 'ident', 'string']);
      assert.deepEqual(tokenize('<!-- -->').map((token) => token.type), ['cdo', 'ws', 'cdc']);
    });

    it('keeps numbers as they were written, and knows a number from a name', () => {
      const one = (text) => { const [token] = tokenize(text); return [token.type, token.repr, token.unit]; };
      assert.deepEqual(one('.50'), ['number', '.50', undefined]);
      assert.deepEqual(one('1e3'), ['number', '1e3', undefined]);
      assert.deepEqual(one('-1.5E-2px'), ['dimension', '-1.5E-2', 'px']);
      assert.deepEqual(one('2n'), ['dimension', '2', 'n']);
      assert.deepEqual(one('10%'), ['percentage', '10', undefined]);
      assert.deepEqual(tokenize('#1a #a1').filter((token) => token.type === 'hash').map((token) => token.id), [false, true]);
      assert.deepEqual(tokenize('U+0000-00FF').map((token) => [token.type, token.repr || token.value]), [['ident', 'U'], ['number', '+0000'], ['dimension', '-00']]);
    });

    it('knows the line each token is on, whatever ends the lines', () => {
      assert.deepEqual(tokenize('a\nb\r\nc\rd\fe').filter((token) => token.type === 'ident').map((token) => token.line), [1, 2, 3, 4, 5]);
      assert.deepEqual(tokenize('/* one\ntwo */ x').filter((token) => token.type === 'ident').map((token) => token.line), [2]);
    });
  });

  describe('what it can never do', () => {
    it('refuses each way of loading something, of showing what was switched off, or of painting outside the stage, and says where', () => {
      for (const [name, text] of CSS_ATTACKS) {
        assert.throws(() => strict(text), (error) => error instanceof CssError && /^(Line \d+: .+|The style sheet is too large .+)\.$/.test(error.message), name);
      }
    });

    it('leaves each of them out of what it writes, so nothing written can load anything, show anything switched off or step outside the stage', () => {
      for (const [name, text] of CSS_ATTACKS) {
        const { css, dropped } = lenient(text);
        assert.ok(dropped.length > 0, `${name}: says what was left out`);
        assert.doesNotThrow(() => assertSafe(css), name);
        assert.equal(lenient(css).css, css, `${name}: what is written is written the same again`);
      }
    });

    it('does the same when it writes the addresses the overlay loads the files from', () => {
      const address = (ref) => `/api/theme/assets/${ref}?v=1&design=Store%20League`;
      const own = (text) => /^\/api\/theme\/assets\/([^?]+)\?v=1&design=Store%20League$/.test(text) && isOwnRef(/^\/api\/theme\/assets\/([^?]+)/.exec(text)[1]);
      for (const [name, text] of CSS_ATTACKS) assert.doesNotThrow(() => assertSafe(lenient(text, { resolve: address }).css, own), name);
    });

    it('keeps what was fine around what it left out', () => {
      const out = (name) => written(CSS_ATTACKS.find((attack) => attack[0] === name)[1]);
      assert.equal(out('@import inside @media'), '@media screen{\n#stage .t{color:red}\n}');
      assert.equal(out('url() to the web'), '#stage .t{}');
      assert.equal(out('a custom property holding a url(), used later'), '#stage .t{background:var(--u)}', 'the property that held the address is gone');
      assert.equal(out('@font-face from the web'), '@font-face{font-family:Web}\n#stage .t{font-family:Web}');
      assert.equal(out('an attribute selector that tells what an attribute holds'), '#stage [data-x^="a"]{}');
      assert.equal(out('!important'), '#stage .t{display:block}\n#stage .u{display:block}\n#stage .v{display:block}', 'the declaration stays, without !important');
      assert.equal(out('!important in a layer'), '@layer x{\n#stage [hidden]{display:block}\n}');
      assert.equal(out('a transition of display, which beats !important'), '#stage .t,#stage [hidden]{}\n#stage .u{}');
      assert.equal(out(':root'), ':root{}');
      assert.equal(out('html'), 'html{}');
      assert.equal(out('body'), '');
      assert.equal(out('</style><script>'), '#stage .t::before{content:"\\3c /style\\3e \\3c script\\3e alert(1)\\3c /script\\3e "}');
      assert.equal(out('<!-- and -->'), '#stage .t{color:red}');
      assert.equal(out('a rule inside a rule'), '#stage .t{color:red}\n#stage .v{}');
      assert.equal(out('a block not closed at the end'), '');
      assert.equal(out('a 300 KB file'), '');
      assert.equal(out('what is next to the stage'), '');
    });

    it('never lets a hidden prize card be shown by a selector or a property that loads it', () => {
      const text = '.prizes.is-hidden .prize.has-face::after { background-image: image-set(var(--prize-face) 1x); }';
      refuses(text, /image-set\(\) is not allowed/);
      assert.equal(written(text), '#stage .prizes.is-hidden .prize.has-face::after{}');
    });
  });

  describe('what a design can do', () => {
    it('takes style sheets a designer would write as they are: gradients, keyframes, @media, @font-face with its own fonts, var(), calc(), and more', () => {
      for (const sheet of CSS_SHEETS) {
        const { css, dropped } = strict(sheet.css);
        assert.deepEqual(dropped, [], sheet.name);
        assert.doesNotThrow(() => assertSafe(css), sheet.name);
      }
      const neon = written(CSS_SHEETS[0].css);
      assert.ok(neon.includes('#stage .scoreboard{background:linear-gradient(135deg, rgba(10, 14, 24, .9) 0%, rgba(40, 20, 80, .85) 100%), var(--css-texture);'));
      assert.ok(neon.includes('@keyframes shake{\n0%,100%{transform:translateX(0)}\n20%{transform:translateX(-6px) rotate(-1deg)}'));
      assert.ok(neon.includes('#stage .mon[data-amount]::after{content:"-" attr(data-amount);position:absolute;'));
      assert.ok(neon.includes('@media (max-width: 1280px) and (orientation: landscape){\n#stage .scoreboard{transform:scale(.9)}\n}'));
      assert.ok(neon.startsWith(':root{--oto-moment-ms:1800;--glow:0 0 12px rgba(124, 140, 255, .8)}'));
      const paper = written(CSS_SHEETS[1].css);
      assert.ok(paper.startsWith('@font-face{font-family:"Paper Hand";src:url("fonts/names.woff2") format("woff2"), url("fonts/font.ttf") format("truetype"), local("Comic Sans MS");font-display:block;unicode-range:U+0000-00FF, U+0131, U+4??}'));
      assert.ok(paper.includes('#stage .bench .mon:nth-last-child(-n+2 of .mon){transform:rotate(1.5deg)}'));
      assert.ok(paper.includes('@supports (backdrop-filter: blur(4px)) and (not (display: none)){'));
      assert.ok(paper.includes('html.prize-pokeball #stage .prize::before{content:"★ \\"star\\""}'));
      const sunrise = written(CSS_SHEETS[2].css);
      assert.ok(sunrise.includes('#stage .logo{background:url("images/css-sun.png") center / contain no-repeat, url("images/logoImage.png");width:clamp(80px, 10vw, 160px)}'));
      assert.ok(sunrise.includes('#stage :is(.trainer-a,.trainer-b) .hp-bar>.fill{'));
    });

    it('writes each of them out the same when it reads what it wrote, and what it writes reads as the same tokens as what was given', () => {
      // (the same tokens, but for white space, the #stage it puts in front of rules, the last ; of a block, and url(x) written as url("x"))
      const normal = (text) => {
        const tokens = [];
        for (const token of plainTokens(text)) {
          if (token.type === 'hash' && token.value === 'stage') continue;
          if (token.type === 'url') { tokens.push({ type: 'function', value: 'url' }, { type: 'string', value: token.value }, { type: ')' }); continue; }
          if (token.type === '}' && tokens.length && tokens[tokens.length - 1].type === ';') tokens.pop();
          tokens.push(token);
        }
        return tokens;
      };
      for (const sheet of CSS_SHEETS) {
        const once = written(sheet.css);
        const twice = written(once);
        assert.equal(twice, once, sheet.name);
        assert.deepEqual(plainTokens(twice), plainTokens(once), sheet.name);
        assert.deepEqual(normal(once), normal(sheet.css), sheet.name);
      }
    });

    it('never lets two tokens run together into another one when it writes them', () => {
      // values made of tokens that would merge if they were written next to each other carelessly: ident + ident, number + name,
      // - + number, / + *, an "e" after a number...
      const POOL = ['a', 'B', '-x', '--y', 'e3', 'E', 'n', 'u', '\\31 a', 'a\\ b', '\\@x', '\\3c x', '1', '+2', '-3', '.5', '1e3', '1E-2', '1px', '2n',
        '1\\65 3px', '-1-x', '1\\-', '10%', '#a', '#1a', '#-b', '"s"', "'t\\\"'", '/', '*', '+', '-', ',', 'calc(1px)', '[a b]', 'rgb(1 2 3)', 'url(images/css-a.png)'];
      const JOINS = ['', '', '', ' ', '/**/', '\n'];
      let seed = 7;
      const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
      const normal = (text) => {
        const tokens = tokenize(text).map(({ line, ...token }) => token).filter((token, index, all) => !(token.type === 'ws' && (index === 0 || index === all.length - 1 || all[index - 1].type === 'ws')));
        return tokens.map((token) => (token.type === 'url' ? [{ type: 'function', value: 'url' }, { type: 'string', value: token.value }, { type: ')' }] : [token])).flat();
      };
      let tried = 0;
      for (let round = 0; round < 3000; round++) {
        let value = '';
        for (let k = 1 + random(6); k > 0; k--) value += POOL[random(POOL.length)] + JOINS[random(JOINS.length)];
        const { css, dropped } = lenient(`.a{--f:${value}}`);
        if (dropped.length) continue;
        tried++;
        const out = css.slice('#stage .a{--f:'.length, -1);
        assert.deepEqual(normal(out), normal(value.trim()), `${JSON.stringify(value)} was written ${JSON.stringify(out)}`);
      }
      assert.ok(tried > 2000, `${tried} values were tried`);
    });

    it('keeps rules inside @media, @supports, @container, @layer and @starting-style, and keyframes in @keyframes', () => {
      assert.equal(written('@media screen and (min-width: 600px) { .a { color: red } }'), '@media screen and (min-width: 600px){\n#stage .a{color:red}\n}');
      assert.equal(written('@media (width >= 600px) and (min-aspect-ratio: 16/9) { .a { color: red } }'), '@media (width >= 600px) and (min-aspect-ratio: 16/9){\n#stage .a{color:red}\n}');
      assert.equal(written('@supports selector(:is(a)) { .a { color: red } }'), '@supports selector(:is(a)){\n#stage .a{color:red}\n}');
      assert.equal(written('@container card (min-width: 400px) { .a { color: red } }'), '@container card (min-width: 400px){\n#stage .a{color:red}\n}');
      assert.equal(written('@layer base, theme.colors;'), '@layer base,theme.colors;');
      assert.equal(written('@layer { .a { color: red } }'), '@layer{\n#stage .a{color:red}\n}');
      assert.equal(written('@starting-style { .a { opacity: 0 } }'), '@starting-style{\n#stage .a{opacity:0}\n}');
      assert.equal(written('@keyframes "glow" { FROM { opacity: 0 } 50%, 75% { opacity: .5 } }'), '@keyframes "glow"{\nfrom{opacity:0}\n50%,75%{opacity:.5}\n}');
      assert.equal(written('@media print { @supports (display: grid) { @layer x { .a { color: red } } } }'), '@media print{\n@supports (display: grid){\n@layer x{\n#stage .a{color:red}\n}\n}\n}', 'three deep');
    });
  });

  describe('where its rules apply: the stage', () => {
    it('puts each rule on the stage', () => {
      assert.equal(written('.logo { opacity: .5 }'), '#stage .logo{opacity:.5}');
      assert.equal(written('* { box-sizing: border-box }'), '#stage *{box-sizing:border-box}');
      assert.equal(written('.a, .b > .c, div.d { color: red }'), '#stage .a,#stage .b>.c,#stage div.d{color:red}');
      assert.equal(written('::before { content: "" }'), '#stage ::before{content:""}');
      assert.equal(written('#stage.is-paused .board { opacity: .5 }'), '#stage.is-paused .board{opacity:.5}', 'a rule that starts at the stage is kept as it is');
      assert.equal(written('#stage { --x: 1 }'), '#stage{--x:1}');
      assert.equal(written('.a #stage { color: red }'), '#stage .a #stage{color:red}');
    });

    it('lets a rule start at the page with the classes OTO puts on it, and puts what follows on the stage', () => {
      assert.equal(written(':root.has-logo .logo { opacity: 1 }'), ':root.has-logo #stage .logo{opacity:1}');
      assert.equal(written('html.prize-pokeball .prize { opacity: 1 }'), 'html.prize-pokeball #stage .prize{opacity:1}');
      assert.equal(written('html.prize-pokeball #stage .prize { opacity: 1 }'), 'html.prize-pokeball #stage .prize{opacity:1}');
      assert.equal(written(':root:not(.has-logo) > .logo { display: none }'), ':root:not(.has-logo) #stage .logo{display:none}');
      assert.equal(written(':root[data-x] ~ #stage { color: red }'), ':root[data-x] #stage{color:red}');
    });

    it('lets a rule for the page alone set custom properties, and nothing else', () => {
      assert.equal(written(':root { --oto-moment-ms: 2000; --glow: url(images/css-glow.png) }'), ':root{--oto-moment-ms:2000;--glow:url("images/css-glow.png")}');
      assert.equal(written('html.has-logo { --x: 1; background: #000; opacity: 0 }'), 'html.has-logo{--x:1}');
      refuses(':root { background: #000 }', /^Line 1: background is not allowed in a rule for :root or html \(the overlay's page must stay see-through: set only custom properties, such as --name, there\)\.$/);
      refuses('html {\n  opacity: 0\n}', /^Line 2: opacity is not allowed in a rule for :root or html/);
      assert.equal(written(':root, .a { --x: 1; color: red }'), '#stage .a{--x:1;color:red}\n:root{--x:1}', 'with other selectors, the rule is split in two');
      refuses(':root, .a { --x: 1; color: red }', /color is not allowed in a rule for :root or html/);
    });

    it('refuses what reaches outside the stage', () => {
      for (const [text, pattern] of [
        ['#stage ~ div { color: red }', /a rule can only style what is on the stage \(#stage ~ reaches outside it\)/],
        ['#stage + * { color: red }', /#stage \+ reaches outside it/],
        [':root #stage ~ div { color: red }', /#stage ~ reaches outside it/],
        [':root::before { content: "" }', /a pseudo-element of the page itself is not allowed \(the overlay's page must stay see-through\)/],
        ['html::after { content: "" }', /a pseudo-element of the page itself/],
        ['body { background: #000 }', /^Line 1: rules for body are not allowed \(the overlay's page must stay see-through\)\.$/],
        ['.a body { color: red }', /rules for body are not allowed/],
        [':not(body) { color: red }', /rules for body are not allowed/],
        ['BODY { color: red }', /rules for body are not allowed/],
        ['b\\ody { color: red }', /rules for body are not allowed/],
        ...['head', 'style', 'script', 'link', 'meta', 'title', 'iframe'].map((name) => [`${name} { display: block }`, new RegExp(`rules for ${name} are not allowed \\(only what is on the overlay's stage can be styled\\)`)])
      ]) {
        refuses(text, pattern);
        assert.doesNotThrow(() => assertSafe(written(text)), text);
      }
    });

    it('takes the selectors a design needs, and checks what is inside :not(), :is() and the like', () => {
      for (const [given, expected] of [
        ['[data-x] {}', '#stage [data-x]{}'],
        ['[data-x="a"], [data-x=a], [data-x~="a"], [data-x|="a"], [data-x^="a"], [data-x$="a"], [data-x*="a" i], [data-x="a" s] {}',
          '#stage [data-x="a"],#stage [data-x="a"],#stage [data-x~="a"],#stage [data-x|="a"],#stage [data-x^="a"],#stage [data-x$="a"],#stage [data-x*="a" i],#stage [data-x="a" s]{}'],
        ['.a:not(.b .c, :is(.d, .e)):where(.f) {}', '#stage .a:not(.b .c,:is(.d,.e)):where(.f){}'],
        ['li:nth-child(odd), li:nth-child(2n + 1 of .x), li:nth-last-child(-n+3), li:nth-of-type(3), li:nth-last-of-type(even) {}',
          '#stage li:nth-child(odd),#stage li:nth-child(2n + 1 of .x),#stage li:nth-last-child(-n+3),#stage li:nth-of-type(3),#stage li:nth-last-of-type(even){}'],
        [':lang(en, "fr"):dir(rtl) {}', '#stage :lang(en,"fr"):dir(rtl){}'],
        ['.a::before, .a::after, .a::first-letter, .a::first-line, li::marker, .a::selection, input::placeholder {}',
          '#stage .a::before,#stage .a::after,#stage .a::first-letter,#stage .a::first-line,#stage li::marker,#stage .a::selection,#stage input::placeholder{}'],
        ['.a:before, .a:AFTER, .a:first-letter, .a:first-line {}', '#stage .a:before,#stage .a:after,#stage .a:first-letter,#stage .a:first-line{}'],
        ['.a:hover, .a:first-child, .a:empty, .a:only-of-type {}', '#stage .a:hover,#stage .a:first-child,#stage .a:empty,#stage .a:only-of-type{}'],
        ['.\\31 a, #\\31 b, .a\\:b {}', '#stage .\\31 a,#stage #\\31 b,#stage .a\\:b{}']
      ]) {
        assert.equal(strict(given).css, expected, given);
      }
    });

    it('refuses the selectors a design cannot use, and keeps the others of the same rule', () => {
      for (const [text, pattern] of [
        ['.a:has(.b) {}', /:has\(\) is not allowed \(it can make the overlay slow\)/],
        [':host {}', /:host is not allowed/],
        [':host(.a) {}', /:host\(\) is not allowed/],
        ['.a::part(x) {}', /::part\(\) is not allowed/],
        ['.a::slotted(b) {}', /::slotted\(\) is not allowed/],
        ['a:visited {}', /:visited is not allowed \(the overlay has no links\)/],
        ['a:link {}', /:link is not allowed/],
        ['a:any-link {}', /:any-link is not allowed/],
        ['a:target {}', /:target is not allowed/],
        ['.a::backdrop {}', /::backdrop is not allowed/],
        ['.a:matches(.b) {}', /:matches\(\) is not allowed/],
        ['.a::before .b {}', /a pseudo-element such as ::before can only be at the end of a selector/],
        ['.a::before.b {}', /only a pseudo-class such as :hover can follow a pseudo-element/],
        [':is(.a::before) {}', /::before cannot be used inside :not\(\), :is\(\) or :where\(\)/],
        ['> .a {}', /a selector cannot start with >/],
        ['.a > {}', /a selector cannot end with >/],
        ['ns|a {}', /namespaces are not allowed/],
        ['[ns|a] {}', /namespaces are not allowed/],
        ['#1a {}', /#1a is not an id a selector can use/],
        ['.a, {}', /a selector is missing/],
        ['{ color: red }', /a \{ \} needs a selector before it/],
        ['.a;.b { color: red }', /";" is not allowed in a selector/]
      ]) {
        refuses(text, pattern);
        assert.doesNotThrow(() => assertSafe(written(text)), text);
      }
      assert.equal(written('.ok, body, .a:has(.b), .ok2 { color: red }'), '#stage .ok,#stage .ok2{color:red}');
      assert.equal(written('body, :host { color: red }'), '', 'a rule with no selector left is left out');
    });
  });

  describe('declarations', () => {
    it('refuses !important however it is written, and leaves the declaration without it', () => {
      for (const text of ['.a{display:block!important}', '.a{display:block ! important}', '.a{display:block !IMPORTANT}', '.a{display:block !/**/important}', '.a{display:block !\\69mportant}', '.a{--x: 1 !important}']) {
        refuses(text, /^Line 1: !important is not allowed \(it could show what the producer switched off\)\.$/);
        assert.match(written(text), /^#stage \.a\{(display:block|--x:1)\}$/, text);
      }
      for (const text of ['.a{display:block !ie}', '.a{color:var(--x, red !important)}', '.a{color:red !important !important}']) {
        refuses(text, /!/);
        assert.equal(written(text), '#stage .a{}', text);
      }
    });

    it('refuses a transition of display (allow-discrete), which would beat the !important that keeps a piece switched off', () => {
      for (const text of [
        '.a{transition:display 100000s step-end allow-discrete}', '.a{transition-behavior:allow-discrete}', '.a{TRANSITION:display 9s ALLOW-DISCRETE}',
        '.a{transition:display 9s allow\\-discrete}', '.a{transition:opacity 1s, display 9s allow-discrete}', '.a{--b:allow-discrete}', '.a{transition-behavior:var(--b, allow-discrete)}'
      ]) {
        refuses(text, /^Line 1: allow-discrete is not allowed \(it could show what the producer switched off\)\.$/);
        assert.equal(written(text), '#stage .a{}', text);
      }
      assert.equal(written('.a{transition:display 9s allow-discrete;opacity:.5}'), '#stage .a{opacity:.5}', 'the rest of the rule stays');
      assert.equal(strict('.a{transition:opacity .3s ease, transform 1s;transition-behavior:normal}').css, '#stage .a{transition:opacity .3s ease, transform 1s;transition-behavior:normal}', 'other transitions are fine');
      assert.throws(() => checkValue('allow-discrete'), /allow-discrete is not allowed/, 'nor in a color of a design');
    });

    it('refuses the properties that could run code, however they are written', () => {
      for (const text of ['.a{behavior:url(x.htc)}', '.a{BEHAVIOR:none}', '.a{beh\\61vior:none}', '.a{-moz-binding:none}']) {
        refuses(text, /(behavior|-moz-binding) is not allowed \(it could run code\)/);
        assert.equal(written(text), '#stage .a{}');
      }
    });

    it('takes any other property, custom properties too, and writes the names as CSS reads them', () => {
      assert.equal(written('.a { COLOR: Red; --My-Var: 1; \\63olor: blue; -webkit-line-clamp: 2 }'), '#stage .a{color:Red;--My-Var:1;color:blue;-webkit-line-clamp:2}');
    });

    it('refuses what is not a declaration, a value with nothing in it, and anything a value cannot hold', () => {
      for (const [text, pattern] of [
        ['.a { color red }', /this is not a declaration \(write it as property: value\)/],
        ['.a { color: }', /color has no value/],
        ['.a { color: red; .b { color: blue } }', /a rule inside another rule is not allowed \(write each rule on its own\)/],
        ['.a { & .b { color: blue } }', /a rule inside another rule is not allowed/],
        ['.a { @media screen { color: red } }', /a rule inside another rule is not allowed/],
        ['.a { color: (red) }', /\( \) is not allowed in a value/],
        ['.a { --x: { a: b } }', /\{ \} is not allowed in a value/],
        ['.a { color: a:b }', /":" is not allowed in a value/],
        ['.a { color: @x }', /@x is not allowed in a value/],
        ['.a { color: < }', /"<" is not allowed in a value/],
        ['.a { color: # }', /"#" is not allowed in a value/],
        ['.a { width: calc(1px; 2px) }', /";" is not allowed in a value/],
        ['.a { color: red) }', /there is a \) that closes nothing/],
        ['.a { content: attr(data-x url) }', /attr\(\) can only take the name of an attribute here, as attr\(data-name\)/],
        ['.a { color: attr(data-x) }', /attr\(\) is only allowed in content/],
        ['.a { color: var(red) }', /var\(\) needs the name of a custom property, as var\(--name\)/],
        ['.a { src: local(Arial) }', /local\(\) is only allowed in the src of @font-face/],
        ['.a { color: selector(a) }', /selector\(\) is only allowed after @supports/],
        ['.a { color: foo(1) }', /foo\(\) is not allowed \(it is not one of the functions a design can use\)/],
        ['.a { width: expression(alert(1)) }', /expression\(\) is not allowed/],
        ['.a { color: red <!-- }', /<!-- is not allowed \(a style sheet is not a web page\)/]
      ]) {
        refuses(text, pattern);
        assert.doesNotThrow(() => assertSafe(written(text)), text);
      }
    });

    it('keeps the values a design uses, with the functions it allows, including the -webkit- ones of older browsers', () => {
      const text = '.a { background: -webkit-linear-gradient(top, red, blue), repeating-conic-gradient(red 0 10%, blue 0 20%); width: -webkit-calc(100% - 2px); '
        + 'color: color-mix(in srgb, red 50%, light-dark(#fff, #000)); transform: matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1) skewX(2deg) perspective(100px); '
        + 'shape-outside: circle(50% at 50% 50%); offset-path: path("M 0 0 L 10 10"); counter-increment: x; content: counters(x, ".") " " attr(data-x, "none"); '
        + 'grid-template-columns: fit-content(40%) [a] minmax(0, 1fr); padding: env(safe-area-inset-top, 0px); rotate: atan2(1, 2); width: round(up, 10.5px, 1px) }';
      assert.equal(strict(text).dropped.length, 0);
      assert.doesNotThrow(() => assertSafe(written(text)));
    });
  });

  describe('url() and the design\'s own files', () => {
    it('knows which files a design can hold', () => {
      for (const ref of ['images/logoImage.png', 'images/spaceFrame3.jpg', 'images/css-glow.webp', 'images/css-a.svg', 'images/css-0-x.gif', 'fonts/font.woff2', 'fonts/names.ttf', 'fonts/text.otf']) {
        assert.equal(isOwnRef(ref), true, ref);
      }
      for (const ref of ['images/nonsense.png', 'images/css-A.png', 'images/css-.png', `images/css-${'a'.repeat(33)}.png`, 'images/logoImage.bmp', 'images/logoImage.png?x', 'images/logoImage.png#x',
        'images/../design.json', 'images/../../x.png', '/images/logoImage.png', './images/logoImage.png', 'images\\logoImage.png', 'fonts/display.woff2', 'fonts/font.exe',
        'sounds/damage.mp3', 'styles.css', 'design.json', 'https://e.x/a.png', '//e.x/a.png', 'data:image/png;base64,AAA', '', 5, null]) {
        assert.equal(isOwnRef(ref), false, String(ref));
      }
      assert.ok(THEME.isImageKey('css-glow') && THEME.isImageKey('logoImage') && !THEME.isImageKey('css-') && !THEME.isImageKey('__proto__') && !THEME.isImageKey(5));
    });

    it('writes one of the design\'s files as it is when it is not told where the files are', () => {
      assert.equal(strict('.a { background: url(images/css-glow.png) } .b { background: url( "fonts/font.woff2" ) }').css,
        '#stage .a{background:url("images/css-glow.png")}\n#stage .b{background:url("fonts/font.woff2")}');
      assert.equal(written('.a { background: url(images/css-gl\\6fw.png) }'), '#stage .a{background:url("images/css-glow.png")}', 'with its escapes decoded');
    });

    it('writes the address it is told for each file, escaped, and leaves out a declaration whose file the design does not have', () => {
      const asked = [];
      const resolve = (ref) => {
        asked.push(ref);
        return ref === 'images/css-glow.png' ? '/api/theme/assets/images/css-glow.png?v=12&design=A"\\B\n<C>' : null;
      };
      const text = '.a { color: red; background: url(images/css-glow.png) } .b { color: blue; background: url(images/css-gone.png) }';
      for (const options of [{ resolve }, { resolve, strict: true }]) {
        const { css, dropped } = sanitizeCss(text, options);
        assert.equal(css, '#stage .a{color:red;background:url("/api/theme/assets/images/css-glow.png?v=12&design=A%22%5CB%0A%3CC%3E")}\n#stage .b{color:blue}');
        assert.deepEqual(dropped, [], 'a file the design does not have is not a problem: it just does not show');
      }
      assert.deepEqual(asked, ['images/css-glow.png', 'images/css-gone.png', 'images/css-glow.png', 'images/css-gone.png']);
      assert.equal(written('.a { background: url(https://e.x) }', { resolve: () => assert.fail('only asked about the design\'s own files') }), '#stage .a{}');
    });

    it('refuses any other address, saying what it is', () => {
      for (const [text, pattern] of [
        ['.a { background: url(https://e.x/a) }', /a web address is not allowed in url\(\) \(a design can only use its own pictures and fonts, as url\(images\/css-name\.png\)\)/],
        ['.a { background: url(//e.x/a) }', /a web address is not allowed in url\(\)/],
        ['.a { background: url(\\\\\\\\e.x/a) }', /a web address is not allowed in url\(\)/], // (\\e.x: what a browser reads as //e.x)
        ['.a { background: url("data:image/png;base64,AAA") }', /a data: address is not allowed in url\(\)/],
        ['.a { background: url(/api/theme) }', /url\(\/api\/theme\) is not one of the design's files/],
        ['.a { background: url(images/../x.png) }', /url\(images\/\.\.\/x\.png\) is not one of the design's files/],
        ['.a { background: url(images/x.png more) }', /this url\(\) cannot be read/],
        ['.a { background: url("images/css-a.png" crossorigin) }', /url\(\) can only hold the name of one of the design's files/]
      ]) {
        refuses(text, pattern);
        assert.equal(written(text), '#stage .a{}', text);
      }
    });

    it('only takes the design\'s own fonts, and local ones, in the src of @font-face', () => {
      assert.equal(strict('@font-face { font-family: X; src: url(fonts/font.woff2) format("woff2") tech(variations), local("X Bold"), local(X) }').css,
        '@font-face{font-family:X;src:url("fonts/font.woff2") format("woff2") tech(variations), local("X Bold"), local(X)}');
      for (const text of ['@font-face { src: url(https://e.x/f.woff2) }', '@font-face { src: var(--f) }', '@font-face { src: format("woff2") }', '@font-face { src: local(X) format("woff2") }', '@font-face { src: url(fonts/font.woff2) rgb(1,2,3) }',
        '@font-face { src: url(images/logoImage.png) }', '@font-face { src: url("images/css-a.png") format("woff2") }']) {
        assert.throws(() => strict(text), CssError, text);
        assert.equal(written(text), '@font-face{}', text);
      }
    });
  });

  describe('at-rules', () => {
    it('refuses the ones a design cannot use, however they are written', () => {
      for (const [text, pattern] of [
        ['@import url(x.css);', /^Line 1: @import is not allowed \(a design can only use the files it carries\)\.$/],
        ['@import "x.css";', /@import is not allowed/],
        ['@IMPORT "x.css";', /@import is not allowed/],
        ['@\\69mport "x.css";', /@import is not allowed/],
        ['@namespace svg url(http://www.w3.org/2000/svg);', /@namespace is not allowed/],
        ['@charset "utf-8";', /@charset is not allowed \(a style sheet is always read as UTF-8\)/],
        ...['page', 'document', '-moz-document', 'counter-style', 'property', 'font-feature-values', 'scope', 'view-transition', 'font-palette-values'].map((name) => [`@${name} x { a: b }`, new RegExp(`@${name} is not allowed \\(a design can use @media, @supports, @layer, @keyframes, @font-face, @container and @starting-style\\)`)])
      ]) {
        refuses(text, pattern);
        assert.equal(written(text), '', text);
      }
    });

    it('checks what comes after them', () => {
      for (const [text, pattern] of [
        ['@media url(x) { .a {} }', /url\(\) is not allowed after @media \(only a condition such as \(max-width: 600px\) can be used\)/],
        ['@media "print" { .a {} }', /a string is not allowed after @media/],
        ['@media (min-width: calc(1px)) { .a {} }', /calc\(\) is not allowed after @media/],
        ['@supports (background: url(images/css-a.png)) { .a {} }', /url\(\) is not allowed/],
        ['@supports selector(:has(a)) { .a {} }', /:has\(\) is not allowed/],
        ['@container style(--x: 1) { .a {} }', /style\(\) is not allowed after @container/],
        ['@media screen;', /@media needs a \{ \} block after it/],
        ['@keyframes { from {} }', /@keyframes needs one name, as @keyframes glow/],
        ['@keyframes a b { from {} }', /@keyframes needs one name/],
        ['@keyframes a { from { opacity: 0 } @media x {} }', /@media is not allowed inside @keyframes \(it only holds keyframes\)/],
        ['@keyframes a { 50px { opacity: 0 } }', /a number is not a keyframe \(use from, to or a percentage, as 50%\)/],
        ['@layer "x";', /the name of a layer can only be letters, digits and dashes/],
        ['@layer a, b { .a {} }', /a block of @layer can only have one name/],
        ['@layer;', /@layer needs the name of a layer/],
        ['@font-face x { src: local(X) }', /nothing can go between @font-face and its \{/],
        ['@starting-style x { .a {} }', /nothing can go between @starting-style and its \{/]
      ]) {
        refuses(text, pattern);
        assert.doesNotThrow(() => assertSafe(written(text)), text);
      }
    });

    it('lets them go three deep inside each other, and no more', () => {
      refuses('@media a { @media b { @media c { @media d { .x { color: red } } } } }', /^Line 1: at-rules can only go 3 deep inside each other\.$/);
      assert.equal(written('@media a { @media b { @media c { @media d { .x { color: red } } .y { color: blue } } } }'), '@media a{\n@media b{\n@media c{\n#stage .y{color:blue}\n}\n}\n}');
    });
  });

  describe('what it is told, in plain words', () => {
    const sheet = [
      '.a { color: red }', // 1
      '/* a comment', // 2
      '   over lines */ @import "x.css";', // 3
      '.b {', // 4
      '  color: blue;', // 5
      '}', // 6
      '.c {', // 7
      '  background: url(https://e.x/c.png);', // 8
      '}', // 9
      '', // 10
      '.d {', // 11
      '  display: block !important;', // 12
      '}' // 13
    ];

    it('says on which line the first problem is', () => {
      assert.throws(() => strict(sheet.join('\n')), { message: 'Line 3: @import is not allowed (a design can only use the files it carries).' });
      assert.throws(() => strict(sheet.slice(3).join('\n')), { message: 'Line 5: a web address is not allowed in url() (a design can only use its own pictures and fonts, as url(images/css-name.png)).' });
      assert.throws(() => strict(sheet.join('\r\n').replace('@import "x.css";', '')), { message: 'Line 8: a web address is not allowed in url() (a design can only use its own pictures and fonts, as url(images/css-name.png)).' });
      assert.throws(() => strict(sheet.slice(9).join('\n')), { message: 'Line 3: !important is not allowed (it could show what the producer switched off).' });
      const later = `${'\n'.repeat(19)}.e { background: image-set("x.png" 1x) }`;
      assert.throws(() => strict(later), { message: 'Line 20: image-set() is not allowed (a design can only use its own pictures and fonts, as url(images/css-name.png)).' });
      assert.throws(() => strict('\n\n\nbody { background: #000 }'), { message: 'Line 4: rules for body are not allowed (the overlay\'s page must stay see-through).' });
      const error = (() => { try { strict('\n.a { color: red ! important }'); } catch (caught) { return caught; } return null; })();
      assert.ok(error instanceof CssError && error instanceof Error);
      assert.equal(error.line, 2);
      assert.equal(error.reason, '!important is not allowed (it could show what the producer switched off)');
    });

    it('without strict, lists what it left out and on which line, and goes on', () => {
      const { css, dropped } = lenient(sheet.join('\n'));
      assert.equal(css, '#stage .a{color:red}\n#stage .b{color:blue}\n#stage .c{}\n#stage .d{display:block}');
      assert.deepEqual(dropped, [
        { line: 3, reason: '@import is not allowed (a design can only use the files it carries)' },
        { line: 8, reason: 'a web address is not allowed in url() (a design can only use its own pictures and fonts, as url(images/css-name.png))' },
        { line: 12, reason: '!important is not allowed (it could show what the producer switched off)' }
      ]);
    });

    it('says when something is not closed at the end', () => {
      refuses('.a { color: red', /^Line 1: a \{ is not closed \(add the \} that ends it\)\.$/);
      refuses('.a { color: rgb(1, 2, 3 }', /a \( is not closed \(add the \) that ends it\)/);
      refuses('.a [data-x { color: red }', /a \[ is not closed/);
      refuses('@layer x;\n.a::before { content: "abc', /^Line 2: a \{ is not closed/);
      refuses('.a { color: red }\n/* the end', /^Line 2: a comment is not closed \(add the \*\/ that ends it\)\.$/);
      refuses('.a::before { content: "abc\n}', /^Line 1: a string goes on past the end of its line \(end it with a quote before the line ends\)\.$/);
      refuses('} .a { color: red }', /there is a \} that closes nothing/);
      for (const text of ['.a { color: red', '.a{color:rgb(1, 2, 3 }', '.a::before { content: "abc', '.a { color: red }\n/* the end', '.b { background: url(images/css-a.png']) {
        assert.doesNotThrow(() => assertSafe(written(text)), text);
      }
    });
  });

  describe('what it is given', () => {
    it('takes up to 256 KB, counted as UTF-8 bytes', () => {
      assert.equal(THEME.CSS_MAX_BYTES, 256 * 1024);
      const fits = `.a{content:"${'é'.repeat((256 * 1024 - 20) / 2)}"}`;
      assert.ok(Buffer.byteLength(fits) <= 256 * 1024);
      assert.equal(strict(fits).dropped.length, 0);
      const over = `.a{content:"${'é'.repeat(256 * 1024 / 2)}"}`;
      assert.throws(() => strict(over), { message: 'The style sheet is too large (256 KB at most).' });
      assert.deepEqual(lenient(over), { css: '', dropped: [{ line: null, reason: 'the style sheet is too large (256 KB at most)' }] });
    });

    it('refuses NUL and other control characters, but not tabs and line ends', () => {
      for (const c of ['\u0000', '\u0001', '\u0008', '\u000b', '\u001f', '\u007f', '\u0085']) {
        refuses(`.a{color:red}\n.b{color:${c}blue}`, /^Line 2: a control character is not allowed \(a style sheet is plain text\)\.$/);
        assert.doesNotThrow(() => assertSafe(written(`.a{color:red}${c}.b{background:url(//e.x)}`)));
      }
      assert.equal(strict('.a{\tcolor:\fred;\r\n}\r').css, '#stage .a{color:red}');
    });

    it('drops a byte order mark, and takes nothing but text', () => {
      assert.equal(strict('\uFEFF.a{color:red}').css, '#stage .a{color:red}');
      assert.throws(() => strict(Buffer.from('.a{}')), { message: 'The style sheet must be text.' });
      assert.deepEqual(lenient(undefined), { css: '', dropped: [{ line: null, reason: 'the style sheet must be text' }] });
      assert.deepEqual(lenient(''), { css: '', dropped: [] });
    });

    it('takes at most 10000 rules and declarations', () => {
      assert.equal(CSS.MAX_ITEMS, 10000);
      const rules = (n) => '.a{}\n'.repeat(n);
      assert.equal(strict(rules(10000)).css.split('\n').length, 10000);
      assert.throws(() => strict(rules(10001)), { message: 'Line 10001: a style sheet can have at most 10000 rules and declarations.' });
      const { css, dropped } = lenient(rules(10050));
      assert.equal(css.split('\n').length, 10000);
      assert.deepEqual(dropped, [{ line: 10001, reason: 'a style sheet can have at most 10000 rules and declarations: the rest was left out' }]);
      assert.throws(() => strict(`.a{${'color:red;'.repeat(10000)}}`), /at most 10000 rules and declarations/);
    });

    it('is not thrown off by brackets or selectors that go very deep, or by a very long text', () => {
      for (const text of [
        `.a{width:${'('.repeat(200000)}`, `.a{width:${'calc('.repeat(40000)}1px${')'.repeat(40000)}}`, `${'['.repeat(200000)}`, `${'{'.repeat(200000)}`,
        `${':not('.repeat(40000)}.a${')'.repeat(40000)}{}`, `@media a{${'@media a{'.repeat(20000)}`, `.a{${'a:b;'.repeat(60000)}}`
      ]) {
        assert.doesNotThrow(() => assertSafe(written(text.slice(0, 256 * 1024))), text.slice(0, 20));
        assert.throws(() => strict(text.slice(0, 256 * 1024)), CssError, text.slice(0, 20));
      }
      const many = `${'.a,'.repeat(60000)}.a{}`;
      assert.equal(strict(many).css.split(',').length, 60001, 'a long list of selectors is one rule');
      assert.doesNotThrow(() => assertSafe(written(many)));
      refuses(`.a{width:${'calc('.repeat(30)}1px${')'.repeat(30)}}`, /brackets and functions can only go 24 deep inside each other/);
      assert.equal(strict(`.a{width:${'calc('.repeat(20)}1px${')'.repeat(20)}}`).dropped.length, 0);
    });
  });

  describe('how it is written', () => {
    it('writes a rule a line, with no comments and no more white space than it needs', () => {
      assert.equal(written('/* x */ .a  >  .b   .c { color :  red  ; margin : 0   auto ; }\n\n\n.d{}'), '#stage .a>.b .c{color:red;margin:0 auto}\n#stage .d{}');
    });

    it('writes strings and names again, so that a browser reads them as they were meant, and "</style" can never be in it', () => {
      assert.equal(written('.a::before { content: \'a"b\\\\c\\A d\' }'), '#stage .a::before{content:"a\\"b\\\\c\\a d"}');
      assert.equal(written('.a::before { content: "</style>" } .b::before { content: "\\3c/style>" } .\\3c x {}'), '#stage .a::before{content:"\\3c /style\\3e "}\n#stage .b::before{content:"\\3c /style\\3e "}\n#stage .\\3c x{}');
      assert.equal(written('@media (a</style>) { .a {} }'), '@media (a< /style>){\n#stage .a{}\n}');
      assert.equal(written('.a { --x: \\31 0px; --y: 1\\65 3px; --z: -\\31; --w: \\- }'), '#stage .a{--x:\\31 0px;--y:1\\65 3px;--z:-\\31 ;--w:\\-}');
      assert.equal(written('.a { --x: a/**/b; --y: 1/**/px; --z: -/**/1; --w: //**/*; --v: a/**/-b }'), '#stage .a{--x:a/**/b;--y:1/**/px;--z:-/**/1;--w://**/*;--v:a/**/-b}', 'tokens that would run together are kept apart');
    });

    it('never writes "-->" for a name that is "--" with a ">" after it, so what it writes reads as the same rule again', () => {
      for (const [text, out] of [
        ['.-- > .t{color:red}', '#stage .-\\->.t{color:red}'],
        ['.--/**/>.t{color:red}', '#stage .-\\->.t{color:red}'],
        ['\\-->.t{color:red}', '#stage -\\->.t{color:red}'],
        ['-\\->.t{color:red}', '#stage -\\->.t{color:red}'],
        ['.t:not(.-- > .t){color:blue}', '#stage .t:not(.-\\->.t){color:blue}'],
        ['@media (--/**/>5){.t{color:red}}', '@media (-\\->5){\n#stage .t{color:red}\n}']
      ]) {
        const once = strict(text).css;
        assert.equal(once, out, text);
        assert.doesNotMatch(once, /-->/, text);
        assert.equal(strict(once).css, once, `${text}: written the same again`);
        assert.deepEqual(plainTokens(strict(once).css), plainTokens(once));
      }
      assert.ok(tokenize('#stage .-\\->.t').some((token) => token.type === 'ident' && token.value === '--'), 'and "-\\-" is still the name "--"');
      assert.equal(written('.a{width:1--}'), '#stage .a{width:1-\\-}', 'a unit too');
    });
  });

  describe('one value: a color of a design', () => {
    it('takes colors, sizes, gradients and the like, as they are', () => {
      for (const value of ['#ff4d6d', 'rgba(10, 14, 24, 0.82)', '14px', '0.18s ease', 'linear-gradient(90deg, red, blue)', 'var(--accent)', 'calc(1px + 2px)', 'Impact, "Arial Black", sans-serif', 'oklch(70% 0.1 200 / .5)']) {
        assert.equal(checkValue(value), value, value);
      }
    });

    it('refuses anything that could point at a picture or a web address, and anything else a value cannot hold', () => {
      for (const [value, pattern] of [
        ['url(https://x)', /url\(\) is not allowed here \(a color or a size cannot point at a picture or a web address\)/],
        ['url(images/logoImage.png)', /url\(\) is not allowed here/],
        ['url("//x")', /url\(\) is not allowed here/],
        ['\\75 rl(//x)', /url\(\) is not allowed here/],
        ['image-set("https://x" 1x)', /image-set\(\) is not allowed/],
        ['-webkit-image-set(url(//x) 1x)', /-webkit-image-set\(\) is not allowed/],
        ['linear-gradient(red, blue), url(//x/b)', /url\(\) is not allowed here/],
        ['var(--a, url(//x))', /url\(\) is not allowed here/],
        ['cross-fade(red, blue)', /cross-fade\(\) is not allowed/],
        ['red !important', /!important is not allowed/],
        ['red; color: blue', /";" is not allowed in a value/],
        ['red /* x', /a comment is not closed/],
        ['attr(x)', /attr\(\) is only allowed in content/]
      ]) {
        assert.throws(() => checkValue(value), (error) => error instanceof CssError && pattern.test(error.message), value);
        assert.equal(checkValue(value, { strict: false }), null, value);
      }
    });

    it('closes the gap: a design\'s colors can no longer point at a web address', () => {
      for (const value of ['url(https://evil.example/x.png)', 'image-set("https://evil.example/x.png" 1x)', '-webkit-image-set(url(//evil.example/a) 1x)', 'linear-gradient(red,blue), url(//evil.example/b)', 'url(data:image/png;base64,AAA)']) {
        assert.throws(() => RULES.sanitizeColors({ '--bg-panel': value }), (error) => error instanceof RULES.RuleError && /^Invalid value for --bg-panel\b/.test(error.message), value);
      }
      assert.throws(() => RULES.sanitizeColors({ '--bg-panel': 'url(https://evil.example/x.png)' }), { message: 'Invalid value for --bg-panel: url() is not allowed here (a color or a size cannot point at a picture or a web address)' });
      assert.deepEqual(RULES.sanitizeColors({ '--bg-panel': ' linear-gradient(180deg, rgba(0,0,0,.8), transparent) ', '--radius': '12px' }),
        { '--bg-panel': 'linear-gradient(180deg, rgba(0,0,0,.8), transparent)', '--radius': '12px' });
    });
  });
});
