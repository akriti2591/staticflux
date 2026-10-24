/**
 * View-state handoff within a feature (R19.4, R18.6) and "persist on hide".
 *
 * - `remember(view, state)` / `recall(view)` keep per-view state (scroll,
 *   selection, expanded rows) while the user moves between sub-routes/tabs.
 * - `pass(state)` / `receive()` hand state one-shot to whichever view (or mode
 *   variant: studio-desktop → studio-mobile) mounts next.
 *
 * Both live in memory by default (this page only); pass `scope: 'tab'` to keep
 * them across a reload (e.g. scroll position).
 */
import { ok, type Result, type Scope } from '@staticflux/core';
import type { HandoffSchema } from './envelope.js';
import { defineHandoff, type HandoffKey, type HandoffScope, type HandoffSlot } from './slot.js';
import type { HandoffStore } from './store.js';

export interface ViewStateHandoff<T> {
  readonly key: HandoffKey;
  remember(view: string, state: T): Promise<Result<void>>;
  recall(view: string): Promise<Result<T | undefined>>;
  forget(view?: string): Promise<Result<void>>;
  pass(state: T): Promise<Result<void>>;
  receive(): Promise<Result<T | undefined>>;
}

export interface ViewStateHandoffOptions<T> {
  readonly key: HandoffKey;
  readonly version: number;
  readonly scope?: HandoffScope;
  /** Validates each view's state. */
  readonly schema?: HandoffSchema<T>;
}

export function createViewStateHandoff<T>(store: HandoffStore, options: ViewStateHandoffOptions<T>): ViewStateHandoff<T> {
  const scope = options.scope ?? 'memory';
  const schema = options.schema;
  const isRecord = (value: unknown): value is Readonly<Record<string, T>> => {
    if (typeof value !== 'object' || value === null) return false;
    if (schema === undefined) return true;
    return Object.values(value).every((v) => (typeof schema === 'function' ? schema(v) : schema.parse(v).ok));
  };
  const views: HandoffSlot<Readonly<Record<string, T>>> = defineHandoff({
    key: options.key,
    version: options.version,
    lifetime: 'session',
    scope,
    schema: isRecord,
  });
  const passed: HandoffSlot<T> = defineHandoff<T>({
    key: `${options.key}:pass` as HandoffKey,
    version: options.version,
    lifetime: 'one-shot',
    scope,
    ...(schema === undefined ? {} : { schema }),
  });

  return {
    key: options.key,
    async remember(view, state) {
      const current = await store.peek(views);
      const next = { ...(current.ok ? current.value : undefined), [view]: state };
      const written = await store.put(views, next);
      return written.ok ? ok() : written;
    },
    async recall(view) {
      const current = await store.peek(views);
      return current.ok ? ok(current.value?.[view]) : current;
    },
    async forget(view) {
      if (view === undefined) return store.discard(views);
      const current = await store.peek(views);
      if (!current.ok) return current;
      if (current.value === undefined) return ok();
      const { [view]: _removed, ...rest } = current.value;
      const written = await store.put(views, rest);
      return written.ok ? ok() : written;
    },
    async pass(state) {
      const written = await store.put(passed, state);
      return written.ok ? ok() : written;
    },
    receive() {
      return store.take(passed);
    },
  };
}

/**
 * Run `save` when the page is being hidden (tab switch, navigation away, mobile
 * backgrounding) — `visibilitychange: hidden` and `pagehide`, never `unload`
 * (bfcache-friendly). Listeners are removed with `scope`.
 */
export function persistOnHide(target: { readonly document?: Document; readonly window?: Window }, scope: Scope, save: () => void): void {
  const doc = target.document;
  if (doc !== undefined) {
    scope.listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'hidden') save();
    });
  }
  if (target.window !== undefined) scope.listen(target.window, 'pagehide', () => save());
}
