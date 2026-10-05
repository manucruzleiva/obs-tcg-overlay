/**
 * Building blocks for several producers driving one match.
 *
 * - Collab keeps a log of what changed (so a stale click can be recognised), the shared
 *   undo history, and the activity feed.
 * - Presence knows who is connected and what to call them.
 *
 * Everything here is plain data and logic with no sockets, so it is easy to test.
 */

// Does the change to `a` touch the same part of the game as `b`? ("trainerA.active" overlaps
// "trainerA.active.hp"; "*" means everything.)
function overlaps(a, b) {
  return a === '*' || b === '*' || a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

class Collab {
  constructor({ changeLogSize = 500, activitySize = 50, undoSize = 50, seqMemory = 200 } = {}) {
    this.changeLogSize = changeLogSize;
    this.activitySize = activitySize;
    this.undoSize = undoSize;
    this.seqMemory = seqMemory;

    this.changes = []; // { rev, clientId, by, label, targets }
    this.undoStack = []; // { before, rev, label, by }
    this.redoStack = []; // { snapshot, label, by } states that an undo stepped back from
    this.activity = []; // { id, ts, rev, by, label, kind }
    this.seen = new Map(); // clientId -> Set of action sequence numbers already handled
    this.nextActivityId = 1;
  }

  // ---- change log and conflict detection

  recordChange(change) {
    this.changes.push(change);
    if (this.changes.length > this.changeLogSize) this.changes.shift();
  }

  // The newest change made by someone else, after the revision the sender last saw, to a part
  // of the game the sender is about to change. Null means the action is safe to apply.
  findConflict(baseRevision, clientId, targets) {
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const change = this.changes[i];
      if (change.rev <= baseRevision) break;
      if (change.clientId === clientId) continue;
      if (change.targets.some((t) => targets.some((u) => overlaps(t, u)))) return change;
    }
    return null;
  }

  // ---- idempotency: a retried or re-delivered action carries the same sequence number

  claim(clientId, seq) {
    let seen = this.seen.get(clientId);
    if (!seen) {
      seen = new Set();
      this.seen.set(clientId, seen);
    }
    if (seen.has(seq)) return false;
    seen.add(seq);
    if (seen.size > this.seqMemory) seen.delete(seen.values().next().value);
    return true;
  }

  // ---- shared undo history

  pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.undoSize) this.undoStack.shift();
  }

  peekUndo() {
    return this.undoStack[this.undoStack.length - 1] || null;
  }

  popUndo() {
    return this.undoStack.pop() || null;
  }

  // ---- redo: only valid until the next real change

  pushRedo(entry) {
    this.redoStack.push(entry);
    if (this.redoStack.length > this.undoSize) this.redoStack.shift();
  }

  popRedo() {
    return this.redoStack.pop() || null;
  }

  clearRedo() {
    this.redoStack = [];
  }

  // ---- activity feed

  addActivity({ rev, by, label, kind }) {
    const entry = { id: this.nextActivityId++, ts: Date.now(), rev, by, label, kind };
    this.activity.push(entry);
    if (this.activity.length > this.activitySize) this.activity.shift();
    return entry;
  }
}

// Who is connected. A producer is identified by a client id the browser keeps, so a page
// reload (or a second tab) is the same person.
class Presence {
  constructor() {
    this.sockets = new Map(); // socketId -> { role, clientId }
    this.names = new Map(); // clientId -> display name
    this.counter = 0;
  }

  static cleanName(name) {
    if (typeof name !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  }

  join(socketId, { role, clientId, name }) {
    this.sockets.set(socketId, { role, clientId });
    if (role === 'producer') {
      const chosen = Presence.cleanName(name);
      if (chosen) this.names.set(clientId, chosen);
      else if (!this.names.has(clientId)) this.names.set(clientId, `Producer ${++this.counter}`);
    }
  }

  leave(socketId) {
    const info = this.sockets.get(socketId);
    this.sockets.delete(socketId);
    return info;
  }

  rename(clientId, name) {
    const chosen = Presence.cleanName(name);
    if (!chosen) return false;
    this.names.set(clientId, chosen);
    return true;
  }

  who(clientId) {
    return { clientId, name: this.names.get(clientId) || 'Someone' };
  }

  // Producers with at least one open page, in the order they first appeared
  producers() {
    const tabs = new Map();
    for (const { role, clientId } of this.sockets.values()) {
      if (role === 'producer') tabs.set(clientId, (tabs.get(clientId) || 0) + 1);
    }
    return [...tabs].map(([clientId, count]) => ({ clientId, name: this.names.get(clientId), tabs: count }));
  }

  viewerCount() {
    let count = 0;
    for (const { role } of this.sockets.values()) if (role !== 'producer') count++;
    return count;
  }

  hasClient(clientId) {
    for (const info of this.sockets.values()) if (info.clientId === clientId) return true;
    return false;
  }
}

module.exports = { Collab, Presence, overlaps };
