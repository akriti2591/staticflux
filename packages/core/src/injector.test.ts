import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { analyzeGraph } from './graph.js';
import {
  bind,
  composeUnits,
  contribution,
  createDeferred,
  createInjector,
  createMemorySink,
  createTelemetry,
  err,
  formatTraceparent,
  metric,
  ok,
  parseTraceparent,
  token,
  unit,
  variant,
  type DepHandle,
  defineError,
  deferredUnits,
} from './index.js';

interface Config {
  readonly apiUrl: string;
}
interface Session {
  readonly user: string;
}
interface Store {
  readonly label: string;
}

const ConfigToken = token('test/config').type<Config>();
const SessionToken = token('test/session').type<Session>();
const StoreToken = token('test/store').type<Store>();
const PresenceToken = token('test/presence').type<{ online: number }>();
const MenuToken = token('test/menu').multi<string>();

const configUnit = unit({
  id: 'test/config-unit',
  provides: ConfigToken,
  scope: 'app',
  create: () => ({ apiUrl: 'https://api' }),
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('injector: resolution and readiness', () => {
  it('resolves required deps before create and runs init once (single-flight)', async () => {
    const initSpy = vi.fn(async () => ok());
    const sessionUnit = unit({
      id: 'test/session-unit',
      provides: SessionToken,
      scope: 'app',
      deps: { required: { config: ConfigToken } },
      create: ({ config }) => {
        expectTypeOf(config).toEqualTypeOf<Config>();
        return { user: `u@${config.apiUrl}` };
      },
      init: initSpy,
    });
    const injector = createInjector({ units: [configUnit, sessionUnit] });
    const [a, b] = await Promise.all([injector.get(SessionToken), injector.get(SessionToken)]);
    expect(a).toEqual(ok({ user: 'u@https://api' }));
    expect(b.ok && a.ok && b.value === a.value).toBe(true);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(injector.stateOf(SessionToken)).toBe('ready');
  });

  it('reports missing providers and failed dependencies as typed errors', async () => {
    const needsConfig = unit({
      id: 'test/needs',
      provides: StoreToken,
      scope: 'app',
      deps: { required: { config: ConfigToken } },
      create: () => ({ label: 'x' }),
    });
    const injector = createInjector({ units: [needsConfig] });
    const result = await injector.get(StoreToken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SF-DI-001');

    const Fails = defineError('SF-TEST-INIT', 'network', 'down', 'retry later');
    const failingConfig = unit({
      id: 'test/failing-config',
      provides: ConfigToken,
      scope: 'app',
      create: () => ({ apiUrl: '' }),
      init: async () => err(Fails()),
    });
    const injector2 = createInjector({ units: [failingConfig, needsConfig] });
    const r2 = await injector2.get(StoreToken);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('SF-DI-003');
    expect(injector2.stateOf(ConfigToken)).toBe('failed');
  });

  it('retries init with the declared policy', async () => {
    let attempts = 0;
    const Flaky = defineError('SF-TEST-FLAKY', 'network', 'flaky', 'retry');
    const flaky = unit({
      id: 'test/flaky',
      provides: ConfigToken,
      scope: 'app',
      retry: { attempts: 3, baseDelayMs: 1, random: () => 0 },
      create: () => ({ apiUrl: 'x' }),
      init: async () => {
        attempts += 1;
        return attempts < 3 ? err(Flaky()) : ok();
      },
    });
    const injector = createInjector({ units: [flaky] });
    expect((await injector.get(ConfigToken)).ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('detects required cycles', async () => {
    const A = token('test/a').type<number>();
    const B = token('test/b').type<number>();
    const a = unit({ id: 'test/a-unit', provides: A, scope: 'app', deps: { required: { b: B } }, create: ({ b }) => b + 1 });
    const b = unit({ id: 'test/b-unit', provides: B, scope: 'app', deps: { required: { a: A } }, create: ({ a: v }) => v + 1 });
    const injector = createInjector({ units: [a, b] });
    const result = await injector.get(A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SF-DI-004');
  });
});

describe('injector: scopes', () => {
  const featureStore = unit({
    id: 'test/feature-store',
    provides: StoreToken,
    scope: 'feature',
    deps: { required: { config: ConfigToken } },
    create: ({ config }) => ({ label: config.apiUrl }),
  });

  it('hosts instances at the matching scope and shares app instances', async () => {
    const app = createInjector({ units: [configUnit] });
    const f1 = app.child('feature', 'f1', [featureStore]);
    const f2 = app.child('feature', 'f2', [featureStore]);
    const s1 = await f1.get(StoreToken);
    const s2 = await f2.get(StoreToken);
    expect(s1.ok && s2.ok && s1.value !== s2.value).toBe(true);
    const c1 = await f1.get(ConfigToken);
    const c2 = await f2.get(ConfigToken);
    expect(c1.ok && c2.ok && c1.value === c2.value).toBe(true);
  });

  it('rejects longer-lived units depending on shorter-lived ones (I-2)', async () => {
    const appStore = unit({
      id: 'test/app-store',
      provides: SessionToken,
      scope: 'app',
      deps: { required: { store: StoreToken } },
      create: ({ store }) => ({ user: store.label }),
    });
    const app = createInjector({ units: [configUnit, appStore] });
    const feature = app.child('feature', 'f', [featureStore]);
    const result = await feature.get(SessionToken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SF-DI-002');
  });

  it('rejects registering app units in a feature injector', () => {
    const app = createInjector({ units: [] });
    expect(() => app.child('feature', 'f', [configUnit])).toThrow(/SF-DI-007|cannot be registered/);
  });

  it('disposes instances when the scope ends', async () => {
    const disposed = vi.fn();
    const withCleanup = unit({
      id: 'test/cleanup',
      provides: StoreToken,
      scope: 'feature',
      create: (_deps, ctx) => {
        ctx.scope.defer(disposed);
        return { label: 'x' };
      },
    });
    const app = createInjector({ units: [] });
    const feature = app.child('feature', 'f', [withCleanup]);
    await feature.get(StoreToken);
    await feature.dispose();
    expect(disposed).toHaveBeenCalled();
    expect(app.inspect()).toHaveLength(0);
  });
});

describe('injector: lazy and functional deps, hooks', () => {
  it('lazy deps arrive without blocking and blocking hooks gate readiness', async () => {
    const gate = createDeferred<void>();
    const presenceUnit = unit({
      id: 'test/presence-unit',
      provides: PresenceToken,
      scope: 'app',
      create: () => ({ online: 3 }),
      init: async () => {
        await gate.promise;
        return ok();
      },
    });
    const seen: number[] = [];
    let handleRef: DepHandle<{ online: number }> | undefined;
    const consumer = unit({
      id: 'test/consumer',
      provides: StoreToken,
      scope: 'app',
      deps: { lazy: { presence: PresenceToken } },
      create: ({ presence }, ctx) => {
        expectTypeOf(presence).toEqualTypeOf<DepHandle<{ online: number }>>();
        handleRef = presence;
        ctx.onReady(presence, (p) => {
          seen.push(p.online);
        });
        return { label: 'c' };
      },
    });
    const injector = createInjector({ units: [presenceUnit, consumer] });
    const result = await injector.get(StoreToken);
    expect(result.ok).toBe(true); // not blocked by presence
    await tick();
    expect(handleRef?.state).toBe('pending');
    gate.resolve();
    await handleRef?.whenReady();
    await tick();
    expect(handleRef?.state).toBe('ready');
    expect(seen).toEqual([3]);
  });

  it('blocking hooks are part of the consumer readiness', async () => {
    const order: string[] = [];
    const presenceUnit = unit({ id: 'test/p2', provides: PresenceToken, scope: 'app', create: () => ({ online: 1 }) });
    const consumer = unit({
      id: 'test/c2',
      provides: StoreToken,
      scope: 'app',
      deps: { lazy: { presence: PresenceToken } },
      create: ({ presence }, ctx) => {
        ctx.onReady(
          presence,
          async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push('hook');
          },
          { blocking: true },
        );
        return { label: 'c' };
      },
    });
    const injector = createInjector({ units: [presenceUnit, consumer] });
    await injector.get(StoreToken);
    order.push('ready');
    expect(order).toEqual(['hook', 'ready']);
  });

  it('functional deps resolve only on first use', async () => {
    const created = vi.fn(() => ({ online: 9 }));
    const presenceUnit = unit({ id: 'test/p3', provides: PresenceToken, scope: 'app', create: created });
    const consumer = unit({
      id: 'test/c3',
      provides: StoreToken,
      scope: 'app',
      deps: { functional: { presence: PresenceToken } },
      create: () => ({ label: 'c' }),
    });
    const injector = createInjector({ units: [presenceUnit, consumer] });
    await injector.get(StoreToken);
    await tick();
    expect(created).not.toHaveBeenCalled();
    const fn = injector.functional(PresenceToken);
    expect((await fn.get()).ok).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
  });
});

describe('injector: deferred units', () => {
  const LazyStoreToken = token('test/lazy-store').type<Store>();
  const LazyMenuToken = token('test/lazy-menu').multi<string>();
  const realStore = unit({
    id: 'test/real-store-unit',
    provides: LazyStoreToken,
    scope: 'app',
    deps: { required: { config: ConfigToken } },
    create: ({ config }) => ({ label: `store@${config.apiUrl}` }),
  });

  it('loads the group on first resolution, once per injector, and resolves the real provider', async () => {
    const load = vi.fn(async () => [realStore, contribution({ id: 'test/lazy-menu-a', provides: LazyMenuToken, scope: 'app', create: () => 'a' })]);
    const units = deferredUnits({ id: 'test/lazy-group', provides: [LazyStoreToken, LazyMenuToken], load });
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const injector = createInjector({ units: [configUnit, ...units], telemetry });
    expect(load).not.toHaveBeenCalled();
    expect(injector.stateOf(LazyStoreToken)).toBe('unresolved');
    const [a, b] = await Promise.all([injector.get(LazyStoreToken), injector.get(LazyStoreToken)]);
    expect(a).toEqual(ok({ label: 'store@https://api' }));
    expect(b.ok && a.ok && b.value === a.value).toBe(true);
    expect(await injector.get(LazyMenuToken)).toEqual(ok(['a']));
    expect(load).toHaveBeenCalledTimes(1);
    expect(injector.stateOf(LazyStoreToken)).toBe('ready');
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'di.deferred' && r.attrs['units'] === 'test/lazy-group')).toBe(true);

    // A second app (same module graph) gets its own registration.
    const other = createInjector({ units: [configUnit, ...units] });
    expect((await other.get(LazyStoreToken)).ok).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('serves required deps and lazy handles of consumers, from child injectors too', async () => {
    const consumer = unit({
      id: 'test/consumer-unit',
      provides: PresenceToken,
      scope: 'feature',
      deps: { required: { store: LazyStoreToken } },
      create: ({ store }) => ({ online: store.label.length }),
    });
    const root = createInjector({ units: [configUnit, ...deferredUnits({ id: 'test/lazy-group', provides: [LazyStoreToken], load: async () => [realStore] })] });
    const handle = root.handle(LazyStoreToken);
    const child = root.child('feature', 'f', [consumer]);
    const presence = await child.get(PresenceToken);
    expect(presence).toEqual(ok({ online: 'store@https://api'.length }));
    expect(await handle.whenReady()).toEqual(ok({ label: 'store@https://api' }));
  });

  it('a failed load is an SF-DI-008 error and the next resolution retries', async () => {
    let attempts = 0;
    const injector = createInjector({
      units: [
        configUnit,
        ...deferredUnits({
          id: 'test/lazy-group',
          provides: [LazyStoreToken],
          load: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('chunk offline');
            return [realStore];
          },
        }),
      ],
    });
    const first = await injector.get(LazyStoreToken);
    expect(!first.ok && first.error.code).toBe('SF-DI-008');
    expect((await injector.get(LazyStoreToken)).ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it('reports SF-DI-001 when the loaded group does not provide the token', async () => {
    const injector = createInjector({ units: deferredUnits({ id: 'test/lazy-group', provides: [LazyStoreToken], load: async () => [] }) });
    const result = await injector.get(LazyStoreToken);
    expect(!result.ok && result.error.code).toBe('SF-DI-001');
  });
});

describe('injector: refresh', () => {
  it('refreshes units that refreshOn a token, keeping instances', async () => {
    let sessionInits = 0;
    let storeInits = 0;
    const sessionUnit = unit({
      id: 'test/session-r',
      provides: SessionToken,
      scope: 'app',
      create: () => ({ user: 'u' }),
      init: async () => {
        sessionInits += 1;
        return ok();
      },
    });
    const storeUnit = unit({
      id: 'test/store-r',
      provides: StoreToken,
      scope: 'app',
      deps: { required: { session: SessionToken } },
      refreshOn: [SessionToken],
      create: () => ({ label: 's' }),
      init: async () => {
        storeInits += 1;
        return ok();
      },
    });
    const injector = createInjector({ units: [sessionUnit, storeUnit] });
    const before = await injector.get(StoreToken);
    expect((await injector.refresh([SessionToken])).ok).toBe(true);
    const after = await injector.get(StoreToken);
    expect(before.ok && after.ok && before.value === after.value).toBe(true);
    expect(sessionInits).toBe(2);
    expect(storeInits).toBe(2);
  });

  it('epoch refresh bumps the epoch and refreshes epoch-subscribed units', async () => {
    let inits = 0;
    const storeUnit = unit({
      id: 'test/store-e',
      provides: StoreToken,
      scope: 'app',
      refreshOn: ['epoch'],
      create: () => ({ label: 's' }),
      init: async () => {
        inits += 1;
        return ok();
      },
    });
    const injector = createInjector({ units: [storeUnit] });
    await injector.get(StoreToken);
    expect(injector.epoch).toBe(0);
    await injector.refresh('epoch');
    expect(injector.epoch).toBe(1);
    expect(inits).toBe(2);
  });
});

describe('injector: bindings', () => {
  it('experiment variants override defaults without feature code branching', async () => {
    let inExperiment = true;
    const a = unit({ id: 'test/rank-a', provides: StoreToken, scope: 'app', create: () => ({ label: 'A' }) });
    const b = unit({ id: 'test/rank-b', provides: StoreToken, scope: 'app', create: () => ({ label: 'B' }) });
    const injector = createInjector({ units: [a, variant({ of: StoreToken, unit: b, when: () => inExperiment })] });
    expect(await injector.get(StoreToken)).toEqual(ok({ label: 'B' }));
    inExperiment = false;
    const other = createInjector({ units: [a, variant({ of: StoreToken, unit: b, when: () => inExperiment })] });
    expect(await other.get(StoreToken)).toEqual(ok({ label: 'A' }));
  });

  it('workspace bindings beat app bindings', async () => {
    const a = unit({ id: 'test/ws-a', provides: StoreToken, scope: 'app', create: () => ({ label: 'app' }) });
    const w = unit({ id: 'test/ws-w', provides: StoreToken, scope: 'app', create: () => ({ label: 'ws' }) });
    const injector = createInjector({ units: [bind(w, { precedence: 'workspace' }), bind(a, { precedence: 'app' })] });
    expect(await injector.get(StoreToken)).toEqual(ok({ label: 'ws' }));
  });

  it('multi tokens collect ordered contributions', async () => {
    const m1 = contribution({ id: 'test/menu-2', provides: MenuToken, scope: 'app', order: 2, create: () => 'second' });
    const m2 = contribution({ id: 'test/menu-1', provides: MenuToken, scope: 'app', order: 1, create: () => 'first' });
    const injector = createInjector({ units: [m1, m2] });
    expect(await injector.get(MenuToken)).toEqual(ok(['first', 'second']));
  });
});

describe('injector: telemetry', () => {
  it('traces critical resolution as a boot span', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'standard' });
    telemetry.addSink(sink);
    const critical = unit({ ...configUnit, id: 'test/critical-config', critical: true });
    const injector = createInjector({ units: [critical], telemetry });
    expect((await injector.resolveCritical()).ok).toBe(true);
    const names = sink.records.filter((r) => r.type === 'span').map((r) => (r.type === 'span' ? r.name : ''));
    expect(names).toContain('di.critical');
    expect(names).toContain('di.resolve');
  });
});

describe('telemetry', () => {
  it('respects per-subsystem levels and buffers until a sink attaches', () => {
    const t = createTelemetry({ defaultLevel: 'critical', levels: { 'router/pipeline': 'verbose' } });
    expect(t.enabled('core/di', 'standard')).toBe(false);
    expect(t.enabled('router/pipeline', 'verbose')).toBe(true);
    t.span('x', { subsystem: 'router/pipeline' }).end();
    const sink = createMemorySink();
    t.addSink(sink);
    expect(sink.records.map((r) => r.type)).toEqual(['span-start', 'span']);
    t.setLevel('*', 'debug');
    expect(t.enabled('core/di', 'debug')).toBe(true);
  });

  it('records declared metrics', () => {
    const t = createTelemetry();
    const sink = createMemorySink();
    t.addSink(sink);
    const latency = metric.histogram('test/latency', { unit: 'ms' });
    t.record(latency, 12, { route: '/a' });
    expect(sink.records[0]).toMatchObject({ type: 'metric', metric: 'test/latency', value: 12, unit: 'ms' });
  });

  it('round-trips traceparent', () => {
    const ctx = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx);
    expect(parseTraceparent('garbage')).toBeUndefined();
  });

  it('child spans share the trace id', () => {
    const t = createTelemetry();
    const parent = t.span('p', { subsystem: 'test/x' });
    const child = t.span('c', { subsystem: 'test/x', parent });
    expect(child.context?.traceId).toBe(parent.context?.traceId);
  });
});

describe('graph analysis', () => {
  it('reports cycles, missing providers, scope violations and boot order', () => {
    const A = token('g/a').type<number>();
    const B = token('g/b').type<number>();
    const C = token('g/c').type<number>();
    const Missing = token('g/missing').type<number>();
    const a = unit({ id: 'g/a-unit', provides: A, scope: 'app', critical: true, deps: { required: { b: B } }, create: () => 1 });
    const b = unit({ id: 'g/b-unit', provides: B, scope: 'app', create: () => 1 });
    const c = unit({ id: 'g/c-unit', provides: C, scope: 'app', deps: { required: { m: Missing } }, create: () => 1 });
    const report = analyzeGraph([a, b, c]);
    expect(report.bootOrder.indexOf('g/b-unit')).toBeLessThan(report.bootOrder.indexOf('g/a-unit'));
    expect(report.criticalSet).toEqual(expect.arrayContaining(['g/a-unit', 'g/b-unit']));
    expect(report.issues.some((i) => i.code === 'SF-DI-001' && i.severity === 'error')).toBe(true);

    const x = unit({ id: 'g/x', provides: A, scope: 'app', deps: { required: { b: B } }, create: () => 1 });
    const y = unit({ id: 'g/y', provides: B, scope: 'feature', deps: { required: { a: A } }, create: () => 1 });
    const cyc = analyzeGraph([x, y]);
    expect(cyc.issues.some((i) => i.code === 'SF-DI-004')).toBe(true);
    expect(cyc.issues.some((i) => i.code === 'SF-DI-002')).toBe(true);
  });

  it('checks metric producers and consumers', () => {
    const m = metric.counter('g/clicks');
    const reader = unit({ id: 'g/reader', provides: token('g/r').type<number>(), scope: 'app', reads: [m], create: () => 1 });
    expect(analyzeGraph([reader]).issues.some((i) => i.code === 'SF-METRIC-001')).toBe(true);
  });
});

describe('compile-time completeness', () => {
  it('composeUnits accepts complete sets and rejects incomplete ones', () => {
    const store = unit({
      id: 'test/compose-store',
      provides: StoreToken,
      scope: 'app',
      deps: { required: { config: ConfigToken } },
      create: () => ({ label: 'x' }),
    });
    composeUnits([configUnit, store]);
    // @ts-expect-error — "test/config" has no provider
    composeUnits([store]);
    expect(true).toBe(true);
  });
});
