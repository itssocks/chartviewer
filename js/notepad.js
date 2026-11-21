// Kneeboard page templates. Each template is drawn as vector graphics on a
// canvas, so it stays sharp at any zoom. makeNotePage() returns an object that
// behaves like a pdf.js page, so the chart viewer (zoom, Pencil, eraser, undo,
// night mode) works on note pages unchanged.

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const INK = '#111';
const FAINT = '#c9d1db';

function helpers(ctx) {
  return {
    line(x1, y1, x2, y2, w = 1.2, color = INK, dash = null) {
      ctx.beginPath();
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]);
    },
    rect(x, y, w, h, lw = 1.2, color = INK) {
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.strokeRect(x, y, w, h);
    },
    text(str, x, y, size = 11, { bold = false, align = 'left', color = INK } = {}) {
      ctx.fillStyle = color;
      ctx.font = `${bold ? 700 : 500} ${size}px ${FONT}`;
      ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
      ctx.fillText(str, x, y);
    },
    hlines(x1, x2, y0, y1, step, color = FAINT, w = 1) {
      for (let y = y0; y <= y1 + 0.01; y += step) this.line(x1, y, x2, y, w, color);
    },
  };
}

export const TEMPLATES = [
  {
    id: 'blank', name: 'Blank', icon: '▢', w: 600, h: 800,
    draw() {},
  },
  {
    id: 'lined', name: 'Lined', icon: '☰', w: 600, h: 800,
    draw(d) {
      d.hlines(24, 576, 70, 776, 30);
      d.line(70, 20, 70, 780, 1, '#f2b8b8');
    },
  },
  {
    id: 'grid', name: 'Grid', icon: '▦', w: 600, h: 800,
    draw(d) {
      for (let x = 25; x <= 575; x += 25) d.line(x, 25, x, 775, x % 100 === 25 ? 1 : 0.6, FAINT);
      for (let y = 25; y <= 775; y += 25) d.line(25, y, 575, y, y % 100 === 25 ? 1 : 0.6, FAINT);
    },
  },
  {
    id: 'ifr', name: 'IFR clearance + ATIS', icon: '✈︎', w: 600, h: 800,
    draw(d) {
      // ATIS
      d.text('ATIS', 20, 32, 15, { bold: true });
      d.rect(20, 40, 560, 200);
      d.line(110, 40, 110, 200);
      d.text('INFO', 30, 56, 10);
      const rows = [['TIME', 'WIND'], ['VIS', 'WX'], ['CLOUDS', 'TEMP / DEW'], ['ALTIMETER', 'RWY / APPROACH']];
      rows.forEach(([a, b], i) => {
        const y = 40 + i * 40;
        if (i) d.line(110, y, 580, y);
        d.line(345, y, 345, y + 40);
        d.text(a, 116, y + 12, 9);
        d.text(b, 351, y + 12, 9);
      });
      d.line(20, 200, 580, 200);
      d.text('REMARKS', 26, 212, 9);
      // CRAFT clearance
      d.text('CLEARANCE  (CRAFT)', 20, 272, 15, { bold: true });
      const craft = [['C', 'CLEARANCE LIMIT'], ['R', 'ROUTE'], ['A', 'ALTITUDE  (climb / expect)'], ['F', 'FREQUENCY  (departure)'], ['T', 'TRANSPONDER  (squawk)']];
      d.rect(20, 280, 560, 260);
      d.line(72, 280, 72, 540);
      craft.forEach(([L, label], i) => {
        const y = 280 + i * 52;
        if (i) d.line(20, y, 580, y);
        d.text(L, 46, y + 36, 28, { bold: true, align: 'center' });
        d.text(label, 78, y + 12, 9);
      });
      // Taxi
      d.rect(20, 552, 560, 50);
      d.line(440, 552, 440, 602);
      d.text('TAXI', 26, 564, 9);
      d.text('RWY / HOLD SHORT', 446, 564, 9);
      // Notes
      d.text('NOTES', 20, 628, 15, { bold: true });
      d.hlines(20, 580, 660, 780, 30);
    },
  },
  {
    // Rebuilt from the printed "Kneeboard Cheat Sheet" (half a letter page).
    id: 'pvfr', name: 'Panama VFR (MPMG)', icon: '🇵🇦', w: 396, h: 612,
    draw(d) {
      const W = 396;
      d.text('CLEARANCE / ATIS', 6, 14, 8, { color: '#777' });
      // TAXI / QNH / SQUAWK rows
      for (const y of [141, 184]) {
        d.line(0, y, W, y, 1.6);
        d.line(180, y, 180, y + 43, 1.2);
        d.line(289, y, 289, y + 43, 1.2);
        d.text('TAXI', 3, y + 11, 8.5);
        d.text('QNH', 183, y + 11, 8.5);
        d.text('SQUAWK', 292, y + 11, 8.5);
      }
      d.line(0, 228, W, 228, 1.6);
      d.text('NOTES', 3, 242, 10);
      // Flight plan items + frequencies
      const top = 398;
      d.line(0, top, W, top, 1.6);
      const items = ['FROM', 'TO', 'ALTITUDE', 'TIME ENROUTE', 'FUEL ON BOARD (TIME)', 'SOULS ON BOARD', 'PILOT FLYING'];
      items.forEach((s, i) => {
        const y = top + 16 + i * 17;
        d.text('▪', 6, y, 7);
        d.text(s, 17, y, 9.5);
      });
      d.line(180, top, 180, 612, 1.4);
      const freqs = [['Gelabert Ground', '121.7'], ['Gelabert Tower', '118.3'], ['Panama Advisory', '121.2'],
        ['Panama Radio NE', '123.6'], ['Panama Radio SW', '126.9'], ['Unicom', '122.8']];
      freqs.forEach(([n, f], i) => {
        const y = top + i * 24;
        if (i) d.line(180, y, W, y, 1);
        d.text(n, 187, y + 16, 10.5);
        d.text(f, 343, y + 16, 10.5);
      });
      d.line(336, top, 336, top + 144, 1);
      d.line(180, top + 144, W, top + 144, 1.4);
    },
  },
  {
    id: 'log', name: 'Time & fuel log', icon: '⏱', w: 600, h: 800,
    draw(d) {
      const head = ['DATE', 'AIRCRAFT', 'TAKEOFF', 'FUEL START'];
      d.rect(20, 30, 560, 50);
      head.forEach((h, i) => {
        if (i) d.line(20 + i * 140, 30, 20 + i * 140, 80);
        d.text(h, 26 + i * 140, 42, 9);
      });
      const cols = [[20, 'CHECKPOINT'], [230, 'ETA'], [310, 'ATA'], [390, 'FUEL'], [470, 'ALT / NOTES']];
      d.rect(20, 100, 560, 690);
      cols.forEach(([x, h], i) => {
        if (i) d.line(x, 100, x, 790);
        d.text(h, x + 6, 118, 9.5, { bold: true });
      });
      for (let y = 126; y < 790; y += 30) d.line(20, y, 580, y, y === 126 ? 1.4 : 0.8);
    },
  },
];

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];

/** A page-like object for the chart viewer (same API subset as a pdf.js page). */
export function makeNotePage(templateId) {
  const t = templateById(templateId);
  return {
    rotate: 0,
    getViewport({ scale = 1 } = {}) {
      return { width: t.w * scale, height: t.h * scale, scale };
    },
    render({ canvasContext: ctx, viewport, transform }) {
      let cancelled = false;
      const promise = new Promise((resolve, reject) => {
        // Run on the next frame so it behaves like pdf.js (async, cancellable).
        requestAnimationFrame(() => {
          if (cancelled) { const e = new Error('cancelled'); e.name = 'RenderingCancelledException'; reject(e); return; }
          ctx.save();
          if (transform) ctx.setTransform(...transform);
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, viewport.width, viewport.height);
          ctx.scale(viewport.scale, viewport.scale);
          t.draw(helpers(ctx));
          ctx.restore();
          resolve();
        });
      });
      return { promise, cancel() { cancelled = true; } };
    },
  };
}
