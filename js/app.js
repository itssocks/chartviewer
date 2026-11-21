// Chart Viewer - main app. Everything stays on this device; no network use
// except loading the app itself (and that is cached for offline use).
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import * as store from './store.js';
import { parseAirportPdf, enrichFromIndex, compareNumbers } from './pdfindex.js';
import { ChartViewer } from './viewer.js';
import { TEMPLATES, templateById, makeNotePage } from './notepad.js';
import { Gps, parseMagvar } from './gps.js';
import { georefFromText, linesFromOps, toChart } from './georef.js';

export const APP_VERSION = '1.4.1';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const TABS = [
  { id: 'INFO', label: 'Info / Taxi', cats: ['AIRPORT'] },
  { id: 'SID', label: 'SID', cats: ['DEPARTURE'] },
  { id: 'STAR', label: 'STAR', cats: ['ARRIVAL'] },
  { id: 'APP', label: 'Approach', cats: ['APPROACH'] },
  { id: 'OTHER', label: 'Other', cats: ['AIRSPACE', 'NOISE', 'TEXT', 'OTHER'] },
];
const tabOf = (cat) => (TABS.find((t) => t.cats.includes(cat)) || TABS[4]).id;
const tabLabel = (id) => (TABS.find((t) => t.id === id) || TABS[4]).label;
const SLOTS = [['dep', 'DEP'], ['arr', 'ARR'], ['alt', 'ALT']];

const KV_DEFAULTS = {
  favorites: [], recents: [], flight: { dep: '', arr: '', alt: '' },
  theme: 'auto', chartNight: false, dim: 1,
  tool: { kind: 'pen', color: 'red', width: 'thin' },
  last: {}, index: null, rotation: {}, rwy: {}, wx: {}, wxRelay: '', gps: false, compassOffset: 0, lastNote: '', lastBackup: 0,
};

const S = { airports: new Map(), kv: {}, ann: new Map(), view: null, missing: new Set(), notes: new Map() };
const app = document.getElementById('app');

// ================================================================ state

async function loadState() {
  for (const a of await store.getAll('airports')) S.airports.set(a.icao, a);
  for (const k of Object.keys(KV_DEFAULTS)) {
    const v = await store.get('kv', k);
    S.kv[k] = v === undefined ? structuredClone(KV_DEFAULTS[k]) : v;
  }
  for (const n of await store.getAll('notes')) S.notes.set(n.id, n);
  for (const r of await store.getAll('annotations')) S.ann.set(r.id, { id: r.id, icao: r.icao, key: r.key, cycle: r.cycle, rev: r.rev, n: r.strokes.length });
}
function setKv(k, v) { S.kv[k] = v; store.put('kv', v, k).catch((e) => console.warn(e)); }

// ================================================================ helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d, year = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  return m ? `${m[3]} ${MON[+m[2] - 1]}${year ? ' ' + m[1] : ''}` : '?';
}
function fmtWhen(ts) {
  const d = new Date(ts);
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
const todayUTC = () => new Date().toISOString().slice(0, 10);

function cycleState(a) {
  if (!a?.validTo) return 'unknown';
  const t = todayUTC();
  if (t > a.validTo) return 'expired';
  if (a.validFrom && t < a.validFrom) return 'future';
  return (Date.parse(a.validTo) - Date.parse(t)) / 864e5 < 2 ? 'soon' : 'ok';
}
function cycleText(a) {
  if (!a?.cycle && !a?.validTo) return 'Cycle unknown';
  return `Cycle ${a.cycle || '?'} · ${fmtDate(a.validFrom, false)} – ${fmtDate(a.validTo)}`;
}
function cycleBadge(a, extra = '') {
  const st = cycleState(a);
  const tag = { expired: ' · EXPIRED', future: ' · not yet effective', unknown: '' }[st] || '';
  return `<span class="cyc cyc-${st} ${extra}">${esc(cycleText(a))}${tag}</span>`;
}

/** The cycle most airports are on (what the app calls "installed"). */
function mainCycle() {
  const counts = new Map();
  for (const a of S.airports.values()) {
    const k = `${a.cycle}|${a.validFrom}|${a.validTo}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  if (!best) return null;
  const [cycle, validFrom, validTo] = best.split('|');
  return { cycle, validFrom, validTo, mixed: counts.size > 1 };
}

const sortedAirports = () => [...S.airports.values()].sort((a, b) => a.icao.localeCompare(b.icao));
const chartsInTab = (a, tab) => a.charts.filter((c) => tabOf(c.cat) === tab);

// Runway filter: '' = all. Charts without runway info always show.
const rwyFilter = (a) => (S.kv.rwy || {})[a.icao] || '';
const passRwy = (a, c) => { const f = rwyFilter(a); return !f || !c.runways?.length || c.runways.includes(f); };
const chartsShown = (a, tab) => chartsInTab(a, tab).filter((c) => passRwy(a, c));
function airportRunways(a) {
  const set = new Set();
  for (const r of a.info?.runways || []) for (const id of r.ids) set.add(id);
  for (const c of a.charts) for (const r of c.runways || []) set.add(r);
  return [...set].sort();
}
const countryName = (a) => a.info?.country_name || a.country || 'Other';
const findChart = (a, key) => a?.charts.find((c) => c.key === key);
const annId = (a, key, pidx) => `${a.icao}|${key}${pidx ? '@' + pidx : ''}|${a.cycle}`;
const hasAnn = (a, c) => { for (let i = 0; i < (c.pages || 1); i++) if (S.ann.get(annId(a, c.key, i))?.n) return true; return false; };
const isFav = (icao, key) => S.kv.favorites.some((f) => f.icao === icao && f.key === key);

function go(hash, replace = false) {
  if (replace) location.replace(hash); else location.hash = hash;
}
const chartHash = (icao, tab, key, pidx = 0) => `#/c/${encodeURIComponent(icao)}/${tab}/${encodeURIComponent(key)}/${pidx}`;

let toastTimer;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

let dialogFields = {}; // values of the inputs in the last closed dialog
function dialog({ title, html = '', buttons = [{ label: 'OK', value: true, cls: 'primary' }] }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="sheet" role="dialog"><h2>${esc(title)}</h2><div class="sheet-body">${html}</div>
      <div class="sheet-btns">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      dialogFields = {};
      wrap.querySelectorAll('input').forEach((i) => { dialogFields[i.id] = i.type === 'checkbox' ? i.checked : i.value; });
      wrap.remove();
      resolve(buttons[+b.dataset.i].value);
    });
    document.body.append(wrap);
  });
}

// ================================================================ theme

function applyTheme() {
  const t = S.kv.theme;
  const dark = t === 'night' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0d1117' : '#0b2545');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// ================================================================ PDF documents (cache of opened files)

const docCache = new Map(); // icao -> { file, promise }
function getDoc(a) {
  const c = docCache.get(a.icao);
  if (c && c.file === a.file) { docCache.delete(a.icao); docCache.set(a.icao, c); return c.promise; }
  if (c) dropDoc(a.icao);
  const promise = store.loadPdf(a.file, a.where)
    .then((data) => pdfjsLib.getDocument({ data, isEvalSupported: false }).promise);
  docCache.set(a.icao, { file: a.file, promise });
  promise.catch(() => docCache.delete(a.icao));
  while (docCache.size > 3) dropDoc(docCache.keys().next().value);
  return promise;
}
function dropDoc(icao) {
  const c = docCache.get(icao);
  if (!c) return;
  docCache.delete(icao);
  c.promise.then((d) => d.destroy()).catch(() => {});
}

// ================================================================ common pieces

function flightBar(currentIcao) {
  const f = S.kv.flight;
  return `<nav class="flightbar">${SLOTS.map(([slot, lbl]) => {
    const icao = f[slot];
    const a = icao && S.airports.get(icao);
    const st = a ? cycleState(a) : '';
    return `<button class="fslot ${icao === currentIcao && icao ? 'active' : ''} ${icao ? '' : 'unset'} ${st === 'expired' ? 'exp' : ''}" data-act="flight" data-slot="${slot}">
      <small>${lbl}</small><b>${esc(icao || '—')}</b></button>`;
  }).join('')}<button class="fedit" data-act="edit-flight" aria-label="Edit flight">✎</button></nav>`;
}

function rwyTags(a, c) {
  const r = c.runways || [];
  if (!r.length || r.length >= airportRunways(a).length) return '';
  return `<span class="rtags">${r.map((x) => `<i>${esc(x)}</i>`).join('')}</span>`;
}

function chartRow(a, c, tab, showTab = false) {
  const fav = isFav(a.icao, c.key);
  return `<div class="row chart-row">
    <button class="star ${fav ? 'on' : ''}" data-act="fav" data-icao="${esc(a.icao)}" data-key="${esc(c.key)}" aria-label="Favorite">${fav ? '★' : '☆'}</button>
    <button class="row-main" data-act="open-chart" data-icao="${esc(a.icao)}" data-key="${esc(c.key)}" data-tab="${tab}">
      <span class="num">${esc(c.number || '—')}</span>
      <span class="ttl">${esc(c.title)}${showTab ? ` <em>${esc(tabLabel(tabOf(c.cat)))}</em>` : ''}</span>
      ${rwyTags(a, c)}
      ${hasAnn(a, c) ? '<span class="annmark" title="Has notes">✎</span>' : ''}
      ${c.unindexed ? '<span class="warnmark">⚠</span>' : ''}
    </button></div>`;
}

function savedChartRow(item, kind) {
  const a = S.airports.get(item.icao);
  const c = a && findChart(a, item.key);
  const gone = !c;
  return `<div class="row chart-row ${gone ? 'gone' : ''}">
    ${kind === 'fav' ? `<button class="star on" data-act="fav" data-icao="${esc(item.icao)}" data-key="${esc(item.key)}">★</button>` : '<span class="star-sp"></span>'}
    <button class="row-main" ${gone ? 'disabled' : `data-act="open-chart" data-icao="${esc(item.icao)}" data-key="${esc(item.key)}" data-tab="${tabOf(c.cat)}"`}>
      <span class="apt">${esc(item.icao)}</span>
      <span class="num">${esc(item.number || '—')}</span>
      <span class="ttl">${esc(c ? c.title : item.title)}${gone ? ' <em>not in installed charts</em>' : ''}</span>
    </button></div>`;
}

function airportRow(a, slot = '') {
  const st = cycleState(a);
  const w = slot ? wxOf(a.icao) : null;
  const cat = w?.metar && Date.now() - w.metar.obs < 3 * 3600e3 ? catBadge(w.metar.cat) : '';
  return `<button class="row apt-row" data-act="open-airport" data-icao="${esc(a.icao)}">
    ${slot ? `<span class="pill slot">${slot}</span>` : ''}
    <span class="apt-code">${esc(a.icao)}${a.iata ? `<small>${esc(a.iata)}</small>` : ''}</span>
    <span class="apt-name">${esc(a.name)}<small>${esc([a.city, a.country].filter(Boolean).join(', '))}</small></span>
    ${a.flags?.length ? '<span class="warnmark" title="Check this PDF">⚠</span>' : ''}
    ${cat}
    ${S.missing.has(a.icao) ? '<span class="pill red">FILE MISSING — re-import</span>' : ''}
    ${st === 'expired' ? '<span class="pill red">EXPIRED</span>' : st === 'future' ? '<span class="pill amber">NOT YET</span>' : ''}
  </button>`;
}

function topBar({ back, title, sub = '', right = '' }) {
  return `<header class="top">
    ${back ? `<button class="iconbtn" data-act="nav" data-to="${back}" aria-label="Back">‹</button>` : '<span class="logo">✈︎</span>'}
    <div class="top-title"><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    ${right}
    <button class="iconbtn" data-act="kneeboard" aria-label="Kneeboard">📝</button>
    <button class="iconbtn" data-act="nav" data-to="#/settings" aria-label="Settings and import">⚙︎</button>
  </header>`;
}

function expiredStrip() {
  const exp = [...S.airports.values()].filter((a) => cycleState(a) === 'expired');
  if (!exp.length) return '';
  return `<div class="strip red">EXPIRED charts: ${exp.map((a) => esc(a.icao)).join(', ')} — import the current cycle.</div>`;
}

// ================================================================ home

function renderHome() {
  leaveViewer();
  const mc = mainCycle();
  const q = S.homeQuery || '';
  const has = S.airports.size > 0;
  app.innerHTML = `
    ${topBar({ title: 'Charts', sub: mc ? cycleBadge(mc) + (mc.mixed ? ' <span class="pill amber">mixed cycles</span>' : '') : '<span class="cyc cyc-unknown">No charts imported</span>' })}
    ${expiredStrip()}
    ${flightBar()}
    <main class="scroll">
      ${has ? `<div class="searchbox"><input id="aptq" type="search" inputmode="search" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
        placeholder="Airport: ICAO, IATA, name or city" value="${esc(q)}"></div>
      <div id="homeres"></div>` : `
      <div class="empty">
        <h2>No charts yet</h2>
        <p>Tap <b>Import charts</b> and choose the airport PDFs (and <i>_charts_index.json</i> if you have it) from your <b>Charts</b> folder in the Files app. You can select many at once.</p>
        <button class="btn primary big" data-act="import">Import charts</button>
      </div>`}
    </main>`;
  if (has) {
    const inp = document.getElementById('aptq');
    inp.addEventListener('input', () => { S.homeQuery = inp.value; fillHomeResults(); });
    fillHomeResults();
  }
}

function searchAirports(q) {
  q = q.trim().toUpperCase();
  const words = q.split(/\s+/).filter(Boolean);
  const out = [];
  for (const a of S.airports.values()) {
    let score = 0;
    if (a.icao === q || a.iata === q) score = 100;
    else if (a.icao.startsWith(q)) score = 80;
    else if (a.iata && a.iata.startsWith(q)) score = 70;
    else {
      const hay = `${a.name} ${a.city} ${a.country}`.toUpperCase();
      if (words.every((w) => hay.includes(w))) score = hay.startsWith(words[0]) || hay.includes(' ' + words[0]) ? 50 : 40;
    }
    if (score) out.push([score, a]);
  }
  return out.sort((x, y) => y[0] - x[0] || x[1].icao.localeCompare(y[1].icao)).map((x) => x[1]);
}

function fillHomeResults() {
  const box = document.getElementById('homeres');
  if (!box) return;
  const q = (S.homeQuery || '').trim();
  if (q) {
    const res = searchAirports(q);
    box.innerHTML = res.length ? `<div class="list">${res.map(airportRow).join('')}</div>` : `<p class="muted pad">No airport matches “${esc(q)}”.</p>`;
    return;
  }
  const favs = S.kv.favorites;
  const allRec = S.kv.recents.filter((r) => S.airports.has(r.icao));
  const rec = S.allRecents ? allRec : allRec.slice(0, 5);
  const fl = SLOTS.map(([s, l]) => [l, S.airports.get(S.kv.flight[s])]).filter(([, a]) => a);
  if (fl.length && relayBase() && fl.some(([, a]) => !wxOf(a.icao) || Date.now() - wxOf(a.icao).fetched > WX_REFRESH)) {
    fetchWx(fl.map(([, a]) => a.icao)).then((ok) => { if (ok && location.hash.replace(/^#\/?/, '') === '') fillHomeResults(); });
  }
  const groups = new Map();
  for (const a of sortedAirports()) {
    const k = countryName(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const countries = [...groups.keys()].sort((x, y) => x.localeCompare(y));
  box.innerHTML = `
    ${fl.length ? `<h3 class="sec">This flight</h3><div class="list">${fl.map(([l, a]) => airportRow(a, l)).join('')}</div>` : ''}
    ${favs.length ? `<h3 class="sec">★ Favorites</h3><div class="list">${favs.map((f) => savedChartRow(f, 'fav')).join('')}</div>` : ''}
    ${rec.length ? `<h3 class="sec">Recent charts</h3><div class="list">${rec.map((r) => savedChartRow(r, 'recent')).join('')}
      ${allRec.length > 5 ? `<button class="row more-row" data-act="more-recents">${S.allRecents ? 'Show fewer' : `Show all ${allRec.length}`}</button>` : ''}</div>` : ''}
    ${countries.map((k) => `<h3 class="sec">${esc(k)} (${groups.get(k).length})</h3><div class="list">${groups.get(k).map((a) => airportRow(a)).join('')}</div>`).join('')}`;
}

// ================================================================ airport

function carryCandidates(a) {
  const out = [];
  for (const m of S.ann.values()) {
    if (m.icao !== a.icao || m.cycle === a.cycle || !m.n) continue;
    const base = m.key.split('@')[0];
    const c = findChart(a, base);
    if (!c || !c.rev || !m.rev || c.rev !== m.rev) continue;
    const pidx = +(m.key.split('@')[1] || 0);
    if (S.ann.get(annId(a, base, pidx))?.n) continue; // already has notes this cycle
    out.push(m);
  }
  // keep only the newest older cycle per chart
  const best = new Map();
  for (const m of out) { const b = best.get(m.key); if (!b || m.cycle > b.cycle) best.set(m.key, m); }
  return [...best.values()];
}

async function carryOver(a, list) {
  for (const m of list) {
    const r = await store.get('annotations', m.id);
    if (!r) continue;
    const base = m.key.split('@')[0], pidx = +(m.key.split('@')[1] || 0);
    const id = annId(a, base, pidx);
    const nr = { ...r, id, cycle: a.cycle, carriedFrom: r.cycle, updated: Date.now() };
    await store.put('annotations', nr);
    S.ann.set(id, { id, icao: a.icao, key: m.key, cycle: a.cycle, rev: r.rev, n: r.strokes.length });
  }
}

function renderAirport(icao, tab) {
  leaveViewer();
  const a = S.airports.get(icao);
  if (!a) { go('#/', true); return; }
  if (!TABS.some((t) => t.id === tab)) tab = S.kv.last[icao]?.tab || (a.charts.some((c) => tabOf(c.cat) === 'INFO') ? 'INFO' : 'OTHER');
  const q = S.aptQuery?.icao === icao ? S.aptQuery.q : '';
  const f = S.kv.flight;
  const carry = carryCandidates(a);
  app.innerHTML = `
    ${topBar({ back: '#/', title: `${esc(a.icao)}${a.iata ? ` <span class="iata">${esc(a.iata)}</span>` : ''} ${esc(a.name)}`, sub: `${esc([a.city, a.country].filter(Boolean).join(', '))} ${cycleBadge(a)}` })}
    ${cycleState(a) === 'expired' ? `<div class="strip red">EXPIRED — cycle ${esc(a.cycle)} ended ${fmtDate(a.validTo)}. Import the current cycle.</div>` : ''}
    ${a.flags?.length ? `<div class="strip amber">⚠ ${a.flags.map(esc).join('<br>⚠ ')}</div>` : ''}
    ${flightBar(icao)}
    <div class="apt-tools">
      <div class="seg small">${SLOTS.map(([s, l]) => `<button class="${f[s] === icao ? 'on' : ''}" data-act="set-slot" data-slot="${s}" data-icao="${esc(icao)}">${f[s] === icao ? '✓ ' : ''}${l}</button>`).join('')}</div>
      <div class="searchbox inline"><input id="chq" type="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Find chart, e.g. ILS 03" value="${esc(q)}"></div>
    </div>
    ${carry.length ? `<div class="strip blue">${carry.length} chart${carry.length > 1 ? 's' : ''} with your notes from cycle ${esc(carry[0].cycle)} did not change. <button class="btn small" data-act="carry" data-icao="${esc(icao)}">Bring notes over</button></div>` : ''}
    <nav class="tabs">${TABS.map((t) => {
      const n = chartsShown(a, t.id).length;
      return `<button class="tab ${t.id === tab ? 'on' : ''} ${n ? '' : 'none'}" data-act="nav" data-replace="1" data-to="#/a/${esc(icao)}/${t.id}">${t.label}<small>${n}</small></button>`;
    }).join('')}</nav>
    ${rwyBar(a)}
    <div id="wxbox">${wxStrip(a)}</div>
    <main class="scroll" id="chartlist"></main>`;
  autoWx(a);
  const inp = document.getElementById('chq');
  const fill = () => {
    const box = document.getElementById('chartlist');
    const qq = inp.value.trim().toUpperCase();
    S.aptQuery = { icao, q: inp.value };
    if (qq) {
      const words = qq.split(/\s+/);
      const res = a.charts.filter((c) => {
        const hay = `${c.number} ${c.title} ${tabLabel(tabOf(c.cat))}`.toUpperCase();
        return words.every((w) => hay.includes(w));
      });
      res.sort((x, y) => TABS.findIndex((t) => t.id === tabOf(x.cat)) - TABS.findIndex((t) => t.id === tabOf(y.cat)) || compareNumbers(x.number, y.number));
      box.innerHTML = res.length ? `<div class="list">${res.map((c) => chartRow(a, c, tabOf(c.cat), true)).join('')}</div>` : `<p class="muted pad">No chart matches “${esc(inp.value)}”.</p>`;
    } else {
      const list = chartsShown(a, tab);
      const f = rwyFilter(a);
      box.innerHTML = (tab === 'INFO' ? airportInfoCard(a) : '') + (list.length
        ? `<div class="list">${list.map((c) => chartRow(a, c, tab)).join('')}</div>`
        : `<p class="muted pad">No ${esc(tabLabel(tab))} charts for ${esc(icao)}${f ? ` runway ${esc(f)}` : ''}.</p>`);
    }
  };
  inp.addEventListener('input', fill);
  fill();
  S.kv.last[icao] = { ...(S.kv.last[icao] || {}), tab };
  setKv('last', S.kv.last);
}

// ---------------------------------------------------------------- weather (METAR / TAF)
// Fetched through your own relay (see README), cached on the iPad so the last
// report stays readable offline, always shown with its age.

const WX_REFRESH = 10 * 60e3;
const wxOf = (icao) => (S.kv.wx || {})[icao];
const relayBase = () => (S.kv.wxRelay || '').trim().replace(/\/+$/, '');
let wxBusy = false;

async function fetchWx(icaos) {
  const base = relayBase();
  const ids = [...new Set(icaos.filter(Boolean))];
  if (!base || !ids.length || !navigator.onLine || wxBusy) return false;
  wxBusy = true;
  try {
    const get = (k) => fetch(`${base}/${k}?ids=${ids.join(',')}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [m, t] = await Promise.all([get('metar'), get('taf')]);
    if (!Array.isArray(m) && !Array.isArray(t)) return false;
    const wx = { ...(S.kv.wx || {}) };
    const now = Date.now();
    for (const id of ids) {
      const ms = (m || []).filter((x) => x.icaoId === id).sort((a, b) => b.obsTime - a.obsTime);
      const ts = (t || []).filter((x) => x.icaoId === id).sort((a, b) => Date.parse(b.issueTime) - Date.parse(a.issueTime));
      const old = wx[id] || {};
      wx[id] = {
        metar: ms[0] ? { raw: ms[0].rawOb, cat: ms[0].fltCat || '', obs: ms[0].obsTime * 1000 } : (Array.isArray(m) ? null : old.metar || null),
        taf: ts[0] ? { raw: ts[0].rawTAF, issued: Date.parse(ts[0].issueTime) } : (Array.isArray(t) ? null : old.taf || null),
        fetched: now,
      };
    }
    setKv('wx', wx);
    return true;
  } finally {
    wxBusy = false;
  }
}

function ageText(ts) {
  const min = Math.round((Date.now() - ts) / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min ago`;
}

const catBadge = (cat) => (cat ? `<span class="fcat fcat-${esc(cat)}">${esc(cat)}</span>` : '');

function tafLines(raw) {
  return esc(raw).replace(/\s(FM\d{6}|TEMPO|BECMG|PROB\d{2}(?:\sTEMPO)?)\b/g, '<br>&nbsp;&nbsp;$1');
}

function wxStrip(a) {
  const w = wxOf(a.icao);
  if (!relayBase()) {
    return w?.metar ? '' : `<div class="wx wx-setup"><span>Weather: one-time setup in ⚙︎ to show METAR / TAF here.</span></div>`;
  }
  if (!w) return `<div class="wx muted">${navigator.onLine ? 'Getting weather…' : 'No weather saved for this airport (offline).'}</div>`;
  const m = w.metar;
  const age = m ? (Date.now() - m.obs) / 60e3 : 0;
  const ageCls = age > 180 ? 'old' : age > 75 ? 'stale' : '';
  const open = S.wxOpen === a.icao;
  return `<div class="wx">
    <button class="wx-main" data-act="wx-toggle" data-icao="${esc(a.icao)}">
      ${m ? `${catBadge(m.cat)}<span class="wxraw">${esc(m.raw)}</span>` : `<span class="wxraw muted">No METAR from ${esc(a.icao)} in the last 3 hours.</span>`}
    </button>
    <div class="wx-side">
      ${m ? `<span class="wxage ${ageCls}">${ageText(m.obs)}${navigator.onLine ? '' : ' · offline'}</span>` : ''}
      <button class="iconbtn small" data-act="wx-refresh" data-icao="${esc(a.icao)}" aria-label="Refresh weather">↻</button>
    </div>
    ${open ? `<div class="wx-taf">${w.taf ? `<small>TAF · issued ${ageText(w.taf.issued)}</small><div class="wxraw">${tafLines(w.taf.raw)}</div>` : '<small>No TAF for this airport.</small>'}</div>` : (w.taf ? '<small class="wx-hint">Tap for TAF</small>' : '')}
  </div>`;
}

function refreshWxBox(a) {
  const box = document.getElementById('wxbox');
  if (box) box.innerHTML = wxStrip(a);
}

/** Refresh in the background if the saved report is older than 10 minutes. */
async function autoWx(a) {
  const w = wxOf(a.icao);
  if (w && Date.now() - w.fetched < WX_REFRESH) return;
  const f = S.kv.flight;
  if (await fetchWx([a.icao, f.dep, f.arr, f.alt])) refreshWxBox(a);
  else if (!w) refreshWxBox(a);
}

function rwyBar(a) {
  const rws = airportRunways(a);
  if (!rws.length) return '';
  const f = rwyFilter(a);
  const b = (r, label) => `<button class="rchip ${f === r ? 'on' : ''}" data-act="rwy" data-icao="${esc(a.icao)}" data-r="${esc(r)}">${esc(label)}</button>`;
  return `<div class="rwybar"><span class="rwylbl">RWY</span>${b('', 'All')}${rws.map((r) => b(r, r)).join('')}</div>`;
}

function fmtLatLon(v, pos, neg, w) {
  if (v == null) return '';
  const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
  return `${v < 0 ? neg : pos}${String(d).padStart(w, '0')}°${m.toFixed(1).padStart(4, '0')}'`;
}
function utcText(u) {
  // Jeppesen "+5:00=UTC" means local time + 5 h = UTC, i.e. UTC−5.
  const m = /^([+-])(\d+):(\d+)/.exec(u || '');
  if (!m) return '';
  return `UTC${m[1] === '+' ? '−' : '+'}${+m[2]}${m[3] !== '00' ? ':' + m[3] : ''}`;
}
const CAT = { 1: 'CAT I', 2: 'CAT II', 3: 'CAT III' };

function airportInfoCard(a) {
  const i = a.info;
  if (!i) return '';
  const tl = i.tl && i.tl !== '-1' ? i.tl : '—';
  const mv = /^([EW])0*(\d+(?:\.\d)?)/.exec(i.magvar || '');
  const facts = [
    ['Elevation', i.elev ? `${Number(i.elev).toLocaleString('en-US')} ft` : ''],
    ['Trans. alt / level', `${i.ta ? Number(i.ta).toLocaleString('en-US') + ' ft' : '—'} / ${tl}`],
    ['Mag. variation', mv ? `${parseFloat(mv[2])}° ${mv[1]}` : ''],
    ['Time', utcText(i.utc)],
    ['Position', `${fmtLatLon(i.lat, 'N', 'S', 2)} ${fmtLatLon(i.lon, 'E', 'W', 3)}`],
  ].filter(([, v]) => v && v.trim());
  const rws = (i.runways || []).map((r) => {
    const extra = [];
    for (const e of r.ends || []) {
      if (e.ils) extra.push(`ILS ${e.id} <b>${esc(e.ils)}</b>${CAT[e.ils_cat] ? ' ' + CAT[e.ils_cat] : ''}`);
      if (e.displaced_ft) extra.push(`${e.id} displaced thr. ${e.displaced_ft.toLocaleString('en-US')} ft`);
    }
    return `<div class="rwyline"><b class="rwyid">${r.ids.map(esc).join(' / ')}</b>
      <span>${r.length_ft ? `≈ ${r.length_ft.toLocaleString('en-US')} ft · ${r.length_m.toLocaleString('en-US')} m` : ''}</span>
      ${extra.length ? `<small>${extra.join(' · ')}</small>` : ''}</div>`;
  }).join('');
  return `<section class="infocard">
    <div class="facts">${facts.map(([k, v]) => `<div><small>${k}</small><b>${esc(v)}</b></div>`).join('')}</div>
    ${rws ? `<div class="rwys"><small class="lbl">Runways</small>${rws}</div>` : ''}
    <p class="note">From this cycle's nav data. Lengths are approximate; declared distances and frequencies are on the 10-9.</p>
  </section>`;
}

// ================================================================ viewer

let viewer = null;
let wakeLock = null;
let saveTimer = null;
let pendingSave = null;

async function setWake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const w = wakeLock; wakeLock = null; await w.release();
    }
  } catch (e) { console.warn('wake lock', e); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.view === 'viewer') setWake(true);
  if (document.visibilityState === 'hidden') flushSave();
  gpsRun(document.visibilityState === 'visible' && S.view === 'viewer' && S.viewerMode === 'chart');
});

function leaveViewer() {
  if (S.view !== 'viewer') { S.view = 'other'; return; }
  flushSave();
  viewer?.destroy();
  viewer = null;
  S.view = 'other';
  setWake(false);
  gpsRun(false);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (pendingSave) { const p = pendingSave; pendingSave = null; p(); }
}

function sequence(a, tab) {
  const seq = [];
  for (const c of chartsShown(a, tab)) for (let i = 0; i < (c.pages || 1); i++) seq.push([c, i]);
  return seq;
}

function toolState() { return S.kv.tool; }

function viewerShell(mode = 'chart') {
  S.viewerMode = mode;
  const chartBtns = `
      <button class="iconbtn gpsbtn ${S.kv.gps ? 'on' : ''}" data-act="gps" id="vgps" aria-label="Show my GPS position">➤</button>
      <button class="iconbtn" data-act="kneeboard" aria-label="Kneeboard">📝</button>
      <button class="iconbtn" data-act="v-fav" id="vfav" aria-label="Favorite">☆</button>
      <button class="iconbtn" data-act="v-rotate" aria-label="Rotate">⟳</button>`;
  const noteBtns = `
      <button class="iconbtn" data-act="note-new-same" aria-label="New page">＋</button>`;
  app.innerHTML = `
  <div class="viewer ${S.kv.chartNight ? 'chart-night' : ''} ${mode === 'note' ? 'note-mode' : ''}">
    <header class="vbar">
      <button class="iconbtn" data-act="v-back" aria-label="Back">‹</button>
      <div class="vpills" id="vpills"></div>
      <div class="vtitle" id="vtitle"></div>
      ${mode === 'note' ? noteBtns : chartBtns}
      <button class="iconbtn ${S.kv.chartNight ? 'on' : ''}" data-act="v-night" id="vnight" aria-label="Night mode">☾</button>
      <label class="dimctl" aria-label="Brightness">☀︎<input type="range" id="vdim" min="0.25" max="1" step="0.05" value="${S.kv.dim}"></label>
    </header>
    <div class="vstage-wrap">
      <div class="vstage" id="vstage"></div>
      <div class="vdim" id="vdimlayer"></div>
      <div class="vbanners" id="vbanners"></div>
      <div class="vgps" id="vgpsbar"></div>
      <div class="vloading" id="vloading">Loading…</div>
    </div>
    <footer class="vtools" id="vtools"></footer>
  </div>`;
  const dim = document.getElementById('vdim');
  dim.addEventListener('input', () => { S.kv.dim = +dim.value; applyDim(); });
  dim.addEventListener('change', () => setKv('dim', +dim.value));
  applyDim();
  renderTools();
}

function applyDim() {
  const l = document.getElementById('vdimlayer');
  if (l) l.style.opacity = String(1 - S.kv.dim);
}

function renderTools() {
  const box = document.getElementById('vtools');
  if (!box) return;
  const t = S.kv.tool;
  const b = (act, label, on, extra = '', title = '') => `<button class="tbtn ${on ? 'on' : ''}" data-act="${act}" ${extra} title="${title}">${label}</button>`;
  box.innerHTML = `
    <span class="tlabel">✎ Pencil</span>
    ${b('tool', '<i class="dot red"></i>', t.kind === 'pen' && t.color === 'red', 'data-kind="pen" data-color="red"', 'Red pen')}
    ${b('tool', '<i class="dot blue"></i>', t.kind === 'pen' && t.color === 'blue', 'data-kind="pen" data-color="blue"', 'Blue pen')}
    ${b('tool', '<i class="dot black"></i>', t.kind === 'pen' && t.color === 'black', 'data-kind="pen" data-color="black"', 'Black pen')}
    ${b('tool-width', t.width === 'thick' ? '<i class="ln thick"></i>' : '<i class="ln"></i>', false, '', 'Pen width')}
    ${b('tool', '<i class="hl"></i>', t.kind === 'highlighter', 'data-kind="highlighter"', 'Highlighter')}
    ${b('tool', '⌫', t.kind === 'eraser', 'data-kind="eraser"', 'Eraser')}
    ${b('tool', 'Off', t.kind === 'off', 'data-kind="off"', 'Pencil does not draw')}
    <span class="tsp"></span>
    ${b('ink-undo', '↶ Undo', false)}
    ${b('ink-clear', 'Clear', false)}
    <span class="tsp"></span>
    <button class="tbtn" data-act="v-step" data-dir="-1" aria-label="Previous chart">‹</button>
    <span class="vpos" id="vpos">${esc(S.posText || '')}</span>
    <button class="tbtn" data-act="v-step" data-dir="1" aria-label="Next chart">›</button>`;
}

async function renderViewer(icao, tab, key, pidx) {
  const a = S.airports.get(icao);
  const c = findChart(a, key);
  if (!a || !c) { go(a ? `#/a/${icao}` : '#/', true); return; }
  if (!TABS.some((t) => t.id === tab)) tab = tabOf(c.cat);
  pidx = Math.max(0, Math.min((c.pages || 1) - 1, +pidx || 0));

  ensureViewer('chart');
  const cur = { kind: 'chart', icao, tab, key, pidx, a, c };
  S.cur = cur;

  // header
  fillPills(icao);
  document.getElementById('vtitle').innerHTML = `<b>${esc(a.icao)} ${esc(c.number)}</b> ${esc(c.title)}${c.pages > 1 ? ` <small>(page ${pidx + 1}/${c.pages})</small>` : ''}<div class="sub">${cycleBadge(a)}</div>`;
  const fav = isFav(icao, key);
  const vf = document.getElementById('vfav');
  vf.textContent = fav ? '★' : '☆'; vf.classList.toggle('on', fav);
  const seq = sequence(a, tab);
  const pos = seq.findIndex(([x, i]) => x.key === key && i === pidx);
  S.posText = `${tabLabel(tab)} ${pos + 1}/${seq.length}`;
  document.getElementById('vpos').textContent = S.posText;

  // safety banners
  const st = cycleState(a);
  let bn = '';
  if (st === 'expired') bn += `<div class="vban red">EXPIRED<small>Cycle ${esc(a.cycle)} ended ${fmtDate(a.validTo)} — not for navigation</small></div>`;
  else if (st === 'future') bn += `<div class="vban amber">NOT YET EFFECTIVE<small>Cycle ${esc(a.cycle)} starts ${fmtDate(a.validFrom)}</small></div>`;
  else if (st === 'unknown') bn += `<div class="vban grey">CYCLE UNKNOWN<small>Check currency before use</small></div>`;
  if (c.unindexed || !a.charts.some((x) => !x.unindexed)) bn += `<div class="vban amber small">⚠ Page without bookmark — verify chart identity</div>`;
  document.getElementById('vbanners').innerHTML = bn;

  // remember
  S.kv.last[icao] = { tab, key, pidx };
  setKv('last', S.kv.last);
  const rec = [{ icao, key, number: c.number, title: c.title, at: Date.now() }, ...S.kv.recents.filter((r) => !(r.icao === icao && r.key === key))].slice(0, 20);
  setKv('recents', rec);

  // load and show the page
  viewer.clear();
  const loading = document.getElementById('vloading');
  loading.style.display = 'block';
  loading.textContent = 'Loading…';
  try {
    const doc = await getDoc(a);
    if (S.cur !== cur) return;
    const page = await doc.getPage(c.page + pidx);
    if (S.cur !== cur) return;
    const ann = await store.get('annotations', annId(a, key, pidx));
    if (S.cur !== cur) return;
    const rot = S.kv.rotation[`${icao}|${key}`] ? 90 : 0;
    await viewer.show(page, { rotation: rot, strokes: ann?.strokes || [] });
    if (S.cur === cur) loading.style.display = 'none';
    cur.page = page;
    gps.magvar = parseMagvar(a.info?.magvar);
    gps.compassOffset = S.kv.compassOffset || 0;
    if (S.kv.gps) chartGeo(cur).then(updateOwn);
    updateOwn();
    // pre-load the next chart's page so swiping is quick
    const nx = seq[pos + 1];
    if (nx) doc.getPage(nx[0].page + nx[1]).catch(() => {});
  } catch (e) {
    console.error(e);
    loading.textContent = 'Could not open this chart: ' + (e.message || e);
  }
}

// ---------------------------------------------------------------- GPS on charts
// Situational awareness only. The icon only appears on charts whose plan view
// passed the georeference checks (see georef.js), inside that plan view.

const gps = new Gps(() => updateOwn());
const geoCache = new Map(); // "file#page" -> Promise<georef result>

function chartGeo(cur) {
  if (cur.kind !== 'chart' || !cur.page) return Promise.resolve(null);
  if (cur.geo) return Promise.resolve(cur.geo);
  const key = `${cur.a.file}#${cur.c.page + cur.pidx}`;
  let p = geoCache.get(key);
  if (!p) {
    const page = cur.page;
    p = (async () => {
      try {
        const [tc, ol] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
        return georefFromText(tc.items, cur.a.info, linesFromOps(ol, pdfjsLib.OPS), !!cur.a.aspectFixed);
      } catch (e) { return { ok: false, reason: 'could not read chart' }; }
    })();
    geoCache.set(key, p);
  }
  return p.then((g) => { cur.geo = g; return g; });
}

const R = 6371008.8;
function distBrg(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, p1 = lat1 * r, p2 = lat2 * r, dl = (lon2 - lon1) * r;
  const d = 2 * R * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
  const b = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / r;
  return [d / 1852, (b + 360) % 360];
}
const deg3 = (v) => String(Math.round(v) % 360 || 360).padStart(3, '0');

function gpsStatus(text, cls = '') {
  const bar = document.getElementById('vgpsbar');
  if (!bar) return;
  bar.className = `vgps ${text ? 'show' : ''} ${cls}`;
  bar.innerHTML = text ? `${text}<small>GPS · situational awareness only</small>` : '';
}

function updateOwn() {
  const cur = S.cur;
  if (!viewer || S.view !== 'viewer') return;
  if (!S.kv.gps || cur?.kind !== 'chart') { viewer.setOwnship(null); gpsStatus(''); return; }
  const g = cur.geo;
  const f = gps.fix;
  if (!cur.page || g === undefined) { viewer.setOwnship(null); gpsStatus('Checking this chart…'); return; }
  if (!g || !g.ok) { viewer.setOwnship(null); gpsStatus(`Position not available on this chart${g?.reason ? ` (${esc(g.reason)})` : ''}`, 'muted'); return; }
  if (!f) { viewer.setOwnship(null); gpsStatus(esc(gps.error || 'Waiting for GPS…'), gps.error ? 'warn' : 'muted'); return; }
  if (f.acc > 1000) { viewer.setOwnship(null); gpsStatus(`GPS signal too weak (±${Math.round(f.acc)} m)`, 'warn'); return; }
  const p = toChart(g, f.lat, f.lon);
  if (!p.inside) {
    viewer.setOwnship(null);
    const i = cur.a.info;
    const [d, b] = i?.lat != null ? distBrg(f.lat, f.lon, i.lat, i.lon) : [null, null];
    gpsStatus(`You're outside this chart${d != null ? ` · ${esc(cur.a.icao)} ${d < 10 ? d.toFixed(1) : Math.round(d)} nm, ${deg3(b)}°` : ''}`, 'muted');
    return;
  }
  // PDF point -> page units of the viewer (unrotated page), heading as an angle on the page
  const v0 = cur.page.getViewport({ scale: 1, rotation: cur.page.rotate });
  const [x, y] = v0.convertToViewportPoint(p.x, p.y);
  let hdg = null;
  if (gps.heading != null) {
    // a point 200 m ahead, so the chart's slight sideways stretch is accounted for
    const h = gps.heading * Math.PI / 180, dm = 200;
    const lat2 = f.lat + (dm * Math.cos(h)) / 111320;
    const lon2 = f.lon + (dm * Math.sin(h)) / (111320 * Math.cos(f.lat * Math.PI / 180));
    const q = toChart(g, lat2, lon2);
    const [x2, y2] = v0.convertToViewportPoint(q.x, q.y);
    hdg = Math.atan2(x2 - x, -(y2 - y)) * 180 / Math.PI;
  }
  const acc = f.acc * g.ay / 1852; // metres -> page units (ay = points per minute of latitude)
  viewer.setOwnship({ x, y, hdg, acc, weak: f.acc > 100 });
  const src = gps.headingSource === 'compass' ? ' (compass)' : gps.headingSource === 'blend' ? ' (blend)' : '';
  gpsStatus(`±${Math.round(f.acc)} m · ${Math.round(f.kt)} kt${gps.heading != null ? ` · ${deg3(gps.heading)}°T${src}` : ''}`, f.acc > 100 ? 'warn' : '');
}

function gpsRun(on) {
  if (on && S.kv.gps && document.visibilityState === 'visible') gps.start();
  else gps.stop();
}

function ensureViewer(mode) {
  if (S.view === 'viewer' && viewer && S.viewerMode === mode) { flushSave(); return; }
  leaveViewer();
  viewerShell(mode);
  S.view = 'viewer';
  gpsRun(mode === 'chart');
  viewer = new ChartViewer(document.getElementById('vstage'), {
    onSwipe: (dir) => stepChart(dir),
    onInkChange: (strokes) => queueSave(strokes),
    getTool: toolState,
    onRenderError: (msg) => { if (!S.renderErrShown) { S.renderErrShown = true; toast(`Display problem: ${msg}`); } },
  });
  setWake(true);
}

function fillPills(icao) {
  document.getElementById('vpills').innerHTML = SLOTS.map(([s, l]) => {
    const x = S.kv.flight[s];
    return x ? `<button class="vpill ${x === icao ? 'on' : ''}" data-act="flight" data-slot="${s}"><small>${l}</small>${esc(x)}</button>` : '';
  }).join('');
}

// ================================================================ kneeboard (note pages)
// Digital paper: one list of pages, newest first, each made from a template.
// Pages are saved as you write and stay until you delete them.

const notesInOrder = () => [...S.notes.values()].sort((a, b) => b.created - a.created);

function noteTitle(tid) {
  const d = new Date();
  return `${templateById(tid).name} · ${d.getDate()} ${MON[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function newNote(tid, replace = false) {
  const now = Date.now();
  const n = { id: `n${now}`, title: noteTitle(tid), template: tid, created: now, updated: now, strokes: [] };
  await store.put('notes', n);
  S.notes.set(n.id, n);
  go(`#/n/${n.id}`, replace);
}

function renderNotes() {
  leaveViewer();
  const list = notesInOrder();
  app.innerHTML = `
    ${topBar({ back: '#/', title: 'Kneeboard', sub: `${list.length} page${list.length === 1 ? '' : 's'}` })}
    ${flightBar()}
    <main class="scroll">
      <h3 class="sec">New page</h3>
      <div class="tpl-grid">${TEMPLATES.map((t) => `
        <button class="tpl" data-act="note-new" data-tpl="${t.id}"><span class="tpl-ic">${t.icon}</span>${esc(t.name)}</button>`).join('')}
      </div>
      ${list.length ? `<h3 class="sec">Pages</h3><div class="list">${list.map((n) => `
        <div class="row chart-row">
          <span class="star-sp tpl-mini">${templateById(n.template).icon}</span>
          <button class="row-main" data-act="nav" data-to="#/n/${n.id}">
            <span class="ttl">${esc(n.title)}<em>${n.strokes.length ? `${n.strokes.length} stroke${n.strokes.length === 1 ? '' : 's'} · ` : 'empty · '}edited ${fmtWhen(n.updated)}</em></span>
          </button>
          <button class="star" data-act="note-del" data-id="${n.id}" aria-label="Delete page">🗑</button>
        </div>`).join('')}</div>` : '<p class="muted pad">No pages yet. Pick a template above.</p>'}
    </main>`;
}

async function renderNote(id) {
  const n = S.notes.get(id);
  if (!n) { go('#/notes', true); return; }
  ensureViewer('note');
  const cur = { kind: 'note', id, n };
  S.cur = cur;
  setKv('lastNote', id);
  fillPills('');
  document.getElementById('vtitle').innerHTML = `<button class="titlebtn" data-act="note-rename"><b>${esc(n.title)}</b> ✎</button><div class="sub">${esc(templateById(n.template).name)}</div>`;
  const list = notesInOrder();
  const pos = list.findIndex((x) => x.id === id);
  S.posText = `Page ${pos + 1}/${list.length}`;
  document.getElementById('vpos').textContent = S.posText;
  document.getElementById('vbanners').innerHTML = '';
  document.getElementById('vloading').style.display = 'none';
  await viewer.show(makeNotePage(n.template), { strokes: n.strokes || [] });
}

function queueSave(strokes) {
  const cur = S.cur;
  if (!cur) return;
  if (cur.kind === 'note') {
    const n = cur.n;
    const snapshot = strokes.slice();
    pendingSave = async () => {
      n.strokes = snapshot;
      n.updated = Date.now();
      await store.put('notes', n);
    };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 600);
    return;
  }
  const { a, key, pidx, c } = cur;
  const id = annId(a, key, pidx);
  const snapshot = strokes.slice();
  pendingSave = async () => {
    const mkey = key + (pidx ? '@' + pidx : '');
    if (snapshot.length) {
      await store.put('annotations', { id, icao: a.icao, key: mkey, cycle: a.cycle, rev: c.rev || '', strokes: snapshot, updated: Date.now() });
      S.ann.set(id, { id, icao: a.icao, key: mkey, cycle: a.cycle, rev: c.rev || '', n: snapshot.length });
    } else {
      await store.del('annotations', id);
      S.ann.delete(id);
    }
  };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

function stepChart(dir) {
  const cur = S.cur;
  if (!cur) return;
  if (cur.kind === 'note') {
    const list = notesInOrder();
    const nx = list[list.findIndex((x) => x.id === cur.id) + dir];
    if (!nx) { toast(dir > 0 ? 'Last page' : 'First page'); return; }
    go(`#/n/${nx.id}`, true);
    return;
  }
  const seq = sequence(cur.a, cur.tab);
  const pos = seq.findIndex(([x, i]) => x.key === cur.key && i === cur.pidx);
  const nx = seq[pos + dir];
  if (!nx) { toast(dir > 0 ? `Last chart in ${tabLabel(cur.tab)}` : `First chart in ${tabLabel(cur.tab)}`); return; }
  go(chartHash(cur.icao, cur.tab, nx[0].key, nx[1]), true);
}

// ================================================================ settings / import

async function renderSettings() {
  leaveViewer();
  const mc = mainCycle();
  const swOk = !!navigator.serviceWorker?.controller;
  app.innerHTML = `
    ${topBar({ back: '#/', title: 'Import & settings' })}
    <main class="scroll pad">
      <section class="card">
        <button class="btn primary big" data-act="import">Import charts…</button>
        <p class="muted">Choose airport PDFs (and optionally <i>_charts_index.json</i>) from your Charts folder. You can pick many at once. Re-importing an airport replaces it.</p>
      </section>
      <section class="card">
        <h3>Charts on this iPad</h3>
        <p>${mc ? `${cycleBadge(mc)}${mc.mixed ? ' <span class="pill amber">airports are on different cycles</span>' : ''}` : 'None imported yet.'}</p>
        <p id="storage" class="muted">Storage: checking…</p>
        <p class="muted">${swOk ? '✓ Ready for offline use.' : '… Offline copy not ready yet — open the app once more while online.'}</p>
      </section>
      <section class="card">
        <h3>Weather (METAR / TAF)</h3>
        <p class="muted">Paste the address of your weather relay (README → "Weather setup"). Only airport codes are sent. The last report is kept for offline use and always shows its age.</p>
        <label class="field"><input id="wx-relay" value="${esc(S.kv.wxRelay)}" placeholder="https://chartviewer-wx.yourname.workers.dev" style="text-transform:none" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url"></label>
        <button class="btn primary" data-act="wx-save">Save & test</button>
        <span id="wx-test" class="muted"></span>
      </section>
      <section class="card">
        <h3>GPS</h3>
        <p class="muted">The ➤ button on a chart shows your position (situational awareness only). If the plane points the wrong way when you're stopped, the compass needs a correction:</p>
        <div class="seg">${[[0, 'None'], [90, '+90°'], [180, '180°'], [-90, '−90°']].map(([v, l]) => `<button class="${(S.kv.compassOffset || 0) === v ? 'on' : ''}" data-act="compass-offset" data-v="${v}">${l}</button>`).join('')}</div>
      </section>
      <section class="card">
        <h3>Menus</h3>
        <div class="seg">${[['auto', 'Auto'], ['day', 'Day'], ['night', 'Night']].map(([v, l]) => `<button class="${S.kv.theme === v ? 'on' : ''}" data-act="theme" data-v="${v}">${l}</button>`).join('')}</div>
      </section>
      <section class="card">
        <h3>Airports (${S.airports.size})</h3>
        <div class="tablewrap"><table class="apts">
          <tr><th>Airport</th><th>Cycle</th><th>Imported</th><th>Size</th><th></th></tr>
          ${sortedAirports().map((a) => `<tr>
            <td><b>${esc(a.icao)}</b> ${esc(a.iata || '')}<br><small>${esc(a.name)}</small>${S.missing.has(a.icao) ? '<br><small class="err">⚠ Chart file missing on this iPad — import it again</small>' : ''}${a.flags?.length ? `<br><small class="warn">⚠ ${a.flags.map(esc).join('<br>⚠ ')}</small>` : ''}</td>
            <td>${cycleBadge(a)}</td>
            <td><small>${fmtWhen(a.importedAt)}</small></td>
            <td><small>${fmtBytes(a.size)}<br>${a.charts.length} charts</small></td>
            <td><button class="btn small danger" data-act="del-airport" data-icao="${esc(a.icao)}">Delete</button></td>
          </tr>`).join('')}
        </table></div>
      </section>
      <section class="card">
        <h3>Backup of your notes</h3>
        <p class="muted">Chart notes, kneeboard pages, favorites and settings in one small file (no charts). In the share sheet choose <b>Save to Files → On My iPad</b> (or anywhere you like). Restore it if the app's storage is ever cleared.</p>
        <button class="btn primary" data-act="backup">Save backup…</button>
        <button class="btn" data-act="restore">Restore backup…</button>
        <p class="muted">Last backup: ${S.kv.lastBackup ? fmtWhen(S.kv.lastBackup) : 'never'}</p>
      </section>
      <section class="card">
        <h3>Clean up</h3>
        <button class="btn" data-act="del-old-notes">Delete notes from old cycles</button>
        <button class="btn danger" data-act="del-all">Delete all charts</button>
      </section>
      <section class="card muted">
        <p>Chart Viewer ${APP_VERSION}. Your charts and notes are stored only on this iPad and are never uploaded. Not an approved EFB — always check you have current charts.</p>
      </section>
    </main>`;
  const si = await store.storageInfo();
  const el = document.getElementById('storage');
  if (el) el.textContent = `Storage used: ${fmtBytes(si.usage)}${si.quota ? ` of ${fmtBytes(si.quota)} available` : ''} · ${si.persisted ? 'protected from automatic clean-up ✓' : 'not protected (add the app to the Home Screen)'}`;
}

function pickFiles() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = '.pdf,application/pdf,.json,application/json';
  inp.style.display = 'none';
  inp.addEventListener('change', () => { const files = [...inp.files]; inp.remove(); if (files.length) importFiles(files); });
  document.body.append(inp);
  inp.click();
}

async function importFiles(files) {
  const jsons = files.filter((f) => /\.json$/i.test(f.name));
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const skipped = files.filter((f) => !jsons.includes(f) && !pdfs.includes(f));
  const prog = document.createElement('div');
  prog.className = 'modal';
  prog.innerHTML = '<div class="sheet"><h2>Importing…</h2><p id="progtxt"></p><div class="bar"><i id="progbar"></i></div></div>';
  document.body.append(prog);
  const say = (t, f) => { prog.querySelector('#progtxt').textContent = t; prog.querySelector('#progbar').style.width = `${Math.round(f * 100)}%`; };
  await store.askPersist();

  const res = { ok: [], failed: [], flagged: [], older: [], carry: [] };
  let backups = 0;
  for (const f of jsons) {
    try {
      const idx = JSON.parse(await f.text());
      if (isBackup(idx)) { prog.remove(); await restoreBackup(idx); backups++; continue; }
      if (!Array.isArray(idx.airports)) throw new Error('not a charts index');
      const old = S.kv.index && Array.isArray(S.kv.index.airports) ? S.kv.index.airports : [];
      const map = new Map(old.map((x) => [x.icao, x]));
      for (const x of idx.airports) map.set(x.icao, { cycle: idx.cycle, valid_from: idx.valid_from, valid_to: idx.valid_to, ...x });
      const merged = { cycle: idx.cycle, valid_from: idx.valid_from, valid_to: idx.valid_to, airports: [...map.values()] };
      setKv('index', merged);
      for (const a of S.airports.values()) if (enrichFromIndex(a, merged)) await store.put('airports', a);
    } catch (e) { res.failed.push(`${f.name}: ${e.message || e}`); }
  }

  for (let i = 0; i < pdfs.length; i++) {
    const f = pdfs[i];
    say(`${i + 1} of ${pdfs.length}: ${f.name}`, i / pdfs.length);
    try {
      const buf = await f.arrayBuffer();
      const rec = await parseAirportPdf(pdfjsLib, new Uint8Array(buf.slice(0)), f.name, S.kv.index);
      const prior = S.airports.get(rec.icao);
      const name = `${rec.icao.replace(/[^A-Z0-9]/g, '_')}_${Date.now()}.pdf`;
      const where = await store.savePdf(name, buf);
      Object.assign(rec, { file: name, where, size: f.size, importedAt: Date.now(), source: f.name });
      await store.put('airports', rec);
      S.airports.set(rec.icao, rec);
      S.missing.delete(rec.icao);
      if (prior) { dropDoc(rec.icao); await store.deletePdf(prior.file, prior.where); }
      res.ok.push(rec.icao);
      if (rec.flags.length) res.flagged.push(`${rec.icao}: ${rec.flags.join(' ')}`);
      if (prior && prior.cycle && rec.cycle && rec.cycle < prior.cycle) res.older.push(`${rec.icao}: cycle ${rec.cycle} replaced newer ${prior.cycle}`);
      const cc = carryCandidates(rec);
      if (cc.length) res.carry.push([rec, cc]);
    } catch (e) {
      console.error(e);
      res.failed.push(`${f.name}: ${e.message || e}`);
    }
  }
  say('Done', 1);
  prog.remove();
  if (backups && backups === jsons.length && !pdfs.length && !res.failed.length) { route(); return; }
  await store.cleanOrphans([...S.airports.values()].filter((a) => a.where !== 'idb').map((a) => a.file));

  let html = `<p><b>${res.ok.length}</b> airport${res.ok.length === 1 ? '' : 's'} imported${res.ok.length ? ': ' + res.ok.map(esc).join(', ') : ''}.</p>`;
  if (jsons.length) html += `<p>Chart index read (${jsons.length} file).</p>`;
  if (res.flagged.length) html += `<p class="warn"><b>Check these:</b><br>${res.flagged.map(esc).join('<br>')}</p>`;
  if (res.older.length) html += `<p class="warn"><b>Older cycle imported:</b><br>${res.older.map(esc).join('<br>')}</p>`;
  if (res.failed.length) html += `<p class="err"><b>Failed:</b><br>${res.failed.map(esc).join('<br>')}</p>`;
  if (skipped.length) html += `<p class="muted">Skipped (not PDF/JSON): ${skipped.map((f) => esc(f.name)).join(', ')}</p>`;
  const mc = mainCycle();
  if (mc) html += `<p>${cycleBadge(mc)}</p>`;
  await dialog({ title: 'Import finished', html });

  for (const [rec, cc] of res.carry) {
    const ok = await dialog({
      title: `${rec.icao}: bring your notes over?`,
      html: `<p>${cc.length} chart${cc.length > 1 ? 's' : ''} you annotated in cycle ${esc(cc[0].cycle)} did not change in cycle ${esc(rec.cycle)}:</p>
             <p>${cc.map((m) => esc(m.key.replace('@', ' page '))).join(', ')}</p>
             <p class="muted">Notes on charts that changed stay hidden with the old cycle.</p>`,
      buttons: [{ label: 'Not now', value: false }, { label: 'Bring notes over', value: true, cls: 'primary' }],
    });
    if (ok) await carryOver(rec, cc);
  }
  route();
}

// ================================================================ backup / restore
// A backup is one JSON file with your chart notes, kneeboard pages, favorites and
// settings. It never contains the chart PDFs.

const BACKUP_FORMAT = 'chartviewer-backup';
const BACKUP_KV = ['favorites', 'recents', 'flight', 'theme', 'chartNight', 'dim', 'tool', 'rotation', 'last', 'lastNote'];

async function saveBackup() {
  flushSave();
  const data = {
    format: BACKUP_FORMAT, version: 1, app: APP_VERSION, made: new Date().toISOString(),
    annotations: await store.getAll('annotations'),
    notes: await store.getAll('notes'),
    kv: Object.fromEntries(BACKUP_KV.map((k) => [k, S.kv[k]])),
  };
  const d = new Date();
  const name = `chartviewer-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Chart Viewer backup' });
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    setKv('lastBackup', Date.now());
    toast('Choose Save to Files to keep the backup');
    if (location.hash === '#/settings') route();
  } catch (e) {
    if (e?.name !== 'AbortError') dialog({ title: 'Backup failed', html: `<p>${esc(e.message || e)}</p>` });
  }
}

function pickBackup() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.style.display = 'none';
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; inp.remove();
    if (!f) return;
    try { await restoreBackup(JSON.parse(await f.text())); } catch (e) { dialog({ title: 'Restore failed', html: `<p>${esc(e.message || e)}</p>` }); }
  });
  document.body.append(inp);
  inp.click();
}

const isBackup = (o) => o && o.format === BACKUP_FORMAT;

/** Merge a backup in: keeps whichever copy of each note/page was edited last. */
async function restoreBackup(data) {
  if (!isBackup(data)) throw new Error('This is not a Chart Viewer backup file.');
  let ann = 0, notes = 0;
  for (const r of data.annotations || []) {
    const cur = await store.get('annotations', r.id);
    if (!cur || (r.updated || 0) > (cur.updated || 0)) {
      await store.put('annotations', r);
      S.ann.set(r.id, { id: r.id, icao: r.icao, key: r.key, cycle: r.cycle, rev: r.rev, n: r.strokes.length });
      ann++;
    }
  }
  for (const n of data.notes || []) {
    const cur = S.notes.get(n.id);
    if (!cur || (n.updated || 0) > (cur.updated || 0)) { await store.put('notes', n); S.notes.set(n.id, n); notes++; }
  }
  const kv = data.kv || {};
  if (Array.isArray(kv.favorites)) {
    const have = new Set(S.kv.favorites.map((f) => `${f.icao}|${f.key}`));
    setKv('favorites', [...S.kv.favorites, ...kv.favorites.filter((f) => !have.has(`${f.icao}|${f.key}`))]);
  }
  for (const k of BACKUP_KV) if (k !== 'favorites' && kv[k] !== undefined && (S.kv[k] === undefined || JSON.stringify(S.kv[k]) === JSON.stringify(KV_DEFAULTS[k]))) setKv(k, kv[k]);
  await dialog({ title: 'Backup restored', html: `<p>From ${esc(fmtWhen(Date.parse(data.made)))}.</p><p>${ann} annotated chart page(s) and ${notes} kneeboard page(s) restored. Newer copies already on this iPad were kept.</p>` });
  applyTheme();
  route();
}

async function deleteAirport(icao) {
  const a = S.airports.get(icao);
  if (!a) return;
  dropDoc(icao);
  await store.deletePdf(a.file, a.where);
  await store.del('airports', icao);
  S.airports.delete(icao);
}

// ================================================================ actions

const actions = {
  nav: (t) => go(t.dataset.to, !!t.dataset.replace),
  import: () => pickFiles(),
  'open-airport': (t) => go(`#/a/${encodeURIComponent(t.dataset.icao)}`),
  'open-chart': (t) => go(chartHash(t.dataset.icao, t.dataset.tab, t.dataset.key, 0)),
  fav: (t) => { toggleFav(t.dataset.icao, t.dataset.key); route(); },
  flight: (t) => {
    const icao = S.kv.flight[t.dataset.slot];
    if (!icao) { editFlight(); return; }
    if (!S.airports.has(icao)) { toast(`${icao} is not imported`); return; }
    const last = S.kv.last[icao];
    const here = S.view === 'viewer' ? S.cur?.icao : (location.hash.match(/^#\/a\/([^/]+)/) || [])[1];
    if (S.view === 'viewer' && here === icao) { go(`#/a/${icao}/${S.cur.tab}`); return; }
    if (last?.key && findChart(S.airports.get(icao), last.key)) go(chartHash(icao, last.tab, last.key, last.pidx || 0), S.view === 'viewer');
    else go(`#/a/${icao}`);
  },
  'edit-flight': () => editFlight(),
  'set-slot': (t) => {
    const f = { ...S.kv.flight };
    const s = t.dataset.slot, icao = t.dataset.icao;
    f[s] = f[s] === icao ? '' : icao;
    setKv('flight', f);
    route();
  },
  rwy: (t) => {
    const m = { ...(S.kv.rwy || {}) };
    if (t.dataset.r) m[t.dataset.icao] = t.dataset.r; else delete m[t.dataset.icao];
    setKv('rwy', m);
    route();
  },
  'more-recents': () => { S.allRecents = !S.allRecents; fillHomeResults(); },
  'wx-toggle': (t) => { S.wxOpen = S.wxOpen === t.dataset.icao ? null : t.dataset.icao; refreshWxBox(S.airports.get(t.dataset.icao)); },
  'wx-refresh': async (t) => {
    const a = S.airports.get(t.dataset.icao);
    if (!relayBase()) { go('#/settings'); return; }
    if (!navigator.onLine) { toast('Offline — showing the last saved report'); return; }
    t.disabled = true;
    const ok = await fetchWx([a.icao]);
    refreshWxBox(a);
    if (!ok) toast('Could not get weather — check the relay in ⚙︎');
  },
  'wx-save': async () => {
    const v = (document.getElementById('wx-relay')?.value || '').trim();
    const out = document.getElementById('wx-test');
    if (v && !/^https:\/\//i.test(v)) { out.textContent = 'The address must start with https://'; return; }
    setKv('wxRelay', v);
    if (!v) { out.textContent = 'Weather turned off.'; return; }
    out.textContent = 'Testing…';
    try {
      const r = await fetch(`${relayBase()}/metar?ids=MPTO`);
      const d = await r.json();
      out.textContent = Array.isArray(d) ? `✓ Works (${d[0]?.rawOb ? d[0].rawOb.slice(0, 40) + '…' : 'no report right now'})` : '✗ Unexpected answer from the relay';
    } catch (e) { out.textContent = `✗ Could not reach the relay (${e.message})`; }
  },
  carry: async (t) => { const a = S.airports.get(t.dataset.icao); await carryOver(a, carryCandidates(a)); toast('Notes brought over'); route(); },
  theme: (t) => { setKv('theme', t.dataset.v); applyTheme(); route(); },
  'del-airport': async (t) => {
    const icao = t.dataset.icao;
    const ok = await dialog({ title: `Delete ${icao}?`, html: '<p>Removes its charts from this iPad. Your notes are kept and come back if you import it again.</p>', buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }] });
    if (ok) { await deleteAirport(icao); route(); }
  },
  'del-all': async () => {
    const ok = await dialog({ title: 'Delete all charts?', html: '<p>Removes every airport PDF from this iPad. Notes, favorites and settings are kept.</p>', buttons: [{ label: 'Cancel', value: false }, { label: 'Delete all', value: true, cls: 'danger' }] });
    if (!ok) return;
    for (const icao of [...S.airports.keys()]) await deleteAirport(icao);
    await store.cleanOrphans([]);
    route();
  },
  'del-old-notes': async () => {
    const old = [...S.ann.values()].filter((m) => { const a = S.airports.get(m.icao); return a && m.cycle !== a.cycle; });
    if (!old.length) { toast('No notes from old cycles'); return; }
    const ok = await dialog({ title: 'Delete old notes?', html: `<p>${old.length} annotated chart page(s) from older cycles will be deleted. This cannot be undone.</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }] });
    if (!ok) return;
    for (const m of old) { await store.del('annotations', m.id); S.ann.delete(m.id); }
    toast('Old notes deleted');
  },
  // viewer
  'v-back': () => {
    const c = S.cur;
    if (c?.kind === 'note') go(S.noteReturn || '#/notes');
    else go(c ? `#/a/${encodeURIComponent(c.icao)}/${c.tab}` : '#/');
    S.noteReturn = null;
  },
  kneeboard: () => {
    // From a chart: remember it, so ‹ on the note page comes straight back.
    S.noteReturn = S.view === 'viewer' && S.viewerMode === 'chart' ? location.hash : null;
    const last = S.kv.lastNote && S.notes.get(S.kv.lastNote);
    go(last ? `#/n/${last.id}` : '#/notes');
  },
  'note-new': (t) => newNote(t.dataset.tpl),
  'note-new-same': async () => {
    if (S.cur?.kind !== 'note') return;
    const tid = await dialog({ title: 'New page', buttons: [...TEMPLATES.map((t) => ({ label: `${t.icon} ${t.name}`, value: t.id })), { label: 'Cancel', value: null }] });
    if (tid) newNote(tid, true);
  },
  'note-rename': async () => {
    const c = S.cur; if (c?.kind !== 'note') return;
    const ok = await dialog({
      title: 'Page name',
      html: `<label class="field"><input id="note-title" value="${esc(c.n.title)}" style="text-transform:none"></label>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, cls: 'primary' }],
    });
    if (!ok) return;
    c.n.title = (dialogFields['note-title'] || '').trim() || c.n.title;
    c.n.updated = Date.now();
    await store.put('notes', c.n);
    route();
  },
  'note-del': async (t) => {
    const n = S.notes.get(t.dataset.id); if (!n) return;
    const ok = await dialog({ title: 'Delete this page?', html: `<p>${esc(n.title)}</p><p>This cannot be undone (unless you have a backup).</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }] });
    if (!ok) return;
    await store.del('notes', n.id);
    S.notes.delete(n.id);
    route();
  },
  backup: () => saveBackup(),
  restore: () => pickBackup(),
  'v-fav': () => {
    const c = S.cur; if (!c) return;
    const on = toggleFav(c.icao, c.key);
    const b = document.getElementById('vfav'); b.textContent = on ? '★' : '☆'; b.classList.toggle('on', on);
  },
  'compass-offset': (t) => { setKv('compassOffset', +t.dataset.v); gps.compassOffset = +t.dataset.v; route(); },
  gps: async (t) => {
    const on = !S.kv.gps;
    setKv('gps', on);
    t.classList.toggle('on', on);
    if (on) {
      await Gps.askCompass(); // iOS: must come from this tap
      gpsRun(true);
      const cur = S.cur;
      if (cur?.kind === 'chart') chartGeo(cur).then(updateOwn);
      toast('GPS on — situational awareness only');
    } else {
      gpsRun(false);
    }
    updateOwn();
  },
  'v-rotate': () => {
    const c = S.cur; if (!c || !viewer) return;
    const k = `${c.icao}|${c.key}`;
    const r = S.kv.rotation[k] ? 0 : 90; // upright <-> turned 90°, never upside down
    if (r) S.kv.rotation[k] = r; else delete S.kv.rotation[k];
    setKv('rotation', S.kv.rotation);
    viewer.setRotation(r);
  },
  'v-night': () => {
    setKv('chartNight', !S.kv.chartNight);
    document.querySelector('.viewer')?.classList.toggle('chart-night', S.kv.chartNight);
    document.getElementById('vnight')?.classList.toggle('on', S.kv.chartNight);
  },
  'v-step': (t) => stepChart(+t.dataset.dir),
  tool: (t) => { setKv('tool', { ...S.kv.tool, kind: t.dataset.kind, ...(t.dataset.color ? { color: t.dataset.color } : {}) }); renderTools(); },
  'tool-width': () => { setKv('tool', { ...S.kv.tool, width: S.kv.tool.width === 'thick' ? 'thin' : 'thick', kind: 'pen' }); renderTools(); },
  'ink-undo': () => viewer?.inkUndo(),
  'ink-clear': async () => {
    if (!viewer) return;
    const ok = await dialog({ title: 'Clear notes on this chart?', html: '<p>You can still Undo right after.</p>', buttons: [{ label: 'Cancel', value: false }, { label: 'Clear', value: true, cls: 'danger' }] });
    if (ok) viewer.inkClear();
  },
};

function toggleFav(icao, key) {
  const a = S.airports.get(icao);
  const c = findChart(a, key);
  let favs = S.kv.favorites;
  const on = !isFav(icao, key);
  if (on) favs = [...favs, { icao, key, number: c?.number || '', title: c?.title || '' }];
  else favs = favs.filter((f) => !(f.icao === icao && f.key === key));
  favs.sort((x, y) => x.icao.localeCompare(y.icao) || compareNumbers(x.number, y.number));
  setKv('favorites', favs);
  return on;
}

async function editFlight() {
  const f = S.kv.flight;
  const opts = sortedAirports().map((a) => `<option value="${esc(a.icao)}">${esc(a.iata || '')} ${esc(a.name)}</option>`).join('');
  const val = await dialog({
    title: 'Flight',
    html: `<datalist id="aptlist">${opts}</datalist>
      ${SLOTS.map(([s, l]) => `<label class="field"><span>${l}</span><input id="f-${s}" list="aptlist" value="${esc(f[s])}" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ICAO or IATA"></label>`).join('')}
      <p class="muted">Tap a flight tab to jump to that airport's last chart. Tap it again to see its chart list.</p>`,
    buttons: [{ label: 'Clear', value: 'clear' }, { label: 'Cancel', value: null }, { label: 'Save', value: 'save', cls: 'primary' }],
  });
  if (!val) return;
  const nf = { dep: '', arr: '', alt: '' };
  if (val === 'save') {
    for (const [s] of SLOTS) {
      const v = (dialogFields[`f-${s}`] || '').trim().toUpperCase();
      const hit = [...S.airports.values()].find((a) => a.icao === v || a.iata === v);
      nf[s] = hit ? hit.icao : v;
    }
  }
  setKv('flight', nf);
  route();
}

// ---------------------------------------------------------------- swipe back
// Like Apple's apps: drag right from the left edge of the screen, or swipe right
// along the top bar, to go back. Touch events keep coming even while a list scrolls.
const EDGE_PX = 24;
let swipe = null;
function backTarget() {
  return document.querySelector('[data-act=v-back]') || document.querySelector('header.top [data-act=nav][aria-label=Back]');
}
function backHint(dx) {
  let h = document.getElementById('backhint');
  if (!h) { h = document.createElement('div'); h.id = 'backhint'; h.textContent = '‹'; document.body.append(h); }
  const k = Math.max(0, Math.min(1, dx / 90));
  h.style.opacity = String(k);
  h.style.transform = `translate(${Math.min(dx, 90) - 50}px, -50%) scale(${0.6 + 0.4 * k})`;
  h.classList.toggle('ready', dx > 80);
}
document.addEventListener('touchstart', (e) => {
  swipe = null;
  if (e.touches.length !== 1 || !backTarget() || document.querySelector('.modal')) return;
  const t = e.touches[0];
  const onBar = e.target.closest('header.top, header.vbar') && !e.target.closest('input, .dimctl, .vpills');
  if (t.clientX < EDGE_PX || onBar) swipe = { x: t.clientX, y: t.clientY, dx: 0, dy: 0 };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  if (e.touches.length !== 1) { swipe = null; backHint(0); return; }
  const t = e.touches[0];
  swipe.dx = t.clientX - swipe.x; swipe.dy = t.clientY - swipe.y;
  if (Math.abs(swipe.dy) > 60 && Math.abs(swipe.dy) > swipe.dx) { swipe = null; backHint(0); return; }
  backHint(swipe.dx);
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!swipe) return;
  const { dx, dy } = swipe;
  swipe = null;
  backHint(0);
  if (dx > 80 && Math.abs(dy) < dx * 0.7) {
    const b = backTarget();
    if (b) b.click();
  }
}, { passive: true });
document.addEventListener('touchcancel', () => { swipe = null; backHint(0); }, { passive: true });

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const fn = actions[t.dataset.act];
  if (fn) { e.preventDefault(); fn(t, e); }
});

// ================================================================ router

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] === 'a' && parts[1]) renderAirport(parts[1], parts[2]);
    else if (parts[0] === 'c' && parts[3]) renderViewer(parts[1], parts[2], parts[3], parts[4]);
    else if (parts[0] === 'settings') renderSettings();
    else if (parts[0] === 'notes') renderNotes();
    else if (parts[0] === 'n' && parts[1]) renderNote(parts[1]);
    else renderHome();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="pad"><h2>Something went wrong</h2><pre>${esc(e.stack || e)}</pre><button class="btn" data-act="nav" data-to="#/">Home</button></div>`;
  }
}
window.addEventListener('hashchange', route);

// ================================================================ offline (service worker) + update

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (w) => {
      if (!w || !navigator.serviceWorker.controller) return;
      let b = document.getElementById('updbar');
      if (!b) {
        b = document.createElement('button');
        b.id = 'updbar';
        b.textContent = 'App update ready — tap to update';
        b.addEventListener('click', () => w.postMessage('skipWaiting'));
        document.body.append(b);
      }
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    if (navigator.onLine) reg.update().catch(() => {});
  }).catch((e) => console.warn('SW registration failed', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    flushSave();
    location.reload();
  });
}

// ================================================================ start

async function start() {
  try {
    await loadState();
  } catch (e) {
    app.innerHTML = `<div class="pad"><h2>Storage unavailable</h2><p>${esc(e.message || e)}</p><p>Private Browsing blocks storage. Open the app from the Home Screen.</p></div>`;
    return;
  }
  applyTheme();
  route();
  setupServiceWorker();
  document.addEventListener('click', () => { if (S.kv.gps) Gps.askCompass(); }, { once: true, capture: true });
  // Check every airport's PDF is still on the device; flag any that aren't.
  for (const a of [...S.airports.values()]) {
    if (await store.pdfExists(a.file, a.where)) continue;
    // Re-check with the current record: an import may have just replaced this file.
    const now = S.airports.get(a.icao);
    if (now && !(await store.pdfExists(now.file, now.where))) S.missing.add(a.icao);
  }
  if (S.missing.size) {
    route();
    toast(`Chart files missing: ${[...S.missing].join(', ')} — import them again`);
  }
  window.addEventListener('pagehide', flushSave);
}

// Small hook used for automated testing on the PC (imports File objects).
window.chartApp = { importFiles, state: S };

start();
