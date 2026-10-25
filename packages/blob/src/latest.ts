/**
 * The Latest store: durable state of one mutable asset as **part snapshots +
 * a journal + a head** (DOCUMENT-FORMAT §5.2), engine-agnostic. It is the
 * persistence port `DocumentRepo` (A4) builds on: parts and records are opaque
 * bytes; the caller supplies `snapshot(part)` (e.g. a CRDT export).
 *
 * - `append(records)` journals records durably (the ack point), deduping by id,
 *   and marks the parts each record touches dirty.
 * - `compact()` is **incremental** (S6): it snapshots at most `maxParts` dirty
 *   parts per head swap and advances `logFrom` only once no dirty part has a
 *   record in an older segment. Without the cap a leader killed every ~0.4 s
 *   never finished a compaction and the log grew without bound.
 * - The head records, per part, the journal position its snapshot covers
 *   (`cover`), so recovery marks a part dirty only for records newer than its
 *   snapshot. Replay is still at-least-once: applying records must be idempotent.
 * - `recover()` removes temp heads, reads the head, replays the journal from
 *   `logFrom` (stopping at torn tails) and drops stale segments.
 *
 * Contract for `snapshot(part)`: it must reflect every record whose `append()`
 * has been called for that part (apply first, then append).
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { fromUtf8, utf8 } from './codec.js';
import { BlobDisposedError, BlobInvalidInputError, toBlobError } from './errors.js';
import type { Head, HeadBody, HeadStore } from './heads.js';
import { comparePositions, type Journal, type JournalPosition } from './journal.js';
import type { BlobEncoding, BlobRef, BlobStore } from './types.js';

export interface LatestRecord {
  /** Unique commit id (dedupe key across resends and leaders). */
  readonly id: string;
  /** Parts the record changes (one record may touch several: an atomic cross-part move). */
  readonly parts: readonly string[];
  readonly data: Uint8Array;
}

export interface ReplayedRecord extends LatestRecord {
  readonly position: JournalPosition;
}

export type CoverPosition = readonly [segment: number, index: number];

interface DirtySpan {
  readonly first: JournalPosition;
  readonly last: JournalPosition;
}

export interface LatestHead extends Head {
  readonly parts: Readonly<Record<string, BlobRef>>;
  /** First live journal segment. */
  readonly logFrom: number;
  /** Per part: the last journal position its snapshot includes. */
  readonly cover?: Readonly<Record<string, CoverPosition>>;
}

/** Encode a record as a journal payload: `[u32 header length][header JSON][data]`. */
export function encodeLatestRecord(record: LatestRecord): Uint8Array {
  const header = utf8(JSON.stringify({ i: record.id, p: record.parts }));
  const out = new Uint8Array(4 + header.length + record.data.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(record.data, 4 + header.length);
  return out;
}

export function decodeLatestRecord(payload: Uint8Array): Result<LatestRecord> {
  try {
    const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
    const header = JSON.parse(fromUtf8(payload.subarray(4, 4 + length))) as { i?: unknown; p?: unknown };
    if (typeof header.i !== 'string' || !Array.isArray(header.p) || !header.p.every((p) => typeof p === 'string')) {
      return err(BlobInvalidInputError({ message: 'Journal record header is malformed.' }));
    }
    return ok({ id: header.i, parts: header.p as string[], data: payload.slice(4 + length) });
  } catch (cause) {
    return err(BlobInvalidInputError({ cause, message: 'Journal record could not be decoded.' }));
  }
}

export interface CompactHooks {
  /** Fault injection points (a throw simulates a crash at that point). */
  readonly afterBlobs?: () => Promise<void> | void;
  readonly beforeMove?: () => Promise<void> | void;
  readonly afterHead?: () => Promise<void> | void;
}

export interface CompactOptions {
  readonly signal?: AbortSignal;
  /** Override `maxPartsPerSwap` for this call. */
  readonly maxParts?: number;
  readonly hooks?: CompactHooks;
}

export type CompactResult =
  | { readonly skipped: true; readonly reason: 'clean' | 'busy' }
  | { readonly skipped: false; readonly generation: number; readonly parts: readonly string[]; readonly logFrom: number; readonly segmentsDropped: number };

export interface LatestRecovery<H extends LatestHead = LatestHead> {
  /** `undefined` for a new asset. */
  readonly head: H | undefined;
  /** Records newer than `logFrom`, in journal order, to re-apply (idempotently). */
  readonly records: readonly ReplayedRecord[];
  readonly dirtyParts: readonly string[];
  readonly report: {
    readonly tempsRemoved: number;
    readonly segments: number;
    readonly tornTails: number;
    readonly staleSegments: number;
    readonly duplicateRecords: number;
  };
}

export interface LatestStoreOptions<H extends LatestHead = LatestHead> {
  readonly blobs: BlobStore;
  readonly heads: HeadStore;
  readonly journal: Journal;
  /** Head name (the asset id). */
  readonly name: string;
  /** Current bytes of a part (called during compaction). */
  readonly snapshot: (part: string) => Promise<Result<Uint8Array>> | Result<Uint8Array>;
  /** Fields of a brand-new head besides `parts`, `logFrom` and `cover`. */
  readonly initialHead?: () => Omit<HeadBody<H>, 'parts' | 'logFrom' | 'cover'>;
  readonly maxPartsPerSwap?: number;
  readonly mime?: string;
  readonly encoding?: BlobEncoding;
  /** CAS retries when another writer changed the head meanwhile (default 4). */
  readonly attempts?: number;
}

export interface LatestStore<H extends LatestHead = LatestHead> {
  readonly name: string;
  /** Cached head (after `recover()`), `undefined` before the first compaction of a new asset. */
  readonly head: H | undefined;
  /** Parts with journal records not yet in a snapshot. */
  readonly dirty: readonly string[];
  recover(signal?: AbortSignal): Promise<Result<LatestRecovery<H>>>;
  /** Journal records durably; returns the ids now durable (new and already-known ones). */
  append(records: readonly LatestRecord[], signal?: AbortSignal): Promise<Result<{ readonly fresh: readonly string[]; readonly durable: readonly string[] }>>;
  /** True once `id` is durable in this store's session. */
  has(id: string): boolean;
  compact(options?: CompactOptions): Promise<Result<CompactResult>>;
  /** Change other head fields (milestones, pins) with CAS retries; refreshes the cached head. */
  updateHead(fn: (current: H | undefined) => Result<HeadBody<H>>, signal?: AbortSignal): Promise<Result<H>>;
  close(): Promise<void>;
}

export function createLatestStore<H extends LatestHead = LatestHead>(options: LatestStoreOptions<H>): LatestStore<H> {
  const maxParts = options.maxPartsPerSwap ?? 16;
  const attempts = options.attempts ?? 4;
  const mime = options.mime ?? 'application/octet-stream';
  let head: H | undefined;
  /** Per dirty part: the oldest and newest journal positions not yet in its snapshot. */
  const dirty = new Map<string, DirtySpan>();
  const ids = new Set<string>();
  let recovered = false;
  let closed = false;
  let compacting = false;

  const markDirty = (part: string, first: JournalPosition, last: JournalPosition = first): void => {
    const previous = dirty.get(part);
    if (previous === undefined) {
      dirty.set(part, { first, last });
      return;
    }
    dirty.set(part, {
      first: comparePositions(first, previous.first) < 0 ? first : previous.first,
      last: comparePositions(last, previous.last) > 0 ? last : previous.last,
    });
  };

  const notReady = (): SfError | undefined => {
    if (closed) return BlobDisposedError({ message: `Latest store ${options.name} is closed.` });
    if (!recovered) return BlobInvalidInputError({ message: 'Call latest.recover() first.' });
    return undefined;
  };

  const baseBody = (): HeadBody<H> =>
    ({ ...(options.initialHead?.() ?? {}), parts: {}, logFrom: 0, cover: {} }) as unknown as HeadBody<H>;

  const store: LatestStore<H> = {
    name: options.name,
    get head() {
      return head;
    },
    get dirty() {
      return [...dirty.keys()];
    },

    async recover(signal) {
      if (closed) return err(BlobDisposedError({ message: `Latest store ${options.name} is closed.` }));
      const temps = await options.heads.recover();
      if (!temps.ok) return temps;
      const current = await options.heads.read<H>(options.name, signal === undefined ? {} : { signal });
      if (!current.ok) return current;
      head = current.value;
      const replay = await options.journal.open(head?.logFrom ?? 0, signal);
      if (!replay.ok) return replay;
      dirty.clear();
      ids.clear();
      const cover = head?.cover ?? {};
      const records: ReplayedRecord[] = [];
      let duplicateRecords = 0;
      for (const { position, payload } of replay.value.records) {
        const decoded = decodeLatestRecord(payload);
        if (!decoded.ok) continue;
        if (ids.has(decoded.value.id)) {
          duplicateRecords += 1;
          continue;
        }
        ids.add(decoded.value.id);
        records.push({ ...decoded.value, position });
        for (const part of decoded.value.parts) {
          const covered = cover[part];
          if (covered === undefined || comparePositions(position, { segment: covered[0], index: covered[1] }) > 0) markDirty(part, position);
        }
      }
      if (replay.value.stale > 0 && head !== undefined) {
        const dropped = await options.journal.dropBefore(head.logFrom);
        if (!dropped.ok) return dropped;
      }
      recovered = true;
      return ok({
        head,
        records,
        dirtyParts: [...dirty.keys()],
        report: {
          tempsRemoved: temps.value.tempsRemoved,
          segments: replay.value.segments,
          tornTails: replay.value.tornTails,
          staleSegments: replay.value.stale,
          duplicateRecords,
        },
      });
    },

    async append(records, signal) {
      const stopped = notReady();
      if (stopped !== undefined) return err(stopped);
      const seen = new Set<string>();
      const fresh = records.filter((r) => {
        if (ids.has(r.id) || seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      if (fresh.length > 0) {
        for (const record of fresh) {
          if (record.parts.length === 0) return err(BlobInvalidInputError({ message: `Record ${record.id} touches no part.` }));
        }
        const positions = await options.journal.append(fresh.map(encodeLatestRecord), signal);
        if (!positions.ok) return positions;
        fresh.forEach((record, i) => {
          ids.add(record.id);
          const position = positions.value[i];
          if (position !== undefined) for (const part of record.parts) markDirty(part, position);
        });
      }
      return ok({ fresh: fresh.map((r) => r.id), durable: [...new Set(records.map((r) => r.id))] });
    },

    has(id) {
      return ids.has(id);
    },

    async compact(compactOptions = {}) {
      const stopped = notReady();
      if (stopped !== undefined) return err(stopped);
      if (compacting) return ok({ skipped: true, reason: 'busy' });
      if (dirty.size === 0) return ok({ skipped: true, reason: 'clean' });
      compacting = true;
      const hooks = compactOptions.hooks ?? {};
      const taken: [string, DirtySpan][] = [];
      try {
        const rolled = await options.journal.roll();
        if (!rolled.ok) return rolled;
        const next = rolled.value;
        for (const [part, span] of dirty) {
          if (taken.length >= (compactOptions.maxParts ?? maxParts)) break;
          taken.push([part, span]);
        }
        for (const [part] of taken) dirty.delete(part);
        const refs: Record<string, BlobRef> = {};
        const covers: Record<string, CoverPosition> = {};
        for (const [part, { last: position }] of taken) {
          const bytes = await options.snapshot(part);
          if (!bytes.ok) return restore(taken, bytes);
          const put = await options.blobs.put(bytes.value, {
            mime,
            ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
            ...(compactOptions.signal === undefined ? {} : { signal: compactOptions.signal }),
          });
          if (!put.ok) return restore(taken, put);
          refs[part] = put.value;
          covers[part] = [position.segment, position.index];
        }
        await hooks.afterBlobs?.();
        const olderDirty = [...dirty.values()].some((span) => span.first.segment < next);
        let result: Result<H> | undefined;
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (attempt > 0) {
            const reread = await options.heads.read<H>(options.name);
            if (!reread.ok) return restore(taken, reread);
            head = reread.value;
          }
          const base = head === undefined ? baseBody() : (stripGeneration(head) as HeadBody<H>);
          const previous = base as unknown as LatestHead;
          const logFrom = olderDirty ? previous.logFrom : Math.max(previous.logFrom, next);
          const body = {
            ...base,
            parts: { ...previous.parts, ...refs },
            cover: { ...(previous.cover ?? {}), ...covers },
            logFrom,
          } as unknown as HeadBody<H>;
          result = await options.heads.cas<H>(options.name, head?.generation ?? 0, body, {
            ...(hooks.beforeMove === undefined ? {} : { beforeMove: hooks.beforeMove }),
            ...(compactOptions.signal === undefined ? {} : { signal: compactOptions.signal }),
          });
          if (result.ok || result.error.code !== 'SF-BLOB-003') break;
        }
        if (result === undefined || !result.ok) return restore(taken, result ?? err(BlobInvalidInputError({ message: 'no CAS attempt' })));
        head = result.value;
        await hooks.afterHead?.();
        let segmentsDropped = 0;
        const dropped = await options.journal.dropBefore(head.logFrom);
        if (dropped.ok) segmentsDropped = dropped.value;
        return ok({ skipped: false, generation: head.generation, parts: taken.map(([p]) => p), logFrom: head.logFrom, segmentsDropped });
      } catch (cause) {
        return restore(taken, err(toBlobError(cause, 'compact')));
      } finally {
        compacting = false;
      }
    },

    async updateHead(fn, signal) {
      const stopped = notReady();
      if (stopped !== undefined) return err(stopped);
      const updated = await options.heads.update<H>(
        options.name,
        (current) => fn(current),
        signal === undefined ? { attempts } : { attempts, signal },
      );
      if (updated.ok) head = updated.value;
      return updated;
    },

    async close() {
      closed = true;
      await options.journal.close();
    },
  };

  function restore<T>(taken: readonly [string, DirtySpan][], failure: Result<unknown>): Result<T> {
    for (const [part, span] of taken) markDirty(part, span.first, span.last);
    return failure.ok ? err(BlobInvalidInputError({ message: 'compaction failed' })) : (failure as Result<T>);
  }

  return store;
}

function stripGeneration<H extends Head>(head: H): HeadBody<H> {
  const { generation: _generation, ...body } = head;
  return body as HeadBody<H>;
}
