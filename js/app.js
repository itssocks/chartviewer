// Chart Viewer - main app. Everything stays on this device; no network use
// except loading the app itself (and that is cached for offline use).
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import * as store from './store.js';
import { parseAirportPdf, enrichFromIndex, compareNumbers } from './pdfindex.js';
import { ChartViewer } from './viewer.js';

export const APP_VERSION = '1.0.2';

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
  last: {}, index: null, rotation: {},
};

const S = { airports: new Map(), kv: {}, ann: new Map(), view: null, missing: new Set() };
const app = document.getElementById('app');

// ================================================================ state

async function loadState() {
  for (const a of await store.getAll('airports')) S.airports.set(a.icao, a);
  for (const k of Object.keys(KV_DEFAULTS)) {
    const v = await store.get('kv', k);
    S.kv[k] = v === undefined ? structuredClone(KV_DEFAULTS[k]) : v;
  }
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
      wrap.querySelectorAll('input').forEach((i) => { dialogFields[i.id] = i.value; });
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

function chartRow(a, c, tab, showTab = false) {
  const fav = isFav(a.icao, c.key);
  return `<div class="row chart-row">
    <button class="star ${fav ? 'on' : ''}" data-act="fav" data-icao="${esc(a.icao)}" data-key="${esc(c.key)}" aria-label="Favorite">${fav ? '★' : '☆'}</button>
    <button class="row-main" data-act="open-chart" data-icao="${esc(a.icao)}" data-key="${esc(c.key)}" data-tab="${tab}">
      <span class="num">${esc(c.number || '—')}</span>
      <span class="ttl">${esc(c.title)}${showTab ? ` <em>${esc(tabLabel(tabOf(c.cat)))}</em>` : ''}</span>
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

function airportRow(a) {
  const st = cycleState(a);
  return `<button class="row apt-row" data-act="open-airport" data-icao="${esc(a.icao)}">
    <span class="apt-code">${esc(a.icao)}${a.iata ? `<small>${esc(a.iata)}</small>` : ''}</span>
    <span class="apt-name">${esc(a.name)}<small>${esc([a.city, a.country].filter(Boolean).join(', '))}</small></span>
    ${a.flags?.length ? '<span class="warnmark" title="Check this PDF">⚠</span>' : ''}
    ${S.missing.has(a.icao) ? '<span class="pill red">FILE MISSING — re-import</span>' : ''}
    ${st === 'expired' ? '<span class="pill red">EXPIRED</span>' : st === 'future' ? '<span class="pill amber">NOT YET</span>' : ''}
  </button>`;
}

function topBar({ back, title, sub = '', right = '' }) {
  return `<header class="top">
    ${back ? `<button class="iconbtn" data-act="nav" data-to="${back}" aria-label="Back">‹</button>` : '<span class="logo">✈︎</span>'}
    <div class="top-title"><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    ${right}
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
  const favs = S.kv.favorites, rec = S.kv.recents.slice(0, 12);
  box.innerHTML = `
    ${favs.length ? `<h3 class="sec">★ Favorites</h3><div class="list">${favs.map((f) => savedChartRow(f, 'fav')).join('')}</div>` : ''}
    ${rec.length ? `<h3 class="sec">Recent charts</h3><div class="list">${rec.map((r) => savedChartRow(r, 'recent')).join('')}</div>` : ''}
    <h3 class="sec">Airports (${S.airports.size})</h3><div class="list">${sortedAirports().map(airportRow).join('')}</div>`;
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
      const n = chartsInTab(a, t.id).length;
      return `<button class="tab ${t.id === tab ? 'on' : ''} ${n ? '' : 'none'}" data-act="nav" data-replace="1" data-to="#/a/${esc(icao)}/${t.id}">${t.label}<small>${n}</small></button>`;
    }).join('')}</nav>
    <main class="scroll" id="chartlist"></main>`;
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
      const list = chartsInTab(a, tab);
      box.innerHTML = list.length ? `<div class="list">${list.map((c) => chartRow(a, c, tab)).join('')}</div>` : `<p class="muted pad">No ${esc(tabLabel(tab))} charts for ${esc(icao)}.</p>`;
    }
  };
  inp.addEventListener('input', fill);
  fill();
  S.kv.last[icao] = { ...(S.kv.last[icao] || {}), tab };
  setKv('last', S.kv.last);
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
});

function leaveViewer() {
  if (S.view !== 'viewer') { S.view = 'other'; return; }
  flushSave();
  viewer?.destroy();
  viewer = null;
  S.view = 'other';
  setWake(false);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (pendingSave) { const p = pendingSave; pendingSave = null; p(); }
}

function sequence(a, tab) {
  const seq = [];
  for (const c of chartsInTab(a, tab)) for (let i = 0; i < (c.pages || 1); i++) seq.push([c, i]);
  return seq;
}

function toolState() { return S.kv.tool; }

function viewerShell() {
  app.innerHTML = `
  <div class="viewer ${S.kv.chartNight ? 'chart-night' : ''}">
    <header class="vbar">
      <button class="iconbtn" data-act="v-back" aria-label="Back to chart list">‹</button>
      <div class="vpills" id="vpills"></div>
      <div class="vtitle" id="vtitle"></div>
      <button class="iconbtn" data-act="v-fav" id="vfav" aria-label="Favorite">☆</button>
      <button class="iconbtn" data-act="v-rotate" aria-label="Rotate">⟳</button>
      <button class="iconbtn ${S.kv.chartNight ? 'on' : ''}" data-act="v-night" id="vnight" aria-label="Night mode">☾</button>
      <label class="dimctl" aria-label="Brightness">☀︎<input type="range" id="vdim" min="0.25" max="1" step="0.05" value="${S.kv.dim}"></label>
    </header>
    <div class="vstage-wrap">
      <div class="vstage" id="vstage"></div>
      <div class="vdim" id="vdimlayer"></div>
      <div class="vbanners" id="vbanners"></div>
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

  if (S.view !== 'viewer' || !viewer) {
    leaveViewer();
    viewerShell();
    S.view = 'viewer';
    viewer = new ChartViewer(document.getElementById('vstage'), {
      onSwipe: (dir) => stepChart(dir),
      onInkChange: (strokes) => queueSave(strokes),
      getTool: toolState,
    });
    setWake(true);
  } else {
    flushSave();
  }
  const cur = { icao, tab, key, pidx, a, c };
  S.cur = cur;

  // header
  document.getElementById('vpills').innerHTML = SLOTS.map(([s, l]) => {
    const x = S.kv.flight[s];
    return x ? `<button class="vpill ${x === icao ? 'on' : ''}" data-act="flight" data-slot="${s}"><small>${l}</small>${esc(x)}</button>` : '';
  }).join('');
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
    // pre-load the next chart's page so swiping is quick
    const nx = seq[pos + 1];
    if (nx) doc.getPage(nx[0].page + nx[1]).catch(() => {});
  } catch (e) {
    console.error(e);
    loading.textContent = 'Could not open this chart: ' + (e.message || e);
  }
}

function queueSave(strokes) {
  const cur = S.cur;
  if (!cur) return;
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
  for (const f of jsons) {
    try {
      const idx = JSON.parse(await f.text());
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
  'v-back': () => { const c = S.cur; go(c ? `#/a/${encodeURIComponent(c.icao)}/${c.tab}` : '#/'); },
  'v-fav': () => {
    const c = S.cur; if (!c) return;
    const on = toggleFav(c.icao, c.key);
    const b = document.getElementById('vfav'); b.textContent = on ? '★' : '☆'; b.classList.toggle('on', on);
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
  // Check every airport's PDF is still on the device; flag any that aren't.
  for (const a of S.airports.values()) if (!(await store.pdfExists(a.file, a.where))) S.missing.add(a.icao);
  if (S.missing.size) {
    route();
    toast(`Chart files missing: ${[...S.missing].join(', ')} — import them again`);
  }
  window.addEventListener('pagehide', flushSave);
}

// Small hook used for automated testing on the PC (imports File objects).
window.chartApp = { importFiles, state: S };

start();
