// Map data for the moving map: reads _map_data.zip (made by the export script)
// straight from the iPad's storage, one small part at a time - never the whole
// file at once. Everything here works offline.
//
// Coordinates: "world units" are Web Mercator scaled to 0..1 (x east, y south).
// Base-map tiles are turned into Path2D shapes once, in tile-local units of
// K per world unit, so drawing them at any zoom is a cheap, sharp vector redraw.

export const K = 1048576; // 2^20 local units per world unit

const D2R = Math.PI / 180;
export const lonX = (lon) => (lon + 180) / 360;
export function latY(lat) {
  const l = Math.max(-85.05, Math.min(85.05, lat)) * D2R;
  return (1 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / Math.PI) / 2;
}
export const xLon = (x) => x * 360 - 180;
export const yLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;

// ------------------------------------------------------------------ zip reading

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This iPad is too old for the map (needs iPadOS 16.4 or newer)');
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export class ZipFile {
  constructor(blob) { this.blob = blob; this.entries = new Map(); }

  async open() {
    const size = this.blob.size;
    const tailLen = Math.min(size, 65557);
    const tail = new DataView(await this.blob.slice(size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    const count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
    const cd = new DataView(await this.blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (u32(cd, p) !== 0x02014b50) throw new Error('damaged zip file');
      const method = u16(cd, p + 10), csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32), off = u32(cd, p + 42);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nlen));
      this.entries.set(name, { method, csize, usize, off, nlen });
      p += 46 + nlen + xlen + clen;
    }
    return this;
  }

  has(name) { return this.entries.has(name); }

  async bytes(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    let head = await this.blob.slice(e.off, e.off + 30 + e.nlen + 64 + e.csize).arrayBuffer();
    let v = new DataView(head);
    if (u32(v, 0) !== 0x04034b50) throw new Error('damaged zip entry ' + name);
    const start = 30 + u16(v, 26) + u16(v, 28);
    if (start + e.csize > head.byteLength) head = await this.blob.slice(e.off, e.off + start + e.csize).arrayBuffer();
    const data = new Uint8Array(head, start, e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new Error('unsupported zip compression');
  }

  async json(name) {
    const b = await this.bytes(name);
    return b ? JSON.parse(new TextDecoder().decode(b)) : null;
  }
}

// ------------------------------------------------------------------ helpers

/** {cols, rows} -> array of objects (only the columns asked for). */
function table(t, keep) {
  if (!t) return [];
  const idx = keep.map((k) => t.cols.indexOf(k));
  return t.rows.map((r) => { const o = {}; keep.forEach((k, i) => { o[k] = idx[i] >= 0 ? r[idx[i]] : undefined; }); return o; });
}

/** Simple grid index over world units, so only what's on screen is looked at. */
class Grid {
  constructor(n = 256) { this.n = n; this.cells = new Map(); }
  add(item) {
    const k = Math.floor(item.x * this.n) + Math.floor(item.y * this.n) * this.n;
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = []));
    c.push(item);
  }
  *query(x0, y0, x1, y1) {
    const n = this.n;
    const cy0 = Math.max(0, Math.floor(y0 * n)), cy1 = Math.min(n - 1, Math.floor(y1 * n));
    const cx0 = Math.floor(x0 * n), cx1 = Math.floor(x1 * n);
    if (cx1 - cx0 > n) { for (const c of this.cells.values()) yield* c; return; }
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.cells.get(((cx % n) + n) % n + cy * n);
        if (c) yield* c;
      }
    }
  }
}

// Delta-coded flat [lat5, lon5, dlat, dlon, ...] -> [[lat, lon], ...]
function unpackRing(flat) {
  const out = [];
  let a = 0, b = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) { a += flat[i]; b += flat[i + 1]; out.push([a / 1e5, b / 1e5]); }
  return out;
}

// ------------------------------------------------------------------ the map data

export class MapData {
  constructor(zip) {
    this.zip = zip;
    this.tiles = new Map();     // "x_y" -> { path layers } | Promise | null
    this.tileSet = new Set();
    this.onTile = null;         // called when a tile finishes loading
  }

  static async open(blob) {
    const zip = await new ZipFile(blob).open();
    const meta = await zip.json('meta.json');
    if (!meta || meta.format !== 1) throw new Error('This map file is from a different version - export it again');
    const d = new MapData(zip);
    d.meta = meta;
    d.tileSet = new Set(meta.tiles || []);
    await d._loadGlobal();
    return d;
  }

  async _loadGlobal() {
    const [apt, rwy, nav, towns, pts, asp, lo] = await Promise.all(
      ['airports.json', 'runways.json', 'navaids.json', 'towns.json', 'points.json', 'airspace.json', 'base/lo.json'].map((n) => this.zip.json(n)));

    this.countries = apt?.countries || {};
    this.airports = table(apt, ['code', 'icao', 'iata', 'name', 'rank', 'lat', 'lon', 'elev', 'country', 'city', 'ident', 'sched']);
    this.aptGrid = new Grid(512);
    this.aptMajor = [];
    this.aptByCode = new Map();
    this.airports.forEach((a, i) => {
      a.i = i; a.kind = 'apt'; a.lat /= 1e5; a.lon /= 1e5; a.x = lonX(a.lon); a.y = latY(a.lat); a.rwys = [];
      this.aptGrid.add(a);
      if (a.rank <= 2) this.aptMajor.push(a);
      for (const k of [a.icao, a.code, a.ident]) if (k && !this.aptByCode.has(k)) this.aptByCode.set(k, a);
    });

    this.runways = table(rwy, ['apt', 'le', 'he', 'len', 'wid', 'surf', 'lit', 'closed', 'le_disp', 'he_disp', 'le_elev', 'he_elev', 'le_lat', 'le_lon', 'he_lat', 'he_lon']);
    for (const r of this.runways) {
      const a = this.airports[r.apt];
      if (!a) continue;
      a.rwys.push(r);
      if (r.le_lat != null && r.he_lat != null) {
        r.geo = true;
        r.x1 = lonX(r.le_lon / 1e5); r.y1 = latY(r.le_lat / 1e5);
        r.x2 = lonX(r.he_lon / 1e5); r.y2 = latY(r.he_lat / 1e5);
      }
      const L = r.len || 0;
      if (!r.closed && L > (a.maxLen || 0)) a.maxLen = L;
    }

    this.navaids = table(nav, ['ident', 'name', 'type', 'khz', 'lat', 'lon', 'elev', 'country', 'magvar', 'dme_ch', 'apt']);
    this.navGrid = new Grid(512);
    this.navaids.forEach((n, i) => {
      n.i = i; n.kind = 'nav'; n.lat /= 1e5; n.lon /= 1e5; n.x = lonX(n.lon); n.y = latY(n.lat);
      n.vor = /VOR|TACAN/.test(n.type);
      this.navGrid.add(n);
    });

    this.towns = (towns || []).map(([name, rank, lat, lon]) => ({ name, rank, lat: lat / 1e5, lon: lon / 1e5, x: lonX(lon / 1e5), y: latY(lat / 1e5) }));
    this.townGrid = new Grid(256);
    for (const t of this.towns) this.townGrid.add(t);

    this.points = table(pts, ['name', 'code', 'lat', 'lon', 'compulsory']);
    this.ptGrid = new Grid(512);
    this.points.forEach((p, i) => { p.i = i; p.kind = 'pt'; p.lat /= 1e5; p.lon /= 1e5; p.x = lonX(p.lon); p.y = latY(p.lat); this.ptGrid.add(p); });

    this.airspace = table(asp, ['cls', 'type', 'name', 'lo', 'hi', 'bbox', 'ring']).map((a, i) => {
      const ring = unpackRing(a.ring);
      const [la0, lo0, la1, lo1] = a.bbox.map((v) => v / 1e5);
      const x0 = lonX(lo0), y0 = latY(la1);
      const path = new Path2D();
      ring.forEach(([lat, lon], k) => { const x = (lonX(lon) - x0) * K, y = (latY(lat) - y0) * K; if (k) path.lineTo(x, y); else path.moveTo(x, y); });
      path.closePath();
      return { i, kind: 'asp', cls: a.cls, type: a.type, name: a.name, lo: a.lo, hi: a.hi, ring, x0, y0, x1: lonX(lo1), y1: latY(la0), path };
    });

    // zoomed-out world outline (rounded to lo_step degrees)
    this.lo = {};
    const step = this.meta.lo_step || 0.02;
    for (const [layer, rings] of Object.entries(lo || {})) {
      const p = new Path2D();
      for (const flat of rings) {
        let a = 0, b = 0;
        for (let i = 0; i + 1 < flat.length; i += 2) {
          a += flat[i]; b += flat[i + 1];
          const x = lonX(b * step) * K, y = latY(a * step) * K;
          if (i) p.lineTo(x, y); else p.moveTo(x, y);
        }
        if (layer !== 'border') p.closePath();
      }
      this.lo[layer] = p;
    }
  }

  /** Base-map tile (x, y in tile numbers): Path2D per layer, or null while loading. */
  tile(tx, ty) {
    const key = `${tx}_${ty}`;
    const t = this.tiles.get(key);
    if (t !== undefined) return t instanceof Promise ? null : t;
    if (!this.tileSet.has(key)) { this.tiles.set(key, false); return false; }
    const p = this._loadTile(tx, ty, key).then((v) => { this.tiles.set(key, v); this.onTile?.(); }, (e) => { console.warn('tile', key, e); this.tiles.set(key, false); });
    this.tiles.set(key, p);
    if (this.tiles.size > 600) this._trim();
    return null;
  }

  async _loadTile(tx, ty, key) {
    const d = await this.zip.json(`base/t/${key}.json`);
    const T = this.meta.tile, Q = this.meta.q;
    const ox = tx * T - 180, oy = ty * T - 90;
    const x0 = lonX(ox), y0 = latY(oy + T);
    // mercator y for each tile-local row (0..Q) is computed lazily and cached
    const yCache = new Map();
    const yOf = (qy) => { let v = yCache.get(qy); if (v === undefined) { v = (latY(oy + (qy / Q) * T) - y0) * K; yCache.set(qy, v); } return v; };
    const xs = (T / 360) * K / Q;
    const out = { x0, y0 };
    for (const [layer, list] of Object.entries(d || {})) {
      const p = new Path2D();
      const closed = layer === 'land' || layer === 'lake';
      for (const flat of list) {
        let qx = 0, qy = 0;
        for (let i = 0; i + 1 < flat.length; i += 2) {
          qx += flat[i]; qy += flat[i + 1];
          const x = qx * xs, y = yOf(qy);
          if (i) p.lineTo(x, y); else p.moveTo(x, y);
        }
        if (closed) p.closePath();
      }
      out[layer] = p;
    }
    return out;
  }

  _trim() {
    let n = this.tiles.size - 400;
    for (const [k, v] of this.tiles) { if (n <= 0) break; if (!(v instanceof Promise)) { this.tiles.delete(k); n--; } }
  }

  /** Airport by ICAO / code (first match). */
  airport(code) { return this.aptByCode.get(code) || null; }

  /** Airspaces containing a point (lat/lon), smallest first. */
  airspaceAt(lat, lon) {
    const x = lonX(lon), y = latY(lat);
    const out = [];
    for (const a of this.airspace) {
      if (x < a.x0 || x > a.x1 || y < a.y0 || y > a.y1) continue;
      if (pointInRing(lat, lon, a.ring)) out.push(a);
    }
    return out.sort((p, q) => (p.x1 - p.x0) * (p.y1 - p.y0) - (q.x1 - q.x0) * (q.y1 - q.y0));
  }
}

function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, oi] = ring[i], [aj, oj] = ring[j];
    if ((ai > lat) !== (aj > lat) && lon < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ geodesy

const R_NM = 3440.065;
/** Great-circle distance (nm) and initial true bearing (deg) from 1 to 2. */
export function distBrg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  const b = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / D2R;
  return [d, (b + 360) % 360];
}
