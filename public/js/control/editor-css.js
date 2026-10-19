/**
 * The "Style sheet" tab of the design editor: the design's own CSS (styles.css). It can restyle anything on the overlay's stage and
 * animate the moments of the game that the overlay marks (a hit, a knock out, a prize card taken...). Typing changes the overlay as
 * soon as the text is allowed; what is not allowed is shown with its line, and the overlay keeps the last version that was. Below it:
 * the pictures the style sheet can use (they go up the moment they are chosen, like the other pictures), a way to play a moment on the
 * overlay to see what the style sheet does with it, and a short guide to what there is to style.
 */
import { h, icon } from './dom.js';
import { promptDialog } from './ui.js';

const THEME = window.OTO_THEME;
const CSS = window.OTO_THEME_CSS;

// The moments that can be tried, each on a piece of the overlay it happens to (see markMoments in public/js/overlay.js)
const MOMENTS = [
  { key: 'damage', label: 'Damage', target: 'active', amount: 30 },
  { key: 'heal', label: 'Healing', target: 'active', amount: 30 },
  { key: 'ko', label: 'Knock out', target: 'active' },
  { key: 'enter', label: 'A Pokémon comes in', target: 'bench0' },
  { key: 'switch', label: 'Switch with the bench', target: 'active' },
  { key: 'evolve', label: 'Evolution', target: 'active' },
  { key: 'devolve', label: 'Devolution', target: 'active' },
  { key: 'energy', label: 'Energy attached', target: 'active', amount: 1 },
  { key: 'tool', label: 'Pokémon Tool attached', target: 'active' },
  { key: 'status', label: 'Status condition', target: 'active' },
  { key: 'ability', label: 'Ability used', target: 'active' },
  { key: 'taken', label: 'Prize card taken', target: 'prize0' },
  { key: 'turn', label: 'Turn starts', target: 'trainer' },
  { key: 'used', label: 'Supporter played', target: 'token-supporter' },
  { key: 'stadium', moment: 'enter', label: 'A Stadium comes into play', target: 'stadium' },
  { key: 'point', label: 'Game won', target: 'wins' }
];

const code = (text) => h('code', {}, text);

export class CssPanel {
  // `canvas`: the EditorCanvas (it plays the moments). `assetUrl(ref)` is the address of a file of the design; `upload(key)` asks for a
  // picture and puts it in the slot `key` ("css-<name>"); `removePicture(key)` takes it out. `onInput()` is told when the text in the
  // box changes or is read (whether it is in the design is part of what is saved and what is not).
  constructor({ model, canvas, assetUrl, upload, removePicture, onInput = () => {} }) {
    this.model = model;
    this.canvas = canvas;
    this.assetUrl = assetUrl;
    this.upload = upload;
    this.removePicture = removePicture;
    this.onInput = onInput;
    this.timer = null;
    this.build();
    this.show();
    this.drawPictures();
    // An undo, a redo or "Undo all changes" puts the style sheet of the draft in the box (and takes away text with a mistake, which
    // the draft never had). A picture that came or went may be one the style sheet names, so what it says about the style sheet is
    // said again.
    model.on((change) => {
      const back = change.kind === 'history' || change.source === 'revert';
      if (change.source !== 'css' && (this.model.draft.css !== this.shown || (back && this.unapplied))) this.show();
      if (change.kind === 'files' || change.kind === 'saved') {
        this.drawPictures();
        // (unless a mistake is being typed: the status says that until it is fixed)
        if (!this.input.classList.contains('bad') && this.status.textContent) this.tell(this.check(this.shown));
      }
    });
  }

  build() {
    this.input = h('textarea', {
      class: 'code-input css-input', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off',
      'aria-label': 'The style sheet of the design', 'aria-describedby': 'css-status', placeholder: '.scoreboard {\n  border-radius: 24px;\n}'
    });
    this.gutter = h('pre', { class: 'code-gutter', 'aria-hidden': 'true' });
    this.status = h('p', { class: 'code-status css-status', id: 'css-status', role: 'status' });
    this.input.addEventListener('input', () => {
      this.numbers();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.apply(); }, 300);
      this.onInput();
    });
    this.input.addEventListener('scroll', () => { this.gutter.scrollTop = this.input.scrollTop; });
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));

    // the pictures of the style sheet
    this.count = h('span', { class: 'hint' });
    this.pictures = h('div', { class: 'css-pictures' });
    this.add = h('button', { class: 'btn tiny', type: 'button', onclick: () => this.addPicture() }, icon('plus', 14), 'Add a picture');

    // a moment to try
    this.moment = h('select', { 'aria-label': 'The moment to play' },
      MOMENTS.map((entry) => h('option', { value: entry.key }, `${entry.label} (moment-${entry.moment || entry.key})`)));
    this.side = h('select', { 'aria-label': 'The trainer it happens to' },
      h('option', { value: 'a' }, 'Trainer A'), h('option', { value: 'b' }, 'Trainer B'));
    const play = h('button', { class: 'btn tiny', type: 'button', onclick: () => this.play() }, icon('play', 14), 'Play');

    this.element = h('div', { class: 'code-panel css-panel' },
      h('p', { class: 'settings-note' }, 'The design\'s own style sheet (CSS). It can restyle anything on the overlay and animate what happens in the game, with the design\'s own pictures and fonts and nothing from the web. Changes show on the overlay as you type.'),
      h('div', { class: 'code-editor' }, this.gutter, this.input),
      this.status,
      h('section', { class: 'css-section' },
        h('div', { class: 'section-label' }, 'Pictures for the style sheet', this.count),
        h('p', { class: 'settings-note' }, 'Saved as soon as they are chosen. The style sheet uses each one by its name, as var(--css-name), or as url(images/css-name.png) with the ending of its file.'),
        this.pictures,
        h('div', { class: 'button-row' }, this.add)),
      h('section', { class: 'css-section' },
        h('div', { class: 'section-label' }, 'Try a moment'),
        h('p', { class: 'settings-note' }, 'Plays a moment on the overlay as if it had happened, to see what the style sheet does with it.'),
        h('div', { class: 'css-try' }, this.moment, this.side, play)),
      this.help());
  }

  // What there is to style and to animate, in short (the design guide, docs/DESIGNING.md, has it all, with examples)
  help() {
    return h('details', { class: 'css-help' },
      h('summary', {}, 'How to use it'),
      h('ul', {},
        h('li', {}, 'Every rule is for the overlay\'s stage: ', code('.scoreboard'), ' is read as ', code('#stage .scoreboard'), ', so it wins over the built-in look without ', code('!important'), ' (which is not allowed, nor is a transition of ', code('display'), ' with ', code('allow-discrete'), ': either could show what the producer switched off).'),
        h('li', {}, 'A rule for ', code(':root'), ' alone can only set custom properties, such as ', code('--accent: #ff00aa'), ' or how long a moment lasts: ', code('--oto-moment-ms: 1200'), ' (1500 unless it says).'),
        h('li', {}, 'The design\'s pictures and fonts: ', code('var(--logoImage)'), ', ', code('var(--css-name)'), ', ', code('url(images/css-name.png)'), ', ', code('url(fonts/font.woff2)'), '. Nothing else can be loaded: no web addresses, no ', code('@import'), '.'),
        h('li', {}, 'For a short while after something happens, the overlay puts a class on the piece it happened to. On a Pokémon\'s tile (', code('.mon'), '): ',
          code('moment-damage'), ' and ', code('moment-heal'), ' (', code('data-damage'), ' and ', code('--moment-damage'), ', ', code('data-heal'), ' and ', code('--moment-heal'), ' say how much), ', code('moment-ko'), ', ',
          code('moment-enter'), ', ', code('moment-switch'), ', ', code('moment-evolve'), ', ', code('moment-devolve'), ', ', code('moment-energy'), ' (', code('data-energy'), ' says how many), ', code('moment-tool'), ', ',
          code('moment-status'), ' (', code('data-status'), ' says which) and ', code('moment-ability'), '.'),
        h('li', {}, code('moment-taken'), ' on a prize card (', code('.prize'), '), ', code('moment-turn'), ' on a trainer (', code('.trainer'), '), ', code('moment-used'), ' on a tracker (',
          code('.token'), '), ', code('moment-enter'), ' on the Stadium (', code('.stadium'), ') and ', code('moment-point'), ' on the games won (', code('.sb-wins'), ').'),
        h('li', {}, 'The stage gets the kind and the side of each one too (', code('moment-damage-a'), ', ', code('moment-taken-b'), '...), for effects over the whole stage.'),
        h('li', {}, 'A knocked out Pokémon stays on its tile until its moment is over when the style sheet has a rule for ', code('moment-ko'), '.'),
        h('li', {}, 'The producer can switch the design animations off in Settings, Overlay, and none plays about a piece that is switched off (no ', code('moment-damage'), ' while the HP bars are off). The design guide (docs/DESIGNING.md) has all of it, with examples.')));
  }

  // Tab inserts two spaces instead of leaving the box
  onKeyDown(event) {
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey) return;
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

  // Whether the box holds text the draft does not have: keys pressed a moment ago (`waiting` to be read), or a mistake. It is not saved.
  get unapplied() {
    return this.input.value !== this.shown;
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

  // Put the style sheet of the draft in the box (an undo, a revert)
  show() {
    clearTimeout(this.timer);
    this.timer = null;
    this.shown = this.model.draft.css;
    this.input.value = this.shown;
    this.input.removeAttribute('aria-invalid');
    this.input.classList.remove('bad');
    this.numbers();
    // (a style sheet written outside OTO can hold something that is not allowed: that is said at once)
    const result = this.shown ? this.check(this.shown) : null;
    if (result && result.error) this.tell(result);
    else this.say('');
  }

  say(text, bad = false) {
    this.status.textContent = text;
    this.status.classList.toggle('bad', bad);
  }

  // What is wrong with the text, in plain words ({ error }), or else the files it names that the design does not have ({ missing }):
  // the overlay leaves those out
  check(text) {
    const held = this.model.fileRefs();
    const missing = [];
    try {
      CSS.sanitizeCss(text, { strict: true, resolve: (ref) => { if (!CSS.heldFile(ref, held) && !missing.includes(ref)) missing.push(ref); return ref; } });
    } catch (error) {
      if (error instanceof CSS.CssError) return { error: error.message };
      throw error;
    }
    return { missing };
  }

  // Say what the overlay does with the style sheet it has: what is not allowed in one written outside OTO, and the files the design
  // does not have, are left out
  tell({ error, missing }) {
    if (error) this.say(`${error} The overlay leaves out what is not allowed.`, true);
    else this.say(missing.length ? `Applied. Not in the design, so left out: ${missing.join(', ')}.` : 'Applied.');
  }

  // Read what was typed: when it is allowed, the overlay follows
  apply() {
    const text = this.input.value;
    const result = this.check(text);
    this.input.classList.toggle('bad', Boolean(result.error));
    if (result.error) {
      this.input.setAttribute('aria-invalid', 'true');
      // (the complaint ends with its own full stop)
      this.say(`${result.error} The overlay keeps the last version that made sense.`, true);
      this.onInput();
      return;
    }
    this.input.removeAttribute('aria-invalid');
    this.tell(result);
    this.shown = text;
    this.model.update({ css: text }, { source: 'css' });
    this.onInput();
  }

  // ---- the pictures

  // The pictures of the design that are for the style sheet: [[key, ref]], by name
  cssPictures() {
    return Object.entries(this.model.files.images).filter(([key]) => THEME.CSS_IMAGE_KEY.test(key)).sort(([a], [b]) => a.localeCompare(b));
  }

  drawPictures() {
    const pictures = this.cssPictures();
    this.count.textContent = `${pictures.length} of ${THEME.CSS_IMAGE_MAX}`;
    this.add.disabled = pictures.length >= THEME.CSS_IMAGE_MAX;
    this.pictures.textContent = '';
    if (!pictures.length) {
      this.pictures.appendChild(h('p', { class: 'empty' }, 'None yet.'));
      return;
    }
    for (const [key, ref] of pictures) {
      this.pictures.appendChild(h('div', { class: 'css-picture', dataset: { key } },
        h('div', { class: 'image-preview' }, h('img', { src: this.assetUrl(ref), alt: '' })),
        h('div', { class: 'image-info' },
          h('strong', {}, key),
          h('small', {}, code(`var(--${key})`), ' or ', code(`url(${ref})`)),
          h('div', { class: 'button-row' },
            h('button', { class: 'btn tiny', type: 'button', 'aria-label': `Replace ${key}`, onclick: () => this.upload(key) }, icon('upload', 14), 'Replace'),
            h('button', { class: 'btn tiny', type: 'button', 'aria-label': `Remove ${key}`, onclick: () => this.removePicture(key) }, icon('trash', 14), 'Remove')))));
    }
  }

  // Ask for the name of a new picture, then for the picture
  async addPicture() {
    const taken = this.cssPictures().map(([key]) => key);
    const name = await promptDialog({
      title: 'Add a picture for the style sheet', label: 'Name of the picture', placeholder: 'texture', confirmLabel: 'Choose the picture', maxLength: 36,
      message: 'The style sheet uses the picture by this name: a name such as "texture" is var(--css-texture), or url(images/css-texture.png).',
      check: (value) => {
        const key = `css-${value.toLowerCase().replace(/^css-/, '')}`;
        if (value && !THEME.CSS_IMAGE_KEY.test(key)) return 'Use letters from a to z, digits and dashes (32 at most), starting with a letter or a digit';
        return taken.includes(key) ? 'The style sheet has a picture with that name already: use its Replace button' : '';
      }
    });
    if (!name) return;
    await this.upload(`css-${name.toLowerCase().replace(/^css-/, '')}`);
  }

  // ---- the moments

  play() {
    const entry = MOMENTS.find((item) => item.key === this.moment.value);
    if (!entry) return;
    const side = this.side.value;
    let target = entry.target;
    // The trackers of what is used each turn are hidden for the trainer who does not have the turn (.token.off-turn): a Supporter
    // played by that one is tried on a marker that is drawn, the GX or the VSTAR one
    if (entry.key === 'used') {
      const state = this.canvas.sample ? this.canvas.sample() : null;
      const trainer = state && state[side === 'a' ? 'trainerA' : 'trainerB'];
      const display = (state && state.settings && state.settings.display) || {};
      if (!(trainer && trainer.isTurn && display.supporterCounter !== false)) {
        if (display.gxMarker !== false) target = 'token-gx';
        else if (display.vstarMarker !== false) target = 'token-vstar';
      }
    }
    this.canvas.playMoment(entry.moment || entry.key, side, target, entry.amount);
  }
}
