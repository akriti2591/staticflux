import { describe, expect, it } from 'vitest';
import { createTelemetry, metric, type Telemetry } from '@staticflux/core';
import { reportViolation } from '@staticflux/perf';
import {
  createDevtoolsCollector,
  instanceOf,
  parseInvalidEvent,
  parseLifecycleEvent,
  splitDecisionKey,
} from './collector.js';
import { createBoundedMap, createRingBuffer } from './ring.js';

function clockTelemetry(level: 'verbose' | 'debug' | 'standard' = 'debug'): { telemetry: Telemetry; tick: (ms: number) => void } {
  let t = 0;
  let seed = 1;
  const telemetry = createTelemetry({
    defaultLevel: level,
    now: () => t,
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    },
  });
  return { telemetry, tick: (ms) => (t += ms) };
}

describe('ring buffer / bounded map', () => {
  it('keeps the newest `capacity` items in order', () => {
    const ring = createRingBuffer<number>(3);
    for (let i = 1; i <= 5; i += 1) ring.push(i);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
    expect(ring.pushed).toBe(5);
    expect(ring.last()).toBe(5);
    ring.clear();
    expect(ring.toArray()).toEqual([]);
    expect(ring.last()).toBeUndefined();
  });

  it('bounded map evicts the least recently touched key', () => {
    const map = createBoundedMap<string, number>(2);
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 3); // touch a
    map.set('c', 4); // evicts b
    expect(map.entries()).toEqual([
      ['a', 3],
      ['c', 4],
    ]);
    expect(map.has('b')).toBe(false);
    map.delete('a');
    expect(map.size).toBe(1);
  });
});

describe('parsers', () => {
  it('parses lifecycle transition names, including namespaced machines', () => {
    expect(parseLifecycleEvent('lifecycle.app.starting→core-ready')).toEqual({ machine: 'app', from: 'starting', to: 'core-ready' });
    expect(parseLifecycleEvent('lifecycle.messaging/surface.queued→showing')).toEqual({ machine: 'messaging/surface', from: 'queued', to: 'showing' });
    expect(parseLifecycleEvent('lifecycle.app.invalid')).toBeUndefined();
    expect(parseLifecycleEvent('nav.pipeline')).toBeUndefined();
  });

  it('parses invalid-transition events', () => {
    expect(parseInvalidEvent('lifecycle.subsystem.invalid', {})).toBe('subsystem');
    expect(parseInvalidEvent('lifecycle.invalid', { machine: 'i18n/locale' })).toBe('i18n/locale');
    expect(parseInvalidEvent('lifecycle.app.ready→x', {})).toBeUndefined();
  });

  it('picks the instance attribute by priority', () => {
    expect(instanceOf('subsystem', { subsystem: 'router', from: 'idle' })).toBe('router');
    expect(instanceOf('messaging/surface', { surface: 'studio/share', kind: 'dialog' })).toBe('studio/share');
    expect(instanceOf('app', { from: 'a', to: 'b' })).toBe('app');
  });

  it('splits decision keys whose resource contains colons', () => {
    expect(splitDecisionKey('route:/studio:gate/access')).toEqual({ level: 'route', resourceId: '/studio', actionId: 'gate/access' });
    expect(splitDecisionKey('capability:a:b:agent/x')).toEqual({ level: 'capability', resourceId: 'a:b', actionId: 'agent/x' });
    expect(splitDecisionKey('route\u0000/x\u0000gate/access').resourceId).toBe('/x');
  });
});

describe('collector', () => {
  it('records ended spans, open spans and the boot trace separately', () => {
    const { telemetry, tick } = clockTelemetry();
    const collector = createDevtoolsCollector({ capacity: { spans: 3 } });
    telemetry.addSink(collector);
    const boot = telemetry.span('app.boot', { subsystem: 'runtime/app', level: 'critical' });
    const core = telemetry.span('boot.core', { subsystem: 'runtime/app', parent: boot });
    tick(2);
    core.end();
    expect(collector.bootTrace()?.open.map((s) => s.name)).toEqual(['app.boot']);
    tick(3);
    boot.end();
    for (let i = 0; i < 5; i += 1) telemetry.span(`other.${i}`, { subsystem: 'data/request' }).end();
    // general ring is bounded to 3, the boot trace survives
    expect(collector.spans().map((s) => s.name)).toEqual(['other.2', 'other.3', 'other.4']);
    const trace = collector.bootTrace();
    expect(trace?.spans.map((s) => s.name)).toEqual(['boot.core', 'app.boot']);
    expect(trace?.open).toEqual([]);
    expect(collector.openSpans()).toEqual([]);
  });

  it('a bare di.critical root is a boot trace when there is no app.boot', () => {
    const { telemetry } = clockTelemetry();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    telemetry.span('di.critical', { subsystem: 'core/di' }).end();
    expect(collector.bootTrace()?.spans[0]?.name).toBe('di.critical');
    // a later app.boot replaces it
    telemetry.span('app.boot', { subsystem: 'runtime/app' }).end();
    expect(collector.bootTrace()?.spans.map((s) => s.name)).toEqual(['app.boot']);
  });

  it('receives records buffered before it attached (install after boot)', () => {
    const { telemetry } = clockTelemetry();
    const boot = telemetry.span('app.boot', { subsystem: 'runtime/app' });
    boot.end();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    expect(collector.bootTrace()?.spans).toHaveLength(1);
  });

  it('tracks lifecycle state, history and invalid attempts per instance', () => {
    const { telemetry, tick } = clockTelemetry();
    const collector = createDevtoolsCollector({ capacity: { lifecycleHistory: 2 } });
    telemetry.addSink(collector);
    const sub = 'runtime/app' as const;
    telemetry.event('lifecycle.subsystem.idle→starting', { subsystem: sub, attrs: { subsystem: 'router', event: 'start' } });
    tick(5);
    telemetry.event('lifecycle.subsystem.starting→running', { subsystem: sub, attrs: { subsystem: 'router', event: 'started' } });
    telemetry.event('lifecycle.subsystem.running→paused', { subsystem: sub, attrs: { subsystem: 'router', event: 'pause' } });
    telemetry.event('lifecycle.subsystem.idle→starting', { subsystem: sub, attrs: { subsystem: 'data' } });
    telemetry.event('lifecycle.subsystem.invalid', { subsystem: sub, attrs: { subsystem: 'router', state: 'paused', event: 'start' } });
    const router = collector.lifecycles().find((e) => e.instance === 'router');
    expect(router).toMatchObject({ machine: 'subsystem', state: 'paused', transitions: 3, invalid: 1, since: 5 });
    expect(router?.history.map((h) => h.to)).toEqual(['running', 'paused']);
    expect(router?.lastInvalid).toMatchObject({ state: 'paused', event: 'start' });
    expect(collector.lifecycles().map((e) => e.instance)).toEqual(['data', 'router']);
  });

  it('bounds lifecycle instances (LRU)', () => {
    const { telemetry } = clockTelemetry();
    const collector = createDevtoolsCollector({ capacity: { lifecycleInstances: 2 } });
    telemetry.addSink(collector);
    for (const id of ['a', 'b', 'c']) telemetry.event('lifecycle.feature.declared→loading', { subsystem: 'runtime/feature', attrs: { feature: id } });
    expect(collector.lifecycles().map((e) => e.instance)).toEqual(['b', 'c']);
  });

  it('groups violations by code with fix text, attribution and bounded samples', () => {
    const { telemetry, tick } = clockTelemetry();
    const collector = createDevtoolsCollector({ capacity: { violationSamples: 2 } });
    telemetry.addSink(collector);
    reportViolation(telemetry, { code: 'SF-PERF-002', fix: 'Batch reads before writes.', feature: 'studio', severity: 'warning' });
    tick(10);
    reportViolation(telemetry, { code: 'SF-PERF-002', fix: 'Batch reads before writes.', feature: 'chat', unit: 'chat/panel', severity: 'warning' });
    reportViolation(telemetry, { code: 'SF-PERF-002', fix: 'Batch reads before writes.', feature: 'chat', severity: 'warning' });
    telemetry.event('violation', { subsystem: 'messaging/surfaces', level: 'critical', attrs: { code: 'SF-MSG-001', fix: 'Own the surface by a scope.', details: '{"surface":"x"}' } });
    telemetry.event('violation', { subsystem: 'messaging/surfaces', attrs: { fix: 'no code → ignored' } });
    const groups = collector.violations();
    expect(groups).toHaveLength(2);
    const perf = groups.find((g) => g.code === 'SF-PERF-002');
    expect(perf).toMatchObject({ count: 3, severity: 'warning', fix: 'Batch reads before writes.', features: ['studio', 'chat'], units: ['chat/panel'], firstAt: 0, lastAt: 10 });
    expect(perf?.samples).toHaveLength(2);
    expect(groups.find((g) => g.code === 'SF-MSG-001')).toMatchObject({ severity: 'error', subsystems: ['messaging/surfaces'] });
    expect(groups.find((g) => g.code === 'SF-MSG-001')?.samples[0]?.details).toBe('{"surface":"x"}');
    expect(collector.violationCount()).toBe(4);
  });

  it('records gate decision events unless a bound gate is preferred', () => {
    const { telemetry } = clockTelemetry();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    telemetry.event('gate.decision-changed', {
      subsystem: 'gate/decisions',
      attrs: { key: 'route:/studio:gate/access', subject: 'principal', effect: 'deny', reason: 'login', policies: ['studio/route-requires-login'] },
    });
    expect(collector.decisions()).toEqual([
      expect.objectContaining({ level: 'route', resourceId: '/studio', actionId: 'gate/access', effect: 'deny', reason: 'login', determining: ['studio/route-requires-login'], source: 'event' }),
    ]);
    collector.preferGateDecisions(true);
    const before = collector.revision;
    telemetry.event('gate.decision-changed', { subsystem: 'gate/decisions', attrs: { key: 'route:/x:gate/access', effect: 'allow' } });
    expect(collector.decisions()).toHaveLength(1);
    expect(collector.revision).toBe(before);
  });

  it('keeps latest value + aggregates per metric series', () => {
    const { telemetry, tick } = clockTelemetry();
    const collector = createDevtoolsCollector({ capacity: { metricSeries: 2 } });
    telemetry.addSink(collector);
    const duration = metric.histogram('data/request-duration', { unit: 'ms' });
    telemetry.record(duration, 10, { endpoint: 'docs' });
    tick(1);
    telemetry.record(duration, 30, { endpoint: 'docs' });
    telemetry.record(duration, 5, { endpoint: 'chat' });
    const docs = collector.metrics().find((s) => s.attrs['endpoint'] === 'docs');
    expect(docs).toMatchObject({ metric: 'data/request-duration', kind: 'histogram', unit: 'ms', last: 30, count: 2, sum: 40, min: 10, max: 30, time: 1 });
    telemetry.record(duration, 1, { endpoint: 'third' });
    expect(collector.metrics()).toHaveLength(2);
  });

  it('collects seen subsystems, notifies listeners and clears', () => {
    const { telemetry } = clockTelemetry();
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    let calls = 0;
    const stop = collector.onChange(() => (calls += 1));
    telemetry.event('x.y', { subsystem: 'router/navigation' });
    telemetry.span('s', { subsystem: 'core/di' }).end();
    expect(collector.subsystems()).toEqual(['core/di', 'router/navigation']);
    expect(collector.events().map((e) => e.name)).toEqual(['x.y']);
    expect(calls).toBe(3); // event, span-start, span
    stop();
    collector.clear();
    expect(collector.spans()).toEqual([]);
    expect(collector.violationCount()).toBe(0);
    expect(collector.bootTrace()).toBeUndefined();
    expect(calls).toBe(3);
  });

  it('disabled telemetry produces nothing (zero cost at off)', () => {
    const telemetry = createTelemetry({ defaultLevel: 'off' });
    const collector = createDevtoolsCollector();
    telemetry.addSink(collector);
    telemetry.span('app.boot', { subsystem: 'runtime/app', level: 'critical' }).end();
    telemetry.event('lifecycle.app.a→b', { subsystem: 'runtime/app' });
    expect(collector.revision).toBe(0);
  });
});
