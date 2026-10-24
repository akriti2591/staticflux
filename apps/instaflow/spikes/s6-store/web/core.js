// S6 spike core: content-addressed workspace store over a FileSystemDirectoryHandle.
// Two backends share one layout (DOCUMENT-FORMAT §5.1):
//   - 'sync'  : OPFS + createSyncAccessHandle (dedicated worker only)  -> the OPFS primary
//   - 'async' : createWritable + FileSystemHandle.move                 -> the folder (File System Access) backend,
//               exercised here on an OPFS directory handle because the folder picker cannot be automated headless.
// Spike code: minimal, no production polish.

export const enc = new TextEncoder();
export const dec = new TextDecoder();

// ---------- hashing / checksums ----------
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function toHex(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]];
  return s;
}
export async function sha256Hex(bytes) { return toHex(await crypto.subtle.digest('SHA-256', bytes)); }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// RFC 8785-style canonical JSON: sorted keys, ES number serialization (shortest round trip), no whitespace.
export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
}

async function pump(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const deflateRaw = (b) => pump(b, new CompressionStream('deflate-raw'));
export const inflateRaw = (b) => pump(b, new DecompressionStream('deflate-raw'));

export function sfError(code, message, fix) { return { ok: false, error: { code, message, fix } }; }

// ---------- backend: a thin file API over a directory handle ----------
const rnd = () => Math.random().toString(36).slice(2, 10);

export class Backend {
  /** @param {FileSystemDirectoryHandle} root @param {'sync'|'async'} kind */
  constructor(root, kind) {
    this.root = root; this.kind = kind; this.dirs = new Map();
    this.stats = { bytesWritten: 0, filesWritten: 0 };
  }
  async dir(parts, create = true) {
    const key = parts.join('/');
    let d = this.dirs.get(key);
    if (d) return d;
    d = this.root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    this.dirs.set(key, d);
    return d;
  }
  async tryDir(parts) { try { return await this.dir(parts, false); } catch { return null; } }

  async exists(parts, name) {
    const d = await this.tryDir(parts); if (!d) return false;
    try { await d.getFileHandle(name); return true; } catch { return false; }
  }
  async read(parts, name, { viaFile = false } = {}) {
    const d = await this.tryDir(parts); if (!d) return null;
    let fh; try { fh = await d.getFileHandle(name); } catch { return null; }
    if (this.kind === 'sync' && !viaFile) {
      // sync read (exclusive handle); falls back to getFile if someone holds it
      try {
        const h = await fh.createSyncAccessHandle();
        try { const b = new Uint8Array(h.getSize()); h.read(b, { at: 0 }); return b; } finally { h.close(); }
      } catch { /* fallthrough */ }
    }
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  }
  /** raw write of a file under a name (no atomicity) */
  async writeRaw(d, name, bytes) {
    const fh = await d.getFileHandle(name, { create: true });
    if (this.kind === 'sync') {
      const h = await fh.createSyncAccessHandle();
      try { h.truncate(0); let off = 0; while (off < bytes.length) off += h.write(bytes.subarray(off), { at: off }); h.flush(); } finally { h.close(); }
    } else {
      const w = await fh.createWritable();
      await w.write(bytes); await w.close();
    }
    this.stats.bytesWritten += bytes.length; this.stats.filesWritten++;
    return fh;
  }
  /** Atomic publish: write a unique temp file fully (flush/close), then move() it over the final name. */
  async writeAtomic(parts, name, bytes, hooks) {
    const d = await this.dir(parts);
    const tmp = `${name}.tmp-${rnd()}`;
    const fh = await this.writeRaw(d, tmp, bytes);
    if (hooks?.beforeMove) await hooks.beforeMove();
    await fh.move(d, name);           // overwrites an existing target in Chromium 153 (probed in bench)
  }
  async remove(parts, name) { const d = await this.tryDir(parts); if (d) await d.removeEntry(name).catch(() => {}); }
  async list(parts) {
    const d = await this.tryDir(parts); if (!d) return [];
    const out = []; for await (const [n, h] of d.entries()) out.push([n, h]); return out;
  }
}

// ---------- blobs ----------
export const blobPath = (hex) => [['blobs', 'sha256', hex.slice(0, 2)], hex];

/** put content-addressed bytes. `hex` is the digest of the DECODED content; `stored` may be deflate-raw. */
export async function putBlob(be, hex, stored, { direct = false } = {}) {
  const [parts, name] = blobPath(hex);
  if (await be.exists(parts, name)) return 0;
  if (direct) await be.writeRaw(await be.dir(parts), name, stored);
  else await be.writeAtomic(parts, name, stored);
  return stored.length;
}
export async function getBlob(be, hex) { const [p, n] = blobPath(hex); return be.read(p, n); }

// ---------- heads with compare-and-swap ----------
export function encodeHead(head) {
  const body = { ...head }; delete body.crc;
  const c = canonicalJSON(body);
  return enc.encode(canonicalJSON({ ...body, crc: crc32(enc.encode(c)) }));
}
/** returns {status:'missing'|'ok'|'torn', head?} */
export function decodeHead(bytes) {
  if (!bytes) return { status: 'missing' };
  try {
    const h = JSON.parse(dec.decode(bytes));
    const body = { ...h }; delete body.crc;
    if (crc32(enc.encode(canonicalJSON(body))) !== h.crc) return { status: 'torn', reason: 'crc' };
    return { status: 'ok', head: h };
  } catch (e) { return { status: 'torn', reason: 'parse', len: bytes.length }; }
}
export async function readHead(be, name) { return decodeHead(await be.read(['heads'], `${name}.json`, { viaFile: true })); }

/**
 * CAS: under an exclusive Web Lock for this head, re-read it and swap only if generation === expected.
 * The lock serialises all writers in the origin (tabs, workers); the generation fences stale writers.
 */
export async function casHead(be, lockPrefix, name, expectedGen, next, hooks) {
  return navigator.locks.request(`${lockPrefix}:head:${name}`, async () => {
    const cur = await readHead(be, name);
    if (cur.status === 'torn') return sfError('IF-STORE-002', 'head unreadable', 'restore from previous head');
    const curGen = cur.status === 'ok' ? cur.head.generation : 0;
    if (curGen !== expectedGen) return { ...sfError('IF-STORE-003', `head CAS conflict: expected ${expectedGen}, found ${curGen}`, 'reload head and retry'), current: cur.head };
    const head = { ...next, generation: expectedGen + 1 };
    await be.writeAtomic(['heads'], `${name}.json`, encodeHead(head), hooks);
    return { ok: true, head };
  });
}

// ---------- log segments: [u32 len][u32 crc][payload] ----------
export function frame(payload) {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, payload.length, true); dv.setUint32(4, crc32(payload), true);
  out.set(payload, 8); return out;
}
export function parseFrames(bytes) {
  const recs = []; let off = 0; let torn = false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off < bytes.length) {
    if (off + 8 > bytes.length) { torn = true; break; }
    const len = dv.getUint32(off, true), c = dv.getUint32(off + 4, true);
    if (len === 0 || off + 8 + len > bytes.length) { torn = true; break; }
    const p = bytes.subarray(off + 8, off + 8 + len);
    if (crc32(p) !== c) { torn = true; break; }
    recs.push(p); off += 8 + len;
  }
  return { recs, torn, validBytes: off };
}
export const segName = (n, peer) => `${String(n).padStart(8, '0')}-${peer}.bin`;
export const segNum = (name) => Number(name.slice(0, 8));

// ---------- zip (.iflow) ----------
// Minimal streaming writer: local header with known sizes, no data descriptors, no zip64 (spike).
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 10 << 5 | 24;
export class ZipWriter {
  /** @param {(chunk:Uint8Array)=>Promise<void>|void} sink */
  constructor(sink) { this.sink = sink; this.offset = 0; this.cd = []; }
  async #emit(b) { await this.sink(b); this.offset += b.length; }
  /** data: bytes as stored; method 0 STORED or 8 DEFLATE (data already deflate-raw); crc/size of the decoded bytes */
  async add(name, data, { method = 0, crc = crc32(data), size = data.length } = {}) {
    const nb = enc.encode(name);
    const h = new Uint8Array(30 + nb.length); const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, method, true);
    dv.setUint16(10, DOS_TIME, true); dv.setUint16(12, DOS_DATE, true); dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true); dv.setUint32(22, size, true); dv.setUint16(26, nb.length, true); dv.setUint16(28, 0, true);
    h.set(nb, 30);
    const local = this.offset;
    await this.#emit(h); await this.#emit(data);
    this.cd.push({ nb, method, crc, csize: data.length, size, local });
  }
  async finish() {
    const start = this.offset;
    for (const e of this.cd) {
      const h = new Uint8Array(46 + e.nb.length); const dv = new DataView(h.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, e.method, true); dv.setUint16(12, DOS_TIME, true); dv.setUint16(14, DOS_DATE, true);
      dv.setUint32(16, e.crc, true); dv.setUint32(20, e.csize, true); dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.nb.length, true); dv.setUint32(42, e.local, true); h.set(e.nb, 46);
      await this.#emit(h);
    }
    const eocd = new Uint8Array(22); const dv = new DataView(eocd.buffer);
    dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, this.cd.length, true); dv.setUint16(10, this.cd.length, true);
    dv.setUint32(12, this.offset - start, true); dv.setUint32(16, start, true);
    await this.#emit(eocd);
  }
}
/** In-place reader: EOCD + central directory, entries read lazily with Blob.slice. */
export async function readZipDirectory(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  let p = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { p = i; break; }
  if (p < 0) return null;
  const tv = new DataView(tail.buffer, p);
  const count = tv.getUint16(10, true), cdSize = tv.getUint32(12, true), cdOff = tv.getUint32(16, true);
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()); const dv = new DataView(cd.buffer);
  const entries = []; let o = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(o, true) !== 0x02014b50) return null;
    const method = dv.getUint16(o + 10, true), crc = dv.getUint32(o + 16, true), csize = dv.getUint32(o + 20, true), size = dv.getUint32(o + 24, true);
    const nl = dv.getUint16(o + 28, true), xl = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true), local = dv.getUint32(o + 42, true);
    entries.push({ name: dec.decode(cd.subarray(o + 46, o + 46 + nl)), method, crc, csize, size, local });
    o += 46 + nl + xl + cl;
  }
  return entries;
}
export async function readZipEntry(file, e) {
  const lh = new DataView(await file.slice(e.local, e.local + 30).arrayBuffer());
  const start = e.local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  return new Uint8Array(await file.slice(start, start + e.csize).arrayBuffer());
}

// ---------- stats ----------
export function summarize(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const r = (x) => Math.round(x * 100) / 100;
  return { n: s.length, median: r(q(0.5)), p95: r(q(0.95)), min: r(s[0]), max: r(s[s.length - 1]) };
}
