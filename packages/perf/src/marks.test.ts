import { createMemorySink, createTelemetry, type MetricRecord } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createFeatureMarks, type PerfEntryLike, type PerfEnv } from './index.js';

interface FakeObserver {
  readonly cb: (entries: readonly PerfEntryLike[]) => void;
  readonly types: string[];
  disconnected: boolean;
}

function fakeEnv(supportedEntryTypes: readonly string[] = []) {
  let now = 0;
  let rafs: { cb: (t: number) => void; live: boolean }[] = [];
  const timers: { at: number; cb: () => void; live: boolean }[] = [];
  const observers: FakeObserver[] = [];
  const env: PerfEnv = {
    now: () => now,
    raf(cb) {
      const r = { cb, live: true };
      rafs.push(r);
      return () => {
        r.live = false;
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
      const o: FakeObserver = { cb, types: [], disconnected: false };
      observers.push(o);
      return {
        observe: (opts) => o.types.push(opts.type),
        disconnect: () => {
          o.disconnected = true;
        },
      };
    },
    supportedEntryTypes,
  };
  return {
    env,
    observers,
    /** Advance the clock to `at` and run queued rAF callbacks. */
    frame(at: number) {
      now = at;
      const due = rafs;
      rafs = [];
      for (const r of due) if (r.live) r.cb(at);
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
    set(at: number) {
      now = at;
    },
  };
}

function setup(types: readonly string[] = []) {
  const fake = fakeEnv(types);
  const telemetry = createTelemetry({ random: () => 0.5 });
  const sink = createMemorySink();
  telemetry.addSink(sink);
  const marks = createFeatureMarks({ env: fake.env, telemetry, layoutStableMs: 100 });
  const metrics = () => sink.records.filter((r): r is MetricRecord => r.type === 'metric').map((r) => [r.metric, r.attrs['feature'], r.attrs['method'], r.value]);
  return { ...fake, marks, sink, metrics };
}

const el = (width: number, height: number) => {
  const attrs: Record<string, string> = {};
  return { attrs, getBoundingClientRect: () => ({ width, height }), setAttribute: (n: string, v: string) => (attrs[n] = v) };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('feature marks (framework defaults)', () => {
  it('placeholder/first-render on commit + next frame; interactive when deps resolved; complete after a layout-stable window', async () => {
    const { marks, frame, advance, metrics, set } = setup();
    marks.start('studio');
    set(5);
    marks.placeholderCommitted('studio');
    frame(16);
    let resolveDoc!: () => void;
    marks.track('studio', new Promise<void>((r) => (resolveDoc = r)));
    set(100);
    marks.renderCommitted('studio', el(100, 100));
    marks.renderCommitted('studio', el(400, 300));
    frame(116);
    expect(marks.marks('studio')['first-render']).toEqual({ at: 116, method: 'commit+frame' });
    expect(marks.marks('studio').interactive).toBeUndefined();
    set(130);
    marks.renderDepsResolved('studio');
    expect(marks.marks('studio').interactive).toEqual({ at: 130, method: 'framework-default' });
    advance(500);
    expect(marks.marks('studio').complete).toBeUndefined(); // resource still pending
    resolveDoc();
    await flush();
    advance(50);
    marks.layoutShift('studio'); // restarts window
    advance(60);
    expect(marks.marks('studio').complete).toBeUndefined();
    advance(40);
    expect(marks.marks('studio').complete?.method).toBe('framework-default');
    expect(marks.marks('studio')['largest-render']).toEqual({ at: 116, method: 'largest-heuristic' });
    expect(metrics()).toEqual([
      ['feature/placeholder-shown', 'studio', 'commit+frame', 16],
      ['feature/first-render', 'studio', 'commit+frame', 116],
      ['feature/interactive', 'studio', 'framework-default', 130],
      ['feature/complete', 'studio', 'framework-default', 780],
      ['feature/largest-render', 'studio', 'largest-heuristic', 116],
    ]);
  });

  it('marks are recorded once per mount; start() resets and cancels pending frames', () => {
    const { marks, frame } = setup();
    marks.renderCommitted('settings');
    frame(10);
    marks.renderCommitted('settings');
    frame(20);
    expect(marks.marks('settings')['first-render']?.at).toBe(10);
    marks.renderCommitted('settings');
    marks.start('settings');
    frame(30);
    expect(marks.marks('settings')['first-render']).toBeUndefined();
    marks.renderCommitted('settings');
    frame(40);
    expect(marks.marks('settings')['first-render']?.at).toBe(40);
    expect(marks.marks('unknown')).toEqual({});
  });

  it('feature-declared readiness replaces framework defaults (R17.20)', () => {
    const { marks, frame, advance, set } = setup();
    marks.declare('agent-chat', { interactive: 'feature', complete: 'feature', firstRender: 'feature' });
    marks.renderCommitted('agent-chat');
    marks.renderDepsResolved('agent-chat');
    frame(10);
    advance(1_000);
    expect(marks.marks('agent-chat')).toEqual({});
    set(50);
    marks.signal('agent-chat', 'first-render');
    set(60);
    marks.signal('agent-chat', 'interactive');
    set(90);
    marks.signal('agent-chat', 'complete');
    expect(marks.marks('agent-chat')).toEqual({
      'first-render': { at: 50, method: 'readiness-signal' },
      interactive: { at: 60, method: 'readiness-signal' },
      complete: { at: 90, method: 'readiness-signal' },
    });
  });

  it('interactive signalled by the feature still lets the framework derive complete', () => {
    const { marks, frame, advance } = setup();
    marks.declare('onboarding', { interactive: 'feature' });
    marks.renderCommitted('onboarding');
    frame(10);
    marks.renderDepsResolved('onboarding');
    expect(marks.marks('onboarding').interactive).toBeUndefined();
    marks.signal('onboarding', 'interactive');
    advance(100);
    expect(marks.marks('onboarding').complete).toBeDefined();
  });

  it('uses Element Timing where supported (method element-timing beats the heuristic)', () => {
    const { marks, frame, advance, observers } = setup(['element']);
    const element = el(800, 600);
    marks.renderCommitted('studio', element);
    expect(element.attrs['elementtiming']).toBe('sf:studio');
    expect(observers[0]?.types).toEqual(['element']);
    observers[0]?.cb([
      { entryType: 'element', name: 'image-paint', startTime: 0, duration: 0, identifier: 'sf:studio', renderTime: 0, loadTime: 70, intersectionRect: { width: 10, height: 10 } } as PerfEntryLike,
      { entryType: 'element', name: 'image-paint', startTime: 0, duration: 0, identifier: 'sf:other', renderTime: 5, loadTime: 0 } as PerfEntryLike,
    ]);
    frame(20);
    marks.renderDepsResolved('studio');
    advance(100);
    expect(marks.marks('studio')['largest-render']).toEqual({ at: 70, method: 'element-timing' });
    observers[0]?.cb([{ entryType: 'element', name: 'x', startTime: 0, duration: 0, identifier: 'sf:studio', renderTime: 0, loadTime: 0 } as PerfEntryLike]);
    marks.dispose();
    expect(observers[0]?.disconnected).toBe(true);
  });

  it('dispose stops recording', () => {
    const { marks, frame, metrics } = setup();
    marks.renderCommitted('studio');
    marks.dispose();
    frame(10);
    marks.signal('studio', 'complete');
    expect(metrics()).toEqual([]);
  });

  it('a resource rejection also counts as settled', async () => {
    const { marks, frame, advance } = setup();
    marks.track('billing', Promise.reject(new Error('x')));
    marks.renderCommitted('billing');
    frame(10);
    marks.renderDepsResolved('billing');
    await flush();
    advance(100);
    expect(marks.marks('billing').complete).toBeDefined();
  });
});
