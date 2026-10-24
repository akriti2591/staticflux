import { createInjector, createMemorySink, createTelemetry, err, ok, token, unwrap } from '@staticflux/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushMicrotasks, hostElement, testEnv } from './fakes.test.js';
import {
  absoluteNow,
  acquireContext,
  backingSize,
  type CanvasLike,
  type CompactInputEvent,
  createCanvasSurface,
  createDomSurface,
  createFrameLoop,
  createInputForwarder,
  createSurfaceMetrics,
  defaultSurfaceEnvironment,
  EngineInitError,
  HtmlInCanvasSupportToken,
  htmlInCanvasSupportUnit,
  InputCode,
  InputModifier,
  mapInputToIntents,
  MainThreadOnlyError,
  NO_HTML_IN_CANVAS,
  oldestTimestamp,
  PointerKind,
  rafScheduler,
  type RenderContext,
  type RenderEngine,
  sizeCanvas,
  type Surface,
  SurfaceContextError,
  SurfaceEnvironmentToken,
  surfaceEnvironmentUnit,
  SurfaceImageLoaderToken,
  surfaceImageLoaderUnit,
  SurfaceImagePolicyToken,
  surfaceImagePolicyUnit,
  SurfaceNotAttachedError,
  surfaceUnit,
  supportsOffscreenCanvas,
  supportsWebGpu,
  timerScheduler,
} from './index.js';

// ---------------------------------------------------------------- env

describe('environment', () => {
  it('uses rAF when present, a timer otherwise', async () => {
    expect(rafScheduler({})).toBeUndefined();
    const calls: number[] = [];
    const raf = rafScheduler({ requestAnimationFrame: (cb) => (cb(5), 7), cancelAnimationFrame: (h) => calls.push(h) });
    expect(raf?.kind).toBe('raf');
    let seen = 0;
    const handle = raf?.request((now) => (seen = now));
    raf?.cancel(handle);
    expect(seen).toBe(5);
    expect(calls).toEqual([7]);

    const timer = timerScheduler(1, () => 42);
    const fired = new Promise<number>((resolve) => timer.request(resolve));
    expect(await fired).toBe(42);
    const cancelled = timer.request(() => {
      throw new Error('should not fire');
    });
    timer.cancel(cancelled);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const env = defaultSurfaceEnvironment({}, { performance: { now: () => 3, timeOrigin: 100 }, devicePixelRatio: 3 });
    expect(env.scheduler.kind).toBe('timer');
    expect(env.devicePixelRatio()).toBe(3);
    expect(absoluteNow(env)).toBe(103);
    expect(env.document).toBeUndefined();
    expect(env.resizeObserver).toBeUndefined();
    const withRo = defaultSurfaceEnvironment({}, {
      ResizeObserver: class {
        observe(): void {}
        disconnect(): void {}
      } as never,
    });
    expect(withRo.resizeObserver?.(() => undefined)).toBeDefined();
    expect(defaultSurfaceEnvironment().document).toBe(document);
    expect(defaultSurfaceEnvironment({}, {}).timeOrigin).toBe(0);
  });
});

// ---------------------------------------------------------------- metrics

describe('surface metrics', () => {
  it('counts dropped frames, aggregates per window and reports budget overruns', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const metrics = createSurfaceMetrics({ surfaceId: 's', kind: 'webgl', telemetry, window: 3, targetFrameMs: 16, budget: { frameMs: 8, inputLatencyMs: 20 } });
    metrics.frame(0, 2);
    metrics.frame(16, 4);
    metrics.frame(48, 30); // 2 frames dropped
    metrics.input(10);
    metrics.input(50);
    const snap = metrics.snapshot();
    expect(snap).toMatchObject({ frames: 3, droppedFrames: 2, lastFrameMs: 30, maxFrameMs: 30, lastInputLatencyMs: 50, maxInputLatencyMs: 50, avgInputLatencyMs: 30 });
    expect(snap.avgFrameMs).toBe(12);
    const recorded = sink.records.filter((r) => r.type === 'metric').map((r) => (r.type === 'metric' ? [r.metric, r.value] : []));
    expect(recorded).toContainEqual(['surface/frame-time', 12]);
    expect(recorded).toContainEqual(['surface/frame-time-max', 30]);
    expect(recorded).toContainEqual(['surface/dropped-frames', 2]);
    expect(sink.records.filter((r) => r.type === 'event' && r.name === 'surface.budget-exceeded')).toHaveLength(1);
    metrics.flush(); // inputs only in this window
    expect(recorded.length).toBeLessThan(sink.records.filter((r) => r.type === 'metric').length);
    expect(metrics.snapshot().budgetExceeded).toBe(2);
    metrics.flush(); // empty window: nothing
    metrics.input(-5);
    expect(metrics.snapshot().lastInputLatencyMs).toBe(0);
    expect(createSurfaceMetrics({ surfaceId: 'x', kind: 'dom' }).snapshot().avgInputLatencyMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------- frame loop

describe('frame loop', () => {
  it('runs frames on the scheduler with dt, pauses, resumes and stops', () => {
    const env = testEnv();
    const frames: { frame: number; dt: number }[] = [];
    const metrics = createSurfaceMetrics({ surfaceId: 's', kind: 'canvas2d' });
    const loop = createFrameLoop({ scheduler: env.scheduler, now: env.now, onFrame: (info) => frames.push({ frame: info.frame, dt: info.dt }), metrics });
    expect(loop.state).toBe('idle');
    expect(loop.pause().ok).toBe(false);
    unwrap(loop.start());
    env.frames.tick(16);
    env.frames.tick(32);
    expect(frames).toEqual([
      { frame: 0, dt: 0 },
      { frame: 1, dt: 16 },
    ]);
    unwrap(loop.pause());
    expect(env.frames.pending).toBe(0);
    env.frames.tick(100);
    expect(frames).toHaveLength(2);
    unwrap(loop.resume());
    env.frames.tick(200);
    expect(frames[2]).toEqual({ frame: 2, dt: 0 }); // a pause is not dropped frames
    expect(loop.frames).toBe(3);
    expect(metrics.snapshot().frames).toBe(3);
    loop.stop();
    loop.stop();
    expect(loop.state).toBe('stopped');
    expect(loop.start().ok).toBe(false);
    env.frames.tick(300);
    expect(frames).toHaveLength(3);
  });

  it('keeps running when a frame throws', () => {
    const env = testEnv();
    const errors: unknown[] = [];
    let count = 0;
    const loop = createFrameLoop({
      scheduler: env.scheduler,
      now: env.now,
      onFrame: () => {
        count += 1;
        throw new Error('frame failed');
      },
      onError: (error) => errors.push(error),
    });
    loop.start();
    env.frames.tick(1);
    env.frames.tick(2);
    expect(count).toBe(2);
    expect(errors).toHaveLength(2);
    const silent = createFrameLoop({ scheduler: env.scheduler, now: env.now, onFrame: () => {
      throw new Error('x');
    } });
    silent.start();
    env.frames.tick(3);
    silent.stop();
    loop.stop();
  });
});

// ---------------------------------------------------------------- engine helpers

describe('engine helpers', () => {
  it('acquires contexts with WebGL2 → WebGL fallback and reports missing kinds', () => {
    const asked: string[] = [];
    const canvas: CanvasLike = {
      width: 1,
      height: 1,
      getContext: (id) => {
        asked.push(id);
        return id === 'webgl' ? { gl: 1 } : id === 'webgpu' ? (() => {
          throw new Error('nope');
        })() : null;
      },
    };
    expect(unwrap(acquireContext(canvas, 'webgl'))).toEqual({ gl: 1 });
    expect(asked).toEqual(['webgl2', 'webgl']);
    const gpu = acquireContext(canvas, 'webgpu');
    expect(gpu.ok ? undefined : gpu.error.code).toBe(SurfaceContextError.code);
    expect(acquireContext(canvas, 'canvas2d').ok).toBe(false);
  });

  it('detects OffscreenCanvas transfer and WebGPU; sizes backing stores by DPR', () => {
    expect(supportsOffscreenCanvas({})).toBe(false);
    expect(supportsOffscreenCanvas({ OffscreenCanvas: function OffscreenCanvas() {}, HTMLCanvasElement: { prototype: { transferControlToOffscreen() {} } } })).toBe(true);
    expect(supportsOffscreenCanvas({ OffscreenCanvas: function OffscreenCanvas() {}, HTMLCanvasElement: { prototype: {} } })).toBe(false);
    expect(supportsWebGpu({ navigator: { gpu: {} } })).toBe(true);
    expect(supportsWebGpu({ navigator: {} })).toBe(false);
    expect(backingSize({ width: 100.4, height: 0, dpr: 2 })).toEqual({ width: 201, height: 1 });
    const canvas = { width: 0, height: 0, style: document.createElement('canvas').style };
    sizeCanvas(canvas, { width: 50, height: 20, dpr: 1.5 });
    expect(canvas).toMatchObject({ width: 75, height: 30 });
    expect(canvas.style.width).toBe('50px');
    sizeCanvas({ width: 75, height: 30 }, { width: 50, height: 20, dpr: 1.5 });
  });
});

// ---------------------------------------------------------------- input

describe('input forwarding', () => {
  function pointer(type: string, init: Record<string, unknown>): Event {
    const event = new Event(type);
    for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value });
    return event;
  }

  it('encodes pointer, wheel and key events with absolute timestamps and surface-relative coordinates', async () => {
    const env = testEnv({ timeOrigin: 5000 });
    const target = hostElement();
    const batches: (readonly CompactInputEvent[])[] = [];
    const forwarder = createInputForwarder({ target, env, sink: (batch) => batches.push(batch), captureWheel: true });
    target.dispatchEvent(pointer('pointerdown', { clientX: 15, clientY: 30, buttons: 1, pointerId: 3, pointerType: 'pen', shiftKey: true, timeStamp: 12 }));
    const wheel = pointer('wheel', { clientX: 10, clientY: 20, deltaX: 1, deltaY: 2, deltaMode: 1, ctrlKey: true, timeStamp: 13 });
    target.dispatchEvent(wheel);
    target.dispatchEvent(pointer('keydown', { key: 'a', code: 'KeyA', metaKey: true, altKey: true, timeStamp: 14 }));
    target.dispatchEvent(pointer('keyup', { key: 'a', code: 'KeyA', timeStamp: 0 }));
    target.dispatchEvent(pointer('pointerup', { clientX: 10, clientY: 20, pointerType: 'touch', timeStamp: 15 }));
    target.dispatchEvent(pointer('pointercancel', { pointerType: 'mouse', timeStamp: 16 }));
    target.dispatchEvent(pointer('wheel', { deltaY: 1, deltaMode: 2 }));
    expect(batches).toHaveLength(0);
    await flushMicrotasks();
    expect(batches).toHaveLength(1);
    const [down, wheelEvent, key, keyUp, up, cancel, pageWheel] = batches[0] as CompactInputEvent[];
    expect(down).toEqual({ t: InputCode.pointerDown, ts: 5012, x: 5, y: 10, b: 1, m: InputModifier.shift, p: 3, k: PointerKind.pen });
    expect(wheelEvent).toMatchObject({ t: InputCode.wheel, ts: 5013, dx: 16, dy: 32, m: InputModifier.ctrl });
    expect(wheel.defaultPrevented).toBe(false); // Event not cancelable; preventDefault was still called
    expect(key).toMatchObject({ t: InputCode.keyDown, key: 'a', code: 'KeyA', m: InputModifier.alt | InputModifier.meta });
    expect(keyUp?.t).toBe(InputCode.keyUp);
    expect(keyUp?.ts).toBe(5000); // no timeStamp → env.now()
    expect(up).toMatchObject({ t: InputCode.pointerUp, k: PointerKind.touch });
    expect(cancel).toMatchObject({ t: InputCode.pointerCancel, k: PointerKind.mouse });
    expect(pageWheel?.dy).toBe(800);
    expect(forwarder.forwarded).toBe(7);
    forwarder.dispose();
    forwarder.dispose();
    target.dispatchEvent(pointer('pointerdown', {}));
    await flushMicrotasks();
    expect(batches).toHaveLength(1);
  });

  it('coalesces pointer moves per pointer, keeping the oldest timestamp', () => {
    const env = testEnv();
    const target = hostElement();
    const batches: (readonly CompactInputEvent[])[] = [];
    let scheduled: (() => void) | undefined;
    const forwarder = createInputForwarder({ target, env, sink: (batch) => batches.push(batch), schedule: (fn) => (scheduled = fn) });
    for (let i = 1; i <= 3; i += 1) target.dispatchEvent(pointer('pointermove', { clientX: 10 + i, clientY: 20, pointerId: 1, timeStamp: i }));
    target.dispatchEvent(pointer('pointermove', { clientX: 50, clientY: 20, pointerId: 2, timeStamp: 4 }));
    scheduled?.();
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]).toMatchObject({ x: 3, ts: 1001, n: 3 });
    forwarder.flush(); // nothing queued
    expect(batches).toHaveLength(1);
    const raw = createInputForwarder({ target, env, sink: (batch) => batches.push(batch), coalesce: false, schedule: () => undefined });
    target.dispatchEvent(pointer('pointermove', { pointerId: 1 }));
    target.dispatchEvent(pointer('pointermove', { pointerId: 1 }));
    raw.flush();
    expect(batches[1]).toHaveLength(2);
    raw.dispose();
    forwarder.dispose();
  });

  it('maps input to intents and finds the oldest timestamp', () => {
    const events: CompactInputEvent[] = [
      { t: InputCode.pointerDown, ts: 30, x: 1, y: 2, b: 1, m: 0 },
      { t: InputCode.pointerMove, ts: 10, x: 1, y: 2, b: 1, m: 0 },
      { t: InputCode.keyDown, ts: 20, x: 0, y: 0, b: 0, m: 0, key: 'Delete' },
    ];
    const intents = mapInputToIntents(
      events,
      (event, context) =>
        event.t === InputCode.pointerDown
          ? { action: 'select', at: [event.x, event.y], surface: context.surfaceId }
          : event.key === 'Delete'
            ? [{ action: 'remove' }, { action: 'announce' }]
            : undefined,
      { surfaceId: 'canvas', size: { width: 1, height: 1, dpr: 1 } },
    );
    expect(intents).toEqual([{ action: 'select', at: [1, 2], surface: 'canvas' }, { action: 'remove' }, { action: 'announce' }]);
    expect(oldestTimestamp(events)).toBe(10);
    expect(oldestTimestamp([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------- canvas surface

interface FakeEngine extends RenderEngine<{ value: number }, 'canvas2d'> {
  readonly calls: string[];
  readonly frames: { state: { value: number }; dt: number }[];
  readonly inputs: CompactInputEvent[];
  context: RenderContext<'canvas2d'> | undefined;
}

function fakeEngine(init: () => ReturnType<RenderEngine['init']> = () => ok()): FakeEngine {
  const engine: FakeEngine = {
    calls: [],
    frames: [],
    inputs: [],
    context: undefined,
    init(context) {
      engine.context = context;
      engine.calls.push(`init:${context.size.width}x${context.size.height}@${context.size.dpr}`);
      return init();
    },
    frame(state, dt) {
      engine.frames.push({ state, dt });
    },
    resize(size) {
      engine.calls.push(`resize:${size.width}x${size.height}@${size.dpr}`);
    },
    input(events) {
      engine.inputs.push(...events);
    },
    dispose() {
      engine.calls.push('dispose');
    },
  };
  return engine;
}

describe('canvas surface (main thread)', () => {
  const contexts = new Map<string, unknown>([['2d', { kind: '2d', getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }) }]]);
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((id: string) => contexts.get(id) ?? null) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('attaches a DPR-sized canvas, inits the engine, runs frames with state and resizes', async () => {
    const env = testEnv({ dpr: 2 });
    const engine = fakeEngine();
    let value = 1;
    const surface = createCanvasSurface({ id: 'studio/canvas', kind: 'canvas2d', engine: () => engine, state: () => ({ value }), env, label: 'Page canvas' });
    const states: string[] = [];
    surface.machine.onTransition((r) => states.push(r.to));
    expect(surface.start().ok ? undefined : surface.start()).toMatchObject({ error: { code: SurfaceNotAttachedError.code } });
    const host = hostElement(300, 150);
    unwrap(await surface.attach(host));
    expect(states).toEqual(['attaching', 'attached', 'running']);
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    expect(surface.element).toBe(canvas);
    expect(canvas.getAttribute('aria-label')).toBe('Page canvas');
    expect([canvas.width, canvas.height, canvas.style.width]).toEqual([600, 300, '300px']);
    expect(canvas.tabIndex).toBe(0);
    expect(engine.calls).toEqual(['init:300x150@2', 'resize:300x150@2']);
    expect(engine.context).toMatchObject({ surfaceId: 'studio/canvas', kind: 'canvas2d', thread: 'main' });
    expect(surface.thread).toBe('main');

    env.frames.tick(16);
    value = 2;
    env.frames.tick(32);
    expect(engine.frames).toEqual([
      { state: { value: 1 }, dt: 0 },
      { state: { value: 2 }, dt: 16 },
    ]);
    expect(surface.metrics().frames).toBe(2);

    env.ro.resize(400, 200);
    expect([canvas.width, canvas.height]).toEqual([800, 400]);
    env.ro.resize(400, 200); // unchanged → no resize call
    surface.resize({ width: 400, height: 200 }, 3);
    expect(engine.calls.slice(2)).toEqual(['resize:400x200@2', 'resize:400x200@3']);
    expect(surface.size).toEqual({ width: 400, height: 200, dpr: 3 });
    surface.resize(); // re-measure host (300x150) at the current DPR
    expect(surface.size).toEqual({ width: 300, height: 150, dpr: 2 });

    unwrap(surface.pause());
    unwrap(surface.pause());
    env.frames.tick(48);
    expect(engine.frames).toHaveLength(2);
    unwrap(surface.start());
    unwrap(surface.start());
    env.frames.tick(64);
    expect(engine.frames).toHaveLength(3);

    await surface.detach();
    expect(surface.state).toBe('detached');
    expect(host.querySelector('canvas')).toBeNull();
    expect(engine.calls.at(-1)).toBe('dispose');
    expect(env.ro.disconnected).toBe(1);
    expect(surface.pause().ok).toBe(false);
    surface.resize({ width: 1, height: 1 }); // no host: ignored

    // Re-attach creates a fresh canvas and engine.
    unwrap(await surface.attach(host, { autoStart: false, size: { width: 100, height: 50 } }));
    expect(surface.state).toBe('attached');
    expect((host.querySelector('canvas') as HTMLCanvasElement).width).toBe(200);
    await surface.dispose();
    expect(surface.state).toBe('disposed');
    await surface.dispose();
    expect((await surface.attach(host)).ok).toBe(false);
  });

  it('turns forwarded input into engine input, intents and input-to-frame latency', async () => {
    const env = testEnv({ timeOrigin: 1000 });
    const engine = fakeEngine();
    const intents: unknown[] = [];
    const surface = createCanvasSurface({
      id: 'studio/input',
      kind: 'canvas2d',
      engine: () => engine,
      state: () => ({ value: 0 }),
      env,
      input: {
        mapper: (event) => (event.t === InputCode.pointerDown ? { action: 'select', x: event.x } : undefined),
        onIntents: (batch) => intents.push(...batch),
        keyboard: false,
        captureWheel: true,
      },
    });
    const host = hostElement();
    unwrap(await surface.attach(host));
    const canvas = surface.element as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    expect(canvas.hasAttribute('tabindex')).toBe(false);
    env.clock.time = 10;
    const down = new Event('pointerdown');
    Object.defineProperties(down, { clientX: { value: 7 }, clientY: { value: 8 }, timeStamp: { value: 10 } });
    canvas.dispatchEvent(down);
    await flushMicrotasks();
    env.frames.tick(25);
    expect(engine.inputs).toHaveLength(1);
    expect(intents).toEqual([{ action: 'select', x: 7 }]);
    expect(surface.metrics().lastInputLatencyMs).toBe(15);
    canvas.dispatchEvent(new Event('pointermove'));
    await flushMicrotasks();
    env.frames.tick(30);
    expect(intents).toHaveLength(1); // mapped to nothing
    await surface.dispose();
  });

  it('fails attach with typed errors and cleans up (missing context, engine init, no document)', async () => {
    const env = testEnv();
    const webgl = createCanvasSurface({ id: 's/gl', kind: 'webgl', engine: () => fakeEngine() as never, state: () => ({ value: 0 }), env });
    const host = hostElement();
    const noContext = await webgl.attach(host);
    expect(noContext.ok ? undefined : noContext.error.code).toBe(SurfaceContextError.code);
    expect(webgl.state).toBe('failed');
    expect(host.querySelector('canvas')).toBeNull();

    const engine = fakeEngine(() => err(SurfaceContextError({ message: 'no adapter' })));
    const failing = createCanvasSurface({ id: 's/fail', kind: 'canvas2d', engine: () => engine, state: () => ({ value: 0 }), env });
    const initFailed = await failing.attach(host);
    expect(initFailed.ok ? undefined : initFailed.error.code).toBe(EngineInitError.code);
    expect(engine.calls).toContain('dispose');

    const throwing = createCanvasSurface({
      id: 's/throw',
      kind: 'canvas2d',
      engine: () => fakeEngine(() => {
        throw new Error('boom');
      }),
      state: () => ({ value: 0 }),
      env,
    });
    expect((await throwing.attach(host)).ok).toBe(false);

    const worker = createCanvasSurface({ id: 's/worker', kind: 'canvas2d', engine: () => fakeEngine(), state: () => ({ value: 0 }), env: testEnv({ document: undefined }) });
    const noDom = await worker.attach(host);
    expect(noDom.ok ? undefined : noDom.error.code).toBe(MainThreadOnlyError.code);

    // Retry after failure works (failed → attaching).
    contexts.set('webgl', { gl: true });
    expect((await webgl.attach(host)).ok).toBe(true);
    contexts.delete('webgl');
    await webgl.dispose();
  });

  it('handles detach/dispose while attaching and attach aborts', async () => {
    const env = testEnv();
    let release: () => void = () => undefined;
    const slow = fakeEngine(() => new Promise((resolve) => (release = () => resolve(ok()))));
    const surface = createCanvasSurface({ id: 's/slow', kind: 'canvas2d', engine: () => slow, state: () => ({ value: 0 }), env });
    const host = hostElement();
    const attaching = surface.attach(host);
    await flushMicrotasks();
    await surface.detach();
    release();
    const result = await attaching;
    expect(result.ok ? undefined : result.error.kind).toBe('aborted');
    expect(surface.state).toBe('detached');
    expect(host.querySelector('canvas')).toBeNull();

    const slow2 = fakeEngine(() => new Promise((resolve) => (release = () => resolve(ok()))));
    const disposing = createCanvasSurface({ id: 's/slow2', kind: 'canvas2d', engine: () => slow2, state: () => ({ value: 0 }), env });
    const pending = disposing.attach(host);
    await flushMicrotasks();
    await disposing.dispose();
    release();
    expect((await pending).ok).toBe(false);
    expect(disposing.state).toBe('disposed');

    const controller = new AbortController();
    const slow3 = fakeEngine(() => new Promise((resolve) => (release = () => resolve(ok()))));
    const aborted = createCanvasSurface({ id: 's/slow3', kind: 'canvas2d', engine: () => slow3, state: () => ({ value: 0 }), env });
    const abortedAttach = aborted.attach(host, { signal: controller.signal });
    await flushMicrotasks();
    controller.abort();
    release();
    const abortedResult = await abortedAttach;
    expect(abortedResult.ok ? undefined : abortedResult.error.kind).toBe('aborted');
    expect(aborted.state).toBe('failed');
  });

  it('gives html-in-canvas engines the adapter (overlay fallback) and reports frame errors', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const env = testEnv();
    let adapterMode: string | undefined;
    const surface = createCanvasSurface({
      id: 's/html',
      kind: 'html-in-canvas',
      engine: () => ({
        init: (context) => {
          adapterMode = context.htmlInCanvas?.mode;
          return ok();
        },
        frame: () => {
          throw new Error('draw failed');
        },
        resize: () => undefined,
        dispose: () => undefined,
      }),
      state: () => undefined,
      env,
      telemetry,
      input: false,
      htmlInCanvasSupport: NO_HTML_IN_CANVAS,
    });
    const host = hostElement();
    unwrap(await surface.attach(host));
    expect(adapterMode).toBe('overlay');
    env.frames.tick(1);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'surface.frame-error')).toBe(true);
    await surface.dispose();

    const noDoc = createCanvasSurface({ id: 's/html2', kind: 'html-in-canvas', engine: () => fakeEngine() as never, state: () => undefined, env });
    vi.spyOn(document, 'createElement'); // still main thread: adapter creation works
    expect((await noDoc.attach(host)).ok).toBe(true);
    await noDoc.dispose();
  });
});

// ---------------------------------------------------------------- DOM surface

describe('DOM surface', () => {
  it('mounts, updates per frame when asked, resizes and unmounts', async () => {
    const env = testEnv();
    const calls: string[] = [];
    let state = 'a';
    const surface = createDomSurface<string>({
      id: 'studio/panel',
      mount: (container) => {
        container.textContent = 'mounted';
        calls.push('mount');
        return ok();
      },
      update: (value, dt) => calls.push(`update:${value}:${dt}`),
      state: () => state,
      unmount: () => calls.push('unmount'),
      onResize: (size) => calls.push(`resize:${size.width}`),
      env,
    });
    const host = hostElement(120, 40);
    unwrap(await surface.attach(host));
    expect(surface.kind).toBe('dom');
    expect(host.querySelector('[data-sf-surface="studio/panel"]')?.textContent).toBe('mounted');
    env.frames.tick(5);
    state = 'b';
    env.frames.tick(10);
    surface.pause();
    surface.start();
    await surface.detach();
    expect(calls).toEqual(['mount', 'resize:120', 'update:a:0', 'update:b:5', 'unmount']);
    expect(surface.metrics().frames).toBe(2);
  });

  it('reports mount failures and needs a document', async () => {
    const env = testEnv();
    const failing = createDomSurface({ id: 's/dom-fail', mount: () => err(SurfaceContextError()), env });
    expect((await failing.attach(hostElement())).ok).toBe(false);
    const throwing = createDomSurface({
      id: 's/dom-throw',
      mount: () => {
        throw new Error('x');
      },
      env,
    });
    expect((await throwing.attach(hostElement())).ok).toBe(false);
    const static_ = createDomSurface({ id: 's/static', mount: () => ok(), env });
    unwrap(await static_.attach(hostElement()));
    static_.pause();
    await static_.dispose();
    const worker = createDomSurface({ id: 's/dom-worker', mount: () => ok(), env: testEnv({ document: undefined }) });
    expect((await worker.attach(hostElement())).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- units

describe('units', () => {
  it('provides environment, image policy/loader, HTML-in-Canvas facts and scoped surfaces', async () => {
    vi.stubGlobal('fetch', undefined); // no network in tests: the loader reports missing ports
    const SurfaceToken = token('test/surface').type<Surface>();
    let created: Surface | undefined;
    const injector = createInjector({
      units: [
        surfaceEnvironmentUnit({ devicePixelRatio: () => 4 }),
        surfaceImagePolicyUnit(),
        surfaceImageLoaderUnit(),
        htmlInCanvasSupportUnit(),
        surfaceUnit({
          id: 'test/surface-unit',
          provides: SurfaceToken,
          scope: 'app',
          create: (env) => (created = createDomSurface({ id: 'test/dom', mount: () => ok(), env })),
        }),
      ],
    });
    expect(unwrap(await injector.get(SurfaceEnvironmentToken)).devicePixelRatio()).toBe(4);
    expect(unwrap(await injector.get(SurfaceImagePolicyToken)).crossOriginFor('https://x.test/a.png')).toBe('anonymous');
    const loader = unwrap(await injector.get(SurfaceImageLoaderToken));
    const loaded = await loader.load('/a.png');
    expect(loaded.ok).toBe(false); // happy-dom has no createImageBitmap
    expect(unwrap(await injector.get(HtmlInCanvasSupportToken)).native).toBe(false);
    const surface = unwrap(await injector.get(SurfaceToken));
    expect(surface).toBe(created);
    unwrap(await surface.attach(hostElement()));
    await injector.dispose();
    expect(surface.state).toBe('disposed');
    vi.unstubAllGlobals();
  });

  it('uses explicit image ports', async () => {
    const injector = createInjector({
      units: [
        surfaceImagePolicyUnit({ crossOriginFor: () => 'use-credentials' }),
        surfaceImageLoaderUnit({
          ports: {
            origin: 'https://app.test',
            fetch: () => Promise.resolve({ ok: true, status: 200, type: 'cors', blob: () => Promise.resolve(new Blob()) }),
            decode: () => Promise.resolve({ width: 1, height: 1 } as ImageBitmap),
          },
        }),
      ],
    });
    const loader = unwrap(await injector.get(SurfaceImageLoaderToken));
    expect(unwrap(await loader.load('https://cdn.test/a.png')).width).toBe(1);
    await injector.dispose();
  });
});
