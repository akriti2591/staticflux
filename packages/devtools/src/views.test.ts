import { describe, expect, it } from 'vitest';
import { createInjector, createTelemetry, metric, ok, type Telemetry, token, unit } from '@staticflux/core';
import { createJourneyTracker, featureMarkMetrics } from '@staticflux/perf';
import { bootApp } from '@staticflux/runtime';
import { createDevtoolsCollector } from './collector.js';
import {
  buildBootWaterfall,
  buildDecisions,
  buildDiGraph,
  buildJourneysFromSpans,
  buildJourneysFromTracker,
  buildLifecycles,
  buildMetrics,
  buildViolations,
  declaredMetricsOf,
  previewJson,
} from './views.js';

function clock(level: 'debug' | 'standard' = 'debug'): { telemetry: Telemetry; at: (ms: number) => void } {
  let t = 0;
  let seed = 7;
  const telemetry = createTelemetry({
    defaultLevel: level,
    now: () => t,
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    },
  });
  return { telemetry, at: (ms) => (t = ms) };
}

/** app.boot [0,20] ← boot.core [0,1], boot.critical [1,20] ← di.critical ← shell [1,20] ← transport [2,12], config [2,6]. */
function emitBoot(telemetry: Telemetry, at: (ms: number) => void, endRoot = true) {
  at(0);
  const boot = telemetry.span('app.boot', { subsystem: 'runtime/app', level: 'critical' });
  const core = telemetry.span('boot.core', { subsystem: 'runtime/app', parent: boot });
  at(1);
  core.end();
  const critical = telemetry.span('boot.critical', { subsystem: 'runtime/app', parent: boot });
  const di = telemetry.span('di.critical', { subsystem: 'core/di', parent: critical });
  const shell = telemetry.span('di.resolve', { subsystem: 'core/di', parent: di, attrs: { unit: 'app/shell', token: 'app/shell', scope: 'app', injector: 'app' } });
  at(2);
  const transport = telemetry.span('di.resolve', { subsystem: 'core/di', parent: shell, attrs: { unit: 'data/transport', scope: 'app' } });
  const config = telemetry.span('di.resolve', { subsystem: 'core/di', parent: shell, attrs: { unit: 'config/provider', scope: 'app' } });
  at(6);
  config.end();
  at(12);
  transport.end();
  at(20);
  shell.set('budget.initMs', 2);
  shell.end();
  di.end();
  critical.end();
  if (endRoot) boot.end();
  return boot;
}

describe('boot waterfall (R2.4)', () => {
  it('builds the span tree with offsets, critical path and per-unit timings', () => {
    const { telemetry, at } = clock();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    emitBoot(telemetry, at);
    const wf = buildBootWaterfall(collector.bootTrace(), 20);
    expect(wf.status).toBe('complete');
    expect(wf.total).toBe(20);
    expect(wf.rows.map((r) => [r.label, r.depth, r.offset, r.duration])).toEqual([
      ['app.boot', 0, 0, 20],
      ['boot.core', 1, 0, 1],
      ['boot.critical', 1, 1, 19],
      ['di.critical', 2, 1, 19],
      ['app/shell', 3, 1, 19],
      ['config/provider', 4, 2, 4],
      ['data/transport', 4, 2, 10],
    ]);
    const onPath = wf.rows.filter((r) => r.onCriticalPath).map((r) => r.label);
    expect(onPath).toContain('data/transport');
    expect(onPath).not.toContain('config/provider');
    expect(wf.criticalPath.map((s) => s.label)).toEqual(['app.boot', 'boot.core', 'boot.critical', 'di.critical', 'app/shell', 'data/transport']);

    const shell = wf.units.find((u) => u.unit === 'app/shell');
    expect(shell).toMatchObject({ duration: 19, waitMs: 11, ownMs: 8, budgetMs: 2, overBudget: true, onCriticalPath: true, waitedOn: ['config/provider', 'data/transport'] });
    expect(wf.units.map((u) => u.unit)).toEqual(['app/shell', 'data/transport', 'config/provider']);
    expect(wf.overBudget.map((u) => u.unit)).toEqual(['app/shell']);
    expect(wf.hint).toBeUndefined();
  });

  it('shows a running boot with open spans and elapsed time', () => {
    const { telemetry, at } = clock();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    emitBoot(telemetry, at, false);
    const wf = buildBootWaterfall(collector.bootTrace(), 25);
    expect(wf.status).toBe('running');
    expect(wf.total).toBe(25);
    expect(wf.rows[0]).toMatchObject({ name: 'app.boot', status: 'open' });
  });

  it('reports missing traces and missing DI spans with a hint', () => {
    expect(buildBootWaterfall(undefined, 0)).toMatchObject({ status: 'missing', rows: [] });
    const { telemetry } = clock();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    const boot = telemetry.span('app.boot', { subsystem: 'runtime/app' });
    boot.end('error');
    const wf = buildBootWaterfall(collector.bootTrace(), 0);
    expect(wf.status).toBe('failed');
    expect(wf.hint).toContain('core/di');
  });

  it('works on a real bootApp trace (per-unit DI resolution from core/di spans)', async () => {
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    const A = token('test/a').type<number>();
    const B = token('test/b').type<number>();
    const result = await bootApp({
      telemetry,
      units: [
        unit({ id: 'test/a-unit', provides: A, scope: 'app', critical: true, deps: { required: { b: B } }, create: ({ b }) => b + 1 }),
        unit({ id: 'test/b-unit', provides: B, scope: 'app', create: () => 1, init: async () => ok() }),
      ],
    });
    if (!result.ok) throw result.error;
    const wf = buildBootWaterfall(collector.bootTrace(), telemetry.now());
    expect(wf.status).toBe('complete');
    expect(wf.rows[0]?.name).toBe('app.boot');
    expect(wf.units.map((u) => u.unit).sort()).toEqual(['test/a-unit', 'test/b-unit']);
    expect(wf.units.find((u) => u.unit === 'test/a-unit')?.waitedOn).toEqual(['test/b-unit']);
    await result.value.shutdown();
  });
});

describe('journeys (R17.5)', () => {
  it('falls back to nav.pipeline spans: stages become phases with critical paths', () => {
    const { telemetry, at } = clock();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    at(100);
    const nav = telemetry.span('nav.pipeline', { subsystem: 'router/navigation', attrs: { route: 'studio/doc', start: 'soft', kind: 'full' } });
    const match = telemetry.span('nav.stage', { subsystem: 'router/pipeline', parent: nav, attrs: { stage: 'match' } });
    at(102);
    match.end();
    const load = telemetry.span('nav.stage', { subsystem: 'router/pipeline', parent: nav, attrs: { stage: 'load' } });
    const chunk = telemetry.span('chunk.load', { subsystem: 'loader/chunks', parent: load, attrs: { chunk: 'feature:studio' } });
    at(130);
    chunk.end();
    load.end();
    nav.set('outcome', 'committed');
    nav.end();
    const view = telemetry.span('nav.view', { subsystem: 'router/navigation', attrs: { route: 'studio/doc' } });
    at(135);
    view.end();
    const journeys = buildJourneysFromSpans(collector.spans());
    expect(journeys).toHaveLength(2);
    expect(journeys[0]).toMatchObject({ start: 'view', duration: 5, source: 'spans' });
    const full = journeys[1];
    expect(full).toMatchObject({ route: 'studio/doc', start: 'soft', outcome: 'committed', duration: 30, classification: { kind: 'full' } });
    expect(full?.phases.map((p) => [p.name, p.offset, p.total, p.spanCount])).toEqual([
      ['stage match', 0, 2, 1],
      ['stage load', 2, 28, 2],
    ]);
    expect(full?.phases[1]?.criticalPath.map((c) => c.label)).toEqual(['stage load', 'chunk feature:studio']);
  });

  it("uses perf's journey tracker when bound (phases, marks, classification, open journey)", () => {
    const { telemetry, at } = clock();
    const tracker = createJourneyTracker({ telemetry, completion: 'manual' });
    telemetry.addSink(tracker);
    at(0);
    tracker.begin({ start: 'soft', route: '/studio/doc/42' });
    const nav = telemetry.span('nav.pipeline', { subsystem: 'router/navigation', attrs: { route: '/studio/doc/42' } });
    at(10);
    nav.end();
    telemetry.record(featureMarkMetrics.firstRender, 15, { feature: 'studio', method: 'commit+frame', at: 15 });
    at(20);
    tracker.end();
    at(30);
    tracker.begin({ start: 'soft', route: '/settings' });
    at(34);
    const journeys = buildJourneysFromTracker(tracker, 34);
    expect(journeys[0]).toMatchObject({ route: '/settings', open: true, outcome: 'open', duration: 4 });
    const done = journeys[1];
    expect(done).toMatchObject({ route: '/studio/doc/42', outcome: 'ended', duration: 20, source: 'tracker', classification: { start: 'soft' } });
    expect(done?.phases[0]).toMatchObject({ name: 'nav.pipeline', total: 10 });
    expect(done?.marks).toEqual([{ feature: 'studio', mark: 'firstRender', value: 15, method: 'commit+frame' }]);
  });
});

describe('DI graph', () => {
  const A = token('g/a').type<number>();
  const B = token('g/b').type<number>();
  const C = token('g/c').type<number>();
  const Missing = token('g/missing').type<number>();
  const units = [
    unit({ id: 'g/a-unit', provides: A, scope: 'app', critical: true, deps: { required: { b: B, c: C } }, create: ({ b, c }) => b + c }),
    unit({ id: 'g/b-unit', provides: B, scope: 'app', deps: { required: { c: C } }, create: ({ c }) => c }),
    unit({ id: 'g/c-unit', provides: C, scope: 'app', create: () => 1 }),
    unit({ id: 'g/d-unit', provides: token('g/d').type<number>(), scope: 'app', deps: { lazy: { m: Missing } }, create: () => 0 }),
  ];

  it('layers declared units by required depth and merges live states from inspect()', async () => {
    const injector = createInjector({ units });
    expect((await injector.get(A)).ok).toBe(true);
    const graph = buildDiGraph(injector.inspect(), units);
    expect(graph.source).toBe('graph');
    expect(graph.layers.map((l) => l.map((n) => n.unitId))).toEqual([['g/c-unit', 'g/d-unit'], ['g/b-unit'], ['g/a-unit']]);
    const a = graph.layers[2]?.[0];
    expect(a).toMatchObject({ state: 'ready', critical: true, inCriticalSet: true, requires: ['g/b-unit', 'g/c-unit'], fanOut: 2, declared: true });
    expect(graph.layers[0]?.find((n) => n.unitId === 'g/d-unit')?.state).toBe('not-created');
    expect(graph.counts).toMatchObject({ ready: 3, 'not-created': 1 });
    expect(graph.issues.some((i) => i.code === 'SF-DI-001')).toBe(true);
    expect(graph.bootOrder.indexOf('g/c-unit')).toBeLessThan(graph.bootOrder.indexOf('g/a-unit'));
    expect(graph.edges).toContainEqual({ from: 'g/a-unit', to: 'g/b-unit', kind: 'required' });
  });

  it('without definitions, groups live instances by scope and aggregates per-injector states', async () => {
    const injector = createInjector({ units: units.slice(0, 3) });
    await injector.get(A);
    const child = injector.child('feature', 'feature:x', [unit({ id: 'g/f-unit', provides: token('g/f').type<number>(), scope: 'feature', create: () => 2 })]);
    await child.get(token('g/f').type<number>());
    const graph = buildDiGraph(injector.inspect());
    expect(graph.source).toBe('instances');
    expect(graph.layers.map((l) => l.map((n) => `${n.scope}:${n.unitId}`))).toEqual([
      ['app:g/a-unit', 'app:g/b-unit', 'app:g/c-unit'],
      ['feature:g/f-unit'],
    ]);
    expect(graph.layers[1]?.[0]?.instances).toEqual([{ injector: 'feature:x', state: 'ready' }]);
  });

  it('marks undeclared instances and failed units with their error', async () => {
    const Bad = token('g/bad').type<number>();
    const bad = unit({ id: 'g/bad-unit', provides: Bad, scope: 'app', create: () => { throw new Error('nope'); } });
    const injector = createInjector({ units: [...units.slice(0, 3), bad] });
    await injector.get(Bad);
    const graph = buildDiGraph(injector.inspect(), units.slice(0, 3));
    const node = graph.layers.flat().find((n) => n.unitId === 'g/bad-unit');
    expect(node).toMatchObject({ declared: false, state: 'failed' });
    expect(node?.error).toContain('nope');
  });
});

describe('lifecycles', () => {
  it('merges live supervisor/feature state with transition history from events', () => {
    const { telemetry, at } = clock();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    at(1);
    telemetry.event('lifecycle.app.starting→core-ready', { subsystem: 'runtime/app', attrs: { event: 'core-ready' } });
    telemetry.event('lifecycle.worker.spawning→handshaking', { subsystem: 'worker/supervisor', attrs: { worker: 'doc' } });
    telemetry.event('lifecycle.messaging/surface.requested→queued', { subsystem: 'messaging/surfaces', attrs: { surface: 'billing/upsell' } });
    telemetry.event('lifecycle.i18n/locale.idle→loading', { subsystem: 'i18n/locale' });
    const view = buildLifecycles(collector.lifecycles(), {
      app: { state: 'running', epoch: 3 },
      subsystems: [{ id: 'app/router', state: 'running', critical: false, dependsOn: ['app/data'], restarts: 1, error: undefined }],
      features: [
        {
          id: 'app/studio',
          state: 'mounted',
          weight: 'heavy',
          retention: 'archive' as never,
          headless: false,
          explicit: true,
          refCount: 1,
          mountedDependents: [],
          lastUsed: 0,
          busy: false,
          error: undefined,
        },
      ],
    });
    expect(view.groups.map((g) => g.label)).toEqual(['App', 'Subsystems', 'Features', 'Workers', 'Surfaces', 'i18n/locale']);
    const app = view.groups[0]?.items[0];
    expect(app).toMatchObject({ state: 'running', source: 'both', transitions: 1, details: { epoch: 3 } });
    expect(app?.history[0]).toMatchObject({ from: 'starting', to: 'core-ready', event: 'core-ready' });
    expect(view.groups[1]?.items[0]).toMatchObject({ instance: 'app/router', source: 'live', details: { restarts: 1, dependsOn: 'app/data', critical: false } });
    expect(view.groups[2]?.items[0]).toMatchObject({ instance: 'app/studio', state: 'mounted', details: { weight: 'heavy', refCount: 1 } });
    expect(view.groups[3]?.items[0]).toMatchObject({ instance: 'doc', state: 'handshaking', source: 'events' });
    expect(view.groups[4]?.items[0]?.instance).toBe('billing/upsell');
    expect(view.total).toBe(6);
  });
});

describe('decisions, violations, metrics, previews', () => {
  it('lists decisions newest first with filters', () => {
    const base = { level: 'route', actionId: 'gate/access', subject: 'principal', determining: [], facts: undefined, alternatives: undefined, source: 'event' as const, reason: undefined };
    const records = [
      { ...base, time: 1, key: 'route:/a:gate/access', resourceId: '/a', effect: 'allow' as const },
      { ...base, time: 2, key: 'route:/studio:gate/access', resourceId: '/studio', effect: 'deny' as const, reason: 'login' },
    ];
    expect(buildDecisions(records).items.map((d) => d.time)).toEqual([2, 1]);
    expect(buildDecisions(records, { effect: 'deny' })).toMatchObject({ allow: 0, deny: 1 });
    expect(buildDecisions(records, { text: 'STUDIO' }).items).toHaveLength(1);
  });

  it('sorts violation groups (errors first, then count) and fills fixes from the catalog', () => {
    const group = (code: string, severity: 'error' | 'warning', count: number, fix = '') => ({
      code,
      severity,
      count,
      fix,
      message: undefined,
      features: [],
      units: [],
      subsystems: [],
      firstAt: 0,
      lastAt: 0,
      samples: [],
    });
    const view = buildViolations([group('SF-X-1', 'warning', 9, 'f'), group('SF-DI-004', 'error', 1), group('SF-X-2', 'error', 3, 'g')]);
    expect(view.groups.map((g) => g.code)).toEqual(['SF-X-2', 'SF-DI-004', 'SF-X-1']);
    const cycle = view.groups[1];
    expect(cycle?.fixFromCatalog).toBe(true);
    expect(cycle?.fix).toContain('Break the cycle');
    expect(view).toMatchObject({ total: 13, errors: 4, warnings: 9 });
  });

  it('lists declared metrics (informs/reads) with observed series', () => {
    const declaredOnly = metric.counter('test/silent');
    const used = metric.histogram('test/used', { unit: 'ms', description: 'used' });
    const units = [unit({ id: 'm/u', provides: token('m/x').type<number>(), scope: 'app', informs: [used], reads: [declaredOnly], create: () => 1 })];
    expect(declaredMetricsOf(units).map((m) => m.id)).toEqual(['test/used', 'test/silent']);
    const view = buildMetrics(
      [
        { metric: 'test/used', kind: 'histogram', unit: 'ms', attrs: {}, last: 4, time: 1, count: 2, sum: 6, min: 2, max: 4 },
        { metric: 'test/other', kind: 'gauge', unit: undefined, attrs: { a: 1 }, last: 1, time: 1, count: 1, sum: 1, min: 1, max: 1 },
      ],
      declaredMetricsOf(units),
    );
    expect(view.metrics.map((m) => [m.id, m.declared, m.observed])).toEqual([
      ['test/other', false, true],
      ['test/silent', true, false],
      ['test/used', true, true],
    ]);
    expect(view.silent).toEqual(['test/silent']);
    expect(view.metrics[2]).toMatchObject({ description: 'used', unit: 'ms' });
  });

  it('previews JSON safely (cycles, functions, bigint, truncation)', () => {
    const cyclic: Record<string, unknown> = { a: 1, f: () => 1, n: 10n };
    cyclic['self'] = cyclic;
    const text = previewJson(cyclic);
    expect(text).toContain('[circular]');
    expect(text).toContain('[function]');
    expect(text).toContain('10n');
    expect(previewJson('x'.repeat(50), 10)).toContain('more chars');
    expect(previewJson(undefined)).toBe('undefined');
  });
});
