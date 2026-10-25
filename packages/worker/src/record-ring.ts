/**
 * Record rings (SF-Δ18, SF-Δ22): lossless single-producer / multi-consumer rings
 * of fixed-size records described with `defineLayout` — the binary input ring
 * (main → editor, plus the render worker for the camera fast path) is one.
 *
 * - Lossless: every reader sees every record pushed after its endpoint was made.
 *   When the slowest reader lags by `capacity` records the writer queues records
 *   (up to `maxPending`) and flushes them as readers advance (S2: pending queue
 *   under back-pressure). Beyond `maxPending` the push fails with SF-WK-036.
 * - Each reader has its own cursor; a closed reader stops holding the writer back.
 * - Same code on every medium (`local`, `shared`, `message`).
 *
 * Region format (format 1): Int32 words
 *   [0] write count [1] magic 'SFRR' [2] format [3] schema version [4] id hash [5] capacity (records, 2^n)
 *   [6] stride [7] readers [8] closed; [16 + 2i] cursor of reader i, [17 + 2i] reader i detached.
 *   Records at byte `headerBytes` (16-aligned): slot = seq & (capacity - 1).
 *
 * @example
 * export const InputRing = defineRecordRing({ id: 'surface/input', layout: InputRecordLayout, capacity: 4096, readers: 2 });
 * const ring = unwrap(createRecordRing(InputRing, { medium }));
 * ring.push((r) => { r.type = InputCode.pointerMove; r.x = 10; r.y = 20; });
 * const editor = unwrap(await attachRecordRing(InputRing, unwrap(ring.endpoint(0))));
 * editor.drain((r, seq) => reduce(r));
 */
import { err, ok, type Result } from '@staticflux/core';
import type { ChannelId } from './envelope.js';
import { fnv1aString } from './hash.js';
import type { Layout, LayoutFields, LayoutRecord, StructView } from './layout.js';
import { PipeClosedError, PipeEndpointTakenError, PipeMismatchError, PipeOverflowError } from './pipeline-errors.js';
import {
  attachRegion,
  type AttachRegionOptions,
  createRegion,
  type CreateRegionOptions,
  type PipeMedium,
  type RegionEndpoint,
  type RegionSide,
  type RegionWaitOptions,
} from './region.js';
import { checkPipeHeader } from './seqlock-cell.js';

export const RING_RECORD_MAGIC = 0x53465252; // 'SFRR'
export const RING_RECORD_FORMAT = 1;
export const MAX_RING_READERS = 8;

const W_WRITE = 0;
const W_MAGIC = 1;
const W_FORMAT = 2;
const W_SCHEMA = 3;
const W_ID = 4;
const W_CAPACITY = 5;
const W_STRIDE = 6;
const W_READERS = 7;
const W_CLOSED = 8;
const W_CURSORS = 16;

const cursorWord = (reader: number): number => W_CURSORS + 2 * reader;
const detachedWord = (reader: number): number => W_CURSORS + 2 * reader + 1;
const roundUp16 = (n: number): number => Math.ceil(n / 16) * 16;
const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

export interface RecordRingDefinition<F extends LayoutFields = LayoutFields> {
  readonly kind: 'record-ring';
  readonly id: ChannelId;
  readonly layout: Layout<F>;
  /** Slots (power of two). */
  readonly capacity: number;
  /** Reader slots (each reader index gets one endpoint). */
  readonly readers: number;
  readonly version: number;
}

export function defineRecordRing<const Id extends ChannelId, F extends LayoutFields>(declaration: {
  readonly id: Id;
  readonly layout: Layout<F>;
  readonly capacity?: number;
  readonly readers?: number;
  readonly version?: number;
}): RecordRingDefinition<F> {
  const capacity = declaration.capacity ?? 1024;
  const readers = declaration.readers ?? 1;
  if (!isPowerOfTwo(capacity) || capacity > 1 << 20) {
    throw PipeMismatchError({ message: `Record ring "${declaration.id}" capacity must be a power of two ≤ 2^20.`, details: { capacity } });
  }
  if (!Number.isInteger(readers) || readers < 1 || readers > MAX_RING_READERS) {
    throw PipeMismatchError({ message: `Record ring "${declaration.id}" supports 1–${MAX_RING_READERS} readers.`, details: { readers } });
  }
  return Object.freeze({ kind: 'record-ring', id: declaration.id, layout: declaration.layout, capacity, readers, version: declaration.version ?? 1 });
}

/** Header bytes (records start here). */
export function recordRingHeaderBytes(definition: RecordRingDefinition): number {
  return roundUp16((W_CURSORS + 2 * definition.readers) * 4);
}

/** Region bytes of a record ring. */
export function recordRingByteLength(definition: RecordRingDefinition): number {
  return recordRingHeaderBytes(definition) + roundUp16(definition.capacity * definition.layout.stride);
}

export type PushOutcome = 'written' | 'queued';

export interface RecordRingStats {
  readonly pushed: number;
  /** Records currently queued under back-pressure. */
  readonly pending: number;
  /** Largest queue seen. */
  readonly maxPending: number;
  /** Records refused because the queue was full. */
  readonly dropped: number;
}

export interface RecordRingWriter<F extends LayoutFields = LayoutFields> {
  readonly id: ChannelId;
  readonly medium: PipeMedium;
  readonly closed: boolean;
  /** Fill one record. Written in place when there is room, else copied to the pending queue. */
  push(fill: (record: LayoutRecord<F>) => void): Result<PushOutcome>;
  /** Move queued records into the ring as space allows. Returns how many moved. */
  flush(): number;
  /** Endpoint for reader `reader` (0-based, once each). The reader sees records pushed from now on. */
  endpoint(reader: number): Result<RegionEndpoint>;
  /** Forget a reader that died (respawn): it stops holding the writer back and its index can get a new endpoint. */
  release(reader: number): void;
  readonly stats: RecordRingStats;
  close(): void;
}

export interface RecordRingReader<F extends LayoutFields = LayoutFields> {
  readonly id: ChannelId;
  readonly medium: PipeMedium;
  readonly reader: number;
  /** Records ready to drain. */
  readonly available: number;
  readonly closed: boolean;
  /** Consume up to `max` records in order. `record` is a flyweight valid during the call. Returns the count. */
  drain(consume: (record: LayoutRecord<F>, seq: number) => void, max?: number): number;
  /** Resolve `ok(true)` when records are available. */
  wait(options?: RegionWaitOptions): Promise<Result<boolean>>;
  /** Blocking wait (shared medium, workers only). */
  waitSync(timeoutMs: number): 'ok' | 'timed-out' | 'unsupported';
  close(): void;
}

export interface CreateRecordRingOptions extends Omit<CreateRegionOptions, 'byteLength'> {
  /** Queue limit under back-pressure. Default 4 × capacity. */
  readonly maxPending?: number;
}

function viewOver<F extends LayoutFields>(definition: RecordRingDefinition<F>, region: RegionSide): StructView<F> {
  const view = definition.layout.view(region.buffer, { byteOffset: recordRingHeaderBytes(definition), count: definition.capacity });
  if (!view.ok) throw view.error;
  return view.value;
}

export function createRecordRing<F extends LayoutFields>(
  definition: RecordRingDefinition<F>,
  options: CreateRecordRingOptions,
): Result<RecordRingWriter<F>> {
  const created = createRegion({ ...options, byteLength: recordRingByteLength(definition) });
  if (!created.ok) return created;
  const region = created.value;
  const { words } = region;
  const { capacity, readers } = definition;
  const stride = definition.layout.stride;
  const dataOffset = recordRingHeaderBytes(definition);
  words[W_MAGIC] = RING_RECORD_MAGIC;
  words[W_FORMAT] = RING_RECORD_FORMAT;
  words[W_SCHEMA] = definition.version;
  words[W_ID] = fnv1aString(definition.id);
  words[W_CAPACITY] = capacity;
  words[W_STRIDE] = stride;
  words[W_READERS] = readers;
  region.publish([W_MAGIC, W_FORMAT, W_SCHEMA, W_ID, W_CAPACITY, W_STRIDE, W_READERS], [[0, dataOffset]]);

  const view = viewOver(definition, region);
  const scratch = definition.layout.allocate(1);
  const scratchBytes = new Uint8Array(scratch.buffer, 0, stride);
  const maxPending = options.maxPending ?? capacity * 4;
  const registered = new Set<number>();
  const pending: Uint8Array[] = [];
  const stats = { pushed: 0, maxPending: 0, dropped: 0 };
  let closed = false;
  let retrying = false;
  // Aborted on close: stops the back-pressure retry loop.
  const lifetime = new AbortController();

  const slowest = (): { reader: number; cursor: number } | undefined => {
    const w = Atomics.load(words, W_WRITE);
    let best: { reader: number; cursor: number } | undefined;
    for (const reader of registered) {
      if (Atomics.load(words, detachedWord(reader)) === 1) continue;
      const cursor = Atomics.load(words, cursorWord(reader));
      if (best === undefined || ((w - cursor) | 0) > ((w - best.cursor) | 0)) best = { reader, cursor };
    }
    return best;
  };
  const free = (): number => {
    const lagging = slowest();
    if (lagging === undefined) return capacity; // no reader: records are not retained for anyone
    return capacity - ((Atomics.load(words, W_WRITE) - lagging.cursor) | 0);
  };
  const slotOffset = (seq: number): number => dataOffset + ((seq >>> 0) & (capacity - 1)) * stride;

  const publishRange = (fromSeq: number, count: number): void => {
    if (count === 0) return;
    const first = (fromSeq >>> 0) & (capacity - 1);
    const end = first + count;
    const ranges: [number, number][] =
      end <= capacity
        ? [[dataOffset + first * stride, dataOffset + end * stride]]
        : [
            [dataOffset + first * stride, dataOffset + capacity * stride],
            [dataOffset, dataOffset + (end - capacity) * stride],
          ];
    region.publish([W_WRITE], ranges);
  };

  const flush = (): number => {
    if (closed || pending.length === 0) return 0;
    const start = Atomics.load(words, W_WRITE);
    let moved = 0;
    let room = free();
    while (pending.length > 0 && room > 0) {
      region.bytes.set(pending.shift() as Uint8Array, slotOffset((start + moved) | 0));
      moved += 1;
      room -= 1;
    }
    if (moved > 0) {
      Atomics.store(words, W_WRITE, (start + moved) | 0);
      publishRange(start, Math.min(moved, capacity));
    }
    if (pending.length > 0) scheduleRetry();
    return moved;
  };

  const scheduleRetry = (): void => {
    if (retrying || closed || pending.length === 0) return;
    const lagging = slowest();
    if (lagging === undefined) {
      flush();
      return;
    }
    retrying = true;
    // Bounded wait: a reader that detaches (or is released) changes no cursor, so re-check periodically.
    void region.wait(cursorWord(lagging.reader), lagging.cursor, { signal: lifetime.signal, timeoutMs: 50 }).then(() => {
      retrying = false;
      if (!closed) flush();
    });
  };

  return ok({
    id: definition.id,
    medium: region.medium,
    get closed() {
      return closed;
    },
    push(fill) {
      if (closed) return err(PipeClosedError({ details: { pipe: definition.id } }));
      if (pending.length === 0 && free() > 0) {
        const seq = Atomics.load(words, W_WRITE);
        fill(view.at((seq >>> 0) & (capacity - 1)));
        Atomics.store(words, W_WRITE, (seq + 1) | 0);
        publishRange(seq, 1);
        stats.pushed += 1;
        return ok('written');
      }
      if (pending.length >= maxPending) {
        stats.dropped += 1;
        return err(PipeOverflowError({ details: { pipe: definition.id, pending: pending.length } }));
      }
      scratchBytes.fill(0);
      fill(scratch.at(0));
      pending.push(scratchBytes.slice());
      stats.pushed += 1;
      stats.maxPending = Math.max(stats.maxPending, pending.length);
      flush();
      return ok(pending.length === 0 ? 'written' : 'queued');
    },
    flush,
    endpoint(reader) {
      if (closed) return err(PipeClosedError({ details: { pipe: definition.id } }));
      if (!Number.isInteger(reader) || reader < 0 || reader >= readers) {
        return err(PipeMismatchError({ message: `Reader index ${String(reader)} is outside 0…${readers - 1}.`, details: { pipe: definition.id } }));
      }
      if (registered.has(reader)) return err(PipeEndpointTakenError({ details: { pipe: definition.id, reader } }));
      // The reader starts at the current write position (reader-owned word, set once before the reader exists).
      Atomics.store(words, cursorWord(reader), Atomics.load(words, W_WRITE));
      Atomics.store(words, detachedWord(reader), 0);
      const endpoint = region.endpoint();
      if (!endpoint.ok) return endpoint;
      registered.add(reader);
      return ok(Object.assign({}, endpoint.value, { reader }));
    },
    release(reader) {
      if (!registered.delete(reader)) return;
      Atomics.store(words, detachedWord(reader), 1);
      flush();
    },
    get stats() {
      return { ...stats, pending: pending.length };
    },
    close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      pending.length = 0;
      Atomics.store(words, W_CLOSED, 1);
      region.publish([W_CLOSED]);
      region.close();
    },
  });
}

/** Attach reader `endpoint.reader` (set by `ring.endpoint(i)`). */
export async function attachRecordRing<F extends LayoutFields>(
  definition: RecordRingDefinition<F>,
  endpoint: RegionEndpoint,
  options: AttachRegionOptions = {},
): Promise<Result<RecordRingReader<F>>> {
  const reader = (endpoint as { reader?: unknown }).reader;
  if (typeof reader !== 'number' || endpoint.byteLength !== recordRingByteLength(definition)) {
    return err(PipeMismatchError({ details: { pipe: definition.id, byteLength: endpoint.byteLength } }));
  }
  const attached = await attachRegion(endpoint, options);
  if (!attached.ok) return attached;
  const region = attached.value;
  const header = checkPipeHeader(
    region,
    { id: definition.id, magic: RING_RECORD_MAGIC, format: RING_RECORD_FORMAT, schema: definition.version },
    { magic: W_MAGIC, format: W_FORMAT, schema: W_SCHEMA, id: W_ID },
  );
  const { words } = region;
  const shapeMatches =
    Atomics.load(words, W_CAPACITY) === definition.capacity &&
    Atomics.load(words, W_STRIDE) === definition.layout.stride &&
    Atomics.load(words, W_READERS) === definition.readers;
  if (!header.ok || !shapeMatches) {
    region.close();
    return header.ok ? err(PipeMismatchError({ details: { pipe: definition.id } })) : header;
  }
  const view = viewOver(definition, region);
  const mask = definition.capacity - 1;
  const cursor = cursorWord(reader);
  let closed = false;
  const available = (): number => (Atomics.load(words, W_WRITE) - Atomics.load(words, cursor)) | 0;

  return ok({
    id: definition.id,
    medium: region.medium,
    reader,
    get available() {
      return available();
    },
    get closed() {
      return closed || Atomics.load(words, W_CLOSED) === 1;
    },
    drain(consume, max = Infinity) {
      if (closed) return 0;
      const start = Atomics.load(words, cursor);
      const count = Math.min(available(), max);
      let done = 0;
      try {
        for (; done < count; done++) {
          const seq = (start + done) | 0;
          consume(view.at((seq >>> 0) & mask), seq);
        }
      } finally {
        if (done > 0) {
          Atomics.store(words, cursor, (start + done) | 0);
          region.publish([cursor]);
        }
      }
      return done;
    },
    async wait(waitOptions = {}) {
      if (available() > 0) return ok(true);
      if (closed || Atomics.load(words, W_CLOSED) === 1) return err(PipeClosedError({ details: { pipe: definition.id } }));
      return region.wait(W_WRITE, Atomics.load(words, W_WRITE), waitOptions);
    },
    waitSync(timeoutMs) {
      if (available() > 0) return 'ok';
      return region.waitSync(W_WRITE, Atomics.load(words, W_WRITE), timeoutMs);
    },
    close() {
      if (closed) return;
      closed = true;
      Atomics.store(words, detachedWord(reader), 1);
      region.publish([detachedWord(reader)]);
      region.close();
    },
  });
}
