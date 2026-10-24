/**
 * Pause port (R4.3 "transports queue", R4.6). The runtime drives `pause()` /
 * `resume()`; the data client consults it before every request:
 *
 * - `queue`  — wait (abortably) until resume, then send.
 * - `reject` — fail immediately with `SF-DATA-002`.
 *
 * Mutations never auto-replay: a non-idempotent request is always rejected
 * while paused, even if it asked for `queue` (see `effectivePausePolicy`).
 */
import { AbortedError, box, err, ok, type Result } from '@staticflux/core';

export type PausePolicy = 'queue' | 'reject';

export interface PauseControl {
  /** Reactive. */
  readonly paused: boolean;
  /** Requests currently waiting for resume. Reactive. */
  readonly queued: number;
  pause(): void;
  resume(): void;
  /** Resolves ok() immediately when not paused; otherwise on resume, or err(aborted). */
  whenResumed(signal: AbortSignal): Promise<Result<void>>;
}

/** Idempotent requests may queue; mutations are rejected unless declared idempotent. */
export function effectivePausePolicy(requested: PausePolicy | undefined, idempotent: boolean): PausePolicy {
  if (!idempotent) return 'reject';
  return requested ?? 'queue';
}

export function createPauseControl(): PauseControl {
  const paused = box(false);
  const queued = box(0);
  const waiters = new Set<() => void>();
  return {
    get paused() {
      return paused.get();
    },
    get queued() {
      return queued.get();
    },
    pause() {
      paused.set(true);
    },
    resume() {
      paused.set(false);
      for (const wake of [...waiters]) wake();
    },
    whenResumed(signal) {
      if (!paused.get()) return Promise.resolve(ok());
      if (signal.aborted) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      return new Promise((resolve) => {
        const done = (result: Result<void>): void => {
          waiters.delete(wake);
          signal.removeEventListener('abort', onAbort);
          queued.set(queued.get() - 1);
          resolve(result);
        };
        const wake = (): void => done(ok());
        const onAbort = (): void => done(err(AbortedError({ cause: signal.reason })));
        waiters.add(wake);
        queued.set(queued.get() + 1);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
