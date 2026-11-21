// Local storage on the device only. Nothing here is ever sent anywhere.
//  - Chart PDFs: Origin Private File System (OPFS), folder "charts".
//    Fallback (very old iOS): IndexedDB "blobs" store.
//  - Airport list, annotations, favorites, settings: IndexedDB.

const DB_NAME = 'chartviewer';
const DB_VERSION = 2; // 2: added "notes" (kneeboard pages)
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('airports')) d.createObjectStore('airports', { keyPath: 'icao' });
        if (!d.objectStoreNames.contains('annotations')) d.createObjectStore('annotations', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

export async function get(store, key) {
  const d = await openDb();
  return req(d.transaction(store).objectStore(store).get(key));
}
export async function getAll(store) {
  const d = await openDb();
  return req(d.transaction(store).objectStore(store).getAll());
}
export async function put(store, value, key) {
  const d = await openDb();
  const t = d.transaction(store, 'readwrite');
  if (key === undefined) t.objectStore(store).put(value); else t.objectStore(store).put(value, key);
  return done(t);
}
export async function del(store, key) {
  const d = await openDb();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  return done(t);
}

// ------------------------------------------------------------- files (OPFS)

const opfsAvailable = !!(navigator.storage && navigator.storage.getDirectory);

async function chartsDir(folder = 'charts') {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(folder, { create: true });
}

function writeViaWorker(name, buf, folder = 'charts') {
  // Older Safari has no createWritable(); a worker can use createSyncAccessHandle().
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./opfs-worker.js', import.meta.url));
    w.onmessage = (e) => { w.terminate(); e.data.ok ? resolve() : reject(new Error(e.data.error)); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker error')); };
    w.postMessage({ name, buf, folder }, [buf]);
  });
}

/** Save a PDF. Returns where it went: 'opfs' or 'idb'. `buf` is an ArrayBuffer (may be consumed). */
export async function savePdf(name, buf) {
  if (opfsAvailable) {
    try {
      const dir = await chartsDir();
      const fh = await dir.getFileHandle(name, { create: true });
      if (fh.createWritable) {
        const w = await fh.createWritable();
        await w.write(buf);
        await w.close();
      } else {
        await writeViaWorker(name, buf.slice(0));
      }
      const f = await fh.getFile();
      if (f.size === buf.byteLength) return 'opfs';
      throw new Error('size check failed');
    } catch (e) {
      console.warn('OPFS write failed, using IndexedDB instead', e);
      try { (await chartsDir()).removeEntry(name); } catch { /* ignore */ }
    }
  }
  await put('blobs', new Blob([buf], { type: 'application/pdf' }), name);
  return 'idb';
}

export async function loadPdf(name, where) {
  let blob;
  if (where === 'idb') {
    blob = await get('blobs', name);
  } else {
    try {
      const dir = await chartsDir();
      blob = await (await dir.getFileHandle(name)).getFile();
    } catch { blob = null; }
  }
  if (!blob) throw new Error('The chart file is missing on this iPad - import this airport again');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Is the stored PDF still there? (Storage can be cleared by the system.) */
export async function pdfExists(name, where) {
  try {
    if (where === 'idb') return !!(await get('blobs', name));
    const f = await (await (await chartsDir()).getFileHandle(name)).getFile();
    return f.size > 0;
  } catch { return false; }
}

export async function deletePdf(name, where) {
  try {
    if (where === 'idb') await del('blobs', name);
    else await (await chartsDir()).removeEntry(name);
  } catch (e) { console.warn('delete failed', name, e); }
}

/** Remove files in the charts folder that no airport refers to (leftovers of failed imports). */
export async function cleanOrphans(keepNames) {
  if (!opfsAvailable) return;
  try {
    const dir = await chartsDir();
    const keep = new Set(keepNames);
    for await (const [name] of dir.entries()) {
      if (!keep.has(name)) await dir.removeEntry(name);
    }
  } catch (e) { console.warn('cleanup skipped', e); }
}

export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null };
  try {
    if (navigator.storage?.estimate) Object.assign(out, await navigator.storage.estimate());
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
  } catch { /* not supported */ }
  return out;
}

export async function askPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

// ------------------------------------------------------------- map data (OPFS folder "map")
// One file (_map_data.zip from the export script). Saved like the charts, but in
// its own folder so the chart clean-up never touches it.

/** Save the map file. Returns 'opfs' or 'idb'. */
export async function saveMapFile(name, buf) {
  if (opfsAvailable) {
    try {
      const dir = await chartsDir('map');
      const fh = await dir.getFileHandle(name, { create: true });
      if (fh.createWritable) {
        const w = await fh.createWritable();
        await w.write(buf);
        await w.close();
      } else {
        await writeViaWorker(name, buf.slice(0), 'map');
      }
      if ((await fh.getFile()).size === buf.byteLength) return 'opfs';
      throw new Error('size check failed');
    } catch (e) {
      console.warn('OPFS write failed, using IndexedDB instead', e);
      try { (await chartsDir('map')).removeEntry(name); } catch { /* ignore */ }
    }
  }
  await put('blobs', new Blob([buf], { type: 'application/zip' }), 'map:' + name);
  return 'idb';
}

/** The stored map file as a Blob/File (read in pieces, never all at once), or null. */
export async function mapFile(name, where) {
  try {
    if (where === 'idb') return (await get('blobs', 'map:' + name)) || null;
    return await (await (await chartsDir('map')).getFileHandle(name)).getFile();
  } catch { return null; }
}

/** Remove map files other than `keep`. */
export async function cleanMapFiles(keep) {
  try {
    if (opfsAvailable) {
      const dir = await chartsDir('map');
      for await (const [name] of dir.entries()) if (name !== keep) await dir.removeEntry(name);
    }
  } catch (e) { console.warn('map cleanup skipped', e); }
}

export async function deleteMapFile(name, where) {
  try {
    if (where === 'idb') await del('blobs', 'map:' + name);
    else await (await chartsDir('map')).removeEntry(name);
  } catch (e) { console.warn('delete failed', name, e); }
}
