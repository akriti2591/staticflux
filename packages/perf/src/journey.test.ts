import { createTelemetry, type SpanEndRecord, type Telemetry } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createJourneyTracker, criticalPath, featureMarkMetrics, type JourneySummary } from './index.js';

function setup(options: Partial<Parameters<typeof createJourneyTracker>[0]> = {}) {
  let t = 0;
  let seed = 0;
  const telemetry = createTelemetry({ now: () => t, random: () => ((seed = (seed * 9301 + 49297) % 233280) / 233280) });
  const tracker = createJourneyTracker({ telemetry, ...options });
  telemetry.addSink(tracker);
  const summaries: JourneySummary[] = [];
  tracker.onJourney((s) => summaries.push(s));
  return { telemetry, tracker, summaries, at: (ms: number) => (t = ms) };
}

const mark = (telemetry: Telemetry, name: keyof typeof featureMarkMetrics, feature: string, at: number, method = 'commit+frame'): void =>
  telemetry.record(featureMarkMetrics[name], at, { feature, method, at });

describe('journey tracer', () => {
  it('assembles a cold journey: boot → pipeline → feature, with critical paths, marks and classification', () => {
    const { telemetry, tracker, summaries, at } = setup();
    at(0);
    const boot = telemetry.span('app.boot', { subsystem: 'runtime/app', level: 'critical' });
    const core = telemetry.span('boot.core', { subsystem: 'runtime/app', parent: boot });
    at(10);
    core.end();
    const critical = telemetry.span('boot.critical', { subsystem: 'runtime/app', parent: boot });
    const unitA = telemetry.span('di.resolve', { subsystem: 'core/di', parent: critical });
    const unitB = telemetry.span('di.resolve', { subsystem: 'core/di', parent: critical });
    at(30);
    unitA.end();
    at(60);
    unitB.end();
    critical.end();
    at(70);
    boot.end();
    expect(tracker.current?.start).toBe('cold');

    at(80);
    const nav = telemetry.span('nav.pipeline', { subsystem: 'router/pipeline', attrs: { route: '/studio/doc/42' } });
    const load = telemetry.span('stage.load', { subsystem: 'router/pipeline', parent: nav });
    const chunk1 = telemetry.span('chunk.load', { subsystem: 'loader/chunk', parent: load, attrs: { chunk: 'feature:studio-desktop' } });
    const chunk2 = telemetry.span('chunk.load', { subsystem: 'loader/chunk', parent: load, attrs: { chunk: 'lib:editor' } });
    at(150);
    chunk2.set('codeSource', 'http-cache');
    chunk2.end();
    at(200);
    chunk1.set('codeSource', 'network');
    chunk1.end();
    load.end();
    at(210);
    nav.end();

    const activate = telemetry.span('feature.activate', { subsystem: 'runtime/feature', attrs: { feature: 'studio', activation: 'fresh' } });
    const req = telemetry.span('data/request', { subsystem: 'data/request', parent: activate, attrs: { dataSource: 'cache' } });
    at(260);
    req.end();
    activate.end();
    const orphan = telemetry.span('misc.thing', { subsystem: 'x/y' });
    orphan.end();

    mark(telemetry, 'firstRender', 'studio', 300);
    mark(telemetry, 'largestRender', 'studio', 320, 'largest-heuristic');
    mark(telemetry, 'largestRender', 'studio', 340, 'element-timing');
    mark(telemetry, 'firstRender', 'studio', 999);
    telemetry.record(featureMarkMetrics.interactive, 1, { method: 'x' }); // no feature attr → ignored
    at(400);
    mark(telemetry, 'complete', 'studio', 400, 'framework-default');

    expect(summaries).toHaveLength(1);
    const s = summaries[0] as JourneySummary;
    expect(s.outcome).toBe('complete');
    expect(s.route).toBe('/studio/doc/42');
    expect(s.duration).toBe(400);
    expect(s.classification).toEqual({ start: 'cold', activation: 'fresh', code: 'network', data: 'cache' });
    expect(s.marks['studio']).toEqual({
      'firstRender': { value: 300, method: 'commit+frame' },
      'largestRender': { value: 340, method: 'element-timing' },
      complete: { value: 400, method: 'framework-default' },
    });
    expect(s.phases.map((p) => [p.phase, p.start, p.end, p.total, p.spanCount])).toEqual([
      ['app.boot', 0, 70, 70, 5],
      ['nav.pipeline', 80, 210, 130, 4],
      ['feature', 210, 260, 50, 2],
    ]);
    const bootPath = s.phases[0]?.criticalPath.map((c) => `${'  '.repeat(c.depth)}${c.name}@${c.start}-${c.end}`);
    expect(bootPath).toEqual(['app.boot@0-70', '  boot.core@0-10', '  boot.critical@10-60', '    di.resolve@10-60']);
    const navPath = s.phases[1]?.criticalPath.map((c) => c.name);
    expect(navPath).toEqual(['nav.pipeline', 'stage.load', 'chunk.load']);
    expect(s.phases[1]?.criticalPath[2]?.end).toBe(200);
    expect(tracker.current).toBeUndefined();
    expect(tracker.history).toHaveLength(1);
  });

  it('emits a journey.summary event and duration metrics', () => {
    let t = 0;
    const telemetry = createTelemetry({ now: () => t, random: () => 0.3 });
    const records: unknown[] = [];
    telemetry.addSink({ receive: (r) => records.push(r) });
    const tracker = createJourneyTracker({ telemetry });
    telemetry.addSink(tracker);
    tracker.begin({ start: 'soft', route: '/settings' });
    const view = telemetry.span('view.enter', { subsystem: 'router/view' });
    t = 40;
    view.end();
    const summary = tracker.end();
    expect(summary?.phases.map((p) => p.phase)).toEqual(['view']);
    expect(records).toContainEqual(expect.objectContaining({ type: 'event', name: 'journey.summary', attrs: expect.objectContaining({ start: 'soft', outcome: 'ended', 'phase.view': 40, route: '/settings' }) }));
    expect(records).toContainEqual(expect.objectContaining({ type: 'metric', metric: 'perf/journey-duration', value: 40 }));
    expect(records).toContainEqual(expect.objectContaining({ type: 'metric', metric: 'perf/phase-duration', attrs: { phase: 'view', start: 'soft' } }));
    expect(tracker.end()).toBeUndefined();
  });

  it('a new navigation supersedes the open journey; warm boot and inputAt are honoured', () => {
    const { telemetry, tracker, summaries, at } = setup();
    at(5);
    const boot = telemetry.span('app.boot', { subsystem: 'runtime/app', level: 'critical', attrs: { warm: true } });
    boot.end();
    expect(tracker.current?.start).toBe('warm');
    const nav1 = telemetry.span('nav.pipeline', { subsystem: 'router/pipeline', attrs: { route: '/' } });
    nav1.end();
    expect(tracker.current?.route).toBe('/');
    at(50);
    const nav2 = telemetry.span('nav.pipeline', { subsystem: 'router/pipeline', attrs: { route: '/onboarding', inputAt: 45 } });
    nav2.end();
    expect(summaries.map((s) => [s.outcome, s.classification.start])).toEqual([['superseded', 'warm']]);
    expect(tracker.current).toMatchObject({ start: 'soft', route: '/onboarding', startedAt: 45 });
    at(60);
    const nav3 = telemetry.span('nav.pipeline', { subsystem: 'router/pipeline' });
    nav3.end();
    expect(summaries).toHaveLength(2);
    expect(tracker.current?.route).toBeUndefined();
    tracker.end('abandoned');
    expect(summaries[2]?.outcome).toBe('abandoned');
  });

  it('all-features completion waits for every marking feature; manual completion never auto-ends', () => {
    const { telemetry, tracker, summaries } = setup();
    tracker.begin({ start: 'soft' });
    mark(telemetry, 'firstRender', 'studio', 10);
    mark(telemetry, 'firstRender', 'agent-chat', 12);
    mark(telemetry, 'complete', 'studio', 20);
    expect(summaries).toHaveLength(0);
    mark(telemetry, 'complete', 'agent-chat', 30);
    expect(summaries[0]?.outcome).toBe('complete');
    expect(summaries[0]?.endedAt).toBe(30);

    const manual = setup({ completion: 'manual' });
    manual.tracker.begin({ start: 'soft' });
    mark(manual.telemetry, 'complete', 'studio', 20);
    expect(manual.summaries).toHaveLength(0);
    // marks outside a journey are ignored
    manual.tracker.end();
    mark(manual.telemetry, 'complete', 'studio', 20);
    expect(manual.summaries).toHaveLength(1);
  });

  it('archived activation implies snapshot data; history is bounded; span buffer capped', () => {
    const { telemetry, tracker, summaries } = setup({ historyLimit: 2, spanLimit: 1 });
    for (let i = 0; i < 3; i += 1) {
      tracker.begin({ start: 'soft' });
      const a = telemetry.span('feature.activate', { subsystem: 'runtime/feature', attrs: { activation: 'archived' } });
      a.end();
      telemetry.span('feature.mount', { subsystem: 'runtime/feature' }).end();
      tracker.end();
    }
    expect(summaries[0]?.classification).toMatchObject({ activation: 'archived', data: 'snapshot', code: undefined });
    expect(summaries[0]?.spans).toHaveLength(1);
    expect(tracker.history).toHaveLength(2);
  });

  it('critical path skips parallel siblings that finish earlier', () => {
    const span = (id: string, start: number, end: number, parent?: string): SpanEndRecord => ({
      type: 'span',
      name: id,
      subsystem: 'x/y',
      level: 'standard',
      context: { traceId: 't', spanId: id, sampled: true },
      parentSpanId: parent,
      start,
      end,
      duration: end - start,
      attrs: {},
      status: 'ok',
      error: undefined,
    });
    const path = criticalPath([span('a', 0, 10), span('b', 0, 30), span('c', 30, 50), span('d', 35, 45), span('c1', 30, 40, 'c'), span('c2', 30, 49, 'c')]);
    expect(path.map((p) => `${p.depth}:${p.name}`)).toEqual(['0:b', '0:c', '1:c2']);
    expect(criticalPath([])).toEqual([]);
  });
});
