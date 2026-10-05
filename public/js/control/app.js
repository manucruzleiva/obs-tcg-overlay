/**
 * The control panel: ties the connection, the views, the dialogs and the keyboard together.
 */
import { Connection } from './connection.js';
import { h, $, append, replace } from './dom.js';
import { toast, openModal, closeModal, isModalOpen, closeAllModals, confirmDialog } from './ui.js';
import { TrainerView } from './trainer-view.js';
import { CenterView } from './center-view.js';
import { TopBar, DraftBanner } from './topbar-view.js';
import * as modals from './modals.js';
import { openSettings } from './settings.js';
import { openImportDialog } from './packages.js';

const NATIONALITIES = ['USA', 'CAN', 'MEX', 'BRA', 'ARG', 'CHL', 'COL', 'PER', 'GBR', 'IRL', 'FRA', 'DEU', 'ESP', 'ITA', 'PRT', 'NLD', 'BEL', 'SWE', 'NOR', 'DNK', 'FIN', 'POL', 'AUT', 'CHE', 'JPN', 'KOR', 'CHN', 'TWN', 'HKG', 'SGP', 'MYS', 'THA', 'IDN', 'PHL', 'VNM', 'IND', 'AUS', 'NZL', 'ZAF'];

// ------------------------------------------------------------------------------------ keyboard

const noMods = (e) => !e.ctrlKey && !e.metaKey && !e.altKey;
const plain = (key) => (e) => noMods(e) && !e.shiftKey && e.key.toLowerCase() === key;
const shifted = (key) => (e) => noMods(e) && e.shiftKey && e.key.toLowerCase() === key;
const ctrl = (...keys) => (e) => (e.ctrlKey || e.metaKey) && !e.altKey && keys.includes(e.key.toLowerCase());

// What each shortcut does. Shortcuts about "the trainer" apply to the focused one: press 1 or 2 to
// choose, and the focus follows the turn on its own.
export const KEYMAP = [
  { group: 'Game', keys: ['Space'], label: 'Pass the turn', test: (e) => noMods(e) && e.key === ' ', run: (app) => app.act('action:match', { action: 'toggleTurn' }) },
  { group: 'Game', keys: ['1'], label: 'Shortcuts apply to Trainer A', test: plain('1'), run: (app) => app.setFocus('trainerA') },
  { group: 'Game', keys: ['2'], label: 'Shortcuts apply to Trainer B', test: plain('2'), run: (app) => app.setFocus('trainerB') },
  { group: 'Game', keys: ['↑', '↓'], label: 'Trainer A takes / gives back a prize card', test: (e) => noMods(e) && !e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key), run: (app, e) => app.act('action:trainerA', { action: e.key === 'ArrowDown' ? 'prizeMinus' : 'prizePlus' }) },
  { group: 'Game', keys: ['Shift', '↑ ↓'], label: 'The same for Trainer B', test: (e) => noMods(e) && e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key), run: (app, e) => app.act('action:trainerB', { action: e.key === 'ArrowDown' ? 'prizeMinus' : 'prizePlus' }) },
  { group: 'Game', keys: ['I'], label: 'Item lock on / off (focused trainer)', test: plain('i'), run: (app) => app.toggleLock('itemLock', 'toggleItemLock') },
  { group: 'Game', keys: ['V'], label: 'Evolution lock on / off (focused trainer)', test: plain('v'), run: (app) => app.toggleLock('evoLock', 'toggleEvoLock') },
  { group: 'Game', keys: ['Shift', 'S'], label: 'Supporter played this turn (focused trainer)', test: shifted('s'), run: (app) => app.toggleSupporter() },

  { group: 'Dialogs', keys: ['A'], label: 'Deploy a new Active Pokémon', test: plain('a'), run: (app) => app.openPicker({ kind: 'active', side: app.focus }) },
  { group: 'Dialogs', keys: ['B'], label: 'Edit the bench', test: plain('b'), run: (app) => app.openBench(app.focus) },
  { group: 'Dialogs', keys: ['D'], label: 'Damage', test: plain('d'), run: (app) => app.openDamage('damage') },
  { group: 'Dialogs', keys: ['H'], label: 'Heal', test: plain('h'), run: (app) => app.openDamage('heal', app.focus) },
  { group: 'Dialogs', keys: ['E'], label: 'Energy (the turn\'s attachment, or a special one)', test: plain('e'), run: (app) => app.openEnergy(app.focus) },
  { group: 'Dialogs', keys: ['K'], label: 'Knock out', test: plain('k'), run: (app) => app.openKO(app.focus) },
  { group: 'Dialogs', keys: ['S'], label: 'Stadium', test: plain('s'), run: (app) => app.openPicker({ kind: 'stadium' }) },
  { group: 'Dialogs', keys: ['X'], label: 'Abilities', test: plain('x'), run: (app) => app.openAbilities(app.focus) },

  { group: 'Hype', keys: ['C'], label: 'Announce an attack', test: plain('c'), run: (app) => app.openAttack() },
  { group: 'Hype', keys: ['T'], label: 'Announce a Top Deck', test: plain('t'), run: (app) => app.act('action:toast', { action: 'topDeck', target: app.focus }) },
  { group: 'Hype', keys: ['P'], label: 'Announce a passed turn', test: plain('p'), run: (app) => app.act('action:toast', { action: 'passTurn' }) },

  { group: 'History', keys: ['Ctrl', 'Z'], label: 'Undo', test: (e) => ctrl('z')(e) && !e.shiftKey, run: (app) => app.undo() },
  { group: 'History', keys: ['Ctrl', 'Y'], label: 'Redo (also Ctrl+Shift+Z)', test: (e) => ctrl('y')(e) || (ctrl('z')(e) && e.shiftKey), run: (app) => app.redo() },
  { group: 'History', keys: ['Ctrl', 'Enter'], label: 'Send your draft to the overlay', test: (e) => ctrl('enter')(e), run: (app) => app.draftShortcut() },

  { group: 'Other', keys: ['?'], label: 'Show these shortcuts', test: (e) => e.key === '?', run: (app) => app.openHelp() },
  { group: 'Other', keys: ['Esc'], label: 'Close a dialog', test: () => false, run: () => {} }
];

// ----------------------------------------------------------------------------------------- app

class App {
  constructor() {
    this.conn = new Connection();
    this.focus = 'trainerA';
    this.keymap = KEYMAP;
    this.sfx = new window.OTO_SFX.Engine();
    this.lastHolder = null;

    this.trainers = { trainerA: new TrainerView('trainerA', this), trainerB: new TrainerView('trainerB', this) };
    this.center = new CenterView(this);
    this.topbar = new TopBar(this);
    this.banner = new DraftBanner(this);

    const root = $('#app');
    append(root, [this.topbar.root, this.banner.root,
      h('main', { class: 'board' }, this.trainers.trainerA.root, this.center.root, this.trainers.trainerB.root)]);
    append(document.body, h('datalist', { id: 'nationalities' }, NATIONALITIES.map((code) => h('option', { value: code }))));

    this.wire();
    this.listenForPackages();
    document.addEventListener('keydown', (event) => this.onKey(event));
    // Keep "2 min ago" honest
    setInterval(() => { if (this.conn.state) this.center.updateActivity(this.conn.activity, this.conn.you); }, 15000);
  }

  // A .oto file dropped anywhere on the page, or opened with the desktop app, offers to install itself
  listenForPackages() {
    let depth = 0;
    const hasFiles = (event) => Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes('Files');
    document.addEventListener('dragenter', (event) => { if (hasFiles(event)) { depth++; document.body.classList.add('dragging'); } });
    document.addEventListener('dragleave', (event) => { if (hasFiles(event) && --depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    document.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
    document.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      // always stop the browser from opening the dropped file in place of this page
      event.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      const file = Array.from(event.dataTransfer.files).find((entry) => /\.(oto|json)$/i.test(entry.name));
      if (file) openImportDialog(this, file);
      else toast('Drop a .oto file to install it.', 'info');
    });
    // the desktop app hands over a .oto file that was double-clicked
    if (window.electronAPI && window.electronAPI.onPackageOpened) {
      window.electronAPI.onPackageOpened((file) => openImportDialog(this, file));
    }
  }

  get state() {
    return this.conn.state;
  }

  wire() {
    const { conn } = this;
    conn.on('connection', (connected) => this.topbar.setConnected(connected));
    conn.on('state', () => this.render());
    conn.on('draft', () => this.render());
    conn.on('presence', (presence) => this.topbar.updatePresence(presence, conn.you));
    conn.on('you', () => this.topbar.updatePresence(conn.presence, conn.you));
    conn.on('activity', (entries) => {
      this.center.updateActivity(entries, conn.you);
      this.topbar.updateHistory(entries.length > 0);
    });
    conn.on('rejected', (rejected) => this.explainRejection(rejected));
    conn.on('draft-conflicts', (data) => modals.openDraftConflicts(this, data));
    // A card library or picture download ended: say how it went, once per download
    conn.on('catalog:progress', ({ job }) => {
      if (!job || !job.finished || job.id === this.reportedJob) return;
      this.reportedJob = job.id;
      toast(job.message, job.phase === 'done' ? 'success' : job.phase === 'cancelled' ? 'info' : 'error', 6000);
    });
    conn.on('draft-sent', ({ applied, skipped }) => {
      toast(`Sent ${applied} change${applied === 1 ? '' : 's'} to the overlay${skipped.length ? `, ${skipped.length} left out` : ''}.`, skipped.length ? 'warning' : 'success');
    });
  }

  render() {
    const state = this.conn.state;
    if (!state) return;

    // The focus follows the turn
    const holder = state.trainerA.isTurn ? 'trainerA' : state.trainerB.isTurn ? 'trainerB' : null;
    if (holder && holder !== this.lastHolder) this.focus = holder;
    this.lastHolder = holder;

    this.trainers.trainerA.update(state);
    this.trainers.trainerB.update(state);
    this.center.update(state);
    this.banner.update(this.conn.draft);
    this.topbar.updateDraft(this.conn.draft.active);
    document.body.classList.toggle('drafting', this.conn.draft.active);
  }

  setFocus(side) {
    this.focus = side;
    if (this.state) this.render();
  }

  // ---- doing things

  async act(event, payload) {
    return this.conn.send(event, payload);
  }

  explainRejection(rejected) {
    switch (rejected.reason) {
      case 'conflict':
        toast(`${rejected.by} just changed this (${rejected.label}). Your click was not applied, so nothing counts twice. Look at the new value and try again if you still need to.`, 'warning', 7000);
        break;
      case 'invalid': toast(rejected.message || 'That is not allowed.', 'error'); break;
      case 'offline': toast('Not connected to the server. Reconnecting…', 'error'); break;
      case 'timeout': toast('The server did not answer. Check the connection.', 'error'); break;
      case 'read-only': toast('This screen is not signed in as a producer. Reload the page and sign in.', 'error'); break;
      case 'nothing-to-undo': toast('Nothing to undo.', 'info'); break;
      case 'nothing-to-redo': toast('Nothing to redo.', 'info'); break;
      case 'no-draft': toast('You are not editing a draft.', 'warning'); break;
      default: toast(rejected.message || 'That did not work.', 'error');
    }
  }

  async undo() {
    const result = await this.conn.undo();
    if (result.ok) toast(`Undid: ${this.conn.activity[this.conn.activity.length - 1]?.label.replace(/^Undid: /, '') || 'the last change'}`, 'info', 2600);
  }

  async redo() {
    const result = await this.conn.redo();
    if (result.ok) toast('Redone', 'info', 2000);
  }

  toggleLock(lock, action) {
    const value = this.state[this.focus].locks[lock];
    return this.act(`action:${this.focus}`, { action, enabled: !value });
  }

  toggleSupporter() {
    const counter = this.state[this.focus].resources.supporterPerTurn;
    return this.act(`action:${this.focus}`, { action: counter.used >= counter.available ? 'supporterMinus' : 'supporterPlus' });
  }

  // ---- draft

  async toggleDraft() {
    const draft = this.conn.draft;
    if (!draft.active) { this.conn.startDraft(); return; }
    if ((draft.changes || []).length === 0) { this.conn.discardDraft(); return; }
    this.openDraftChoice();
  }

  openDraftChoice() {
    const count = this.conn.draft.changes.length;
    openModal({
      title: 'You are editing a draft', size: 'sm', name: 'draft-choice',
      body: h('p', { class: 'confirm-text' }, `You have ${count} change${count === 1 ? '' : 's'} that are not on the overlay yet.`),
      footer: [
        h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Keep editing'),
        h('button', { class: 'btn danger-text', type: 'button', onclick: () => { closeModal(); this.conn.discardDraft(); } }, 'Discard'),
        h('button', { class: 'btn primary', type: 'button', 'data-autofocus': true, onclick: () => { closeModal(); this.sendDraft('safe'); } }, 'Send to overlay')
      ]
    });
  }

  sendDraft(mode) {
    this.conn.sendDraft(mode);
  }

  async discardDraft() {
    const count = (this.conn.draft.changes || []).length;
    if (count > 0 && !(await confirmDialog({ title: 'Discard the draft?', message: `${count} change${count === 1 ? '' : 's'} will be thrown away. Nothing has been sent to the overlay.`, confirmLabel: 'Discard', danger: true }))) return;
    this.conn.discardDraft();
  }

  draftShortcut() {
    if (this.conn.draft.active) this.sendDraft('safe');
    else toast('Start a draft with "Edit & send" first.', 'info');
  }

  // ---- dialogs

  openPicker(purpose) { modals.openPicker(this, purpose); }
  openEvolve(side, slot) { modals.openPicker(this, { kind: 'evolve', side, slot }); }
  openKO(side, slot) { modals.openKO(this, side, slot); }
  openDamage(mode, side, slot) { modals.openDamage(this, mode, side, slot); }
  openEnergy(side, slot) { modals.openEnergy(this, side, slot); }
  openBench(side) { modals.openBench(this, side); }
  openAbilities(side) { modals.openAbilities(this, side); }
  openAttack() { modals.openAttack(this); }
  openHelp() { modals.openHelp(this); }
  openPreview() { modals.openPreview(this); }
  openSettings(tab) { openSettings(this, tab); }

  // ---- misc

  toast(message, kind) { toast(message, kind); }

  async copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // plain http on the local network has no clipboard API
    const area = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }

  onKey(event) {
    if (event.key === 'Escape') {
      if (isModalOpen()) { event.preventDefault(); closeModal(); }
      return;
    }
    if (!this.state) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable;
    if (typing) return;
    if (isModalOpen()) return; // dialogs have their own keys
    const entry = KEYMAP.find((candidate) => candidate.test(event));
    if (!entry) return;
    event.preventDefault();
    entry.run(this, event);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.oto = new App();
});
