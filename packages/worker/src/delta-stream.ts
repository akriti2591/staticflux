/**
 * Sequenced binary delta streams (SF-Δ18, ARCHITECTURE §4 E-1/E-2): the scene
 * delta stream from the editor module to the render module.
 *
 * - **Versioned records.** Every record carries `epoch`, `version` and `base`
 *   (the version it applies on top of). A snapshot starts an epoch and carries
 *   the full state at `version`.
 * - **E-1 ordered apply.** The reader applies deltas in order; a delta whose
 *   `base` is not the reader's version (a gap) or whose epoch moved without a
 *   snapshot puts the reader in `resyncing`: it asks the writer for a resnapshot
 *   and skips deltas until a snapshot of a newer epoch arrives. The caller keeps
 *   drawing its last good frame meanwhile.
 * - **Apply up to a version.** `apply(handler, { upTo: frame.docVersion })` stops
 *   before deltas newer than the view frame being drawn (S2 protocol rule: publish
 *   deltas before the frame, draw a frame only at equality).
 * - **Content-addressed refs.** Records list digests of large blobs sent through
 *   the side channel; a record whose blobs have not arrived blocks the stream
 *   (order is never broken) until they do.
 * - **Lossless under back-pressure** up to `maxPendingBytes`; beyond it the writer
 *   drops its queue and asks the app for a snapshot (SF-WK-036) — the stream heals.
 *
 * Region format (format 1): Int32 words [0] write pos (bytes) [1] read pos [2] magic 'SFDS' [3] format
 * [4] schema version [5] id hash [6] capacity (bytes, 2^n) [7] closed [8] resnapshot requests [9] epoch;
 * records from byte 64, 8-aligned, never split (a wrap marker 0xFFFFFFFF skips the tail):
 *   u32 length · u8 kind · u8 flags · u16 refs bytes · u32 epoch · u32 payload bytes · f64 version · f64 base ·
 *   refs (u16 count, then u8 length + ASCII digest each) · payload (8-aligned)
 *
 * @example
 * export const SceneDeltas = defineDeltaStream({ id: 'instaflow/scene-deltas', capacityBytes: 1 << 21 });
 * const deltas = unwrap(createDeltaStream(SceneDeltas, { medium }));       // editor
 * deltas.snapshot({ version: doc.version, payload: encodeScene(doc) });
 * deltas.onResnapshot(() => deltas.snapshot({ version: doc.version, payload: encodeScene(doc) }));
 * deltas.append({ version: v, payload: encodeChanges(tx) });
 * const scene = unwrap(await attachDeltaStream(SceneDeltas, endpoint));     // render
 * scene.apply((record) => applyToIr(record), { upTo: frame.docVersion, blobs });
 */
import { createMachine, defineMachine, err, type Machine, ok, type Result } from '@staticflux/core';
import type { ChannelId } from './envelope.js';
import { fnv1aString } from './hash.js';
import { DeltaOrderError, PipeClosedError, PipeMismatchError, PipeOverflowError, RecordTooLargeError } from './pipeline-errors.js';
import type { PushOutcome } from './record-ring.js';
import {
  attachRegion,
  type AttachRegionOptions,
  createRegion,
  type CreateRegionOptions,
  type PipeMedium,
  type RegionEndpoint,
  type RegionWaitOptions,
} from './region.js';
import { checkPipeHeader } from './seqlock-cell.js';

export const DELTA_MAGIC = 0x53464453; // 'SFDS'
export const DELTA_FORMAT = 1;
export const DELTA_HEADER_BYTES = 64;
export const DELTA_RECORD_HEADER_BYTES = 32;

const W_WRITE = 0;
const W_READ = 1;
const W_MAGIC = 2;
const W_FORMAT = 3;
const W_SCHEMA = 4;
const W_ID = 5;
const W_CAPACITY = 6;
const W_CLOSED = 7;
const W_RESNAP = 8;
const W_EPOCH = 9;

const WRAP = 0xffffffff;
const KIND_DELTA = 1;
const KIND_SNAPSHOT = 2;

const roundUp8 = (n: number): number => Math.ceil(n / 8) * 8;
const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
const DIGEST = /^[\x21-\x7e]{1,255}$/;

export interface DeltaStreamDefinition<Id extends ChannelId = ChannelId> {
  readonly kind: 'delta-stream';
  readonly id: Id;
  /** Ring bytes (power of two). A record may use at most half. */
  readonly capacityBytes: number;
  /** Schema version of the payload encoding: attach fails across versions. */
  readonly version: number;
}

export function defineDeltaStream<const Id extends ChannelId>(declaration: {
  readonly id: Id;
  readonly capacityBytes?: number;
  readonly version?: number;
}): DeltaStreamDefinition<Id> {
  const capacityBytes = declaration.capacityBytes ?? 1 << 20;
  if (!isPowerOfTwo(capacityBytes) || capacityBytes < 256 || capacityBytes > 1 << 29) {
    throw PipeMismatchError({ message: `Delta stream "${declaration.id}" capacityBytes must be a power of two in [256, 2^29].`, details: { capacityBytes } });
  }
  return Object.freeze({ kind: 'delta-stream', id: declaration.id, capacityBytes, version: declaration.version ?? 1 });
}

export function deltaStreamByteLength(definition: DeltaStreamDefinition): number {
  return DELTA_HEADER_BYTES + definition.capacityBytes;
}

export type DeltaRecordKind = 'delta' | 'snapshot';

export interface DeltaAppend {
  /** Version after this delta (strictly increasing). */
  readonly version: number;
  /** Version the delta applies to. Default: the previous record's version. */
  readonly base?: number;
  readonly payload?: Uint8Array;
  /** Digests of side-channel blobs the record needs. */
  readonly refs?: readonly string[];
  /** App-defined bits (0–255). */
  readonly flags?: number;
}

export interface DeltaSnapshot {
  readonly version: number;
  readonly payload?: Uint8Array;
  readonly refs?: readonly string[];
  readonly flags?: number;
}

export interface DeltaWriterStats {
  readonly records: number;
  readonly snapshots: number;
  /** Bytes currently queued under back-pressure. */
  readonly pendingBytes: number;
  readonly maxPendingBytes: number;
  /** Times the queue overflowed (deltas dropped, resnapshot requested). */
  readonly overflows: number;
}

export interface DeltaStreamWriter {
  readonly id: ChannelId;
  readonly medium: PipeMedium;
  /** Current epoch (0 before the first snapshot). */
  readonly epoch: number;
  /** Version of the last record. */
  readonly version: number;
  /** True while a resnapshot was requested (by the reader or an overflow) and not yet written. */
  readonly resnapshotRequested: boolean;
  readonly closed: boolean;
  /** Append a delta. Fails with SF-WK-034 on a non-increasing version and SF-WK-036 while a snapshot is owed. */
  append(record: DeltaAppend): Result<PushOutcome>;
  /** Start a new epoch with the full state; drops queued deltas it supersedes. */
  snapshot(record: DeltaSnapshot): Result<PushOutcome>;
  /** Publish queued records as space allows. True when nothing is queued. */
  flush(): boolean;
  /** Called when a resnapshot is requested (reader gap, respawned reader, or overflow). */
  onResnapshot(listener: (reason: 'reader' | 'overflow') => void): () => void;
  endpoint(): Result<RegionEndpoint>;
  readonly stats: DeltaWriterStats;
  close(): void;
}

export interface DeltaRecordHeader {
  readonly kind: DeltaRecordKind;
  readonly epoch: number;
  readonly version: number;
  /** NaN for snapshots. */
  readonly base: number;
  readonly flags: number;
}

export interface DeltaRecord extends DeltaRecordHeader {
  readonly refs: readonly string[];
  /** View into the stream memory: valid only during the handler call (copy to keep). */
  readonly payload: Uint8Array;
}

/** Where a reader looks up side-channel blobs (see `createBlobReceiver`). */
export interface BlobResolver {
  has(digest: string): boolean;
  /** Ask the sender for blobs that are missing (re-send, or `gone`). */
  request(digests: readonly string[]): void;
  /** The blob cannot be recovered (the reader resnapshots). */
  gone(digest: string): boolean;
}

export interface DeltaApplyOptions {
  /** Do not apply deltas newer than this version (the view frame's docVersion). */
  readonly upTo?: number;
  /** Apply at most this many records. */
  readonly max?: number;
  /** Blob resolver for records with refs. Without it, refs are not checked. */
  readonly blobs?: BlobResolver;
}

export type DeltaApplyOutcome = 'drained' | 'limit' | 'blocked' | 'resyncing';

export interface DeltaApplyReport {
  readonly applied: number;
  readonly skipped: number;
  readonly outcome: DeltaApplyOutcome;
  /** Digests the stream waits for (`outcome: 'blocked'`). */
  readonly blockedOn: readonly string[];
}

export const DeltaReaderLifecycle = defineMachine({
  id: 'worker/delta-reader',
  initial: 'awaiting-snapshot',
  states: ['awaiting-snapshot', 'live', 'resyncing', 'closed'],
  transitions: {
    'awaiting-snapshot': { snapshot: 'live', close: 'closed' },
    live: { snapshot: 'live', gap: 'resyncing', close: 'closed' },
    resyncing: { snapshot: 'live', gap: 'resyncing', close: 'closed' },
  },
  terminal: ['closed'],
});

export type DeltaReaderState = (typeof DeltaReaderLifecycle.states)[number];
export type DeltaReaderEvent = 'snapshot' | 'gap' | 'close';

export interface DeltaReaderStats {
  readonly applied: number;
  readonly snapshots: number;
  readonly gaps: number;
  /** Records skipped: older epoch, or deltas while waiting for a snapshot. */
  readonly staleSkipped: number;
  readonly blocked: number;
  readonly resnapshotRequests: number;
}

export interface DeltaStreamReader {
  readonly id: ChannelId;
  readonly medium: PipeMedium;
  readonly state: DeltaReaderState;
  readonly machine: Machine<DeltaReaderState, DeltaReaderEvent>;
  readonly epoch: number;
  /** Version of the last applied record (the committed state). */
  readonly version: number;
  readonly closed: boolean;
  /** Next record's header without consuming it. */
  peek(): DeltaRecordHeader | undefined;
  /** Apply records in order (see the module header for the rules). */
  apply(handler: (record: DeltaRecord) => void, options?: DeltaApplyOptions): DeltaApplyReport;
  /** Ask the writer for a snapshot now (e.g. a respawned reader with no state). */
  requestResnapshot(): void;
  /** Resolve `ok(true)` when unread records exist. */
  wait(options?: RegionWaitOptions): Promise<Result<boolean>>;
  readonly stats: DeltaReaderStats;
  close(): void;
}

// ---------------------------------------------------------------- encoding

function refsBytes(refs: readonly string[]): number {
  if (refs.length === 0) return 0;
  return roundUp8(2 + refs.reduce((sum, ref) => sum + 1 + ref.length, 0));
}

function encodeRecord(
  kind: number,
  epoch: number,
  version: number,
  base: number,
  flags: number,
  refs: readonly string[],
  payload: Uint8Array,
): Uint8Array {
  const refBytes = refsBytes(refs);
  const payloadOffset = DELTA_RECORD_HEADER_BYTES + refBytes;
  const length = roundUp8(payloadOffset + payload.byteLength);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length, true);
  view.setUint8(4, kind);
  view.setUint8(5, flags & 0xff);
  view.setUint16(6, refBytes, true);
  view.setUint32(8, epoch >>> 0, true);
  view.setUint32(12, payload.byteLength, true);
  view.setFloat64(16, version, true);
  view.setFloat64(24, base, true);
  if (refs.length > 0) {
    let at = DELTA_RECORD_HEADER_BYTES;
    view.setUint16(at, refs.length, true);
    at += 2;
    for (const ref of refs) {
      out[at++] = ref.length;
      for (let i = 0; i < ref.length; i++) out[at++] = ref.charCodeAt(i);
    }
  }
  out.set(payload, payloadOffset);
  return out;
}

function checkRefs(refs: readonly string[] | undefined): Result<readonly string[]> {
  const list = refs ?? [];
  for (const ref of list) {
    if (!DIGEST.test(ref)) return err(RecordTooLargeError({ message: 'Digests must be 1–255 printable ASCII characters.', details: { ref } }));
  }
  return ok(list);
}

const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------- writer

export interface CreateDeltaStreamOptions extends Omit<CreateRegionOptions, 'byteLength'> {
  /** Queue limit under back-pressure. Default 4 × capacityBytes. */
  readonly maxPendingBytes?: number;
}

export function createDeltaStream(definition: DeltaStreamDefinition, options: CreateDeltaStreamOptions): Result<DeltaStreamWriter> {
  const created = createRegion({ ...options, byteLength: deltaStreamByteLength(definition) });
  if (!created.ok) return created;
  const region = created.value;
  const { words } = region;
  const capacity = definition.capacityBytes;
  const mask = capacity - 1;
  words[W_MAGIC] = DELTA_MAGIC;
  words[W_FORMAT] = DELTA_FORMAT;
  words[W_SCHEMA] = definition.version;
  words[W_ID] = fnv1aString(definition.id);
  words[W_CAPACITY] = capacity;
  region.publish([W_MAGIC, W_FORMAT, W_SCHEMA, W_ID, W_CAPACITY], [[0, DELTA_HEADER_BYTES]]);

  const maxPendingBytes = options.maxPendingBytes ?? capacity * 4;
  const pending: Uint8Array[] = [];
  const listeners = new Set<(reason: 'reader' | 'overflow') => void>();
  const stats = { records: 0, snapshots: 0, maxPendingBytes: 0, overflows: 0 };
  let pendingBytes = 0;
  let epoch = 0;
  let version = 0;
  let owed = false; // a snapshot is owed (requested and not yet written)
  let overflowOwed = false; // owed because the queue overflowed: deltas are dropped until the snapshot
  let seenRequests = 0;
  let closed = false;
  let retrying = false;
  // Aborted on close: stops the request watcher and the back-pressure retry.
  const lifetime = new AbortController();

  const requestSnapshot = (reason: 'reader' | 'overflow'): void => {
    owed = true;
    for (const listener of [...listeners]) listener(reason);
  };
  const checkRequests = (): void => {
    const requests = Atomics.load(words, W_RESNAP);
    if (requests === seenRequests) return;
    seenRequests = requests;
    requestSnapshot('reader');
  };
  const watchRequests = (): void => {
    if (closed) return;
    void region.wait(W_RESNAP, seenRequests, { signal: lifetime.signal }).then((result) => {
      if (closed || !result.ok) return;
      checkRequests();
      watchRequests();
    });
  };

  /** Try to place one encoded record. Returns false when it does not fit yet. */
  const place = (record: Uint8Array): boolean => {
    const w = Atomics.load(words, W_WRITE);
    const r = Atomics.load(words, W_READ);
    const free = capacity - ((w - r) | 0);
    const pos = (w >>> 0) & mask;
    const tail = capacity - pos;
    const need = record.byteLength <= tail ? record.byteLength : tail + record.byteLength;
    if (need > free) return false;
    let at = pos;
    let next = w;
    const ranges: [number, number][] = [];
    if (record.byteLength > tail) {
      region.view.setUint32(DELTA_HEADER_BYTES + pos, WRAP, true);
      ranges.push([DELTA_HEADER_BYTES + pos, DELTA_HEADER_BYTES + pos + 4]);
      next = (next + tail) | 0;
      at = 0;
    }
    region.bytes.set(record, DELTA_HEADER_BYTES + at);
    ranges.push([DELTA_HEADER_BYTES + at, DELTA_HEADER_BYTES + at + record.byteLength]);
    Atomics.store(words, W_WRITE, (next + record.byteLength) | 0);
    region.publish([W_WRITE], ranges);
    return true;
  };

  const flush = (): boolean => {
    if (closed) return pending.length === 0;
    while (pending.length > 0 && place(pending[0] as Uint8Array)) {
      pendingBytes -= (pending.shift() as Uint8Array).byteLength;
    }
    if (pending.length > 0) scheduleRetry();
    return pending.length === 0;
  };

  const scheduleRetry = (): void => {
    if (retrying || closed) return;
    retrying = true;
    void region.wait(W_READ, Atomics.load(words, W_READ), { signal: lifetime.signal, timeoutMs: 50 }).then(() => {
      retrying = false;
      if (!closed) flush();
    });
  };

  const enqueue = (record: Uint8Array): Result<PushOutcome> => {
    if (record.byteLength > capacity / 2) {
      return err(RecordTooLargeError({ details: { pipe: definition.id, bytes: record.byteLength, capacityBytes: capacity } }));
    }
    if (pending.length === 0 && place(record)) return ok('written');
    if (pendingBytes + record.byteLength > maxPendingBytes) {
      pending.length = 0;
      pendingBytes = 0;
      stats.overflows += 1;
      requestSnapshot('overflow');
      return err(PipeOverflowError({ details: { pipe: definition.id, maxPendingBytes } }));
    }
    pending.push(record);
    pendingBytes += record.byteLength;
    stats.maxPendingBytes = Math.max(stats.maxPendingBytes, pendingBytes);
    flush();
    return ok(pending.length === 0 ? 'written' : 'queued');
  };

  watchRequests();

  return ok({
    id: definition.id,
    medium: region.medium,
    get epoch() {
      return epoch;
    },
    get version() {
      return version;
    },
    get resnapshotRequested() {
      checkRequests();
      return owed;
    },
    get closed() {
      return closed;
    },
    append(record) {
      if (closed) return err(PipeClosedError({ details: { pipe: definition.id } }));
      checkRequests();
      if (!(record.version > version) || !Number.isFinite(record.version)) {
        return err(DeltaOrderError({ details: { pipe: definition.id, version: record.version, previous: version } }));
      }
      if (overflowOwed) {
        // Deltas after an overflow are meaningless until the snapshot: the reader resyncs from it.
        version = record.version;
        return err(PipeOverflowError({ message: 'A snapshot is owed after an overflow; the delta was dropped.', details: { pipe: definition.id } }));
      }
      const refs = checkRefs(record.refs);
      if (!refs.ok) return refs;
      const encoded = encodeRecord(KIND_DELTA, epoch, record.version, record.base ?? version, record.flags ?? 0, refs.value, record.payload ?? EMPTY);
      const result = enqueue(encoded);
      if (result.ok) {
        version = record.version;
        stats.records += 1;
      } else if (result.error.code === PipeOverflowError.code) {
        version = record.version;
        overflowOwed = true;
      }
      return result;
    },
    snapshot(record) {
      if (closed) return err(PipeClosedError({ details: { pipe: definition.id } }));
      const refs = checkRefs(record.refs);
      if (!refs.ok) return refs;
      checkRequests();
      const nextEpoch = epoch + 1;
      const encoded = encodeRecord(KIND_SNAPSHOT, nextEpoch, record.version, Number.NaN, record.flags ?? 0, refs.value, record.payload ?? EMPTY);
      // A snapshot supersedes every queued delta.
      pending.length = 0;
      pendingBytes = 0;
      const result = enqueue(encoded);
      if (!result.ok) return result;
      epoch = nextEpoch;
      version = record.version;
      owed = false;
      overflowOwed = false;
      stats.records += 1;
      stats.snapshots += 1;
      Atomics.store(words, W_EPOCH, epoch);
      region.publish([W_EPOCH]);
      return result;
    },
    flush,
    onResnapshot(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    endpoint: () => (closed ? err(PipeClosedError({ details: { pipe: definition.id } })) : region.endpoint()),
    get stats() {
      return { ...stats, pendingBytes };
    },
    close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      pending.length = 0;
      pendingBytes = 0;
      Atomics.store(words, W_CLOSED, 1);
      region.publish([W_CLOSED]);
      region.close();
    },
  });
}

// ---------------------------------------------------------------- reader

export async function attachDeltaStream(
  definition: DeltaStreamDefinition,
  endpoint: RegionEndpoint,
  options: AttachRegionOptions = {},
): Promise<Result<DeltaStreamReader>> {
  if (endpoint.byteLength !== deltaStreamByteLength(definition)) {
    return err(PipeMismatchError({ details: { pipe: definition.id, byteLength: endpoint.byteLength } }));
  }
  const attached = await attachRegion(endpoint, options);
  if (!attached.ok) return attached;
  const region = attached.value;
  const header = checkPipeHeader(
    region,
    { id: definition.id, magic: DELTA_MAGIC, format: DELTA_FORMAT, schema: definition.version },
    { magic: W_MAGIC, format: W_FORMAT, schema: W_SCHEMA, id: W_ID },
  );
  if (!header.ok || Atomics.load(region.words, W_CAPACITY) !== definition.capacityBytes) {
    region.close();
    return header.ok ? err(PipeMismatchError({ details: { pipe: definition.id } })) : header;
  }
  const { words, view } = region;
  const capacity = definition.capacityBytes;
  const mask = capacity - 1;
  const machine = createMachine(DeltaReaderLifecycle);
  const stats = { applied: 0, snapshots: 0, gaps: 0, staleSkipped: 0, blocked: 0, resnapshotRequests: 0 };
  let epoch = 0;
  let version = 0;
  let minEpoch = 0; // snapshots older than this are stale
  let closed = false;

  /** Position of the next record (skipping a wrap marker), or undefined when empty. */
  const nextPosition = (): { read: number; at: number } | undefined => {
    const w = Atomics.load(words, W_WRITE);
    let r = Atomics.load(words, W_READ);
    if (((w - r) | 0) <= 0) return undefined;
    let pos = (r >>> 0) & mask;
    if (view.getUint32(DELTA_HEADER_BYTES + pos, true) === WRAP) {
      r = (r + (capacity - pos)) | 0;
      pos = 0;
      if (((w - r) | 0) <= 0) return undefined;
    }
    return { read: r, at: DELTA_HEADER_BYTES + pos };
  };
  const headerAt = (at: number): DeltaRecordHeader & { length: number; refBytes: number; payloadBytes: number } => ({
    length: view.getUint32(at, true),
    kind: view.getUint8(at + 4) === KIND_SNAPSHOT ? 'snapshot' : 'delta',
    flags: view.getUint8(at + 5),
    refBytes: view.getUint16(at + 6, true),
    epoch: view.getUint32(at + 8, true),
    payloadBytes: view.getUint32(at + 12, true),
    version: view.getFloat64(at + 16, true),
    base: view.getFloat64(at + 24, true),
  });
  const refsAt = (at: number, refBytes: number): string[] => {
    if (refBytes === 0) return [];
    let p = at + DELTA_RECORD_HEADER_BYTES;
    const count = view.getUint16(p, true);
    p += 2;
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const length = view.getUint8(p++);
      let text = '';
      for (let j = 0; j < length; j++) text += String.fromCharCode(view.getUint8(p++));
      out.push(text);
    }
    return out;
  };

  const requestResnapshot = (): void => {
    stats.resnapshotRequests += 1;
    Atomics.add(words, W_RESNAP, 1);
    region.publish([W_RESNAP]);
  };
  const gap = (): void => {
    stats.gaps += 1;
    minEpoch = epoch + 1;
    machine.send('gap');
    requestResnapshot();
  };

  const reader: DeltaStreamReader = {
    id: definition.id,
    medium: region.medium,
    machine,
    get state() {
      return machine.state;
    },
    get epoch() {
      return epoch;
    },
    get version() {
      return version;
    },
    get closed() {
      return closed || Atomics.load(words, W_CLOSED) === 1;
    },
    peek() {
      const next = nextPosition();
      if (next === undefined) return undefined;
      const { kind, epoch: e, version: v, base, flags } = headerAt(next.at);
      return { kind, epoch: e, version: v, base, flags };
    },
    apply(handler, applyOptions = {}) {
      const max = applyOptions.max ?? Infinity;
      let applied = 0;
      let skipped = 0;
      let outcome: DeltaApplyOutcome = 'drained';
      let blockedOn: readonly string[] = [];
      let consumedTo: number | undefined;
      try {
        while (!closed) {
          if (applied >= max) {
            outcome = 'limit';
            break;
          }
          const next = nextPosition();
          if (next === undefined) break;
          const h = headerAt(next.at);
          const consume = (): void => {
            consumedTo = (next.read + h.length) | 0;
            Atomics.store(words, W_READ, consumedTo);
          };
          const waiting = machine.state !== 'live';
          if (h.kind === 'snapshot') {
            const accept = waiting ? h.epoch >= minEpoch : h.epoch > epoch;
            if (!accept) {
              stats.staleSkipped += 1;
              skipped += 1;
              consume();
              continue;
            }
          } else {
            if (waiting || h.epoch < epoch) {
              stats.staleSkipped += 1;
              skipped += 1;
              consume();
              continue;
            }
            if (applyOptions.upTo !== undefined && h.version > applyOptions.upTo) {
              outcome = 'limit';
              break;
            }
            if (h.epoch > epoch || h.base !== version) {
              gap(); // E-1: keep the last good frame, wait for a snapshot of a newer epoch
              outcome = 'resyncing';
              continue;
            }
          }
          const refs = refsAt(next.at, h.refBytes);
          if (refs.length > 0 && applyOptions.blobs !== undefined) {
            const blobs = applyOptions.blobs;
            const missing = refs.filter((digest) => !blobs.has(digest));
            if (missing.some((digest) => blobs.gone(digest))) {
              if (h.kind === 'snapshot') minEpoch = h.epoch + 1;
              consume();
              skipped += 1;
              if (machine.state === 'live') gap();
              else requestResnapshot();
              outcome = 'resyncing';
              continue;
            }
            if (missing.length > 0) {
              stats.blocked += 1;
              blobs.request(missing);
              outcome = 'blocked';
              blockedOn = missing;
              break;
            }
          }
          const payloadAt = next.at + DELTA_RECORD_HEADER_BYTES + h.refBytes;
          handler({
            kind: h.kind,
            epoch: h.epoch,
            version: h.version,
            base: h.base,
            flags: h.flags,
            refs,
            payload: region.bytes.subarray(payloadAt, payloadAt + h.payloadBytes),
          });
          consume();
          applied += 1;
          stats.applied += 1;
          version = h.version;
          if (h.kind === 'snapshot') {
            epoch = h.epoch;
            minEpoch = h.epoch;
            stats.snapshots += 1;
            machine.send('snapshot');
            if (outcome === 'resyncing') outcome = 'drained';
          }
        }
      } finally {
        if (consumedTo !== undefined) region.publish([W_READ]);
      }
      if (outcome === 'drained' && machine.state === 'resyncing') outcome = 'resyncing';
      return { applied, skipped, outcome, blockedOn };
    },
    requestResnapshot() {
      if (machine.state === 'live') minEpoch = epoch + 1;
      requestResnapshot();
    },
    async wait(waitOptions = {}) {
      if (nextPosition() !== undefined) return ok(true);
      if (closed || Atomics.load(words, W_CLOSED) === 1) return err(PipeClosedError({ details: { pipe: definition.id } }));
      return region.wait(W_WRITE, Atomics.load(words, W_WRITE), waitOptions);
    },
    get stats() {
      return { ...stats };
    },
    close() {
      if (closed) return;
      closed = true;
      if (machine.can('close')) machine.send('close');
      region.close();
    },
  };
  // A reader joining a running stream (respawn) has no state: ask for a snapshot unless one is next.
  if (Atomics.load(words, W_EPOCH) > 0 && reader.peek()?.kind !== 'snapshot') reader.requestResnapshot();
  return ok(reader);
}
