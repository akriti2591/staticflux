/**
 * View Transitions wrapper (R12.19): animate route/view/mode/workspace changes where
 * `document.startViewTransition` exists and motion is allowed; otherwise just run
 * the update. Always resolves with a Result; the DOM update runs exactly once.
 */
import { attemptAsync, err, ok, type Result, toSfError } from '@staticflux/core';

interface ViewTransitionLike {
  readonly updateCallbackDone: Promise<void>;
  readonly finished: Promise<void>;
  skipTransition?(): void;
}

type StartViewTransition = (callback: () => Promise<void> | void) => ViewTransitionLike;

export interface ViewTransitionOptions {
  readonly document?: Document;
  /** Skip the animation (reduced motion). Default: `prefers-reduced-motion: reduce`. */
  readonly reducedMotion?: boolean;
  readonly signal?: AbortSignal;
  /** Wait for the animation to finish (default false: resolve after the DOM update). */
  readonly waitForFinish?: boolean;
}

export interface ViewTransitionOutcome {
  readonly animated: boolean;
}

function prefersReducedMotion(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === 'function' && mm.call(globalThis, '(prefers-reduced-motion: reduce)').matches;
}

export async function withViewTransition(
  update: () => void | Promise<void>,
  options: ViewTransitionOptions = {},
): Promise<Result<ViewTransitionOutcome>> {
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
  const start = (doc as unknown as { startViewTransition?: StartViewTransition } | undefined)?.startViewTransition;
  const reduced = options.reducedMotion ?? prefersReducedMotion();
  if (options.signal?.aborted === true) return err(toSfError(options.signal.reason ?? new DOMException('aborted', 'AbortError')));
  if (typeof start !== 'function' || reduced) {
    const ran = await attemptAsync(async () => update());
    return ran.ok ? ok({ animated: false }) : ran;
  }
  let updateError: unknown;
  const transition = start.call(doc, async () => {
    try {
      await update();
    } catch (error) {
      updateError = error;
      throw error;
    }
  });
  // Skipping only matters while the transition runs; detach once it has finished either way.
  const detach = new AbortController();
  const detachListener = (): void => detach.abort();
  void transition.finished.then(detachListener, detachListener);
  options.signal?.addEventListener('abort', () => transition.skipTransition?.(), { once: true, signal: detach.signal });
  try {
    await transition.updateCallbackDone;
    if (options.waitForFinish === true) await transition.finished.catch(() => undefined);
  } catch (error) {
    return err(toSfError(updateError ?? error));
  }
  return ok({ animated: true });
}
