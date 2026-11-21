// Moving map: draws the base map and aviation layers on one canvas, redrawn as
// vectors at the current zoom every frame (so it's sharp at any zoom on the iPad -
// no picture is ever stretched). Situational awareness only.
import { K, lonX, latY, xLon, yLat, distBrg } from './mapdata.js';

const D2R = Math.PI / 180;
// Same plane as on the charts: seen from above, nose up, ~34 px long.
const PLANE = new Path2D('M0,-17 C2,-17 2.6,-13 2.6,-9 L2.6,-4 L16,3 L16,6.5 L2.6,3 L2.6,10 L6.5,13.5 L6.5,16 L0,14.2 L-6.5,16 L-6.5,13.5 L-2.6,10 L-2.6,3 L-16,6.5 L-16,3 L-2.6,-4 L-2.6,-9 C-2.6,-13 -2,-17 0,-17 Z');
const LO_SPAN = 700;           // nm across the screen: above this, the simple world outline
const MIN_S = 600, MAX_S = 6e8; // zoom limits (pixels per world unit)

export const PALETTES = {
  day: {
    water: '#b9d7ee', land: '#f4f1e8', lake: '#b9d7ee', coast: '#7aa6c8', border: '#9a7aa0', river: '#8db8dc', road: '#d9b77e',
    text: '#1d2733', halo: 'rgba(255,255,255,.85)', town: '#4a4f57',
    apt: '#1f56b8', aptCharts: '#0a7d3b', heli: '#6b4fa0', rwy: '#3c4450', rwyText: '#ffffff',
    vor: '#1f56b8', ndb: '#8a3b7a', pt: '#c0187a',
    asp: { B: '#1f56b8', C: '#a3249a', D: '#1f56b8', CTR: '#1f56b8', A: '#5a6270', E: '#a3249a', R: '#d22', P: '#d22', Q: '#e0700b', other: '#6c7684' },
    own: '#0b5cd5', ownLine: '#ffffff', ownWeak: '#8a94a3', acc: 'rgba(11,92,213,.15)', target: '#c0187a', sel: '#ff8c00',
  },
  night: {
    water: '#06101c', land: '#2a3039', lake: '#06101c', coast: '#4a6f92', border: '#6d5677', river: '#1d3a55', road: '#4d4232',
    text: '#d6dde6', halo: 'rgba(0,0,0,.85)', town: '#a7b0bb',
    apt: '#5c9cff', aptCharts: '#3fcf78', heli: '#a78bfa', rwy: '#9aa4b2', rwyText: '#0d1117',
    vor: '#5c9cff', ndb: '#d07ac0', pt: '#ff5cad',
    asp: { B: '#5c9cff', C: '#d06ad0', D: '#5c9cff', CTR: '#5c9cff', A: '#9aa4b2', E: '#d06ad0', R: '#ff5252', P: '#ff5252', Q: '#ff9f43', other: '#8b95a3' },
    own: '#3b8cff', ownLine: '#000000', ownWeak: '#6b7480', acc: 'rgba(59,140,255,.18)', target: '#ff5cad', sel: '#ffb02e',
  },
};

const wrapDx = (d) => d - Math.round(d);

export class MovingMap {
  /**
   * opts: data (MapData), chartCodes (Set of ICAO with charts on this iPad),
   * onTap(feature | {kind:'point', lat, lon}), onUserMove() (pan -> follow off), onChange()
   */
  constructor(el, opts) {
    this.el = el;
    this.o = opts;
    this.d = opts.data;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    el.prepend(this.canvas); // under the buttons and panels
    this.ctx = this.canvas.getContext('2d');
    this.cx = lonX(-79.5); this.cy = latY(8.9); this.S = 2e5; // world position at the anchor, zoom
    this.rot = 0;            // map rotation (deg): the true bearing that points up
    this._c = 1; this._s = 0;
    this.trackUp = false;
    this.follow = false;
    this.own = null;         // { lat, lon, hdg, accM, weak } | null
    this.target = null;      // selected feature / point (line from me)
    this.layers = { apt: true, nav: true, pt: true, asp: true, rwy: true, town: true, road: true };
    this.palette = PALETTES.day;
    this.hits = [];
    this.ptrs = new Map();
    this.raf = 0;
    this.d.onTile = () => this.invalidate();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(el);
    this._bind();
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this._ro.disconnect();
    this.d.onTile = null;
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- view

  resize() {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.invalidate();
  }

  /** Screen point the view is centred on (lower in track-up + follow, to see ahead). */
  anchor() {
    // while following, keep the plane in the part of the map a side panel doesn't cover
    const w = this.w - (this.follow ? this.padRight || 0 : 0);
    const h = this.h - (this.follow ? this.padBottom || 0 : 0);
    return this.follow && this.trackUp ? [w / 2, h * 0.68] : [w / 2, h / 2];
  }

  get pxPerNm() { return this.S / (21600 * Math.cos(yLat(this.cy) * D2R)); }
  get spanNm() { return this.w / this.pxPerNm; }

  setCenter(lat, lon) { this.cx = lonX(lon); this.cy = latY(lat); this.invalidate(); }
  centre() { return { lat: yLat(this.cy), lon: xLon(((this.cx % 1) + 1) % 1) }; }

  /** Zoom so `nm` fit across the screen. */
  setSpan(nm) { this.S = this._clampS(this.w * 21600 * Math.cos(yLat(this.cy) * D2R) / nm); this.invalidate(); }
  _clampS(s) { return Math.max(MIN_S, Math.min(MAX_S, s)); }

  zoomBy(f, sx, sy) {
    if (sx == null || this.follow) [sx, sy] = this.anchor();
    const [x, y] = this.toWorld(sx, sy);
    this.S = this._clampS(this.S * f);
    const [x2, y2] = this.toWorld(sx, sy);
    this.cx += x - x2; this.cy += y - y2;
    this.invalidate();
  }

  toScreen(x, y) {
    const [ax, ay] = this.anchor();
    const px = wrapDx(x - this.cx) * this.S, py = (y - this.cy) * this.S;
    const c = this._c, s = this._s;
    return [ax + c * px + s * py, ay - s * px + c * py];
  }

  toWorld(sx, sy) {
    const [ax, ay] = this.anchor();
    const c = Math.cos(this.rot * D2R), s = Math.sin(this.rot * D2R);
    const dx = sx - ax, dy = sy - ay;
    return [this.cx + (c * dx - s * dy) / this.S, this.cy + (s * dx + c * dy) / this.S];
  }

  latLonAt(sx, sy) {
    const [x, y] = this.toWorld(sx, sy);
    return { lat: yLat(y), lon: xLon(((x % 1) + 1) % 1) };
  }

  invalidate() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }

  // ---------------------------------------------------------------- drawing

  draw() {
    const ctx = this.ctx, P = this.palette, dpr = this.dpr;
    if (this.follow && this.own) { this.cx = lonX(this.own.lon); this.cy = latY(this.own.lat); }
    this._c = Math.cos(this.rot * D2R); this._s = Math.sin(this.rot * D2R);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = P.water;
    ctx.fillRect(0, 0, this.w, this.h);

    // visible world box (corners of the rotated screen), with a margin
    const cs = [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]].map(([a, b]) => this.toWorld(a, b));
    const m = 40 / this.S;
    const x0 = Math.min(...cs.map((p) => p[0])) - m, x1 = Math.max(...cs.map((p) => p[0])) + m;
    const y0 = Math.max(0, Math.min(...cs.map((p) => p[1])) - m), y1 = Math.min(1, Math.max(...cs.map((p) => p[1])) + m);
    this.box = { x0, x1, y0, y1 };
    const span = this.spanNm;
    this.hits = [];
    this.labels = [];

    this._drawBase(span);
    if (this.layers.asp && span < 500) this._drawAirspace();
    this._drawFeatures(span);
    this._drawTarget();
    this._drawOwn();
    this._drawScale();
    this.o.onChange?.();
  }

  /** Canvas transform for shapes stored in local units (K per world unit) from (ox, oy). */
  _local(ox, oy) {
    const [ax, ay] = this.anchor();
    const k = this.S / K, c = this._c, s = this._s, d = this.dpr;
    const px = (ox - this.cx) * this.S, py = (oy - this.cy) * this.S;
    this.ctx.setTransform(d * c * k, -d * s * k, d * s * k, d * c * k, d * (ax + c * px + s * py), d * (ay - s * px + c * py));
  }

  _drawBase(span) {
    const ctx = this.ctx, P = this.palette, d = this.d, b = this.box;
    const lw = (px) => (px * K) / this.S;
    // world copies needed (across the date line)
    const copies = [];
    for (let k = Math.floor(b.x0); k <= Math.floor(b.x1); k++) copies.push(k);

    let tiles = [];
    let pending = false;
    if (span < LO_SPAN) {
      const T = d.meta.tile;
      const lon0 = b.x0 * 360 - 180, lon1 = b.x1 * 360 - 180;
      const lat0 = yLat(b.y1), lat1 = yLat(b.y0);
      const tx0 = Math.floor((lon0 + 180) / T), tx1 = Math.floor((lon1 + 180) / T);
      const ty0 = Math.max(0, Math.floor((lat0 + 90) / T)), ty1 = Math.min(180 / T - 1, Math.floor((lat1 + 90) / T));
      const nx = 360 / T;
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
          const wx = ((tx % nx) + nx) % nx;
          const t = d.tile(wx, ty);
          if (t === null) pending = true;
          if (t) tiles.push([t, Math.floor(tx / nx)]);
        }
      }
    }
    if (span >= LO_SPAN || pending) {
      for (const k of copies) {
        this._local(k, 0);
        if (d.lo.land) { ctx.fillStyle = P.land; ctx.fill(d.lo.land, 'evenodd'); }
        if (d.lo.lake) { ctx.fillStyle = P.lake; ctx.fill(d.lo.lake, 'evenodd'); }
        if (span >= LO_SPAN) {
          ctx.lineJoin = 'round';
          if (d.lo.land) { ctx.strokeStyle = P.coast; ctx.lineWidth = lw(1); ctx.stroke(d.lo.land); }
          if (d.lo.border) { ctx.strokeStyle = P.border; ctx.lineWidth = lw(1); ctx.setLineDash([lw(4), lw(3)]); ctx.stroke(d.lo.border); ctx.setLineDash([]); }
        }
      }
    }
    if (!tiles.length) return;
    const layer = (name, style, width, fill, dash) => {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const [t, k] of tiles) {
        const p = t[name];
        if (!p) continue;
        this._local(t.x0 + k, t.y0);
        if (fill) { ctx.fillStyle = style; ctx.fill(p, 'evenodd'); continue; }
        ctx.strokeStyle = style; ctx.lineWidth = lw(width);
        if (dash) ctx.setLineDash(dash.map(lw));
        ctx.stroke(p);
        if (dash) ctx.setLineDash([]);
      }
    };
    layer('land', P.land, 0, true);
    layer('lake', P.lake, 0, true);
    if (span < 250) layer('river', P.river, span < 60 ? 1.6 : 1);
    if (this.layers.road && span < 160) layer('road', P.road, span < 40 ? 2 : 1.2);
    layer('coast', P.coast, 1.2);
    layer('border', P.border, 1.4, false, [5, 3]);
  }

  _drawAirspace() {
    const ctx = this.ctx, P = this.palette, b = this.box;
    for (const a of this.d.airspace) {
      if (a.y1 < b.y0 || a.y0 > b.y1) continue;
      let k = Math.round((b.x0 + b.x1) / 2 - (a.x0 + a.x1) / 2);
      if (a.x1 + k < b.x0 || a.x0 + k > b.x1) continue;
      const col = P.asp[a.cls] || P.asp.other;
      this._local(a.x0 + k, a.y0);
      ctx.strokeStyle = col;
      ctx.lineWidth = ((a.cls === 'B' || a.cls === 'C' ? 2.2 : 1.6) * K) / this.S;
      ctx.lineJoin = 'round';
      if (a.cls === 'D' || a.cls === 'CTR' || a.cls === 'E') ctx.setLineDash([(7 * K) / this.S, (4 * K) / this.S]);
      ctx.stroke(a.path);
      ctx.setLineDash([]);
      if (/^[RPQ]$/.test(a.cls)) { ctx.fillStyle = col + '14'; ctx.fill(a.path); }
    }
  }

  _visible(grid, list) {
    const b = this.box;
    return list || grid.query(b.x0, b.y0, b.x1, b.y1);
  }

  _onScreen(x, y, pad = 20) { return x > -pad && y > -pad && x < this.w + pad && y < this.h + pad; }

  _drawFeatures(span) {
    const ctx = this.ctx, P = this.palette, d = this.d, L = this.layers;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const charts = this.o.chartCodes || new Set();
    const items = []; // [priority, draw()]

    // towns (labels only)
    if (L.town) {
      const maxRank = span > 1500 ? 2 : span > 600 ? 4 : span > 200 ? 6 : span > 60 ? 8 : 10;
      for (const t of this._visible(d.townGrid)) {
        if (t.rank > maxRank) continue;
        const [x, y] = this.toScreen(t.x, t.y);
        if (!this._onScreen(x, y)) continue;
        items.push([20 + t.rank, () => {
          if (!this._label(t.name, x + 5, y, P.town, '500 13px', 'left')) return;
          ctx.fillStyle = P.town; ctx.fillRect(x - 2, y - 2, 4, 4);
        }]);
      }
    }

    // runways to scale (close in)
    const rwyMode = L.rwy && span < 40;
    if (L.apt) {
      const list = span > 700 ? d.aptMajor : null;
      for (const a of this._visible(d.aptGrid, list)) {
        const has = charts.has(a.icao) || charts.has(a.code);
        const show = has ? span < 3000 : a.rank === 1 ? span < 3000 : a.rank === 2 ? span < 700 : a.rank === 3 ? span < 140 : span < 25;
        if (!show) continue;
        const [x, y] = this.toScreen(a.x, a.y);
        if (!this._onScreen(x, y, 60)) continue;
        // runways to scale once the longest is at least ~30 px long, else the round symbol
        const geo = rwyMode && a.maxLen * 0.3048 / ((40075016 * Math.cos(a.lat * D2R)) / this.S) >= 30 && a.rwys.some((r) => r.geo && !r.closed);
        if (geo) this._drawRunways(a, span);
        const pri = has ? 0 : a.rank;
        items.push([pri, () => {
          const col = has ? P.aptCharts : a.rank >= 5 ? P.heli : P.apt;
          if (!geo) this._aptSymbol(x, y, a, col, has);
          const lab = span < (has ? 3000 : a.rank === 1 ? 1500 : a.rank === 2 ? 350 : 80);
          if (lab) this._label(a.code, x + (geo ? 0 : 9), y + (geo ? -14 : 0), col, has ? '700 14px' : '600 13px', geo ? 'center' : 'left');
          this.hits.push({ f: a, x, y, pri: 0 });
        }]);
      }
    }

    if (L.nav) {
      for (const n of this._visible(d.navGrid)) {
        const isVor = n.vor || /DME/.test(n.type) && !/NDB/.test(n.type);
        if (isVor ? span > 500 : span > 150) continue;
        const [x, y] = this.toScreen(n.x, n.y);
        if (!this._onScreen(x, y)) continue;
        items.push([isVor ? 4 : 6, () => {
          this._navSymbol(x, y, n);
          if (span < (isVor ? 250 : 80)) this._label(n.ident, x + 10, y + 10, n.vor || isVor ? P.vor : P.ndb, '600 12px', 'left');
          this.hits.push({ f: n, x, y, pri: 1 });
        }]);
      }
    }

    if (L.pt && span < 60) {
      for (const p of this._visible(d.ptGrid)) {
        const [x, y] = this.toScreen(p.x, p.y);
        if (!this._onScreen(x, y)) continue;
        items.push([7, () => {
          ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 5.5, y + 4); ctx.lineTo(x - 5.5, y + 4); ctx.closePath();
          ctx.lineWidth = 1.6; ctx.strokeStyle = P.pt;
          if (p.compulsory) { ctx.fillStyle = P.pt; ctx.fill(); } else ctx.stroke();
          if (span < 30) this._label(p.name, x + 8, y + 6, P.pt, '600 12px', 'left');
          this.hits.push({ f: p, x, y, pri: 2 });
        }]);
      }
    }

    items.sort((p, q) => p[0] - q[0]);
    // draw the most important last so it's on top, but place its label first
    for (const [, fn] of items) fn();

    if (this.target?.f) {
      const f = this.target.f;
      const [x, y] = this.toScreen(f.x, f.y);
      ctx.beginPath(); ctx.arc(x, y, 14, 0, 2 * Math.PI);
      ctx.lineWidth = 3; ctx.strokeStyle = P.sel; ctx.stroke();
    }
  }

  _aptSymbol(x, y, a, col, has) {
    const ctx = this.ctx, P = this.palette;
    const r = a.rank === 1 ? 6.5 : a.rank === 2 ? 5.5 : a.rank >= 5 ? 4 : 4.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.lineWidth = 2.2;
    ctx.fillStyle = has ? col : P.land; ctx.strokeStyle = col;
    ctx.fill(); ctx.stroke();
    if (has) { ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 2 * Math.PI); ctx.lineWidth = 1.5; ctx.stroke(); }
    if (a.rank >= 5) { ctx.fillStyle = has ? P.land : col; ctx.font = '700 7px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('H', x, y + 0.5); }
  }

  _navSymbol(x, y, n) {
    const ctx = this.ctx, P = this.palette;
    ctx.lineWidth = 1.8;
    if (/NDB/.test(n.type)) {
      ctx.strokeStyle = P.ndb; ctx.fillStyle = P.ndb;
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill();
      ctx.setLineDash([1.5, 2.2]); ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
      if (/DME/.test(n.type)) ctx.strokeRect(x - 9, y - 9, 18, 18);
      return;
    }
    ctx.strokeStyle = P.vor; ctx.fillStyle = P.vor;
    if (n.vor) {
      ctx.beginPath();
      for (let k = 0; k < 6; k++) { const a = (k * 60 + 30) * D2R; const px = x + 7 * Math.cos(a), py = y + 7 * Math.sin(a); if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
      ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 2 * Math.PI); ctx.fill();
      if (/DME|TAC/.test(n.type)) ctx.strokeRect(x - 9, y - 8, 18, 16);
    } else {
      ctx.strokeRect(x - 6, y - 5, 12, 10);
      ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 2 * Math.PI); ctx.fill();
    }
  }

  _drawRunways(a, span) {
    const ctx = this.ctx, P = this.palette;
    const mPerPx = (40075016 * Math.cos(a.lat * D2R)) / this.S;
    const ends = [];
    for (const r of a.rwys) {
      if (!r.geo || r.closed) continue;
      const [x1, y1] = this.toScreen(r.x1, r.y1), [x2, y2] = this.toScreen(r.x2, r.y2);
      const wpx = Math.max(3, ((r.wid || 100) * 0.3048) / mPerPx);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.lineCap = 'butt'; ctx.lineWidth = wpx; ctx.strokeStyle = P.rwy; ctx.stroke();
      if (span < 8) {
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len > 40) {
          const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
          ends.push([r.le, x1 - ux * 15, y1 - uy * 15], [r.he, x2 + ux * 15, y2 + uy * 15]);
        }
      }
    }
    // runway numbers, upright, just beyond each end (drawn after all runways)
    for (const [t, x, y] of ends) if (t) this._label(t, x, y, P.text, '700 13px', 'center');
  }

  /** Text with a halo; returns false (and draws nothing) if it would overlap another label. */
  _label(text, x, y, color, font, align = 'left') {
    if (!text) return false;
    const ctx = this.ctx;
    ctx.font = `${font} -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const w = ctx.measureText(text).width, h = 15;
    const lx = align === 'center' ? x - w / 2 : x;
    const box = [lx - 2, y - h / 2 - 1, lx + w + 2, y + h / 2 + 1];
    for (const b of this.labels) if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) return false;
    this.labels.push(box);
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.strokeStyle = this.palette.halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
    return true;
  }

  _drawTarget() {
    const t = this.target, o = this.own;
    if (!t || !o) return;
    const ctx = this.ctx, P = this.palette;
    const [x1, y1] = this.toScreen(lonX(o.lon), latY(o.lat));
    const tx = t.f ? t.f.x : lonX(t.lon), ty = t.f ? t.f.y : latY(t.lat);
    const [x2, y2] = this.toScreen(tx, ty);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.lineWidth = 3; ctx.strokeStyle = P.target; ctx.setLineDash([10, 6]); ctx.stroke(); ctx.setLineDash([]);
    if (!t.f) { ctx.beginPath(); ctx.arc(x2, y2, 6, 0, 2 * Math.PI); ctx.lineWidth = 2.5; ctx.stroke(); }
  }

  _drawOwn() {
    const o = this.own;
    if (!o) return;
    const ctx = this.ctx, P = this.palette;
    const [x, y] = this.toScreen(lonX(o.lon), latY(o.lat));
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const mPerPx = (40075016 * Math.cos(o.lat * D2R)) / this.S;
    const r = o.accM / mPerPx;
    if (r > 8) { ctx.beginPath(); ctx.arc(x, y, Math.min(r, 4000), 0, 2 * Math.PI); ctx.fillStyle = P.acc; ctx.fill(); }
    const col = o.weak ? P.ownWeak : P.own;
    ctx.translate(x, y);
    if (o.hdg == null) {
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, 2 * Math.PI);
      ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = P.ownLine; ctx.stroke();
    } else {
      ctx.rotate((o.hdg - this.rot) * D2R);
      ctx.scale(1.35, 1.35);
      ctx.lineWidth = 2.6; ctx.lineJoin = 'round'; ctx.strokeStyle = P.ownLine; ctx.stroke(PLANE);
      ctx.fillStyle = col; ctx.fill(PLANE);
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _drawScale() {
    const ctx = this.ctx, P = this.palette;
    const ppn = this.pxPerNm;
    const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
    let nm = nice[0];
    for (const v of nice) if (v * ppn <= 140) nm = v;
    const len = nm * ppn, x = this.w - len - 16, y = this.h - 24;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineWidth = 5; ctx.strokeStyle = P.halo; ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 6); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = P.text; ctx.stroke();
    ctx.font = '600 13px -apple-system, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3.5; ctx.strokeStyle = P.halo; const t = `${nm} nm`; ctx.strokeText(t, x + 4, y - 4);
    ctx.fillStyle = P.text; ctx.fillText(t, x + 4, y - 4);
  }

  // ---------------------------------------------------------------- touch / mouse

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e, true));
    c.addEventListener('wheel', (e) => { e.preventDefault(); const r = c.getBoundingClientRect(); this.zoomBy(Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    for (const ev of ['gesturestart', 'gesturechange']) c.addEventListener(ev, (e) => e.preventDefault());
  }

  _pt(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  _down(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    const [x, y] = this._pt(e);
    this.ptrs.set(e.pointerId, { x, y, x0: x, y0: y });
    if (this.ptrs.size === 1) this.g = { kind: 'one', t: performance.now(), moved: false };
    else if (this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      this.g = { kind: 'two', t: this.g?.t || performance.now(), d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, S0: this.S, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, moved: false };
      this.g.w = this.toWorld(this.g.mx, this.g.my);
    }
  }

  _move(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p || !this.g) return;
    const [x, y] = this._pt(e);
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (this.g.kind === 'one' && this.ptrs.size === 1) {
      if (!this.g.moved && Math.hypot(x - p.x0, y - p.y0) < 8) return;
      if (!this.g.moved) { this.g.moved = true; if (this.follow) { this.follow = false; this.o.onUserMove?.(); } }
      const c = Math.cos(this.rot * D2R), s = Math.sin(this.rot * D2R);
      this.cx -= (c * dx - s * dy) / this.S; this.cy -= (s * dx + c * dy) / this.S;
      this.cy = Math.max(0.0, Math.min(1, this.cy));
      this.invalidate();
    } else if (this.g.kind === 'two' && this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      const dd = Math.hypot(b.x - a.x, b.y - a.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (Math.abs(dd - this.g.d0) > 10 || Math.hypot(mx - this.g.mx, my - this.g.my) > 10) this.g.moved = true;
      this.S = this._clampS(this.g.S0 * dd / this.g.d0);
      if (!this.follow) {
        // keep the point between the fingers under the fingers
        const [wx, wy] = this.toWorld(mx, my);
        this.cx += this.g.w[0] - wx; this.cy += this.g.w[1] - wy;
      }
      this.invalidate();
    }
  }

  _up(e, cancel) {
    const p = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    if (!p || !this.g || cancel) { if (!this.ptrs.size) this.g = null; return; }
    const quick = performance.now() - this.g.t < 350;
    if (this.g.kind === 'two') {
      if (!this.ptrs.size) {
        if (quick && !this.g.moved) this.zoomBy(0.5); // two-finger tap: zoom out
        this.g = null;
      } else this.g = { kind: 'rest' };
      return;
    }
    if (this.g.kind === 'one' && !this.g.moved && quick) {
      const now = performance.now();
      if (this.lastTap && now - this.lastTap.t < 320 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30) {
        this.zoomBy(2, p.x, p.y);
        this.lastTap = null;
      } else {
        this.lastTap = { t: now, x: p.x, y: p.y };
        this._tap(p.x, p.y);
      }
    }
    if (!this.ptrs.size) this.g = null;
  }

  _tap(x, y) {
    let best = null, bd = 26;
    for (const h of this.hits) {
      const dd = Math.hypot(h.x - x, h.y - y) + h.pri * 3;
      if (dd < bd) { bd = dd; best = h.f; }
    }
    if (best) this.o.onTap?.(best);
    else this.o.onTap?.({ kind: 'point', ...this.latLonAt(x, y) });
  }
}

export { distBrg };
