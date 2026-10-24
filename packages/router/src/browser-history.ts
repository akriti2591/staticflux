/**
 * Browser history adapter (R7.4, R18.9): Navigation API where available (feature-detected,
 * Baseline 2026; Safari < 26.2 lacks it), History API fallback.
 *
 * - Writes always use `history.pushState/replaceState` (same as urlstate), with an envelope
 *   `{ __sf: { key, index }, state }` so traversal distances are known.
 * - History API: back/forward arrive as `popstate`, which cannot be blocked: they are reported
 *   `committed: true` and the router reverts with a silent `go()` if the pipeline does not commit.
 * - Navigation API: cancelable traversals and user-initiated same-origin link navigations are
 *   `preventDefault()`-ed and reported `committed: false`; the router commits them itself
 *   (silent `go()` / `pushState`) after the pipeline passes. Non-cancelable traversals fall
 *   back to the popstate path.
 * - Everything is injected (`window` shape) for tests; nothing touches globals at import time.
 */
import {
  createEmitter,
  type ExternalNavigation,
  EXTERNAL_SOURCE,
  type GoOptions,
  type HistoryAdapter,
  type HistoryChange,
  type HistoryEntry,
  ROUTER_SOURCE,
  type WriteOptions,
} from './history.js';

export interface HistoryLike {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
  go(delta: number): void;
}

export interface NavigateEventLike {
  readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  readonly destination: { readonly url: string; readonly index: number };
  readonly canIntercept: boolean;
  readonly cancelable: boolean;
  readonly userInitiated: boolean;
  readonly hashChange: boolean;
  readonly downloadRequest: string | null;
  readonly formData: unknown;
  preventDefault(): void;
}

export interface NavigationLike {
  readonly currentEntry: { readonly index: number } | null;
  addEventListener(type: 'navigate', listener: (event: NavigateEventLike) => void): void;
  removeEventListener(type: 'navigate', listener: (event: NavigateEventLike) => void): void;
}

export interface BrowserWindowLike {
  readonly location: { readonly pathname: string; readonly search: string; readonly hash: string; readonly origin: string };
  readonly history: HistoryLike;
  readonly navigation?: NavigationLike | undefined;
  addEventListener(type: 'popstate', listener: (event: Event) => void): void;
  removeEventListener(type: 'popstate', listener: (event: Event) => void): void;
}

export interface BrowserHistoryOptions {
  readonly window: BrowserWindowLike;
  /** Force the History API path even when the Navigation API exists. */
  readonly preferHistoryApi?: boolean;
  /** Intercept user-initiated same-origin link navigations (Navigation API only). Default true. */
  readonly interceptLinks?: boolean;
  /** Resolve `go()` after this long if no traversal event arrives (out-of-range deltas). Default 1000. */
  readonly traverseTimeoutMs?: number;
}

interface Envelope {
  readonly __sf: { readonly key: string; readonly index: number };
  readonly state: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && '__sf' in value;
}

/** True when `win` exposes a usable Navigation API. */
export function supportsNavigationApi(win: Pick<BrowserWindowLike, 'navigation'>): boolean {
  const navigation = win.navigation;
  return navigation !== undefined && navigation !== null && typeof navigation.addEventListener === 'function';
}

export function createBrowserHistory(options: BrowserHistoryOptions): HistoryAdapter {
  const win = options.window;
  const navigation = options.preferHistoryApi === true || !supportsNavigationApi(win) ? undefined : win.navigation;
  const interceptLinks = options.interceptLinks ?? true;
  const timeoutMs = options.traverseTimeoutMs ?? 1000;
  const changes = createEmitter<HistoryChange>();
  const navigations = createEmitter<ExternalNavigation>();
  let counter = 0;
  const newKey = (): string => {
    counter += 1;
    return `b${Date.now().toString(36)}-${counter}`;
  };
  const relativeUrl = (): string => `${win.location.pathname}${win.location.search}${win.location.hash}`;

  // Install the envelope on the entry we booted on.
  let current: HistoryEntry;
  {
    const existing = win.history.state;
    if (isEnvelope(existing)) {
      current = { url: relativeUrl(), key: existing.__sf.key, index: existing.__sf.index, state: existing.state };
    } else {
      const key = newKey();
      const index = navigation?.currentEntry?.index ?? 0;
      win.history.replaceState({ __sf: { key, index }, state: existing ?? null } satisfies Envelope, '', relativeUrl());
      current = { url: relativeUrl(), key, index, state: existing ?? null };
    }
  }

  let writing = false;
  let silentPending = 0;
  let waiters: (() => void)[] = [];
  const resolveWaiters = (): void => {
    const list = waiters;
    waiters = [];
    for (const resolve of list) resolve();
  };

  const write = (cause: 'push' | 'replace', url: string, writeOptions: WriteOptions): void => {
    const key = newKey();
    const index = cause === 'push' ? current.index + 1 : current.index;
    const envelope: Envelope = { __sf: { key, index }, state: writeOptions.state ?? null };
    writing = true;
    try {
      if (cause === 'push') win.history.pushState(envelope, '', url);
      else win.history.replaceState(envelope, '', url);
    } finally {
      writing = false;
    }
    current = { url: relativeUrl(), key, index, state: writeOptions.state ?? null };
    changes.emit({ url: current.url, cause, source: writeOptions.source ?? EXTERNAL_SOURCE });
  };

  const onPop = (): void => {
    const state = win.history.state;
    let index: number;
    let key: string;
    let userState: unknown;
    if (isEnvelope(state)) {
      index = state.__sf.index;
      key = state.__sf.key;
      userState = state.state;
    } else {
      // Entry written by someone else (hash link, third-party pushState): adopt it as the next entry.
      index = current.index + 1;
      key = newKey();
      userState = state ?? null;
      win.history.replaceState({ __sf: { key, index }, state: userState } satisfies Envelope, '', relativeUrl());
    }
    const delta = index - current.index;
    current = { url: relativeUrl(), key, index, state: userState };
    if (silentPending > 0) {
      silentPending -= 1;
      changes.emit({ url: current.url, cause: 'pop', source: ROUTER_SOURCE });
      resolveWaiters();
      return;
    }
    changes.emit({ url: current.url, cause: 'pop', source: EXTERNAL_SOURCE });
    navigations.emit({ url: current.url, type: 'traverse', delta, committed: true, state: userState, userInitiated: true });
    resolveWaiters();
  };

  const onNavigate = (event: NavigateEventLike): void => {
    if (writing || silentPending > 0) return;
    if (event.navigationType === 'traverse') {
      if (!event.cancelable) return; // popstate path (committed, revert-and-replay)
      event.preventDefault();
      const from = navigation?.currentEntry?.index ?? current.index;
      navigations.emit({
        url: toRelative(event.destination.url),
        type: 'traverse',
        delta: event.destination.index - from,
        committed: false,
        state: null,
        userInitiated: event.userInitiated,
      });
      resolveWaiters();
      return;
    }
    if (event.navigationType === 'reload' || !interceptLinks) return;
    if (!event.canIntercept || !event.userInitiated || event.hashChange) return;
    if (event.downloadRequest !== null || (event.formData !== null && event.formData !== undefined)) return;
    const destination = new URL(event.destination.url);
    if (destination.origin !== win.location.origin) return;
    event.preventDefault();
    navigations.emit({
      url: `${destination.pathname}${destination.search}${destination.hash}`,
      type: event.navigationType,
      delta: 0,
      committed: false,
      state: null,
      userInitiated: true,
    });
  };

  const toRelative = (absolute: string): string => {
    const url = new URL(absolute, `${win.location.origin}/`);
    return `${url.pathname}${url.search}${url.hash}`;
  };

  win.addEventListener('popstate', onPop);
  navigation?.addEventListener('navigate', onNavigate);

  const adapter: HistoryAdapter = {
    kind: navigation === undefined ? 'history' : 'navigation',
    get url() {
      return relativeUrl();
    },
    get canGoBack() {
      return current.index > 0;
    },
    get current() {
      return current;
    },
    push: (url, writeOptions = {}) => write('push', url, writeOptions),
    replace: (url, writeOptions = {}) => write('replace', url, writeOptions),
    back() {
      void adapter.go(-1);
    },
    canGo(delta) {
      return current.index + delta >= 0;
    },
    go(delta: number, goOptions: GoOptions = {}) {
      if (delta === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          if (goOptions.silent === true && silentPending > 0) silentPending -= 1;
          waiters = waiters.filter((w) => w !== finish);
          finish();
        }, timeoutMs);
        waiters.push(finish);
        if (goOptions.silent === true) silentPending += 1;
        win.history.go(delta);
      });
    },
    subscribe: (listener) => changes.on(listener),
    listen: (listener) => navigations.on(listener),
    dispose() {
      win.removeEventListener('popstate', onPop);
      navigation?.removeEventListener('navigate', onNavigate);
      resolveWaiters();
    },
  };
  return adapter;
}
