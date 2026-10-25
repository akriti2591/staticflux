/**
 * The journal: an append-only log of opaque records in segment files
 * `log/<stream>/<NNNNNNNN>-<peer>.bin` (DOCUMENT-FORMAT §5.1). Each record is
 * framed `[u32 length][u32 crc32][payload]`, so a torn tail (a crash mid-write)
 * is detected and replay stops at the last whole record.
 *
 * Two write modes (S6):
 * - `append` — one open sync access handle per segment; `append()` writes and
 *   `flush()`es, and only then resolves (the ack point). OPFS in a dedicated
 *   worker; sub-millisecond.
 * - `segments` — one immutable segment per `append()` call, published by temp
 *   file + `move()`. Works anywhere `createWritable` does (main thread, a
 *   folder), at the cost of one file per batch.
 *
 * A reopened journal never appends to an old segment: it starts a new one, so
 * a torn tail is never followed by good records in the same file.
 */
import { err, ok, type Result } from '@staticflux/core';
import { crc32 } from './codec.js';
import { abortedError, BlobDisposedError, BlobInvalidInputError, BlobUnavailableError, toBlobError } from './errors.js';
import {
  checkName,
  createDirectoryCache,
  type DirectoryHandleLike,
  isTempName,
  listFiles,
  publishFile,
  readFile,
  removeFile,
  type SyncAccessHandleLike,
} from './fs.js';
import type { StoreObserver } from './types.js';

export const LOG_PATH = ['log'] as const;
/** Largest record payload (64 MiB). */
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;

export type JournalMode = 'append' | 'segments';

/** Where a record sits: segment number, then index within the segment. Totally ordered. */
export interface JournalPosition {
  readonly segment: number;
  readonly index: number;
}

export function comparePositions(a: JournalPosition, b: JournalPosition): number {
  return a.segment === b.segment ? a.index - b.index : a.segment - b.segment;
}

export interface JournalRecord {
  readonly position: JournalPosition;
  readonly payload: Uint8Array;
}

export interface JournalReplay {
  readonly records: readonly JournalRecord[];
  /** Segments read. */
  readonly segments: number;
  /** Segments whose tail was torn (records after the tear are dropped). */
  readonly tornTails: number;
  /** Segments older than `from` (left for `dropBefore`). */
  readonly stale: number;
  /** The segment the next append goes to. */
  readonly nextSegment: number;
}

/** Frame one record. */
export function frameRecord(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, true);
  view.setUint32(4, crc32(payload), true);
  out.set(payload, 8);
  return out;
}

export interface ParsedFrames {
  readonly records: readonly Uint8Array[];
  readonly torn: boolean;
  /** Bytes covered by whole, valid records. */
  readonly validBytes: number;
}

/** Parse framed records, stopping at the first incomplete or corrupt frame. */
export function parseFrames(bytes: Uint8Array): ParsedFrames {
  const records: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let torn = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      torn = true;
      break;
    }
    const length = view.getUint32(offset, true);
    const crc = view.getUint32(offset + 4, true);
    if (length === 0 || offset + 8 + length > bytes.length) {
      torn = true;
      break;
    }
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(payload) !== crc) {
      torn = true;
      break;
    }
    records.push(payload);
    offset += 8 + length;
  }
  return { records, torn, validBytes: offset };
}

export function segmentName(segment: number, peer: string): string {
  return `${String(segment).padStart(8, '0')}-${peer}.bin`;
}

/** Segment number of a segment file name, or undefined. */
export function segmentNumber(name: string): number | undefined {
  const match = /^(\d{8})-[^/]+\.bin$/.exec(name);
  return match === null || isTempName(name) ? undefined : Number(match[1]);
}

export interface JournalOptions {
  /** One journal per stream (an asset id). */
  readonly stream: string;
  /** This writer (peer id); part of segment names so two writers never collide. */
  readonly peer: string;
  readonly mode: JournalMode;
  readonly path?: readonly string[];
  readonly observer?: StoreObserver;
}

export interface Journal {
  readonly stream: string;
  readonly mode: JournalMode;
  /**
   * Read every record in segments `>= from`, in order, and position the writer
   * on a fresh segment after the newest one found. Call once before `append`.
   */
  open(from: number, signal?: AbortSignal): Promise<Result<JournalReplay>>;
  /** Durably append records; resolves after they are flushed. */
  append(payloads: readonly Uint8Array[], signal?: AbortSignal): Promise<Result<readonly JournalPosition[]>>;
  /** Start a new segment; every record appended so far is in segments `< result`. */
  roll(): Promise<Result<number>>;
  /** Delete segments numbered below `segment`. */
  dropBefore(segment: number): Promise<Result<number>>;
  /** The segment the next record goes to. */
  readonly currentSegment: number;
  /** Close the open sync handle (if any). The journal can be reopened. */
  close(): Promise<void>;
}

export function createJournal(root: DirectoryHandleLike, options: JournalOptions): Journal {
  const path = [...(options.path ?? LOG_PATH), options.stream];
  const dirs = createDirectoryCache(root);
  let segment = 0;
  let index = 0;
  let opened = false;
  let closed = false;
  let handle: { access: SyncAccessHandleLike; offset: number; name: string } | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  /** Serialize all writer operations. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const directory = async (create: boolean): Promise<Result<DirectoryHandleLike | undefined>> => dirs.get(path, create);

  const closeHandle = (): void => {
    if (handle === undefined) return;
    try {
      handle.access.flush();
      handle.access.close();
    } catch {
      // closing an already-invalid handle (context dying) is harmless
    }
    handle = undefined;
  };

  const ensureHandle = async (dir: DirectoryHandleLike): Promise<Result<NonNullable<typeof handle>>> => {
    if (handle !== undefined) return ok(handle);
    const name = segmentName(segment, options.peer);
    try {
      const file = await dir.getFileHandle(name, { create: true });
      if (file.createSyncAccessHandle === undefined) {
        return err(BlobUnavailableError({ message: 'Journal mode "append" needs sync access handles (a dedicated worker on OPFS). Use mode "segments".' }));
      }
      const access = await file.createSyncAccessHandle();
      handle = { access, offset: access.getSize(), name };
      return ok(handle);
    } catch (cause) {
      return err(toBlobError(cause, 'open-segment', name));
    }
  };

  const journal: Journal = {
    stream: options.stream,
    mode: options.mode,
    get currentSegment() {
      return segment;
    },

    open(from, signal) {
      return serial(async (): Promise<Result<JournalReplay>> => {
        const valid = checkName(options.stream);
        if (!valid.ok) return valid;
        closeHandle();
        closed = false;
        const dir = await directory(false);
        if (!dir.ok) return dir;
        const records: JournalRecord[] = [];
        let segments = 0;
        let tornTails = 0;
        let stale = 0;
        let newest = from - 1;
        if (dir.value !== undefined) {
          const names = await listFiles(dir.value);
          if (!names.ok) return names;
          const live: { name: string; number: number }[] = [];
          for (const name of names.value) {
            const number = segmentNumber(name);
            if (number === undefined) continue;
            newest = Math.max(newest, number);
            if (number < from) stale += 1;
            else live.push({ name, number });
          }
          live.sort((a, b) => a.number - b.number || (a.name < b.name ? -1 : 1));
          let lastNumber = -1;
          let lastIndex = 0;
          for (const { name, number } of live) {
            const aborted = abortedError(signal);
            if (aborted !== undefined) return err(aborted);
            const bytes = await readFile(dir.value, name, undefined, signal);
            if (!bytes.ok) {
              if (bytes.error.code === 'SF-BLOB-005') continue;
              return bytes;
            }
            const parsed = parseFrames(bytes.value);
            segments += 1;
            if (parsed.torn) tornTails += 1;
            if (number !== lastNumber) lastIndex = 0;
            lastNumber = number;
            for (const payload of parsed.records) {
              records.push({ position: { segment: number, index: lastIndex }, payload: payload.slice() });
              lastIndex += 1;
            }
          }
        }
        segment = Math.max(newest + 1, from);
        index = 0;
        opened = true;
        return ok({ records, segments, tornTails, stale, nextSegment: segment });
      });
    },

    append(payloads, signal) {
      return serial(async (): Promise<Result<readonly JournalPosition[]>> => {
        if (closed) return err(BlobDisposedError({ message: 'The journal was closed.' }));
        if (!opened) return err(BlobInvalidInputError({ message: 'Call journal.open() before append().' }));
        const aborted = abortedError(signal);
        if (aborted !== undefined) return err(aborted);
        if (payloads.length === 0) return ok([]);
        for (const payload of payloads) {
          if (payload.length === 0 || payload.length > MAX_RECORD_BYTES) {
            return err(BlobInvalidInputError({ message: `Journal records are 1 byte to ${MAX_RECORD_BYTES} bytes; got ${payload.length}.` }));
          }
        }
        const dir = await directory(true);
        if (!dir.ok) return dir;
        if (dir.value === undefined) return err(BlobInvalidInputError({ message: 'journal directory missing' }));
        let total = 0;
        const frames = payloads.map((payload) => {
          const frame = frameRecord(payload);
          total += frame.length;
          return frame;
        });
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const frame of frames) {
          bytes.set(frame, at);
          at += frame.length;
        }
        const positions: JournalPosition[] = [];
        if (options.mode === 'append') {
          const open = await ensureHandle(dir.value);
          if (!open.ok) return open;
          try {
            let written = 0;
            while (written < bytes.length) {
              const n = open.value.access.write(bytes.subarray(written), { at: open.value.offset + written });
              if (n <= 0) throw new Error('sync access handle wrote 0 bytes');
              written += n;
            }
            open.value.access.flush();
            open.value.offset += bytes.length;
          } catch (cause) {
            // The segment may now end in a partial frame: never append to it again.
            closeHandle();
            segment += 1;
            index = 0;
            return err(toBlobError(cause, 'append', open.value.name));
          }
          for (let i = 0; i < payloads.length; i++) positions.push({ segment, index: index + i });
          index += payloads.length;
          options.observer?.({ kind: 'log', path, name: open.value.name });
        } else {
          const name = segmentName(segment, options.peer);
          const published = await publishFile(dir.value, name, bytes, 'writable');
          if (!published.ok) return published;
          for (let i = 0; i < payloads.length; i++) positions.push({ segment, index: i });
          segment += 1;
          index = 0;
          options.observer?.({ kind: 'log', path, name });
        }
        return ok(positions);
      });
    },

    roll() {
      return serial(async (): Promise<Result<number>> => {
        if (!opened) return err(BlobInvalidInputError({ message: 'Call journal.open() before roll().' }));
        if (options.mode === 'append') {
          if (handle !== undefined || index > 0) {
            closeHandle();
            segment += 1;
            index = 0;
          }
        }
        return ok(segment);
      });
    },

    dropBefore(before) {
      return serial(async (): Promise<Result<number>> => {
        const dir = await directory(false);
        if (!dir.ok) return dir;
        if (dir.value === undefined) return ok(0);
        const names = await listFiles(dir.value);
        if (!names.ok) return names;
        let removed = 0;
        for (const name of names.value) {
          const number = segmentNumber(name);
          if (number === undefined || number >= before) continue;
          if (handle?.name === name) continue;
          const gone = await removeFile(dir.value, name);
          if (!gone.ok) return gone;
          removed += 1;
          options.observer?.({ kind: 'delete', path, name });
        }
        return ok(removed);
      });
    },

    close() {
      return serial(async () => {
        closeHandle();
        closed = true;
      });
    },
  };
  return journal;
}
