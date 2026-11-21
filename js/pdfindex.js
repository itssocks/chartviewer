// Reads an airport PDF made by jepp_export.py and builds its chart list
// from the bookmarks (outline) and metadata. Works without _charts_index.json;
// if the index was imported it fills in anything the PDF doesn't carry.

export const CATS = ['AIRPORT', 'DEPARTURE', 'ARRIVAL', 'APPROACH', 'AIRSPACE', 'NOISE', 'TEXT', 'OTHER'];

const CAT_WORDS = [
  ['airport', 'AIRPORT'], ['depart', 'DEPARTURE'], ['sid', 'DEPARTURE'], ['arriv', 'ARRIVAL'],
  ['star', 'ARRIVAL'], ['approach', 'APPROACH'], ['airspace', 'AIRSPACE'], ['noise', 'NOISE'],
  ['text', 'TEXT'], ['other', 'OTHER'],
];

function categoryFromTitle(t) {
  const s = t.toLowerCase().replace(/\(\d+\)\s*$/, '').trim();
  for (const [w, c] of CAT_WORDS) if (s.startsWith(w)) return c;
  return null;
}

export function numberSortKey(n) {
  const m = /^(\d+)-(\d+)(.*)$/.exec(n || '');
  return m ? [+m[1], +m[2], m[3]] : [999, 0, n || ''];
}
export function compareNumbers(a, b) {
  const x = numberSortKey(a), y = numberSortKey(b);
  return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
}

export function parseKeywords(s) {
  const out = {};
  for (const part of String(s || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim();
  }
  return out;
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Find the _charts_index.json entry for this airport + cycle (if any). */
function indexEntry(index, icao, cycle) {
  if (!index || !Array.isArray(index.airports)) return null;
  const a = index.airports.find((x) => x.icao === icao);
  if (!a) return null;
  const c = a.cycle || index.cycle;
  if (cycle && c && c !== cycle) return null;
  return a;
}

/**
 * Parse a PDF. `data` is a Uint8Array (pdf.js may take ownership of it).
 * Returns an airport record (without storage fields).
 */
export async function parseAirportPdf(pdfjsLib, data, fileName, index) {
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const numPages = doc.numPages;
    let info = {};
    try { info = (await doc.getMetadata()).info || {}; } catch { /* no metadata */ }
    const kw = parseKeywords(info.Keywords);
    const custom = info.Custom || {};
    let outline = [];
    try { outline = (await doc.getOutline()) || []; } catch { outline = []; }

    const pageOf = async (dest) => {
      try {
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (!Array.isArray(dest)) return null;
        const ref = dest[0];
        if (ref && typeof ref === 'object') return (await doc.getPageIndex(ref)) + 1;
        if (Number.isInteger(ref)) return ref + 1;
      } catch { /* bad destination */ }
      return null;
    };

    const flags = [];
    let topTitle = '';
    const charts = [];

    // Bookmarks: [top "MPTO - Name | Cycle ..."], then category items with chart children.
    const addChart = async (node, cat) => {
      const page = await pageOf(node.dest);
      if (!page) return;
      const t = (node.title || '').trim();
      const m = /^(\d+-\d+\S*)\s+(.*)$/.exec(t) || /^(\S+)\s{2,}(.*)$/.exec(t);
      charts.push({ number: m ? m[1] : '', title: (m ? m[2] : t).trim(), cat: cat || 'OTHER', page });
    };
    for (const node of outline) {
      const t = (node.title || '').trim();
      const kids = node.items || [];
      const cat = categoryFromTitle(t);
      if (kids.length && cat) {
        for (const k of kids) await addChart(k, cat);
      } else if (!topTitle && /cycle/i.test(t)) {
        topTitle = t;
        for (const k of kids) await addChart(k, categoryFromTitle(k.title || '') || 'OTHER');
      } else if (kids.length) {
        for (const k of kids) await addChart(k, 'OTHER');
      } else if (/^\d+-\d+/.test(t)) {
        await addChart(node, 'OTHER');
      }
    }

    // Identity
    const stem = String(fileName || '').replace(/\.pdf$/i, '').replace(/\s*\(.*\)\s*/g, '').trim();
    let icao = (kw.ICAO || '').toUpperCase();
    if (!icao) { const m = /^([A-Z0-9]{3,4})\b/.exec(info.Title || ''); if (m) icao = m[1]; }
    if (!icao) { const m = /^([A-Z0-9]{3,4})\s+-/.exec(topTitle); if (m) icao = m[1]; }
    if (!icao) icao = stem.toUpperCase().slice(0, 8) || 'UNKNOWN';

    let cycle = kw.CYCLE || '';
    if (!cycle) { const m = /cycle\s+(\d{4})/i.exec(info.Title || '') || /cycle\s+(\d{4})/i.exec(topTitle); if (m) cycle = m[1]; }
    let validFrom = kw.VALID_FROM || '', validTo = kw.VALID_TO || '';
    if (!validTo) {
      const m = /(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/.exec(info.Subject || '');
      if (m) { validFrom = m[1]; validTo = m[2]; }
    }

    const ie = indexEntry(index, icao, cycle);
    if (ie) {
      cycle = cycle || ie.cycle || index.cycle || '';
      validFrom = validFrom || ie.valid_from || index.valid_from || '';
      validTo = validTo || ie.valid_to || index.valid_to || '';
    }

    let name = '';
    { const m = /^\S+\s+-\s+(.*?)\s*(\||$)/.exec(topTitle); if (m) name = m[1]; }
    if (!name && ie?.name) name = titleCase(ie.name);
    if (!name && info.Title) name = titleCase(String(info.Title).replace(/^\S+\s+/, '').replace(/\s+-\s+Jeppesen.*$/i, ''));

    // Chart revisions (to carry annotations to the next cycle when a chart didn't change)
    const revByPage = {};
    for (const part of String(custom.ChartRevs || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) revByPage[+part.slice(0, i)] = part.slice(i + 1);
    }
    const rwyByPage = {};
    for (const part of String(custom.ChartRunways || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) rwyByPage[+part.slice(0, i)] = part.slice(i + 1).split(',').filter(Boolean);
    }
    let aptInfo = null;
    try { aptInfo = custom.AirportInfo ? JSON.parse(custom.AirportInfo) : null; } catch { aptInfo = null; }
    const ieByNumber = {};
    if (ie?.charts) for (const c of ie.charts) ieByNumber[c.number + '@' + c.page] = c;

    // If the bookmarks were missing, try the index; else page by page.
    if (!charts.length && ie?.charts?.length) {
      for (const c of ie.charts) charts.push({ number: c.number, title: c.title, cat: CATS.includes(c.category) ? c.category : 'OTHER', page: c.page });
      flags.push('No bookmarks in the PDF - chart list taken from _charts_index.json');
    }

    // Page ranges, keys, revisions
    charts.sort((a, b) => a.page - b.page);
    for (let i = 0; i < charts.length; i++) {
      const next = charts.slice(i + 1).find((c) => c.page > charts[i].page);
      charts[i].pages = Math.max(1, (next ? next.page : numPages + 1) - charts[i].page);
    }
    const covered = new Set();
    for (const c of charts) for (let p = c.page; p < c.page + c.pages; p++) covered.add(p);

    if (!charts.length) {
      flags.push('No chart bookmarks found - showing the PDF page by page. Check each chart carefully.');
    }
    const unindexed = [];
    for (let p = 1; p <= numPages; p++) if (!covered.has(p)) unindexed.push(p);
    if (charts.length && unindexed.length) flags.push(`${unindexed.length} page(s) have no bookmark - listed under Other as "Page n".`);
    for (const p of unindexed) charts.push({ number: '', title: `Page ${p}`, cat: 'OTHER', page: p, pages: 1, unindexed: true });

    const seen = {};
    for (const c of charts) {
      let key = c.number || `p${c.page}`;
      if (seen[key]) key = `${key}~${++seen[key]}`; else seen[key] = 1;
      c.key = key;
      const ic = ieByNumber[c.number + '@' + c.page];
      c.rev = revByPage[c.page] || ic?.rev || '';
      c.runways = rwyByPage[c.page] || ic?.runways || [];
    }
    charts.sort((a, b) => compareNumbers(a.number, b.number) || a.page - b.page);

    if (!cycle || !validTo) flags.push('Cycle / validity dates not found in this PDF.');

    return {
      icao,
      iata: (kw.IATA || ie?.iata || '').toUpperCase(),
      name: name || icao,
      city: titleCase(kw.CITY || ie?.city || ''),
      country: (kw.COUNTRY || ie?.country || '').toUpperCase(),
      cycle, validFrom, validTo,
      numPages,
      charts,
      info: aptInfo || ie?.info || null,
      aspectFixed: custom.AspectFix === '1',
      flags,
    };
  } finally {
    doc.destroy();
  }
}

/** Fill gaps in an already-imported airport from a newly imported index. */
export function enrichFromIndex(rec, index) {
  const ie = indexEntry(index, rec.icao, rec.cycle);
  if (!ie) return false;
  let changed = false;
  const set = (k, v) => { if (!rec[k] && v) { rec[k] = v; changed = true; } };
  set('iata', (ie.iata || '').toUpperCase());
  set('city', titleCase(ie.city || ''));
  set('country', (ie.country || '').toUpperCase());
  set('validFrom', ie.valid_from || index.valid_from);
  set('validTo', ie.valid_to || index.valid_to);
  set('info', ie.info);
  const byKey = {};
  for (const c of ie.charts || []) byKey[c.number + '@' + c.page] = c;
  for (const c of rec.charts) {
    const x = byKey[c.number + '@' + c.page];
    if (x && !c.rev && x.rev) { c.rev = x.rev; changed = true; }
    if (x && !c.runways?.length && x.runways?.length) { c.runways = x.runways; changed = true; }
  }
  return changed;
}
