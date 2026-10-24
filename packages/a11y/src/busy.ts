/**
 * `aria-busy` helpers for placeholders and skeletons (R15.5). Busy marks are
 * ref-counted per element, so several loaders on one region do not clear each
 * other: the region is busy until the last one finishes.
 */
import { effect, type Scope } from '@staticflux/core';

const counts = new WeakMap<Element, number>();

/** Mark `element` busy; returns an idempotent release. Released automatically with `scope`. */
export function markBusy(element: Element, scope?: Scope): () => void {
  counts.set(element, (counts.get(element) ?? 0) + 1);
  element.setAttribute('aria-busy', 'true');
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const next = (counts.get(element) ?? 1) - 1;
    if (next <= 0) {
      counts.delete(element);
      element.removeAttribute('aria-busy');
    } else counts.set(element, next);
  };
  scope?.defer(release);
  return release;
}

/** Number of outstanding busy marks on `element`. */
export function busyCount(element: Element): number {
  return counts.get(element) ?? 0;
}

/** Attributes for templates: `{ 'aria-busy': 'true' | 'false' }`. */
export function busyAttributes(busy: boolean): { readonly 'aria-busy': 'true' | 'false' } {
  return { 'aria-busy': busy ? 'true' : 'false' };
}

/** Keep `aria-busy` in sync with a reactive condition (e.g. `() => handle.state === 'pending'`). */
export function bindBusy(element: Element, isBusy: () => boolean, scope?: Scope): () => void {
  let release: (() => void) | undefined;
  const stop = effect(() => {
    const busy = isBusy();
    if (busy && release === undefined) release = markBusy(element);
    else if (!busy && release !== undefined) {
      release();
      release = undefined;
    }
  });
  const dispose = (): void => {
    stop();
    release?.();
    release = undefined;
  };
  scope?.defer(dispose);
  return dispose;
}
