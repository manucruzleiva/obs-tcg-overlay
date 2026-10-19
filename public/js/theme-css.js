/**
 * The style sheet of a design (styles.css): what it may hold, in one place for the server (which refuses a style sheet with something
 * not allowed in it, and cleans one that was written by hand) and the design editor (which shows the same complaint while someone
 * types, and previews the cleaned one). Loaded in the browser as OTO_THEME_CSS.
 *
 * A style sheet can restyle and animate anything on the overlay's stage, and nothing else: it cannot load anything but the design's own
 * pictures and fonts, cannot paint the page around the stage (OBS needs it see-through), and cannot use !important or a transition of
 * display (allow-discrete), either of which could show what the producer switched off.
 *
 * It is read the way a browser reads CSS (CSS Syntax Level 3): escapes are decoded, comments are dropped, url(...) and strings are read
 * as browsers read them, so a name written with an escape, or cut in two by a comment, is seen for what it is. What comes out is written
 * again from what was read, never copied from the text, so nothing a browser could read in another way gets through:
 *
 *   sanitizeCss(text, { strict, resolve }) -> { css, dropped: [{ line, reason }] }
 *     strict: a CssError ("Line 12: ...") at the first problem; otherwise the smallest part that is bad (a declaration, a selector, a
 *       rule, an at-rule) is left out, and what was left out is listed in `dropped`.
 *     resolve(ref): the address to write for one of the design's own files ("images/css-texture.png"), or null to leave the
 *       declaration out (the design does not have that file). Without it, the file is written as it is: url("images/css-texture.png").
 *   checkValue(text, { strict }) -> the value as it is, when it is fine for one property (no url() at all); otherwise a CssError, or
 *     null without `strict`
 *   isOwnRef(ref) -> whether a url() names one of the files a design can hold (images/<slot>.<ext>, fonts/font.<ext>, fonts/<group>.<ext>)
 *   heldFile(ref, held) -> the file among those a design holds that a url() names, whatever its ending (or null)
 *
 * Every rule is put on the stage: ".logo" is written "#stage .logo", and a rule that starts with :root or html (which can carry the
 * classes OTO puts on the page: ":root.has-logo .logo") is written ":root.has-logo #stage .logo". A rule for :root or html alone can
 * only set custom properties (--name: value). The text is kept to what older browsers understand (no lookbehind, no \p{...}).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./theme-options'));
  else root.OTO_THEME_CSS = factory(root.OTO_THEME);
}(typeof self !== 'undefined' ? self : this, function (THEME) {
  const MAX_BYTES = THEME.CSS_MAX_BYTES;
  const MAX_ITEMS = 10000; // rules and declarations, in all
  const MAX_AT_DEPTH = 3; // at-rules inside each other
  const MAX_DEPTH = 24; // brackets and functions inside each other

  const OWN_FILES = 'a design can only use its own pictures and fonts, as url(images/css-name.png)';
  const SEE_THROUGH = "the overlay's page must stay see-through";

  // What a design can use, and what it cannot
  const AT_RULES = ['media', 'supports', 'layer', 'keyframes', '-webkit-keyframes', 'font-face', 'container', 'starting-style'];
  const CONDITIONS = ['media', 'supports', 'container']; // at-rules whose prelude is a condition, with rules inside
  const GRADIENTS = ['linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient'];
  const MATH = ['calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log', 'exp'];
  const FUNCTIONS = [].concat(
    ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark'], // colors
    MATH,
    ['var', 'env'],
    GRADIENTS,
    ['matrix', 'matrix3d', 'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale', 'scalex', 'scaley', 'scalez', 'scale3d',
      'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx', 'skewy', 'perspective'], // transforms
    ['blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia'], // filters
    ['cubic-bezier', 'steps', 'linear'], // easing
    ['inset', 'circle', 'ellipse', 'polygon', 'path', 'rect', 'xywh'], // shapes
    ['repeat', 'minmax', 'fit-content'], // grid
    ['counter', 'counters']
  );
  // the ones older browsers knew with -webkit- in front
  const WEBKIT = [].concat(GRADIENTS, ['calc']);
  const FONT_SOURCE = ['format', 'tech', 'local']; // only in the src of @font-face
  // functions that load a picture (or run something) without url(): never
  const LOADERS = ['image-set', 'cross-fade', 'image', 'element', '-moz-element', 'paint', 'src'];
  const VALUE_DELIMS = ['/', '*', '+', '-'];

  const PSEUDO_ELEMENTS = ['before', 'after', 'first-letter', 'first-line', 'marker', 'selection', 'placeholder'];
  const LEGACY_PSEUDO_ELEMENTS = ['before', 'after', 'first-letter', 'first-line']; // also written with one colon
  const SELECTOR_PSEUDO = ['not', 'is', 'where'];
  const NTH_PSEUDO = ['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type'];
  const NO_LINKS = 'the overlay has no links';
  const REFUSED_PSEUDO = {
    has: 'it can make the overlay slow',
    host: 'it is not something the overlay has',
    'host-context': 'it is not something the overlay has',
    visited: NO_LINKS,
    link: NO_LINKS,
    'any-link': NO_LINKS,
    '-webkit-any-link': NO_LINKS,
    'local-link': NO_LINKS,
    target: NO_LINKS,
    'target-within': NO_LINKS
  };
  const REFUSED_TYPES = ['body', 'head', 'style', 'script', 'link', 'meta', 'title', 'iframe'];

  // The files a design can hold, as a url() names them
  const EXTRA_FONT_ROLES = THEME.FONT_ROLE_KEYS.filter((role) => role !== 'display');
  const OWN_IMAGE = /^images\/([A-Za-z0-9-]+)\.(png|jpg|gif|webp|svg)$/;
  const OWN_FONT = /^fonts\/([a-z]+)\.(woff2|woff|ttf|otf)$/;
  function isOwnRef(ref) {
    if (typeof ref !== 'string') return false;
    const image = OWN_IMAGE.exec(ref);
    if (image) return THEME.isImageKey(image[1]);
    const font = OWN_FONT.exec(ref);
    return Boolean(font) && (font[1] === 'font' || EXTRA_FONT_ROLES.indexOf(font[1]) !== -1);
  }

  // The file a design holds that url(ref) names (`held`: the files it holds, "images/css-glow.jpg"...), or null. A file is found by its
  // folder and name whatever the ending it is written with: OTO keeps each file under the type it really is (a picture named .png that
  // is a JPEG is images/css-glow.jpg), and a style sheet names it as it was named in the package or the folder.
  function heldFile(ref, held) {
    if (!isOwnRef(ref) || !Array.isArray(held)) return null;
    if (held.indexOf(ref) !== -1) return ref;
    const base = ref.slice(0, ref.lastIndexOf('.') + 1); // "images/css-glow."
    for (const file of held) {
      if (typeof file === 'string' && file.indexOf(base) === 0 && file.indexOf('.', base.length) === -1 && file.indexOf('/', base.length) === -1) return file;
    }
    return null;
  }

  // A complaint that can be shown to a person as it is: "Line 12: @import is not allowed (...)." (`line` is null for the whole file)
  class CssError extends Error {
    constructor(line, reason) {
      super(line ? `Line ${line}: ${reason}.` : `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`);
      this.line = line || null;
      this.reason = reason;
    }
  }

  // ------------------------------------------------------------------------------------- characters

  const isDigit = (c) => c >= 0x30 && c <= 0x39;
  const isHex = (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
  const isLetter = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  const isNameStart = (c) => isLetter(c) || c === 0x5f || c >= 0x80;
  const isNameChar = (c) => isNameStart(c) || isDigit(c) || c === 0x2d;
  const isSpace = (c) => c === 0x0a || c === 0x09 || c === 0x20;
  const isNonPrintable = (c) => (c >= 0 && c <= 8) || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;
  const isControl = (c) => (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d) || (c >= 0x7f && c <= 0x9f);
  // CSS compares its names in ASCII only (so a letter of another alphabet never turns into an ASCII one)
  const lower = (text) => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  // A bit of the style sheet, short enough to quote in a message
  const shown = (text) => {
    const plain = String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    return plain.length > 40 ? `${plain.slice(0, 40)}...` : plain;
  };

  function byteLength(text) {
    if (text.length > MAX_BYTES) return text.length; // already too many (each character is at least one byte)
    let bytes = 0;
    for (let k = 0; k < text.length; k++) {
      const c = text.charCodeAt(k);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && k + 1 < text.length && text.charCodeAt(k + 1) >= 0xdc00 && text.charCodeAt(k + 1) <= 0xdfff) { bytes += 4; k++; }
      else bytes += 3;
    }
    return bytes;
  }

  // Line ends become "\n" (as CSS reads them), and half of a pair of UTF-16 characters becomes U+FFFD. A control character is a
  // problem: `problem(line, reason)` says so (and the character becomes U+FFFD if it goes on).
  function preprocess(input, problem) {
    let text = '';
    let from = 0;
    let line = 1;
    for (let k = 0; k < input.length; k++) {
      const c = input.charCodeAt(k);
      let swap = null;
      if (c === 0x0a) line++;
      else if (c === 0x0d || c === 0x0c) {
        swap = '\n';
        if (c === 0x0d && input.charCodeAt(k + 1) === 0x0a) { text += `${input.slice(from, k)}\n`; k++; from = k + 1; line++; continue; }
        line++;
      } else if (isControl(c)) {
        problem(line, 'a control character is not allowed (a style sheet is plain text)');
        swap = '�';
      } else if (c >= 0xd800 && c <= 0xdbff) {
        const next = input.charCodeAt(k + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { k++; continue; }
        swap = '�';
      } else if (c >= 0xdc00 && c <= 0xdfff) swap = '�';
      if (swap !== null) { text += input.slice(from, k) + swap; from = k + 1; }
    }
    return text + input.slice(from);
  }

  // ------------------------------------------------------------------------------------- reading tokens

  // The text (preprocessed) -> { tokens, comments }: tokens as CSS Syntax Level 3 defines them, each with the line it starts on;
  // `comments` lists a comment that is not closed. Token types: ident, function, at (an at-keyword), hash (`id` when it is a name),
  // string, bad-string, url, bad-url, delim, number, percentage, dimension (numbers keep the text they were written with), ws,
  // cdo (<!--), cdc (-->), and : ; , ( ) [ ] { } for themselves. A string or url() that the end of the text closed is `unclosed`.
  function readTokens(s) {
    const n = s.length;
    const tokens = [];
    const comments = [];
    let i = 0;
    let line = 1;
    let counted = 0;
    const lineOf = (position) => {
      for (; counted < position; counted++) if (s.charCodeAt(counted) === 0x0a) line++;
      return line;
    };
    const at = (k) => s.charCodeAt(i + k); // NaN past the end
    const isEscape = (a, b) => a === 0x5c && b !== 0x0a;
    const startsName = (a, b, c) => {
      if (a === 0x2d) return isNameStart(b) || b === 0x2d || isEscape(b, c);
      if (isNameStart(a)) return true;
      return isEscape(a, b);
    };
    const startsNumber = (a, b, c) => {
      if (a === 0x2b || a === 0x2d) return isDigit(b) || (b === 0x2e && isDigit(c));
      if (a === 0x2e) return isDigit(b);
      return isDigit(a);
    };

    // after a backslash
    function escaped() {
      if (isHex(at(0))) {
        let hex = '';
        while (hex.length < 6 && isHex(at(0))) { hex += s[i]; i++; }
        if (isSpace(at(0))) i++;
        const code = parseInt(hex, 16);
        return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? '�' : String.fromCodePoint(code);
      }
      if (i >= n) return '�';
      i++;
      return s[i - 1];
    }

    function name() {
      let out = '';
      for (;;) {
        if (isNameChar(at(0))) {
          let j = i + 1;
          while (j < n && isNameChar(s.charCodeAt(j))) j++;
          out += s.slice(i, j);
          i = j;
        } else if (isEscape(at(0), at(1))) {
          i++;
          out += escaped();
        } else return out;
      }
    }

    function numeric() {
      const from = i;
      if (at(0) === 0x2b || at(0) === 0x2d) i++;
      while (isDigit(at(0))) i++;
      if (at(0) === 0x2e && isDigit(at(1))) { i += 2; while (isDigit(at(0))) i++; }
      if ((at(0) === 0x45 || at(0) === 0x65) && (isDigit(at(1)) || ((at(1) === 0x2b || at(1) === 0x2d) && isDigit(at(2))))) {
        i += isDigit(at(1)) ? 2 : 3;
        while (isDigit(at(0))) i++;
      }
      const repr = s.slice(from, i);
      if (startsName(at(0), at(1), at(2))) return { type: 'dimension', repr, unit: name() };
      if (at(0) === 0x25) { i++; return { type: 'percentage', repr }; }
      return { type: 'number', repr };
    }

    // after the opening quote
    function string(quote) {
      let out = '';
      for (;;) {
        if (i >= n) return { type: 'string', value: out, unclosed: true };
        const c = at(0);
        if (c === quote) { i++; return { type: 'string', value: out }; }
        if (c === 0x0a) return { type: 'bad-string' }; // (the line end is read again, as space)
        if (c === 0x5c) {
          if (i + 1 >= n) { i++; continue; }
          if (at(1) === 0x0a) { i += 2; continue; }
          i++;
          out += escaped();
          continue;
        }
        let j = i + 1;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === quote || d === 0x0a || d === 0x5c) break;
          j++;
        }
        out += s.slice(i, j);
        i = j;
      }
    }

    function badUrlRemnants() {
      while (i < n) {
        if (at(0) === 0x29) { i++; return; }
        if (isEscape(at(0), at(1))) { i++; escaped(); } else i++;
      }
    }

    // after "url(" and the spaces that follow it, when no quote follows
    function url() {
      let out = '';
      while (isSpace(at(0))) i++;
      for (;;) {
        if (i >= n) return { type: 'url', value: out, unclosed: true };
        const c = at(0);
        if (c === 0x29) { i++; return { type: 'url', value: out }; }
        if (isSpace(c)) {
          while (isSpace(at(0))) i++;
          if (i >= n) return { type: 'url', value: out, unclosed: true };
          if (at(0) === 0x29) { i++; return { type: 'url', value: out }; }
          badUrlRemnants();
          return { type: 'bad-url' };
        }
        if (c === 0x22 || c === 0x27 || c === 0x28 || isNonPrintable(c)) { i++; badUrlRemnants(); return { type: 'bad-url' }; }
        if (c === 0x5c) {
          if (isEscape(c, at(1))) { i++; out += escaped(); continue; }
          i++;
          badUrlRemnants();
          return { type: 'bad-url' };
        }
        out += s[i];
        i++;
      }
    }

    function identLike() {
      const value = name();
      if (lower(value) === 'url' && at(0) === 0x28) {
        i++;
        while (isSpace(at(0)) && isSpace(at(1))) i++;
        const quote = (c) => c === 0x22 || c === 0x27;
        if (quote(at(0)) || (isSpace(at(0)) && quote(at(1)))) return { type: 'function', value };
        return url();
      }
      if (at(0) === 0x28) { i++; return { type: 'function', value }; }
      return { type: 'ident', value };
    }

    while (i < n) {
      if (at(0) === 0x2f && at(1) === 0x2a) {
        const end = s.indexOf('*/', i + 2);
        if (end === -1) {
          comments.push({ line: lineOf(i), reason: 'a comment is not closed (add the */ that ends it)' });
          break;
        }
        i = end + 2;
        continue;
      }
      const start = i;
      const c = at(0);
      let token;
      if (isSpace(c)) {
        while (isSpace(at(0))) i++;
        token = { type: 'ws' };
      } else if (c === 0x22 || c === 0x27) {
        i++;
        token = string(c);
      } else if (c === 0x23) {
        i++;
        if (isNameChar(at(0)) || isEscape(at(0), at(1))) {
          const id = startsName(at(0), at(1), at(2));
          token = { type: 'hash', value: name(), id };
        } else token = { type: 'delim', value: '#' };
      } else if ('()[]{},:;'.indexOf(s[i]) !== -1) {
        i++;
        token = { type: s[i - 1] };
      } else if (c === 0x2b || c === 0x2e) {
        if (startsNumber(c, at(1), at(2))) token = numeric();
        else { i++; token = { type: 'delim', value: s[i - 1] }; }
      } else if (c === 0x2d) {
        if (startsNumber(c, at(1), at(2))) token = numeric();
        else if (at(1) === 0x2d && at(2) === 0x3e) { i += 3; token = { type: 'cdc' }; }
        else if (startsName(c, at(1), at(2))) token = identLike();
        else { i++; token = { type: 'delim', value: '-' }; }
      } else if (c === 0x3c) {
        if (at(1) === 0x21 && at(2) === 0x2d && at(3) === 0x2d) { i += 4; token = { type: 'cdo' }; }
        else { i++; token = { type: 'delim', value: '<' }; }
      } else if (c === 0x40) {
        i++;
        if (startsName(at(0), at(1), at(2))) token = { type: 'at', value: name() };
        else token = { type: 'delim', value: '@' };
      } else if (c === 0x5c) {
        if (isEscape(c, at(1))) token = identLike();
        else { i++; token = { type: 'delim', value: '\\' }; }
      } else if (isDigit(c)) {
        token = numeric();
      } else if (isNameStart(c)) {
        token = identLike();
      } else {
        i++;
        token = { type: 'delim', value: s[i - 1] };
      }
      token.line = lineOf(start);
      tokens.push(token);
    }
    return { tokens, comments };
  }

  // Tokens -> component values: the tokens, with each ( ), [ ], { } and function holding what is inside it:
  // { type: 'block', open: '(' | '[' | '{', items, line } and { type: 'function', name, items, line }. One that the end of the text
  // closes is `unclosed`; one too far inside others is `deep` (what is inside it is not kept: it is refused anyway).
  const CLOSER = { '(': ')', '[': ']', '{': '}' };
  function readComponents(tokens) {
    const top = { items: [] };
    const stack = [top];
    for (const token of tokens) {
      const current = stack[stack.length - 1];
      const type = token.type;
      if (type === '(' || type === '[' || type === '{' || type === 'function') {
        const close = type === 'function' ? ')' : CLOSER[type];
        if (current.deep) { stack.push({ deep: true, close, marker: true }); continue; }
        const node = type === 'function'
          ? { type: 'function', name: token.value, items: [], line: token.line, close }
          : { type: 'block', open: type, items: [], line: token.line, close };
        if (stack.length > MAX_DEPTH) node.deep = true;
        current.items.push(node);
        stack.push(node);
      } else if (stack.length > 1 && type === current.close) {
        stack.pop();
      } else if (!current.deep) {
        current.items.push(token);
      }
    }
    for (let k = 1; k < stack.length; k++) if (!stack[k].marker) stack[k].unclosed = true;
    return top.items;
  }

  // ------------------------------------------------------------------------------------- writing

  // An identifier as CSS writes it, with escapes where it needs them (< and > are always escaped, so "</style" can never appear)
  function writeName(value, asIdent) {
    let out = '';
    for (let k = 0; k < value.length; k++) {
      const c = value.charCodeAt(k);
      if (c === 0) out += '�';
      else if ((c >= 1 && c <= 0x1f) || c === 0x7f || c === 0x3c || c === 0x3e
        || (asIdent && k === 0 && isDigit(c)) || (asIdent && k === 1 && isDigit(c) && value.charCodeAt(0) === 0x2d)) out += `\\${c.toString(16)} `;
      else if (asIdent && k === 0 && c === 0x2d && value.length === 1) out += '\\-';
      // (the name "--" is written "-\-": with a ">" after it, "-->" would be read as the end of an HTML comment)
      else if (asIdent && k === 1 && c === 0x2d && value.length === 2 && value.charCodeAt(0) === 0x2d) out += '\\-';
      else if (c >= 0x80 || c === 0x2d || c === 0x5f || isDigit(c) || isLetter(c)) out += value[k];
      else out += `\\${value[k]}`;
    }
    return out;
  }
  const writeIdent = (value) => writeName(value, true);
  // the unit of a dimension: an "e" and a digit right after a number would read as an exponent
  const writeUnit = (unit) => (/^[eE]([0-9]|[+-][0-9])/.test(unit) ? `\\${unit.charCodeAt(0).toString(16)} ${writeName(unit.slice(1), false)}` : writeIdent(unit));
  function writeString(value) {
    let out = '"';
    for (let k = 0; k < value.length; k++) {
      const c = value.charCodeAt(k);
      if (c === 0) out += '�';
      else if ((c >= 1 && c <= 0x1f) || c === 0x7f || c === 0x3c || c === 0x3e) out += `\\${c.toString(16)} `;
      else if (c === 0x22 || c === 0x5c) out += `\\${value[k]}`;
      else out += value[k];
    }
    return `${out}"`;
  }
  // an address in url(), quoted and escaped the way the overlay writes its own (overlay.js cssUrl)
  const writeUrl = (address) => `url("${address.replace(/["\\\n\r<>\u0000-\u001f\u007f]/g, (c) => encodeURIComponent(c))}")`;

  // Two tokens written one after the other can run together into another token ("a" "b" -> "ab", "1" "px" -> "1px", "/" "*" -> a
  // comment): `kind` is the last token written, `next` the text that follows. Then an empty comment goes between them (or a space
  // after "<", so that "</" never appears).
  function separator(kind, next) {
    const a = next.charCodeAt(0);
    const b = next.charCodeAt(1);
    const continues = isNameChar(a) || a === 0x5c;
    let merges;
    switch (kind) {
      case 'ident': merges = continues || a === 0x28; break;
      case 'at': case 'hash': case 'dimension': merges = continues; break;
      // (a number goes on into a unit, a % or more digits; "1" "-2" stays two numbers, as in unicode-range: U+0000-00FF)
      case 'number': merges = (a === 0x2d ? isNameStart(b) || b === 0x2d || b === 0x5c : continues) || a === 0x25 || a === 0x2e; break;
      case '-': merges = continues || a === 0x2e; break;
      case '.': merges = isDigit(a); break;
      case '+': merges = isDigit(a) || a === 0x2e; break;
      case '/': merges = a === 0x2a; break;
      case '<': return a === 0x21 || a === 0x2f ? ' ' : '';
      default: merges = false;
    }
    return merges ? '/**/' : '';
  }

  const SPACE = { space: true };
  const piece = (text, kind) => ({ text, kind });
  function join(pieces) {
    let out = '';
    let last = null;
    let space = false;
    for (const part of pieces) {
      if (part === SPACE) { space = true; continue; }
      if (last !== null) out += space ? ' ' : separator(last, part.text);
      out += part.text;
      last = part.kind;
      space = false;
    }
    return out;
  }
  const tokenPiece = (token) => {
    switch (token.type) {
      case 'ident': return piece(writeIdent(token.value), 'ident');
      case 'number': return piece(token.repr, 'number');
      case 'percentage': return piece(`${token.repr}%`, 'percentage');
      case 'dimension': return piece(token.repr + writeUnit(token.unit), 'dimension');
      case 'hash': return piece(`#${writeName(token.value, token.id)}`, 'hash');
      case 'string': return piece(writeString(token.value), 'string');
      case 'delim': return piece(token.value, token.value);
      default: return piece(token.type, token.type); // , and :
    }
  };

  const trim = (items) => {
    let a = 0;
    let b = items.length;
    while (a < b && items[a].type === 'ws') a++;
    while (b > a && items[b - 1].type === 'ws') b--;
    return items.slice(a, b);
  };
  const splitAt = (items, type) => {
    const parts = [[]];
    for (const item of items) {
      if (item.type === type) parts.push([]);
      else parts[parts.length - 1].push(item);
    }
    return parts;
  };
  const lineIn = (items, fallback) => {
    for (const item of items) if (item.type !== 'ws' && item.line) return item.line;
    return fallback;
  };
  // What a token is, in a message
  function what(item) {
    switch (item.type) {
      case 'ident': return `"${shown(item.value)}"`;
      case 'function': return `${shown(lower(item.name))}()`;
      case 'at': return `@${shown(item.value)}`;
      case 'hash': return `#${shown(item.value)}`;
      case 'string': return 'a string';
      case 'url': case 'bad-url': return 'url()';
      case 'delim': return `"${item.value}"`;
      case 'number': case 'percentage': case 'dimension': return 'a number';
      case 'block': return `${item.open} ${CLOSER[item.open]}`;
      case 'cdo': return '<!--';
      case 'cdc': return '-->';
      default: return `"${item.type}"`;
    }
  }

  // ------------------------------------------------------------------------------------- checking

  // A problem found while reading: it becomes a CssError (strict), or an entry of `dropped` and the part is left out
  class Bad {
    constructor(line, reason) {
      this.line = line;
      this.reason = reason;
    }
  }
  const fail = (line, reason) => { throw new Bad(line, reason); };
  const MISSING = {}; // a file of the design that `resolve` does not have: the declaration is left out, and that is not a problem
  const STOP = {}; // too many rules and declarations: the rest is left out

  const NOT_CLOSED = {
    '{': 'a { is not closed (add the } that ends it)',
    '(': 'a ( is not closed (add the ) that ends it)',
    '[': 'a [ is not closed (add the ] that ends it)'
  };
  const TOO_DEEP = `brackets and functions can only go ${MAX_DEPTH} deep inside each other`;
  // A { } block (or a function) that the end of the text closed: the problem is the innermost bracket left open
  function notClosed(node) {
    let open = node;
    for (;;) {
      const inside = open.items.filter((item) => (item.type === 'block' || item.type === 'function') && item.unclosed).pop();
      if (!inside) break;
      open = inside;
    }
    return fail(open.line, NOT_CLOSED[open.type === 'function' ? '(' : open.open]);
  }
  // ... and in what comes before a { } block (a selector, or the condition of an at-rule)
  const allClosed = (items) => {
    for (const item of items) if ((item.type === 'block' || item.type === 'function') && item.unclosed) notClosed(item);
  };
  const NESTED = 'a rule inside another rule is not allowed (write each rule on its own)';
  const FONT_SRC = "the src of @font-face can only use the design's own fonts, as url(fonts/font.woff2), and local()";

  function refusedAddress(ref) {
    if (/^data:/i.test(ref)) return `a data: address is not allowed in url() (${OWN_FILES})`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || /^[\\/]{2}/.test(ref)) return `a web address is not allowed in url() (${OWN_FILES})`;
    return `url(${shown(ref)}) is not one of the design's files (${OWN_FILES})`;
  }

  // What is not allowed where a value, a selector or a condition is expected
  function stray(item, where) {
    switch (item.type) {
      case 'bad-url': return 'this url() cannot be read (write it as url(images/css-name.png))';
      case 'bad-string': return 'a string goes on past the end of its line (end it with a quote before the line ends)';
      case 'cdo': return '<!-- is not allowed (a style sheet is not a web page)';
      case 'cdc': return '--> is not allowed (a style sheet is not a web page)';
      case ')': case ']': case '}': return `there is a ${item.type} that closes nothing`;
      case 'block': if (item.open === '{') return `{ } is not allowed ${where}`; break;
      default: break;
    }
    return `${what(item)} is not allowed ${where}`;
  }

  // One reading of a style sheet (or of a value): strict or not, and the address of each of the design's files
  function createRun({ strict = false, resolve = null, urls = true } = {}) {
    const dropped = [];
    let total = 0;
    let full = false;

    // a problem that leaves something out, but lets the rest go on
    const note = (line, reason) => {
      if (strict) throw new CssError(line, reason);
      dropped.push({ line, reason });
    };
    // do one part; when it is bad, it is left out (or, when strict, that is the end)
    const attempt = (work) => {
      try {
        return work();
      } catch (error) {
        if (error === MISSING || error === STOP) return null;
        if (!(error instanceof Bad)) throw error;
        if (strict) throw new CssError(error.line, error.reason);
        dropped.push({ line: error.line, reason: error.reason });
        return null;
      }
    };
    const tally = (line) => {
      if (++total <= MAX_ITEMS) return;
      const reason = `a style sheet can have at most ${MAX_ITEMS} rules and declarations`;
      if (strict) throw new CssError(line, reason);
      if (!full) {
        full = true;
        dropped.push({ line, reason: `${reason}: the rest was left out` });
      }
      throw STOP;
    };

    // ---- values

    function urlPiece(ref, line, context) {
      if (context.condition) fail(line, 'url() is not allowed in a condition');
      if (!urls) fail(line, 'url() is not allowed here (a color or a size cannot point at a picture or a web address)');
      const clean = ref.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
      if (!isOwnRef(clean)) fail(line, refusedAddress(clean));
      let address = clean;
      if (resolve) {
        address = resolve(clean);
        if (typeof address !== 'string') throw MISSING;
      }
      return piece(writeUrl(address), ')');
    }

    // the arguments of a function that only takes names and strings (format(), tech(), local())
    function plainArguments(fn) {
      for (const item of fn.items) {
        if (['ws', 'ident', 'string', ','].indexOf(item.type) === -1 || item.unclosed) fail(item.line || fn.line, stray(item, `in ${lower(fn.name)}()`));
      }
      return join(fn.items.map((item) => (item.type === 'ws' ? SPACE : tokenPiece(item))));
    }

    function functionPiece(fn, context) {
      if (fn.unclosed) fail(fn.line, NOT_CLOSED['(']);
      if (fn.deep) fail(fn.line, TOO_DEEP);
      const name = lower(fn.name);
      const base = name.indexOf('-webkit-') === 0 && WEBKIT.indexOf(name.slice(8)) !== -1 ? name.slice(8) : name;
      const written = (inner) => piece(`${writeIdent(fn.name)}(${inner})`, ')'); // (as it was written: CSS does not mind the case)
      if (name === 'url') {
        const inside = trim(fn.items);
        if (inside.length !== 1 || inside[0].type !== 'string' || inside[0].unclosed) fail(fn.line, `url() can only hold the name of one of the design's files (${OWN_FILES})`);
        return urlPiece(inside[0].value, fn.line, context);
      }
      if (FONT_SOURCE.indexOf(name) !== -1) {
        if (!context.fontSource) fail(fn.line, `${name}() is only allowed in the src of @font-face`);
        return written(plainArguments(fn));
      }
      if (context.fontSource) fail(fn.line, FONT_SRC);
      if (name === 'attr') {
        const parts = fn.items.filter((item) => item.type !== 'ws');
        const plain = parts.length === 1 || (parts.length === 3 && parts[1].type === ',' && parts[2].type === 'string' && !parts[2].unclosed);
        if (context.property !== 'content') fail(fn.line, 'attr() is only allowed in content');
        if (!plain || parts[0].type !== 'ident') fail(fn.line, 'attr() can only take the name of an attribute here, as attr(data-name)');
        return written(writeIdent(parts[0].value) + (parts.length === 3 ? `,${writeString(parts[2].value)}` : ''));
      }
      if (name === 'selector') fail(fn.line, 'selector() is only allowed after @supports');
      if (LOADERS.indexOf(name.replace(/^-webkit-/, '')) !== -1) fail(fn.line, `${name}() is not allowed (${OWN_FILES})`);
      if (FUNCTIONS.indexOf(base) === -1) fail(fn.line, `${shown(name)}() is not allowed (it is not one of the functions a design can use)`);
      if (base === 'var' || base === 'env') {
        const parts = fn.items.filter((item) => item.type !== 'ws');
        const named = parts.length > 0 && parts[0].type === 'ident' && (base === 'env' || parts[0].value.slice(0, 2) === '--');
        if (!named || (parts.length > 1 && parts[1].type !== ',')) {
          fail(fn.line, base === 'var' ? 'var() needs the name of a custom property, as var(--name)' : 'env() needs the name of a value, as env(safe-area-inset-top)');
        }
      }
      const math = MATH.indexOf(base) !== -1 || ((base === 'var' || base === 'env') && context.math);
      return written(valueText(fn.items, Object.assign({}, context, { math })));
    }

    function blockPiece(block, context) {
      if (block.unclosed) fail(block.line, NOT_CLOSED[block.open]);
      if (block.deep) fail(block.line, TOO_DEEP);
      if (block.open === '(' && context.math) return piece(`(${valueText(block.items, context)})`, ')');
      if (block.open === '[' && block.items.every((item) => item.type === 'ws' || item.type === 'ident')) return piece(`[${valueText(block.items, context)}]`, ']');
      return fail(block.line, stray(block, 'in a value'));
    }

    function valuePieces(items, context) {
      const pieces = [];
      for (const item of items) {
        switch (item.type) {
          case 'ws': pieces.push(SPACE); break;
          case 'ident':
            // (a transition of display beats the !important that keeps a piece the producer switched off hidden)
            if (lower(item.value) === 'allow-discrete') fail(item.line, 'allow-discrete is not allowed (it could show what the producer switched off)');
            pieces.push(tokenPiece(item));
            break;
          case 'number': case 'percentage': case 'dimension': case 'hash': case ',':
            pieces.push(tokenPiece(item));
            break;
          case 'string':
            if (item.unclosed) fail(item.line, 'a string is not closed (add the quote that ends it)');
            pieces.push(tokenPiece(item));
            break;
          case 'url':
            if (item.unclosed) fail(item.line, NOT_CLOSED['(']);
            pieces.push(urlPiece(item.value, item.line, context));
            break;
          case 'function': pieces.push(functionPiece(item, context)); break;
          case 'block': pieces.push(blockPiece(item, context)); break;
          case 'delim':
            if (VALUE_DELIMS.indexOf(item.value) !== -1 || (item.value === '?' && context.fontFace)) { pieces.push(tokenPiece(item)); break; }
            if (item.value === '!') fail(item.line, '! is only used for !important, and !important is not allowed (it could show what the producer switched off)');
            fail(item.line, stray(item, 'in a value'));
            break;
          default: fail(item.line, stray(item, 'in a value'));
        }
      }
      return pieces;
    }
    const valueText = (items, context) => join(valuePieces(items, context));

    // the src of @font-face: url(<one of the design's fonts>) [format(...)] [tech(...)], or local(...), separated by commas
    function fontSource(items, line) {
      for (const part of splitAt(items, ',')) {
        const inside = trim(part);
        if (!inside.length) fail(line, FONT_SRC);
        const first = inside[0];
        const isUrl = first.type === 'url' || (first.type === 'function' && lower(first.name) === 'url');
        const isLocal = first.type === 'function' && lower(first.name) === 'local';
        if (!isUrl && !isLocal) fail(first.line, FONT_SRC);
        // (one of the design's pictures is no font; any other address is refused when the value is read)
        const named = isUrl ? (first.type === 'url' ? first.value : (trim(first.items)[0] || {}).value) : '';
        const ref = typeof named === 'string' ? named.replace(/^[ \t\n]+|[ \t\n]+$/g, '') : '';
        if (isOwnRef(ref) && ref.indexOf('fonts/') !== 0) fail(first.line, FONT_SRC);
        for (const extra of inside.slice(1)) {
          if (extra.type === 'ws') continue;
          if (isLocal || extra.type !== 'function' || ['format', 'tech'].indexOf(lower(extra.name)) === -1) fail(extra.line || line, FONT_SRC);
        }
      }
      return valueText(items, { property: 'src', fontFace: true, fontSource: true, math: false });
    }

    // "name: value" -> { name, custom, line, text }. `context`: { fontFace }
    function declaration(items, context) {
      const head = items[0];
      tally(head.line);
      const braces = items.some((item) => item.type === 'block' && item.open === '{');
      let k = 1;
      while (k < items.length && items[k].type === 'ws') k++;
      const isDeclaration = head.type === 'ident' && Boolean(items[k]) && items[k].type === ':';
      // (a rule inside a rule, "a:hover { ... }" too; a custom property with { } in it is told about with its value)
      if (head.type === 'at' || (braces && !(isDeclaration && head.value.slice(0, 2) === '--'))) fail(head.line, NESTED);
      if (!isDeclaration) fail(head.line, 'this is not a declaration (write it as property: value)');
      const custom = head.value.slice(0, 2) === '--';
      const name = custom ? head.value : lower(head.value);
      if (name === 'behavior' || name === '-moz-binding') fail(head.line, `${name} is not allowed (it could run code)`);
      let value = trim(items.slice(k + 1));
      const last = value.length - 1;
      if (last >= 0 && value[last].type === 'ident' && lower(value[last].value) === 'important') {
        let bang = last - 1;
        while (bang >= 0 && value[bang].type === 'ws') bang--;
        if (bang >= 0 && value[bang].type === 'delim' && value[bang].value === '!') {
          note(value[bang].line, '!important is not allowed (it could show what the producer switched off)');
          value = trim(value.slice(0, bang)); // (the declaration stays, without it)
        }
      }
      if (!value.length) fail(head.line, `${shown(name)} has no value`);
      const text = context.fontFace && name === 'src'
        ? fontSource(value, head.line)
        : valueText(value, { property: name, fontFace: Boolean(context.fontFace), math: false });
      return { name, custom, line: head.line, text: `${writeIdent(name)}:${text}` };
    }

    function declarationList(items, context) {
      const list = [];
      for (const part of splitAt(items, ';')) {
        if (full) break;
        const inside = trim(part);
        if (!inside.length) continue;
        const one = attempt(() => declaration(inside, context));
        if (one) list.push(one);
      }
      return list;
    }

    // ---- selectors

    function readAttribute(block) {
      if (block.unclosed) fail(block.line, NOT_CLOSED['[']);
      if (block.deep) fail(block.line, TOO_DEEP);
      const items = trim(block.items);
      const unreadable = 'this [ ] cannot be read (write it as [name] or [name="value"])';
      const skip = (k) => { while (k < items.length && items[k].type === 'ws') k++; return k; };
      const name = items[0];
      if (!name || name.type !== 'ident') fail(block.line, (name && name.type === 'delim' && (name.value === '|' || name.value === '*')) ? 'namespaces are not allowed in a selector' : unreadable);
      const isDelim = (item, value) => Boolean(item) && item.type === 'delim' && item.value === value;
      if (isDelim(items[1], '|') && !isDelim(items[2], '=')) fail(block.line, 'namespaces are not allowed in a selector');
      let k = skip(1);
      if (k >= items.length) return { kind: 'attr', name: name.value };
      let op;
      const m = items[k];
      const n = items[k + 1];
      if (m.type === 'delim' && m.value === '=') { op = '='; k++; }
      else if (m.type === 'delim' && '~|^$*'.indexOf(m.value) !== -1 && n && n.type === 'delim' && n.value === '=') { op = `${m.value}=`; k += 2; }
      else fail(block.line, unreadable);
      k = skip(k);
      const value = items[k];
      if (!value || (value.type !== 'ident' && value.type !== 'string') || value.unclosed) fail(block.line, unreadable);
      k = skip(k + 1);
      let modifier = '';
      if (k < items.length && items[k].type === 'ident' && /^[is]$/i.test(items[k].value)) { modifier = items[k].value.toLowerCase(); k = skip(k + 1); }
      if (k < items.length) fail(block.line, unreadable);
      return { kind: 'attr', name: name.value, op, value: value.value, modifier };
    }

    // the argument of :nth-child() and the like: An+B (and "of" a list of selectors, for the -child ones)
    function nthArgument(fn, name) {
      const items = trim(fn.items);
      let split = -1;
      if (name === 'nth-child' || name === 'nth-last-child') split = items.findIndex((item) => item.type === 'ident' && lower(item.value) === 'of');
      const formula = trim(split === -1 ? items : items.slice(0, split));
      if (!formula.length) fail(fn.line, `:${name}() needs a formula such as 2n+1, odd or even`);
      for (const item of formula) {
        const fine = ['ws', 'ident', 'number', 'dimension'].indexOf(item.type) !== -1 || (item.type === 'delim' && (item.value === '+' || item.value === '-'));
        if (!fine) fail(item.line || fn.line, stray(item, `in :${name}()`));
      }
      const text = join(formula.map((item) => (item.type === 'ws' ? SPACE : tokenPiece(item))));
      return split === -1 ? text : `${text} of ${selectorListText(items.slice(split + 1), fn.line)}`;
    }

    function plainList(fn, name, types) {
      const parts = fn.items.filter((item) => item.type !== 'ws');
      if (!parts.length) fail(fn.line, `:${name}() needs something inside it`);
      parts.forEach((item, index) => {
        const fine = index % 2 ? item.type === ',' : types.indexOf(item.type) !== -1 && !item.unclosed;
        if (!fine) fail(item.line || fn.line, stray(item, `in :${name}()`));
      });
      if (parts[parts.length - 1].type === ',') fail(fn.line, `:${name}() cannot end with a comma`);
      return parts.map((item) => tokenPiece(item).text).join('');
    }

    // ":" and what follows it, from list[k]; returns where it ends
    function readPseudo(list, k, compound, nested) {
      let at = k + 1;
      const doubled = Boolean(list[at]) && list[at].type === ':';
      if (doubled) at++;
      const item = list[at];
      if (!item || (item.type !== 'ident' && item.type !== 'function')) fail(list[k].line, 'a : in a selector must be followed by a name, as :hover or ::before');
      const isFunction = item.type === 'function';
      const name = lower(isFunction ? item.name : item.value);
      const shownName = `${shown(name)}${isFunction ? '()' : ''}`;
      if (doubled || (!isFunction && LEGACY_PSEUDO_ELEMENTS.indexOf(name) !== -1)) {
        if (isFunction || PSEUDO_ELEMENTS.indexOf(name) === -1) {
          fail(item.line, `::${shownName} is not allowed (a design can use ::before, ::after, ::first-letter, ::first-line, ::marker, ::selection and ::placeholder)`);
        }
        if (nested) fail(item.line, `::${name} cannot be used inside :not(), :is() or :where()`);
        if (compound.element) fail(item.line, 'a selector can only have one pseudo-element, such as ::before');
        compound.element = true;
        compound.parts.push({ kind: 'element', name, legacy: !doubled });
        return at;
      }
      if (Object.prototype.hasOwnProperty.call(REFUSED_PSEUDO, name)) fail(item.line, `:${shownName} is not allowed (${REFUSED_PSEUDO[name]})`);
      if (!isFunction) {
        if (name === 'root') compound.root = true;
        compound.parts.push({ kind: 'pseudo', name });
        return at;
      }
      if (item.unclosed) fail(item.line, NOT_CLOSED['(']);
      if (item.deep) fail(item.line, TOO_DEEP);
      let args;
      if (SELECTOR_PSEUDO.indexOf(name) !== -1) args = selectorListText(item.items, item.line);
      else if (NTH_PSEUDO.indexOf(name) !== -1) args = nthArgument(item, name);
      else if (name === 'lang') args = plainList(item, name, ['ident', 'string']);
      else if (name === 'dir') args = plainList(item, name, ['ident']);
      else fail(item.line, `:${shownName} is not allowed (a design can use :not(), :is(), :where(), :nth-child(), :nth-last-child(), :nth-of-type(), :nth-last-of-type(), :lang() and :dir())`);
      compound.parts.push({ kind: 'pseudo', name, args });
      return at;
    }

    // One compound selector (a.b#c[d]:e::f), from list[k] -> { compound, end }
    function readCompound(list, k, nested) {
      const compound = { type: null, parts: [], element: false, root: false, stage: false };
      const notAfterElement = (item) => { if (compound.element) fail(item.line, 'only a pseudo-class such as :hover can follow a pseudo-element such as ::before'); };
      let item = list[k];
      if (item && (item.type === 'ident' || (item.type === 'delim' && item.value === '*'))) {
        if (item.type === 'ident') {
          const name = lower(item.value);
          if (REFUSED_TYPES.indexOf(name) !== -1) fail(item.line, `rules for ${name} are not allowed (${name === 'body' ? SEE_THROUGH : "only what is on the overlay's stage can be styled"})`);
        }
        compound.type = item.type === 'ident' ? item.value : '*';
        k++;
      }
      if (list[k] && list[k].type === 'delim' && list[k].value === '|') fail(list[k].line, 'namespaces are not allowed in a selector');
      for (; k < list.length; k++) {
        item = list[k];
        if (item.type === 'hash') {
          notAfterElement(item);
          if (!item.id) fail(item.line, `#${shown(item.value)} is not an id a selector can use (an id cannot start with a digit)`);
          compound.parts.push({ kind: 'id', value: item.value });
          if (item.value === 'stage') compound.stage = true;
        } else if (item.type === 'delim' && item.value === '.') {
          notAfterElement(item);
          const next = list[k + 1];
          if (!next || next.type !== 'ident') fail(item.line, 'a . in a selector must be followed by the name of a class');
          compound.parts.push({ kind: 'class', value: next.value });
          k++;
        } else if (item.type === 'block' && item.open === '[') {
          notAfterElement(item);
          compound.parts.push(readAttribute(item));
        } else if (item.type === ':') {
          k = readPseudo(list, k, compound, nested);
        } else break;
      }
      return { compound, end: k };
    }

    // One selector (no commas) -> [compound, combinator, compound, ...], combinators being ' ', '>', '+' and '~'
    function readSelector(items, line, nested) {
      const list = trim(items);
      if (!list.length) fail(line, 'a selector is missing (before a comma, after one, or before a {)');
      const sequence = [];
      let k = 0;
      for (;;) {
        const read = readCompound(list, k, nested);
        if (read.end === k) {
          const item = list[k];
          if (item.type === 'delim' && '>+~'.indexOf(item.value) !== -1) fail(item.line, `a selector cannot ${sequence.length ? 'have two combinators in a row' : `start with ${item.value}`}`);
          fail(item.line || line, stray(item, 'in a selector'));
        }
        sequence.push(read.compound);
        k = read.end;
        let spaced = false;
        while (k < list.length && list[k].type === 'ws') { k++; spaced = true; }
        if (k >= list.length) break;
        let combinator = ' ';
        const item = list[k];
        if (item.type === 'delim' && '>+~'.indexOf(item.value) !== -1) {
          combinator = item.value;
          k++;
          while (k < list.length && list[k].type === 'ws') k++;
          if (k >= list.length) fail(item.line, `a selector cannot end with ${item.value}`);
        } else if (!spaced) fail(item.line || line, stray(item, 'in a selector'));
        if (read.compound.element) fail(item.line || line, 'a pseudo-element such as ::before can only be at the end of a selector');
        sequence.push(combinator);
      }
      return sequence;
    }

    function writePart(part) {
      switch (part.kind) {
        case 'id': return `#${writeIdent(part.value)}`;
        case 'class': return `.${writeIdent(part.value)}`;
        case 'attr': return `[${writeIdent(part.name)}${part.op ? `${part.op}${writeString(part.value)}${part.modifier ? ` ${part.modifier}` : ''}` : ''}]`;
        case 'element': return `${part.legacy ? ':' : '::'}${part.name}`;
        default: return `:${writeIdent(part.name)}${part.args === undefined ? '' : `(${part.args})`}`;
      }
    }
    const writeCompound = (compound) => (compound.type === '*' ? '*' : compound.type ? writeIdent(compound.type) : '') + compound.parts.map(writePart).join('');
    const writeSequence = (sequence) => sequence.map((entry, index) => (index % 2 ? entry : writeCompound(entry))).join('');

    // a list of selectors inside :not(), :is(), :where() or selector(): as they are, not put on the stage
    function selectorListText(items, line) {
      return splitAt(items, ',').map((part) => writeSequence(readSelector(part, lineIn(part, line), true))).join(',');
    }

    // One selector of a rule: put on the stage -> { text, root } (`root`: it is :root or html alone, so the rule only sets custom properties)
    function stageSelector(items, line) {
      const sequence = readSelector(items, line, false);
      const first = sequence[0];
      const leaves = (rest) => {
        if (rest[0].stage && (rest[1] === '+' || rest[1] === '~')) fail(line, `a rule can only style what is on the stage (#stage ${rest[1]} reaches outside it)`);
      };
      if (first.root || (first.type && first.type !== '*' && lower(first.type) === 'html')) {
        if (first.element) fail(line, `a pseudo-element of the page itself is not allowed (${SEE_THROUGH})`);
        if (sequence.length === 1) return { text: writeCompound(first), root: true };
        const rest = sequence.slice(2);
        leaves(rest);
        return { text: `${writeCompound(first)} ${rest[0].stage ? '' : '#stage '}${writeSequence(rest)}`, root: false };
      }
      if (first.stage) {
        leaves(sequence);
        return { text: writeSequence(sequence), root: false };
      }
      return { text: `#stage ${writeSequence(sequence)}`, root: false };
    }

    // ---- rules

    function styleRule(prelude, block, line) {
      tally(line);
      for (const item of prelude) if (item.type === '}' || item.type === ')' || item.type === ']') fail(item.line, stray(item, ''));
      allClosed(prelude);
      if (!block) fail(line, 'this has no { } after it (a selector needs a block of declarations)');
      if (block.unclosed) notClosed(block);
      if (!trim(prelude).length) fail(block.line, 'a { } needs a selector before it');
      const selectors = [];
      for (const part of splitAt(prelude, ',')) {
        const one = attempt(() => stageSelector(part, lineIn(part, line)));
        if (one) selectors.push(one);
      }
      if (!selectors.length) return null;
      const roots = selectors.filter((selector) => selector.root);
      const others = selectors.filter((selector) => !selector.root);
      const declarations = declarationList(block.items, {});
      const written = [];
      const rule = (list, decls) => `${list.map((selector) => selector.text).join(',')}{${decls.map((decl) => decl.text).join(';')}}`;
      if (others.length) written.push(rule(others, declarations));
      if (roots.length) {
        for (const decl of declarations) {
          if (!decl.custom) note(decl.line, `${shown(decl.name)} is not allowed in a rule for :root or html (${SEE_THROUGH}: set only custom properties, such as --name, there)`);
        }
        written.push(rule(roots, declarations.filter((decl) => decl.custom)));
      }
      return written.join('\n');
    }

    function keyframeRule(prelude, block, line) {
      tally(line);
      allClosed(prelude);
      if (!block) fail(line, 'this has no { } after it (write a keyframe as from { ... }, to { ... } or 50% { ... })');
      if (block.unclosed) notClosed(block);
      const selectors = splitAt(prelude, ',').map((part) => {
        const inside = trim(part);
        const item = inside[0];
        const fine = inside.length === 1 && ((item.type === 'ident' && ['from', 'to'].indexOf(lower(item.value)) !== -1) || item.type === 'percentage');
        if (!fine) fail(lineIn(part, line), `${inside.length === 1 ? what(item) : 'this'} is not a keyframe (use from, to or a percentage, as 50%)`);
        return item.type === 'ident' ? lower(item.value) : `${item.repr}%`;
      });
      return `${selectors.join(',')}{${declarationList(block.items, {}).map((decl) => decl.text).join(';')}}`;
    }

    // the names of a layer: "base", "theme.colors", separated by commas
    function layerNames(items, line, most) {
      const names = splitAt(items, ',').map((part) => {
        const inside = trim(part);
        const fine = inside.length % 2 === 1 && inside.every((item, index) => (index % 2 ? item.type === 'delim' && item.value === '.' : item.type === 'ident'));
        if (!fine) fail(lineIn(part, line), 'the name of a layer can only be letters, digits and dashes, as @layer theme');
        return inside.map((item) => (item.type === 'ident' ? writeIdent(item.value) : '.')).join('');
      });
      if (names.length > most) fail(line, 'a block of @layer can only have one name');
      return names.join(',');
    }

    // the condition after @media, @supports or @container: names, numbers, ( ), :, commas; and for @supports, selector() and the
    // functions a value can use, as in (backdrop-filter: blur(4px))
    function conditionPieces(items, name) {
      const where = `after @${name} (only a condition such as (max-width: 600px) can be used)`;
      return items.map((item) => {
        switch (item.type) {
          case 'ws': return SPACE;
          case 'ident': case 'number': case 'percentage': case 'dimension': case ',': case ':': return tokenPiece(item);
          case 'delim': if ('/<>='.indexOf(item.value) !== -1) return tokenPiece(item); break;
          case 'block':
            if (item.open !== '(') break;
            if (item.unclosed) fail(item.line, NOT_CLOSED['(']);
            if (item.deep) fail(item.line, TOO_DEEP);
            return piece(`(${join(conditionPieces(item.items, name))})`, ')');
          case 'function':
            if (name !== 'supports') break;
            if (lower(item.name) !== 'selector') return functionPiece(item, { property: '', math: false, condition: true });
            if (item.unclosed) fail(item.line, NOT_CLOSED['(']);
            if (item.deep) fail(item.line, TOO_DEEP);
            return piece(`selector(${selectorListText(item.items, item.line)})`, ')');
          default: break;
        }
        return fail(item.line, stray(item, where));
      });
    }

    function atRule(token, prelude, block, depth) {
      const line = token.line;
      tally(line);
      const name = lower(token.value);
      if (name === 'import' || name === 'namespace') fail(line, `@${name} is not allowed (a design can only use the files it carries)`);
      if (name === 'charset') fail(line, '@charset is not allowed (a style sheet is always read as UTF-8)');
      if (AT_RULES.indexOf(name) === -1) fail(line, `@${shown(name)} is not allowed (a design can use @media, @supports, @layer, @keyframes, @font-face, @container and @starting-style)`);
      if (depth >= MAX_AT_DEPTH) fail(line, `at-rules can only go ${MAX_AT_DEPTH} deep inside each other`);
      allClosed(prelude);
      if (block && block.unclosed) notClosed(block);
      const inside = trim(prelude);
      if (!block && name !== 'layer') fail(line, `@${name} needs a { } block after it`);
      const nested = () => {
        const rules = ruleList(block.items, depth + 1);
        return rules.length ? `{\n${rules.join('\n')}\n}` : '{}';
      };
      if (CONDITIONS.indexOf(name) !== -1) {
        const condition = join(conditionPieces(inside, name));
        return `@${name}${condition ? ` ${condition}` : ''}${nested()}`;
      }
      if (name === 'layer') {
        if (!block && !inside.length) fail(line, '@layer needs the name of a layer, as @layer theme;');
        const names = inside.length ? layerNames(inside, line, block ? 1 : Infinity) : '';
        return block ? `@layer${names ? ` ${names}` : ''}${nested()}` : `@layer ${names};`;
      }
      if (name === 'keyframes' || name === '-webkit-keyframes') {
        const label = inside[0];
        if (inside.length !== 1 || (label.type !== 'ident' && label.type !== 'string') || label.unclosed) fail(line, `@${name} needs one name, as @keyframes glow`);
        const frames = eachRule(block.items, (head, framePrelude, frameBlock) => {
          if (head.type === 'at') fail(head.line, `@${shown(head.value)} is not allowed inside @${name} (it only holds keyframes)`);
          return keyframeRule(framePrelude, frameBlock, lineIn(framePrelude, head.line));
        });
        return `@${name} ${tokenPiece(label).text}${frames.length ? `{\n${frames.join('\n')}\n}` : '{}'}`;
      }
      if (inside.length) fail(lineIn(inside, line), `nothing can go between @${name} and its {`);
      if (name === 'font-face') return `@font-face{${declarationList(block.items, { fontFace: true }).map((decl) => decl.text).join(';')}}`;
      return `@${name}${nested()}`; // @starting-style
    }

    // Each rule of a list (the style sheet, or what is inside an at-rule), as CSS splits them: an at-rule goes on to a ; or a { } block,
    // any other rule to a { } block. `each(head, prelude, block)` writes one (or fails, and that one is left out) -> the rules, written
    function eachRule(items, each) {
      const written = [];
      let k = 0;
      while (k < items.length && !full) {
        const head = items[k];
        if (head.type === 'ws') { k++; continue; }
        if (head.type === 'cdo' || head.type === 'cdc') {
          attempt(() => fail(head.line, stray(head, '')));
          k++;
          continue;
        }
        const isAt = head.type === 'at';
        let j = isAt ? k + 1 : k;
        while (j < items.length && !(items[j].type === 'block' && items[j].open === '{') && !(isAt && items[j].type === ';')) j++;
        const prelude = items.slice(isAt ? k + 1 : k, j);
        const block = j < items.length && items[j].type === 'block' ? items[j] : null;
        k = j + 1;
        const rule = attempt(() => each(head, prelude, block));
        if (rule) written.push(rule);
      }
      return written;
    }

    function ruleList(items, depth) {
      return eachRule(items, (head, prelude, block) => (head.type === 'at' ? atRule(head, prelude, block, depth) : styleRule(prelude, block, lineIn(prelude, head.line))));
    }

    // ---- the whole thing

    function read(text) {
      return readTokens(preprocess(text, note));
    }

    function sheet(text) {
      if (typeof text !== 'string') {
        note(null, 'the style sheet must be text');
        return { css: '', dropped };
      }
      const plain = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      if (byteLength(plain) > MAX_BYTES) {
        note(null, `the style sheet is too large (${MAX_BYTES / 1024} KB at most)`);
        return { css: '', dropped };
      }
      const { tokens, comments } = read(plain);
      const written = ruleList(readComponents(tokens), 0);
      for (const comment of comments) note(comment.line, comment.reason);
      return { css: written.join('\n'), dropped };
    }

    function value(text) {
      if (typeof text !== 'string') throw new CssError(null, 'a value must be text');
      const { tokens, comments } = read(text);
      if (comments.length) throw new CssError(comments[0].line, comments[0].reason);
      try {
        const items = trim(readComponents(tokens));
        for (const item of items) if (item.type === ';') fail(item.line, '";" is not allowed in a value');
        const last = items[items.length - 1];
        if (last && last.type === 'ident' && lower(last.value) === 'important') {
          for (let k = items.length - 2; k >= 0; k--) {
            if (items[k].type === 'ws') continue;
            if (items[k].type === 'delim' && items[k].value === '!') fail(items[k].line, '!important is not allowed (it could show what the producer switched off)');
            break;
          }
        }
        return valueText(items, { property: '', math: false });
      } catch (error) {
        if (error instanceof Bad) throw new CssError(error.line, error.reason);
        throw error;
      }
    }

    return { sheet, value };
  }

  // The style sheet of a design, checked and written again: see the top of this file
  function sanitizeCss(text, { strict = false, resolve = null } = {}) {
    return createRun({ strict, resolve }).sheet(text);
  }

  // One value of a property (a design's color, for example): the value as it is when it is fine; with `strict` (the usual) a CssError
  // says what is wrong, otherwise the answer is null. Nothing can point at a file or a web address here: url() is never allowed.
  function checkValue(text, { strict = true } = {}) {
    try {
      createRun({ strict: true, urls: false }).value(text);
      return text;
    } catch (error) {
      if (!strict && error instanceof CssError) return null;
      throw error;
    }
  }

  // The tokens of a text, as checkValue and sanitizeCss read it (for tests): [{ type, value, repr, unit, id, line }]
  function tokenize(text) {
    return readTokens(preprocess(String(text), () => {})).tokens;
  }

  return { CssError, sanitizeCss, checkValue, isOwnRef, heldFile, tokenize, MAX_ITEMS, MAX_AT_DEPTH, MAX_DEPTH };
}));
