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

// The energy icons are files in the assets folder. If they are not there (it can be deleted), plain colored discs are drawn.
{
  const probe = new Image();
  probe.onerror = () => document.documentElement.classList.add('no-energy-icons');
  probe.src = window.OTO_GAME.ENERGY_TYPES[0].icon;
}

// The codes offered while typing a nationality, with the name of each country next to it (see public/js/countries.js)
const COUNTRIES = window.OTO_COUNTRIES;
// What is offered while typing a deck: the energy types and every Pokémon (see public/js/deck.js)
const DECK = window.OTO_DECK;

// ------------------------------------------------------------------------------------ keyboard

const noMods = (e) => !e.ctrlKey && !e.metaKey && !e.altKey;
const plain = (key) => (e) => noMods(e) && !e.shiftKey && e.key.toLowerCase() === key;
const shifted = (key) => (e) => noMods(e) && e.shiftKey && e.key.toLowerCase() === key;
const ctrl = (...keys) => (e) => (e.ctrlKey || e.metaKey) && !e.altKey && keys.includes(e.key.toLowerCase());
const prizeKey = (e) => ['ArrowUp', 'ArrowDown'].includes(e.key);
// Down: a prize card taken (one fewer left). Up: given back.
const prizeAction = (e) => (e.key === 'ArrowDown' ? 'prizeMinus' : 'prizePlus');

// What each shortcut does. Shortcuts about "the trainer" apply to the focused one: press 1 or 2 to
// choose, and the focus follows the turn on its own.
export const KEYMAP = [
  { group: 'Game', keys: ['Space'], label: 'Pass the turn', test: (e) => noMods(e) && e.key === ' ', run: (app) => app.act('action:match', { action: 'toggleTurn' }) },
  { group: 'Game', keys: ['1'], label: 'Shortcuts apply to Trainer A', test: plain('1'), run: (app) => app.setFocus('trainerA') },
  { group: 'Game', keys: ['2'], label: 'Shortcuts apply to Trainer B', test: plain('2'), run: (app) => app.setFocus('trainerB') },
  { group: 'Game', keys: ['↑', '↓'], label: 'The player whose turn it is takes / gives back a prize card', test: (e) => noMods(e) && !e.shiftKey && prizeKey(e), run: (app, e) => app.act(`action:${app.prizeSide(false)}`, { action: prizeAction(e) }) },
  { group: 'Game', keys: ['Shift', '↑ ↓'], label: 'The same for the player who does not have the turn', test: (e) => noMods(e) && e.shiftKey && prizeKey(e), run: (app, e) => app.act(`action:${app.prizeSide(true)}`, { action: prizeAction(e) }) },
  { group: 'Game', keys: ['I'], label: 'Item lock on / off (focused trainer)', test: plain('i'), run: (app) => app.toggleLock('itemLock', 'toggleItemLock') },
  { group: 'Game', keys: ['V'], label: 'Evolution lock on / off (focused trainer)', test: plain('v'), run: (app) => app.toggleLock('evoLock', 'toggleEvoLock') },
  { group: 'Game', keys: ['Shift', 'S'], label: 'Supporter played this turn (focused trainer)', test: shifted('s'), run: (app) => app.toggleSupporter() },

  { group: 'Dialogs', keys: ['A'], label: 'Deploy a new Active Pokémon', test: plain('a'), run: (app) => app.openPicker({ kind: 'active', side: app.focus }) },
  { group: 'Dialogs', keys: ['B'], label: 'Edit the bench', test: plain('b'), run: (app) => app.openBench(app.focus) },
  { group: 'Dialogs', keys: ['Shift', 'B'], label: 'Bench back to 5 slots (focused trainer)', test: shifted('b'), run: (app) => app.act(`action:${app.focus}`, { action: 'benchSizeReset' }) },
  { group: 'Dialogs', keys: ['M'], label: 'Move damage from one Pokémon to another (any Pokémon of either trainer)', test: plain('m'), run: (app) => app.openMoveDamage() },
  { group: 'Dialogs', keys: ['D'], label: 'Damage', test: plain('d'), run: (app) => app.openDamage('damage') },
  { group: 'Dialogs', keys: ['H'], label: 'Heal', test: plain('h'), run: (app) => app.openDamage('heal', app.focus) },
  { group: 'Dialogs', keys: ['E'], label: 'Energy (the turn\'s attachment, or a special one)', test: plain('e'), run: (app) => app.openEnergy(app.focus) },
  { group: 'Dialogs', keys: ['K'], label: 'Knock out', test: plain('k'), run: (app) => app.openKO(app.focus) },
  { group: 'Dialogs', keys: ['S'], label: 'Stadium', test: plain('s'), run: (app) => app.openPicker({ kind: 'stadium' }) },
  { group: 'Dialogs', keys: ['X'], label: 'Abilities', test: plain('x'), run: (app) => app.openAbilities(app.focus) },

  { group: 'Hype', keys: ['C'], label: 'Announce an attack', test: plain('c'), run: (app) => app.openAttack() },
  { group: 'Hype', keys: ['T'], label: 'Announce a Top Deck', test: plain('t'), run: (app) => app.act('action:toast', { action: 'topDeck', target: app.focus }) },
  { group: 'Hype', keys: ['P'], label: 'Pause the game, or resume it (the overlay is grayed out while it is paused)', test: plain('p'), run: (app) => app.togglePause() },

  { group: 'History', keys: ['Ctrl', 'Z'], label: 'Undo', test: (e) => ctrl('z')(e) && !e.shiftKey, run: (app) => app.undo() },
  { group: 'History', keys: ['Ctrl', 'Y'], label: 'Redo (also Ctrl+Shift+Z)', test: (e) => ctrl('y')(e) || (ctrl('z')(e) && e.shiftKey), run: (app) => app.redo() },
  { group: 'History', keys: ['Ctrl', 'Enter'], label: 'Send the draft to the overlay (draft mode goes on)', test: (e) => ctrl('enter')(e), run: (app) => app.draftShortcut() },
  { group: 'History', keys: ['Shift', 'Enter'], label: 'Draft mode on or off: in draft mode changes wait until they are sent', test: (e) => noMods(e) && e.shiftKey && e.key === 'Enter', run: (app) => app.toggleDraft() },

  { group: 'Other', keys: ['?'], label: 'Show these shortcuts', test: (e) => e.key === '?', run: (app) => app.openHelp() },
  { group: 'Other', keys: ['Esc'], label: 'Close a dialog', test: () => false, run: () => {} }
];

// ----------------------------------------------------------------------------------------- app

// How the Active Pokémon and the bench look in this control panel: the art of the card ('art', the usual) or the whole card ('full'). It is
// a choice of this browser (the overlay has its own crop, in a design), so it is kept here and not shared with the other producers.
const CARD_VIEW_KEY = 'oto-card-view';
function loadCardView() {
  try { return window.localStorage.getItem(CARD_VIEW_KEY) === 'full' ? 'full' : 'art'; } catch (error) { return 'art'; }
}

class App {
  constructor() {
    this.conn = new Connection();
    this.cardView = loadCardView();
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
    append(document.body, h('datalist', { id: 'nationalities' }, COUNTRIES.COMMON.map((code) => h('option', { value: code, label: COUNTRIES.nameOf(code) }))));
    const deckNames = [...DECK.energyNames(), ...DECK.pokemonNames()];
    append(document.body,
      h('datalist', { id: 'deck-names' }, deckNames.map((name) => h('option', { value: name }))),
      h('datalist', { id: 'deck-pictures' }, [DECK.NO_PICTURE, ...deckNames].map((name) => h('option', { value: name }))));

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

  // Who has the turn ('trainerA' or 'trainerB'), or null before anybody does
  get turnHolder() {
    const state = this.state;
    return !state ? null : state.trainerA.isTurn ? 'trainerA' : state.trainerB.isTurn ? 'trainerB' : null;
  }

  // Show the Pokémon of the table as the art of their cards, or as the whole card, in this control panel
  setCardView(view) {
    this.cardView = view === 'full' ? 'full' : 'art';
    try { window.localStorage.setItem(CARD_VIEW_KEY, this.cardView); } catch (error) { /* a private window cannot remember it */ }
    if (this.state) this.render();
  }

  // Pause the game, or resume it. It says what it wants (not "toggle"), so two producers pressing it at once agree.
  togglePause() {
    return this.act('action:match', { action: 'togglePause', enabled: !(this.state && this.state.paused === true) });
  }

  // Whom the prize shortcuts are for: the player whose turn it is, or with Shift the other one. Until somebody has the turn they are
  // Trainer A and Trainer B, so the keys are never dead.
  prizeSide(other) {
    const holder = this.turnHolder || 'trainerA';
    return other ? (holder === 'trainerA' ? 'trainerB' : 'trainerA') : holder;
  }

  wire() {
    const { conn } = this;
    conn.on('connection', (connected) => this.topbar.setConnected(connected));
    conn.on('state', () => this.render());
    conn.on('draft', (draft) => {
      // somebody else started the draft: this page is in it too, so say so
      if (draft.active && !this.draftWasActive && draft.startedBy && conn.you && draft.startedBy.clientId !== conn.you.clientId) {
        toast(`${draft.startedBy.name} turned draft mode on. Changes wait in the draft until somebody sends them; Shift+Enter leaves draft mode.`, 'info', 5000);
      }
      this.draftWasActive = draft.active;
      this.render();
    });
    conn.on('presence', (presence) => this.topbar.updatePresence(presence, conn.you));
    conn.on('you', () => this.topbar.updatePresence(conn.presence, conn.you));
    conn.on('activity', (entries) => {
      this.center.updateActivity(entries, conn.you);
      this.topbar.updateHistory(entries.length > 0);
    });
    conn.on('rejected', (rejected) => this.explainRejection(rejected));
    conn.on('kicked', () => this.showKicked());
    conn.on('draft-conflicts', (data) => modals.openDraftConflicts(this, data));
    // A card library or picture download ended: say how it went, once per download
    conn.on('catalog:progress', ({ job }) => {
      if (!job || !job.finished || job.id === this.reportedJob) return;
      this.reportedJob = job.id;
      toast(job.message, job.phase === 'done' ? 'success' : job.phase === 'cancelled' ? 'info' : 'error', 6000);
    });
    conn.on('draft-sent', ({ applied, skipped, by, byClientId }) => {
      const mine = !conn.you || byClientId === conn.you.clientId;
      toast(`${mine ? 'Sent' : `${by} sent`} ${applied} change${applied === 1 ? '' : 's'} to the overlay${skipped.length ? `, ${skipped.length} left out` : ''}.`, skipped.length ? 'warning' : 'success');
    });
    conn.on('draft-closed', ({ by, byClientId }) => {
      if (conn.you && byClientId !== conn.you.clientId) toast(`${by} left draft mode.`, 'info');
    });
    conn.on('draft-cleared', ({ count, by, byClientId }) => {
      if (conn.you && byClientId !== conn.you.clientId && count > 0) toast(`${by} threw the ${count} change${count === 1 ? '' : 's'} of the draft away.`, 'info');
    });
  }

  render() {
    const state = this.conn.state;
    if (!state) return;

    // The focus follows the turn
    const holder = this.turnHolder;
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
      case 'forbidden': toast(rejected.message || 'Only the host can do that.', 'warning'); break;
      case 'read-only': toast('This screen is not signed in as a producer. Reload the page and sign in.', 'error'); break;
      case 'nothing-to-undo': toast('Nothing to undo.', 'info'); break;
      case 'nothing-to-redo': toast('Nothing to redo.', 'info'); break;
      case 'no-draft': toast('There is no draft open.', 'warning'); break;
      default: toast(rejected.message || 'That did not work.', 'error');
    }
  }

  // The host changed the name of a producer (or yours changed it yourself: the same call)
  renameProducer(person, name) {
    this.conn.rename(name, person.clientId);
  }

  // The host removes a producer: their pages close, and they cannot come back for an hour unless the host lets them
  async kickProducer(person) {
    if (!(await confirmDialog({ title: `Remove ${person.name}?`, message: `${person.name} is disconnected and cannot come back for an hour, unless you let the removed producers back in.`, confirmLabel: 'Remove', danger: true }))) return;
    this.conn.kick(person.clientId);
  }

  // Shown to a producer the host removed: the page stops here
  showKicked() {
    closeAllModals();
    const message = h('div', { class: 'kicked-screen', role: 'alert' },
      h('h2', {}, 'You were removed from this session'),
      h('p', {}, 'The host of this OTO removed you as a producer. Ask them if you should be let back in.'));
    document.body.replaceChildren(message);
  }

  async undo() {
    const result = await this.conn.undo();
    if (result.ok) toast(`Undid: ${this.conn.activity[this.conn.activity.length - 1]?.label.replace(/^Undid: /, '') || 'the last change'}`, 'info', 2600);
  }

  async redo() {
    const result = await this.conn.redo();
    // redoing the send of a draft opens the draft again, with the changes that were sent: it is not on the overlay until it is sent once more
    if (result.ok && result.applied && result.applied.draft) {
      toast(`The draft is open again with its ${result.applied.changes} change${result.applied.changes === 1 ? '' : 's'}. Change what you like, then send it.`, 'info', 5000);
      return;
    }
    // says what was done again, like the undo says what was taken back
    if (result.ok) toast(`Redid: ${this.conn.activity[this.conn.activity.length - 1]?.label.replace(/^Redid: /, '') || 'the last change'}`, 'info', 2600);
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

  // Leaving draft mode with changes in the draft: send them, throw them away, or stay
  openDraftChoice() {
    const count = this.conn.draft.changes.length;
    openModal({
      title: 'You are in draft mode', size: 'sm', name: 'draft-choice',
      body: h('p', { class: 'confirm-text' }, `You have ${count} change${count === 1 ? '' : 's'} that are not on the overlay yet.`),
      footer: [
        h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Stay in draft mode'),
        h('button', { class: 'btn danger-text', type: 'button', onclick: () => { closeModal(); this.conn.discardDraft(); } }, 'Throw them away and leave'),
        h('button', { class: 'btn primary', type: 'button', 'data-autofocus': true, onclick: () => { closeModal(); this.sendAndLeave(); } }, 'Send and leave')
      ]
    });
  }

  sendDraft(mode) {
    this.conn.sendDraft(mode);
  }

  // Send what is in the draft, and leave draft mode once it is on the overlay (if there is a clash, the draft stays so it can be dealt with)
  sendAndLeave() {
    const offs = [];
    const done = () => { for (const off of offs) off(); };
    offs.push(this.conn.on('draft-sent', () => { done(); this.conn.discardDraft(); }));
    offs.push(this.conn.on('draft-conflicts', done));
    this.sendDraft('safe');
  }

  // Throw the changes of the draft away, and stay in draft mode
  async clearDraft() {
    const count = (this.conn.draft.changes || []).length;
    if (count === 0) return;
    if (!(await confirmDialog({ title: 'Throw the changes away?', message: `${count} change${count === 1 ? '' : 's'} will be thrown away. Nothing has been sent to the overlay, and draft mode goes on.`, confirmLabel: 'Throw away', danger: true }))) return;
    this.conn.clearDraft();
  }

  draftShortcut() {
    if (this.conn.draft.active) this.sendDraft('safe');
    else toast('Turn draft mode on first (Shift+Enter, or "Draft mode" at the top).', 'info');
  }

  // ---- dialogs

  openPicker(purpose) { modals.openPicker(this, purpose); }
  openEvolve(side, slot) { modals.openPicker(this, { kind: 'evolve', side, slot }); }
  openTool(side, slot) { modals.openPicker(this, { kind: 'tool', side, slot }); }

  // Go back to the card a Pokémon was before it evolved: the one that is on file, or (when it did not evolve here) another that is chosen
  async devolve(side, slot) {
    const pokemon = slot === -1 ? this.state[side].active : this.state[side].bench[slot];
    if (pokemon && Array.isArray(pokemon.stages) && pokemon.stages.length > 0) await this.act(`action:${side}`, { action: 'devolve', slot });
    else modals.openPicker(this, { kind: 'devolve', side, slot });
  }
  openKO(side, slot) { modals.openKO(this, side, slot); }
  openMoveDamage() { modals.openMoveDamage(this); }
  openDamage(mode, side, slot) { modals.openDamage(this, mode, side, slot); }
  openEnergy(side, slot) { modals.openEnergy(this, side, slot); }
  openBench(side) { modals.openBench(this, side); }
  openPrizes(side) { modals.openPrizes(this, side); }
  openAbilities(side) { modals.openAbilities(this, side); }
  openAttack() { modals.openAttack(this); }
  openHelp() { modals.openHelp(this); }
  // The overlay as the audience sees it, in a window of this page; with Shift, the overlay itself in the browser (to look at it full size, or to
  // put on another screen)
  openPreview(inBrowser = false) {
    if (inBrowser) window.open('/overlay', '_blank');
    else modals.openPreview(this);
  }
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
