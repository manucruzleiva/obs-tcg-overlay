/**
 * The live session: who is connected, who may change the game, and how changes are applied.
 *
 * Every change goes through finish(), which bumps the revision, records who did what, keeps the
 * shared undo history, and tells everyone. Control panels send the revision they last saw with each
 * action; if another producer changed the same part of the game since then, the action is refused
 * instead of being applied twice.
 *
 * The producers can also work in draft mode together: there is one draft for the whole table, started by any of them, and it stays open
 * (empty again) after it is sent, until one of them leaves the mode. Everybody's changes run against
 * a copy of the game that the overlay does not see, every producer sees the same preview and the same list of changes (and who made each),
 * and any of them can "send" it, which applies all of them to the live game in one step, or throw it away. Undoing a sent draft and then
 * redoing it opens the draft again with those changes, in case somebody wants to change something before it is sent once more.
 */

const actions = require('./actions');
const { attacksOf, retreatOf } = require('./services/attacks');
const GAME = require('../public/js/game-data');
const { Collab, Presence } = require('./services/collab');

const ACTION_EVENTS = [
  'action:trainerA', 'action:trainerB', 'action:match', 'action:toast',
  'action:card', 'action:settings', 'action:reset'
];

// Sockets that may change the game (control panels that passed the password check)
const PRODUCERS = 'producers';
const clientRoom = (clientId) => `client:${clientId}`;
const KICK_MS = 60 * 60 * 1000; // how long a producer the host removed stays out

// The state as clients see it: the keys of the card services are secrets and never leave the server. A page is told which
// ones are saved, and how each looks masked (its first three characters, ***, its last four).
function publicState(state) {
  const settings = { ...state.settings };
  const keys = {};
  for (const name of GAME.SECRET_SETTINGS) {
    keys[name] = GAME.maskSecret(settings[name]);
    delete settings[name];
  }
  return { ...state, settings: { ...settings, apiKeySet: Boolean(state.settings.apiKey), keys } };
}

class Session {
  constructor({ io, gameState, log, afterChange = () => {} }) {
    this.io = io;
    this.gs = gameState;
    this.log = log;
    this.afterChange = afterChange;

    this.collab = new Collab();
    this.presence = new Presence();
    this.draft = null; // the draft of the table: { baseRevision, queue, fork, startedBy }, each change { event, payload, label, targets, conflict, by }
    this.announceId = 0;
    this.sfxId = 0;
    this.kicked = new Map(); // "client:<id>" or "ip:<address>" -> when the host lets them back in again (a producer the host removed)
  }

  // Who may come in as a producer: not somebody the host removed a little while ago
  isBanned(clientId, address) {
    const now = Date.now();
    for (const [key, until] of this.kicked) if (until <= now) this.kicked.delete(key);
    return this.kicked.has(`client:${clientId}`) || (Boolean(address) && this.kicked.has(`ip:${address}`));
  }

  // ----------------------------------------------------------- connections

  // Wire up a freshly connected socket. socket.data holds { clientId, name, canControl }.
  attach(socket) {
    const { clientId, name, canControl, host } = socket.data;
    this.presence.join(socket.id, { role: canControl ? 'producer' : 'viewer', clientId, name, host: canControl && host });

    socket.emit('state:full', publicState(this.gs.state));

    if (canControl) {
      socket.join(PRODUCERS);
      socket.join(clientRoom(clientId));
      socket.emit('you', this.youPayload(clientId));
      socket.emit('activity:history', this.collab.activity);
      if (this.draft) socket.emit('draft:state', this.draftPayload());
    }
    this.broadcastPresence();

    for (const event of ACTION_EVENTS) {
      socket.on(event, (data) => this.guard(socket, () => this.handleAction(socket, event, data)));
    }
    socket.on('action:undo', (data) => this.guard(socket, () => this.undo(socket, data)));
    socket.on('action:redo', (data) => this.guard(socket, () => this.redo(socket, data)));
    socket.on('draft:start', () => this.guard(socket, () => this.draftStart(socket)));
    socket.on('draft:discard', () => this.guard(socket, () => this.draftDiscard(socket)));
    socket.on('draft:clear', () => this.guard(socket, () => this.draftClear(socket)));
    socket.on('draft:send', (data) => this.guard(socket, () => this.draftSend(socket, data)));
    socket.on('presence:rename', (data) => this.guard(socket, () => this.rename(socket, data)));
    socket.on('presence:kick', (data) => this.guard(socket, () => this.kick(socket, data)));
    socket.on('presence:forgive', () => this.guard(socket, () => this.forgive(socket)));

    socket.on('disconnect', () => this.detach(socket));
  }

  detach(socket) {
    this.presence.leave(socket.id);
    // The draft is for the producers who are here: it goes when the last of them leaves
    if (this.draft && this.presence.producers().length === 0) this.draft = null;
    this.broadcastPresence();
  }

  // Run a handler; a bad request tells the sender what was wrong, an unexpected failure is logged
  async guard(socket, fn) {
    try {
      await fn();
    } catch (error) {
      if (error instanceof actions.ActionError) {
        socket.emit('action:rejected', { reason: 'invalid', message: error.message, seq: error.seq });
      } else {
        this.log.error('Action failed', { socketId: socket.id, error: error.message, stack: error.stack });
        socket.emit('action:rejected', { reason: 'error', message: 'Something went wrong; the change was not applied.', seq: error.seq });
      }
    }
  }

  broadcastPresence() {
    // (while there is a draft, every producer is editing it)
    const producers = this.presence.producers().map((p) => ({ ...p, drafting: Boolean(this.draft) }));
    this.io.to(PRODUCERS).emit('presence', { producers, viewers: this.presence.viewerCount(), kicked: this.kickedCount() });
  }

  // What a producer's own page is told about them: who they are, and whether they are the host (the one on the computer that runs OTO)
  youPayload(clientId) {
    return { ...this.presence.who(clientId), host: this.presence.isHost(clientId) };
  }

  kickedCount() {
    this.isBanned('', '');
    return [...this.kicked.keys()].filter((key) => key.startsWith('client:')).length;
  }

  // Anybody can rename themselves; the host can rename any producer (`data.clientId` says whom)
  rename(socket, data) {
    if (!socket.data.canControl) return;
    const target = data && typeof data.clientId === 'string' ? data.clientId : socket.data.clientId;
    if (target !== socket.data.clientId && !this.presence.isHost(socket.data.clientId)) {
      socket.emit('action:rejected', { reason: 'forbidden', message: 'Only the host (on the computer that runs OTO) can rename other producers.' });
      return;
    }
    if (!this.presence.hasClient(target)) return;
    if (this.presence.rename(target, data && data.name)) {
      this.io.to(clientRoom(target)).emit('you', this.youPayload(target));
      this.broadcastPresence();
    }
  }

  // The host can remove a producer: their pages are closed, and they cannot come back for a while (until the host lets them in again)
  kick(socket, data) {
    if (!socket.data.canControl) return;
    const target = data && typeof data.clientId === 'string' ? data.clientId : '';
    if (!this.presence.isHost(socket.data.clientId)) {
      socket.emit('action:rejected', { reason: 'forbidden', message: 'Only the host (on the computer that runs OTO) can remove producers.' });
      return;
    }
    if (!target || target === socket.data.clientId || this.presence.isHost(target) || !this.presence.hasClient(target)) return;
    const name = this.presence.who(target).name;
    const until = Date.now() + KICK_MS;
    this.kicked.set(`client:${target}`, until);
    for (const socketId of this.presence.socketIdsOf(target)) {
      const page = this.io.sockets.sockets.get(socketId);
      if (!page) continue;
      if (page.handshake.address) this.kicked.set(`ip:${page.handshake.address}`, until);
      page.emit('kicked', { by: this.presence.who(socket.data.clientId).name });
      page.disconnect(true);
    }
    const activity = this.collab.addActivity({ rev: this.gs.state.revision, by: this.presence.who(socket.data.clientId), label: `Removed ${name} from the session`, kind: 'system' });
    this.io.to(PRODUCERS).emit('activity', activity);
    this.broadcastPresence();
  }

  // The host lets everybody who was removed come back
  forgive(socket) {
    if (!socket.data.canControl || !this.presence.isHost(socket.data.clientId)) return;
    this.kicked.clear();
    this.broadcastPresence();
  }

  // --------------------------------------------------------------- actions

  async handleAction(socket, event, data) {
    const { meta, ...payload } = data && typeof data === 'object' ? data : {};
    const info = meta && typeof meta === 'object' ? meta : {};
    const seq = Number.isInteger(info.seq) ? info.seq : undefined;

    if (!socket.data.canControl) {
      socket.emit('action:rejected', { reason: 'read-only', seq });
      return;
    }
    if (!actions.resolve(event, payload)) return; // unknown action: ignore

    try {
      const prepared = await actions.prepare(this.gs, event, payload);
      const spec = actions.resolve(event, prepared);

      if (info.draft === true) {
        this.draftAction(socket, event, prepared, spec, seq);
      } else {
        this.commitLive(socket, spec, info);
        if (prepared.detailsLater === true) this.fillDetailsLater(prepared);
      }
    } catch (error) {
      error.seq = seq; // so the sender can tell which of its actions failed
      throw error;
    }
  }

  commitLive(socket, spec, meta) {
    const { clientId } = socket.data;

    // The same action delivered twice (a retry, a re-sent buffer) is applied once
    if (Number.isInteger(meta.seq) && !this.collab.claim(clientId, meta.seq)) {
      socket.emit('action:applied', { seq: meta.seq, revision: this.gs.state.revision, duplicate: true });
      return;
    }

    const targets = spec.targets();
    if (targets && Number.isInteger(meta.baseRevision)) {
      const conflict = this.collab.findConflict(meta.baseRevision, clientId, targets);
      if (conflict) {
        this.rejectConflict(socket, conflict, meta.seq);
        return;
      }
    }

    const before = this.gs.snapshot();
    let announced;
    try {
      announced = spec.run(this.gs);
    } catch (error) {
      this.gs.restore(before);
      throw error;
    }
    if (spec.silent) return;

    this.finish({ before, targets: targets || [], label: spec.label(this.gs), clientId, announced, cues: spec.cues(), kind: 'action' });
    this.acknowledge(socket, meta.seq);
  }

  // Tell the sender its action went through (the new state itself arrives as a state:update first)
  acknowledge(socket, seq) {
    if (Number.isInteger(seq)) socket.emit('action:applied', { seq, revision: this.gs.state.revision });
  }

  rejectConflict(socket, conflict, seq) {
    socket.emit('action:rejected', {
      reason: 'conflict',
      by: conflict.by.name,
      label: conflict.label,
      revision: this.gs.state.revision,
      seq
    });
  }

  // Apply a change that did not come from a control panel (for example the REST API)
  commit(label, mutate, by = { clientId: 'api', name: 'API' }) {
    const before = this.gs.snapshot();
    try {
      mutate(this.gs);
    } catch (error) {
      this.gs.restore(before);
      throw error;
    }
    this.finish({ before, targets: ['*'], label, clientId: by.clientId, by, announced: [], kind: 'action' });
  }

  // A Pokémon picked while the card service was slow has no attacks or retreat cost yet: they are looked for in the background and filled
  // in when they come, if that Pokémon is still there and nobody has set them by hand. It is no step of the history.
  async fillDetailsLater(payload) {
    const match = /^(trainerA|trainerB)-(?:active|bench-\d+)$/.exec(String(payload.target));
    if (!match) return;
    const side = match[1];
    const supplied = payload.cardData && typeof payload.cardData === 'object' ? payload.cardData : {};
    let details = null;
    try {
      details = await this.gs.pokemonTCG.getCard(payload.cardId, { source: supplied.source, language: supplied.language });
    } catch (error) {
      return; // the card service is not answering: the attacks and the retreat cost stay to be set by hand
    }
    if (!details) return;
    const attacks = attacksOf(details.attacks) || [];
    const retreat = retreatOf({ retreat: details.retreat });
    if (attacks.length === 0 && !retreat) return;

    const slot = [-1, 0, 1, 2, 3, 4, 5, 6, 7].find((candidate) => {
      const pokemon = this.gs.pokemonAt(side, candidate);
      return pokemon && pokemon.cardId === payload.cardId && pokemon.attacks.length === 0 && pokemon.retreat === 0;
    });
    if (slot === undefined) return;

    const before = this.gs.snapshot();
    const name = this.gs.pokemonAt(side, slot).name;
    this.gs.fillPokemonDetails(side, slot, { attacks, retreat });
    this.finish({
      before, targets: [slot === -1 ? `${side}.active` : `${side}.bench.${slot}`], by: { clientId: 'card-service', name: 'Card service' },
      label: `${name}: attacks and retreat cost from the card`, kind: 'details', recordUndo: false, keepRedo: true
    });
  }

  // The one place a change becomes official: new revision, undo entry, activity, broadcast
  finish({ before, targets, label, clientId, by, announced = [], cues = [], kind, undoLabel = label, recordUndo = true, keepRedo = false, draft = null }) {
    const gs = this.gs;
    const changed = JSON.stringify({ ...before, revision: 0 }) !== JSON.stringify({ ...gs.state, revision: 0 });

    gs.state.revision += 1;
    const rev = gs.state.revision;
    const who = by || this.presence.who(clientId);

    this.collab.recordChange({ rev, clientId, by: who, label, targets });
    // (a draft that was sent keeps its changes, so that redoing the send can open it again)
    if (recordUndo && changed) this.collab.pushUndo({ before, rev, label: undoLabel, by: who, draft });
    if (kind !== 'undo' && kind !== 'redo' && !keepRedo) this.collab.clearRedo();

    const activity = this.collab.addActivity({ rev, by: who, label, kind });

    this.afterChange(gs.state);
    this.io.emit('state:update', publicState(gs.state));
    this.io.to(PRODUCERS).emit('activity', activity);
    for (const announcement of announced) {
      this.io.emit('announce', { ...announcement, id: ++this.announceId, ts: Date.now() });
    }
    // One sound per kind per change, however many actions it holds (a sent draft, for example)
    for (const cue of new Set(cues)) {
      this.io.emit('sfx', { id: ++this.sfxId, cue });
    }
    this.refreshDraft();
  }

  // ------------------------------------------------------------ undo / redo

  undo(socket, data) {
    if (!socket.data.canControl) return;
    const { clientId } = socket.data;
    const seq = data && data.meta && data.meta.seq;
    const entry = this.collab.peekUndo();
    if (!entry) {
      socket.emit('action:rejected', { reason: 'nothing-to-undo', seq });
      return;
    }
    if (this.staleView(socket, data)) return;

    this.collab.popUndo();
    this.collab.pushRedo({ snapshot: this.gs.snapshot(), label: entry.label, by: entry.by, draft: entry.draft || null });
    this.gs.restore(entry.before);

    const owner = entry.by.clientId === clientId ? '' : ` (made by ${entry.by.name})`;
    this.finish({
      before: this.gs.snapshot(), targets: ['*'], clientId, kind: 'undo', recordUndo: false,
      label: `Undid: ${entry.label}${owner}`
    });
    this.acknowledge(socket, seq);
  }

  redo(socket, data) {
    if (!socket.data.canControl) return;
    const { clientId } = socket.data;
    const seq = data && data.meta && data.meta.seq;
    const entry = this.collab.popRedo();
    if (!entry) {
      socket.emit('action:rejected', { reason: 'nothing-to-redo', seq });
      return;
    }
    if (this.staleView(socket, data)) {
      this.collab.pushRedo(entry);
      return;
    }

    // Redoing the send of a draft opens the draft again instead, with the changes that were sent, so they can be changed before they go
    if (entry.draft && entry.draft.length) {
      this.reopenDraft(socket, entry, seq);
      return;
    }

    const current = this.gs.snapshot();
    this.gs.restore(entry.snapshot);
    this.finish({
      before: current, targets: ['*'], clientId, kind: 'redo',
      label: `Redid: ${entry.label}`, undoLabel: entry.label
    });
    this.acknowledge(socket, seq);
  }

  // Undo and redo affect everything, so refuse them if someone else changed anything since the sender last looked
  staleView(socket, data) {
    const base = data && data.meta && data.meta.baseRevision;
    if (!Number.isInteger(base)) return false;
    const conflict = this.collab.findConflict(base, socket.data.clientId, ['*']);
    if (!conflict) return false;
    this.rejectConflict(socket, conflict, data.meta.seq);
    return true;
  }

  // ---------------------------------------------------------------- the draft

  draftStart(socket) {
    if (!socket.data.canControl) return;
    if (!this.draft) {
      this.draft = { baseRevision: this.gs.state.revision, queue: [], fork: this.gs.fork(), startedBy: this.presence.who(socket.data.clientId) };
      this.broadcastPresence();
    }
    this.sendDraft();
  }

  // Throw the changes of the draft away but stay in draft mode
  draftClear(socket) {
    if (!socket.data.canControl) return;
    const draft = this.draft;
    if (!draft) {
      socket.emit('draft:state', { active: false });
      return;
    }
    const count = draft.queue.length;
    draft.queue = [];
    draft.baseRevision = this.gs.state.revision;
    draft.fork = this.gs.fork();
    const by = this.presence.who(socket.data.clientId);
    this.sendDraft();
    this.io.to(PRODUCERS).emit('draft:cleared', { count, by: by.name, byClientId: by.clientId });
  }

  // Leave draft mode (what is in the draft is thrown away)
  draftDiscard(socket) {
    if (!socket.data.canControl) return;
    if (!this.draft) {
      socket.emit('draft:state', { active: false });
      return;
    }
    const by = this.presence.who(socket.data.clientId);
    this.draft = null;
    this.io.to(PRODUCERS).emit('draft:state', { active: false });
    this.io.to(PRODUCERS).emit('draft:closed', { how: 'discarded', by: by.name, byClientId: by.clientId });
    this.broadcastPresence();
  }

  draftAction(socket, event, payload, spec, seq) {
    const { clientId } = socket.data;
    const draft = this.draft;
    if (!draft) {
      socket.emit('action:rejected', { reason: 'no-draft', seq });
      return;
    }

    // (a draft with nothing in it starts from the game as it is now)
    if (draft.queue.length === 0) {
      draft.baseRevision = this.gs.state.revision;
      draft.fork = this.gs.fork();
    }
    const before = draft.fork.snapshot();
    try {
      spec.run(draft.fork);
    } catch (error) {
      draft.fork.restore(before);
      throw error;
    }
    draft.queue.push({ event, payload, label: spec.label(draft.fork), targets: spec.targets(), conflict: null, by: this.presence.who(clientId) });
    this.sendDraft({ socket, ack: seq });
  }

  // Replay a draft's actions on a fresh copy of the live game, marking the ones that touch something that
  // somebody else (not the one who made that change) changed since the draft began
  rebuildDraft(draft) {
    if (draft.queue.length === 0) draft.baseRevision = this.gs.state.revision;
    const fork = this.gs.fork();
    for (const entry of draft.queue) {
      const conflict = entry.targets ? this.collab.findConflict(draft.baseRevision, entry.by.clientId, entry.targets) : null;
      entry.conflict = conflict ? { by: conflict.by.name, label: conflict.label } : null;
      if (conflict) continue;
      try {
        actions.resolve(entry.event, entry.payload).run(fork);
      } catch (error) {
        entry.conflict = { by: '', label: 'no longer applies' };
      }
    }
    draft.fork = fork;
  }

  refreshDraft() {
    if (!this.draft) return;
    this.rebuildDraft(this.draft);
    this.sendDraft();
  }

  // What every producer's page is told about the draft
  draftPayload() {
    const { startedBy, baseRevision, fork, queue } = this.draft;
    return {
      active: true,
      baseRevision,
      revision: this.gs.state.revision,
      startedBy: { clientId: startedBy.clientId, name: startedBy.name },
      preview: publicState(fork.state),
      changes: queue.map(({ label, conflict, by }) => ({ label, conflict, by: by.name, byClientId: by.clientId }))
    };
  }

  // Tell every producer how the draft is. `ack` is the sequence number of the action of `socket` that this answers: only the page that sent it
  // is told (sequence numbers belong to a page, so another page could mistake it for one of its own).
  sendDraft({ socket, ack } = {}) {
    if (!this.draft) return;
    const payload = this.draftPayload();
    if (socket && ack !== undefined) {
      socket.to(PRODUCERS).emit('draft:state', payload);
      socket.emit('draft:state', { ...payload, ack });
    } else {
      this.io.to(PRODUCERS).emit('draft:state', payload);
    }
  }

  // mode: 'safe' (default: stop and report if anything conflicts), 'skip' (leave conflicting
  // changes out) or 'force' (apply everything)
  draftSend(socket, data) {
    if (!socket.data.canControl) return;
    const { clientId } = socket.data;
    const draft = this.draft;
    if (!draft) {
      socket.emit('action:rejected', { reason: 'no-draft' });
      return;
    }
    const mode = ['skip', 'force'].includes(data && data.mode) ? data.mode : 'safe';

    this.rebuildDraft(draft);
    const conflicting = draft.queue.filter((entry) => entry.conflict);
    if (conflicting.length && mode === 'safe') {
      socket.emit('draft:conflicts', { conflicts: conflicting.map(({ label, conflict }) => ({ label, conflict })) });
      this.sendDraft();
      return;
    }

    const before = this.gs.snapshot();
    const applied = [];
    const kept = []; // what was applied, as it can be played again (redoing the send opens the draft with these)
    const skipped = [];
    const announced = [];
    const cues = [];
    const targets = [];

    for (const entry of draft.queue) {
      if (entry.conflict && mode === 'skip') {
        skipped.push({ label: entry.label, reason: entry.conflict.by ? `${entry.conflict.by} changed this` : entry.conflict.label });
        continue;
      }
      const spec = actions.resolve(entry.event, entry.payload);
      try {
        announced.push(...spec.run(this.gs));
        cues.push(...spec.cues());
        applied.push(spec.label(this.gs));
        kept.push({ event: entry.event, payload: entry.payload, label: entry.label, targets: entry.targets, by: entry.by });
        targets.push(...(entry.targets || []));
      } catch (error) {
        skipped.push({ label: entry.label, reason: error.message });
      }
    }

    this.draft = null; // (it is open again, empty, once what was sent is in the game: see below)

    if (applied.length) {
      const preview = applied.slice(0, 3).join('; ') + (applied.length > 3 ? '…' : '');
      this.finish({
        before, targets, clientId, announced, cues, kind: 'draft', draft: kept,
        label: `Sent ${applied.length} change${applied.length === 1 ? '' : 's'}: ${preview}`,
        undoLabel: `${applied.length} sent change${applied.length === 1 ? '' : 's'}`
      });
    }

    const by = this.presence.who(clientId);
    // draft mode goes on: the draft is empty again, for the next changes
    this.draft = { baseRevision: this.gs.state.revision, queue: [], fork: this.gs.fork(), startedBy: draft.startedBy };
    this.io.to(PRODUCERS).emit('draft:sent', { applied: applied.length, skipped, by: by.name, byClientId: by.clientId });
    this.sendDraft();
    this.broadcastPresence();
  }

  // Redoing the send of a draft: the draft opens again (the one that is open, if there is one, gets those changes too) with the changes that
  // were sent, to be sent again or changed first. The game stays as the undo left it.
  reopenDraft(socket, entry, seq) {
    const { clientId } = socket.data;
    const by = this.presence.who(clientId);
    if (!this.draft) this.draft = { baseRevision: this.gs.state.revision, queue: [], fork: this.gs.fork(), startedBy: by };
    for (const item of entry.draft) this.draft.queue.push({ ...item, conflict: null });
    this.rebuildDraft(this.draft);

    const activity = this.collab.addActivity({
      rev: this.gs.state.revision, by, kind: 'redo',
      label: `Redid: ${entry.label}, opened again as a draft`
    });
    this.io.to(PRODUCERS).emit('activity', activity);
    this.sendDraft();
    this.broadcastPresence();
    if (Number.isInteger(seq)) socket.emit('action:applied', { seq, revision: this.gs.state.revision, draft: true, changes: entry.draft.length });
  }
}

module.exports = { Session, publicState, PRODUCERS };
