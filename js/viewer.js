// Chart viewer: pinch-zoom / pan with sharp re-rendering, double-tap to fit,
// rotation, swipe to next/previous chart, and Apple Pencil annotations.
//
// Coordinates:
//  - "display units": PDF points of the page as currently shown (after rotation).
//  - "page units":    PDF points of the page unrotated by the user (what's saved),
//    so annotations stay put when you rotate.

const SVGNS = 'http://www.w3.org/2000/svg';
const BASE_MAX_PIXELS = 6e6;    // full-page canvas size limit (iPad memory friendly)
const DETAIL_MAX_PIXELS = 9e6;  // sharp "zoomed" canvas limit
const MAX_ZOOM = 10;            // times the fit zoom

export const PEN_WIDTHS = { thin: 0.9, thick: 2.2 };
const HIGHLIGHT_WIDTH = 10;

export class ChartViewer {
  constructor(stage, { onSwipe, onInkChange, getTool }) {
    this.stage = stage;
    this.onSwipe = onSwipe;
    this.onInkChange = onInkChange;
    this.getTool = getTool;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);

    stage.innerHTML = '';
    this.inner = el('div', 'pv-page');
    this.paper = el('div', 'pv-paper');      // canvases (night-mode filter goes here)
    this.base = el('canvas', 'pv-base');
    this.paper.append(this.base);
    this.detail = null;
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'pv-ink');
    this.g = document.createElementNS(SVGNS, 'g');
    this.svg.append(this.g);
    this.inner.append(this.paper, this.svg);
    stage.append(this.inner);

    this.s = 1; this.tx = 0; this.ty = 0; this.fitS = 1;
    this.rot = 0;
    this.strokes = [];
    this.undo = [];
    this.gen = 0;
    this.pointers = new Map();
    this.pen = null;
    this.penUpAt = 0;
    this.lastTap = null;

    this._bind();
  }

  // ------------------------------------------------------------- page

  /** Blank the view at once (so an old chart never shows under a new title). */
  clear() {
    this.gen++;
    try { this.baseTask?.cancel(); this.detailTask?.cancel(); } catch { /* */ }
    this.base.width = this.base.height = 0;
    this._dropDetail();
    this.g.innerHTML = '';
    this.inner.style.visibility = 'hidden';
  }

  async show(page, { rotation = 0, strokes = [] } = {}) {
    this.clear();
    this.page = page;
    this.rot = rotation;
    this.strokes = strokes.map((s) => ({ ...s }));
    this.undo = [];
    this._dims();
    this.fit(false);
    this._drawInk();
    await this._renderBase();
  }

  setRotation(rot) {
    this.rot = ((rot % 360) + 360) % 360;
    this.gen++;
    this._dims();
    this.fit(false);
    this._drawInk();
    this._renderBase();
  }

  _dims() {
    const p = this.page;
    const v0 = p.getViewport({ scale: 1, rotation: p.rotate });
    this.W0 = v0.width; this.H0 = v0.height;
    const r = (p.rotate + this.rot) % 360;
    this.vpRotation = r;
    const v = p.getViewport({ scale: 1, rotation: r });
    this.W = v.width; this.H = v.height;
    this.inner.style.width = this.W + 'px';
    this.inner.style.height = this.H + 'px';
    this.svg.setAttribute('width', this.W);
    this.svg.setAttribute('height', this.H);
    this.svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    const m = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, this.H0, 0], 180: [-1, 0, 0, -1, this.W0, this.H0], 270: [0, -1, 1, 0, 0, this.W0] }[this.rot];
    this.g.setAttribute('transform', `matrix(${m.join(' ')})`);
  }

  /** display units -> page units */
  _toPage(x, y) {
    switch (this.rot) {
      case 90: return [y, this.H0 - x];
      case 180: return [this.W0 - x, this.H0 - y];
      case 270: return [this.W0 - y, x];
      default: return [x, y];
    }
  }

  fit(animate = true) {
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    if (!sw || !sh || !this.W) return;
    this.fitS = Math.min(sw / this.W, sh / this.H);
    this._setView(this.fitS, (sw - this.W * this.fitS) / 2, (sh - this.H * this.fitS) / 2, animate);
  }

  isAtFit() { return this.s <= this.fitS * 1.03; }

  resize() {
    if (!this.page) return;
    const wasFit = this.isAtFit();
    const oldFit = this.fitS;
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    this.fitS = Math.min(sw / this.W, sh / this.H);
    if (wasFit || Math.abs(oldFit - this.fitS) / oldFit > 0.3) { this.fit(false); this._renderBase(); }
    else this._setView(this.s, this.tx, this.ty);
  }

  zoomAt(factor, cx, cy) {
    const s = clamp(this.s * factor, this.fitS, this.fitS * MAX_ZOOM);
    const px = (cx - this.tx) / this.s, py = (cy - this.ty) / this.s;
    this._setView(s, cx - px * s, cy - py * s, true);
  }

  _clamp(s, tx, ty) {
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    const w = this.W * s, h = this.H * s;
    tx = w <= sw ? (sw - w) / 2 : clamp(tx, sw - w, 0);
    ty = h <= sh ? (sh - h) / 2 : clamp(ty, sh - h, 0);
    return [tx, ty];
  }

  _setView(s, tx, ty, animate = false, clampIt = true) {
    if (clampIt) [tx, ty] = this._clamp(s, tx, ty);
    this.s = s; this.tx = tx; this.ty = ty;
    this.inner.style.transition = animate ? 'transform .18s ease-out' : 'none';
    this.inner.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    this._scheduleDetail();
  }

  // ------------------------------------------------------------- rendering

  async _renderBase() {
    const gen = this.gen;
    const page = this.page;
    if (this.baseTask) { try { this.baseTask.cancel(); } catch { /* */ } }
    const want = this.fitS * this.dpr * 1.25;
    const b = Math.min(want, Math.sqrt(BASE_MAX_PIXELS / (this.W * this.H)));
    this.baseScale = b;
    const c = document.createElement('canvas');
    c.className = 'pv-base';
    c.width = Math.round(this.W * b); c.height = Math.round(this.H * b);
    const vp = page.getViewport({ scale: b, rotation: this.vpRotation });
    this.baseTask = page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp });
    try { await this.baseTask.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); return; }
    if (gen !== this.gen) { c.width = c.height = 0; return; }
    this.inner.style.visibility = '';
    this.base.replaceWith(c);
    this.base.width = this.base.height = 0;
    this.base = c;
    this._dropDetail();
    this._scheduleDetail();
  }

  _dropDetail() {
    if (this.detail) { this.detail.width = this.detail.height = 0; this.detail.remove(); this.detail = null; }
  }

  _scheduleDetail() {
    clearTimeout(this.detailTimer);
    if (this.detailTask) { try { this.detailTask.cancel(); } catch { /* */ } this.detailTask = null; }
    this.detailTimer = setTimeout(() => this._renderDetail(), 160);
  }

  async _renderDetail() {
    if (!this.page || this.pointers.size) return;
    const gen = this.gen;
    let k = this.s * this.dpr;
    if (!this.baseScale || k <= this.baseScale * 1.1) { this._dropDetail(); return; }
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    const x0 = Math.max(0, -this.tx / this.s), y0 = Math.max(0, -this.ty / this.s);
    const x1 = Math.min(this.W, (sw - this.tx) / this.s), y1 = Math.min(this.H, (sh - this.ty) / this.s);
    if (x1 <= x0 || y1 <= y0) return;
    if ((x1 - x0) * (y1 - y0) * k * k > DETAIL_MAX_PIXELS) k = Math.sqrt(DETAIL_MAX_PIXELS / ((x1 - x0) * (y1 - y0)));
    const c = document.createElement('canvas');
    c.className = 'pv-detail';
    c.width = Math.ceil((x1 - x0) * k); c.height = Math.ceil((y1 - y0) * k);
    const vp = this.page.getViewport({ scale: k, rotation: this.vpRotation });
    const task = this.page.render({
      canvasContext: c.getContext('2d', { alpha: false }), viewport: vp,
      transform: [1, 0, 0, 1, -x0 * k, -y0 * k],
    });
    this.detailTask = task;
    try { await task.promise; } catch (e) { c.width = c.height = 0; return; }
    if (gen !== this.gen || this.detailTask !== task) { c.width = c.height = 0; return; }
    this.detailTask = null;
    Object.assign(c.style, { left: x0 + 'px', top: y0 + 'px', width: c.width / k + 'px', height: c.height / k + 'px' });
    this._dropDetail();
    this.detail = c;
    this.paper.append(c);
  }

  // ------------------------------------------------------------- ink

  _drawInk() {
    this.g.innerHTML = '';
    for (const s of this.strokes) this.g.append(strokeEl(s));
  }

  inkUndo() {
    const op = this.undo.pop();
    if (!op) return;
    if (op.type === 'add') this.strokes = this.strokes.filter((s) => s !== op.stroke);
    else if (op.type === 'erase' || op.type === 'clear') this.strokes = op.before;
    this._drawInk();
    this.onInkChange?.(this.strokes);
  }

  inkClear() {
    if (!this.strokes.length) return;
    this.undo.push({ type: 'clear', before: this.strokes.slice() });
    this.strokes = [];
    this._drawInk();
    this.onInkChange?.(this.strokes);
  }

  canUndo() { return this.undo.length > 0; }

  _penStart(e) {
    const tool = this.getTool();
    const p = this._eventPagePoint(e);
    if (tool.kind === 'eraser') {
      this.pen = { id: e.pointerId, erase: true, before: this.strokes.slice(), removed: false };
      this._eraseAt(p);
      return;
    }
    const stroke = tool.kind === 'highlighter'
      ? { t: 'h', c: 'yellow', w: HIGHLIGHT_WIDTH, p: [[r1(p[0]), r1(p[1]), 0.5]] }
      : { t: 'p', c: tool.color, w: PEN_WIDTHS[tool.width] || PEN_WIDTHS.thin, p: [[r1(p[0]), r1(p[1]), pressure(e)]] };
    const node = strokeEl(stroke);
    this.g.append(node);
    this.pen = { id: e.pointerId, stroke, node };
  }

  _penMove(e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    if (this.pen.erase) { for (const ev of list) this._eraseAt(this._eventPagePoint(ev)); return; }
    const pts = this.pen.stroke.p;
    const minD = 0.6 / this.s;
    for (const ev of list) {
      const p = this._eventPagePoint(ev);
      const last = pts[pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < minD) continue;
      pts.push([r1(p[0]), r1(p[1]), pressure(ev)]);
    }
    updateStrokeEl(this.pen.node, this.pen.stroke);
  }

  _penEnd() {
    const pen = this.pen;
    this.pen = null;
    this.penUpAt = Date.now();
    if (!pen) return;
    if (pen.erase) {
      if (pen.removed) { this.undo.push({ type: 'erase', before: pen.before }); this.onInkChange?.(this.strokes); }
      return;
    }
    this.strokes.push(pen.stroke);
    this.undo.push({ type: 'add', stroke: pen.stroke });
    this.onInkChange?.(this.strokes);
  }

  _eraseAt([x, y]) {
    const r = 12 / this.s;
    const keep = [];
    let removed = false;
    for (const s of this.strokes) {
      if (hitStroke(s, x, y, r + s.w / 2)) removed = true; else keep.push(s);
    }
    if (removed) { this.strokes = keep; this.pen.removed = true; this._drawInk(); }
  }

  _eventPagePoint(e) {
    const rect = this.stage.getBoundingClientRect();
    const dx = (e.clientX - rect.left - this.tx) / this.s;
    const dy = (e.clientY - rect.top - this.ty) / this.s;
    return this._toPage(dx, dy);
  }

  // ------------------------------------------------------------- gestures

  _bind() {
    const st = this.stage;
    const opts = { passive: false };
    st.addEventListener('pointerdown', (e) => this._down(e), opts);
    st.addEventListener('pointermove', (e) => this._move(e), opts);
    st.addEventListener('pointerup', (e) => this._up(e), opts);
    st.addEventListener('pointercancel', (e) => this._up(e, true), opts);
    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = st.getBoundingClientRect();
      this.zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - rect.left, e.clientY - rect.top);
    }, opts);
    // Stop Safari's own page zoom gestures
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) st.addEventListener(t, (e) => e.preventDefault(), opts);
    st.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, opts);
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(st);
  }

  destroy() {
    this._ro?.disconnect();
    clearTimeout(this.detailTimer);
    try { this.baseTask?.cancel(); this.detailTask?.cancel(); } catch { /* */ }
    this.base.width = this.base.height = 0;
    this._dropDetail();
    this.gen++;
  }

  _local(e) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    e.preventDefault();
    const tool = this.getTool();
    if (e.pointerType === 'pen' && tool.kind !== 'off') {
      if (this.pen) return;
      // Pencil touched down: forget any palm contacts.
      this.pointers.clear();
      try { this.stage.setPointerCapture(e.pointerId); } catch { /* */ }
      this._penStart(e);
      return;
    }
    // Palm rejection: ignore fingers while the Pencil is down or just lifted.
    if (e.pointerType === 'touch' && (this.pen || Date.now() - this.penUpAt < 350)) return;
    if (e.pointerType === 'touch' && (e.width > 60 || e.height > 60)) return; // a big contact = palm
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* */ }
    const p = this._local(e);
    this.pointers.set(e.pointerId, p);
    clearTimeout(this.detailTimer);
    this._gestureStart(performance.now());
  }

  _gestureStart(t) {
    const pts = [...this.pointers.values()];
    this.g0 = { s: this.s, tx: this.tx, ty: this.ty, t, n: pts.length, moved: false };
    if (pts.length === 1) {
      this.g0.x = pts[0].x; this.g0.y = pts[0].y;
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      this.g0.d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.g0.mx = (a.x + b.x) / 2; this.g0.my = (a.y + b.y) / 2;
      this.g0.pinch = true;
    }
  }

  _move(e) {
    if (this.pen && e.pointerId === this.pen.id) { e.preventDefault(); this._penMove(e); return; }
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    this.pointers.set(e.pointerId, this._local(e));
    const pts = [...this.pointers.values()];
    const g = this.g0;
    if (pts.length === 1 && g.n === 1) {
      const dx = pts[0].x - g.x, dy = pts[0].y - g.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) g.moved = true;
      g.dx = dx; g.dy = dy;
      if (this.isAtFit() && !g.pinch) {
        // At "fit" a horizontal drag is a swipe: give a little visual feedback.
        this.inner.style.transition = 'none';
        this.inner.style.transform = `translate(${this.tx + dx * 0.35}px, ${this.ty}px) scale(${this.s})`;
      } else {
        this._setView(this.s, g.tx + dx, g.ty + dy);
      }
    } else if (pts.length >= 2 && g.pinch) {
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = clamp(g.s * d / g.d, this.fitS * 0.7, this.fitS * MAX_ZOOM);
      const px = (g.mx - g.tx) / g.s, py = (g.my - g.ty) / g.s;
      g.moved = true;
      this._setView(s, mx - px * s, my - py * s, false, s >= this.fitS);
      clearTimeout(this.detailTimer);
    }
  }

  _up(e, cancelled = false) {
    if (this.pen && e.pointerId === this.pen.id) { this._penEnd(); return; }
    if (!this.pointers.has(e.pointerId)) return;
    const g = this.g0;
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const now = performance.now();

    if (this.pointers.size) { // one finger left after a pinch: continue as a pan from here
      this._gestureStart(now);
      this.g0.pinch = true;
      return;
    }
    if (this.s < this.fitS) { this.fit(true); return; }

    if (!cancelled && g.n === 1 && !g.pinch) {
      const dt = now - g.t;
      const dx = g.dx || 0, dy = g.dy || 0;
      if (this.isAtFit() && Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && dt < 700) {
        this._setView(this.s, this.tx, this.ty, true);
        this.onSwipe?.(dx < 0 ? 1 : -1);
        return;
      }
      if (this.isAtFit()) this._setView(this.s, this.tx, this.ty, true); // snap back
      if (!g.moved && dt < 300) { // tap
        if (this.lastTap && now - this.lastTap.t < 320 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 40) {
          this.lastTap = null;
          if (this.isAtFit()) this.zoomAt(2.5, p.x, p.y); else this.fit(true);
          return;
        }
        this.lastTap = { t: now, x: p.x, y: p.y };
      }
    }
    this._scheduleDetail();
  }
}

// ------------------------------------------------------------- ink helpers

function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function r1(v) { return Math.round(v * 10) / 10; }
function pressure(e) {
  // Mouse / some pens report 0 or 0.5 always; keep a sensible width.
  const p = e.pressure;
  return p > 0 && p <= 1 ? Math.round(p * 100) / 100 : 0.5;
}

function strokeEl(s) {
  const node = document.createElementNS(SVGNS, 'path');
  updateStrokeEl(node, s);
  return node;
}

function updateStrokeEl(node, s) {
  if (s.t === 'h') {
    node.setAttribute('class', `ink-hl ink-${s.c}`);
    node.setAttribute('stroke-width', s.w);
    node.setAttribute('d', polyline(s.p));
  } else {
    node.setAttribute('class', `ink-pen ink-${s.c}`);
    node.setAttribute('d', penOutline(s.p, s.w));
  }
}

function polyline(p) {
  if (p.length === 1) return `M${p[0][0]} ${p[0][1]}l0.01 0`;
  return 'M' + p.map((q) => `${q[0]} ${q[1]}`).join('L');
}

/** Filled outline of a pressure-sensitive stroke (stays sharp at any zoom). */
function penOutline(p, w) {
  const rad = (i) => {
    // smooth the pressure a little
    const a = p[Math.max(0, i - 1)][2], b = p[i][2], c = p[Math.min(p.length - 1, i + 1)][2];
    const pr = (a + 2 * b + c) / 4;
    return (w * (0.35 + 0.9 * pr)) / 2;
  };
  if (p.length === 1) {
    const r = rad(0), [x, y] = p[0];
    return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  }
  const L = [], R = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = rad(i);
    L.push([p[i][0] - dy * r, p[i][1] + dx * r]);
    R.push([p[i][0] + dy * r, p[i][1] - dx * r]);
  }
  const f = (q) => `${q[0].toFixed(2)} ${q[1].toFixed(2)}`;
  const r0 = rad(0), rn = rad(p.length - 1);
  let d = `M${f(L[0])}`;
  for (let i = 1; i < L.length; i++) d += `L${f(L[i])}`;
  d += `A${rn.toFixed(2)} ${rn.toFixed(2)} 0 0 1 ${f(R[R.length - 1])}`;
  for (let i = R.length - 2; i >= 0; i--) d += `L${f(R[i])}`;
  d += `A${r0.toFixed(2)} ${r0.toFixed(2)} 0 0 1 ${f(L[0])}Z`;
  return d;
}

function hitStroke(s, x, y, r) {
  const p = s.p;
  if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) <= r;
  for (let i = 1; i < p.length; i++) {
    if (segDist(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r) return true;
  }
  return false;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
