/**
 * `HistoryPort`: the one way urlstate (and the router) touch session history.
 * Implementations:
 * - `createNavigationHistory` — Navigation API (Baseline 2026) for observing every
 *   entry change; writes still use `history.pushState/replaceState`, because a
 *   same-document `navigation.navigate()` without interception would reload.
 * - `createBrowserHistory` — History API fallback (`popstate`).
 * - `createMemoryHistory` — embedded hosts (host owns the URL) and tests.
 * `detectHistory()` picks the best available.
 *
 * Writes made through the port notify subscribers with their `source`, so a
 * URL-sync write is distinguishable from a router navigation.
 */

export type HistoryChangeCause = 'push' | 'replace' | 'pop';

export interface HistoryChange {
  /** Path + search + hash. */
  readonly url: string;
  readonly cause: HistoryChangeCause;
  /** Who wrote it (`urlstate`, `router`, …); `external` for traversals and third-party writes. */
  readonly source: string;
}

export interface WriteOptions {
  readonly state?: unknown;
  /** Defaults to `external`. */
  readonly source?: string;
}

export interface HistoryPort {
  readonly kind: 'navigation' | 'history' | 'memory';
  /** Current URL: path + search + hash. */
  readonly url: string;
  /** True when a back traversal stays inside the app. */
  readonly canGoBack: boolean;
  push(url: string, options?: WriteOptions): void;
  replace(url: string, options?: WriteOptions): void;
  back(): void;
  subscribe(listener: (change: HistoryChange) => void): () => void;
  dispose(): void;
}

function relative(location: { readonly pathname: string; readonly search: string; readonly hash: string }): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function notifier(): { emit(change: HistoryChange): void; subscribe(l: (c: HistoryChange) => void): () => void } {
  const listeners = new Set<(change: HistoryChange) => void>();
  return {
    emit(change) {
      for (const listener of [...listeners]) listener(change);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** In-memory history (embedded hosts, tests). */
export function createMemoryHistory(initial = '/'): HistoryPort & { readonly entries: readonly string[]; readonly index: number; forward(): void; go(delta: number): void } {
  const entries: string[] = [initial];
  let index = 0;
  const events = notifier();
  const go = (delta: number): void => {
    const next = Math.min(entries.length - 1, Math.max(0, index + delta));
    if (next === index) return;
    index = next;
    events.emit({ url: entries[index] ?? '/', cause: 'pop', source: 'external' });
  };
  return {
    kind: 'memory',
    get url() {
      return entries[index] ?? '/';
    },
    get canGoBack() {
      return index > 0;
    },
    get entries() {
      return entries;
    },
    get index() {
      return index;
    },
    push(url, options = {}) {
      entries.splice(index + 1, entries.length, url);
      index = entries.length - 1;
      events.emit({ url, cause: 'push', source: options.source ?? 'external' });
    },
    replace(url, options = {}) {
      entries[index] = url;
      events.emit({ url, cause: 'replace', source: options.source ?? 'external' });
    },
    back: () => go(-1),
    forward: () => go(1),
    go,
    subscribe: events.subscribe,
    dispose: () => undefined,
  };
}

interface WindowLike {
  readonly location: Location;
  readonly history: History;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** History API implementation (`popstate`). */
export function createBrowserHistory(win: WindowLike): HistoryPort {
  const events = notifier();
  let depth = 0; // in-app entries pushed in this document (History API cannot tell)
  const onPop = (): void => {
    depth = Math.max(0, depth - 1);
    events.emit({ url: relative(win.location), cause: 'pop', source: 'external' });
  };
  // sf-lint-disable-next-line no-bare-listener -- port-lifetime listener removed in dispose(); WindowLike takes no listener options
  win.addEventListener('popstate', onPop);
  return {
    kind: 'history',
    get url() {
      return relative(win.location);
    },
    get canGoBack() {
      return depth > 0;
    },
    push(url, options = {}) {
      win.history.pushState(options.state ?? null, '', url);
      depth += 1;
      events.emit({ url: relative(win.location), cause: 'push', source: options.source ?? 'external' });
    },
    replace(url, options = {}) {
      win.history.replaceState(options.state ?? null, '', url);
      events.emit({ url: relative(win.location), cause: 'replace', source: options.source ?? 'external' });
    },
    back: () => win.history.back(),
    subscribe: events.subscribe,
    dispose: () => win.removeEventListener('popstate', onPop),
  };
}

interface NavigationLike {
  readonly canGoBack?: boolean;
  addEventListener(type: 'currententrychange', listener: (event: Event & { navigationType?: string }) => void): void;
  removeEventListener(type: 'currententrychange', listener: (event: Event) => void): void;
}

/** Navigation API implementation: observes every entry change, including third-party pushState and traversals. */
export function createNavigationHistory(win: WindowLike & { readonly navigation: NavigationLike }): HistoryPort {
  const events = notifier();
  const navigation = win.navigation;
  let writing = false;
  let lastUrl = relative(win.location);
  const onChange = (event: Event & { navigationType?: string }): void => {
    const url = relative(win.location);
    if (writing) return;
    const type = event.navigationType;
    if (url === lastUrl && type !== 'traverse') return;
    lastUrl = url;
    const cause: HistoryChangeCause = type === 'push' ? 'push' : type === 'replace' ? 'replace' : 'pop';
    events.emit({ url, cause, source: 'external' });
  };
  // sf-lint-disable-next-line no-bare-listener -- port-lifetime listener removed in dispose(); NavigationLike takes no listener options
  navigation.addEventListener('currententrychange', onChange);
  const write = (cause: 'push' | 'replace', url: string, options: WriteOptions): void => {
    writing = true;
    try {
      if (cause === 'push') win.history.pushState(options.state ?? null, '', url);
      else win.history.replaceState(options.state ?? null, '', url);
    } finally {
      writing = false;
    }
    lastUrl = relative(win.location);
    events.emit({ url: lastUrl, cause, source: options.source ?? 'external' });
  };
  return {
    kind: 'navigation',
    get url() {
      return relative(win.location);
    },
    get canGoBack() {
      return navigation.canGoBack ?? false;
    },
    push: (url, options = {}) => write('push', url, options),
    replace: (url, options = {}) => write('replace', url, options),
    back: () => win.history.back(),
    subscribe: events.subscribe,
    dispose: () => navigation.removeEventListener('currententrychange', onChange),
  };
}

/** Best available implementation for this global; memory (at `/`) without a window. */
export function detectHistory(global: typeof globalThis = globalThis): HistoryPort {
  const win = (typeof global.window === 'undefined' ? undefined : global.window) as (WindowLike & { navigation?: NavigationLike }) | undefined;
  if (win === undefined || win.history === undefined || win.location === undefined) return createMemoryHistory('/');
  const navigation = win.navigation;
  if (navigation !== undefined && typeof navigation.addEventListener === 'function') {
    return createNavigationHistory(win as WindowLike & { navigation: NavigationLike });
  }
  return createBrowserHistory(win);
}
