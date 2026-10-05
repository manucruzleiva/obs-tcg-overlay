/**
 * Shared interface pieces: toast messages and the dialog (modal) window.
 */
import { h, icon, $ } from './dom.js';

// ------------------------------------------------------------------------------ toasts

export function toast(message, kind = 'info', ms = 4200) {
  const container = $('#toasts');
  if (!container) return;
  const node = h('div', { class: `toast toast-${kind}`, role: kind === 'error' || kind === 'warning' ? 'alert' : 'status' }, message);
  container.appendChild(node);
  // two frames so the transition runs
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('in')));
  setTimeout(() => {
    node.classList.remove('in');
    setTimeout(() => node.remove(), 300);
  }, ms);
}

// ------------------------------------------------------------------------------- modal

// Open dialogs, topmost last. A confirmation opens on top of the dialog that asked for it.
const stack = [];

function closeTop({ force = false } = {}) {
  const top = stack[stack.length - 1];
  // A dialog can refuse to close, for instance to ask first. It then closes itself with { force: true }.
  if (top && top.beforeClose && !force && top.beforeClose() === false) return;
  const entry = stack.pop();
  if (!entry) return;
  entry.root.remove();
  if (stack.length === 0) document.body.classList.remove('modal-open');
  if (entry.onClose) entry.onClose();
  if (entry.previouslyFocused && entry.previouslyFocused.isConnected && entry.previouslyFocused.focus) entry.previouslyFocused.focus();
}

// Close the topmost dialog
export function closeModal(options) {
  closeTop(options);
}

export function closeAllModals() {
  while (stack.length) closeTop({ force: true });
}

export const isModalOpen = () => stack.length > 0;

// Open a dialog. `body` and `footer` are nodes (or arrays of nodes). Returns { root, close }.
// Opening one normally replaces whatever is open; `stacked` puts it on top instead.
export function openModal({ title, subtitle, body, footer, size = 'md', onClose, beforeClose, name, stacked = false }) {
  if (!stacked) closeAllModals();

  const closeButton = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closeModal() }, icon('close'));
  const root = h('div', { class: `modal-backdrop${stack.length ? ' stacked' : ''}`, dataset: { modal: name || title } },
    h('div', { class: `modal modal-${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', { class: 'modal-head' },
        h('div', {}, h('h2', {}, title), subtitle && h('p', { class: 'modal-sub' }, subtitle)),
        closeButton),
      h('div', { class: 'modal-body' }, body),
      footer && h('footer', { class: 'modal-foot' }, footer)));

  // clicking the dark area outside the dialog closes it
  root.addEventListener('mousedown', (event) => {
    if (event.target === root && stack[stack.length - 1] && stack[stack.length - 1].root === root) closeModal();
  });

  stack.push({ root, onClose, beforeClose, previouslyFocused: document.activeElement });
  document.body.appendChild(root);
  document.body.classList.add('modal-open');

  const firstField = root.querySelector('[data-autofocus], input:not([type=hidden]), button.primary');
  if (firstField) firstField.focus();
  return { root, close: (options) => closeModal(options) };
}

// A yes/no question, shown on top of whatever is open. Resolves true or false.
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      answered = true;
      closeModal({ force: true });
      resolve(value);
    };
    openModal({
      title,
      size: 'sm',
      stacked: true,
      body: h('p', { class: 'confirm-text' }, message),
      footer: [
        h('button', { class: 'btn', type: 'button', onclick: () => answer(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', 'data-autofocus': true, onclick: () => answer(true) }, confirmLabel)
      ],
      onClose: () => { if (!answered) resolve(false); }
    });
  });
}

// A question with a text answer, shown on top of whatever is open. Resolves with the text, or null when cancelled.
// (The desktop app has no window.prompt, so every question that needs typing goes through here.)
// `check` may return a complaint to show under the box; the answer is refused until it returns nothing.
export function promptDialog({ title, label, message, value = '', placeholder = '', confirmLabel = 'OK', maxLength = 60, check = () => '' }) {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', { type: 'text', value, placeholder, maxlength: maxLength, 'aria-label': label || title, 'data-autofocus': true, autocomplete: 'off' });
    const complaint = h('p', { class: 'prompt-complaint', role: 'alert', hidden: true });
    const ok = h('button', { class: 'btn primary', type: 'button' }, confirmLabel);
    const refresh = () => {
      const text = check(input.value.trim());
      complaint.textContent = text || '';
      complaint.hidden = !text;
      ok.disabled = !input.value.trim() || Boolean(text);
    };
    const answer = (result) => {
      answered = true;
      closeModal({ force: true });
      resolve(result);
    };
    const submit = () => { if (!ok.disabled) answer(input.value.trim()); };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
    ok.addEventListener('click', submit);
    refresh();
    openModal({
      title, size: 'sm', stacked: true, name: 'prompt',
      body: h('div', { class: 'prompt-body' }, message && h('p', { class: 'confirm-text' }, message), h('label', { class: 'field' }, label && h('span', {}, label), input), complaint),
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => answer(null) }, 'Cancel'), ok],
      onClose: () => { if (!answered) resolve(null); }
    });
    input.select();
  });
}
