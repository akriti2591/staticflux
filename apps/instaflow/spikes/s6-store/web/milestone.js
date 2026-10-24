// Milestones (§6.1), GC (§6.5) and the .iflow bundle (§9) over a Backend.
import { enc, dec, canonicalJSON, sha256Hex, deflateRaw, inflateRaw, crc32, blobPath, getBlob, readHead, casHead, sfError, ZipWriter, readZipDirectory, readZipEntry } from './core.js';

const recPath = (kind, id) => [['records', kind, id.slice(3, 5)], `${id}.json`];
const now = () => performance.now();

async function updateHead(be, lockPrefix, asset, fn) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const cur = await readHead(be, asset);
    const base = cur.head ?? { schema: 'instaflow.head/1', asset, generation: 0, engine: 'spike/1', treeSchema: 1, minReader: 1, minWriter: 1, parts: {}, logFrom: 0, undoHorizon: { steps: 200 }, milestones: [], pinned: [] };
    const res = await casHead(be, lockPrefix, asset, base.generation, fn(base));
    if (res.ok) return { ...res, attempts: attempt + 1 };
    if (res.error.code !== 'IF-STORE-003') return res;
  }
  return sfError('IF-STORE-003', 'head CAS kept conflicting', 'back off and retry');
}

/** Create a milestone from in-memory canonical parts. Writes only digests not already present. */
export async function createMilestone(be, { lockPrefix, asset, parts, name, parent }) {
  const b0 = be.stats.bytesWritten, f0 = be.stats.filesWritten;
  const t0 = now();
  const items = [...parts].map(([pid, part]) => ({ pid, bytes: enc.encode(canonicalJSON(part)) }));
  const t1 = now();
  await Promise.all(items.map(async (it) => { it.hex = await sha256Hex(it.bytes); }));
  const t2 = now();
  let newBlobs = 0;
  const refs = {};
  for (const it of items) {
    const [dir, file] = blobPath(it.hex);
    if (!(await be.exists(dir, file))) { await be.writeAtomic(dir, file, await deflateRaw(it.bytes)); newBlobs++; }
    refs[it.pid] = { digest: `sha256:${it.hex}`, size: it.bytes.length, mime: 'application/vnd.instaflow.part+json', encoding: 'deflate-raw' };
  }
  const t3 = now();
  const body = { schema: 'instaflow.milestone/1', asset, kind: 'named', name, createdAt: new Date().toISOString(), createdBy: { kind: 'system', service: 's6-spike' }, parent, treeSchema: 1, parts: refs, references: [] };
  const id = `ms_${await sha256Hex(enc.encode(canonicalJSON(body)))}`;
  const [rd, rf] = recPath('ms', id);
  await be.writeAtomic(rd, rf, enc.encode(canonicalJSON({ ...body, id })));
  const h = await updateHead(be, lockPrefix, asset, (head) => ({ ...head, milestones: [id, ...head.milestones] }));
  const t4 = now();
  return { id, ok: h.ok, newBlobs, parts: items.length, bytesWritten: be.stats.bytesWritten - b0, filesWritten: be.stats.filesWritten - f0,
    ms: { canonicalize: t1 - t0, hash: t2 - t1, blobs: t3 - t2, recordAndHead: t4 - t3, total: t4 - t0 } };
}

export async function readRecord(be, kind, id) { const [d, f] = recPath(kind, id); const b = await be.read(d, f); return b ? JSON.parse(dec.decode(b)) : null; }

/** Mark from every head (parts + milestones → parts), sweep unmarked blobs older than graceMs. */
export async function gc(be, { graceMs = 0 } = {}) {
  const start = Date.now(); const t0 = now();
  const live = new Set(); let heads = 0, records = 0;
  for (const [n] of await be.list(['heads'])) {
    if (!n.endsWith('.json') || n.includes('.tmp-')) continue;
    const h = await readHead(be, n.slice(0, -5)); if (h.status !== 'ok') return sfError('IF-STORE-002', `head ${n} unreadable; GC aborted`, 'repair head first');
    heads++;
    for (const r of Object.values(h.head.parts)) live.add(r.digest.slice(7));
    for (const ms of h.head.milestones) {
      const rec = await readRecord(be, 'ms', ms); records++;
      if (!rec) return sfError('IF-MS-001', `milestone ${ms} missing; GC aborted`, 'restore record');
      for (const r of Object.values(rec.parts)) live.add(r.digest.slice(7));
    }
  }
  const t1 = now();
  let scanned = 0, deleted = 0, kept = 0, young = 0;
  const root = await be.tryDir(['blobs', 'sha256']);
  if (root) for await (const [shard, sh] of root.entries()) {
    for await (const [name, fh] of sh.entries()) {
      scanned++;
      const hex = name.includes('.tmp-') ? null : name;
      if (hex && live.has(hex)) { kept++; continue; }
      if (graceMs > 0 && (await fh.getFile()).lastModified > start - graceMs) { young++; continue; }   // written during/after mark: protected
      await sh.removeEntry(name); deleted++;
    }
  }
  const t2 = now();
  return { ok: true, heads, records, live: live.size, scanned, kept, deleted, young, ms: { mark: t1 - t0, sweep: t2 - t1, total: t2 - t0 } };
}

const MIME = 'application/vnd.instaflow.bundle+zip';

/** Stream a milestone bundle into `sink(chunk)`. Parts are copied as their stored deflate-raw bytes (no recompress). */
export async function exportMilestone(be, msId, sink) {
  const t0 = now();
  const rec = await readRecord(be, 'ms', msId);
  if (!rec) return sfError('IF-MS-001', `milestone ${msId} missing`, 'pick another milestone');
  const zip = new ZipWriter(sink);
  await zip.add('mimetype', enc.encode(MIME));
  const manifest = { format: 'instaflow.bundle/1', minReader: 1, kind: 'milestone', roots: [{ asset: rec.asset, milestone: msId }], records: [`records/ms/${msId}.json`], featuresRequired: [], createdWith: 'instaflow/s6-spike' };
  const mb = enc.encode(canonicalJSON(manifest));
  await zip.add('manifest.json', await deflateRaw(mb), { method: 8, crc: crc32(mb), size: mb.length });
  const rb = enc.encode(canonicalJSON(rec));
  await zip.add(`records/ms/${msId}.json`, rb);
  const seen = new Set();
  for (const ref of Object.values(rec.parts)) {
    const hex = ref.digest.slice(7); if (seen.has(hex)) continue; seen.add(hex);
    const stored = await getBlob(be, hex);
    if (!stored) return sfError('IF-STORE-006', `blob ${hex} missing`, 'relink or re-create milestone');
    const raw = await inflateRaw(stored);                       // verify integrity + CRC of the decoded bytes
    if (await sha256Hex(raw) !== hex) return sfError('IF-STORE-002', `digest mismatch ${hex}`, 'quarantine');
    await zip.add(`blobs/sha256/${hex}`, stored, { method: 8, crc: crc32(raw), size: raw.length });
  }
  await zip.finish();
  return { ok: true, entries: zip.cd.length, bytes: zip.offset, ms: now() - t0 };
}

/** Import in place (central directory + Blob.slice); dedupe blobs by digest; "new document from milestone". */
export async function importBundle(be, file, { lockPrefix, newAsset }) {
  const t0 = now(); const b0 = be.stats.bytesWritten;
  const entries = await readZipDirectory(file);
  if (!entries || entries[0]?.name !== 'mimetype' || entries[0].method !== 0 || dec.decode(await readZipEntry(file, entries[0])) !== MIME)
    return sfError('IF-BUNDLE-001', 'not an Instaflow bundle', 'choose an .iflow file');
  const byName = new Map(entries.map((e) => [e.name, e]));
  const man = JSON.parse(dec.decode(await inflateRaw(await readZipEntry(file, byName.get('manifest.json')))));
  if (man.featuresRequired.length) return sfError('IF-BUNDLE-002', `unknown features ${man.featuresRequired}`, 'update Instaflow');
  let written = 0, deduped = 0;
  for (const e of entries) {
    if (!e.name.startsWith('blobs/sha256/')) continue;
    const hex = e.name.slice(13);
    const data = await readZipEntry(file, e);
    const raw = e.method === 8 ? await inflateRaw(data) : data;
    if (crc32(raw) !== e.crc || await sha256Hex(raw) !== hex) return sfError('IF-STORE-002', `digest mismatch ${hex}`, 'bundle is corrupt');
    const [d, f] = blobPath(hex);
    if (await be.exists(d, f)) { deduped++; continue; }
    await be.writeAtomic(d, f, e.method === 8 ? data : await deflateRaw(raw)); written++;
  }
  const msId = man.roots[0].milestone;
  const rec = JSON.parse(dec.decode(await readZipEntry(file, byName.get(`records/ms/${msId}.json`))));
  const [rd, rf] = recPath('ms', msId);
  if (!(await be.exists(rd, rf))) await be.writeAtomic(rd, rf, enc.encode(canonicalJSON(rec)));
  // New document from milestone: a fresh asset whose Latest starts from the canonical parts (spike: no CRDT rebuild)
  const asRec = { schema: 'instaflow.asset/1', id: newAsset, kind: 'composition', createdAt: new Date().toISOString(), createdBy: { kind: 'system', service: 's6-spike' },
    provenance: { action: 'imported', actor: { kind: 'system', service: 's6-spike' }, ingredients: [] }, createdFrom: { asset: rec.asset, milestone: msId, title: rec.name } };
  const [ad, af] = recPath('as', newAsset);
  await be.writeAtomic(ad, af, enc.encode(canonicalJSON(asRec)));
  const h = await updateHead(be, lockPrefix, newAsset, (head) => ({ ...head, parts: rec.parts }));
  return { ok: h.ok, blobsWritten: written, blobsDeduped: deduped, bytesWritten: be.stats.bytesWritten - b0, ms: now() - t0 };
}
