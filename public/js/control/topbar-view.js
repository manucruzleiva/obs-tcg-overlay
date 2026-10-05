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
    this.viewers = h('span', { class: 'viewers', title: 'Overlay screens connected' });

    this.undoButton = h('button', { class: 'icon-btn', type: 'button', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => app.undo() }, icon('undo'));
    this.redoButton = h('button', { class: 'icon-btn', type: 'button', title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo', onclick: () => app.redo() }, icon('redo'));
    this.draftButton = h('button', { class: 'btn draft-toggle', type: 'button', title: 'Make changes privately, then send them all to the overlay at once', onclick: () => app.toggleDraft() },
      icon('send', 16), h('span', {}, 'Edit & send'));

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
        h('button', { class: 'btn', type: 'button', onclick: () => app.openPreview() }, icon('eye', 16), 'Preview'),
        h('button', { class: 'icon-btn', type: 'button', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', onclick: () => app.openHelp() }, icon('keyboard')),
        h('button', { class: 'icon-btn', type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: () => app.openSettings() }, icon('gear'))));
    return this.root;
  }

  setConnected(connected) {
    this.status.textContent = connected ? 'Connected' : 'Reconnecting…';
    this.status.className = `conn-pill ${connected ? 'ok' : 'bad'}`;
  }

  updatePresence(presence, you) {
    replace(this.people, presence.producers.map((person) => {
      const mine = you && person.clientId === you.clientId;
      return h('span', { class: `person${person.drafting ? ' drafting' : ''}${mine ? ' me' : ''}`, title: `${person.name}${mine ? ' (you)' : ''}${person.drafting ? ' is editing a draft' : ''}` },
        h('span', { class: 'avatar', style: { background: personColor(person.clientId) } }, initials(person.name)),
        h('span', { class: 'person-name' }, person.name));
    }));
    this.viewers.textContent = presence.viewers === 1 ? '1 overlay' : `${presence.viewers} overlays`;
    this.viewers.classList.toggle('none', presence.viewers === 0);
  }

  updateHistory(canUndo) {
    this.undoButton.disabled = !canUndo;
  }

  updateDraft(active) {
    this.draftButton.classList.toggle('on', active);
    this.draftButton.querySelector('span').textContent = active ? 'Editing draft' : 'Edit & send';
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
    this.root = h('div', { class: 'draft-banner', hidden: true, role: 'region', 'aria-label': 'Draft' },
      h('div', { class: 'draft-main' },
        h('span', { class: 'draft-title' }, icon('send', 16), 'Draft: nothing here is on the overlay yet'),
        h('span', { class: 'draft-count' }, this.count),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onclick: () => app.discardDraft() }, 'Discard'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => app.sendDraft('safe') }, icon('send', 16), 'Send to overlay', h('kbd', {}, 'Ctrl+Enter'))),
      this.list);
  }

  update(draft) {
    this.root.hidden = !draft.active;
    if (!draft.active) return;
    const changes = draft.changes || [];
    this.count.textContent = changes.length === 0 ? 'No changes yet' : `${changes.length} change${changes.length === 1 ? '' : 's'}`;
    replace(this.list, changes.map((change) => h('li', { class: change.conflict ? 'conflict' : '' },
      change.label,
      change.conflict && h('span', { class: 'conflict-note' }, change.conflict.by ? ` · ${change.conflict.by} changed this since` : ' · no longer applies'))));
  }
}
