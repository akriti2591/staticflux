/**
 * The Home index writer (C0; IF-28.4–28.7): runs next to the library (Studio's store side on main today, the store
 * worker later) and keeps `head.app.home` of the library asset equal to a projection of the live library entries plus
 * when each design was last edited. Home reads that projection with no engine (D17).
 *
 * - **Projection** (`projectHomeIndex`, pure): every entry (B11c: trashed ones carry `trashedAt` for Home's Trash page),
 *   the lens of each kind, the design's format and page count, its project and favourite; `editedAt` = the newest of: a
 *   touch in this session, the stored index, the entry's creation. Projects made on Home are kept.
 * - **Home's journal** (B11c, `../home/journal.ts`): ops Home appended and Studio has not drained yet are applied on top,
 *   so a write from here never undoes a change Home already shows.
 * - **Triggers**: a library change (reactive `entries()`), or `touch(asset)` when the asset's document is written
 *   (`observeStoreWrites`). Writes are debounced and coalesced; `flush()` writes now (before leaving for Home).
 * - **Write**: compare-and-swap on the library head with retries (IF-HOME-005); an unchanged index writes nothing. The
 *   repo adopts the newer head on its next compaction, carrying `app` unchanged.
 */
import { err, ok, type Result, type Scope, type SfError, watch } from '@staticflux/core';
import { type DocumentHead, type DocumentStore, HeadConflictError } from '@staticflux/document/v2';
import { HomeIndexWriteError } from '../home/errors.js';
import { byEdited, type DesignSize, type HomeEntry, type HomeIndex, HOME_INDEX_SCHEMA, readHomeIndex, sameHomeIndex, withHomeIndex } from '../home/index-record.js';
import { HOME_JOURNAL_ASSET, overlayJournal, readHomeJournal } from '../home/journal.js';
import { ASSET_KIND_LENS } from '../library/kinds.js';
import type { Library } from '../library/library.js';
import { LIBRARY_ASSET, type LibraryEntry } from '../library/library-doc.js';

/** What this session learned about an asset (newer than the stored index). */
export interface HomeTouch {
  readonly editedAt?: string;
  readonly format?: DesignSize;
  /** Designs: the page count. */
  readonly pages?: number;
}

/** The Home index for `entries` (pure; see the module header). */
export function projectHomeIndex(entries: readonly LibraryEntry[], previous: HomeIndex, touches: ReadonlyMap<string, HomeTouch> = new Map()): HomeIndex {
  const before = new Map(previous.entries.map((e) => [e.asset, e]));
  const newest = (first: string, ...times: (string | undefined)[]): string =>
    times.filter((t): t is string => t !== undefined && !Number.isNaN(Date.parse(t))).reduce((a, b) => (Number.isNaN(Date.parse(a)) || Date.parse(b) > Date.parse(a) ? b : a), first);
  const out: HomeEntry[] = entries.map((entry) => {
    const old = before.get(entry.asset);
    const touch = touches.get(entry.asset);
    const format = touch?.format ?? old?.format ?? (entry.media?.width !== undefined && entry.media.height !== undefined ? { width: entry.media.width, height: entry.media.height } : undefined);
    const pages = touch?.pages ?? old?.pages;
    return {
      asset: entry.asset,
      kind: entry.kind,
      title: entry.title,
      createdAt: entry.createdAt,
      editedAt: newest(entry.createdAt, old?.editedAt, touch?.editedAt),
      lens: ASSET_KIND_LENS[entry.kind],
      ...(entry.mime === undefined ? {} : { mime: entry.mime }),
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(format === undefined ? {} : { format }),
      ...(entry.folder.length === 0 ? {} : { folder: entry.folder }),
      ...(entry.favorite ? { favorite: true as const } : {}),
      ...(entry.trashedAt === undefined ? {} : { trashedAt: entry.trashedAt }),
      ...(pages === undefined ? {} : { pages }),
      ...(entry.content === undefined ? {} : { digest: entry.content.digest }),
    };
  });
  return { schema: HOME_INDEX_SCHEMA, entries: out.sort(byEdited), ...(previous.projects === undefined || previous.projects.length === 0 ? {} : { projects: previous.projects }) };
}

/** Swap the library head's Home index by CAS (retries on a conflict; unchanged → no write); Home's pending ops on top. */
export async function writeHomeIndex(store: Pick<DocumentStore, 'readHead' | 'writeHead'>, next: (current: HomeIndex) => HomeIndex, signal: AbortSignal, attempts = 6): Promise<Result<{ readonly written: boolean; readonly index: HomeIndex }>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = await store.readHead(LIBRARY_ASSET, signal);
    if (!read.ok) return read;
    const head = read.value;
    if (head === undefined) return ok({ written: false, index: next(readHomeIndex(undefined)) }); // no library yet: nothing listed
    const journal = await store.readHead(HOME_JOURNAL_ASSET, signal);
    if (!journal.ok) return journal;
    const current = readHomeIndex(head);
    const index = overlayJournal(next(current), readHomeJournal(journal.value));
    if (sameHomeIndex(current, index)) return ok({ written: false, index });
    const written: DocumentHead = withHomeIndex({ ...head, generation: head.generation + 1 }, index);
    const swapped = await store.writeHead(LIBRARY_ASSET, written, head.generation, signal);
    if (swapped.ok) return ok({ written: true, index });
    if (swapped.error.code !== HeadConflictError.code) return swapped;
  }
  return err(HomeIndexWriteError({ details: { attempts } }));
}

export interface HomeIndexWriterOptions {
  readonly store: Pick<DocumentStore, 'readHead' | 'writeHead'>;
  readonly library: Pick<Library, 'entries'>;
  readonly scope: Scope;
  readonly now?: () => number;
  /** Coalescing delay (default 400 ms). */
  readonly debounceMs?: number;
  readonly timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** A failed write (the next trigger retries). */
  readonly onProblem?: (error: SfError) => void;
  /** A new index was written (the session pings Home). */
  readonly onWritten?: (index: HomeIndex) => void;
}

export interface HomeIndexWriter {
  /** The asset was edited now (or its format is known): rewrite its entry soon. */
  touch(asset: string, touch?: Omit<HomeTouch, 'editedAt'>): void;
  /** What is known about the asset (its format) without marking it edited. */
  describe(asset: string, touch: Omit<HomeTouch, 'editedAt'>): void;
  /** Write now (pending changes only). */
  flush(signal?: AbortSignal): Promise<Result<void>>;
  /** Writes so far (tests). */
  readonly writes: number;
}

/** Keep the Home index in step with the library and this session's edits (see the module header). */
export function createHomeIndexWriter(options: HomeIndexWriterOptions): HomeIndexWriter {
  const { store, library, scope } = options;
  const now = options.now ?? (() => Date.now());
  const debounceMs = options.debounceMs ?? 400;
  const timers = options.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const touches = new Map<string, HomeTouch>();
  let timer: unknown;
  let dirty = true; // the first write reconciles the stored index with the library
  let writes = 0;
  let running: Promise<Result<void>> = Promise.resolve(ok());

  const write = (signal: AbortSignal): Promise<Result<void>> => {
    running = running.then(async () => {
      if (!dirty || scope.signal.aborted) return ok();
      dirty = false;
      const entries = library.entries();
      const done = await writeHomeIndex(store, (current) => projectHomeIndex(entries, current, touches), signal);
      if (!done.ok) {
        dirty = true;
        options.onProblem?.(done.error);
        return err(done.error);
      }
      if (done.value.written) {
        writes += 1;
        options.onWritten?.(done.value.index);
      }
      return ok();
    });
    return running;
  };
  const schedule = (): void => {
    dirty = true;
    if (timer !== undefined) timers.clear(timer);
    timer = timers.set(() => {
      timer = undefined;
      void write(scope.signal);
    }, debounceMs);
  };
  scope.defer(() => {
    if (timer !== undefined) timers.clear(timer);
  });
  watch(
    () => library.entries(),
    () => schedule(),
    { scope, fireImmediately: true },
  );

  return {
    touch(asset, touch = {}) {
      const previous = touches.get(asset);
      touches.set(asset, { ...previous, ...touch, editedAt: new Date(now()).toISOString() });
      schedule();
    },
    describe(asset, touch) {
      const previous = touches.get(asset);
      touches.set(asset, { ...previous, ...touch });
      schedule();
    },
    async flush(signal = scope.signal) {
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
      return write(signal);
    },
    get writes() {
      return writes;
    },
  };
}

/**
 * A `DocumentStore` that reports which asset was written (log appends and head swaps; the library and Home's journal are skipped):
 * the "edited" signal of the Home index. Everything else passes through unchanged.
 */
export function observeStoreWrites(store: DocumentStore, onWrite: (asset: string) => void): DocumentStore {
  const report = (asset: string): void => {
    if (asset !== LIBRARY_ASSET && asset !== HOME_JOURNAL_ASSET) onWrite(asset);
  };
  return {
    readHead: (asset, signal) => store.readHead(asset, signal),
    async writeHead(asset, head, expected, signal) {
      const r = await store.writeHead(asset, head, expected, signal);
      if (r.ok) report(asset);
      return r;
    },
    putBlob: (bytes, signal) => store.putBlob(bytes, signal),
    getBlob: (ref, signal) => store.getBlob(ref, signal),
    async appendLog(asset, bytes, signal) {
      const r = await store.appendLog(asset, bytes, signal);
      if (r.ok) report(asset);
      return r;
    },
    readLog: (asset, from, signal) => store.readLog(asset, from, signal),
    truncateLog: (asset, before, signal) => store.truncateLog(asset, before, signal),
  };
}
