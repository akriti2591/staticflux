/**
 * Browser seams of the island hydrator (all injectable; feature-detected defaults).
 * Missing IntersectionObserver (old Safari, some webviews) degrades `visible` to "now";
 * missing requestIdleCallback (Safari) falls back to a timeout (loader's `defaultIdleScheduler`).
 */
import { defaultIdleScheduler, type IdleScheduler } from '@staticflux/loader';
import type { IslandSize } from './marker.js';

/** Calls `onVisible` once, when `element` is (near) the viewport. */
export type VisibilityTrigger = (element: Element, onVisible: () => void, signal: AbortSignal) => void;

export interface IslandEnv {
  /** `undefined` → no IntersectionObserver: `visible` islands hydrate right away. */
  readonly whenVisible: VisibilityTrigger | undefined;
  readonly idle: IdleScheduler;
  /** Runs `callback` after the next frame (the post-hydration size check). */
  readonly afterFrame: (callback: () => void, signal: AbortSignal) => void;
  /** Rendered box of an island. */
  readonly measure: (element: Element) => IslandSize;
  readonly now: () => number;
}

interface IntersectionEntryLike {
  readonly isIntersecting: boolean;
  readonly target: Element;
}

type IntersectionObserverCtor = new (
  callback: (entries: readonly IntersectionEntryLike[]) => void,
  options?: { rootMargin?: string },
) => { observe(target: Element): void; unobserve(target: Element): void };

/** One shared IntersectionObserver for every island (`rootMargin` pre-hydrates just before entering). */
export function intersectionVisibility(ctor: IntersectionObserverCtor, rootMargin = '200px'): VisibilityTrigger {
  const waiting = new Map<Element, Set<() => void>>();
  let observer: InstanceType<IntersectionObserverCtor> | undefined;
  const ensure = (): InstanceType<IntersectionObserverCtor> => {
    observer ??= new ctor((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callbacks = waiting.get(entry.target);
        if (callbacks === undefined) continue;
        waiting.delete(entry.target);
        observer?.unobserve(entry.target);
        for (const callback of callbacks) callback();
      }
    }, { rootMargin });
    return observer;
  };
  return (element, onVisible, signal) => {
    if (signal.aborted) return;
    let callbacks = waiting.get(element);
    if (callbacks === undefined) {
      callbacks = new Set();
      waiting.set(element, callbacks);
      ensure().observe(element);
    }
    // `detach` removes the abort listener once the island became visible (no listener left on `signal`).
    const detach = new AbortController();
    const once = (): void => {
      detach.abort();
      onVisible();
    };
    callbacks.add(once);
    signal.addEventListener('abort', () => {
      const set = waiting.get(element);
      if (set === undefined) return;
      set.delete(once);
      if (set.size === 0) {
        waiting.delete(element);
        observer?.unobserve(element);
      }
    }, { once: true, signal: detach.signal });
  };
}

export function defaultVisibilityTrigger(): VisibilityTrigger | undefined {
  const ctor = (globalThis as { IntersectionObserver?: IntersectionObserverCtor }).IntersectionObserver;
  return typeof ctor === 'function' ? intersectionVisibility(ctor) : undefined;
}

export const defaultAfterFrame = (callback: () => void, signal: AbortSignal): void => {
  if (signal.aborted) return;
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  const run = (): void => {
    if (!signal.aborted) callback();
  };
  if (typeof raf === 'function') raf(run);
  else setTimeout(run, 16);
};

/**
 * Box of an island. `<sf-island>` is usually `display: contents` (0×0 box): then the union of
 * its element children's boxes is measured.
 */
export function measureIsland(element: Element): IslandSize {
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0 || element.children.length === 0) return { width: rect.width, height: rect.height };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const child of Array.from(element.children)) {
    const r = child.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  if (right < left) return { width: 0, height: 0 };
  return { width: right - left, height: bottom - top };
}

const defaultNow = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

export function browserIslandEnv(): IslandEnv {
  return {
    whenVisible: defaultVisibilityTrigger(),
    idle: defaultIdleScheduler,
    afterFrame: defaultAfterFrame,
    measure: measureIsland,
    now: defaultNow,
  };
}
