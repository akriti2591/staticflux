import { defineError } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  block,
  type BrowserWindowLike,
  createBrowserHistory,
  createMemoryHistory,
  createRouter,
  defineRoute,
  type ExternalNavigation,
  type HistoryChange,
  type NavigateEventLike,
  proceed,
  supportsNavigationApi,
} from './index.js';

const Denied = defineError('SF-TEST-HIST', 'forbidden', 'denied', 'test');

interface FakeOptions {
  readonly navigation?: boolean;
  readonly cancelableTraverse?: boolean;
  readonly initialState?: unknown;
}

function fakeWindow(options: FakeOptions = {}) {
  const origin = 'https://app.test';
  const entries: { url: string; state: unknown }[] = [{ url: '/', state: options.initialState ?? null }];
  let index = 0;
  const popListeners = new Set<(e: Event) => void>();
  const navListeners = new Set<(e: NavigateEventLike) => void>();
  const log: string[] = [];
  const current = () => entries[index] as { url: string; state: unknown };
  const parts = () => new URL(current().url, origin);
  const fireNavigate = (init: Partial<NavigateEventLike> & Pick<NavigateEventLike, 'navigationType' | 'destination'>): boolean => {
    let prevented = false;
    const event: NavigateEventLike = {
      canIntercept: true,
      cancelable: true,
      userInitiated: false,
      hashChange: false,
      downloadRequest: null,
      formData: null,
      ...init,
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const l of [...navListeners]) l(event);
    return prevented;
  };
  const navigation = {
    get currentEntry() {
      return { index };
    },
    addEventListener: (_t: 'navigate', l: (e: NavigateEventLike) => void) => void navListeners.add(l),
    removeEventListener: (_t: 'navigate', l: (e: NavigateEventLike) => void) => void navListeners.delete(l),
  };
  const win: BrowserWindowLike = {
    get location() {
      const u = parts();
      return { pathname: u.pathname, search: u.search, hash: u.hash, origin };
    },
    history: {
      get state() {
        return current().state;
      },
      pushState(state, _u, url) {
        if (options.navigation === true) fireNavigate({ navigationType: 'push', destination: { url: new URL(url, origin).href, index: index + 1 } });
        entries.splice(index + 1, entries.length, { url, state });
        index += 1;
      },
      replaceState(state, _u, url) {
        if (options.navigation === true) fireNavigate({ navigationType: 'replace', destination: { url: new URL(url, origin).href, index } });
        entries[index] = { url, state };
      },
      go(delta) {
        setTimeout(() => {
          const next = index + delta;
          if (next < 0 || next >= entries.length) return;
          if (options.navigation === true) {
            const prevented = fireNavigate({
              navigationType: 'traverse',
              cancelable: options.cancelableTraverse ?? true,
              userInitiated: true,
              destination: { url: new URL((entries[next] as { url: string }).url, origin).href, index: next },
            });
            if (prevented) return;
          }
          index = next;
          for (const l of [...popListeners]) l(new Event('popstate'));
        }, 0);
      },
    },
    ...(options.navigation === true ? { navigation } : {}),
    addEventListener: (_t: 'popstate', l: (e: Event) => void) => void popListeners.add(l),
    removeEventListener: (_t: 'popstate', l: (e: Event) => void) => void popListeners.delete(l),
  };
  /** A user clicking a link (Navigation API only); returns true if a full load would have happened. */
  const click = (url: string): boolean => {
    const prevented = fireNavigate({ navigationType: 'push', userInitiated: true, destination: { url: new URL(url, origin).href, index: index + 1 } });
    if (!prevented) log.push(`full-load:${url}`);
    return !prevented;
  };
  return {
    win,
    entries,
    click,
    log,
    get index() {
      return index;
    },
    get listenerCount() {
      return popListeners.size + navListeners.size;
    },
  };
}

function record(adapter: { subscribe(l: (c: HistoryChange) => void): () => void; listen(l: (n: ExternalNavigation) => void): () => void }) {
  const changes: string[] = [];
  const navigations: ExternalNavigation[] = [];
  adapter.subscribe((c) => changes.push(`${c.cause}:${c.source}:${c.url}`));
  adapter.listen((n) => navigations.push(n));
  return { changes, navigations };
}

describe('memory history', () => {
  it('push truncates forward entries, replace keeps the index, go clamps', async () => {
    const h = createMemoryHistory({ initial: ['/a', '/b'], initialIndex: 0 });
    const { changes, navigations } = record(h);
    expect(h.url).toBe('/a');
    h.push('/c', { source: 'urlstate', state: 1 });
    expect(h.entries.map((e) => e.url)).toEqual(['/a', '/c']);
    h.replace('/d');
    expect(h.current).toMatchObject({ url: '/d', index: 1, state: null });
    await h.go(-5);
    expect(h.index).toBe(0);
    expect(navigations[0]).toMatchObject({ type: 'traverse', delta: -1, committed: true });
    await h.go(-1); // nothing to do
    expect(navigations).toHaveLength(1);
    h.forward();
    expect(h.url).toBe('/d');
    await h.go(-1, { silent: true });
    expect(navigations).toHaveLength(2);
    expect(changes).toEqual(['push:urlstate:/c', 'replace:external:/d', 'pop:external:/a', 'pop:external:/d', 'pop:router:/a']);
    expect(h.canGo(1)).toBe(true);
    expect(h.canGo(2)).toBe(false);
    expect(h.canGoBack).toBe(false);
    h.back();
    h.dispose();
  });

  it('deferred traversals are reported before the index moves', async () => {
    const h = createMemoryHistory({ initial: ['/a', '/b'], traversal: 'deferred' });
    const { navigations } = record(h);
    await h.go(-1);
    expect(h.index).toBe(1);
    expect(navigations[0]).toMatchObject({ url: '/a', committed: false, delta: -1 });
  });

  it('navigateExternal reports host navigations', () => {
    const h = createMemoryHistory();
    const { navigations } = record(h);
    h.navigateExternal('/x', { replace: true, state: 2 });
    expect(navigations[0]).toMatchObject({ url: '/x', type: 'replace', committed: false, state: 2, userInitiated: false });
  });
});

describe('browser history: History API fallback', () => {
  it('installs an envelope, writes with sources and reports popstate as committed traversals', async () => {
    const fake = fakeWindow({ initialState: { app: 1 } });
    const h = createBrowserHistory({ window: fake.win });
    expect(h.kind).toBe('history');
    expect(h.current).toMatchObject({ url: '/', index: 0, state: { app: 1 } });
    const { changes, navigations } = record(h);
    h.push('/a?x=1', { state: 'A', source: 'router' });
    h.push('/b', { source: 'urlstate' });
    h.replace('/c');
    expect(h.current).toMatchObject({ url: '/c', index: 2, state: null });
    expect(h.canGoBack).toBe(true);
    await h.go(-1);
    expect(h.url).toBe('/a?x=1');
    expect(navigations[0]).toMatchObject({ type: 'traverse', delta: -1, committed: true, state: 'A' });
    await h.go(1, { silent: true });
    expect(h.url).toBe('/c');
    expect(navigations).toHaveLength(1);
    expect(changes).toEqual(['push:router:/a?x=1', 'push:urlstate:/b', 'replace:external:/c', 'pop:external:/a?x=1', 'pop:router:/c']);
    h.dispose();
    expect(fake.listenerCount).toBe(0);
  });

  it('adopts entries written by third parties', async () => {
    const fake = fakeWindow();
    const h = createBrowserHistory({ window: fake.win });
    fake.win.history.pushState(null, '', '/foreign'); // bypasses the adapter
    fake.win.history.pushState(null, '', '/foreign2');
    const { navigations } = record(h);
    await h.go(-1);
    expect(navigations[0]).toMatchObject({ url: '/foreign', type: 'traverse', delta: 1, committed: true });
  });

  it('go() resolves after the timeout when nothing happens', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeWindow();
      const h = createBrowserHistory({ window: fake.win, traverseTimeoutMs: 50 });
      const pending = h.go(-3, { silent: true });
      await vi.advanceTimersByTimeAsync(60);
      await pending;
      expect(h.url).toBe('/');
      expect(await h.go(0)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('browser history: Navigation API', () => {
  it('feature-detects and can be forced to the History API', () => {
    expect(supportsNavigationApi(fakeWindow({ navigation: true }).win)).toBe(true);
    expect(supportsNavigationApi(fakeWindow().win)).toBe(false);
    expect(createBrowserHistory({ window: fakeWindow({ navigation: true }).win, preferHistoryApi: true }).kind).toBe('history');
  });

  it('defers cancelable traversals (not committed) and commits them with a silent go', async () => {
    const fake = fakeWindow({ navigation: true });
    const h = createBrowserHistory({ window: fake.win });
    expect(h.kind).toBe('navigation');
    h.push('/a');
    const { changes, navigations } = record(h);
    await h.go(-1);
    expect(fake.index).toBe(1);
    expect(navigations[0]).toMatchObject({ url: '/', type: 'traverse', delta: -1, committed: false });
    await h.go(-1, { silent: true });
    expect(fake.index).toBe(0);
    expect(navigations).toHaveLength(1);
    expect(changes).toEqual(['pop:router:/']);
  });

  it('non-cancelable traversals fall back to committed popstate', async () => {
    const fake = fakeWindow({ navigation: true, cancelableTraverse: false });
    const h = createBrowserHistory({ window: fake.win });
    h.push('/a');
    const { navigations } = record(h);
    await h.go(-1);
    expect(navigations[0]).toMatchObject({ committed: true, delta: -1 });
  });

  it('intercepts user-initiated same-origin links; own writes are not intercepted', () => {
    const fake = fakeWindow({ navigation: true });
    const h = createBrowserHistory({ window: fake.win });
    const { navigations } = record(h);
    h.push('/own');
    expect(navigations).toHaveLength(0);
    expect(fake.click('/link?q=1')).toBe(false);
    expect(navigations[0]).toMatchObject({ url: '/link?q=1', type: 'push', committed: false });
    expect(fake.click('https://elsewhere.test/x')).toBe(true);
    const noLinks = createBrowserHistory({ window: fakeWindow({ navigation: true }).win, interceptLinks: false });
    expect(noLinks.kind).toBe('navigation');
  });
});

describe('router over browser history (revert-and-replay)', () => {
  const home = defineRoute({ id: 'h/home', path: '/' });
  const next = defineRoute({ id: 'h/next', path: 'next' });

  it('History API: a blocked back is reverted with a silent forward traversal', async () => {
    let allow = false;
    const guarded = defineRoute({ id: 'h/guarded', path: 'guarded', guards: { exit: [() => (allow ? proceed() : block(Denied()))] } });
    const fake = fakeWindow();
    const history = createBrowserHistory({ window: fake.win });
    const created = createRouter({ routes: [home, next, guarded], history });
    if (!created.ok) throw created.error;
    const router = created.value;
    await router.start();
    await router.navigate({ to: guarded });
    expect(fake.index).toBe(1);
    const back = await router.back();
    expect(back.outcome).toBe('blocked');
    expect(fake.index).toBe(1);
    expect(history.url).toBe('/guarded');
    allow = true;
    expect((await router.back()).outcome).toBe('committed');
    expect(router.current?.route).toBe(home);
    expect(fake.index).toBe(0);
  });

  it('Navigation API: an intercepted link runs the pipeline and commits with pushState', async () => {
    const fake = fakeWindow({ navigation: true });
    const history = createBrowserHistory({ window: fake.win });
    const created = createRouter({ routes: [home, next], history });
    if (!created.ok) throw created.error;
    const router = created.value;
    await router.start();
    fake.click('/next');
    await vi.waitFor(() => expect(router.current?.route).toBe(next));
    expect(fake.entries.map((e) => e.url)).toEqual(['/', '/next']);
    expect(fake.log).toEqual([]);
    await router.dispose();
  });
});
