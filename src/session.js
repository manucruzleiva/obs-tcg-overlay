/**
 * The live session: who is connected, who may change the game, and how changes are applied.
 *
 * Every change goes through finish(), which bumps the revision, records who did what, keeps the
 * shared undo history, and tells everyone. Control panels send the revision they last saw with each
 * action; if another producer changed the same part of the game since then, the action is refused
 * instead of being applied twice.
 *
 * A producer can also work on a private draft: their changes run against a copy of the game that
 * only they see, and "send" applies them to the live game in one step.
 */

const actions = require('./actions');
const { Collab, Presence } = require('./services/collab');

const ACTION_EVENTS = [
  'action:trainerA', 'action:trainerB', 'action:match', 'action:toast',
  'action:card', 'action:settings', 'action:reset'
];

// Sockets that may change the game (control panels that passed the password check)
const PRODUCERS = 'producers';
const clientRoom = (clientId) => `client:${clientId}`;

// The state as clients see it: the API key is a secret and never leaves the server
function publicState(state) {
  const { apiKey, ...settings } = state.settings;
  return { ...state, settings: { ...settings, apiKeySet: Boolean(apiKey) } };
}

class Session {
  constructor({ io, gameState, log, afterChange = () => {} }) {
    this.io = io;
    this.gs = gameState;
    this.log = log;
    this.afterChange = afterChange;

    this.collab = new Collab();
    this.presence = new Presence();
    this.drafts = new Map(); // clientId -> { clientId, baseRevision, queue, fork }
    this.announceId = 0;
    this.sfxId = 0;
  }

  // ----------------------------------------------------------- connections

  // Wire up a freshly connected socket. socket.data holds { clientId, name, canControl }.
  attach(socket) {
    const { clientId, name, canControl } = socket.data;
    this.presence.join(socket.id, { role: canControl ? 'producer' : 'viewer', clientId, name });

    socket.emit('state:full', publicState(this.gs.state));

    if (canControl) {
      socket.join(PRODUCERS);
      socket.join(clientRoom(clientId));
      socket.emit('you', this.presence.who(clientId));
      socket.emit('activity:history', this.collab.activity);
      if (this.drafts.has(clientId)) this.sendDraft(clientId);
    }
    this.broadcastPresence();

    for (const event of ACTION_EVENTS) {
      socket.on(event, (data) => this.guard(socket, () => this.handleAction(socket, event, data)));
    }
    socket.on('action:undo', (data) => this.guard(socket, () => this.undo(socket, data)));
    socket.on('action:redo', (data) => this.guard(socket, () => this.redo(socket, data)));
    socket.on('draft:start', () => this.guard(socket, () => this.draftStart(socket)));
    socket.on('draft:discard', () => this.guard(socket, () => this.draftDiscard(socket)));
    socket.on('draft:send', (data) => this.guard(socket, () => this.draftSend(socket, data)));
    socket.on('presence:rename', (data) => this.guard(socket, () => this.rename(socket, data)));

    socket.on('disconnect', () => this.detach(socket));
  }

  detach(socket) {
    this.presence.leave(socket.id);
    const { clientId } = socket.data;
    // A draft belongs to a person: it goes when their last page closes
    if (!this.presence.hasClient(clientId)) this.drafts.delete(clientId);
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
    const producers = this.presence.producers().map((p) => ({ ...p, drafting: this.drafts.has(p.clientId) }));
    this.io.to(PRODUCERS).emit('presence', { producers, viewers: this.presence.viewerCount() });
  }

  rename(socket, data) {
    if (!socket.data.canControl) return;
    const { clientId } = socket.data;
    if (this.presence.rename(clientId, data && data.name)) {
      this.io.to(clientRoom(clientId)).emit('you', this.presence.who(clientId));
      this.broadcastPresence();
    }
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

  // The one place a change becomes official: new revision, undo entry, activity, broadcast
  finish({ before, targets, label, clientId, by, announced = [], cues = [], kind, undoLabel = label, recordUndo = true }) {
    const gs = this.gs;
    const changed = JSON.stringify({ ...before, revision: 0 }) !== JSON.stringify({ ...gs.state, revision: 0 });

    gs.state.revision += 1;
    const rev = gs.state.revision;
    const who = by || this.presence.who(clientId);

    this.collab.recordChange({ rev, clientId, by: who, label, targets });
    if (recordUndo && changed) this.collab.pushUndo({ before, rev, label: undoLabel, by: who });
    if (kind !== 'undo' && kind !== 'redo') this.collab.clearRedo();

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
    this.refreshDrafts();
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
    this.collab.pushRedo({ snapshot: this.gs.snapshot(), label: entry.label, by: entry.by });
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

  // ---------------------------------------------------------------- drafts

  draftStart(socket) {
    if (!socket.data.canControl) return;
    const { clientId } = socket.data;
    if (!this.drafts.has(clientId)) {
      this.drafts.set(clientId, { clientId, baseRevision: this.gs.state.revision, queue: [], fork: this.gs.fork() });
      this.broadcastPresence();
    }
    this.sendDraft(clientId);
  }

  draftDiscard(socket) {
    if (!socket.data.canControl) return;
    const { clientId } = socket.data;
    this.drafts.delete(clientId);
    this.io.to(clientRoom(clientId)).emit('draft:state', { active: false });
    this.broadcastPresence();
  }

  draftAction(socket, event, payload, spec, seq) {
    const { clientId } = socket.data;
    const draft = this.drafts.get(clientId);
    if (!draft) {
      socket.emit('action:rejected', { reason: 'no-draft', seq });
      return;
    }

    const before = draft.fork.snapshot();
    try {
      spec.run(draft.fork);
    } catch (error) {
      draft.fork.restore(before);
      throw error;
    }
    draft.queue.push({ event, payload, label: spec.label(draft.fork), targets: spec.targets(), conflict: null });
    this.sendDraft(clientId, seq);
  }

  // Replay a draft's actions on a fresh copy of the live game, marking the ones that
  // touch something another producer changed since the draft began
  rebuildDraft(draft) {
    const fork = this.gs.fork();
    for (const entry of draft.queue) {
      const conflict = entry.targets ? this.collab.findConflict(draft.baseRevision, draft.clientId, entry.targets) : null;
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

  refreshDrafts() {
    for (const draft of this.drafts.values()) {
      this.rebuildDraft(draft);
      this.sendDraft(draft.clientId);
    }
  }

  // `ack` is the sequence number of the action this answers (absent when the draft just refreshed)
  sendDraft(clientId, ack) {
    const draft = this.drafts.get(clientId);
    if (!draft) return;
    this.io.to(clientRoom(clientId)).emit('draft:state', {
      active: true,
      ack,
      baseRevision: draft.baseRevision,
      revision: this.gs.state.revision,
      preview: publicState(draft.fork.state),
      changes: draft.queue.map(({ label, conflict }) => ({ label, conflict }))
    });
  }

  // mode: 'safe' (default: stop and report if anything conflicts), 'skip' (leave conflicting
  // changes out) or 'force' (apply everything)
  draftSend(socket, data) {
    if (!socket.data.canControl) return;
    const { clientId } = socket.data;
    const draft = this.drafts.get(clientId);
    if (!draft) {
      socket.emit('action:rejected', { reason: 'no-draft' });
      return;
    }
    const mode = ['skip', 'force'].includes(data && data.mode) ? data.mode : 'safe';

    this.rebuildDraft(draft);
    const conflicting = draft.queue.filter((entry) => entry.conflict);
    if (conflicting.length && mode === 'safe') {
      socket.emit('draft:conflicts', { conflicts: conflicting.map(({ label, conflict }) => ({ label, conflict })) });
      this.sendDraft(clientId);
      return;
    }

    const before = this.gs.snapshot();
    const applied = [];
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
        targets.push(...(entry.targets || []));
      } catch (error) {
        skipped.push({ label: entry.label, reason: error.message });
      }
    }

    this.drafts.delete(clientId);

    if (applied.length) {
      const preview = applied.slice(0, 3).join('; ') + (applied.length > 3 ? '…' : '');
      this.finish({
        before, targets, clientId, announced, cues, kind: 'draft',
        label: `Sent ${applied.length} change${applied.length === 1 ? '' : 's'}: ${preview}`,
        undoLabel: `${applied.length} sent change${applied.length === 1 ? '' : 's'}`
      });
    }

    this.io.to(clientRoom(clientId)).emit('draft:sent', { applied: applied.length, skipped });
    this.io.to(clientRoom(clientId)).emit('draft:state', { active: false });
    this.broadcastPresence();
  }
}

module.exports = { Session, publicState, PRODUCERS };
