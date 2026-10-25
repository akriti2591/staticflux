/**
 * Commit records (DOCUMENT-FORMAT §5.2): one logical transaction — possibly
 * touching several parts (a node moved between pages) — as ONE log entry, so
 * it is persisted, replayed and undone atomically.
 *
 * Binary layout: `S F C 0x01 | u32 header length | header JSON (utf-8) | part
 * update bytes…`, header = `{ peer, meta, parts: [[partId, length]…], inverse }`.
 */
import { err, ok, type Result, toSfError } from '@staticflux/core';
import type { PartOp, PeerId, TransactionMeta } from './crdt-v2.js';
import { InvalidUpdateError } from './errors.js';
import type { PartId } from './store.js';

export interface CommitRecord {
  /** Assigned by the log on append (absent until durable). */
  readonly seq?: number;
  readonly peer: PeerId;
  readonly meta: TransactionMeta;
  /** Engine update per touched part. */
  readonly updates: Readonly<Record<PartId, Uint8Array>>;
  /** Inverse ops per touched part (apply all, as one transaction, to undo). */
  readonly inverse: Readonly<Record<PartId, readonly PartOp[]>>;
}

const MAGIC = [0x53, 0x46, 0x43, 0x01] as const;
const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

interface Header {
  readonly peer: PeerId;
  readonly meta: TransactionMeta;
  readonly parts: readonly (readonly [PartId, number])[];
  readonly inverse: Readonly<Record<PartId, readonly PartOp[]>>;
}

export function encodeCommitRecord(record: CommitRecord): Uint8Array {
  const parts = Object.entries(record.updates);
  const header: Header = { peer: record.peer, meta: record.meta, parts: parts.map(([id, bytes]) => [id, bytes.byteLength] as const), inverse: record.inverse };
  const json = encoder.encode(JSON.stringify(header));
  const total = MAGIC.length + 4 + json.byteLength + parts.reduce((n, [, b]) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, json.byteLength);
  out.set(json, MAGIC.length + 4);
  let offset = MAGIC.length + 4 + json.byteLength;
  for (const [, bytes] of parts) {
    out.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return out;
}

export function decodeCommitRecord(bytes: Uint8Array, seq?: number): Result<CommitRecord> {
  if (bytes.byteLength < MAGIC.length + 4 || MAGIC.some((b, i) => bytes[i] !== b)) {
    return err(InvalidUpdateError({ message: 'Not a StaticFlux commit record.' }));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(MAGIC.length);
  const start = MAGIC.length + 4;
  if (start + length > bytes.byteLength) return err(InvalidUpdateError({ message: 'Truncated commit record.' }));
  let header: Header;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(start, start + length))) as Header;
  } catch (error) {
    return err(InvalidUpdateError({ message: 'Malformed commit record header.', cause: toSfError(error) }));
  }
  if (typeof header?.peer !== 'string' || typeof header.meta !== 'object' || !Array.isArray(header.parts)) {
    return err(InvalidUpdateError({ message: 'Malformed commit record header.' }));
  }
  const updates: Record<PartId, Uint8Array> = {};
  let offset = start + length;
  for (const [id, size] of header.parts) {
    if (offset + size > bytes.byteLength) return err(InvalidUpdateError({ message: 'Truncated commit record body.' }));
    updates[id] = bytes.slice(offset, offset + size);
    offset += size;
  }
  return ok({ ...(seq === undefined ? {} : { seq }), peer: header.peer, meta: header.meta, updates, inverse: header.inverse ?? {} });
}

/** Rough in-memory size of a record (log-size accounting for compaction triggers). */
export function commitRecordSize(record: CommitRecord): number {
  return Object.values(record.updates).reduce((n, b) => n + b.byteLength, 0);
}
