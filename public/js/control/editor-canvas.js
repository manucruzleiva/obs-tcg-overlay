/**
 * The design editor's canvas: the real overlay drawn at full size inside a frame, with handles over each
 * piece of it. Drag a piece to move it, drag a corner to resize it, scroll or pinch to zoom, hold Space
 * (or the middle button) and drag to pan. What it changes goes into the editor model; the overlay inside
 * the frame is told, and tells back where every piece ended up. The reserved spaces of the design are boxes
 * of their own (key "space:<place in the list>") that move and resize by their corners, and a grid can be
 * shown over the stage, for moving things by.
 */
import { h } from './dom.js';

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

// A reserved space is selected as "space:<its place in the list>"
const spaceIndexOf = (key) => (typeof key === 'string' && key.startsWith('space:') ? Number(key.slice(6)) : null);

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
    this.grid = { show: false, size: 40, snap: false }; // the grid mask: lines over the stage, and whether pieces jump onto them
    this.stageKey = ''; // the screen the stage was last sized for
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
    this.gridLayer = h('div', { class: 'editor-grid', 'aria-hidden': 'true', hidden: true });
    this.spaceLayer = h('div', { class: 'editor-spaces' });
    this.guideLayer = h('div', { class: 'editor-guides', 'aria-hidden': 'true' });
    this.selectionLabel = h('span', { class: 'editor-selection-label' });
    this.selection = h('div', { class: 'editor-selection', hidden: true },
      this.selectionLabel,
      ['nw', 'ne', 'sw', 'se'].map((corner) => h('span', { class: `editor-handle ${corner}`, dataset: { handle: corner }, title: 'Drag to resize' })));
    this.world = h('div', { class: 'editor-world' }, this.frame, this.gridLayer, this.spaceLayer, this.boxLayer, this.guideLayer, this.selection);
    this.applySize();
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

  // The stage is as big as the screen of the design: a wide one, or a tall one for a phone
  applySize() {
    const { width, height } = this.model.stageSize();
    for (const node of [this.world, this.frame, this.gridLayer, this.spaceLayer, this.boxLayer, this.guideLayer]) {
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
    }
  }

  // What follows from the draft: the size of the stage, the boxes of the spaces and the grid
  syncStage() {
    const screen = this.model.orientationOf();
    if (screen !== this.stageKey) {
      const first = this.stageKey === '';
      this.stageKey = screen;
      this.applySize();
      if (!first) {
        if (this.fitted) this.fit(); else this.applyView();
      }
    }
    this.syncSpaces();
    this.drawGrid();
  }

  // One box for each reserved space of the draft, where it is (the overlay draws the frames; these are what can be picked and dragged)
  syncSpaces() {
    const spaces = this.model.draft.spaces;
    while (this.spaceLayer.children.length > spaces.length) this.spaceLayer.lastChild.remove();
    while (this.spaceLayer.children.length < spaces.length) this.spaceLayer.appendChild(h('div', { class: 'editor-space' }, h('span', { class: 'editor-space-label' })));
    spaces.forEach((space, index) => {
      const box = this.spaceLayer.children[index];
      box.dataset.space = String(index);
      box.className = `editor-space shape-${space.shape}${this.selected === `space:${index}` ? ' on' : ''}`;
      this.place(box, space);
      box.firstChild.textContent = space.name || `Space ${space.id}`;
      box.title = `${space.name || `Space ${space.id}`}: a place kept clear. Drag it to move it, drag a corner to resize it.`;
    });
    const index = spaceIndexOf(this.selected);
    if (index !== null && !spaces[index]) this.select(null);
    else this.placeSelection();
  }

  // The grid mask: `show`, `size` (pixels of the stage) and `snap` (pieces jump onto its lines)
  setGrid(change) {
    this.grid = { ...this.grid, ...change };
    this.drawGrid();
  }

  drawGrid() {
    this.gridLayer.hidden = !this.grid.show;
    this.gridLayer.style.setProperty('--grid', `${this.grid.size}px`);
  }

  // The lines of the grid across a length of the stage
  gridLines(length) {
    const lines = [];
    for (let at = 0; at <= length; at += this.grid.size) lines.push(at);
    return lines;
  }

  // Send the draft design and the made-up match to the overlay (it answers when it has drawn them)
  draw() {
    this.syncStage();
    if (!this.ready) return;
    const target = this.frame.contentWindow;
    const origin = window.location.origin;
    target.postMessage({ kind: 'design', theme: this.model.theme(this.assetUrl) }, origin);
    // (no match until the page has the game: it is sent when the game arrives)
    const state = this.sample();
    if (state) {
      target.postMessage({ kind: 'state', state }, origin);
      this.hasState = true;
    }
    target.postMessage({ kind: 'banner', show: this.banner }, origin);
  }

  // Only the design changed (while dragging): no need to send the match again
  redesign() {
    this.syncStage();
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
    [...this.spaceLayer.children].forEach((box, index) => box.classList.toggle('on', key === `space:${index}`));
    this.placeSelection();
    this.onSelect(key);
  }

  // The piece of the overlay that is selected, or null (when nothing is, or it is a reserved space)
  get selectedBlock() {
    return spaceIndexOf(this.selected) === null ? this.selected : null;
  }

  // The place in the list of the reserved space that is selected, or null
  get selectedSpace() {
    return spaceIndexOf(this.selected);
  }

  // Where a piece or a space is on the stage: { x, y, w, h }, or null when it is not showing
  rectOf(key) {
    const index = spaceIndexOf(key);
    if (index === null) return this.rects[key] || null;
    const space = this.model.draft.spaces[index];
    return space ? { x: space.x, y: space.y, w: space.w, h: space.h } : null;
  }

  placeSelection(rect = this.selected && this.rectOf(this.selected)) {
    if (!this.selected || !rect) {
      this.selection.hidden = true;
      return;
    }
    this.selection.hidden = false;
    this.place(this.selection, rect);
    // keep the handles the same size on screen, whatever the zoom
    this.selection.style.setProperty('--inverse', String(1 / this.view.zoom));
    const index = spaceIndexOf(this.selected);
    const block = THEME.BLOCKS.find((entry) => entry.key === this.selected);
    const space = index === null ? null : this.model.draft.spaces[index];
    this.selectionLabel.textContent = space ? (space.name || `Space ${space.id}`) : block ? block.label : this.selected;
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
    const { width, height } = this.model.stageSize();
    const zoom = clamp(Math.min((box.width - 40) / width, (box.height - 40) / height), MIN_ZOOM, MAX_ZOOM);
    this.view = { zoom, x: (box.width - width * zoom) / 2, y: (box.height - height * zoom) / 2 };
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
    const spaceBox = event.target.closest && event.target.closest('.editor-space');
    if (handle && !panning && this.selected) this.startScale(event);
    else if (box && !panning) {
      this.select(box.dataset.key);
      this.startMove(event);
    } else if (spaceBox && !panning) {
      this.select(`space:${spaceBox.dataset.space}`);
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
    else if (drag.kind === 'resize') this.moveResize(event);
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
    const space = spaceIndexOf(key);
    const rect = this.rectOf(key);
    if (!rect) return;
    // a piece moves by its layout; a space by where it is
    const entry = space === null ? this.model.layoutOf(key) : { x: rect.x, y: rect.y };
    const others = Object.entries(this.rects).filter(([other, other_rect]) => other !== key && other_rect).map(([, other_rect]) => other_rect);
    this.model.draft.spaces.forEach((one, index) => { if (index !== space) others.push({ x: one.x, y: one.y, w: one.w, h: one.h }); });
    this.drag = { kind: 'move', key, space, startX: event.clientX, startY: event.clientY, entry, rect: { ...rect }, others, moved: false };
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
    if ((this.snap || this.grid.snap) && !event.altKey) ({ dx, dy, guides } = this.snapped(drag, dx, dy));
    if (drag.space !== null) {
      // a space is where its corner is: the model keeps it in range and the box and the handles follow it
      this.model.setSpace(drag.space, { x: Math.round(drag.entry.x + dx), y: Math.round(drag.entry.y + dy) }, { commit: false });
      this.showGuides(guides);
      return;
    }
    const limit = THEME.LAYOUT_LIMITS.offset;
    const x = clamp(Math.round(drag.entry.x + dx), -limit, limit);
    const y = clamp(Math.round(drag.entry.y + dy), -limit, limit);
    this.model.setLayout(drag.key, { x, y, scale: drag.entry.scale }, { commit: false });
    this.showGuides(guides);
    // the handles follow at once; the overlay confirms where the piece really is in a moment
    this.placeSelection({ ...drag.rect, x: drag.rect.x + (x - drag.entry.x), y: drag.rect.y + (y - drag.entry.y) });
  }

  // Edges and centres that line up with the stage or with another piece pull the moving one onto them, and so do the lines of the grid
  // when it is switched on to snap to
  snapped(drag, dx, dy) {
    const near = SNAP_PX / this.view.zoom;
    const moving = { x: drag.rect.x + dx, y: drag.rect.y + dy, w: drag.rect.w, h: drag.rect.h };
    const { width, height } = this.model.stageSize();
    // the edges and the middle of the stage first: with this many pieces on it, some other edge is nearly always close
    const lines = this.snap;
    const stageX = lines ? [0, width / 2, width] : [];
    const stageY = lines ? [0, height / 2, height] : [];
    const gridX = this.grid.snap ? this.gridLines(width) : [];
    const gridY = this.grid.snap ? this.gridLines(height) : [];
    const otherX = [];
    const otherY = [];
    for (const other of lines ? drag.others : []) {
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
    const pullX = pull(pointsX, stageX) || pull(pointsX, gridX) || pull(pointsX, otherX);
    const pullY = pull(pointsY, stageY) || pull(pointsY, gridY) || pull(pointsY, otherY);
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
    const space = spaceIndexOf(key);
    if (space !== null) return this.startResize(event, space);
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

  // ---- resizing a reserved space (by a corner: the opposite one stays; Shift keeps its shape)

  startResize(event, index) {
    const space = this.model.draft.spaces[index];
    const handle = event.target.closest('[data-handle]');
    if (!space || !handle) return;
    this.drag = { kind: 'resize', index, handle: handle.dataset.handle, start: { x: space.x, y: space.y, w: space.w, h: space.h } };
    this.element.classList.add('dragging');
  }

  moveResize(event) {
    const { index, handle, start } = this.drag;
    const { minSize } = THEME.SPACE_LIMITS;
    const pointer = this.toStage(event.clientX, event.clientY);
    const lines = (length) => (this.grid.snap ? this.gridLines(length) : []);
    const { width, height } = this.model.stageSize();
    // the corner under the pointer lands on a line of the grid when it is near one
    const near = SNAP_PX / this.view.zoom;
    const toGrid = (value, along) => {
      const best = lines(along).reduce((found, line) => (Math.abs(line - value) <= near && (found === null || Math.abs(line - value) < Math.abs(found - value)) ? line : found), null);
      return best === null ? value : best;
    };
    const px = Math.round(toGrid(pointer.x, width));
    const py = Math.round(toGrid(pointer.y, height));
    let left = start.x;
    let top = start.y;
    let right = start.x + start.w;
    let bottom = start.y + start.h;
    if (handle.includes('w')) left = Math.min(px, right - minSize);
    if (handle.includes('e')) right = Math.max(px, left + minSize);
    if (handle.includes('n')) top = Math.min(py, bottom - minSize);
    if (handle.includes('s')) bottom = Math.max(py, top + minSize);
    if (event.shiftKey) {
      const height = Math.max(minSize, Math.round((right - left) * (start.h / start.w)));
      if (handle.includes('n')) top = bottom - height; else bottom = top + height;
    }
    this.model.setSpace(index, { x: left, y: top, w: right - left, h: bottom - top }, { commit: false });
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
    const space = spaceIndexOf(key);
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (space !== null) this.model.removeSpace(space); // (a space is taken away; a piece goes back where it was)
      else this.model.setLayout(key, {});
      event.preventDefault();
      return;
    }
    const step = event.shiftKey ? NUDGE_BIG : NUDGE;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (move) {
      if (space !== null) {
        const here = this.model.draft.spaces[space];
        if (here) this.model.setSpace(space, { x: here.x + move[0], y: here.y + move[1] }, { commit: false });
      } else {
        const entry = this.model.layoutOf(key);
        const limit = THEME.LAYOUT_LIMITS.offset;
        this.model.setLayout(key, { ...entry, x: clamp(entry.x + move[0], -limit, limit), y: clamp(entry.y + move[1], -limit, limit) }, { commit: false });
      }
      // a run of key presses is one step in the history
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = setTimeout(() => this.model.commit('canvas'), 500);
      event.preventDefault();
    }
  }
}
