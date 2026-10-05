/**
 * .oto packages in the control panel: installing one (from a file, a drop, or a double-click in the
 * desktop app) and saving one. A package holds a design (colors, pictures, font, sounds) and/or the
 * control settings (what the overlay shows, how long announcements stay, sound settings).
 */
import { h } from './dom.js';
import { openModal, closeModal, toast } from './ui.js';

async function request(method, url, body, headers = {}) {
  const response = await fetch(url, { method, headers: body === undefined ? headers : { 'Content-Type': 'application/octet-stream', ...headers }, body });
  let data = null;
  try { data = await response.json(); } catch (error) { /* an empty answer */ }
  if (!response.ok) throw new Error((data && data.error) || `Something went wrong (${response.status})`);
  return data;
}

// The control panel says who is installing, so the other producers see a name in the activity feed
const whoIs = (app) => ({
  'X-OTO-Client': app.conn.clientId,
  'X-OTO-Name': encodeURIComponent((app.conn.you && app.conn.you.name) || app.conn.name || '')
});

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function choice(label, checked, hint) {
  const input = h('input', { type: 'checkbox', checked });
  const node = h('label', { class: 'switch inline' }, input, h('span', { class: 'track' }), h('span', { class: 'switch-label' }, label, hint && h('small', {}, hint)));
  return { node, input };
}

// What the settings in a package would change, in plain sentences
function controlLines(controls) {
  const lines = [];
  if (controls.hidden.length) lines.push(`Hides: ${controls.hidden.join(', ')}`);
  else if (controls.shown) lines.push('Shows everything on the overlay');
  if (controls.toastSeconds !== undefined || controls.animationSeconds !== undefined) {
    const parts = [];
    if (controls.toastSeconds !== undefined) parts.push(`banners stay ${controls.toastSeconds} s`);
    if (controls.animationSeconds !== undefined) parts.push(`full-screen effects ${controls.animationSeconds} s`);
    lines.push(`Announcements: ${parts.join(', ')}`);
  }
  if (controls.announcementsOff) lines.push(`${plural(controls.announcementsOff, 'announcement')} switched off`);
  if (controls.sound) {
    const sound = controls.sound;
    if (sound.enabled !== undefined) lines.push(sound.enabled ? `Sound effects on${sound.volume !== undefined ? ` at ${sound.volume}%` : ''}` : 'Sound effects off');
    if (sound.mutedCues.length) lines.push(`Muted sounds: ${sound.mutedCues.join(', ')}`);
  }
  return lines.length ? lines : [`${plural(controls.settings, 'setting')}`];
}

// ------------------------------------------------------------------------------------- install

// `source`: a File (from a picker or a drop) or { name, bytes } (from the desktop app, which opened the file).
// An older design file (JSON, with the pictures inside) is installed straight away.
export async function openImportDialog(app, source, { onInstalled } = {}) {
  let bytes;
  try {
    // a File (a picker or a drop), or { name, bytes } handed over by the desktop app. (Careful: a File has a
    // method called bytes() of its own, so ask what it is, not whether it has one.)
    bytes = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : new Uint8Array(source.bytes);
  } catch (error) {
    toast('That file could not be read', 'error');
    return;
  }

  if (/\.json$/i.test(source.name || '')) {
    try {
      const design = JSON.parse(new TextDecoder().decode(bytes));
      const response = await fetch('/api/themes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(design) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'That design could not be imported');
      toast(`Imported the design "${data.name}"`, 'success');
      if (onInstalled) onInstalled({ design: { name: data.name } });
    } catch (error) {
      toast(error instanceof SyntaxError ? 'That is not a design file' : error.message, 'error');
    }
    return;
  }

  let info;
  try {
    info = await request('POST', '/api/packages/inspect', bytes);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }

  const design = info.design;
  const installDesign = design && choice('Install the design', true, [plural(design.images.length, 'picture'), design.font && 'a font', design.sounds.length && plural(design.sounds.length, 'sound'),
    design.layout > 0 && `its own layout (${plural(design.layout, 'piece')} moved)`, design.crop.length > 0 && 'card crop'].filter(Boolean).join(', '));
  const activate = design && choice('Put it on the overlay now', true);
  const useControls = info.controls && choice('Use its control settings', true, 'You can undo this afterwards with Ctrl+Z');

  let replace = false;
  const conflict = design && design.exists && h('div', { class: 'radio-stack', role: 'radiogroup', 'aria-label': 'A design with this name exists' },
    h('p', { class: 'settings-note' }, `You already have a design called "${design.name}".`),
    h('label', { class: 'radio-line' }, h('input', { type: 'radio', name: 'package-conflict', checked: true, onchange: () => { replace = false; } }), h('span', {}, 'Keep both (the new one gets a number)')),
    h('label', { class: 'radio-line' }, h('input', { type: 'radio', name: 'package-conflict', onchange: () => { replace = true; } }), h('span', {}, 'Replace the one I have')));

  const install = h('button', { class: 'btn primary', type: 'button', 'data-autofocus': true }, 'Install');
  const update = () => { install.disabled = !((installDesign && installDesign.input.checked) || (useControls && useControls.input.checked)); };
  for (const part of [installDesign, useControls]) if (part) part.input.addEventListener('change', update);

  install.addEventListener('click', async () => {
    install.disabled = true;
    try {
      const params = new URLSearchParams({
        design: installDesign && installDesign.input.checked ? '1' : '0',
        controls: useControls && useControls.input.checked ? '1' : '0',
        activate: activate && activate.input.checked ? '1' : '0',
        replace: replace ? '1' : '0'
      });
      const result = await request('POST', `/api/packages/install?${params}`, bytes, whoIs(app));
      const said = [];
      if (result.design) said.push(`Installed "${result.design.name}"${result.activated ? ' and put it on the overlay' : ''}`);
      if (result.controlsApplied) said.push('control settings applied (Ctrl+Z undoes them)');
      toast(`${said.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()), 'success', 6000);
      closeModal();
      if (onInstalled) onInstalled(result);
    } catch (error) {
      toast(error.message, 'error');
      update();
    }
  });

  openModal({
    title: `Install "${info.name}"`, size: 'md', name: 'install-package', stacked: true,
    subtitle: [info.author && `by ${info.author}`, info.description].filter(Boolean).join(' · ') || undefined,
    body: h('div', { class: 'package-body' },
      design && h('section', { class: 'package-part' }, h('h3', {}, 'Design'), installDesign.node, activate.node, conflict),
      info.controls && h('section', { class: 'package-part' }, h('h3', {}, 'Control settings'), useControls.node,
        h('ul', { class: 'package-lines' }, controlLines(info.controls).map((line) => h('li', {}, line)))),
      info.ignored.length > 0 && h('p', { class: 'settings-note' }, `${plural(info.ignored.length, 'file')} in the package ${info.ignored.length === 1 ? 'was' : 'were'} not used.`)),
    footer: [h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'), install]
  });
}

// ------------------------------------------------------------------------------------- export

function saveFile(blob, filename) {
  const link = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 0);
}

// Save a package. `design`: the name of the design to put in (or null); asks what else to include.
export async function openExportDialog(app, { design = null } = {}) {
  let hasOwnSounds = false;
  try {
    const sounds = await request('GET', '/api/sounds');
    hasOwnSounds = Object.values(sounds.custom).some((sound) => sound.source === 'custom');
  } catch (error) { /* the option is simply not offered */ }

  const withDesign = design && choice(`The design "${design}"`, true, 'Colors, pictures, font and the sounds that belong to it');
  const withOwnSounds = design && hasOwnSounds && choice('My own sounds as well', false, 'The ones set on the Sounds tab. They replace the design\'s sounds in the file.');
  const withControls = choice('My control settings', true, 'What the overlay shows, how long announcements stay and which sounds play. Never the card API key or the password.');

  const save = h('button', { class: 'btn primary', type: 'button', 'data-autofocus': true }, 'Save the file');
  const update = () => { save.disabled = !((withDesign && withDesign.input.checked) || withControls.input.checked); };
  for (const part of [withDesign, withControls]) if (part) part.input.addEventListener('change', update);

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const params = new URLSearchParams();
      if (withDesign && withDesign.input.checked) params.set('design', design);
      if (withOwnSounds && withOwnSounds.input.checked) params.set('mySounds', '1');
      if (withControls.input.checked) params.set('controls', '1');
      const response = await fetch(`/api/packages/export?${params}`);
      if (!response.ok) throw new Error((await response.json()).error || 'The file could not be made');
      const named = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '');
      saveFile(await response.blob(), named ? named[1] : 'setup.oto');
      toast('Saved. Send the .oto file to anyone who uses OTO, or keep it as a backup.', 'success', 6000);
      closeModal();
    } catch (error) {
      toast(error.message, 'error');
      update();
    }
  });

  openModal({
    title: 'Save a package', size: 'md', name: 'export-package', stacked: true,
    subtitle: 'One .oto file that holds everything you pick. Anyone with OTO can install it in a click.',
    body: h('div', { class: 'package-body' }, withDesign && withDesign.node, withOwnSounds && withOwnSounds.node, withControls.node),
    footer: [h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'), save]
  });
}
