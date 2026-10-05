/**
 * The design editor's canvas: the real overlay drawn at full size inside a frame, with handles over each
 * piece of it. Drag a piece to move it, drag a corner to resize it, scroll or pinch to zoom, hold Space
 * (or the middle button) and drag to pan. What it changes goes into the editor model; the overlay inside
 * the frame is told, and tells back where every piece ended up.
 */
import { h } from './dom.js';

const STAGE_W = 1920;
const STAGE_H = 1080;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const SNAP_PX = 8; // how close an edge must come to a line to jump onto it (on screen)
const NUDGE = 1;
const NUDGE_BIG = 10;

const THEME = window.OTO_THEME;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round2 = (value) => Math.round(value * 100) / 100;

// A turn of a mouse wheel, as against two fingers moving on a trackpad
const isMouseWheel = (event) => event.deltaMode !== 0 || (event.deltaX === 0 && Math.abs(event.deltaY) >= 50 && Number.isInteger(event.deltaY));
const isTyping = (target) => target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

export class EditorCanvas {
  // model: the EditorModel. `sample()` gives the match to draw. `assetUrl(ref)` is the address of a file of the design.
  constructor({ model, sample, assetUrl, onView, onSelect }) {
    this.model = model;
    this.sample = sample;
    this.assetUrl = assetUrl;
    this.onView = onView || (() => {});
    this.onSelect = onSelect || (() => {});

    this.view = { zoom: 0.5, x: 0, y: 0 };
    this.fitted = true; // follows the size of the window until someone zooms or pans
    this.snap = true;
    this.selected = null;
    this.rects = {};
    this.ready = false;
    this.pointers = new Map(); // fingers on a touch screen, for pinching
    this.drag = null;
    this.spaceDown = false;
    this.banner = false;
    this.nudgeTimer = null;

    this.build();
    this.listen();
  }

  // ------------------------------------------------------------------------------------ structure

  build() {
    this.frame = h('iframe', { class: 'editor-frame', src: '/overlay?editor=1', title: 'The overlay', tabindex: '-1' });
    this.boxes = new Map(THEME.BLOCKS.map((block) => [block.key, h('div', {
      class: 'editor-box', dataset: { key: block.key }, title: block.label, hidden: true
    })]));
    this.boxLayer = h('div', { class: 'editor-boxes' }, [...this.boxes.values()]);
    this.guideLayer = h('div', { class: 'editor-guides', 'aria-hidden': 'true' });
    this.selectionLabel = h('span', { class: 'editor-selection-label' });
    this.selection = h('div', { class: 'editor-selection', hidden: true },
      this.selectionLabel,
      ['nw', 'ne', 'sw', 'se'].map((corner) => h('span', { class: `editor-handle ${corner}`, dataset: { handle: corner }, title: 'Drag to resize' })));
    this.world = h('div', { class: 'editor-world' }, this.frame, this.boxLayer, this.guideLayer, this.selection);
    this.element = h('div', {
      class: 'editor-viewport', tabindex: '0', role: 'application',
      'aria-label': 'The overlay. Drag a piece to move it, drag a corner to resize it, scroll or pinch to zoom, hold Space and drag to pan.'
    }, this.world);
  }

  listen() {
    const view = this.element;
    view.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    view.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    view.addEventListener('pointermove', (event) => this.onPointerMove(event));
    view.addEventListener('pointerup', (event) => this.onPointerUp(event));
    view.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    view.addEventListener('keydown', (event) => this.onKeyDown(event));
    view.addEventListener('contextmenu', (event) => event.preventDefault());
    this.keyUp = (event) => { if (event.key === ' ') { this.spaceDown = false; view.classList.remove('panning'); } };
    window.addEventListener('keyup', this.keyUp);

    this.onMessage = (event) => {
      if (event.source !== this.frame.contentWindow || event.origin !== window.location.origin) return;
      const message = event.data || {};
      if (message.kind === 'ready') {
        this.ready = true;
        this.draw();
      } else if (message.kind === 'drawn') {
        this.measure();
      }
    };
    window.addEventListener('message', this.onMessage);

    this.resizer = new ResizeObserver(() => { if (this.fitted) this.fit(); });
    this.resizer.observe(view);
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    window.removeEventListener('keyup', this.keyUp);
    this.resizer.disconnect();
    clearTimeout(this.nudgeTimer);
  }

  // ------------------------------------------------------------------------------- the overlay in the frame

  // Send the draft design and the made-up match to the overlay (it answers when it has drawn them)
  draw() {
    if (!this.ready) return;
    const target = this.frame.contentWindow;
    const origin = window.location.origin;
    target.postMessage({ kind: 'design', theme: this.model.theme(this.assetUrl) }, origin);
    target.postMessage({ kind: 'state', state: this.sample() }, origin);
    target.postMessage({ kind: 'banner', show: this.banner }, origin);
  }

  // Only the design changed (while dragging): no need to send the match again
  redesign() {
    if (!this.ready) return;
    this.frame.contentWindow.postMessage({ kind: 'design', theme: this.model.theme(this.assetUrl) }, window.location.origin);
  }

  showBanner(show) {
    this.banner = show;
    if (this.ready) this.frame.contentWindow.postMessage({ kind: 'banner', show }, window.location.origin);
  }

  // Ask the overlay where every piece is, and put the handles there
  measure() {
    const overlay = this.frame.contentWindow && this.frame.contentWindow.oto;
    if (!overlay || !overlay.blockRects) return;
    this.rects = overlay.blockRects();
    const order = Object.entries(this.rects).filter(([, rect]) => rect).sort(([, a], [, b]) => b.w * b.h - a.w * a.h);
    // bigger pieces first, so a small one inside a big one is on top and can be picked
    for (const [key, rect] of order) {
      const box = this.boxes.get(key);
      this.place(box, rect);
      box.hidden = false;
      this.boxLayer.appendChild(box);
    }
    for (const [key, box] of this.boxes) if (!this.rects[key]) box.hidden = true;
    this.placeSelection();
    this.element.dispatchEvent(new CustomEvent('measured', { detail: this.rects }));
  }

  place(node, rect) {
    node.style.left = `${rect.x}px`;
    node.style.top = `${rect.y}px`;
    node.style.width = `${rect.w}px`;
    node.style.height = `${rect.h}px`;
  }

  // ------------------------------------------------------------------------------------ selection

  select(key) {
    if (this.selected === key) return;
    this.selected = key;
    for (const [boxKey, box] of this.boxes) box.classList.toggle('on', boxKey === key);
    this.placeSelection();
    this.onSelect(key);
  }

  placeSelection(rect = this.selected && this.rects[this.selected]) {
    if (!this.selected || !rect) {
      this.selection.hidden = true;
      return;
    }
    this.selection.hidden = false;
    this.place(this.selection, rect);
    // keep the handles the same size on screen, whatever the zoom
    this.selection.style.setProperty('--inverse', String(1 / this.view.zoom));
    const block = THEME.BLOCKS.find((entry) => entry.key === this.selected);
    this.selectionLabel.textContent = block ? block.label : this.selected;
  }

  // ----------------------------------------------------------------------------------- the view

  applyView() {
    const { zoom, x, y } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.element.style.setProperty('--zoom', String(zoom));
    this.selection.style.setProperty('--inverse', String(1 / zoom));
    this.onView(this.view);
  }

  // The whole stage, centred, with a little room around it
  fit() {
    const box = this.element.getBoundingClientRect();
    if (box.width < 10 || box.height < 10) return;
    const zoom = clamp(Math.min((box.width - 40) / STAGE_W, (box.height - 40) / STAGE_H), MIN_ZOOM, MAX_ZOOM);
    this.view = { zoom, x: (box.width - STAGE_W * zoom) / 2, y: (box.height - STAGE_H * zoom) / 2 };
    this.fitted = true;
    this.applyView();
  }

  // 100%: one stage pixel is one screen pixel
  actualSize() {
    const box = this.element.getBoundingClientRect();
    this.zoomTo(1, box.width / 2, box.height / 2);
  }

  zoomTo(zoom, cx, cy) {
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const k = next / this.view.zoom;
    // the point under (cx, cy) stays under it
    this.view = { zoom: next, x: cx - (cx - this.view.x) * k, y: cy - (cy - this.view.y) * k };
    this.fitted = false;
    this.applyView();
  }

  zoomBy(factor, cx, cy) {
    if (cx === undefined) {
      const box = this.element.getBoundingClientRect();
      cx = box.width / 2;
      cy = box.height / 2;
    }
    this.zoomTo(this.view.zoom * factor, cx, cy);
  }

  panBy(dx, dy) {
    this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
    this.fitted = false;
    this.applyView();
  }

  // Where a point of the screen is on the stage
  toStage(clientX, clientY) {
    const box = this.element.getBoundingClientRect();
    return { x: (clientX - box.left - this.view.x) / this.view.zoom, y: (clientY - box.top - this.view.y) / this.view.zoom };
  }

  // ------------------------------------------------------------------------------------- the wheel

  onWheel(event) {
    event.preventDefault();
    const box = this.element.getBoundingClientRect();
    const cx = event.clientX - box.left;
    const cy = event.clientY - box.top;
    if (event.ctrlKey || event.metaKey) {
      // a pinch on a trackpad arrives as a wheel turn with Ctrl held
      this.zoomBy(Math.exp(-event.deltaY * 0.01), cx, cy);
    } else if (event.shiftKey) {
      this.panBy(-(event.deltaX || event.deltaY), 0);
    } else if (isMouseWheel(event)) {
      this.zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
    } else {
      this.panBy(-event.deltaX, -event.deltaY); // two fingers sliding on a trackpad
    }
  }

  // ------------------------------------------------------------------------------------ pointers

  onPointerDown(event) {
    if (event.button > 1) return;
    this.element.focus({ preventScroll: true });
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.element.setPointerCapture(event.pointerId);

    if (event.pointerType === 'touch' && this.pointers.size === 2) {
      this.finishDrag(false);
      this.startPinch();
      return;
    }
    if (this.pinch) return;

    const panning = event.button === 1 || this.spaceDown;
    const handle = event.target.closest && event.target.closest('[data-handle]');
    const box = event.target.closest && event.target.closest('.editor-box');
    if (handle && !panning && this.selected) this.startScale(event);
    else if (box && !panning) {
      this.select(box.dataset.key);
      this.startMove(event);
    } else this.startPan(event, !panning);
    event.preventDefault();
  }

  onPointerMove(event) {
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pinch) return this.movePinch();
    const drag = this.drag;
    if (!drag) return;
    if (drag.kind === 'pan') this.movePan(event);
    else if (drag.kind === 'move') this.moveMove(event);
    else if (drag.kind === 'scale') this.moveScale(event);
  }

  onPointerUp(event) {
    this.pointers.delete(event.pointerId);
    if (this.element.hasPointerCapture && this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    this.finishDrag(true);
  }

  finishDrag(commit) {
    const drag = this.drag;
    this.drag = null;
    this.guideLayer.textContent = '';
    this.element.classList.remove('dragging', 'panning-now');
    if (!drag) return;
    if (drag.kind === 'pan') {
      if (!drag.moved && drag.deselect) this.select(null); // a plain click on nothing
    } else if (commit) this.model.commit('canvas');
  }

  // ---- panning

  startPan(event, deselect) {
    this.drag = { kind: 'pan', x: event.clientX, y: event.clientY, moved: false, deselect };
    this.element.classList.add('panning-now');
  }

  movePan(event) {
    const drag = this.drag;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    this.panBy(dx, dy);
  }

  // ---- moving a piece

  startMove(event) {
    const key = this.selected;
    const entry = this.model.layoutOf(key);
    this.drag = {
      kind: 'move', key, startX: event.clientX, startY: event.clientY, entry,
      rect: { ...this.rects[key] },
      others: Object.entries(this.rects).filter(([other, rect]) => other !== key && rect).map(([, rect]) => rect),
      moved: false
    };
    this.element.classList.add('dragging');
  }

  moveMove(event) {
    const drag = this.drag;
    const zoom = this.view.zoom;
    let dx = (event.clientX - drag.startX) / zoom;
    let dy = (event.clientY - drag.startY) / zoom;
    if (Math.abs(dx) + Math.abs(dy) > 2 / zoom) drag.moved = true;
    if (!drag.moved) return;
    if (event.shiftKey) { // along one direction only
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
    }
    let guides = [];
    if (this.snap && !event.altKey) ({ dx, dy, guides } = this.snapped(drag, dx, dy));
    const limit = THEME.LAYOUT_LIMITS.offset;
    const x = clamp(Math.round(drag.entry.x + dx), -limit, limit);
    const y = clamp(Math.round(drag.entry.y + dy), -limit, limit);
    this.model.setLayout(drag.key, { x, y, scale: drag.entry.scale }, { commit: false });
    this.showGuides(guides);
    // the handles follow at once; the overlay confirms where the piece really is in a moment
    this.placeSelection({ ...drag.rect, x: drag.rect.x + (x - drag.entry.x), y: drag.rect.y + (y - drag.entry.y) });
  }

  // Edges and centres that line up with the stage or with another piece pull the moving one onto them
  snapped(drag, dx, dy) {
    const near = SNAP_PX / this.view.zoom;
    const moving = { x: drag.rect.x + dx, y: drag.rect.y + dy, w: drag.rect.w, h: drag.rect.h };
    // the edges and the middle of the stage first: with this many pieces on it, some other edge is nearly always close
    const stageX = [0, STAGE_W / 2, STAGE_W];
    const stageY = [0, STAGE_H / 2, STAGE_H];
    const otherX = [];
    const otherY = [];
    for (const other of drag.others) {
      otherX.push(other.x, other.x + other.w / 2, other.x + other.w);
      otherY.push(other.y, other.y + other.h / 2, other.y + other.h);
    }
    const pull = (points, lines) => {
      let best = null;
      for (const point of points) {
        for (const line of lines) {
          const gap = line - point;
          if (Math.abs(gap) <= near && (!best || Math.abs(gap) < Math.abs(best.gap))) best = { gap, line };
        }
      }
      return best;
    };
    const pointsX = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
    const pointsY = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
    const pullX = pull(pointsX, stageX) || pull(pointsX, otherX);
    const pullY = pull(pointsY, stageY) || pull(pointsY, otherY);
    return {
      dx: dx + (pullX ? pullX.gap : 0),
      dy: dy + (pullY ? pullY.gap : 0),
      guides: [pullX && { axis: 'x', at: pullX.line }, pullY && { axis: 'y', at: pullY.line }].filter(Boolean)
    };
  }

  showGuides(guides) {
    this.guideLayer.textContent = '';
    for (const guide of guides) {
      this.guideLayer.appendChild(h('div', {
        class: `editor-guide ${guide.axis}`,
        style: guide.axis === 'x' ? { left: `${guide.at}px` } : { top: `${guide.at}px` }
      }));
    }
  }

  // ---- resizing a piece (from its centre, so it stays where it is)

  startScale(event) {
    const key = this.selected;
    const rect = this.rects[key];
    if (!rect) return;
    const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const pointer = this.toStage(event.clientX, event.clientY);
    this.drag = {
      kind: 'scale', key, center, entry: this.model.layoutOf(key), rect: { ...rect },
      distance: Math.max(1, Math.hypot(pointer.x - center.x, pointer.y - center.y))
    };
    this.element.classList.add('dragging');
  }

  moveScale(event) {
    const drag = this.drag;
    const pointer = this.toStage(event.clientX, event.clientY);
    const distance = Math.hypot(pointer.x - drag.center.x, pointer.y - drag.center.y);
    const { minScale, maxScale } = THEME.LAYOUT_LIMITS;
    const scale = round2(clamp(drag.entry.scale * (distance / drag.distance), minScale, maxScale));
    this.model.setLayout(drag.key, { x: drag.entry.x, y: drag.entry.y, scale }, { commit: false });
    const grow = scale / drag.entry.scale;
    this.placeSelection({ x: drag.center.x - (drag.rect.w * grow) / 2, y: drag.center.y - (drag.rect.h * grow) / 2, w: drag.rect.w * grow, h: drag.rect.h * grow });
  }

  // ---- pinching on a touch screen: two fingers zoom and pan together

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  movePinch() {
    if (this.pointers.size < 2) return;
    const [a, b] = [...this.pointers.values()];
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const box = this.element.getBoundingClientRect();
    this.panBy(middle.x - this.pinch.middle.x, middle.y - this.pinch.middle.y);
    this.zoomBy(distance / this.pinch.distance, middle.x - box.left, middle.y - box.top);
    this.pinch = { distance, middle };
  }

  // ------------------------------------------------------------------------------------ keyboard

  onKeyDown(event) {
    if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ') {
      this.spaceDown = true;
      this.element.classList.add('panning');
      event.preventDefault();
      return;
    }
    if (event.key === '+' || event.key === '=') return this.zoomBy(1.2), event.preventDefault();
    if (event.key === '-' || event.key === '_') return this.zoomBy(1 / 1.2), event.preventDefault();
    if (event.key === '0') return this.fit(), event.preventDefault();
    if (event.key === '1') return this.actualSize(), event.preventDefault();

    const key = this.selected;
    if (!key) return;
    if (event.key === 'Escape') {
      this.select(null);
      event.stopPropagation(); // the first Escape lets go of the piece; the next closes the editor
      event.preventDefault();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      this.model.setLayout(key, {});
      event.preventDefault();
      return;
    }
    const step = event.shiftKey ? NUDGE_BIG : NUDGE;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (move) {
      const entry = this.model.layoutOf(key);
      const limit = THEME.LAYOUT_LIMITS.offset;
      this.model.setLayout(key, { ...entry, x: clamp(entry.x + move[0], -limit, limit), y: clamp(entry.y + move[1], -limit, limit) }, { commit: false });
      // a run of key presses is one step in the history
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = setTimeout(() => this.model.commit('canvas'), 500);
      event.preventDefault();
    }
  }
}
