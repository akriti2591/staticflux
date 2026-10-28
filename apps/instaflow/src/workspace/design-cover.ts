/**
 * Keeps the open design's cover current (#64; HOME-FILES §1 and §5 "Covers for cards"): the card preview Home shows
 * in Jump back in and Files. Store side on main, next to the Home index writer.
 *
 * - **When**: once soon after Studio opens a design that has no cover yet; then `idleMs` after the last write of the
 *   design's document (edits coalesce); and on leaving Studio (`flush`: a pending or running render finishes first,
 *   bounded by `leaveWaitMs` so leaving never hangs on it).
 * - **How**: `render` (`export/cover.ts`: the first page in an export worker, PNG within `COVER_EDGE` px) → the
 *   workspace blob store → the library's `cover` rendition. The Home index writer projects that rendition into the
 *   entry's `cover` (its blob digest), and Home shows the blob. Saving never waits on any of it.
 * - One render at a time; an edit during a render renders once more after it. Failures are reported, never thrown;
 *   the next edit tries again.
 */
import type { BlobStore } from '@staticflux/blob';
import { AbortedError, err, ok, type Result, type Scope, type SfError } from '@staticflux/core';
import type { CoverRenderer } from '../export/cover.js';
import { RenditionError } from '../library/errors.js';
import type { Library } from '../library/library.js';
import type { AssetId } from '../library/records.js';

/** Quiet time after the last write before the cover is rendered again. */
export const COVER_IDLE_MS = 1_500;
/** Longest leaving Studio waits for a cover. */
export const COVER_LEAVE_WAIT_MS = 5_000;

export interface DesignCoverOptions {
  readonly asset: AssetId;
  readonly render: CoverRenderer;
  readonly blobs: Pick<BlobStore, 'put'>;
  readonly library: Pick<Library, 'entry' | 'setRendition'>;
  readonly scope: Scope;
  /** Default `COVER_IDLE_MS`. */
  readonly idleMs?: number;
  /** Default `COVER_LEAVE_WAIT_MS`. */
  readonly leaveWaitMs?: number;
  readonly timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  readonly onProblem?: (error: SfError) => void;
}

export interface DesignCover {
  /** The design's document was written: render again once it is quiet. */
  touch(): void;
  /** Render now when a render is due, and wait for it (at most `waitMs`, default `leaveWaitMs`). */
  flush(signal?: AbortSignal, waitMs?: number): Promise<Result<void>>;
  /** Covers stored so far (tests). */
  readonly renders: number;
}

/** Keep `asset`'s cover current (see the module header). */
export function createDesignCover(options: DesignCoverOptions): DesignCover {
  const { asset, scope } = options;
  const idleMs = options.idleMs ?? COVER_IDLE_MS;
  const leaveWaitMs = options.leaveWaitMs ?? COVER_LEAVE_WAIT_MS;
  const timers = options.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  let timer: unknown;
  let due = false;
  let renders = 0;
  let running: Promise<Result<void>> | undefined;

  const once = async (): Promise<Result<void>> => {
    due = false;
    const made = await options.render(scope.signal);
    if (!made.ok) return made;
    if (scope.signal.aborted) return err(AbortedError());
    const stored = await options.blobs.put(made.value.bytes, { mime: made.value.mime, signal: scope.signal });
    if (!stored.ok) return stored;
    const written = options.library.setRendition(asset, 'cover', { blob: stored.value, params: { renderer: made.value.renderer, edge: made.value.edge, source: made.value.source } });
    if (!written.ok) return written;
    renders += 1;
    return ok();
  };
  /** Render while one is due (an edit during a render queues one more). */
  const run = (): Promise<Result<void>> => {
    if (running !== undefined) return running;
    if (!due) return Promise.resolve(ok());
    const job = (async (): Promise<Result<void>> => {
      let result: Result<void> = ok();
      while (due && !scope.signal.aborted) {
        result = await once().catch((cause: unknown) => err(RenditionError({ message: `The cover of ${asset} could not be made.`, details: { asset, role: 'cover' }, cause })));
        if (!result.ok && result.error.kind !== 'aborted') options.onProblem?.(result.error);
      }
      return result;
    })();
    running = job;
    void job.then(() => {
      if (running === job) running = undefined;
    });
    return job;
  };
  const cancelTimer = (): void => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  const schedule = (): void => {
    if (scope.signal.aborted) return;
    due = true;
    cancelTimer();
    timer = timers.set(() => {
      timer = undefined;
      void run();
    }, idleMs);
  };
  scope.defer(cancelTimer);
  if (options.library.entry(asset)?.renditions.cover === undefined) schedule();

  return {
    touch: schedule,
    async flush(signal = scope.signal, waitMs = leaveWaitMs) {
      cancelTimer();
      const work = due ? run() : running;
      if (work === undefined) return ok();
      let stop: unknown;
      const waited = await Promise.race([
        work,
        new Promise<Result<void>>((resolve) => {
          stop = setTimeout(() => resolve(ok()), waitMs);
          signal.addEventListener('abort', () => resolve(err(AbortedError({ cause: signal.reason }))), { once: true });
        }),
      ]);
      clearTimeout(stop as ReturnType<typeof setTimeout>);
      return waited;
    },
    get renders() {
      return renders;
    },
  };
}
