import { createInjector, createMemorySink, createTelemetry, ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import { defineIntent, defineUrlBinding } from './binding.js';
import { codec } from './codec.js';
import { createDialogUrl, formatDialogPath, parseDialogPath } from './dialog.js';
import { createBrowserHistory, createMemoryHistory, createNavigationHistory, detectHistory, type HistoryChange } from './history.js';
import { createMarketingCapture, extractMarketingParams } from './marketing.js';
import { createManualScheduler, createRafScheduler } from './scheduler.js';
import {
  browserHistoryUnit,
  DialogUrlToken,
  dialogUrlUnit,
  FrameSchedulerToken,
  HistoryPortToken,
  intentHoldUnit,
  IntentServiceToken,
  intentServiceUnit,
  intentUnit,
  MarketingCaptureToken,
  marketingCaptureUnit,
  memoryHistoryUnit,
  rafSchedulerUnit,
  urlDeclarationRegistryUnit,
  urlDeclarationUnit,
  UrlSyncToken,
  urlSyncUnit,
} from './units.js';
import { formatUrl, parseUrl, withParam } from './url.js';

describe('url helpers', () => {
  it('parses and formats preserving order, bare keys and hash', () => {
    const parts = parseUrl('/a/b?x=1&flag&y=a+b#h');
    expect(parts).toEqual({ pathname: '/a/b', params: [['x', '1'], ['flag', ''], ['y', 'a b']], hash: '#h' });
    expect(formatUrl(parts)).toBe('/a/b?x=1&flag&y=a+b#h');
    expect(formatUrl(withParam(parts, 'x', '2'))).toBe('/a/b?x=2&flag&y=a+b#h');
    expect(formatUrl(withParam(parseUrl('/?a=1&a=2&b=3'), 'a', '9'))).toBe('/?a=9&b=3');
  });
});

describe('history ports', () => {
  it('memory history: push/replace/back/forward/go and subscribers', () => {
    const h = createMemoryHistory('/a');
    const changes: HistoryChange[] = [];
    const off = h.subscribe((c) => changes.push(c));
    expect(h.canGoBack).toBe(false);
    h.push('/b', { source: 'router' });
    h.push('/c');
    h.back();
    h.replace('/b2');
    h.forward();
    h.go(-5);
    h.go(0);
    expect(h.url).toBe('/a');
    expect(changes.map((c) => `${c.cause}:${c.url}:${c.source}`)).toEqual([
      'push:/b:router',
      'push:/c:external',
      'pop:/b:external',
      'replace:/b2:external',
      'pop:/c:external',
      'pop:/a:external',
    ]);
    h.push('/z');
    expect(h.entries).toEqual(['/a', '/z']); // forward entries truncated
    off();
    h.dispose();
  });

  it('History API: writes through pushState, observes popstate, tracks in-app depth', async () => {
    window.history.replaceState(null, '', '/start');
    const h = createBrowserHistory(window);
    const changes: HistoryChange[] = [];
    h.subscribe((c) => changes.push(c));
    expect(h.kind).toBe('history');
    h.push('/next?x=1', { source: 'urlstate' });
    expect(window.location.pathname).toBe('/next');
    expect(h.url).toBe('/next?x=1');
    expect(h.canGoBack).toBe(true);
    h.replace('/next?x=2');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(h.canGoBack).toBe(false);
    expect(changes.map((c) => c.cause)).toEqual(['push', 'replace', 'pop']);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    h.back();
    expect(back).toHaveBeenCalled();
    back.mockRestore();
    h.dispose();
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(changes).toHaveLength(3);
  });

  it('Navigation API: reports traversals and third-party writes, not its own writes twice', () => {
    window.history.replaceState(null, '', '/nav');
    const target = new EventTarget();
    const navigation = Object.assign(target, { canGoBack: true });
    const h = createNavigationHistory({ location: window.location, history: window.history, navigation, addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window) });
    const changes: HistoryChange[] = [];
    h.subscribe((c) => changes.push(c));
    const fire = (navigationType: string): void => {
      target.dispatchEvent(Object.assign(new Event('currententrychange'), { navigationType }));
    };
    h.push('/nav/a', { source: 'urlstate' });
    fire('push'); // async echo of our own write: same URL → ignored
    window.history.pushState(null, '', '/nav/third-party');
    fire('push');
    fire('traverse');
    window.history.replaceState(null, '', '/nav/r');
    fire('replace');
    expect(changes.map((c) => `${c.cause}:${c.url}:${c.source}`)).toEqual([
      'push:/nav/a:urlstate',
      'push:/nav/third-party:external',
      'pop:/nav/third-party:external',
      'replace:/nav/r:external',
    ]);
    expect(h.kind).toBe('navigation');
    expect(h.canGoBack).toBe(true);
    h.replace('/nav/z');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    h.back();
    expect(back).toHaveBeenCalled();
    back.mockRestore();
    h.dispose();
    fire('traverse');
    expect(changes).toHaveLength(5);
  });

  it('detects the best implementation', () => {
    expect(detectHistory({} as typeof globalThis).kind).toBe('memory');
    expect(detectHistory().kind).toBe('navigation' in window ? 'navigation' : 'history');
    const fakeNav = { addEventListener: () => undefined, removeEventListener: () => undefined };
    const win = { location: window.location, history: window.history, navigation: fakeNav, addEventListener: () => undefined, removeEventListener: () => undefined };
    expect(detectHistory({ window: win } as unknown as typeof globalThis).kind).toBe('navigation');
    const noNav = { ...win, navigation: undefined };
    expect(detectHistory({ window: noNav } as unknown as typeof globalThis).kind).toBe('history');
  });
});

describe('frame schedulers', () => {
  it('manual scheduler queues, flushes and cancels', () => {
    const s = createManualScheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.request(a);
    const cancel = s.request(b);
    cancel();
    expect(s.pending).toBe(1);
    s.flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('raf scheduler uses requestAnimationFrame or falls back to a timeout', async () => {
    vi.useFakeTimers();
    try {
      const fallback = createRafScheduler({} as typeof globalThis);
      const cb = vi.fn();
      fallback.request(cb);
      const cancelled = vi.fn();
      fallback.request(cancelled)();
      vi.advanceTimersByTime(16);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cancelled).not.toHaveBeenCalled();
      const raf = vi.fn((fn: FrameRequestCallback) => {
        fn(0);
        return 1;
      });
      const caf = vi.fn();
      const withRaf = createRafScheduler({ requestAnimationFrame: raf, cancelAnimationFrame: caf } as unknown as typeof globalThis);
      const cb2 = vi.fn();
      withRaf.request(cb2)();
      expect(cb2).toHaveBeenCalled();
      expect(caf).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('marketing params', () => {
  it('extracts and strips', () => {
    expect(extractMarketingParams('/landing?utm_source=news&x=1&utm_campaign=fall&gclid=abc#top')).toEqual({
      params: { utm_source: 'news', utm_campaign: 'fall', gclid: 'abc' },
      url: '/landing?x=1#top',
    });
    expect(extractMarketingParams('/plain?x=1')).toEqual({ params: {}, url: '/plain?x=1' });
    expect(extractMarketingParams('/?ref=a', ['ref']).params).toEqual({ ref: 'a' });
  });

  it('captures once into telemetry and strips via replace', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const history = createMemoryHistory('/?utm_source=news&tab=comments');
    const capture = createMarketingCapture({ history, telemetry });
    expect(capture.capture()).toEqual({ utm_source: 'news' });
    expect(history.url).toBe('/?tab=comments');
    expect(history.entries).toHaveLength(1);
    expect(capture.captured).toEqual({ utm_source: 'news' });
    history.push('/?utm_source=again');
    expect(capture.capture()).toBeUndefined(); // once per page
    expect(history.url).toBe('/');
    expect(capture.capture()).toBeUndefined();
    expect(sink.records.filter((r) => r.type === 'event' && r.name === 'urlstate.marketing')).toHaveLength(1);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'urlstate/marketing-captured')).toBe(true);
    const keep = createMarketingCapture({ history: createMemoryHistory('/?utm_medium=x'), strip: false });
    expect(keep.capture()).toEqual({ utm_medium: 'x' });
  });
});

describe('dialog paths', () => {
  it('parses app- and feature-level dialogs', () => {
    expect(parseDialogPath('/studio/doc/42/d/share')).toEqual(ok({ basePath: '/studio/doc/42', dialog: 'share', level: 'feature' }));
    expect(parseDialogPath('/d/upgrade')).toEqual(ok({ basePath: '/', dialog: 'upgrade', level: 'app' }));
    expect(parseDialogPath('/studio/doc/42')).toEqual(ok({ basePath: '/studio/doc/42', dialog: undefined, level: undefined }));
    expect(parseDialogPath('')).toEqual(ok({ basePath: '/', dialog: undefined, level: undefined }));
    for (const bad of ['/d/share/d/upgrade', '/studio/d', '/studio/d/share/extra', '/d/Bad_Key']) {
      const r = parseDialogPath(bad);
      expect(!r.ok && r.error.code, bad).toBe('SF-URL-004');
    }
  });

  it('formats dialog paths, one routable dialog max', () => {
    expect(formatDialogPath('/studio/doc/42', 'share')).toEqual(ok('/studio/doc/42/d/share'));
    expect(formatDialogPath('/', 'upgrade')).toEqual(ok('/d/upgrade'));
    expect(formatDialogPath('/studio/', 'share')).toEqual(ok('/studio/d/share'));
    expect(formatDialogPath('/x/d/share', 'upgrade').ok).toBe(false);
    expect(formatDialogPath('/x', 'Bad Key' as 'share').ok).toBe(false);
  });

  it('dismiss = back when opened in-app, replace to parent when deep-linked (R7.18)', () => {
    const history = createMemoryHistory('/studio/doc/42?tab=comments');
    const dialogs = createDialogUrl({ history });
    expect(dialogs.current).toBeUndefined();
    expect(dialogs.dismiss()).toEqual(ok()); // nothing open
    dialogs.open('share');
    expect(history.url).toBe('/studio/doc/42/d/share?tab=comments');
    expect(dialogs.current).toBe('share');
    expect(dialogs.open('share')).toEqual(ok()); // already open: no new entry
    dialogs.open('upgrade'); // switching replaces (one routable dialog)
    expect(history.entries).toEqual(['/studio/doc/42?tab=comments', '/studio/doc/42/d/upgrade?tab=comments']);
    dialogs.dismiss();
    expect(history.url).toBe('/studio/doc/42?tab=comments');
    expect(history.index).toBe(0);

    const deep = createMemoryHistory('/studio/doc/42/d/share');
    const deepDialogs = createDialogUrl({ history: deep });
    deepDialogs.open('upgrade'); // replace; still a deep link
    deepDialogs.dismiss();
    expect(deep.entries).toEqual(['/studio/doc/42']);

    const app = createMemoryHistory('/studio');
    const appDialogs = createDialogUrl({ history: app });
    appDialogs.open('upgrade', { level: 'app' });
    expect(app.url).toBe('/d/upgrade');
    const broken = createDialogUrl({ history: createMemoryHistory('/d/a/d/b') });
    expect(broken.open('share').ok).toBe(false);
    expect(broken.dismiss().ok).toBe(false);
    expect(broken.current).toBeUndefined();
    expect(appDialogs.open('Bad Key' as 'share').ok).toBe(false);
  });
});

describe('urlstate DI units', () => {
  const Tab = defineUrlBinding({ key: 'tab', kind: 'view', codec: codec.enum(['comments', 'history']), owner: 'studio/doc-store' });
  const Chat = defineIntent({ id: 'agent-chat/prompt', owner: 'agent-chat', params: { panel: codec.enum(['chat']) } });
  const schedulerUnit = { ...rafSchedulerUnit, create: () => createManualScheduler() };

  it('wires history, scheduler, registry, sync, intents, marketing and dialogs', async () => {
    const injector = createInjector({
      units: [
        memoryHistoryUnit('/studio?panel=chat&utm_source=x&tab=history'),
        schedulerUnit,
        urlDeclarationUnit(Tab),
        intentUnit(Chat),
        intentHoldUnit({ hold: async () => ok(), release: async () => ok(undefined) }),
        urlDeclarationRegistryUnit,
        urlSyncUnit,
        intentServiceUnit,
        marketingCaptureUnit,
        dialogUrlUnit,
      ],
    });
    const marketing = await injector.get(MarketingCaptureToken);
    expect(marketing.ok && marketing.value.captured).toEqual({ utm_source: 'x' });
    const history = await injector.get(HistoryPortToken);
    expect(history.ok && history.value.url).toBe('/studio?panel=chat&tab=history');
    const intents = await injector.get(IntentServiceToken);
    expect(intents.ok && intents.value.capture()).toHaveLength(1);
    expect(intents.ok && (await intents.value.persist())).toEqual(ok(1));
    const sync = await injector.get(UrlSyncToken);
    expect(sync.ok).toBe(true);
    const dialogs = await injector.get(DialogUrlToken);
    expect(dialogs.ok && dialogs.value.current).toBeUndefined();
    expect((await injector.get(FrameSchedulerToken)).ok).toBe(true);
    await injector.dispose();
  });

  it('fails the registry unit on key collisions (SF-URL-002)', async () => {
    const Clash = defineIntent({ id: 'studio/tab', owner: 'studio', params: { tab: codec.enum(['comments']) } });
    const injector = createInjector({ units: [urlDeclarationUnit(Tab), urlDeclarationUnit(Clash), urlDeclarationRegistryUnit, memoryHistoryUnit(), schedulerUnit, urlSyncUnit] });
    const r = await injector.get(UrlSyncToken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error.toJSON()) + String((r.error.cause as { cause?: { code?: string } } | undefined)?.cause?.code ?? '')).toMatch(/SF-DI-003|SF-URL-002/);
  });

  it('browser history and raf scheduler units resolve', async () => {
    const injector = createInjector({ units: [browserHistoryUnit, rafSchedulerUnit] });
    expect((await injector.get(HistoryPortToken)).ok).toBe(true);
    expect((await injector.get(FrameSchedulerToken)).ok).toBe(true);
    await injector.dispose();
  });

  it('intent service works without a hold port', async () => {
    const injector = createInjector({ units: [memoryHistoryUnit('/?panel=chat'), intentUnit(Chat), intentServiceUnit] });
    const r = await injector.get(IntentServiceToken);
    expect(r.ok && (await r.value.persist())).toEqual(ok(0));
  });
});
