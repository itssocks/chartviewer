// Writes a file into the Origin Private File System (for Safari versions
// without FileSystemFileHandle.createWritable()).
self.onmessage = async (e) => {
  const { name, buf, folder } = e.data;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(folder || 'charts', { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    h.truncate(0);
    h.write(new Uint8Array(buf), { at: 0 });
    h.flush();
    h.close();
    self.postMessage({ ok: true });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
