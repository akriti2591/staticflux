import { createMemorySink, createTelemetry } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_FORMAT,
  createConformance,
  createViolationCollector,
  ForcedLayoutViolation,
  parseBaseline,
  RenderStormViolation,
  reportViolation,
  violationAttrs,
  violationKey,
  violationOf,
} from './index.js';

function setup(options: { sampleRate?: number; random?: () => number } = {}) {
  const telemetry = createTelemetry({ random: () => 0.5 });
  const sink = createMemorySink();
  const collector = createViolationCollector();
  telemetry.addSink(sink);
  telemetry.addSink(collector);
  const conformance = createConformance({ telemetry, ...options });
  return { telemetry, sink, collector, conformance };
}

describe('conformance stream (R17.22)', () => {
  it('violationOf fills code, fix and summary from the catalog', () => {
    const v = violationOf(ForcedLayoutViolation, { unit: 'doc-toolbar', details: { api: 'offsetHeight' } });
    expect(v).toEqual({
      code: 'SF-PERF-001',
      fix: ForcedLayoutViolation.fix,
      message: ForcedLayoutViolation.summary,
      unit: 'doc-toolbar',
      details: { api: 'offsetHeight' },
    });
    expect(violationOf(ForcedLayoutViolation, { fix: 'custom', message: 'm' })).toMatchObject({ fix: 'custom', message: 'm' });
    expect(violationAttrs({ code: 'SF-X-1', fix: 'f' })).toEqual({ code: 'SF-X-1', fix: 'f', severity: 'error' });
  });

  it('report emits one typed `violation` event + counter, collected from any subsystem', () => {
    const { conformance, sink, collector, telemetry } = setup();
    const seen: string[] = [];
    const off = conformance.onViolation((v) => seen.push(v.code));
    conformance.report(violationOf(RenderStormViolation, { feature: 'studio', unit: 'canvas', severity: 'warning', details: { renders: 40 } }));
    off();
    conformance.report(violationOf(ForcedLayoutViolation, { unit: 'toolbar' }));
    // Another package emitting the same contract without depending on perf:
    telemetry.event('violation', { subsystem: 'messaging/surfaces', level: 'critical', attrs: { code: 'SF-MSG-001', fix: 'dismiss on scope end', feature: 'billing' } });
    telemetry.event('violation', { subsystem: 'x/y', attrs: { noCode: true } });
    telemetry.event('other', { subsystem: 'x/y', attrs: { code: 'SF-X-1' } });
    expect(seen).toEqual(['SF-PERF-003']);
    const events = sink.records.filter((r) => r.type === 'event' && r.name === 'violation');
    expect(events).toHaveLength(4);
    expect(sink.records.filter((r) => r.type === 'metric' && r.metric === 'perf/violations')).toHaveLength(2);
    expect(collector.violations.map((v) => [v.code, v.feature, v.unit, v.subsystem, v.severity])).toEqual([
      ['SF-PERF-003', 'studio', 'canvas', 'perf/conformance', 'warning'],
      ['SF-PERF-001', undefined, 'toolbar', 'perf/conformance', 'error'],
      ['SF-MSG-001', 'billing', undefined, 'messaging/surfaces', 'error'],
    ]);
    expect(collector.violations[0]?.details).toEqual({ renders: 40 });
  });

  it('sampling drops telemetry but still notifies local listeners', () => {
    const { conformance, collector } = setup({ sampleRate: 0.1, random: () => 0.5 });
    let local = 0;
    conformance.onViolation(() => (local += 1));
    conformance.report(violationOf(ForcedLayoutViolation));
    expect(local).toBe(1);
    expect(collector.violations).toHaveLength(0);
  });

  it('respects telemetry levels (off subsystem → no event)', () => {
    const telemetry = createTelemetry({ levels: { 'perf/conformance': 'off' } });
    const collector = createViolationCollector();
    telemetry.addSink(collector);
    reportViolation(telemetry, violationOf(ForcedLayoutViolation));
    expect(collector.violations).toHaveLength(0);
  });

  it('baselines: CI fails on new violations, reports fixed ones (ratchet)', () => {
    const { conformance, collector } = setup();
    conformance.report(violationOf(ForcedLayoutViolation, { unit: 'toolbar' }));
    conformance.report(violationOf(ForcedLayoutViolation, { unit: 'toolbar' }));
    const baseline = collector.baseline();
    expect(baseline).toEqual({ format: BASELINE_FORMAT, entries: { 'SF-PERF-001||toolbar': 2 } });
    expect(collector.check(baseline).ok).toBe(true);
    conformance.report(violationOf(ForcedLayoutViolation, { unit: 'toolbar' }));
    conformance.report(violationOf(RenderStormViolation, { feature: 'studio', unit: 'canvas' }));
    const comparison = collector.compare({ format: BASELINE_FORMAT, entries: { 'SF-PERF-001||toolbar': 2, 'SF-PERF-004|old|': 1 } });
    expect(comparison.added.map((a) => [a.key, a.count, a.allowed])).toEqual([
      ['SF-PERF-001||toolbar', 3, 2],
      ['SF-PERF-003|studio|canvas', 1, 0],
    ]);
    expect(comparison.fixed).toEqual(['SF-PERF-004|old|']);
    const checked = collector.check(baseline);
    expect(!checked.ok && checked.error.code).toBe('SF-PERF-006');
    expect(violationKey({ code: 'SF-A-1' })).toBe('SF-A-1||');
    collector.clear();
    expect(collector.violations).toHaveLength(0);
  });

  it('parses baselines (SF-PERF-008 on malformed)', () => {
    expect(parseBaseline({ format: BASELINE_FORMAT, entries: { a: 1 } }).ok).toBe(true);
    for (const bad of [null, {}, { format: BASELINE_FORMAT }, { format: BASELINE_FORMAT, entries: { a: 'x' } }, { format: 'v0', entries: {} }]) {
      const r = parseBaseline(bad);
      expect(!r.ok && r.error.code).toBe('SF-PERF-008');
    }
  });

  it('ignores malformed details JSON', () => {
    const { telemetry, collector } = setup();
    telemetry.event('violation', { subsystem: 'x/y', level: 'critical', attrs: { code: 'SF-X-1', details: '{bad' } });
    telemetry.event('violation', { subsystem: 'x/y', level: 'critical', attrs: { code: 'SF-X-2', details: '3' } });
    expect(collector.violations.map((v) => v.details)).toEqual([undefined, undefined]);
    expect(collector.violations[0]?.fix).toBe('');
  });
});
