import { createMemorySink, createScope, createTelemetry, type MetricRecord, type Telemetry } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  createConformance,
  createForcedLayoutDetector,
  createInputLatencyTracker,
  createLayoutShiftTracker,
  createLongFrameDetector,
  createMemorySampler,
  createRenderCounter,
  createViolationCollector,
  defaultHeapRead,
  featureOfNode,
  type PerfEntryLike,
  type PerfEnv,
} from './index.js';

interface FakeObserver {
  readonly cb: (entries: readonly PerfEntryLike[]) => void;
  readonly options: { type: string; durationThreshold?: number }[];
  disconnected: boolean;
}

function fakeEnv(supportedEntryTypes: readonly string[] = []) {
  let now = 0;
  let rafs: ((t: number) => void)[] = [];
  const timers: { at: number; cb: () => void; live: boolean }[] = [];
  const observers: FakeObserver[] = [];
  const env: PerfEnv = {
    now: () => now,
    raf(cb) {
      rafs.push(cb);
      return () => {
        rafs = rafs.filter((r) => r !== cb);
      };
    },
    timer(cb, ms) {
      const t = { at: now + ms, cb, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    observer(cb) {
      const o: FakeObserver = { cb, options: [], disconnected: false };
      observers.push(o);
      return { observe: (opts) => o.options.push({ ...opts }), disconnect: () => (o.disconnected = true) };
    },
    supportedEntryTypes,
  };
  return {
    env,
    observers,
    frame(at: number) {
      now = at;
      const due = rafs;
      rafs = [];
      for (const r of due) r(at);
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers) {
        if (t.live && t.at <= now) {
          t.live = false;
          t.cb();
        }
      }
    },
  };
}

function telemetrySetup(levels: Parameters<typeof createTelemetry>[0] = {}) {
  const telemetry = createTelemetry({ random: () => 0.5, ...levels });
  const sink = createMemorySink();
  const collector = createViolationCollector();
  telemetry.addSink(sink);
  telemetry.addSink(collector);
  const conformance = createConformance({ telemetry });
  const metrics = (id: string): MetricRecord[] => sink.records.filter((r): r is MetricRecord => r.type === 'metric' && r.metric === id);
  return { telemetry, sink, collector, conformance, metrics };
}

describe('long frame detector', () => {
  it('prefers LoAF, attributes the longest script to a chunk/feature, reports budget violations', () => {
    const fake = fakeEnv(['long-animation-frame', 'longtask']);
    const { telemetry, conformance, collector, metrics } = telemetrySetup();
    const detector = createLongFrameDetector({
      env: fake.env,
      telemetry,
      conformance,
      budgetMs: 100,
      attribute: (url) => (url.endsWith('studio.js') ? 'feature:studio-desktop' : url.endsWith('lib.js') ? 'lib:pdf' : undefined),
    });
    expect(detector.mode).toBe('long-animation-frame');
    expect(fake.observers[0]?.options[0]?.type).toBe('long-animation-frame');
    const seen: string[] = [];
    detector.onReport((r) => seen.push(r.chunk ?? '-'));
    fake.observers[0]?.cb([
      { entryType: 'long-animation-frame', name: 'f', startTime: 10, duration: 120, blockingDuration: 70, scripts: [{ sourceURL: '/a/lib.js', duration: 5 }, { sourceURL: '/a/studio.js', duration: 90, forcedStyleAndLayoutDuration: 12, invoker: 'click' }] } as PerfEntryLike,
      { entryType: 'long-animation-frame', name: 'f', startTime: 300, duration: 60, scripts: [{ sourceURL: '/a/lib.js', duration: 50 }] } as PerfEntryLike,
      { entryType: 'long-animation-frame', name: 'f', startTime: 400, duration: 55, scripts: [{ sourceURL: '' }] } as PerfEntryLike,
    ]);
    expect(detector.reports.map((r) => [r.chunk, r.feature, r.blockingMs, r.forcedLayoutMs])).toEqual([
      ['feature:studio-desktop', 'studio-desktop', 70, 12],
      ['lib:pdf', undefined, 10, 0],
      [undefined, undefined, 5, 0],
    ]);
    expect(seen).toEqual(['feature:studio-desktop', 'lib:pdf', '-']);
    expect(metrics('perf/long-frame')).toHaveLength(3);
    expect(collector.violations.map((v) => [v.code, v.feature, v.unit, v.severity])).toEqual([['SF-PERF-005', 'studio-desktop', 'feature:studio-desktop', 'warning']]);
    detector.dispose();
    expect(fake.observers[0]?.disconnected).toBe(true);
  });

  it('falls back to Long Tasks, then none (Safari); dormant when telemetry is off', () => {
    const lt = createLongFrameDetector({ env: fakeEnv(['longtask']).env, telemetry: telemetrySetup().telemetry });
    expect(lt.mode).toBe('longtask');
    expect(createLongFrameDetector({ env: fakeEnv([]).env, telemetry: telemetrySetup().telemetry }).mode).toBe('none');
    const offEnv = fakeEnv(['long-animation-frame']);
    const off = createLongFrameDetector({ env: offEnv.env, telemetry: telemetrySetup({ levels: { 'perf/frames': 'off' } }).telemetry });
    expect(off.mode).toBe('none');
    expect(offEnv.observers).toHaveLength(0);
    expect(createLongFrameDetector({ env: { ...fakeEnv(['longtask']).env, observer: undefined } }).mode).toBe('none');
    const ltEnv = fakeEnv(['longtask']);
    const plain = createLongFrameDetector({ env: ltEnv.env, telemetry: telemetrySetup().telemetry, limit: 1 });
    ltEnv.observers[0]?.cb([
      { entryType: 'longtask', name: 'self', startTime: 0, duration: 80 },
      { entryType: 'longtask', name: 'self', startTime: 100, duration: 90 },
    ]);
    expect(plain.reports.map((r) => [r.type, r.blockingMs])).toEqual([['longtask', 40]]);
  });
});

describe('forced layout detector (dev)', () => {
  it('reports read-after-write in one frame with reader/writer attribution, once per pair', () => {
    const fake = fakeEnv();
    const { telemetry, conformance, collector, metrics } = telemetrySetup();
    const detector = createForcedLayoutDetector({ env: fake.env, telemetry, conformance });
    expect(detector.read('toolbar', () => 42)).toBe(42);
    expect(detector.count).toBe(0);
    detector.write('canvas');
    detector.read('toolbar', () => 1);
    detector.read('toolbar', () => 1);
    expect(detector.count).toBe(2);
    expect(collector.violations).toHaveLength(1);
    expect(collector.violations[0]).toMatchObject({ code: 'SF-PERF-001', unit: 'toolbar', details: { reader: 'toolbar', writer: 'canvas', api: 'measured-read' } });
    expect(metrics('perf/forced-layout')).toHaveLength(2);
    fake.frame(16);
    detector.read('toolbar', () => 1);
    expect(detector.count).toBe(2);
  });

  it('instruments layout-reading DOM APIs and restores them on scope dispose', async () => {
    const fake = fakeEnv();
    const { conformance, collector } = telemetrySetup();
    const detector = createForcedLayoutDetector({ env: fake.env, conformance });
    class Base {
      get offsetHeight(): number {
        return 10;
      }
    }
    class Fake extends Base {
      getBoundingClientRect(): { width: number } {
        return { width: 5 };
      }
    }
    const proto = Fake.prototype;
    const originalRect = proto.getBoundingClientRect;
    const scope = createScope('dev');
    detector.instrument(proto, scope, () => 'panel');
    const node = new Fake();
    expect(node.getBoundingClientRect()).toEqual({ width: 5 });
    detector.write('editor');
    expect(node.offsetHeight).toBe(10);
    expect(node.getBoundingClientRect().width).toBe(5);
    expect(detector.read('measured', () => node.offsetHeight)).toBe(10);
    expect(detector.count).toBe(3);
    expect(collector.violations.map((v) => v.details?.['api'])).toEqual(['offsetHeight', 'measured-read']);
    await scope.dispose();
    expect(proto.getBoundingClientRect).toBe(originalRect);
    expect(Object.getOwnPropertyDescriptor(proto, 'offsetHeight')).toBeUndefined();
    node.getBoundingClientRect();
    expect(detector.count).toBe(3);
    // default attribution
    const scope2 = createScope('dev2');
    detector.instrument(proto, scope2);
    node.getBoundingClientRect();
    expect(collector.violations.at(-1)?.unit).toBe('unknown');
    await scope2.dispose();
  });
});

describe('layout shift tracker', () => {
  const node = (feature: string | undefined) => ({
    closest: (selector: string) => (feature === undefined || selector !== '[data-sf-feature]' ? null : { getAttribute: () => feature }),
  });

  it('attributes layout-shift entries to feature subtrees, ignores input-driven shifts, flags over threshold once', () => {
    const fake = fakeEnv(['layout-shift']);
    const { telemetry, conformance, collector } = telemetrySetup();
    const tracker = createLayoutShiftTracker({ env: fake.env, telemetry, conformance, threshold: 0.1 });
    expect(tracker.supported).toBe(true);
    const shifts: [string, number][] = [];
    tracker.onShift((f, v) => shifts.push([f, v]));
    fake.observers[0]?.cb([
      { entryType: 'layout-shift', name: '', startTime: 0, duration: 0, value: 0.06, hadRecentInput: false, sources: [{ node: node('studio') }, { node: node('studio') }, { node: node(undefined) }] } as PerfEntryLike,
      { entryType: 'layout-shift', name: '', startTime: 0, duration: 0, value: 0.5, hadRecentInput: true, sources: [{ node: node('studio') }] } as PerfEntryLike,
      { entryType: 'layout-shift', name: '', startTime: 0, duration: 0, value: 0.05, hadRecentInput: false, sources: [{ node: node('studio') }] } as PerfEntryLike,
      { entryType: 'layout-shift', name: '', startTime: 0, duration: 0, value: 0.2, hadRecentInput: false } as PerfEntryLike,
    ]);
    expect(tracker.scoreOf('studio')).toBeCloseTo(0.11);
    expect(shifts).toEqual([
      ['studio', 0.06],
      ['studio', 0.05],
    ]);
    tracker.report('studio', 0.5);
    expect(collector.violations.filter((v) => v.code === 'SF-PERF-004')).toHaveLength(1);
    tracker.reset('studio');
    expect(tracker.scoreOf('studio')).toBe(0);
    tracker.dispose();
    expect(fake.observers[0]?.disconnected).toBe(true);
  });

  it('size-stable placeholder check works everywhere (R12.19)', () => {
    const { conformance, collector } = telemetrySetup();
    const tracker = createLayoutShiftTracker({ env: fakeEnv([]).env, conformance });
    expect(tracker.supported).toBe(false);
    const notified: string[] = [];
    tracker.onShift((f) => notified.push(f));
    expect(tracker.checkPlaceholder('billing', { width: 300, height: 40 }, { width: 300.5, height: 40 })).toBe(true);
    expect(tracker.checkPlaceholder('billing', { width: 300, height: 40 }, { width: 300, height: 120 })).toBe(false);
    expect(collector.violations[0]).toMatchObject({ code: 'SF-PERF-004', feature: 'billing', details: { content: { height: 120 } } });
    expect(notified).toEqual(['billing']);
  });

  it('featureOfNode walks to the nearest [data-sf-feature] (text nodes via parentElement)', () => {
    document.body.innerHTML = '<section data-sf-feature="studio"><p><span id="leaf">x</span></p></section>';
    const leaf = document.getElementById('leaf');
    expect(featureOfNode(leaf)).toBe('studio');
    expect(featureOfNode(leaf?.firstChild)).toBe('studio');
    expect(featureOfNode(document.body)).toBeUndefined();
    expect(featureOfNode(null)).toBeUndefined();
  });
});

describe('render counter', () => {
  it('counts renders, emits per-render metrics only at verbose, reports storms once per window', () => {
    let now = 0;
    const verbose = telemetrySetup({ levels: { 'perf/render': 'verbose' } });
    const counter = createRenderCounter({ now: () => now, telemetry: verbose.telemetry, conformance: verbose.conformance, stormThreshold: 3, windowMs: 100 });
    counter.count('doc-toolbar', 'studio');
    now = 10;
    counter.count('doc-toolbar', 'studio');
    now = 20;
    counter.count('doc-toolbar', 'studio');
    now = 30;
    counter.count('doc-toolbar', 'studio');
    expect(counter.counts().get('doc-toolbar')).toBe(4);
    expect(verbose.metrics('perf/renders')).toHaveLength(4);
    expect(verbose.collector.violations.map((v) => [v.code, v.unit, v.feature])).toEqual([['SF-PERF-003', 'doc-toolbar', 'studio']]);
    now = 500;
    counter.count('doc-toolbar');
    counter.count('doc-toolbar');
    counter.count('doc-toolbar');
    expect(verbose.collector.violations).toHaveLength(2);
    counter.reset();
    expect(counter.counts().size).toBe(0);

    const standard = telemetrySetup();
    const quiet = createRenderCounter({ now: () => 0, telemetry: standard.telemetry });
    quiet.count('x');
    expect(standard.metrics('perf/renders')).toHaveLength(0);
  });
});

describe('input latency', () => {
  it('uses Event Timing where supported (max per interaction)', () => {
    const fake = fakeEnv(['event']);
    const { telemetry, conformance, collector, metrics } = telemetrySetup();
    const tracker = createInputLatencyTracker({ env: fake.env, telemetry, conformance, budgetMs: 200, feature: () => 'studio' });
    expect(tracker.mode).toBe('event-timing');
    expect(fake.observers[0]?.options[0]).toMatchObject({ type: 'event', durationThreshold: 16 });
    fake.observers[0]?.cb([
      { entryType: 'event', name: 'pointerdown', startTime: 0, duration: 40, interactionId: 1 } as PerfEntryLike,
      { entryType: 'event', name: 'click', startTime: 0, duration: 64, interactionId: 1 } as PerfEntryLike,
      { entryType: 'event', name: 'pointerup', startTime: 0, duration: 30, interactionId: 1 } as PerfEntryLike,
      { entryType: 'event', name: 'mousemove', startTime: 0, duration: 300, interactionId: 0 } as PerfEntryLike,
      { entryType: 'event', name: 'keydown', startTime: 0, duration: 250, interactionId: 2 } as PerfEntryLike,
    ]);
    expect(tracker.stats()).toEqual({ count: 2, max: 250, p75: 250, p98: 250 });
    expect(metrics('perf/input-latency')).toHaveLength(2);
    expect(collector.violations.map((v) => [v.code, v.feature])).toEqual([['SF-PERF-007', 'studio']]);
    tracker.track('click', 0); // no-op under Event Timing
    tracker.dispose();
    expect(fake.observers[0]?.disconnected).toBe(true);
  });

  it('falls back to rAF + task (next paint) in Safari', () => {
    const fake = fakeEnv([]);
    const tracker = createInputLatencyTracker({ env: fake.env });
    expect(tracker.mode).toBe('raf');
    tracker.track('click', 0);
    fake.frame(30);
    fake.advance(2);
    tracker.track('keydown', 100);
    fake.frame(120);
    fake.advance(0);
    expect(tracker.stats()).toEqual({ count: 2, max: 32, p75: 32, p98: 32 });
    expect(createInputLatencyTracker({ env: fakeEnv([]).env }).stats()).toEqual({ count: 0, max: 0, p75: 0, p98: 0 });
  });
});

describe('memory sampler', () => {
  it('samples periodically when available; dormant without data or when off', () => {
    const fake = fakeEnv();
    const { telemetry, metrics } = telemetrySetup();
    let bytes: number | undefined = 52_428_800;
    const sampler = createMemorySampler({ env: fake.env, telemetry, read: () => bytes, intervalMs: 1_000 });
    expect(sampler.sample()).toBe(50);
    fake.advance(1_000);
    fake.advance(1_000);
    expect(metrics('perf/memory').map((m) => m.value)).toEqual([50, 50, 50]);
    bytes = undefined;
    expect(sampler.sample()).toBeUndefined();
    sampler.dispose();
    fake.advance(5_000);
    expect(metrics('perf/memory')).toHaveLength(3);
    const off: Telemetry = telemetrySetup({ levels: { 'perf/memory': 'off' } }).telemetry;
    const offEnv = fakeEnv();
    createMemorySampler({ env: offEnv.env, telemetry: off, read: () => 1 });
    expect(typeof defaultHeapRead()).not.toBe('string');
  });
});
