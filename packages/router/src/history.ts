/**
 * History strategies behind one port (R7.4, R18.9).
 *
 * `HistoryAdapter` is a structural superset of `@staticflux/urlstate`'s `HistoryPort`
 * (`kind`, `url`, `canGoBack`, `push/replace(url, { state, source })`, `back`, `subscribe`,
 * `dispose`), so ONE adapter instance serves both packages: bind it to the router's
 * `HistoryAdapterToken` and urlstate's `HistoryPortToken`. The router adds:
 * - `current` (entry with index/key/state) for revert-and-replay,
 * - `go(delta, { silent })` — silent traversals do not reach `listen` (router-internal commits/reverts),
 * - `listen` — navigations the router must run through its pipeline (back/forward,
 *   intercepted link clicks, host-initiated navigations).
 *
 * Writes carry a `source`; the router writes with `source: 'router'` (`ROUTER_SOURCE`), so urlstate
 * can tell router navigations from its own URL-sync writes and vice versa.
 *
 * Implementations: `createMemoryHistory` (embedded hosts, tests — here) and
 * `createBrowserHistory` (Navigation API with History API fallback — browser-history.ts).
 */
export type HistoryKind = 'navigation' | 'history' | 'memory';
export type HistoryChangeCause = 'push' | 'replace' | 'pop';

/** The router's write source. */
export const ROUTER_SOURCE = 'router';
/** Source of traversals and writes nobody claimed. */
export const EXTERNAL_SOURCE = 'external';

export interface HistoryChange {
  /** Path + search + hash. */
  readonly url: string;
  readonly cause: HistoryChangeCause;
  readonly source: string;
}

export interface WriteOptions {
  readonly state?: unknown;
  /** Defaults to `external`. */
  readonly source?: string;
}

export interface HistoryEntry {
  readonly url: string;
  readonly key: string;
  /** Position in the session history (relative to the app's first entry). */
  readonly index: number;
  readonly state: unknown;
}

/** A navigation the router did not start and must run through its pipeline. */
export interface ExternalNavigation {
  readonly url: string;
  readonly type: 'traverse' | 'push' | 'replace';
  /** Traversal distance (0 for push/replace). */
  readonly delta: number;
  /**
   * True when the URL already changed (popstate cannot be blocked): the router reverts with a
   * silent `go()` if the pipeline does not commit. False when the adapter deferred it
   * (Navigation API `preventDefault`, deferred memory traversal): the router commits it itself.
   */
  readonly committed: boolean;
  readonly state: unknown;
  readonly userInitiated: boolean;
}

export interface GoOptions {
  /** Do not report the traversal to `listen` listeners (router-internal commit/revert). */
  readonly silent?: boolean;
}

export interface HistoryAdapter {
  readonly kind: HistoryKind;
  /** Current URL: path + search + hash. */
  readonly url: string;
  /** True when a back traversal stays inside the app. */
  readonly canGoBack: boolean;
  readonly current: HistoryEntry;
  push(url: string, options?: WriteOptions): void;
  replace(url: string, options?: WriteOptions): void;
  back(): void;
  canGo(delta: number): boolean;
  /** Traverse; resolves when the traversal has been applied (and reported, unless silent). */
  go(delta: number, options?: GoOptions): Promise<void>;
  /** Every entry change (urlstate-compatible). */
  subscribe(listener: (change: HistoryChange) => void): () => void;
  /** Navigations for the router pipeline. */
  listen(listener: (navigation: ExternalNavigation) => void): () => void;
  dispose(): void;
}

export interface Emitter<T> {
  emit(value: T): void;
  on(listener: (value: T) => void): () => void;
  readonly size: number;
}

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get size() {
      return listeners.size;
    },
  };
}

// ---------------------------------------------------------------- memory

export interface MemoryHistoryOptions {
  /** Initial entries (default `['/']`). */
  readonly initial?: string | readonly string[];
  /** Index of the current initial entry (default: last). */
  readonly initialIndex?: number;
  /**
   * `committed` (default) mimics popstate: the index moves first, then the router is told
   * (revert-and-replay). `deferred` mimics Navigation API interception: the router decides first.
   */
  readonly traversal?: 'committed' | 'deferred';
}

export interface MemoryHistory extends HistoryAdapter {
  readonly entries: readonly HistoryEntry[];
  readonly index: number;
  forward(): void;
  /** Host-initiated navigation (embedded host bridge, R18.9): runs through the router pipeline. */
  navigateExternal(url: string, options?: { readonly replace?: boolean; readonly state?: unknown }): void;
}

export function createMemoryHistory(options: MemoryHistoryOptions = {}): MemoryHistory {
  const initial = typeof options.initial === 'string' ? [options.initial] : (options.initial ?? ['/']);
  let counter = 0;
  const entry = (url: string, index: number, state: unknown): HistoryEntry => {
    counter += 1;
    return Object.freeze({ url, key: `m${counter}`, index, state });
  };
  const entries: HistoryEntry[] = (initial.length === 0 ? ['/'] : initial).map((url, i) => entry(url, i, null));
  let index = Math.min(entries.length - 1, Math.max(0, options.initialIndex ?? entries.length - 1));
  const traversal = options.traversal ?? 'committed';
  const changes = createEmitter<HistoryChange>();
  const navigations = createEmitter<ExternalNavigation>();

  const current = (): HistoryEntry => entries[index] as HistoryEntry;
  const clamp = (delta: number): number => Math.min(entries.length - 1, Math.max(0, index + delta));

  const history: MemoryHistory = {
    kind: 'memory',
    get url() {
      return current().url;
    },
    get canGoBack() {
      return index > 0;
    },
    get current() {
      return current();
    },
    get entries() {
      return entries;
    },
    get index() {
      return index;
    },
    push(url, write = {}) {
      entries.splice(index + 1, entries.length, entry(url, index + 1, write.state ?? null));
      index = entries.length - 1;
      changes.emit({ url, cause: 'push', source: write.source ?? EXTERNAL_SOURCE });
    },
    replace(url, write = {}) {
      entries[index] = entry(url, index, write.state ?? null);
      changes.emit({ url, cause: 'replace', source: write.source ?? EXTERNAL_SOURCE });
    },
    back() {
      void history.go(-1);
    },
    forward() {
      void history.go(1);
    },
    canGo(delta) {
      const next = index + delta;
      return next >= 0 && next < entries.length;
    },
    async go(delta, goOptions = {}) {
      const next = clamp(delta);
      if (next === index) return;
      const target = entries[next] as HistoryEntry;
      if (goOptions.silent === true) {
        index = next;
        changes.emit({ url: target.url, cause: 'pop', source: ROUTER_SOURCE });
        return;
      }
      if (traversal === 'deferred' && navigations.size > 0) {
        navigations.emit({ url: target.url, type: 'traverse', delta: next - index, committed: false, state: target.state, userInitiated: true });
        return;
      }
      const moved = next - index;
      index = next;
      changes.emit({ url: target.url, cause: 'pop', source: EXTERNAL_SOURCE });
      navigations.emit({ url: target.url, type: 'traverse', delta: moved, committed: true, state: target.state, userInitiated: true });
    },
    navigateExternal(url, external = {}) {
      navigations.emit({
        url,
        type: external.replace === true ? 'replace' : 'push',
        delta: 0,
        committed: false,
        state: external.state ?? null,
        userInitiated: false,
      });
    },
    subscribe: (listener) => changes.on(listener),
    listen: (listener) => navigations.on(listener),
    dispose: () => undefined,
  };
  return history;
}
