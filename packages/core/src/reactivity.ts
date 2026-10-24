/**
 * Reactivity port. Framework internals use only these functions so the
 * implementation (MobX 7 today) can be swapped for native Signals later.
 * Feature code may use MobX directly.
 */
import {
  Reaction,
  autorun,
  computed as mobxComputed,
  observable,
  reaction,
  runInAction,
  untracked as mobxUntracked,
} from 'mobx';
import type { Scope } from './disposal.js';

export interface Box<T> {
  get(): T;
  set(value: T): void;
}

export interface Derived<T> {
  get(): T;
}

/** A single observable value (shallow). */
export function box<T>(initial: T, equals?: (a: T, b: T) => boolean): Box<T> {
  const inner = observable.box(initial, { deep: false, ...(equals === undefined ? {} : { equals }) });
  return {
    get: () => inner.get(),
    set: (value) => {
      runInAction(() => inner.set(value));
    },
  };
}

/** A cached derived value. */
export function derived<T>(fn: () => T): Derived<T> {
  const inner = mobxComputed(fn);
  return { get: () => inner.get() };
}

/** Run `fn` now and whenever what it read changes. Disposed with `scope` if given. */
export function effect(fn: () => void, scope?: Scope): () => void {
  const dispose = autorun(fn);
  scope?.defer(dispose);
  return dispose;
}

/** Run `effect` when `expression`'s value changes (not initially, unless `fireImmediately`). */
export function watch<T>(
  expression: () => T,
  onChange: (value: T, previous: T | undefined) => void,
  options: { scope?: Scope; fireImmediately?: boolean } = {},
): () => void {
  const dispose = reaction(expression, (value, previous) => onChange(value, previous), {
    fireImmediately: options.fireImmediately ?? false,
  });
  options.scope?.defer(dispose);
  return dispose;
}

/** Apply several changes as one transaction (one notification). */
export function batch<T>(fn: () => T): T {
  return runInAction(fn);
}

/** Read without tracking. */
export function untracked<T>(fn: () => T): T {
  return mobxUntracked(fn);
}

export interface Tracker {
  /** Run `fn`, tracking every observable it reads; `onInvalidate` fires once any of them changes. */
  track<T>(fn: () => T): T;
  dispose(): void;
}

/**
 * Track reads explicitly (e.g. a component's render) and get notified on change.
 * Re-call `track()` after each invalidation to re-subscribe to what was read this time.
 */
export function createTracker(name: string, onInvalidate: () => void, scope?: Scope): Tracker {
  const reaction = new Reaction(name, onInvalidate);
  let result: unknown;
  const tracker: Tracker = {
    track<T>(fn: () => T): T {
      reaction.track(() => {
        result = fn();
      });
      return result as T;
    },
    dispose() {
      reaction.dispose();
    },
  };
  scope?.defer(() => tracker.dispose());
  return tracker;
}
