/** Internal helpers shared by supervisor and feature host. Not exported from the package. */
import { err, ok, type Result, sleep, toSfError } from '@staticflux/core';

/** Run a lifecycle hook that may return nothing, a Result, or a promise of either; never throws. */
export async function runHook(fn: () => unknown): Promise<Result<void>> {
  try {
    const value = (await fn()) as Result<void> | undefined | null;
    if (typeof value === 'object' && value !== null && 'ok' in value && !value.ok) return err(value.error);
    return ok();
  } catch (error) {
    return err(toSfError(error));
  }
}

/** Sleep injected for tests. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<Result<void>>;

export const defaultSleep: Sleep = sleep;

export function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** Race `work` against a timer; the timer is always cleared. Resolves `'timeout'` when the timer wins. */
export async function withDeadline<T>(work: Promise<T>, ms: number, sleepFn: Sleep): Promise<T | 'timeout'> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      work,
      sleepFn(ms, controller.signal).then((r) => (r.ok ? ('timeout' as const) : new Promise<never>(() => undefined))),
    ]);
  } finally {
    controller.abort();
  }
}
