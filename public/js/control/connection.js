/**
 * The control panel's link to the server: the game state, other producers, your private draft, and
 * sending actions with the revision you last saw so the server can spot a double click.
 */

// Only changes to the game itself can be drafted; announcements and settings always happen right away
const DRAFTABLE = new Set(['action:trainerA', 'action:trainerB', 'action:match', 'action:card']);
const ACTIVITY_LIMIT = 60;
const ANSWER_TIMEOUT_MS = 8000;

function stored(storage, key, make) {
  try {
    let value = storage.getItem(key);
    if (!value && make) {
      value = make();
      storage.setItem(key, value);
    }
    return value || '';
  } catch (error) {
    return make ? make() : '';
  }
}

const randomId = () => `p-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export class Connection {
  constructor() {
    this.listeners = new Map();
    this.live = null; // the real game, as everyone sees it
    this.draft = { active: false }; // your private draft (see the server's draft messages)
    this.presence = { producers: [], viewers: 0 };
    this.activity = [];
    this.you = null;
    this.connected = false;
    this.seq = 0;
    this.pending = new Map();

    // Kept per browser so a reload, or a second tab, is the same person
    this.clientId = stored(window.localStorage, 'oto-client-id', randomId);
    this.name = stored(window.localStorage, 'oto-producer-name');

    this.socket = window.io({ auth: { role: 'control', clientId: this.clientId, name: this.name } });
    this.wire();
  }

  // ---- tiny event emitter

  on(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
    return () => this.listeners.get(name).delete(listener);
  }

  emit(name, data) {
    for (const listener of this.listeners.get(name) || []) listener(data);
  }

  // What the pages should show: the draft preview while drafting, otherwise the real game
  get state() {
    return this.draft.active ? this.draft.preview : this.live;
  }

  get revision() {
    return this.live ? this.live.revision : 0;
  }

  // ---- incoming

  wire() {
    const socket = this.socket;

    socket.on('connect', () => {
      this.connected = true;
      this.emit('connection', true);
    });
    socket.on('disconnect', () => {
      this.connected = false;
      for (const [seq, entry] of this.pending) entry.resolve({ ok: false, rejected: { reason: 'offline' } });
      this.pending.clear();
      this.emit('connection', false);
    });

    const onState = (state) => {
      this.live = state;
      this.emit('state', state);
    };
    socket.on('state:full', onState);
    socket.on('state:update', onState);

    socket.on('presence', (presence) => {
      this.presence = presence;
      this.emit('presence', presence);
    });
    socket.on('you', (you) => {
      this.you = you;
      this.emit('you', you);
    });
    socket.on('activity:history', (history) => {
      this.activity = history.slice(-ACTIVITY_LIMIT);
      this.emit('activity', this.activity);
    });
    socket.on('activity', (entry) => {
      this.activity.push(entry);
      if (this.activity.length > ACTIVITY_LIMIT) this.activity.shift();
      this.emit('activity', this.activity);
    });

    socket.on('draft:state', (draft) => {
      this.draft = draft.active ? draft : { active: false };
      if (draft.ack !== undefined && this.pending.has(draft.ack)) this.settle(draft.ack, { ok: true });
      this.emit('draft', this.draft);
    });
    socket.on('draft:sent', (result) => this.emit('draft-sent', result));
    socket.on('draft:conflicts', (data) => this.emit('draft-conflicts', data));

    socket.on('action:applied', (answer) => this.settle(answer.seq, { ok: true, applied: answer }));
    socket.on('action:rejected', (rejected) => {
      this.settle(rejected.seq, { ok: false, rejected });
      this.emit('rejected', rejected);
    });

    for (const name of ['announce', 'sfx', 'theme:changed', 'sounds:changed', 'catalog:progress']) {
      socket.on(name, (data) => this.emit(name, data));
    }
  }

  settle(seq, result) {
    const entry = this.pending.get(seq);
    if (!entry) return;
    this.pending.delete(seq);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  // ---- outgoing

  // Send an action. Resolves with { ok: true } or { ok: false, rejected } once the server answers.
  send(event, payload = {}) {
    if (!this.connected) {
      const rejected = { reason: 'offline' };
      this.emit('rejected', rejected);
      return Promise.resolve({ ok: false, rejected });
    }

    const seq = ++this.seq;
    const meta = { baseRevision: this.revision, seq };
    if (this.draft.active && DRAFTABLE.has(event)) meta.draft = true;

    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(seq, { ok: false, rejected: { reason: 'timeout' } }), ANSWER_TIMEOUT_MS);
      this.pending.set(seq, { resolve, timer });
      this.socket.emit(event, { ...payload, meta });
    });
  }

  // Shortcuts for the common actions
  trainer(side, action, params) { return this.send(`action:${side}`, { action, ...params }); }
  match(action, params) { return this.send('action:match', { action, ...params }); }
  toast(action, params) { return this.send('action:toast', { action, ...params }); }
  card(action, params) { return this.send('action:card', { action, ...params }); }
  settings(patch) { return this.send('action:settings', { action: 'update', ...patch }); }
  undo() { return this.send('action:undo'); }
  redo() { return this.send('action:redo'); }

  startDraft() { this.socket.emit('draft:start'); }
  discardDraft() { this.socket.emit('draft:discard'); }
  sendDraft(mode) { this.socket.emit('draft:send', { mode }); }

  rename(name) {
    this.name = name;
    try { window.localStorage.setItem('oto-producer-name', name); } catch (error) { /* a private window cannot remember it */ }
    this.socket.emit('presence:rename', { name });
  }
}
