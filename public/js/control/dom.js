/**
 * Small helpers for building the control panel's pages without a framework.
 */

// h('button', { class: 'btn', onclick: fn, dataset: { a: 1 } }, 'Label', childNode)
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') {
      // custom properties (--name) cannot be assigned like ordinary ones
      for (const [name, entry] of Object.entries(value)) {
        if (name.startsWith('--')) node.style.setProperty(name, entry);
        else node.style[name] = entry;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') throw new Error('h() never sets raw HTML');
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  append(node, ...children);
  return node;
}

// Add children (nodes, text, or arrays of them) to a node
export function append(node, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// What an energy chip needs: the picture of the type, and the plain color drawn if the pictures are not there
export function energyStyle(type) {
  return { '--c': type.color, '--icon': `url(${type.icon})` };
}

export function replace(node, ...children) {
  clear(node);
  return append(node, ...children);
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// Call `fn` once things have been quiet for `ms`. `.flush()` runs a waiting call right now (so nothing
// typed is lost when the person moves on); it returns what `fn` returned.
export function debounce(fn, ms) {
  let timer = null;
  let waiting = null;
  const run = () => {
    timer = null;
    const args = waiting;
    waiting = null;
    return fn(...args);
  };
  const debounced = (...args) => {
    waiting = args;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.flush = () => {
    if (!timer) return undefined;
    clearTimeout(timer);
    return run();
  };
  return debounced;
}

// "just now", "12 s ago", "3 min ago"
export function ago(timestamp, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

// A stable color for a person, so each producer is always the same color
export function personColor(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 70%, 62%)`;
}

export const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

// ------------------------------------------------------------------ icons (inline, so they follow the text color)

const PATHS = {
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'm5 12 5 5L20 7',
  bolt: 'M13 2 3 14h8l-1 8 10-12h-8l1-8Z',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  skull: 'M12 3a8 8 0 0 0-8 8c0 2.8 1.4 5 3.5 6.2V20h9v-2.8C18.6 16 20 13.8 20 11a8 8 0 0 0-8-8ZM9 12h.01M15 12h.01',
  drop: 'M12 3s6 6.2 6 10.5A6 6 0 0 1 6 13.5C6 9.2 12 3 12 3Z',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z',
  play: 'M7 4v16l13-8L7 4Z',
  volume: 'M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  keyboard: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  send: 'm22 2-11 11M22 2l-7 20-4-9-9-4 20-7Z',
  user: 'M20 21a8 8 0 0 0-16 0M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  layout: 'M3 4h18v16H3ZM3 10h18M9 10v10',
  crop: 'M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2',
  evolve: 'M12 20V5M6 11l6-6 6 6',
  devolve: 'M12 4v15M6 13l6 6 6-6',
  // an egg with a crack: something that is about to become something else
  egg: 'M12 3c-3.6 0-7 6.2-7 11a7 7 0 0 0 14 0c0-4.8-3.4-11-7-11ZM5.4 13.6l2.5 2 2.1-2.4 2.1 2.4 2.1-2.4 2.4 2',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-.6-.6-2.6 2.4-2.4Z',
  move: 'M5 12h14M13 6l6 6-6 6'
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] || PATHS.star);
  svg.appendChild(path);
  return svg;
}
