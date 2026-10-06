/**
 * The bar across the top (who is here, undo and redo, edit-and-send, preview, settings) and the
 * banner shown while you are editing a private draft.
 */
import { h, icon, replace, personColor, initials } from './dom.js';

export class TopBar {
  constructor(app) {
    this.app = app;
    this.root = this.build();
    this.loadShareLink();
  }

  build() {
    const { app } = this;

    this.status = h('span', { class: 'conn-pill', role: 'status' }, 'Connecting…');
    this.shareLink = h('button', { class: 'share-chip', type: 'button', hidden: true, title: 'Open this link on another device on the same network to produce together. Click to copy.', onclick: () => this.copyShareLink() },
      icon('share', 14), h('span', { class: 'share-text' }));
    this.people = h('div', { class: 'people', 'aria-label': 'Producers connected' });
    this.renaming = false; // a name is being typed in the list: the list is not redrawn under it
    this.viewers = h('span', { class: 'viewers', title: 'Overlay screens connected' });

    this.undoButton = h('button', { class: 'icon-btn', type: 'button', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => app.undo() }, icon('undo'));
    this.redoButton = h('button', { class: 'icon-btn', type: 'button', title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo', onclick: () => app.redo() }, icon('redo'));
    this.draftButton = h('button', { class: 'btn draft-toggle', type: 'button', title: 'Draft mode (Shift+Enter): make changes together with the other producers without the overlay showing them, then send them all at once. It stays on after a send.', onclick: () => app.toggleDraft() },
      icon('send', 16), h('span', {}, 'Draft mode'));

    this.root = h('header', { class: 'topbar' },
      h('div', { class: 'brand' },
        h('img', { src: '/logo.gif', alt: '', class: 'brand-logo' }),
        h('div', {}, h('div', { class: 'brand-name' }, 'OTO'), h('div', { class: 'brand-sub' }, 'Producer'))),
      this.status,
      this.shareLink,
      h('div', { class: 'spacer' }),
      this.people,
      this.viewers,
      h('div', { class: 'bar-actions' },
        this.undoButton, this.redoButton, this.draftButton,
        h('button', { class: 'btn preview-btn', type: 'button', title: 'See the overlay here. Shift+click opens it in the browser.', onclick: (event) => app.openPreview(event.shiftKey) }, icon('eye', 16), 'Preview'),
        h('button', { class: 'icon-btn', type: 'button', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', onclick: () => app.openHelp() }, icon('keyboard')),
        h('button', { class: 'icon-btn', type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: () => app.openSettings() }, icon('gear'))));
    return this.root;
  }

  setConnected(connected) {
    this.status.textContent = connected ? 'Connected' : 'Reconnecting…';
    this.status.className = `conn-pill ${connected ? 'ok' : 'bad'}`;
  }

  updatePresence(presence, you) {
    this.latest = { presence, you };
    if (this.renaming) { this.viewers.textContent = presence.viewers === 1 ? '1 overlay' : `${presence.viewers} overlays`; return; }
    const host = Boolean(you && you.host);
    replace(this.people, presence.producers.map((person) => {
      const mine = you && person.clientId === you.clientId;
      const canRename = mine || host; // everybody can rename themselves, and the host anybody
      const canKick = host && !mine && !person.host;
      const chip = h('span', {
        class: `person${person.drafting ? ' drafting' : ''}${mine ? ' me' : ''}${person.host ? ' host' : ''}`,
        dataset: { client: person.clientId },
        title: `${person.name}${mine ? ' (you)' : ''}${person.host ? ' · on the computer that runs OTO' : ''}${person.drafting ? ' is editing the draft' : ''}${canRename ? '. Double-click to change the name' : ''}`
      },
      h('span', { class: 'avatar', style: { background: personColor(person.clientId) } }, initials(person.name)),
      h('span', { class: 'person-name' }, person.name),
      canKick && h('button', { class: 'kick-btn', type: 'button', title: `Remove ${person.name} from the session`, 'aria-label': `Remove ${person.name}`, onclick: (event) => { event.stopPropagation(); this.app.kickProducer(person); } }, icon('close', 12)));
      if (canRename) chip.addEventListener('dblclick', () => this.startRename(chip, person));
      return chip;
    }));
    // the host can let the producers it removed come back
    this.forgiveButton = this.forgiveButton || h('button', { class: 'btn tiny forgive-btn', type: 'button', title: 'Let the producers you removed come back in', onclick: () => this.app.conn.forgive() });
    this.forgiveButton.textContent = `Let ${presence.kicked} removed back in`;
    this.forgiveButton.hidden = !(host && presence.kicked > 0);
    if (!this.forgiveButton.isConnected) this.people.after(this.forgiveButton);
    this.viewers.textContent = presence.viewers === 1 ? '1 overlay' : `${presence.viewers} overlays`;
    this.viewers.classList.toggle('none', presence.viewers === 0);
  }

  // Change the name of a producer in place: Enter (or clicking away) keeps it, Escape leaves it as it was
  startRename(chip, person) {
    const label = chip.querySelector('.person-name');
    if (!label || this.renaming) return;
    this.renaming = true;
    const input = h('input', { class: 'person-edit', type: 'text', maxlength: 24, value: person.name, 'aria-label': `Name of ${person.name}` });
    let finished = false;
    const finish = (keep) => {
      if (finished) return;
      finished = true;
      this.renaming = false;
      const name = input.value.trim();
      if (keep && name && name !== person.name) this.app.renameProducer(person, name);
      if (this.latest) this.updatePresence(this.latest.presence, this.latest.you);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  updateHistory(canUndo) {
    this.undoButton.disabled = !canUndo;
  }

  updateDraft(active) {
    this.draftButton.classList.toggle('on', active);
    this.draftButton.querySelector('span').textContent = active ? 'Draft mode: on' : 'Draft mode';
  }

  // The address other devices can use to open this page
  async loadShareLink() {
    try {
      const network = await (await fetch('/api/network')).json();
      this.network = network;
      const first = network.lan[0];
      const text = this.shareLink.querySelector('.share-text');
      if (first) {
        text.textContent = first.control;
        this.shareLink.hidden = false;
      } else if (!network.shared) {
        text.textContent = 'This computer only';
        this.shareLink.title = 'The server only accepts connections from this computer (HOST=127.0.0.1)';
        this.shareLink.hidden = false;
      }
    } catch (error) {
      // the page works without it
    }
  }

  async copyShareLink() {
    const link = this.network && this.network.lan[0] && this.network.lan[0].control;
    if (!link) return;
    await this.app.copyText(link);
    this.app.toast('Link copied. Send it to anyone on your network who should produce with you.', 'success');
  }
}

export class DraftBanner {
  constructor(app) {
    this.app = app;
    this.list = h('ul', { class: 'draft-changes' });
    this.count = h('strong', {});
    this.clearButton = h('button', { class: 'btn', type: 'button', title: 'Throw the changes away and stay in draft mode', onclick: () => app.clearDraft() }, 'Throw changes away');
    this.sendButton = h('button', { class: 'btn primary', type: 'button', onclick: () => app.sendDraft('safe') }, icon('send', 16), 'Send to overlay', h('kbd', {}, 'Ctrl+Enter'));
    this.root = h('div', { class: 'draft-banner', hidden: true, role: 'region', 'aria-label': 'Draft' },
      h('div', { class: 'draft-main' },
        h('span', { class: 'draft-title' }, icon('send', 16), 'Draft mode, shared with the other producers: changes wait here until they are sent'),
        h('span', { class: 'draft-count' }, this.count),
        h('span', { class: 'spacer' }),
        this.clearButton,
        h('button', { class: 'btn', type: 'button', title: 'Leave draft mode (Shift+Enter)', onclick: () => app.toggleDraft() }, 'Leave draft mode', h('kbd', {}, 'Shift+Enter')),
        this.sendButton),
      this.list);
  }

  update(draft) {
    this.root.hidden = !draft.active;
    if (!draft.active) return;
    const changes = draft.changes || [];
    this.count.textContent = changes.length === 0 ? 'No changes waiting' : `${changes.length} change${changes.length === 1 ? '' : 's'} waiting`;
    this.clearButton.disabled = changes.length === 0;
    this.sendButton.disabled = changes.length === 0;
    replace(this.list, changes.map((change) => h('li', { class: change.conflict ? 'conflict' : '' },
      change.by && h('span', { class: 'draft-by' }, `${change.by}: `),
      change.label,
      change.conflict && h('span', { class: 'conflict-note' }, change.conflict.by ? ` · ${change.conflict.by} changed this since` : ' · no longer applies'))));
  }
}
