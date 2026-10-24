import {
  createDeferred,
  createMemorySink,
  createScope,
  createTelemetry,
  defineError,
  err,
  ok,
  type SpanEndRecord,
  token,
} from '@staticflux/core';
import { type FeatureId, featureRef } from '@staticflux/runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  bindCapability,
  block,
  cancel,
  createMemoryHistory,
  createRouter,
  defineDialog,
  defineRoute,
  defineStage,
  type DialogSurfacePort,
  guard,
  intentAuthorizePlugin,
  intentCapturePlugin,
  type MemoryHistory,
  modesPredicate,
  type NavigationContext,
  type NavigationResult,
  type PipelineKind,
  proceed,
  redirect,
  type RouteFeatureDriver,
  type RouterOptions,
  ROUTER_SOURCE,
  routerMetrics,
  searchParam,
  STAGES,
  type StagePlugin,
  stagePlugin,
  urlSyncFlushHook,
} from './index.js';

declare module './routes.js' {
  interface RouteRequirements {
    auth?: 'required' | 'optional';
    resource?: string;
  }
}

const Denied = defineError('SF-TEST-NAV', 'forbidden', 'denied', 'test');

const desktop = featureRef('t/desktop');
const mobile = featureRef('t/mobile');
const settingsFeature = featureRef('t/settings');

const home = defineRoute({ id: 't/home', path: '/' });
const editor = defineRoute({
  id: 't/editor',
  path: 'editor/:id',
  feature: bindCapability('t/editor', [
    { feature: desktop, modes: ['expanded'] },
    { feature: mobile, modes: ['compact'] },
  ]),
  search: { tab: searchParam.enum(['a', 'b'], { kind: 'view' }) },
});
const step = defineRoute({ id: 't/step', path: 'step/:n', parent: editor, view: true });
const settings = defineRoute({ id: 't/settings', path: 'settings', feature: bindCapability('t/settings', [{ feature: settingsFeature }], { leave: 'hide' }) });
const login = defineRoute({ id: 't/login', path: 'login' });
const secret = defineRoute({ id: 't/secret', path: 'secret', requires: { auth: 'required' } });
const shortcut = defineRoute({ id: 't/go', path: 'go', redirect: () => ({ to: settings }) });
const callback = defineRoute({ id: 't/callback', path: 'callback', transient: true });
const share = defineDialog({ id: 't/share', key: 'share', owner: editor });
const upsell = defineDialog({ id: 't/upsell', key: 'upsell' });

const ROUTES = [home, editor, step, settings, login, secret, shortcut, callback];

function fakeDriver(modes: Partial<Record<FeatureId, readonly string[]>> = {}) {
  const log: string[] = [];
  const mounted = new Set<FeatureId>();
  const driver: RouteFeatureDriver = {
    has: () => true,
    modesOf: (id) => modes[id],
    activate: async (id) => {
      log.push(`activate:${id}`);
      return ok('fresh' as const);
    },
    mount: async (id) => {
      log.push(`mount:${id}`);
      mounted.add(id);
      return ok();
    },
    release: async (id, how) => {
      log.push(`${how}:${id}`);
      mounted.delete(id);
      return ok();
    },
    isMounted: (id) => mounted.has(id),
  };
  return { driver, log, mounted };
}

function fakeSurface() {
  const log: string[] = [];
  const requests: { dismiss(): void }[] = [];
  const surface: DialogSurfacePort = {
    open: async (request) => {
      log.push(`open:${request.dialog.key}`);
      requests.push(request);
      request.scope.defer(() => log.push(`scope-disposed:${request.dialog.key}`));
      return ok({ close: (reason) => void log.push(`close:${request.dialog.key}:${reason}`) });
    },
  };
  return { surface, log, requests };
}

function recorder(log: string[], kinds: readonly PipelineKind[] = ['full', 'view', 'dialog']): StagePlugin[] {
  return STAGES.map((stage) =>
    stagePlugin({
      id: `t/rec-${stage}`,
      stage,
      pipelines: kinds,
      run: (ctx: NavigationContext) => {
        log.push(`${ctx.kind}:${stage}`);
        return proceed();
      },
    }),
  );
}

function setup(overrides: Partial<RouterOptions> & { initial?: string | string[]; traversal?: 'committed' | 'deferred' } = {}) {
  const history: MemoryHistory = (overrides.history as MemoryHistory | undefined) ??
    createMemoryHistory({ initial: overrides.initial ?? '/', ...(overrides.traversal === undefined ? {} : { traversal: overrides.traversal }) });
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  const sink = createMemorySink();
  telemetry.addSink(sink);
  const features = fakeDriver({ 't/desktop': ['expanded'], 't/mobile': ['compact'] });
  const created = createRouter({
    routes: ROUTES,
    dialogs: [share, upsell],
    features: features.driver,
    telemetry,
    ...overrides,
    history,
  });
  if (!created.ok) throw created.error;
  const router = created.value;
  return { router, history, sink, features };
}

const committed = (r: NavigationResult): boolean => r.outcome === 'committed';

describe('router: full pipeline', () => {
  it('runs all 13 stages in order, mounts the selected feature and commits (push)', async () => {
    const log: string[] = [];
    const { router, history, features } = setup({ plugins: recorder(log) });
    expect(committed(await router.start())).toBe(true);
    log.length = 0;
    const result = await router.navigate({ to: editor, params: { id: '42' } });
    expect(result.outcome).toBe('committed');
    expect(result.kind).toBe('full');
    expect(log).toEqual(STAGES.map((s) => `full:${s}`));
    expect(features.log).toEqual(['activate:t/desktop', 'mount:t/desktop']);
    expect(history.entries.map((e) => e.url)).toEqual(['/', '/editor/42']);
    expect(router.current?.route).toBe(editor);
    expect(router.current?.params).toEqual({ id: '42' });
    expect(router.mountedFeatures).toEqual(['t/desktop']);
    expect(router.status).toBe('idle');
    expect(router.pending).toBeUndefined();
  });

  it('runs serial steps in order and consecutive parallel steps concurrently', async () => {
    const log: string[] = [];
    const a = createDeferred<void>();
    const b = createDeferred<void>();
    const plugins: StagePlugin[] = [
      stagePlugin({ id: 't/s1', stage: 'load', order: 0, applies: (c) => c.to.route === login, run: () => (log.push('s1'), proceed()) }),
      stagePlugin({ id: 't/p1', stage: 'load', order: 1, concurrency: 'parallel', applies: (c) => c.to.route === login, run: async () => { log.push('p1-start'); await a.promise; log.push('p1-end'); return proceed(); } }),
      stagePlugin({ id: 't/p2', stage: 'load', order: 2, concurrency: 'parallel', applies: (c) => c.to.route === login, run: async () => { log.push('p2-start'); await b.promise; log.push('p2-end'); return proceed(); } }),
      stagePlugin({ id: 't/s2', stage: 'load', order: 3, applies: (c) => c.to.route === login, run: () => (log.push('s2'), proceed()) }),
    ];
    const { router } = setup({ plugins });
    await router.start();
    log.length = 0;
    const pending = router.navigate({ to: login });
    await vi.waitFor(() => expect(log).toEqual(['s1', 'p1-start', 'p2-start']));
    b.resolve();
    await vi.waitFor(() => expect(log).toContain('p2-end'));
    expect(log).not.toContain('s2');
    a.resolve();
    expect((await pending).outcome).toBe('committed');
    expect(log).toEqual(['s1', 'p1-start', 'p2-start', 'p2-end', 'p1-end', 's2']);
  });

  it('a non-continue in a parallel group aborts its siblings', async () => {
    let siblingSignal: AbortSignal | undefined;
    const plugins: StagePlugin[] = [
      stagePlugin({ id: 't/slow', stage: 'prefetch', concurrency: 'parallel', run: (_c, signal) => {
        siblingSignal = signal;
        return new Promise(() => undefined);
      } }),
      stagePlugin({ id: 't/deny', stage: 'prefetch', concurrency: 'parallel', run: async () => block(Denied()) }),
    ];
    const { router } = setup({ plugins });
    await router.start();
    const r = await router.navigate({ to: login });
    expect(r.outcome).toBe('blocked');
    expect(siblingSignal?.aborted).toBe(true);
  });

  it('custom stages via before:/after: run in position; unknown custom stage is a definition error', async () => {
    const log: string[] = [];
    const consent = defineStage({ id: 't/consent', position: 'after:auth-boundary' });
    const plugins = [
      ...recorder(log, ['full']),
      stagePlugin({ id: 't/consent-plugin', stage: consent, run: () => (log.push('consent'), proceed()) }),
    ];
    const { router } = setup({ plugins, stages: [consent] });
    await router.start();
    const idx = (s: string): number => log.lastIndexOf(s);
    expect(idx('consent')).toBeGreaterThan(idx('full:auth-boundary'));
    expect(idx('consent')).toBeLessThan(idx('full:post-auth'));
    const bad = createRouter({ routes: ROUTES, history: createMemoryHistory(), plugins: [plugins[plugins.length - 1] as StagePlugin] });
    expect(!bad.ok && bad.error.code).toBe('SF-NAV-013');
  });

  it('plugins honour `applies` and `pipelines`', async () => {
    const seen: string[] = [];
    const plugin = stagePlugin({
      id: 't/auth',
      stage: 'auth-boundary',
      applies: (ctx) => ctx.requires.auth === 'required',
      run: (ctx) => (seen.push(ctx.to.route.id), proceed()),
    });
    const { router } = setup({ plugins: [plugin] });
    await router.start();
    await router.navigate({ to: login });
    await router.navigate({ to: secret });
    expect(seen).toEqual(['t/secret']);
  });
});

describe('router: outcomes', () => {
  const authPlugin = (authenticated: () => boolean): StagePlugin =>
    stagePlugin({
      id: 't/auth-boundary',
      stage: 'auth-boundary',
      applies: (ctx) => ctx.requires.auth === 'required',
      run: (ctx) => (authenticated() ? proceed() : redirect({ to: login }, { state: { returnTo: ctx.intent } })),
    });

  it('redirect: login redirect keeps the intent; retry() replays it (Ember-style)', async () => {
    let authed = false;
    const { router, history } = setup({ plugins: [authPlugin(() => authed)] });
    await router.start();
    const r = await router.navigate({ to: secret });
    expect(r.outcome).toBe('committed');
    expect(r.redirects).toEqual(['/secret']);
    expect(router.current?.route).toBe(login);
    expect(history.entries.map((e) => e.url)).toEqual(['/', '/login']);
    const returnTo = (history.current.state as { user: { returnTo: { href: string; mode: 'push' } } }).user.returnTo;
    expect(returnTo).toEqual({ href: '/secret', mode: 'push', state: null });
    authed = true;
    const retried = await router.retry(returnTo);
    expect(retried.outcome).toBe('committed');
    expect(router.current?.route).toBe(secret);
  });

  it('redirect of the initial navigation replaces the entry', async () => {
    const { router, history } = setup({ initial: '/secret', plugins: [authPlugin(() => false)] });
    const r = await router.start();
    expect(r.outcome).toBe('committed');
    expect(history.entries.map((e) => e.url)).toEqual(['/login']);
  });

  it('block keeps the current location; failed carries the error', async () => {
    const plugins: StagePlugin[] = [
      stagePlugin({ id: 't/deny', stage: 'authorize', applies: (c) => c.to.route === secret, run: () => block(Denied()) }),
      stagePlugin({ id: 't/throw', stage: 'load', applies: (c) => c.to.route === settings, run: () => { throw new Error('kaput'); } }),
      stagePlugin({ id: 't/err', stage: 'load', applies: (c) => c.to.route === login, run: () => err(Denied()) }),
    ];
    const { router, history } = setup({ plugins });
    await router.start();
    const blocked = await router.navigate({ to: secret });
    expect(blocked.outcome === 'blocked' && blocked.error.code).toBe('SF-TEST-NAV');
    expect(blocked.outcome === 'blocked' && blocked.stage).toBe('authorize');
    expect(router.current?.route).toBe(home);
    expect(history.entries).toHaveLength(1);
    const thrown = await router.navigate({ to: settings });
    expect(thrown.outcome === 'failed' && thrown.error.code).toBe('SF-NAV-004');
    const failed = await router.navigate({ to: login });
    expect(failed.outcome === 'failed' && failed.error.code).toBe('SF-TEST-NAV');
    expect(router.status).toBe('idle');
  });

  it('cancel outcome drops the navigation silently', async () => {
    const { router } = setup({ plugins: [stagePlugin({ id: 't/c', stage: 'enter', run: () => cancel('nope') })] });
    await router.start();
    const r = await router.navigate({ to: login });
    expect(r.outcome === 'cancelled' && r.reason).toBe('nope');
  });

  it('redirect loops fail with SF-NAV-003', async () => {
    const plugins = [
      stagePlugin({ id: 't/a', stage: 'authorize', applies: (c) => c.to.route === login, run: () => redirect({ to: secret }) }),
      stagePlugin({ id: 't/b', stage: 'authorize', applies: (c) => c.to.route === secret, run: () => redirect({ to: login }) }),
    ];
    const { router } = setup({ plugins, maxRedirects: 3 });
    await router.start();
    const r = await router.navigate({ to: login });
    expect(r.outcome === 'failed' && r.error.code).toBe('SF-NAV-003');
    expect(router.current?.route).toBe(home);
    expect(router.status).toBe('idle');
  });

  it('transient routes: redirect-only routes never commit; transient without redirect fails closed', async () => {
    const { router, history } = setup();
    await router.start();
    const r = await router.navigate({ to: shortcut });
    expect(r.outcome === 'committed' && r.match.route).toBe(settings);
    expect(history.entries.map((e) => e.url)).toEqual(['/', '/settings']);
    const t = await router.navigate({ to: callback });
    expect(t.outcome === 'blocked' && t.error.code).toBe('SF-NAV-006');
  });

  it('a transient-stage plugin can handle a transient route', async () => {
    const plugin = stagePlugin({ id: 't/cb', stage: 'transient', applies: (c) => c.to.route.transient, run: () => redirect({ to: secret }) });
    const { router } = setup({ plugins: [plugin], initial: '/callback' });
    const r = await router.start();
    expect(r.outcome === 'committed' && r.match.route).toBe(secret);
  });

  it('not found: blocked SF-NAV-001, or the notFound route with the URL kept', async () => {
    const a = setup();
    await a.router.start();
    const r = await a.router.navigate({ href: '/nope' });
    expect(r.outcome === 'blocked' && r.error.code).toBe('SF-NAV-001');
    const notFound = defineRoute({ id: 't/404', path: '404' });
    const b = setup({ notFound });
    await b.router.start();
    const r2 = await b.router.navigate({ href: '/nope' });
    expect(r2.outcome === 'committed' && r2.match.notFound).toBe(true);
    expect(b.history.url).toBe('/nope');
  });

  it('missing params from untyped callers fail with SF-NAV-011', async () => {
    const { router } = setup();
    await router.start();
    const r = await router.navigate({ to: editor, params: {} as { id: string } });
    expect(r.outcome === 'failed' && r.error.code).toBe('SF-NAV-011');
  });

  it('same location is a skipped commit unless forced', async () => {
    const log: string[] = [];
    const { router } = setup({ plugins: recorder(log, ['full']) });
    await router.start();
    log.length = 0;
    const r = await router.navigate({ to: home });
    expect(r.outcome === 'committed' && r.skipped).toBe(true);
    expect(log).toEqual([]);
    await router.navigate({ to: home }, { force: true });
    expect(log).toHaveLength(13);
  });
});

describe('router: concurrency (R7.2, R7.3)', () => {
  it('the newest navigation cancels older ones through their signal', async () => {
    const gate = createDeferred<void>();
    let seen: AbortSignal | undefined;
    const plugin = stagePlugin({
      id: 't/slow',
      stage: 'load',
      applies: (c) => c.to.route === secret,
      run: async (_c, signal) => {
        seen = signal;
        await gate.promise;
        return proceed();
      },
    });
    const { router, history } = setup({ plugins: [plugin] });
    await router.start();
    const first = router.navigate({ to: secret });
    await vi.waitFor(() => expect(seen).toBeDefined());
    const second = await router.navigate({ to: login });
    const firstResult = await first;
    expect(firstResult.outcome === 'cancelled' && firstResult.reason).toBe('superseded');
    expect(seen?.aborted).toBe(true);
    expect(second.outcome).toBe('committed');
    expect(router.current?.route).toBe(login);
    expect(history.entries.map((e) => e.url)).toEqual(['/', '/login']);
  });

  it('an uninterruptible exit guard (save) defers cancellation; the newer navigation waits for it', async () => {
    const save = createDeferred<void>();
    const log: string[] = [];
    let saveSignal: AbortSignal | undefined;
    let saves = 0;
    const saving = defineRoute({
      id: 't/doc',
      path: 'doc',
      guards: {
        exit: [
          guard(
            async (_c, signal) => {
              saves += 1;
              saveSignal = signal;
              log.push('save-start');
              if (saves === 1) await save.promise;
              log.push('save-end');
              return proceed();
            },
            { uninterruptible: true, name: 'flush-save' },
          ),
        ],
      },
    });
    const plugins = [stagePlugin({ id: 't/avail', stage: 'availability', run: (c) => (log.push(`availability:${c.to.route.id}`), proceed()) })];
    const { router } = setup({ routes: [...ROUTES, saving], plugins, initial: '/doc' });
    await router.start();
    log.length = 0;
    const toLogin = router.navigate({ to: login });
    await vi.waitFor(() => expect(log).toEqual(['save-start']));
    const toSettings = router.navigate({ to: settings });
    await Promise.resolve();
    expect(log).toEqual(['save-start']); // newer navigation has not started its stages
    save.resolve();
    const [a, b] = await Promise.all([toLogin, toSettings]);
    expect(saveSignal?.aborted).toBe(false);
    expect(a.outcome === 'cancelled' && a.reason).toBe('superseded');
    expect(b.outcome).toBe('committed');
    expect(router.current?.route).toBe(settings);
    // the exit guard ran again for the newer navigation (still leaving /doc)
    expect(log).toEqual(['save-start', 'save-end', 'save-start', 'save-end', 'availability:t/settings']);
  });

  it('render/commit are the commit point: a navigation that reached them completes', async () => {
    const render = createDeferred<void>();
    const plugin = stagePlugin({
      id: 't/render',
      stage: 'render',
      applies: (c) => c.to.route === secret,
      run: async () => {
        await render.promise;
        return proceed();
      },
    });
    const { router } = setup({ plugins: [plugin] });
    await router.start();
    const first = router.navigate({ to: secret });
    await vi.waitFor(() => expect(router.stage).toBe('render'));
    const second = router.navigate({ to: login });
    render.resolve();
    expect((await first).outcome).toBe('committed');
    expect((await second).outcome).toBe('committed');
    expect(router.current?.route).toBe(login);
  });

  it('a caller signal cancels its navigation', async () => {
    const plugin = stagePlugin({ id: 't/hang', stage: 'load', run: () => new Promise(() => undefined) });
    const { router } = setup({ plugins: [plugin], initial: '/' });
    const controller = new AbortController();
    const pending = router.navigate({ to: login }, { signal: controller.signal });
    controller.abort();
    const r = await pending;
    expect(r.outcome === 'cancelled' && r.reason).toBe('aborted');
  });
});

describe('router: nested routes & per-segment guards (R7.5)', () => {
  it('runs guards of entering segments outer→inner and exit guards of leaving segments inner→outer', async () => {
    const log: string[] = [];
    const g = (name: string) => guard(() => (log.push(name), proceed()), { name });
    const area = defineRoute({ id: 'n/area', path: 'area', abstract: true, guards: { authorize: [g('area:authorize')], exit: [g('area:exit')] } });
    const item = defineRoute({ id: 'n/item', path: 'item/:id', parent: area, guards: { authorize: [g('item:authorize')], exit: [g('item:exit')] } });
    const sub = defineRoute({ id: 'n/sub', path: 'sub', parent: item, guards: { authorize: [g('sub:authorize')], exit: [g('sub:exit')] }, loaders: [() => (log.push('sub:loader'), proceed())] });
    const { router } = setup({ routes: [home, area, item, sub], dialogs: [] });
    await router.start();
    await router.navigate({ to: sub, params: { id: '1' } });
    expect(log).toEqual(['area:authorize', 'item:authorize', 'sub:authorize', 'sub:loader']);
    log.length = 0;
    await router.navigate({ to: item, params: { id: '2' } });
    expect(log).toEqual(['sub:exit', 'item:exit', 'item:authorize']);
    log.length = 0;
    await router.navigate({ to: home });
    expect(log).toEqual(['item:exit', 'area:exit']);
  });

  it('segment scopes are disposed when the segment is left (R7.21)', async () => {
    const { router } = setup();
    await router.start();
    await router.navigate({ to: editor, params: { id: '1' } });
    const scope = router.scopeOf(editor);
    expect(scope?.disposed).toBe(false);
    await router.navigate({ to: step, params: { id: '1', n: '2' } });
    expect(router.scopeOf(editor)).toBe(scope);
    await router.navigate({ to: home });
    expect(scope?.disposed).toBe(true);
    expect(router.scopeOf(editor)).toBeUndefined();
  });
});

describe('router: view-state light pipeline (R7.7)', () => {
  it('view search params and view sub-routes run exit → enter → commit without reactivation', async () => {
    const log: string[] = [];
    const stepWithGuards = defineRoute({
      id: 'v/step',
      path: 'wizard/:n',
      parent: editor,
      view: true,
      guards: { exit: [() => (log.push('step:exit'), proceed())], enter: [() => (log.push('step:enter'), proceed())] },
    });
    const { router, features, sink, history } = setup({ routes: [...ROUTES, stepWithGuards], plugins: recorder(log) });
    await router.start();
    await router.navigate({ to: editor, params: { id: '1' } });
    log.length = 0;
    features.log.length = 0;
    const tab = await router.navigate({ to: editor, params: { id: '1' }, search: { tab: 'b' } });
    expect(tab.kind).toBe('view');
    expect(log).toEqual(['view:exit', 'view:enter', 'view:commit']);
    expect(router.current?.search).toEqual({ tab: 'b' });
    log.length = 0;
    await router.navigate({ to: stepWithGuards, params: { id: '1', n: '1' } });
    await router.navigate({ to: stepWithGuards, params: { id: '1', n: '2' } });
    expect(log).toEqual(['view:exit', 'view:enter', 'step:enter', 'view:commit', 'view:exit', 'step:exit', 'view:enter', 'step:enter', 'view:commit']);
    expect(features.log).toEqual([]);
    expect(router.mountedFeatures).toEqual(['t/desktop']);
    expect(history.entries).toHaveLength(5);
    const spans = sink.records.filter((r): r is SpanEndRecord => r.type === 'span' && r.name === 'nav.view');
    expect(spans).toHaveLength(3);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === routerMetrics.viewTransition.id)).toBe(true);
  });
});

describe('router: availability & feature binding (R18.5, R18.6)', () => {
  it('selects the per-mode variant from the injected profile and swaps on refresh()', async () => {
    let modes: string[] = ['expanded'];
    const { router, features } = setup({ profile: modesPredicate(() => modes) });
    await router.start();
    await router.navigate({ to: editor, params: { id: '1' } });
    expect(router.mountedFeatures).toEqual(['t/desktop']);
    modes = ['compact'];
    features.log.length = 0;
    const r = await router.refresh();
    expect(r.outcome).toBe('committed');
    expect(features.log).toEqual(['activate:t/mobile', 'mount:t/mobile', 'unmount:t/desktop']);
    expect(router.mountedFeatures).toEqual(['t/mobile']);
  });

  it('blocks with SF-NAV-005 when no candidate serves the profile', async () => {
    const { router } = setup({ profile: modesPredicate(() => ['tv']) });
    await router.start();
    const r = await router.navigate({ to: editor, params: { id: '1' } });
    expect(r.outcome === 'blocked' && r.error.code).toBe('SF-NAV-005');
    expect(r.outcome === 'blocked' && r.stage).toBe('availability');
  });

  it('feature code loads only after authorize (R7.8); leaving releases per selector (hide)', async () => {
    const order: string[] = [];
    const { router, features } = setup({
      plugins: [stagePlugin({ id: 't/authz', stage: 'authorize', run: () => (order.push('authorize'), proceed()) })],
    });
    const original = features.driver.activate;
    features.driver.activate = async (id, s) => {
      order.push(`activate:${id}`);
      return original(id, s);
    };
    await router.start();
    order.length = 0;
    await router.navigate({ to: settings });
    expect(order).toEqual(['authorize', 'activate:t/settings']);
    features.log.length = 0;
    await router.navigate({ to: home });
    expect(features.log).toEqual(['hide:t/settings']);
    expect(router.mountedFeatures).toEqual([]);
  });

  it('a failed activation fails the navigation with SF-NAV-010', async () => {
    const { router, features } = setup();
    features.driver.activate = async () => err(Denied());
    await router.start();
    const r = await router.navigate({ to: settings });
    expect(r.outcome === 'failed' && r.error.code).toBe('SF-NAV-010');
    expect(r.outcome === 'failed' && r.stage).toBe('load');
  });
});

describe('router: routable dialogs (R7.16–R7.20)', () => {
  it('opens via the light dialog pipeline and dismisses with history back when opened in-app', async () => {
    const log: string[] = [];
    const s = fakeSurface();
    const { router, history, features } = setup({ dialogSurface: s.surface, plugins: recorder(log) });
    await router.start();
    await router.navigate({ to: editor, params: { id: '1' } });
    log.length = 0;
    features.log.length = 0;
    const opened = await router.openDialogRoute(share);
    expect(opened.kind).toBe('dialog');
    expect(log).toEqual(['dialog:exit', 'dialog:availability', 'dialog:authorize', 'dialog:load', 'dialog:enter', 'dialog:commit']);
    expect(s.log).toEqual(['open:share']);
    expect(history.url).toBe('/editor/1/d/share');
    expect(router.openDialog).toBe(share);
    expect(features.log).toEqual([]);
    const dismissed = await router.dismissDialog();
    expect(dismissed.outcome).toBe('committed');
    expect(history.url).toBe('/editor/1');
    expect(history.entries).toHaveLength(3); // went back, forward entry kept
    expect(history.index).toBe(1);
    expect(s.log).toEqual(['open:share', 'close:share:navigation', 'scope-disposed:share']);
    expect(router.openDialog).toBeUndefined();
  });

  it('deep-linked dialog dismiss replaces to the parent location', async () => {
    const s = fakeSurface();
    const { router, history } = setup({ dialogSurface: s.surface, initial: '/editor/1/d/share' });
    const r = await router.start();
    expect(r.outcome).toBe('committed');
    expect(s.log).toEqual(['open:share']);
    await router.dismissDialog();
    expect(history.entries.map((e) => e.url)).toEqual(['/editor/1']);
    expect(s.log).toContain('close:share:navigation');
  });

  it('the surface dismiss callback dismisses through the router', async () => {
    const s = fakeSurface();
    const { router, history } = setup({ dialogSurface: s.surface, initial: '/editor/1' });
    await router.start();
    await router.openDialogRoute(upsell);
    s.requests[0]?.dismiss();
    await vi.waitFor(() => expect(history.url).toBe('/editor/1'));
  });

  it('switching dialogs replaces (one routable dialog max) and leaving the feature closes it', async () => {
    const s = fakeSurface();
    const { router, history } = setup({ dialogSurface: s.surface, initial: '/editor/1' });
    await router.start();
    await router.openDialogRoute(share);
    await router.openDialogRoute(upsell);
    expect(history.entries.map((e) => e.url)).toEqual(['/editor/1', '/editor/1/d/upsell']);
    expect(s.log).toEqual(['open:share', 'close:share:replaced', 'scope-disposed:share', 'open:upsell']);
    await router.navigate({ to: settings });
    expect(s.log.slice(-2)).toEqual(['close:upsell:navigation', 'scope-disposed:upsell']);
    expect(router.openDialog).toBeUndefined();
  });

  it('dialog exit guards (unsaved state) block the dismiss; dialog authorize guards block the open', async () => {
    const s = fakeSurface();
    let dirty = true;
    const form = defineDialog({ id: 't/form', key: 'form', guards: { authorize: [() => proceed()] } });
    const denied = defineDialog({ id: 't/denied', key: 'denied', guards: { authorize: [() => block(Denied())] } });
    const { router, history } = setup({ dialogSurface: s.surface, dialogs: [form, denied], initial: '/editor/1' });
    await router.start();
    const opened = await router.openDialogRoute(form);
    expect(opened.outcome).toBe('committed');
    const scope = router.dialogScope;
    router.guardExit(form, () => (dirty ? block(Denied()) : proceed()), scope);
    const blocked = await router.dismissDialog();
    expect(blocked.outcome).toBe('blocked');
    expect(history.url).toBe('/editor/1/d/form'); // reverted after the committed back traversal
    expect(router.openDialog).toBe(form);
    dirty = false;
    expect((await router.dismissDialog()).outcome).toBe('committed');
    expect(history.url).toBe('/editor/1');
    const d = await router.openDialogRoute(denied);
    expect(d.outcome === 'blocked' && d.stage).toBe('authorize');
    expect(s.log.filter((l) => l.startsWith('open:'))).toEqual(['open:form']);
  });

  it('fails with SF-NAV-009 without a dialog surface, SF-NAV-008 outside the owner', async () => {
    const { router } = setup({ initial: '/editor/1' });
    await router.start();
    const r = await router.openDialogRoute(share);
    expect(r.outcome === 'failed' && r.error.code).toBe('SF-NAV-009');
    await router.navigate({ to: home });
    const outside = await router.openDialogRoute(share);
    expect(outside.outcome === 'failed' && outside.error.code).toBe('SF-NAV-008');
  });
});

describe('router: history replay (R7.4)', () => {
  it('back/forward run the pipeline; a blocked back traversal is reverted (popstate semantics)', async () => {
    let allowLeave = false;
    const guarded = defineRoute({ id: 't/guarded', path: 'guarded', guards: { exit: [() => (allowLeave ? proceed() : block(Denied()))] } });
    const log: string[] = [];
    const { router, history } = setup({ routes: [...ROUTES, guarded], plugins: recorder(log, ['full']) });
    await router.start();
    await router.navigate({ to: login });
    await router.navigate({ to: guarded });
    log.length = 0;
    const back = await router.back();
    expect(back.outcome).toBe('blocked');
    expect(log).toEqual(['full:resolve', 'full:exit']);
    expect(history.index).toBe(2);
    expect(history.url).toBe('/guarded');
    expect(router.current?.route).toBe(guarded);
    allowLeave = true;
    const back2 = await router.back();
    expect(back2.outcome).toBe('committed');
    expect(router.current?.route).toBe(login);
    expect(history.index).toBe(1);
    const fwd = await router.forward();
    expect(fwd.outcome).toBe('committed');
    expect(router.current?.route).toBe(guarded);
    expect(history.entries.map((e) => e.url)).toEqual(['/', '/login', '/guarded']);
    expect((await router.go(5)).outcome).toBe('committed'); // out of range: nothing to do
  });

  it('deferred traversals (Navigation API style) commit only after the pipeline passes', async () => {
    let allow = false;
    const guarded = defineRoute({ id: 't/guarded', path: 'guarded', guards: { exit: [() => (allow ? proceed() : block(Denied()))] } });
    const { router, history } = setup({ routes: [...ROUTES, guarded], traversal: 'deferred' });
    await router.start();
    await router.navigate({ to: guarded });
    const changes: string[] = [];
    history.subscribe((c) => changes.push(`${c.cause}:${c.source}:${c.url}`));
    expect((await router.back()).outcome).toBe('blocked');
    expect(history.index).toBe(1);
    expect(changes).toEqual([]);
    allow = true;
    expect((await router.back()).outcome).toBe('committed');
    expect(history.index).toBe(0);
    expect(changes).toEqual(['pop:router:/']);
  });

  it('a superseded traversal is not reverted; the newest navigation aligns history first', async () => {
    let hold: Promise<void> | undefined;
    const plugin = stagePlugin({ id: 't/hold', stage: 'load', applies: (c) => c.to.route === home, run: async () => (await hold, proceed()) });
    const { router, history } = setup({ plugins: [plugin], initial: '/' });
    await router.start();
    await router.navigate({ to: login });
    const release = createDeferred<void>();
    hold = release.promise;
    const back = router.back(); // URL already at '/', pipeline pending in load
    expect(history.index).toBe(0);
    const push = router.navigate({ to: settings });
    const backResult = await back;
    expect(backResult.outcome === 'cancelled' && backResult.reason).toBe('superseded');
    expect((await push).outcome).toBe('committed');
    expect(history.entries.map((e) => e.url)).toEqual(['/', '/login', '/settings']);
    expect(history.index).toBe(2);
    release.resolve();
  });

  it('host-initiated navigations (embedded memory history) run the pipeline', async () => {
    const { router, history } = setup();
    await router.start();
    const results: NavigationResult[] = [];
    router.onNavigation((r) => results.push(r));
    history.navigateExternal('/settings');
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(router.current?.route).toBe(settings);
    expect(history.entries.map((e) => e.url)).toEqual(['/', '/settings']);
  });
});

describe('router: urlstate integration', () => {
  it('adopts view-only writes from other sources without a pipeline; path writes run it (revert on block)', async () => {
    const log: string[] = [];
    const deny = stagePlugin({ id: 't/deny', stage: 'authorize', applies: (c) => c.to.route === secret, run: () => block(Denied()) });
    const { router, history } = setup({ plugins: [...recorder(log), deny], initial: '/editor/1' });
    await router.start();
    log.length = 0;
    history.replace('/editor/1?tab=b', { source: 'urlstate' });
    expect(log).toEqual([]);
    expect(router.current?.search).toEqual({ tab: 'b' });
    history.push('/secret', { source: 'third-party' });
    await vi.waitFor(() => expect(router.status).toBe('idle'));
    await vi.waitFor(() => expect(history.url).toBe('/editor/1?tab=b'));
    expect(router.current?.route).toBe(editor);
    history.push('/settings', { source: 'third-party' });
    await vi.waitFor(() => expect(router.current?.route).toBe(settings));
    expect(history.url).toBe('/settings');
  });

  it('router writes carry source "router"', async () => {
    const { router, history } = setup();
    const changes: string[] = [];
    history.subscribe((c) => changes.push(`${c.cause}:${c.source}`));
    await router.start();
    await router.navigate({ to: login });
    expect(changes).toEqual(['replace:router', 'push:router']);
    expect(ROUTER_SOURCE).toBe('router');
  });

  it('wires intent capture (resolve), intent authorize (after authorize) and url-sync flush (before navigation)', async () => {
    const order: string[] = [];
    const intents = { capture: vi.fn((url?: string) => order.push(`capture:${url}`)), authorize: vi.fn(() => void order.push('authorize-intents')) };
    const sync = { flush: vi.fn(() => void order.push('flush')) };
    const authz = stagePlugin({ id: 't/authz', stage: 'authorize', run: () => (order.push('authorize'), proceed()) });
    const { router } = setup({ plugins: [intentCapturePlugin(intents), authz, intentAuthorizePlugin(intents)], hooks: [urlSyncFlushHook(sync)] });
    await router.start();
    expect(order).toEqual(['flush', 'capture:/', 'authorize', 'authorize-intents']);
  });
});

describe('router: gates, guards, telemetry, lifecycle', () => {
  it('the run gate (I-1) can block navigations', async () => {
    const { router } = setup({ runGate: async () => err(Denied()) });
    const r = await router.start();
    expect(r.outcome === 'blocked' && r.error.code).toBe('SF-TEST-NAV');
  });

  it('dynamic exit guards: per route, global (full only), removed with their scope', async () => {
    const { router } = setup();
    await router.start();
    await router.navigate({ to: editor, params: { id: '1' } });
    const scope = createScope('feature-ui');
    router.guardExit(editor, () => block(Denied()), scope);
    expect((await router.navigate({ to: editor, params: { id: '1' }, search: { tab: 'a' } })).outcome).toBe('committed'); // view: not leaving
    expect((await router.navigate({ to: home })).outcome).toBe('blocked');
    await scope.dispose();
    expect((await router.navigate({ to: home })).outcome).toBe('committed');
    const remove = router.guardExit(undefined, () => block(Denied()));
    expect((await router.navigate({ to: login })).outcome).toBe('blocked');
    remove();
    expect((await router.navigate({ to: login })).outcome).toBe('committed');
  });

  it('emits nav.pipeline with one nav.stage child per stage, journey marks and machine transitions', async () => {
    const { router, sink } = setup();
    await router.start();
    sink.clear();
    await router.navigate({ to: settings });
    const spans = sink.records.filter((r): r is SpanEndRecord => r.type === 'span');
    const pipeline = spans.find((s) => s.name === 'nav.pipeline');
    expect(pipeline?.subsystem).toBe('router/navigation');
    expect(pipeline?.attrs.start).toBe('soft');
    expect(pipeline?.attrs['activation.t/settings']).toBe('fresh');
    const stages = spans.filter((s) => s.name === 'nav.stage');
    expect(stages.map((s) => s.attrs.stage)).toEqual([...STAGES]);
    expect(stages.every((s) => s.subsystem === 'router/pipeline' && s.parentSpanId === pipeline?.context.spanId)).toBe(true);
    const metrics = sink.records.filter((r) => r.type === 'metric').map((r) => (r.type === 'metric' ? r.metric : ''));
    expect(metrics).toContain(routerMetrics.navStart.id);
    expect(metrics).toContain(routerMetrics.navCommit.id);
    const events = sink.records.filter((r) => r.type === 'event').map((r) => (r.type === 'event' ? r.name : ''));
    expect(events).toEqual(expect.arrayContaining(['lifecycle.router/navigation.idle→running', 'lifecycle.router/navigation.running→committed', 'lifecycle.router/navigation.committed→idle']));
  });

  it('typed context slots are shared between steps', async () => {
    const Decision = token('t/decision').type<{ allow: boolean }>();
    let read: { allow: boolean } | undefined;
    const plugins = [
      stagePlugin({ id: 't/w', stage: 'authorize', run: (c) => (c.set(Decision, { allow: true }), proceed()) }),
      stagePlugin({ id: 't/r', stage: 'load', run: (c) => ((read = c.get(Decision)), proceed()) }),
    ];
    const { router } = setup({ plugins });
    await router.start();
    expect(read).toEqual({ allow: true });
  });

  it('dispose: later navigations fail with SF-NAV-012; open dialogs close', async () => {
    const s = fakeSurface();
    const { router } = setup({ dialogSurface: s.surface, initial: '/editor/1/d/share' });
    await router.start();
    await router.dispose();
    expect(s.log).toContain('close:share:disposed');
    const r = await router.navigate({ to: home });
    expect(r.outcome === 'failed' && r.error.code).toBe('SF-NAV-012');
  });

  it('start() twice is a no-op', async () => {
    const { router } = setup();
    await router.start();
    const again = await router.start();
    expect(again.outcome === 'committed' && again.skipped).toBe(true);
  });
});
