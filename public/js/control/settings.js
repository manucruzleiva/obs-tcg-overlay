/**
 * The settings dialog: what the overlay shows, announcements, sounds, the look (themes), cards and
 * general options.
 */
import { h, icon, replace, debounce } from './dom.js';
import { openModal, closeModal, confirmDialog, promptDialog, pickFile } from './ui.js';
import { openDesignEditor } from './design-editor.js';
import { libraryPanels } from './library.js';
import { openImportDialog, openExportDialog } from './packages.js';

const DISPLAY = window.OTO_DISPLAY;
const SOUND = window.OTO_SOUND;
const THEME = window.OTO_THEME;
const GAME = window.OTO_GAME;

// The most the server takes for one picture or font
const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024;

// ------------------------------------------------------------------------------ small controls

function switchControl(label, checked, onChange, { hint } = {}) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  const node = h('label', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', { class: 'switch-label' }, label, hint && h('small', {}, hint)));
  node.input = input;
  return node;
}

function slider({ label, value, min, max, step = 1, format = (v) => v, onInput, onChange, disabled }) {
  const readout = h('output', {}, format(value));
  const input = h('input', { type: 'range', min, max, step, value, disabled: disabled || undefined, 'aria-label': label });
  input.addEventListener('input', () => { readout.textContent = format(Number(input.value)); if (onInput) onInput(Number(input.value)); });
  input.addEventListener('change', () => onChange(Number(input.value)));
  return h('label', { class: 'slider' }, h('span', { class: 'slider-label' }, label), input, readout);
}

async function readError(response) {
  try { return (await response.json()).error; } catch (error) { return `Something went wrong (${response.status})`; }
}

function download(filename, text, type = 'application/json') {
  const link = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 0);
}

const section = (title, ...children) => h('section', { class: 'settings-section' }, h('h3', {}, title), ...children);
const note = (text) => h('p', { class: 'settings-note' }, text);

// -------------------------------------------------------------------------------------- overlay

function overlayTab(app) {
  const settings = app.state.settings;
  const display = settings.display || {};
  const update = (patch) => app.act('action:settings', { action: 'update', ...patch });

  // (a way of drawing something, such as the flag for a nationality, is not a piece to show or hide: these buttons leave it as it is)
  const setAll = (predicate) => update({ display: Object.fromEntries(DISPLAY.KEYS.filter((key) => !DISPLAY.STYLE_KEYS.includes(key)).map((key) => [key, predicate(key)])) });
  const MINIMAL = new Set(['scoreboard', 'matchScore', 'trainerName', 'activePokemon', 'pokemonNames', 'hpBars', 'toasts']);

  const visibility = section('What the overlay shows',
    note('Switch off anything you do not want on stream. It disappears right away and the rest rearranges itself.'),
    h('div', { class: 'button-row' },
      h('button', { class: 'btn', type: 'button', onclick: async () => { await setAll(() => true); app.openSettings('overlay'); } }, 'Show everything'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await setAll((key) => MINIMAL.has(key)); app.openSettings('overlay'); } }, 'Minimal (score, names, Active, HP)')),
    h('div', { class: 'option-groups' }, DISPLAY.GROUPS.map((group) => h('fieldset', { class: 'option-group' },
      h('legend', {}, group.label),
      group.options.map((option) => switchControl(option.label, display[option.key] !== false, (on) => update({ display: { [option.key]: on } })))))));

  // The hype moments, each with the switches it has: its banner, its full-screen effect and (a knock out) the effect for a bench Pokémon.
  // The pause only has a banner: the one that stays while the game is paused, and the short one when it is resumed.
  const moments = [
    { label: 'Game start', banner: 'enableStartGameToast', effect: 'enableStartGameAnimation' },
    { label: 'Top Deck', banner: 'enableTopDeckToast', effect: 'enableTopDeckAnimation' },
    { label: 'Attack', banner: 'enableAttackToast', effect: 'enableAttackAnimation' },
    { label: 'Pass turn', banner: 'enablePassTurnToast', effect: 'enablePassTurnAnimation' },
    { label: 'Knock out · Trainer A', banner: 'enableTrainerAKOToast', effect: 'enableTrainerAKOAnimation', bench: 'enableTrainerAKO_OOC_Animation' },
    { label: 'Knock out · Trainer B', banner: 'enableTrainerBKOToast', effect: 'enableTrainerBKOAnimation', bench: 'enableTrainerBKO_OOC_Animation' },
    { label: 'Victory · Trainer A', banner: 'enableTrainerAWinToast', effect: 'enableTrainerAWinAnimation' },
    { label: 'Victory · Trainer B', banner: 'enableTrainerBWinToast', effect: 'enableTrainerBWinAnimation' },
    { label: 'Game pause', banner: 'enablePauseToast' }
  ];
  const KIND_LABEL = { banner: 'Banner', effect: 'Effect', bench: 'Effect for a bench KO' };
  const boxes = []; // every switch of the table: { moment, kind, key, input }
  const masters = { rows: new Map(), columns: {}, everything: null }; // the checkboxes that switch several at once

  // A master shows on when all of its switches are on, off when none is, and in between (a dash) when some are
  const refreshMasters = () => {
    const show = (input, list) => {
      const on = list.filter((box) => box.input.checked).length;
      input.checked = list.length > 0 && on === list.length;
      input.indeterminate = on > 0 && on < list.length;
    };
    for (const [moment, input] of masters.rows) show(input, boxes.filter((box) => box.moment === moment));
    for (const [kind, input] of Object.entries(masters.columns)) show(input, boxes.filter((box) => box.kind === kind));
    show(masters.everything, boxes);
  };
  // Switch these on or off together: one change to the settings for all of them
  const setMany = (list, on) => {
    const changed = list.filter((box) => box.input.checked !== on);
    for (const box of changed) box.input.checked = on;
    refreshMasters();
    if (changed.length) update(Object.fromEntries(changed.map((box) => [box.key, on])));
  };
  const check = (moment, kind) => {
    const key = moment[kind];
    if (!key) return h('span', { class: 'muted' }, '–');
    const input = h('input', { type: 'checkbox', checked: settings[key] !== false, 'aria-label': `${moment.label}: ${KIND_LABEL[kind].toLowerCase()}` });
    const box = { moment, kind, key, input };
    boxes.push(box);
    // (one switch says what it is now: it is not compared with itself, as the masters' switches are)
    input.addEventListener('change', () => { refreshMasters(); update({ [key]: input.checked }); });
    return input;
  };
  const master = (label, list) => {
    const input = h('input', { type: 'checkbox', 'aria-label': label });
    input.addEventListener('change', () => setMany(list(), input.checked));
    return input;
  };

  const momentRows = moments.map((moment) => {
    const cells = ['banner', 'effect', 'bench'].map((kind) => h('td', {}, check(moment, kind)));
    const all = master(`${moment.label}: everything`, () => boxes.filter((box) => box.moment === moment));
    masters.rows.set(moment, all);
    return h('tr', {}, h('th', { scope: 'row' }, moment.label), ...cells, h('td', { class: 'all-cell' }, all));
  });
  // The first row switches a whole column: every banner, every effect, every bench effect, or everything
  const allRow = h('tr', { class: 'all-row' },
    h('th', { scope: 'row' }, 'All moments'),
    ...['banner', 'effect', 'bench'].map((kind) => {
      masters.columns[kind] = master(`All: ${KIND_LABEL[kind].toLowerCase()}`, () => boxes.filter((box) => box.kind === kind));
      return h('td', {}, masters.columns[kind]);
    }),
    h('td', { class: 'all-cell' }, (masters.everything = master('All: everything', () => boxes))));
  refreshMasters();

  const announcements = section('Announcements',
    note('Each hype moment can show a banner, a full-screen effect, or both. The All column switches a whole row, and the All moments row a whole column.'),
    h('table', { class: 'grid-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Moment'), h('th', {}, 'Banner'), h('th', {}, 'Effect'), h('th', {}, 'Effect for a bench KO'), h('th', {}, 'All'))),
      h('tbody', {}, allRow, ...momentRows)),
    h('div', { class: 'slider-stack' },
      slider({ label: 'Banner stays for', value: settings.toastSeconds ?? 2, min: 1, max: 30, step: 0.5, format: (v) => `${v} s`, onChange: (v) => update({ toastSeconds: v }) }),
      slider({ label: 'Effect stays for', value: settings.animationSeconds ?? 3, min: 1, max: 30, step: 0.5, format: (v) => `${v} s`, onChange: (v) => update({ animationSeconds: v }) })));

  const picture = section('Picture',
    slider({ label: 'Overlay opacity', value: settings.overlayOpacity ?? 100, min: 0, max: 100, step: 5, format: (v) => `${v}%`, onChange: (v) => update({ overlayOpacity: v }) }),
    switchControl('Scale the overlay to fit the browser source', settings.autoScale !== false, (on) => update({ autoScale: on }),
      { hint: 'Turn off only if the browser source is exactly 1920 × 1080' }));

  return h('div', { class: 'settings-stack' }, visibility, screensSection(app), announcements, picture);
}

// ----------------------------------------------------------------------------------- more overlays

// Every overlay shows the same game. Besides the main one (/overlay) there can be screens: another overlay in OBS with its own design (a vertical
// one for a phone, say) and its own switches. Each has an address of its own.
function screensSection(app) {
  const screens = () => (app.state.settings.screens || []);
  const body = h('div', { class: 'screen-list' });
  let designs = [];
  const save = async (next) => {
    const result = await app.act('action:settings', { action: 'update', screens: next });
    if (result.ok) draw();
  };
  const change = (id, patch) => save(screens().map((screen) => (screen.id === id ? { ...screen, ...patch } : screen)));
  const addressOf = (screen) => `${window.location.origin}/overlay?screen=${encodeURIComponent(screen.id)}`;

  const add = async () => {
    const name = await promptDialog({
      title: 'Add an overlay', label: 'Name of the overlay', placeholder: 'Vertical', confirmLabel: 'Add', maxLength: DISPLAY.SCREEN_LIMITS.nameLength,
      message: 'It has an address of its own to put in OBS. Choose its design (a mobile one, for a vertical stream) and what it shows when it is added.',
      check: (value) => (screens().some((screen) => screen.name.toLowerCase() === value.toLowerCase()) ? 'You have an overlay with that name' : '')
    });
    if (!name) return;
    const id = DISPLAY.screenId(name, screens().map((screen) => screen.id));
    await save([...screens(), { id, name, design: null, display: {}, sound: false }]);
  };

  const remove = async (screen) => {
    if (!(await confirmDialog({ title: `Remove "${screen.name}"?`, message: 'The address of this overlay stops showing anything: the browser source in OBS would be empty.', confirmLabel: 'Remove', danger: true }))) return;
    await save(screens().filter((entry) => entry.id !== screen.id));
  };

  const card = (screen) => {
    const name = h('input', { type: 'text', maxlength: DISPLAY.SCREEN_LIMITS.nameLength, value: screen.name, 'aria-label': `Name of the overlay ${screen.name}` });
    name.addEventListener('change', () => { if (name.value.trim() && name.value.trim() !== screen.name) change(screen.id, { name: name.value.trim() }); else name.value = screen.name; });
    const design = h('select', { 'aria-label': `Design of ${screen.name}` },
      h('option', { value: '' }, 'The same as the main overlay'),
      designs.map((entry) => h('option', { value: entry }, entry)),
      // a design that is gone is still said
      screen.design && !designs.includes(screen.design) && h('option', { value: screen.design }, `${screen.design} (not found)`));
    design.value = screen.design || '';
    design.addEventListener('change', () => change(screen.id, { design: design.value || null }));
    const sound = switchControl('Plays the sound effects', screen.sound === true, (on) => change(screen.id, { sound: on }), { hint: 'The main overlay plays them: two overlays together would play every sound twice' });
    const overrides = Object.keys(screen.display || {}).length;
    return h('div', { class: 'screen-card', dataset: { screen: screen.id } },
      h('div', { class: 'screen-head' }, name,
        h('button', { class: 'round-btn small', type: 'button', title: 'Remove this overlay', 'aria-label': `Remove ${screen.name}`, onclick: () => remove(screen) }, icon('trash', 14))),
      h('div', { class: 'screen-address' },
        h('code', {}, addressOf(screen)),
        h('button', { class: 'btn tiny', type: 'button', onclick: async () => { await app.copyText(addressOf(screen)); app.toast('Address copied. Paste it in a browser source in OBS.', 'success'); } }, 'Copy'),
        h('button', { class: 'btn tiny', type: 'button', onclick: () => window.open(addressOf(screen), '_blank') }, 'Open')),
      h('label', { class: 'field' }, h('span', {}, 'Design'), design),
      h('div', { class: 'screen-options' },
        h('button', { class: 'btn', type: 'button', onclick: () => openScreenOptions(app, screen.id, draw) }, overrides ? `What it shows (${overrides} different)` : 'What it shows'),
        h('small', {}, overrides ? 'Different from the main overlay in some things' : 'The same as the main overlay')),
      sound);
  };

  const draw = () => {
    const list = screens();
    replace(body,
      h('div', { class: 'screen-card main' }, h('strong', {}, 'Main overlay'), h('div', { class: 'screen-address' }, h('code', {}, `${window.location.origin}/overlay`),
        h('button', { class: 'btn tiny', type: 'button', onclick: async () => { await app.copyText(`${window.location.origin}/overlay`); app.toast('Address copied.', 'success'); } }, 'Copy'))),
      list.map(card),
      h('div', { class: 'button-row' }, h('button', { class: 'btn', type: 'button', disabled: list.length >= DISPLAY.SCREEN_LIMITS.max || undefined, onclick: add }, icon('plus', 16), 'Add an overlay'),
        list.length >= DISPLAY.SCREEN_LIMITS.max && h('small', {}, `Up to ${DISPLAY.SCREEN_LIMITS.max} more`)));
  };

  // the designs there are, for the choice of a design
  draw();
  fetch('/api/themes').then((response) => response.json()).then((data) => { designs = data.names || []; draw(); }).catch(() => {});

  return section('More overlays',
    note('Every overlay shows the same game. Add one for a second stream, a vertical one for a phone for example: it has an address of its own to use in OBS, a design of its own (a mobile design is tall) and its own switches.'),
    body);
}

// What one of the extra overlays shows: for each piece of the overlay the same as the main overlay, or shown, or hidden
function openScreenOptions(app, id, redraw = () => {}) {
  const find = () => (app.state.settings.screens || []).find((screen) => screen.id === id);
  const screen = find();
  if (!screen) return;
  const body = h('div', { class: 'option-groups' });
  const set = async (key, value) => {
    const current = find();
    if (!current) return;
    const display = { ...current.display };
    if (value === 'same') delete display[key]; else display[key] = value === 'show';
    await app.act('action:settings', { action: 'update', screens: (app.state.settings.screens || []).map((entry) => (entry.id === id ? { ...entry, display } : entry)) });
    redraw();
  };
  for (const group of DISPLAY.GROUPS) {
    body.appendChild(h('fieldset', { class: 'option-group' }, h('legend', {}, group.label), group.options.map((option) => {
      const mine = screen.display[option.key];
      const select = h('select', { 'aria-label': option.label, dataset: { option: option.key } },
        h('option', { value: 'same' }, `Same as the main overlay (${(app.state.settings.display || {})[option.key] === false ? 'hidden' : 'shown'})`),
        h('option', { value: 'show' }, 'Shown'),
        h('option', { value: 'hide' }, 'Hidden'));
      select.value = mine === undefined ? 'same' : mine ? 'show' : 'hide';
      select.addEventListener('change', () => set(option.key, select.value));
      return h('label', { class: 'screen-option' }, h('span', {}, option.label), select);
    })));
  }
  openModal({
    title: `What "${screen.name}" shows`, subtitle: 'Anything left on "the same" follows the main overlay', size: 'lg', name: 'screen-options', stacked: true, body, onClose: redraw,
    footer: [
      h('button', { class: 'btn', type: 'button', onclick: async () => { const current = find(); if (current) await app.act('action:settings', { action: 'update', screens: (app.state.settings.screens || []).map((entry) => (entry.id === id ? { ...entry, display: {} } : entry)) }); closeModal(); } }, 'Make it all the same as the main overlay'),
      h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Done')
    ]
  });
}

// --------------------------------------------------------------------------------------- sounds

function soundsTab(app) {
  const update = (patch) => app.act('action:settings', { action: 'update', sound: patch });
  const body = h('div', { class: 'settings-stack' });
  let custom = {};

  const play = (cue) => {
    // Auditioning uses the cue's own volume and works even while sound is switched off
    app.sfx.play(cue, app.state.settings.sound || SOUND.DEFAULTS, true);
  };

  const refreshCustom = async () => {
    try {
      custom = (await (await fetch('/api/sounds')).json()).custom;
      await app.sfx.setCustom(custom);
    } catch (error) { custom = {}; }
  };

  const upload = async (cue) => {
    const file = await pickFile('audio/*,.mp3,.wav,.ogg,.m4a,.webm');
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) { app.toast('That file is larger than 1.5 MB. Use a shorter sound.', 'warning'); return; }
    const response = await fetch(`/api/sounds/${cue}`, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!response.ok) { app.toast(await readError(response), 'error'); return; }
    app.toast('Sound uploaded', 'success');
    await refreshCustom();
    draw();
    play(cue);
  };

  const remove = async (cue) => {
    const response = await fetch(`/api/sounds/${cue}`, { method: 'DELETE' });
    if (!response.ok) { app.toast(await readError(response), 'error'); return; }
    await refreshCustom();
    draw();
  };

  const draw = () => {
    const current = app.state.settings.sound || SOUND.DEFAULTS;
    replace(body,
      section('Sound effects',
        note('Sounds play from the overlay, so OBS picks them up as browser source audio (switch on "Control audio via OBS" if you want them on their own audio track). They stay off until you turn them on here.'),
        switchControl('Play sound effects', current.enabled, async (on) => { await update({ enabled: on }); draw(); }),
        slider({ label: 'Master volume', value: current.volume, min: 0, max: 100, step: 5, format: (v) => `${v}%`, onChange: (v) => update({ volume: v }) })),
      SOUND.GROUPS.map((group) => section(group.label, h('div', { class: 'cue-list' }, group.cues.map((cue) => {
        const event = (current.events && current.events[cue.key]) || SOUND.DEFAULTS.events[cue.key];
        const sound = custom[cue.key];
        // a sound may come from the design on the overlay; the producer's own upload replaces it
        const mine = sound && sound.source !== 'design';
        return h('div', { class: `cue-row${event.enabled ? '' : ' off'}` },
          switchControl(cue.label, event.enabled, (on) => update({ events: { [cue.key]: { enabled: on } } })),
          // always a cell here, so every row lines up whether or not it has a badge
          sound ? h('span', { class: 'custom-badge', title: `${Math.round(sound.size / 1024)} KB` }, mine ? 'Your sound' : 'From the design') : h('span', {}),
          slider({ label: 'Volume', value: event.volume, min: 0, max: 100, step: 5, format: (v) => `${v}%`, onChange: (v) => update({ events: { [cue.key]: { volume: v } } }) }),
          h('div', { class: 'cue-actions' },
            h('button', { class: 'btn tiny', type: 'button', onclick: () => play(cue.key), 'aria-label': `Play ${cue.label}` }, icon('play', 14), 'Test'),
            h('button', { class: 'btn tiny', type: 'button', onclick: () => upload(cue.key) }, icon('upload', 14), mine ? 'Replace' : 'Use my own'),
            mine && h('button', { class: 'btn tiny', type: 'button', onclick: () => remove(cue.key) }, icon('trash', 14), 'Remove')));
      })))));
  };

  refreshCustom().then(draw);
  draw();
  return body;
}

// ---------------------------------------------------------------------------------------- designs

function themesTab(app) {
  const root = h('div', { class: 'theme-editor' });
  const status = h('span', { class: 'save-status' });
  let names = [];
  let active = null;
  let selected = null;
  let theme = null;
  let own = {}; // cues the producer set a sound for on the Sounds tab: those win over the design's

  const json = async (method, path, body) => {
    const response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  };

  // A picture, the font or a sound goes up as the file itself
  const sendFile = async (path, file) => {
    const response = await fetch(path, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  };

  const here = (path) => `/api/themes/${encodeURIComponent(theme.name)}${path}`;
  const assetUrl = (ref) => `${here(`/assets/${ref}`)}?v=${theme.version}`;

  const refresh = async (select) => {
    await save.flush(); // what was just typed goes up before the screen is rebuilt from the server
    const data = await json('GET', '/api/themes');
    names = data.names;
    active = data.active;
    selected = select !== undefined ? select : (names.includes(selected) ? selected : (active || names[0] || null));
    theme = selected ? await json('GET', `/api/themes/${encodeURIComponent(selected)}`) : null;
    try {
      own = Object.fromEntries(Object.entries((await json('GET', '/api/sounds')).custom).filter(([, sound]) => sound.source === 'custom'));
    } catch (error) { own = {}; }
    draw();
  };

  // Colors, author and description save by themselves; files go up the moment they are chosen
  let pending = false; // something typed that has not been saved yet
  const savedText = () => (selected === active ? 'Saved and live on the overlay' : 'Saved');
  const save = debounce(async () => {
    if (!theme) return;
    pending = false;
    status.textContent = 'Saving…';
    try {
      await json('PUT', here(''), { colors: theme.colors, author: theme.author || '', description: theme.description || '', fontFamilies: theme.fontFamilies || {} });
      if (!pending) status.textContent = savedText();
    } catch (error) {
      status.textContent = '';
      app.toast(error.message, 'error');
    }
  }, 700);

  const edit = (change) => { change(); pending = true; status.textContent = 'Unsaved changes…'; save(); };

  // Run a change that goes to the server at once, and keep what is still being typed
  const change = async (work) => {
    status.textContent = 'Saving…';
    try {
      const saved = await work();
      theme = { ...saved, colors: theme.colors, author: theme.author, description: theme.description, fontFamilies: theme.fontFamilies };
      status.textContent = pending ? 'Unsaved changes…' : savedText();
      draw();
    } catch (error) {
      status.textContent = pending ? 'Unsaved changes…' : '';
      app.toast(error.message, 'error');
    }
  };

  const defaultOf = (key) => getComputedStyle(document.documentElement).getPropertyValue(key).trim();

  const colorRow = (color) => {
    const text = h('input', { type: 'text', value: theme.colors[color.key] || '', placeholder: defaultOf(color.key), 'aria-label': color.label });
    const swatch = h('input', { type: 'color', 'aria-label': `${color.label} picker` });
    const syncSwatch = () => {
      const value = (text.value || defaultOf(color.key)).trim();
      swatch.value = /^#[0-9a-f]{6}$/i.test(value) ? value : /^#[0-9a-f]{3}$/i.test(value) ? `#${value.slice(1).split('').map((c) => c + c).join('')}` : '#808080';
      swatch.disabled = !/^#[0-9a-f]{3,6}$/i.test(value) && value !== '';
    };
    text.addEventListener('input', () => edit(() => { if (text.value.trim()) theme.colors[color.key] = text.value.trim(); else delete theme.colors[color.key]; syncSwatch(); }));
    swatch.addEventListener('input', () => { text.value = swatch.value; text.dispatchEvent(new Event('input')); });
    syncSwatch();
    return h('div', { class: 'color-row' }, h('span', {}, color.label), h('div', { class: 'color-inputs' }, swatch, text));
  };

  const imageRow = (image) => {
    const ref = theme.images[image.key];
    return h('div', { class: 'image-row' },
      h('div', { class: 'image-preview' }, ref ? h('img', { src: assetUrl(ref), alt: '' }) : h('span', { class: 'muted' }, 'None')),
      h('div', { class: 'image-info' }, h('strong', {}, image.label), h('small', {}, image.help),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn tiny', type: 'button', onclick: async () => {
            const file = await pickFile('image/png,image/jpeg,image/gif,image/webp,image/svg+xml');
            if (!file) return;
            if (file.size > MAX_UPLOAD_BYTES) { app.toast('That picture is larger than 4.5 MB. Use a smaller one.', 'warning'); return; }
            change(() => sendFile(here(`/images/${image.key}`), file));
          } }, icon('upload', 14), ref ? 'Replace' : 'Upload'),
          ref && h('button', { class: 'btn tiny', type: 'button', onclick: () => change(() => json('DELETE', here(`/images/${image.key}`))) }, icon('trash', 14), 'Remove'))));
  };

  const fontRow = () => h('div', { class: 'image-row', dataset: { role: 'display' } },
    h('div', { class: 'image-preview font-sample' }, theme.font ? h('span', {}, 'Aa') : h('span', { class: 'muted' }, 'None')),
    h('div', { class: 'image-info' }, h('strong', {}, 'Main font'), h('small', {}, 'Used for names, numbers and announcements (WOFF2, WOFF, TTF or OTF). A font for each kind of text is in the editor, on the Fonts tab.'),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn tiny', type: 'button', onclick: async () => {
          const file = await pickFile('.woff2,.woff,.ttf,.otf,font/*');
          if (!file) return;
          if (file.size > MAX_UPLOAD_BYTES) { app.toast('That font file is larger than 4.5 MB.', 'warning'); return; }
          change(() => sendFile(here('/font'), file));
        } }, icon('upload', 14), theme.font ? 'Replace' : 'Upload'),
        theme.font && h('button', { class: 'btn tiny', type: 'button', onclick: () => change(() => json('DELETE', here('/font'))) }, icon('trash', 14), 'Remove'))));

  const soundRow = (cue) => {
    const ref = theme.sounds[cue.key];
    return h('div', { class: 'sound-row' },
      h('span', { class: 'sound-name' }, cue.label, ref && own[cue.key] && h('small', {}, ' · your own sound plays instead')),
      h('span', { class: 'cue-actions' },
        ref && h('button', { class: 'btn tiny', type: 'button', 'aria-label': `Play ${cue.label}`, onclick: () => { new Audio(assetUrl(ref)).play().catch(() => {}); } }, icon('play', 14), 'Test'),
        h('button', { class: 'btn tiny', type: 'button', onclick: async () => {
          const file = await pickFile('audio/*,.mp3,.wav,.ogg,.m4a,.webm');
          if (!file) return;
          if (file.size > 1.5 * 1024 * 1024) { app.toast('That file is larger than 1.5 MB. Use a shorter sound.', 'warning'); return; }
          await change(() => sendFile(here(`/sounds/${cue.key}`), file));
          new Audio(assetUrl(theme.sounds[cue.key])).play().catch(() => {});
        } }, icon('upload', 14), ref ? 'Replace' : 'Upload'),
        ref && h('button', { class: 'btn tiny', type: 'button', onclick: () => change(() => json('DELETE', here(`/sounds/${cue.key}`))) }, icon('trash', 14), 'Remove')));
  };

  const groups = [...new Set(THEME.COLORS.map((color) => color.group))];

  const field = (label, value, max, onInput) => {
    const input = h('input', { type: 'text', maxlength: max, value: value || '', 'aria-label': label });
    input.addEventListener('input', () => edit(() => onInput(input.value)));
    return h('label', { class: 'field' }, h('span', {}, label), input);
  };

  const draw = () => {
    const list = h('div', { class: 'theme-list' },
      h('button', { class: `theme-item${active === null ? ' live' : ''}`, type: 'button', onclick: async () => { await json('POST', '/api/theme/active', { name: null }); app.toast('The overlay is using the built-in look', 'success'); refresh(selected); } },
        h('strong', {}, 'Built-in look'), active === null && h('span', { class: 'live-tag' }, 'On the overlay')),
      names.map((name) => h('button', { class: `theme-item${name === selected ? ' on' : ''}${name === active ? ' live' : ''}`, type: 'button', onclick: () => refresh(name) },
        h('strong', {}, name), name === active && h('span', { class: 'live-tag' }, 'On the overlay'))),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => newTheme() }, icon('plus', 16), 'New'),
        h('button', { class: 'btn', type: 'button', title: 'A design with every color of the built-in look written out, to learn from and change', onclick: () => newTheme({ fromBuiltIn: true }) }, icon('layout', 16), 'Copy of the built-in look'),
        h('button', { class: 'btn', type: 'button', onclick: importPackage }, icon('upload', 16), 'Install a .oto')));

    const editor = theme
      ? h('div', { class: 'theme-form' },
        h('div', { class: 'theme-head' },
          h('h3', {}, theme.name), status,
          h('div', { class: 'button-row' },
            h('button', { class: 'btn primary', type: 'button', disabled: selected === active || undefined, onclick: async () => { await json('POST', '/api/theme/active', { name: selected }); app.toast(`"${selected}" is on the overlay`, 'success'); refresh(selected); } }, selected === active ? 'On the overlay' : 'Put on the overlay'),
            h('button', { class: 'btn', type: 'button', onclick: () => openEditor(selected) }, icon('layout', 16), 'Layout and crop'),
            h('button', { class: 'btn', type: 'button', onclick: () => openExportDialog(app, { design: selected }) }, icon('share', 16), 'Save as .oto'),
            h('button', { class: 'btn danger-text', type: 'button', onclick: removeTheme }, icon('trash', 16), 'Delete'))),
        note('Changes save by themselves. If this design is on the overlay, you see them on stream as you make them. Leave a color empty to keep the built-in one.'),
        h('div', { class: 'theme-meta' },
          field('Made by', theme.author, 60, (value) => { theme.author = value; }),
          field('About this design', theme.description, 300, (value) => { theme.description = value; })),
        groups.map((group) => h('fieldset', { class: 'option-group' }, h('legend', {}, group), THEME.COLORS.filter((color) => color.group === group).map(colorRow))),
        // (the frame of a reserved space is listed when the design has that space, or still has the picture)
        h('fieldset', { class: 'option-group' }, h('legend', {}, 'Pictures and font'), THEME.IMAGES.filter((image) => !image.space || theme.images[image.key] || (theme.spaces || []).some((space) => space.id === image.space)).map(imageRow), fontRow()),
        h('fieldset', { class: 'option-group' }, h('legend', {}, 'Sounds'),
          note('These play while this design is on the overlay, once sound effects are switched on in Settings > Sounds. A sound you set yourself on the Sounds tab plays instead of the design\'s for that moment.'),
          SOUND.GROUPS.map((group) => h('div', { class: 'design-sounds' }, h('div', { class: 'section-label' }, group.label), group.cues.map(soundRow)))))
      : h('div', { class: 'empty-theme' }, h('h3', {}, 'Make it yours'), note('Create a design to change the colors, add a logo, backgrounds, avatars, a font and sounds, then share it with others as a single .oto file. Until you put a design on the overlay, the built-in look is used.'),
        h('div', { class: 'button-row' }, h('button', { class: 'btn primary', type: 'button', onclick: newTheme }, 'Create a design'), h('button', { class: 'btn', type: 'button', onclick: importPackage }, 'Install a .oto file')));

    replace(root, list, editor);
  };

  // The editor for a design opens over the settings; when it closes after saving, the design is read again
  const openEditor = (designName) => openDesignEditor(app, designName, { onClose: (model) => { if (model.everSaved) refresh(designName).catch((error) => app.toast(error.message, 'error')); } });

  // A new design: an empty one, or (`fromBuiltIn`) a copy of the built-in look, with every color and the fonts written out so they can be changed
  const newTheme = async ({ fromBuiltIn = false } = {}) => {
    // The list of designs may still be on its way, or have changed: ask again, so a name that is taken is never reused
    try { names = (await json('GET', '/api/themes')).names; } catch (error) { /* the check below uses the list it has */ }
    const name = await promptDialog({
      title: fromBuiltIn ? 'Copy of the built-in look' : 'Create a design', label: 'Name of the design', placeholder: fromBuiltIn ? 'My copy' : 'Store League', confirmLabel: 'Create', maxLength: 40,
      message: fromBuiltIn ? 'Every color of the built-in look is written into the new design, so you can see how it is made and change what you like.' : 'Then move the pieces of the overlay, crop the cards and choose colors in the editor.',
      check: (value) => {
        if (value && !/[a-z0-9]/i.test(value)) return 'A name needs at least one letter or digit';
        return names.some((existing) => existing.toLowerCase() === value.toLowerCase()) ? 'You already have a design with that name' : '';
      }
    });
    if (!name) return;
    try {
      const body = fromBuiltIn
        ? {
          colors: Object.fromEntries(THEME.COLORS.map((color) => [color.key, defaultOf(color.key)]).filter(([, value]) => value)),
          fontFamilies: { display: defaultOf('--font-display'), text: defaultOf('--font-body') },
          description: 'A copy of the built-in look'
        }
        : { colors: {} };
      const saved = await json('PUT', `/api/themes/${encodeURIComponent(name)}`, body);
      await refresh(saved.name);
      openEditor(saved.name);
    } catch (error) { app.toast(error.message, 'error'); }
  };

  const importPackage = async () => {
    const file = await pickFile('.oto,.json,application/json');
    if (!file) return;
    openImportDialog(app, file, { onInstalled: (result) => refresh(result.design ? result.design.name : selected).catch((error) => app.toast(error.message, 'error')) });
  };

  const removeTheme = async () => {
    const yes = await confirmDialog({ title: `Delete "${selected}"?`, message: 'The design and its files are removed. Save it as a .oto file first if you may want it back.', confirmLabel: 'Delete', danger: true });
    if (!yes) return;
    try { await json('DELETE', `/api/themes/${encodeURIComponent(selected)}`); } catch (error) { app.toast(error.message, 'error'); }
    await refresh(null);
  };

  refresh().catch((error) => app.toast(error.message, 'error'));
  draw();
  return root;
}

// ---------------------------------------------------------------------------------------- cards

// One credential of a card service. Once it is saved it is shown masked (its first three characters, ***, its last four): the
// key itself never comes back from the server. Until then there is a box to paste it in.
function credentialRow(app, credential, service) {
  const row = h('div', { class: 'credential-row', dataset: { setting: credential.setting } });
  let changing = false;
  const send = (value) => app.act('action:settings', { action: 'update', [credential.setting]: value });
  const name = `${service.label} ${credential.label.toLowerCase()}`;

  const draw = () => {
    const mask = ((app.state.settings.keys || {})[credential.setting]) || '';
    const label = h('span', { class: 'credential-label' }, credential.label, credential.needed && h('small', {}, ' · needed'));
    if (mask && !changing) {
      replace(row, label,
        h('code', { class: 'secret-mask', title: 'Saved. Only the ends are shown.' }, mask),
        h('button', { class: 'btn tiny', type: 'button', 'aria-label': `Change the ${name}`, onclick: () => { changing = true; draw(); } }, 'Change'),
        h('button', {
          class: 'btn tiny danger-text', type: 'button', 'aria-label': `Remove the ${name}`,
          onclick: async () => { if ((await send('')).ok) { app.toast(`The ${name} was removed`, 'success'); draw(); } }
        }, 'Remove'));
      return;
    }
    const input = h('input', { type: 'password', placeholder: `Paste the ${credential.label.toLowerCase()}`, autocomplete: 'off', spellcheck: 'false', 'aria-label': `The ${name}` });
    const save = async () => {
      const value = input.value.trim();
      if (!value) { input.focus(); return; }
      if ((await send(value)).ok) {
        app.toast(`The ${name} was saved`, 'success');
        changing = false;
        draw();
      }
    };
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
    replace(row, label, input,
      h('button', { class: 'btn tiny primary', type: 'button', onclick: save }, 'Save'),
      changing && h('button', { class: 'btn tiny', type: 'button', onclick: () => { changing = false; draw(); } }, 'Cancel'));
  };
  draw();
  return row;
}

function cardsTab(app) {
  const settings = app.state.settings;
  const body = h('div', { class: 'settings-stack' });
  const library = libraryPanels(app);
  body.cleanup = library.cleanup; // stop listening for download progress when this tab goes away

  // Where cards are searched for, and in which language (see PokemonTCGService)
  const update = (patch) => app.act('action:settings', { action: 'update', ...patch });
  const sourceSelect = h('select', { 'aria-label': 'Card source' },
    GAME.CARD_SOURCES.map((entry) => h('option', { value: entry.key, selected: settings.apiProvider === entry.key || undefined }, entry.label)));
  sourceSelect.addEventListener('change', () => update({ apiProvider: sourceSelect.value }));
  const languageSelect = h('select', { 'aria-label': 'Card language' },
    GAME.CARD_LANGUAGES.map(([code, label]) => h('option', { value: code, selected: settings.cardLanguage === code || undefined }, label)));
  languageSelect.addEventListener('change', () => update({ cardLanguage: languageSelect.value }));

  // Which service builds the card libraries; one whose key is missing cannot be chosen yet
  const saved = (service) => service.credentials.filter((entry) => entry.needed).every((entry) => ((app.state.settings.keys || {})[entry.setting] || ''));
  const librarySelect = h('select', { 'aria-label': 'Build the libraries from' },
    GAME.CARD_SERVICES.map((service) => h('option', { value: service.key, selected: settings.librarySource === service.key || undefined, disabled: !saved(service) || undefined },
      saved(service) ? service.label : `${service.label} (needs its key)`)));
  librarySelect.addEventListener('change', () => update({ librarySource: librarySelect.value }));

  const serviceBlock = (service) => h('div', { class: 'service-block', dataset: { service: service.key } },
    h('div', { class: 'service-head' },
      h('strong', {}, service.label),
      h('a', { href: service.site, target: '_blank', rel: 'noopener noreferrer' }, new URL(service.site).host)),
    note(service.note),
    service.credentials.map((credential) => credentialRow(app, credential, service)));

  body.append(
    section('Card services',
      note('Cards are searched for in free services. Automatic asks the Pokémon TCG API and, when it does not answer, TCGdex; or choose one of them. Keys are saved on this computer and shown here with only their ends.'),
      h('div', { class: 'inline-form' },
        h('label', { class: 'field' }, h('span', {}, 'Search in'), sourceSelect),
        h('label', { class: 'field' }, h('span', {}, 'Card language'), languageSelect)),
      note('Only TCGdex has cards in other languages than English. With another language it is asked first, and your English card library below is left out of the search.'),
      GAME.CARD_SERVICES.map(serviceBlock)),
    section('Card library',
      note('Keep a copy of the cards you need on this computer. Searching is instant, keeps working when the internet does not, and never runs into the card service\'s request limits. Pick one to search it; a card it does not have is looked up online.'),
      h('div', { class: 'inline-form' }, h('label', { class: 'field' }, h('span', {}, 'Build the libraries from'), librarySelect)),
      note('Standard can be built from any of the services. Gym Leader Challenge and Expanded need to know which cards are legal in Expanded, which only the Pokémon TCG API tells, so they always come from it.'),
      library.libraryBox),
    section('Card pictures',
      note('A card\'s picture is saved on this computer the first time it is shown, so it still shows without internet. You can also save them all ahead of time.'),
      library.picturesBox),
    section('Most used cards',
      note('The card picker starts from the cards you use most, and from those already saved on this computer, before you type anything.'),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const yes = await confirmDialog({ title: 'Forget the most used cards?', message: 'The picker will start from the cards saved on this computer until you use cards again.', confirmLabel: 'Forget' });
        if (yes) { await fetch('/api/cards/used', { method: 'DELETE' }); app.toast('Forgotten', 'success'); }
      } }, 'Forget')),
    section('Remembered searches',
      note('Searches and cards you have looked up are remembered for a while so they load fast.'),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const yes = await confirmDialog({ title: 'Clear remembered searches?', message: 'Cards will be looked up again the next time you need them.', confirmLabel: 'Clear' });
        if (yes) { await fetch('/api/cache/clear', { method: 'POST' }); app.toast('Cleared', 'success'); }
      } }, 'Clear')));
  return body;
}

// -------------------------------------------------------------------------------------- general

function generalTab(app) {
  const body = h('div', { class: 'settings-stack' });
  const nameInput = h('input', { type: 'text', maxlength: 24, value: (app.conn.you && app.conn.you.name) || '', 'aria-label': 'Your name' });
  const save = () => { if (nameInput.value.trim()) { app.conn.rename(nameInput.value.trim()); app.toast('Name saved', 'success'); } };
  nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); });

  body.append(section('You',
    note('Other producers see this name next to everything you do.'),
    h('div', { class: 'inline-form' }, nameInput, h('button', { class: 'btn', type: 'button', onclick: save }, 'Save name'))));

  // how the Pokémon of the table look in this control panel (the overlay has its own crop, in a design)
  const viewButtons = [['art', 'Art only'], ['full', 'Whole card']].map(([view, label]) => {
    const button = h('button', { class: 'seg', type: 'button', dataset: { view }, onclick: () => { app.setCardView(view); showView(); } }, label);
    return button;
  });
  const showView = () => {
    for (const button of viewButtons) {
      const on = button.dataset.view === app.cardView;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
  };
  showView();
  body.append(section('Pokémon cards here',
    note('What the Active Pokémon and the bench show in this control panel: just the art of the card, or the whole card. This is only for this browser; the overlay has its own crop, which a design sets (Settings, Overlay, Designs).'),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'What the Pokémon cards show in this control panel' }, viewButtons)));

  // password
  const passwordBox = h('div', {});
  const drawPassword = async () => {
    const status = await (await fetch('/api/auth/status')).json();
    const input = h('input', { type: 'password', autocomplete: 'new-password', placeholder: status.required ? 'New password' : 'Choose a password', maxlength: 128, 'aria-label': 'Password' });
    const apply = async (password, message) => {
      const response = await fetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (!response.ok) { app.toast(await readError(response), 'error'); return; }
      app.toast(message, 'success');
      drawPassword();
    };
    replace(passwordBox,
      status.source === 'environment'
        ? note('The password is set by the OTO_PASSWORD environment variable, so it cannot be changed here.')
        : [
          note(status.required
            ? 'A password is set. Anyone opening the control panel has to enter it. The overlay for OBS never needs it.'
            : 'No password is set, so anyone who can reach this address can use the control panel. Any text will do; there are no rules.'),
          h('div', { class: 'inline-form' }, input,
            h('button', { class: 'btn primary', type: 'button', onclick: () => { if (!input.value) { input.focus(); return; } apply(input.value, 'Password saved. Everyone else has to sign in again.'); } }, status.required ? 'Change password' : 'Set password'),
            status.required && h('button', { class: 'btn', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Remove the password?', message: 'Anyone who can reach this address will be able to use the control panel.', confirmLabel: 'Remove', danger: true })) apply('', 'Password removed'); } }, 'Remove')),
          status.required && h('button', { class: 'btn', type: 'button', onclick: async () => { await fetch('/api/logout', { method: 'POST' }); window.location.assign('/login'); } }, 'Sign out')]);
  };
  body.append(section('Password', passwordBox));
  drawPassword();

  // sharing
  const links = h('div', { class: 'link-list' }, h('p', { class: 'muted' }, 'Looking up addresses…'));
  fetch('/api/network').then((response) => response.json()).then((network) => {
    replace(links, network.lan.length === 0
      ? h('p', { class: 'muted' }, network.shared ? 'No network connection found.' : 'The server only accepts connections from this computer (it was started with HOST=127.0.0.1).')
      : network.lan.map((entry) => h('div', { class: 'link-row' },
        h('div', {}, h('strong', {}, entry.control), h('small', {}, `${entry.name} · overlay: ${entry.overlay}`)),
        h('button', { class: 'btn tiny', type: 'button', onclick: async () => { await app.copyText(entry.control); app.toast('Copied', 'success'); } }, 'Copy control link'))));
  });
  body.append(section('Share with another producer', note('Anyone on the same network can open one of these links in a browser to produce together with you.'), links));

  // desktop app
  if (window.electronAPI && window.electronAPI.getAppSettings) {
    const box = h('div', {});
    window.electronAPI.getAppSettings().then((values) => {
      replace(box, switchControl('Keep running in the tray when the window is closed', values.keepInTray, (on) => window.electronAPI.setAppSetting('keepInTray', on),
        { hint: 'The overlay stays live. Right-click the tray icon (next to the clock) to quit.' }));
    });
    body.append(section('This app', box));
  }

  // share a setup as a .oto package
  const fileButton = (label, onFile, accept = '.json,application/json') => h('button', { class: 'btn', type: 'button', onclick: async () => { const file = await pickFile(accept); if (file) onFile(file); } }, icon('upload', 16), label);
  body.append(section('Share your setup',
    note('A .oto file holds a design (colors, pictures, font and sounds) and your control settings: what the overlay shows, how long announcements stay and which sounds play. Share it with other producers, or keep it as a backup. You can also drop a .oto file on this window to install it.'),
    h('div', { class: 'button-row' },
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        let design = null;
        try { design = (await (await fetch('/api/themes')).json()).active; } catch (error) { /* the dialog works without a design */ }
        openExportDialog(app, { design });
      } }, icon('share', 16), 'Save my setup as .oto'),
      fileButton('Install a .oto file', (file) => openImportDialog(app, file), '.oto,.json,application/json'))));

  // backup and reset
  body.append(section('Match backup',
    note('The match, the trainers and every setting as a plain JSON file. The card API key is never included. To share a design or your setup with someone else, use a .oto file above.'),
    h('div', { class: 'button-row' },
      h('button', { class: 'btn', type: 'button', onclick: async () => { const response = await fetch('/api/config/export'); download(`oto-config-${new Date().toISOString().slice(0, 10)}.json`, await response.text()); } }, 'Export match and settings'),
      fileButton('Import match and settings', async (file) => {
        let config;
        try { config = JSON.parse(await file.text()); } catch (error) { app.toast('That is not a configuration file', 'error'); return; }
        if (!(await confirmDialog({ title: 'Import this configuration?', message: 'It replaces the current match and settings. You can undo it afterwards.', confirmLabel: 'Import' }))) return;
        const result = await app.act('action:settings', { action: 'import', config });
        if (result.ok) app.toast('Configuration imported', 'success');
      }))));

  body.append(section('Start over',
    note('Resets the match, the trainers and every setting to how a new install starts. Themes and sounds you uploaded are kept.'),
    h('button', { class: 'btn danger-text', type: 'button', onclick: async () => {
      if (await confirmDialog({ title: 'Reset everything?', message: 'This clears the match and all settings. You can undo it right after.', confirmLabel: 'Reset', danger: true })) {
        const result = await app.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });
        if (result.ok) app.toast('Everything was reset', 'success');
      }
      closeModal();
    } }, 'Reset everything')));

  return body;
}

// ----------------------------------------------------------------------------------------- dialog

const TABS = [
  { id: 'overlay', label: 'Overlay', build: overlayTab },
  { id: 'sounds', label: 'Sounds', build: soundsTab },
  { id: 'themes', label: 'Look', build: themesTab },
  { id: 'cards', label: 'Cards', build: cardsTab },
  { id: 'settings', label: 'General', build: generalTab }
];

export function openSettings(app, tab = 'overlay') {
  const content = h('div', { class: 'settings-content' });
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  let leave = null; // what the tab on show wants done when it goes away
  const show = (id) => {
    if (leave) leave();
    replace(bar, TABS.map((entry) => h('button', { class: `tab${entry.id === id ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(entry.id === id), onclick: () => show(entry.id) }, entry.label)));
    const built = TABS.find((entry) => entry.id === id).build(app);
    leave = built.cleanup || null;
    replace(content, built);
  };
  openModal({
    title: 'Settings', size: 'xl', name: 'settings', body: [bar, content],
    footer: h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Done'),
    onClose: () => { if (leave) leave(); leave = null; }
  });
  show(tab);
}
