/**
 * Settings > Cards: the card library (Standard, Gym Leader Challenge, Expanded) kept on this computer,
 * and the card pictures saved with it. Progress arrives live from the server; the list is only redrawn
 * when something changes shape, so a click is never lost to a redraw while a download runs.
 */
import { h, replace } from './dom.js';
import { confirmDialog } from './ui.js';

const number = (value) => Number(value).toLocaleString();

function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const megabytes = bytes / 1024 ** 2;
  return `${megabytes < 10 ? Math.max(0.1, megabytes).toFixed(1) : Math.round(megabytes)} MB`;
}

const day = (time) => new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await response.json(); } catch (error) { /* an empty answer */ }
  if (!response.ok) {
    const failure = new Error((data && data.error) || `Something went wrong (${response.status})`);
    failure.data = data;
    throw failure;
  }
  return data;
}

// Rough sizes of a picture on the card image host, for the warning before a big download
const KB_SMALL = 60;
const KB_LARGE = 400;

export function libraryPanels(app) {
  let status = null;
  let shownKey = '';
  let sizes = 'both';
  const libraryBox = h('div', { class: 'library-list' }, h('p', { class: 'library-state' }, 'Loading…'));
  const picturesBox = h('div', { class: 'library-pictures' });
  let live = {}; // the parts that change while a download runs

  const failed = (error) => app.toast(error.message, 'error');
  const job = () => (status && status.job && !status.job.finished ? status.job : null);

  // What decides the shape of the lists: when it changes they are redrawn, otherwise only progress moves
  const shapeOf = (s) => JSON.stringify([
    s.active,
    s.profiles.map((p) => [p.id, p.ready, p.building, p.resumable, p.count, p.builtAt]),
    s.job && [s.job.id, s.job.kind, s.job.finished, s.job.phase],
    s.pictures && [s.pictures.count, s.pictures.bytes]
  ]);

  const percent = (j) => (j.total > 0 ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0);

  const progressBar = (j) => {
    const fill = h('div', { style: { width: `${percent(j)}%` } });
    const label = h('span', { class: 'library-state' });
    const bar = h('div', { class: `progress${j.total > 0 ? '' : ' waiting'}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
    const update = (next) => {
      fill.style.width = `${percent(next)}%`;
      bar.classList.toggle('waiting', next.total === 0);
      bar.setAttribute('aria-valuenow', String(percent(next)));
      label.textContent = `${next.message}${next.total > 0 ? ` ${number(next.done)} of ${number(next.total)}${next.failed ? ` (${number(next.failed)} failed)` : ''}` : ''}`;
    };
    update(j);
    return { node: h('div', {}, bar, label), update };
  };

  const stop = async () => {
    try { await api('POST', '/api/catalog/cancel'); } catch (error) { failed(error); }
  };

  // ---- the libraries

  const choose = async (id) => {
    try { refresh(await api('PUT', '/api/catalog/active', { profile: id })); } catch (error) { failed(error); }
  };

  const start = async (profile) => {
    try {
      const fromExpanded = profile.id === 'glc' && status.profiles.some((p) => p.id === 'expanded' && p.ready);
      if (profile.big && !fromExpanded) {
        const yes = await confirmDialog({
          title: `Download the ${profile.label} library?`,
          message: `It is about ${number(profile.approximate)} cards and can take ten minutes or more. It runs in the background, so you can keep producing, and you can stop it at any time and carry on later.`,
          confirmLabel: 'Download'
        });
        if (!yes) return;
      }
      refresh(await api('POST', `/api/catalog/${profile.id}/download`, { confirm: true }));
    } catch (error) { failed(error); }
  };

  const remove = async (profile) => {
    const yes = await confirmDialog({ title: `Remove the ${profile.label} library?`, message: 'The cards are deleted from this computer. You can download them again later.', confirmLabel: 'Remove', danger: true });
    if (!yes) return;
    try { refresh(await api('DELETE', `/api/catalog/${profile.id}`)); } catch (error) { failed(error); }
  };

  const libraryRow = (profile) => {
    const running = job();
    const mine = running && running.kind === 'library' && running.profile === profile.id ? running : null;
    const last = status.job && status.job.finished && status.job.kind === 'library' && status.job.profile === profile.id && status.job.phase === 'error' ? status.job : null;
    const choosable = profile.ready && !mine;

    let state;
    if (mine) {
      const bar = progressBar(mine);
      live.library = { id: profile.id, update: bar.update };
      state = bar.node;
    } else if (profile.ready) {
      state = h('span', { class: 'library-state' }, `${number(profile.count)} cards · ${size(profile.bytes)} · saved ${day(profile.builtAt)}`);
    } else {
      state = h('span', { class: 'library-state' }, profile.resumable ? 'Stopped part way. It carries on from where it got to.' : `Not downloaded · about ${number(profile.approximate)} cards`);
    }

    const actions = mine
      ? [h('button', { class: 'btn tiny', type: 'button', onclick: stop }, 'Stop')]
      : profile.ready
        ? [h('button', { class: 'btn tiny', type: 'button', disabled: Boolean(running) || undefined, onclick: () => start(profile) }, 'Update'),
          h('button', { class: 'btn tiny danger-text', type: 'button', disabled: Boolean(running) || undefined, onclick: () => remove(profile) }, 'Remove')]
        : [h('button', { class: 'btn tiny primary', type: 'button', disabled: Boolean(running) || undefined, onclick: () => start(profile) }, profile.resumable ? 'Continue' : 'Download')];

    return h('div', { class: `library-row${status.active === profile.id ? ' on' : ''}` },
      h('input', { type: 'radio', name: 'card-library', checked: status.active === profile.id, disabled: !choosable || undefined, 'aria-label': `Search the ${profile.label} library`, onchange: () => choose(profile.id) }),
      h('div', { class: 'library-text' },
        h('div', { class: 'library-name' }, profile.label),
        h('p', {}, profile.description),
        state,
        last && h('p', { class: 'library-error' }, last.message)),
      h('div', { class: 'library-actions' }, actions));
  };

  const onlineRow = () => h('div', { class: `library-row${status.active === null ? ' on' : ''}` },
    h('input', { type: 'radio', name: 'card-library', checked: status.active === null, 'aria-label': 'Search online only', onchange: () => choose(null) }),
    h('div', { class: 'library-text' },
      h('div', { class: 'library-name' }, 'Search online only'),
      h('p', {}, 'Every search asks the card service on the internet. Nothing is kept on this computer.')),
    h('div', {}));

  // ---- the pictures

  const startPictures = async () => {
    try {
      let result;
      try {
        result = await api('POST', '/api/catalog/pictures', { sizes });
      } catch (error) {
        if (!(error.data && error.data.needsConfirm)) throw error;
        const count = error.data.count;
        const megabytes = sizes === 'small' ? (count * KB_SMALL) / 1024 : ((count / 2) * (KB_SMALL + KB_LARGE)) / 1024;
        const yes = await confirmDialog({
          title: 'Save these pictures?',
          message: `That is ${number(count)} pictures, roughly ${size(megabytes * 1024 ** 2)}. It runs in the background and you can stop it at any time.`,
          confirmLabel: 'Save pictures'
        });
        if (!yes) return;
        result = await api('POST', '/api/catalog/pictures', { sizes, confirm: true });
      }
      refresh(result);
    } catch (error) { failed(error); }
  };

  const clearPictures = async () => {
    const yes = await confirmDialog({ title: 'Delete the saved pictures?', message: 'They are saved again the next time a card is shown, or when you save them ahead of time.', confirmLabel: 'Delete', danger: true });
    if (!yes) return;
    try { refresh(await api('DELETE', '/api/catalog/pictures')); } catch (error) { failed(error); }
  };

  const drawPictures = () => {
    const running = job();
    const mine = running && running.kind === 'pictures' ? running : null;
    const library = status.profiles.find((p) => p.id === status.active);
    let progress = null;
    if (mine) {
      const bar = progressBar(mine);
      live.pictures = { update: bar.update };
      progress = bar.node;
    }
    const last = status.job && status.job.finished && status.job.kind === 'pictures' ? status.job : null;

    const choice = (value, label) => h('label', { class: 'radio-line' },
      h('input', { type: 'radio', name: 'picture-sizes', checked: sizes === value, onchange: () => { sizes = value; } }), h('span', {}, label));

    replace(picturesBox,
      h('p', { class: 'library-state' }, status.pictures
        ? `${number(status.pictures.count)} pictures saved · ${size(status.pictures.bytes)}`
        : 'Counting…'),
      h('div', { class: 'library-save' },
        h('div', { class: 'section-label' }, library ? `Save the ${library.label} pictures ahead of time` : 'Save pictures ahead of time'),
        choice('small', 'Small pictures (what the card search shows)'),
        choice('both', 'Small pictures and the full-size card art (what the overlay shows)'),
        h('div', { class: 'button-row' },
          mine
            ? h('button', { class: 'btn', type: 'button', onclick: stop }, 'Stop')
            : h('button', { class: 'btn', type: 'button', disabled: !library || Boolean(running) || undefined, title: library ? '' : 'Choose a card library first', onclick: startPictures }, 'Save pictures'),
          h('button', { class: 'btn danger-text', type: 'button', disabled: Boolean(running) || !status.pictures || status.pictures.count === 0 || undefined, onclick: clearPictures }, 'Delete saved pictures')),
        progress,
        !mine && last && h('p', { class: last.phase === 'error' ? 'library-error' : 'library-state' }, last.message)));
  };

  // ---- keeping up with the server

  const draw = () => {
    shownKey = shapeOf(status);
    live = {};
    replace(libraryBox, [onlineRow(), ...status.profiles.map(libraryRow)]);
    drawPictures();
  };

  function refresh(next) {
    // an answer built before something newer was pushed to this page is out of date
    if (status && next.serial !== undefined && next.serial < status.serial) return;
    const wasRunning = job();
    status = { ...next, pictures: next.pictures || (status && status.pictures) };
    // a picture download that just ended changes the totals: ask for them again
    if (wasRunning && wasRunning.kind === 'pictures' && !job()) reload();
    if (shapeOf(status) !== shownKey) { draw(); return; }
    const running = job();
    if (running && running.kind === 'library' && live.library) live.library.update(running);
    if (running && running.kind === 'pictures' && live.pictures) live.pictures.update(running);
  }

  async function reload() {
    try { refresh(await api('GET', '/api/catalog')); } catch (error) { failed(error); }
  }

  const off = app.conn.on('catalog:progress', refresh);
  reload();

  return { libraryBox, picturesBox, cleanup: off };
}
