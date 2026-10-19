/**
 * The code view of the design editor: the design as text (the same JSON that is saved in design.json,
 * without the pictures). Typing changes the overlay as soon as the text makes sense; what the mouse does
 * on the canvas is written back into the text. A mistake is shown with its line, and nothing changes
 * until it is fixed.
 */
import { h } from './dom.js';

const RULES = window.OTO_THEME_RULES;
const KNOWN = ['author', 'description', 'colors', 'layout', 'crop', 'tile', 'prizeStyle', 'prizeLayout', 'orientation', 'spaces', 'fontFamilies'];
const MAX_AUTHOR = 60;
const MAX_DESCRIPTION = 300;

// "Line 3, column 5" for a position in the text
function placeOf(text, position) {
  const before = text.slice(0, Math.max(0, position));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

// What is wrong with this text, in plain words, or what it holds. { error, position } or { design, ignored }
export function readCode(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const match = /position (\d+)/.exec(error.message);
    const position = match ? Number(match[1]) : text.length;
    const where = placeOf(text, position);
    // the browser's own words for the mistake, without its position (which is shown as a line instead)
    const said = error.message.replace(/ in JSON at position \d+.*$/, '').replace(/\s*\(line \d+ column \d+\)/, '');
    return { error: `Line ${where.line}, column ${where.column}: ${said}`, position };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'The design must be an object: { ... }' };

  const design = {};
  try {
    if ('author' in parsed) {
      if (typeof parsed.author !== 'string') throw new RULES.RuleError('"author" must be text');
      design.author = parsed.author.slice(0, MAX_AUTHOR);
    }
    if ('description' in parsed) {
      if (typeof parsed.description !== 'string') throw new RULES.RuleError('"description" must be text');
      design.description = parsed.description.slice(0, MAX_DESCRIPTION);
    }
    if ('colors' in parsed) design.colors = RULES.sanitizeColors(parsed.colors);
    if ('layout' in parsed) design.layout = RULES.sanitizeLayout(parsed.layout, { strict: true });
    if ('crop' in parsed) design.crop = RULES.sanitizeCrop(parsed.crop, { strict: true });
    if ('tile' in parsed) design.tile = RULES.sanitizeTile(parsed.tile, { strict: true });
    if ('prizeStyle' in parsed) design.prizeStyle = RULES.sanitizePrize(parsed.prizeStyle, { strict: true });
    if ('prizeLayout' in parsed) design.prizeLayout = RULES.sanitizePrizeLayout(parsed.prizeLayout, { strict: true });
    if ('orientation' in parsed) design.orientation = RULES.sanitizeOrientation(parsed.orientation, { strict: true });
    if ('spaces' in parsed) design.spaces = RULES.sanitizeSpaces(parsed.spaces, { strict: true });
    if ('fontFamilies' in parsed) design.fontFamilies = RULES.sanitizeFontFamilies(parsed.fontFamilies, { strict: true });
  } catch (error) {
    if (error instanceof RULES.RuleError) return { error: error.message };
    throw error;
  }
  return { design, ignored: Object.keys(parsed).filter((key) => !KNOWN.includes(key)) };
}

export class CodePanel {
  // `onInput()` is told when the text in the box changes or is read (whether it is in the design is part of what is saved and what is not)
  constructor({ model, onInput = () => {} }) {
    this.model = model;
    this.onInput = onInput;
    this.timer = null;
    this.build();
    this.show();
    // What the mouse (or an undo) does is written into the text. A change that left the design as it was, such as the
    // end of a run of key presses, leaves what is being typed alone; an undo or "Undo all changes" takes away text with a mistake.
    model.on((change) => {
      const back = change.kind === 'history' || change.source === 'revert';
      if (change.source !== 'code' && (this.model.toCode() !== this.shown || (back && this.unapplied))) this.show();
    });
  }

  build() {
    this.input = h('textarea', {
      class: 'code-input', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off',
      'aria-label': 'The design as code (Tab indents; Ctrl+M makes it move to the next control)', 'aria-describedby': 'code-status'
    });
    this.gutter = h('pre', { class: 'code-gutter', 'aria-hidden': 'true' });
    this.status = h('p', { class: 'code-status', id: 'code-status', role: 'status' });
    this.input.addEventListener('input', () => {
      this.numbers();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.apply(); }, 300);
      this.onInput();
    });
    this.input.addEventListener('scroll', () => { this.gutter.scrollTop = this.input.scrollTop; });
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.format = h('button', { class: 'btn tiny', type: 'button', onclick: () => this.tidy() }, 'Format');
    this.element = h('div', { class: 'code-panel' },
      h('p', { class: 'settings-note' }, 'Everything about the look except the pictures, font, sounds and style sheet (it has a tab of its own). Changes show on the overlay as you type. Pieces of the overlay are listed under "layout", the part of the card that shows under "crop", where the HP bar, the energy and the retreat cost go under "tile", the picture on the prize cards under "prizeStyle" and how they are laid out under "prizeLayout", the screen under "orientation", the places kept clear for a camera feed under "spaces" and the fonts of each kind of text under "fontFamilies".'),
      h('div', { class: 'code-editor' }, this.gutter, this.input),
      this.status,
      h('div', { class: 'button-row' }, this.format));
  }

  // Tab inserts two spaces instead of leaving the box, until Ctrl+M says it moves to the next control (and Ctrl+M again brings it back),
  // as in code editors: so the controls after the box can be reached with the keyboard
  onKeyDown(event) {
    if (event.key.toLowerCase() === 'm' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      this.tabMoves = !this.tabMoves;
      this.say(this.tabMoves ? 'Tab now moves to the next control (Ctrl+M to indent with it again).' : 'Tab now indents (Ctrl+M to move to the next control with it).');
      return;
    }
    if (this.tabMoves || event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = this.input;
    this.input.value = `${value.slice(0, start)}  ${value.slice(end)}`;
    this.input.selectionStart = this.input.selectionEnd = start + 2;
    this.input.dispatchEvent(new Event('input'));
  }

  numbers() {
    const count = this.input.value.split('\n').length;
    this.gutter.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
  }

  // Whether the box holds text the design does not have: keys pressed a moment ago (`waiting` to be read), or a mistake. It is not saved.
  get unapplied() {
    return this.input.value !== this.read;
  }

  get waiting() {
    return this.timer !== null;
  }

  // Read what was typed and is still waiting to be read (Save and Close do this first, so the last key presses are not lost)
  flush() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.apply();
  }

  // The editor is closing: nothing is read after that
  dispose() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // Put the model's text in the box (what was written on the canvas, an undo, a revert)
  show() {
    clearTimeout(this.timer);
    this.timer = null;
    this.shown = this.model.toCode();
    this.read = this.shown; // (the text in the box that the design has)
    this.input.value = this.shown;
    this.input.removeAttribute('aria-invalid');
    this.input.classList.remove('bad');
    this.say('');
    this.numbers();
  }

  say(text, bad = false) {
    this.status.textContent = text;
    this.status.classList.toggle('bad', bad);
  }

  // Read what was typed: when it makes sense, the overlay follows
  apply() {
    const result = readCode(this.input.value);
    this.input.classList.toggle('bad', Boolean(result.error));
    if (result.error) {
      this.input.setAttribute('aria-invalid', 'true');
      this.say(`${result.error}. The overlay keeps the last version that made sense.`, true);
      this.onInput();
      return;
    }
    this.input.removeAttribute('aria-invalid');
    const patch = {};
    const TEXTS = ['author', 'description', 'prizeStyle', 'prizeLayout', 'orientation']; // what is left out of the text goes back to nothing, to an empty list or to an empty object
    for (const key of KNOWN) patch[key] = key in result.design ? result.design[key] : (TEXTS.includes(key) ? '' : key === 'spaces' ? [] : {});
    this.say(result.ignored.length ? `Not used: ${result.ignored.join(', ')}.` : 'Applied.');
    this.read = this.input.value;
    this.model.update(patch, { source: 'code' });
    this.shown = this.model.toCode(); // the model now says what the text says
    this.onInput();
  }

  // Write the text out again, tidily
  tidy() {
    clearTimeout(this.timer);
    const result = readCode(this.input.value);
    if (result.error) {
      this.say(`${result.error}. Fix it before formatting.`, true);
      return;
    }
    this.apply();
    this.show();
    this.say('Formatted.');
  }
}
