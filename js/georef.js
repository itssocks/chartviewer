// Georeferencing of Jeppesen airport diagrams (10-9) and approach plan views,
// for showing your GPS position on the chart (situational awareness only).
//
// Jeppesen prints latitude/longitude labels at the frame ticks, e.g. "09-04"
// (N09°04') on the left/right edges and "79-23" (W079°23') on the top/bottom.
// pdf.js gives us each label's exact position, so we fit:
//     x = ax * lonMinutes + bx        y = ay * latMinutes + by     (PDF points)
// The chart is north-up; east-west and north-south are fitted separately
// because the exported PDFs are stretched ~4 % sideways (harmless this way).
//
// Strict checks - if any fails, the chart gets NO position (never a wrong one):
//   - at least 2 different values per axis, after dropping labels that don't
//     line up with the others (some labels are nudged away from their tick);
//   - every remaining label within 1.5 pt of the fitted line;
//   - the two scales agree with the latitude (cos lat), allowing for the stretch;
//   - the chart doesn't say NOT TO SCALE.

const LABEL = /^\s*(\d{2,3})-(\d{2})\s*$/;
const TOL = 1.5;           // pt: max distance of a label from the fitted line
// The exported PDFs are drawn ~3.6 % wider than tall (from JeppViewer's chart-to-PDF
// tools) unless the export corrected it (PDF field AspectFix). The fitted scales
// must match that closely, or the labels were misread and the chart is rejected.
const STRETCH_RAW = 1.036;
const STRETCH_BAND = [0.985, 1.025]; // allowed (measured ratio / expected ratio)

function fit(pts) {
  // least squares p = a*v + b, dropping the worst outlier until all fit
  let use = pts.slice();
  for (;;) {
    const vals = new Set(use.map((q) => q.v));
    if (vals.size < 2) return null;
    const n = use.length;
    const mv = use.reduce((s, q) => s + q.v, 0) / n, mp = use.reduce((s, q) => s + q.p, 0) / n;
    let sxx = 0, sxy = 0;
    for (const q of use) { sxx += (q.v - mv) ** 2; sxy += (q.v - mv) * (q.p - mp); }
    const a = sxy / sxx, b = mp - a * mv;
    let worst = null, wr = 0;
    for (const q of use) { const r = Math.abs(a * q.v + b - q.p); if (r > wr) { wr = r; worst = q; } }
    if (wr <= TOL) return { a, b, n: use.length, values: vals.size, dropped: pts.length - use.length };
    use = use.filter((q) => q !== worst);
  }
}

/**
 * @param textItems  pdf.js getTextContent().items for the page
 * @param apt        { lat, lon } of the airport (degrees, signed)
 * @param lines      linesFromOps() result (optional but strongly preferred)
 * @returns { ok:true, ax,bx, ay,by, box:[x0,y0,x1,y1] } or { ok:false, reason }
 */
/**
 * Long straight horizontal / vertical lines drawn on the page, in PDF user space,
 * from a pdf.js operator list. Used to find the plan view's frame edges.
 * Returns { h: [[y, x0, x1]...], v: [[x, y0, y1]...] }.
 */
export function linesFromOps(ol, OPS) {
  const h = [], v = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const T = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const seg = (p, q) => {
    if (Math.abs(p[1] - q[1]) < 0.3 && Math.abs(p[0] - q[0]) > 30) h.push([(p[1] + q[1]) / 2, Math.min(p[0], q[0]), Math.max(p[0], q[0])]);
    else if (Math.abs(p[0] - q[0]) < 0.3 && Math.abs(p[1] - q[1]) > 30) v.push([(p[0] + q[0]) / 2, Math.min(p[1], q[1]), Math.max(p[1], q[1])]);
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(args, ctm);
    else if (fn === OPS.constructPath) {
      const [ops, coords] = args;
      let k = 0, start = null, last = null;
      for (const op of ops) {
        if (op === OPS.moveTo) { last = start = T(coords[k], coords[k + 1]); k += 2; }
        else if (op === OPS.lineTo) { const p = T(coords[k], coords[k + 1]); k += 2; if (last) seg(last, p); last = p; }
        else if (op === OPS.closePath) { if (last && start) seg(last, start); last = start; }
        else if (op === OPS.rectangle) {
          const [x, y, w, hh] = coords.slice(k, k + 4); k += 4;
          const c = [T(x, y), T(x + w, y), T(x + w, y + hh), T(x, y + hh)];
          for (let j = 0; j < 4; j++) seg(c[j], c[(j + 1) % 4]);
        } else if (op === OPS.curveTo) { k += 6; last = null; }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { k += 4; last = null; }
      }
    }
  }
  return { h, v };
}

export function georefFromText(textItems, apt, lines = { h: [], v: [] }, aspectFixed = false) {
  if (!apt || apt.lat == null || apt.lon == null) return { ok: false, reason: 'no airport position' };
  const nts = textItems.filter((it) => /NOT\s+TO\s+SCALE/i.test(it.str)).map((it) => [it.transform[4], it.transform[5]]);
  const lat0 = Math.abs(apt.lat), lon0 = Math.abs(apt.lon);
  const sLat = apt.lat < 0 ? -1 : 1, sLon = apt.lon < 0 ? -1 : 1;
  const latPts = [], lonPts = [];
  const latX = [], lonY = [];
  for (const it of textItems) {
    const m = LABEL.exec(it.str || '');
    if (!m) continue;
    const [a, b, , , e, f] = it.transform;
    if (Math.abs(b) > 0.01 * Math.abs(a)) continue; // only horizontal labels
    const deg = +m[1], min = +m[2];
    if (min >= 60) continue;
    const v = deg + min / 60;
    const isLat = Math.abs(v - lat0) < 1.5, isLon = Math.abs(v - lon0) < 1.5;
    if (isLat === isLon) continue; // neither, or ambiguous
    const h = it.height || Math.abs(a);
    if (isLat) {
      latPts.push({ v: sLat * (deg * 60 + min), p: f + h * 0.35 }); // tick at the label's mid-height
      latX.push([e, e + it.width]);
    } else {
      lonPts.push({ v: sLon * (deg * 60 + min), p: e + it.width / 2 }); // tick at the label's centre
      lonY.push([f, f + h]);
    }
  }
  const fx = fit(lonPts), fy = fit(latPts);
  if (!fx || !fy) return { ok: false, reason: 'not enough lat/lon labels' };
  // Signed minutes grow eastward / northward, and so do PDF x / y (PDF y is up).
  if (fx.a <= 0 || fy.a <= 0) return { ok: false, reason: 'unexpected orientation' };
  const ratio = (Math.abs(fx.a) / Math.abs(fy.a)) / Math.cos((lat0 * Math.PI) / 180);
  const rel = ratio / (aspectFixed ? 1 : STRETCH_RAW);
  if (rel < STRETCH_BAND[0] || rel > STRETCH_BAND[1]) return { ok: false, reason: `scales disagree (${ratio.toFixed(3)})` };

  // Area the position is valid in: the frame the labels sit on (plus a small margin).
  const spanX = Math.abs(fx.a * 60), spanY = Math.abs(fy.a * 60); // pt per degree (for margins below)
  const gx = lonPts.map((q) => fx.a * q.v + fx.b), gy = latPts.map((q) => fy.a * q.v + fy.b);
  const gridX = Math.abs(fx.a) * minStep(lonPts), gridY = Math.abs(fy.a) * minStep(latPts);
  const lefts = latX.map((r) => r[1]), rights = latX.map((r) => r[0]);
  const bottoms = lonY.map((r) => r[1]), tops = lonY.map((r) => r[0]);
  const midX = (Math.min(...gx) + Math.max(...gx)) / 2, midY = (Math.min(...gy) + Math.max(...gy)) / 2;
  const leftSide = lefts.filter((x) => x < midX), rightSide = rights.filter((x) => x > midX);
  const botSide = bottoms.filter((y) => y < midY), topSide = tops.filter((y) => y > midY);
  // The area the position is valid in = the plan view's frame. Its edges are the
  // nearest long straight lines just outside the outermost ticks that span the
  // whole tick range. If an edge can't be found, use the label edge on that side,
  // else stop at the outermost tick (smaller area, never too big).
  const tx0 = Math.min(...gx), tx1 = Math.max(...gx), ty0 = Math.min(...gy), ty1 = Math.max(...gy);
  const T = 3; // pt
  const near = (arr, cmp) => arr.length ? arr.reduce((a, b) => (cmp(a, b) ? a : b)) : null;
  const hs = lines.h.filter(([, x0, x1]) => x0 <= tx0 + T && x1 >= tx1 - T);
  const vs = lines.v.filter(([, y0, y1]) => y0 <= ty0 + T && y1 >= ty1 - T);
  const top = near(hs.filter(([y]) => y >= ty1 - T).map(([y]) => y), (a, b) => a < b);
  const bot = near(hs.filter(([y]) => y <= ty0 + T).map(([y]) => y), (a, b) => a > b);
  const rgt = near(vs.filter(([x]) => x >= tx1 - T).map(([x]) => x), (a, b) => a < b);
  const lft = near(vs.filter(([x]) => x <= tx0 + T).map(([x]) => x), (a, b) => a > b);
  const box = [
    lft ?? (leftSide.length ? Math.max(...leftSide) : tx0),
    bot ?? (botSide.length ? Math.max(...botSide) : ty0),
    rgt ?? (rightSide.length ? Math.min(...rightSide) : tx1),
    top ?? (topSide.length ? Math.min(...topSide) : ty1),
  ];
  const framed = [lft, bot, rgt, top].filter((e) => e != null).length;
  // A "NOT TO SCALE" note inside the plan view means part of it isn't to scale: no position.
  // (The same note outside it - e.g. on the profile - doesn't matter.)
  if (nts.some(([x, y]) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3])) {
    return { ok: false, reason: 'not to scale' };
  }
  return { ok: true, ax: fx.a, bx: fx.b, ay: fy.a, by: fy.b, box, framed, ratio, spanX, spanY,
    labels: { lon: fx.n, lat: fy.n, dropped: fx.dropped + fy.dropped } };
}

function minStep(pts) {
  const v = [...new Set(pts.map((q) => q.v))].sort((a, b) => a - b);
  let m = Infinity;
  for (let i = 1; i < v.length; i++) m = Math.min(m, v[i] - v[i - 1]);
  return Number.isFinite(m) ? m : 1;
}

/** lat/lon (degrees) -> PDF user-space point, or null if outside the chart's area. */
export function toChart(g, lat, lon) {
  const x = g.ax * lon * 60 + g.bx, y = g.ay * lat * 60 + g.by;
  const [x0, y0, x1, y1] = g.box;
  const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
  return { x, y, inside };
}
