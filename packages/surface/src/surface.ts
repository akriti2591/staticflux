/**
 * The `Surface` contract (R11.20) and the main-thread surfaces:
 *
 * - `createCanvasSurface` — canvas2d / webgl / webgpu / html-in-canvas rendered on the
 *   main thread by a `RenderEngine` (also the fallback when OffscreenCanvas is missing);
 * - `createDomSurface` — DOM (Lit) content behind the same lifecycle.
 *
 * Render-worker surfaces (`createWorkerSurface`) live in render-worker.ts.
 *
 * Lifecycle (`surface/lifecycle`):
 *   created → attaching → attached ⇄ running;  attaching → failed;  attached|running|attaching → detached;
 *   detached|failed → attaching (re-attach);  * → disposed.
 */
import {
  AbortedError,
  anySignal,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  type Machine,
  ok,
  type Result,
  type SfError,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import {
  acquireContext,
  backingSize,
  type CanvasSurfaceKind,
  type RenderContext,
  type RenderEngine,
  type RenderEngineFactory,
  type SurfaceKind,
  type SurfaceSize,
} from './engine.js';
import { absoluteNow, defaultSurfaceEnvironment, type ResizeObserverLike, type SurfaceEnvironment } from './env.js';
import { EngineInitError, MainThreadOnlyError, SurfaceNotAttachedError } from './errors.js';
import { createFrameLoop, type FrameInfo, type FrameLoop } from './frame-loop.js';
import { createHtmlInCanvas, type HtmlInCanvasAdapter, type HtmlInCanvasSupport } from './html-in-canvas.js';
import {
  type CompactInputEvent,
  createInputForwarder,
  type InputForwarder,
  type InputIntentMapper,
  mapInputToIntents,
  oldestTimestamp,
} from './input.js';
import { createSurfaceMetrics, type SurfaceBudget, type SurfaceMetricsRecorder, type SurfaceMetricsSnapshot } from './metrics.js';

export const SurfaceLifecycle = defineMachine({
  id: 'surface/lifecycle',
  initial: 'created',
  states: ['created', 'attaching', 'attached', 'running', 'detached', 'failed', 'disposed'],
  transitions: {
    created: { attach: 'attaching', dispose: 'disposed' },
    attaching: { attached: 'attached', fail: 'failed', detach: 'detached', dispose: 'disposed' },
    attached: { start: 'running', detach: 'detached', dispose: 'disposed' },
    running: { pause: 'attached', detach: 'detached', dispose: 'disposed' },
    detached: { attach: 'attaching', dispose: 'disposed' },
    failed: { attach: 'attaching', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type SurfaceState = (typeof SurfaceLifecycle.states)[number];
export type SurfaceEvent = 'attach' | 'attached' | 'fail' | 'start' | 'pause' | 'detach' | 'dispose';

export interface AttachOptions {
  readonly signal?: AbortSignal;
  /** CSS size (default: measured from the host). */
  readonly size?: { readonly width: number; readonly height: number };
  /** Start the frame loop once attached. Default true. */
  readonly autoStart?: boolean;
}

export interface Surface {
  readonly id: string;
  readonly kind: SurfaceKind;
  /** Where frames are produced. */
  readonly thread: 'main' | 'worker';
  /** Reactive. */
  readonly state: SurfaceState;
  readonly machine: Machine<SurfaceState, SurfaceEvent>;
  /** The canvas / container element in the host (while attached). */
  readonly element: HTMLElement | undefined;
  readonly size: SurfaceSize | undefined;
  attach(host: HTMLElement, options?: AttachOptions): Promise<Result<void>>;
  /** Resize to a CSS size (default: re-measure the host) at `dpr` (default: current device pixel ratio). */
  resize(size?: { readonly width: number; readonly height: number }, dpr?: number): void;
  /** Start / resume the frame loop. */
  start(): Result<void>;
  /** Pause the frame loop (e.g. surface hidden, feature hidden). */
  pause(): Result<void>;
  detach(): Promise<void>;
  dispose(): Promise<void>;
  metrics(): SurfaceMetricsSnapshot;
}

// ---------------------------------------------------------------- shell

/** What a concrete surface implements; the shell owns lifecycle, sizing and observation. */
export interface SurfaceHooks {
  attach(host: HTMLElement, size: SurfaceSize, signal: AbortSignal): Promise<Result<HTMLElement>>;
  resize(size: SurfaceSize): void;
  start(): void;
  pause(): void;
  detach(): void | Promise<void>;
  metrics(): SurfaceMetricsSnapshot;
}

export interface SurfaceShellOptions {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly thread: 'main' | 'worker';
  readonly env: SurfaceEnvironment;
  readonly telemetry: Telemetry;
  readonly hooks: SurfaceHooks;
}

const SUBSYSTEM = 'surface/lifecycle';

function measure(host: HTMLElement): { width: number; height: number } {
  const rect = host.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/** Build a `Surface` from hooks (shared by DOM, main-thread canvas and render-worker surfaces). */
export function createSurfaceShell(options: SurfaceShellOptions): Surface {
  const { env, telemetry, hooks } = options;
  const machine = createMachine(SurfaceLifecycle);
  let host: HTMLElement | undefined;
  let element: HTMLElement | undefined;
  let size: SurfaceSize | undefined;
  let observer: ResizeObserverLike | undefined;
  let controller: AbortController | undefined;
  const attrs = { surface: options.id, kind: options.kind, thread: options.thread };

  machine.onTransition((record) => {
    telemetry.event('surface.transition', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { ...attrs, from: record.from, to: record.to } });
  });

  const live = (): boolean => machine.is('attached', 'running');
  const applySize = (css: { width: number; height: number }, dpr = env.devicePixelRatio()): void => {
    const next = { width: css.width, height: css.height, dpr };
    if (size !== undefined && size.width === next.width && size.height === next.height && size.dpr === next.dpr) return;
    size = next;
    if (live()) hooks.resize(next);
  };

  const teardown = async (): Promise<void> => {
    observer?.disconnect();
    observer = undefined;
    controller?.abort(new DOMException('surface detached', 'AbortError'));
    controller = undefined;
    await hooks.detach();
    element = undefined;
    host = undefined;
  };

  const surface: Surface = {
    id: options.id,
    kind: options.kind,
    thread: options.thread,
    machine,
    get state() {
      return machine.state;
    },
    get element() {
      return element;
    },
    get size() {
      return size;
    },
    async attach(target, attachOptions = {}) {
      const sent = machine.send('attach');
      if (!sent.ok) return sent;
      const span = telemetry.span('surface.attach', { subsystem: SUBSYSTEM, attrs });
      controller = new AbortController();
      const signal = anySignal(controller.signal, attachOptions.signal);
      host = target;
      const css = attachOptions.size ?? measure(target);
      size = { width: css.width, height: css.height, dpr: env.devicePixelRatio() };
      let result: Result<HTMLElement>;
      try {
        result = await hooks.attach(target, size, signal);
      } catch (error) {
        result = err(toSfError(error));
      }
      if (machine.state !== 'attaching') {
        // Detached or disposed while attaching.
        if (result.ok) await hooks.detach();
        span.end('cancelled');
        return err(AbortedError({ message: `Surface "${options.id}" was detached while attaching.` }));
      }
      if (!result.ok || signal.aborted) {
        const error: SfError = result.ok ? AbortedError({ cause: signal.reason }) : result.error;
        machine.send('fail');
        await hooks.detach();
        controller = undefined;
        host = undefined;
        span.end(error.kind === 'aborted' ? 'cancelled' : 'error', error);
        telemetry.event('surface.attach-failed', { subsystem: SUBSYSTEM, level: 'critical', attrs: { ...attrs, code: error.code } });
        return err(error);
      }
      element = result.value;
      machine.send('attached');
      hooks.resize(size);
      if (attachOptions.size === undefined && env.resizeObserver !== undefined) {
        observer = env.resizeObserver((entries) => {
          const last = entries[entries.length - 1];
          if (last !== undefined) applySize({ width: last.contentRect.width, height: last.contentRect.height });
        });
        observer.observe(target);
      }
      span.end('ok');
      if (attachOptions.autoStart ?? true) surface.start();
      return ok();
    },
    resize(css, dpr) {
      if (host === undefined) return;
      applySize(css ?? measure(host), dpr ?? env.devicePixelRatio());
    },
    start() {
      if (machine.state === 'running') return ok();
      const result = machine.send('start');
      if (!result.ok) return err(SurfaceNotAttachedError({ details: { surface: options.id, state: machine.state } }));
      hooks.start();
      return ok();
    },
    pause() {
      if (machine.state === 'attached') return ok();
      const result = machine.send('pause');
      if (!result.ok) return err(SurfaceNotAttachedError({ details: { surface: options.id, state: machine.state } }));
      hooks.pause();
      return ok();
    },
    async detach() {
      if (!machine.can('detach')) return;
      const wasLive = live();
      machine.send('detach');
      if (wasLive) {
        hooks.pause();
        await teardown();
      } else {
        observer?.disconnect();
        controller?.abort(new DOMException('surface detached', 'AbortError'));
      }
    },
    async dispose() {
      if (machine.state === 'disposed') return;
      if (live()) {
        hooks.pause();
        machine.send('dispose');
        await teardown();
        return;
      }
      machine.send('dispose');
      controller?.abort(new DOMException('surface disposed', 'AbortError'));
    },
    metrics: () => hooks.metrics(),
  };
  return surface;
}

// ---------------------------------------------------------------- main-thread canvas surface

export interface SurfaceInputOptions<Intent> {
  /** Derive intents from input (sent to the owner via `onIntents`). */
  readonly mapper?: InputIntentMapper<Intent>;
  readonly onIntents?: (intents: readonly Intent[]) => void;
  /** Surface owns wheel scrolling (preventDefault). */
  readonly captureWheel?: boolean;
  /** Make the canvas focusable and forward key events. Default true. */
  readonly keyboard?: boolean;
}

export interface CanvasSurfaceOptions<State, K extends CanvasSurfaceKind, Intent = never> {
  readonly id: string;
  readonly kind: K;
  readonly engine: RenderEngineFactory<State, K>;
  /** Current state for the next frame (e.g. a replica snapshot or projection). */
  readonly state: () => State;
  readonly env?: SurfaceEnvironment;
  readonly telemetry?: Telemetry;
  readonly budget?: SurfaceBudget;
  readonly targetFrameMs?: number;
  /** `false` disables input forwarding. */
  readonly input?: SurfaceInputOptions<Intent> | false;
  readonly contextOptions?: unknown;
  /** html-in-canvas: override detection (e.g. force the overlay). */
  readonly htmlInCanvasSupport?: HtmlInCanvasSupport;
  /** Accessible name of the canvas. */
  readonly label?: string;
}

/** A canvas surface rendered on the main thread. */
export function createCanvasSurface<State, K extends CanvasSurfaceKind, Intent = never>(
  options: CanvasSurfaceOptions<State, K, Intent>,
): Surface {
  const env = options.env ?? defaultSurfaceEnvironment();
  const telemetry = options.telemetry ?? createNoopTelemetry();
  let metrics: SurfaceMetricsRecorder = newMetrics();
  let canvas: HTMLCanvasElement | undefined;
  let engine: RenderEngine<State, K> | undefined;
  let loop: FrameLoop | undefined;
  let forwarder: InputForwarder | undefined;
  let adapter: HtmlInCanvasAdapter | undefined;
  let current: SurfaceSize | undefined;
  let inputQueue: CompactInputEvent[] = [];
  const inputOptions = options.input === false ? undefined : (options.input ?? {});

  function newMetrics(): SurfaceMetricsRecorder {
    return createSurfaceMetrics({
      surfaceId: options.id,
      kind: options.kind,
      telemetry,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.targetFrameMs === undefined ? {} : { targetFrameMs: options.targetFrameMs }),
    });
  }

  const onFrame = (info: FrameInfo): void => {
    if (engine === undefined) return;
    const pending = inputQueue;
    if (pending.length > 0) {
      inputQueue = [];
      engine.input?.(pending);
      if (inputOptions?.mapper !== undefined && current !== undefined) {
        const intents = mapInputToIntents(pending, inputOptions.mapper, { surfaceId: options.id, size: current });
        if (intents.length > 0) inputOptions.onIntents?.(intents);
      }
    }
    engine.frame(options.state(), info.dt, info);
    const oldest = oldestTimestamp(pending);
    if (oldest !== undefined) metrics.input(absoluteNow(env) - oldest);
  };

  const hooks: SurfaceHooks = {
    async attach(host, size, signal) {
      const doc = env.document;
      if (doc === undefined) return err(MainThreadOnlyError({ details: { surface: options.id } }));
      metrics = newMetrics();
      const element = doc.createElement('canvas');
      element.style.display = 'block';
      if (options.label !== undefined) element.setAttribute('aria-label', options.label);
      canvas = element;
      host.appendChild(element);
      current = size;
      sizeCanvas(element, size);
      if (options.kind === 'html-in-canvas') {
        const created = createHtmlInCanvas({
          canvas: element,
          document: doc,
          ...(options.htmlInCanvasSupport === undefined ? {} : { support: options.htmlInCanvasSupport }),
          cssSize: () => ({ width: current?.width ?? 0, height: current?.height ?? 0 }),
        });
        if (!created.ok) return created;
        adapter = created.value;
      }
      const context = acquireContext(element, options.kind, options.contextOptions);
      if (!context.ok) return context;
      const instance = options.engine();
      engine = instance;
      const renderContext: RenderContext<K> = {
        surfaceId: options.id,
        kind: options.kind,
        canvas: element,
        context: context.value,
        size,
        thread: 'main',
        signal,
        ...(adapter === undefined ? {} : { htmlInCanvas: adapter }),
      };
      let initialized: Result<void>;
      try {
        initialized = await instance.init(renderContext);
      } catch (error) {
        initialized = err(toSfError(error));
      }
      if (!initialized.ok) {
        return err(EngineInitError({ cause: initialized.error, message: `Engine init failed: ${initialized.error.message}`, details: { surface: options.id, code: initialized.error.code } }));
      }
      if (inputOptions !== undefined) {
        if (inputOptions.keyboard ?? true) element.tabIndex = 0;
        forwarder = createInputForwarder({
          target: element,
          env,
          sink: (batch) => inputQueue.push(...batch),
          ...(inputOptions.captureWheel === undefined ? {} : { captureWheel: inputOptions.captureWheel }),
        });
      }
      loop = createFrameLoop({
        scheduler: env.scheduler,
        now: env.now,
        onFrame,
        metrics,
        onError: (error) =>
          telemetry.event('surface.frame-error', {
            subsystem: 'surface/frame',
            level: 'critical',
            attrs: { surface: options.id, message: toSfError(error).message },
          }),
      });
      return ok(element);
    },
    resize(size) {
      current = size;
      if (canvas !== undefined) sizeCanvas(canvas, size);
      engine?.resize(size);
    },
    start() {
      if (loop === undefined) return;
      if (loop.state === 'idle') loop.start();
      else if (loop.state === 'paused') loop.resume();
    },
    pause() {
      if (loop?.state === 'running') loop.pause();
    },
    detach() {
      loop?.stop();
      loop = undefined;
      metrics.flush();
      forwarder?.dispose();
      forwarder = undefined;
      inputQueue = [];
      engine?.dispose();
      engine = undefined;
      adapter?.dispose();
      adapter = undefined;
      canvas?.remove();
      canvas = undefined;
    },
    metrics: () => metrics.snapshot(),
  };
  return createSurfaceShell({ id: options.id, kind: options.kind, thread: 'main', env, telemetry, hooks });
}

/** Set the backing store to CSS size × DPR and the CSS size on the element. */
export function sizeCanvas(canvas: { width: number; height: number; style?: CSSStyleDeclaration }, size: SurfaceSize): void {
  const backing = backingSize(size);
  if (canvas.width !== backing.width) canvas.width = backing.width;
  if (canvas.height !== backing.height) canvas.height = backing.height;
  if (canvas.style !== undefined) {
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
  }
}

// ---------------------------------------------------------------- DOM surface

export interface DomSurfaceOptions<State> {
  readonly id: string;
  /** Render into the container (e.g. a Lit `render()`); runs once per attach. */
  readonly mount: (container: HTMLElement, signal: AbortSignal) => Result<void> | Promise<Result<void>>;
  /** Optional per-frame update (most DOM surfaces are reactive and leave this out). */
  readonly update?: (state: State, dt: number, info: FrameInfo) => void;
  readonly state?: () => State;
  readonly unmount?: (container: HTMLElement) => void;
  readonly onResize?: (size: SurfaceSize) => void;
  readonly env?: SurfaceEnvironment;
  readonly telemetry?: Telemetry;
}

export function createDomSurface<State = undefined>(options: DomSurfaceOptions<State>): Surface {
  const env = options.env ?? defaultSurfaceEnvironment();
  const telemetry = options.telemetry ?? createNoopTelemetry();
  let container: HTMLElement | undefined;
  let loop: FrameLoop | undefined;
  let metrics = createSurfaceMetrics({ surfaceId: options.id, kind: 'dom', telemetry });
  const hooks: SurfaceHooks = {
    async attach(host, _size, signal) {
      const doc = env.document;
      if (doc === undefined) return err(MainThreadOnlyError({ details: { surface: options.id } }));
      metrics = createSurfaceMetrics({ surfaceId: options.id, kind: 'dom', telemetry });
      const element = doc.createElement('div');
      element.setAttribute('data-sf-surface', options.id);
      host.appendChild(element);
      container = element;
      let mounted: Result<void>;
      try {
        mounted = await options.mount(element, signal);
      } catch (error) {
        mounted = err(toSfError(error));
      }
      if (!mounted.ok) return mounted;
      const update = options.update;
      if (update !== undefined) {
        loop = createFrameLoop({
          scheduler: env.scheduler,
          now: env.now,
          metrics,
          onFrame: (info) => update(options.state?.() as State, info.dt, info),
        });
      }
      return ok(element);
    },
    resize: (size) => options.onResize?.(size),
    start() {
      if (loop?.state === 'idle') loop.start();
      else if (loop?.state === 'paused') loop.resume();
    },
    pause() {
      if (loop?.state === 'running') loop.pause();
    },
    detach() {
      loop?.stop();
      loop = undefined;
      if (container !== undefined) options.unmount?.(container);
      container?.remove();
      container = undefined;
    },
    metrics: () => metrics.snapshot(),
  };
  return createSurfaceShell({ id: options.id, kind: 'dom', thread: 'main', env, telemetry, hooks });
}
