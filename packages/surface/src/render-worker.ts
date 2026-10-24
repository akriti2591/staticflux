/**
 * Render-worker hosting (R11.21): the main thread creates the canvas, transfers
 * it as an `OffscreenCanvas` to a worker over a Link, forwards size changes and
 * timestamped compact input; the worker runs the engine with its own frame loop
 * (rAF in the worker where available, else a timer), turns input into intents,
 * and reports frame metrics back. Engine-agnostic: the worker registers engine
 * factories by id; nothing here knows Three.js, Babylon or wgpu.
 *
 * Wire (all on one Link, structured clone + transfer):
 *   main → worker  request `sf/surface/attach` { surfaceId, kind, engine, canvas, size }  (canvas transferred)
 *                  event   `sf/surface/resize` { surfaceId, size }
 *                  event   `sf/surface/input`  { surfaceId, events }
 *                  event   `sf/surface/run`    { surfaceId, running }
 *                  request `sf/surface/detach` { surfaceId }
 *   worker → main  event   `sf/surface/metrics` { surfaceId, snapshot }
 *                  event   `sf/surface/error`   { surfaceId, error }
 */
import { createNoopTelemetry, err, ok, type Result, type Telemetry, toSfError } from '@staticflux/core';
import { type ChannelId, fromWireError, type Link, toWireError, type WireError } from '@staticflux/worker';
import {
  acquireContext,
  backingSize,
  type CanvasFeatureGlobals,
  type CanvasLike,
  type RenderEngine,
  type RenderEngineFactory,
  supportsOffscreenCanvas,
  type SurfaceSize,
  type WorkerSurfaceKind,
} from './engine.js';
import { absoluteNow, defaultSurfaceEnvironment, type SurfaceEnvironment } from './env.js';
import { EngineInitError, MainThreadOnlyError, OffscreenUnsupportedError, RenderWorkerError } from './errors.js';
import { createFrameLoop, type FrameLoop } from './frame-loop.js';
import {
  type CompactInputEvent,
  createInputForwarder,
  type InputForwarder,
  type InputIntentMapper,
  mapInputToIntents,
  oldestTimestamp,
} from './input.js';
import {
  createSurfaceMetrics,
  EMPTY_SURFACE_METRICS,
  type SurfaceBudget,
  type SurfaceMetricsRecorder,
  type SurfaceMetricsSnapshot,
} from './metrics.js';
import { createCanvasSurface, createSurfaceShell, type CanvasSurfaceOptions, type Surface, type SurfaceHooks } from './surface.js';

export const SurfaceChannels = {
  attach: 'sf/surface/attach',
  resize: 'sf/surface/resize',
  input: 'sf/surface/input',
  run: 'sf/surface/run',
  detach: 'sf/surface/detach',
  metrics: 'sf/surface/metrics',
  error: 'sf/surface/error',
} as const satisfies Record<string, ChannelId>;

interface AttachMessage {
  readonly surfaceId: string;
  readonly kind: WorkerSurfaceKind;
  readonly engine: string;
  readonly canvas: CanvasLike;
  readonly size: SurfaceSize;
  readonly budget?: SurfaceBudget;
  readonly targetFrameMs?: number;
}

interface SurfaceMessage {
  readonly surfaceId: string;
}

// ---------------------------------------------------------------- main side

export interface WorkerSurfaceOptions {
  readonly id: string;
  readonly kind: WorkerSurfaceKind;
  /** Engine id registered in the worker (`hostRenderSurfaces({ engines })`). */
  readonly engine: string;
  readonly link: Link;
  readonly env?: SurfaceEnvironment;
  readonly telemetry?: Telemetry;
  readonly budget?: SurfaceBudget;
  readonly targetFrameMs?: number;
  /** `false` disables input forwarding. */
  readonly input?: { readonly captureWheel?: boolean; readonly keyboard?: boolean } | false;
  /** Timeout for attach/detach requests. Default 10 s. */
  readonly timeoutMs?: number;
  readonly label?: string;
}

/** A surface whose frames are produced by a render worker. */
export function createWorkerSurface(options: WorkerSurfaceOptions): Surface {
  const env = options.env ?? defaultSurfaceEnvironment();
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const { link } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let canvas: HTMLCanvasElement | undefined;
  let forwarder: InputForwarder | undefined;
  let snapshot: SurfaceMetricsSnapshot = EMPTY_SURFACE_METRICS;
  let attached = false;
  const unsubscribers: (() => void)[] = [];

  const hooks: SurfaceHooks = {
    async attach(host, size, signal) {
      const doc = env.document;
      if (doc === undefined) return err(MainThreadOnlyError({ details: { surface: options.id } }));
      const element = doc.createElement('canvas');
      element.style.display = 'block';
      element.style.width = `${size.width}px`;
      element.style.height = `${size.height}px`;
      if (options.label !== undefined) element.setAttribute('aria-label', options.label);
      if (typeof (element as { transferControlToOffscreen?: unknown }).transferControlToOffscreen !== 'function') {
        return err(OffscreenUnsupportedError({ details: { surface: options.id } }));
      }
      host.appendChild(element);
      canvas = element;
      const offscreen = element.transferControlToOffscreen();
      const backing = backingSize(size);
      offscreen.width = backing.width;
      offscreen.height = backing.height;
      snapshot = EMPTY_SURFACE_METRICS;
      unsubscribers.push(
        link.on(SurfaceChannels.metrics, (payload) => {
          const message = payload as { surfaceId?: unknown; snapshot?: SurfaceMetricsSnapshot } | null;
          if (message?.surfaceId === options.id && message.snapshot !== undefined) snapshot = message.snapshot;
        }),
        link.on(SurfaceChannels.error, (payload) => {
          const message = payload as { surfaceId?: unknown; error?: WireError } | null;
          if (message?.surfaceId !== options.id || message.error === undefined) return;
          const error = fromWireError(message.error);
          telemetry.event('surface.worker-error', { subsystem: 'surface/worker', level: 'critical', attrs: { surface: options.id, code: error.code, message: error.message } });
        }),
      );
      const message: AttachMessage = {
        surfaceId: options.id,
        kind: options.kind,
        engine: options.engine,
        canvas: offscreen,
        size,
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(options.targetFrameMs === undefined ? {} : { targetFrameMs: options.targetFrameMs }),
      };
      const response = await link.request(SurfaceChannels.attach, message, { transfer: [offscreen], signal, timeoutMs });
      if (!response.ok) {
        return err(response.error.code.startsWith('SF-SURF-') ? response.error : RenderWorkerError({ cause: response.error, message: `Render worker attach failed: ${response.error.message}`, details: { surface: options.id, code: response.error.code } }));
      }
      attached = true;
      const input = options.input;
      if (input !== false) {
        if (input?.keyboard ?? true) element.tabIndex = 0;
        forwarder = createInputForwarder({
          target: element,
          env,
          sink: (events) => link.send(SurfaceChannels.input, { surfaceId: options.id, events }),
          ...(input?.captureWheel === undefined ? {} : { captureWheel: input.captureWheel }),
        });
      }
      return ok(element);
    },
    resize(size) {
      if (canvas !== undefined) {
        canvas.style.width = `${size.width}px`;
        canvas.style.height = `${size.height}px`;
      }
      if (attached) link.send(SurfaceChannels.resize, { surfaceId: options.id, size });
    },
    start() {
      if (attached) link.send(SurfaceChannels.run, { surfaceId: options.id, running: true });
    },
    pause() {
      if (attached) link.send(SurfaceChannels.run, { surfaceId: options.id, running: false });
    },
    async detach() {
      forwarder?.dispose();
      forwarder = undefined;
      if (attached && !link.closed) {
        attached = false;
        await link.request(SurfaceChannels.detach, { surfaceId: options.id } satisfies SurfaceMessage, { timeoutMs });
      }
      attached = false;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      canvas?.remove();
      canvas = undefined;
    },
    metrics: () => snapshot,
  };
  return createSurfaceShell({ id: options.id, kind: options.kind, thread: 'worker', env, telemetry, hooks });
}

export interface RenderSurfaceOptions<State, K extends WorkerSurfaceKind, Intent = never> extends CanvasSurfaceOptions<State, K, Intent> {
  /** Link to the render worker; omit to render on the main thread. */
  readonly link?: Link;
  /** Engine id registered in the worker. */
  readonly engineId: string;
  /** Feature globals for OffscreenCanvas detection (tests). */
  readonly features?: CanvasFeatureGlobals;
}

/**
 * Prefer the render worker (OffscreenCanvas available + link given); otherwise
 * render the same engine on the main thread. Feature code is the same.
 */
export function createRenderSurface<State, K extends WorkerSurfaceKind, Intent = never>(options: RenderSurfaceOptions<State, K, Intent>): Surface {
  if (options.link !== undefined && supportsOffscreenCanvas(options.features)) {
    const input = options.input;
    return createWorkerSurface({
      id: options.id,
      kind: options.kind,
      engine: options.engineId,
      link: options.link,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.targetFrameMs === undefined ? {} : { targetFrameMs: options.targetFrameMs }),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(input === undefined
        ? {}
        : {
            input:
              input === false
                ? false
                : {
                    ...(input.captureWheel === undefined ? {} : { captureWheel: input.captureWheel }),
                    ...(input.keyboard === undefined ? {} : { keyboard: input.keyboard }),
                  },
          }),
    });
  }
  return createCanvasSurface(options);
}

// ---------------------------------------------------------------- worker side

export interface RenderHostOptions<State, Intent = never> {
  readonly link: Link;
  /** Engine factories by id (any engine: Wasm, Three.js, Babylon, hand-written). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly engines: Readonly<Record<string, RenderEngineFactory<State, any>>>;
  /** State for the next frame of a surface (replica snapshot, frame-channel data…). */
  readonly state: (surfaceId: string) => State;
  /** Input → intents (forwarded to the owner with `onIntents`, e.g. `replica.intent(...)`). */
  readonly mapper?: InputIntentMapper<Intent>;
  readonly onIntents?: (intents: readonly Intent[], surfaceId: string) => void;
  readonly env?: SurfaceEnvironment;
  readonly telemetry?: Telemetry;
  /** Send a metrics snapshot to the main thread every N frames. Default 30. */
  readonly metricsEvery?: number;
}

export interface HostedSurfaceInfo {
  readonly id: string;
  readonly kind: WorkerSurfaceKind;
  readonly engine: string;
  readonly running: boolean;
  readonly size: SurfaceSize;
  readonly metrics: SurfaceMetricsSnapshot;
}

export interface RenderHost {
  surfaces(): readonly HostedSurfaceInfo[];
  dispose(): void;
}

interface Hosted<State> {
  readonly id: string;
  readonly kind: WorkerSurfaceKind;
  readonly engineId: string;
  readonly canvas: CanvasLike;
  readonly engine: RenderEngine<State>;
  readonly loop: FrameLoop;
  readonly metrics: SurfaceMetricsRecorder;
  readonly controller: AbortController;
  size: SurfaceSize;
  input: CompactInputEvent[];
}

/** Inside the render worker: host surfaces sent by `createWorkerSurface`. */
export function hostRenderSurfaces<State, Intent = never>(options: RenderHostOptions<State, Intent>): RenderHost {
  const { link } = options;
  const env = options.env ?? defaultSurfaceEnvironment({ document: undefined });
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const metricsEvery = options.metricsEvery ?? 30;
  const hosted = new Map<string, Hosted<State>>();

  const reportError = (surfaceId: string, error: unknown): void => {
    const sf = toSfError(error);
    telemetry.event('surface.frame-error', { subsystem: 'surface/worker', level: 'critical', attrs: { surface: surfaceId, message: sf.message } });
    link.send(SurfaceChannels.error, { surfaceId, error: toWireError(sf) });
  };

  const detach = (surfaceId: string): void => {
    const entry = hosted.get(surfaceId);
    if (entry === undefined) return;
    hosted.delete(surfaceId);
    entry.loop.stop();
    entry.controller.abort(new DOMException('surface detached', 'AbortError'));
    entry.metrics.flush();
    try {
      entry.engine.dispose();
    } catch (error) {
      reportError(surfaceId, error);
    }
  };

  const attach = async (message: AttachMessage): Promise<Result<void>> => {
    if (hosted.has(message.surfaceId)) detach(message.surfaceId);
    const factory = options.engines[message.engine];
    if (factory === undefined) {
      return err(RenderWorkerError({ message: `No render engine "${message.engine}" registered in the worker.`, details: { surface: message.surfaceId, engine: message.engine } }));
    }
    const context = acquireContext(message.canvas, message.kind);
    if (!context.ok) return context;
    const engine = factory() as RenderEngine<State>;
    const controller = new AbortController();
    let initialized: Result<void>;
    try {
      initialized = await engine.init({
        surfaceId: message.surfaceId,
        kind: message.kind,
        canvas: message.canvas,
        context: context.value,
        size: message.size,
        thread: 'worker',
        signal: controller.signal,
      });
    } catch (error) {
      initialized = err(toSfError(error));
    }
    if (!initialized.ok) {
      return err(EngineInitError({ cause: initialized.error, message: `Engine init failed: ${initialized.error.message}`, details: { surface: message.surfaceId, code: initialized.error.code } }));
    }
    const metrics = createSurfaceMetrics({
      surfaceId: message.surfaceId,
      kind: message.kind,
      telemetry,
      ...(message.budget === undefined ? {} : { budget: message.budget }),
      ...(message.targetFrameMs === undefined ? {} : { targetFrameMs: message.targetFrameMs }),
    });
    const entry: Hosted<State> = {
      id: message.surfaceId,
      kind: message.kind,
      engineId: message.engine,
      canvas: message.canvas,
      engine,
      metrics,
      controller,
      size: message.size,
      input: [],
      loop: createFrameLoop({
        scheduler: env.scheduler,
        now: env.now,
        // Report a snapshot to the main thread every `metricsEvery` frames (after the frame is counted).
        metrics: {
          ...metrics,
          frame(intervalMs, workMs) {
            metrics.frame(intervalMs, workMs);
            if (metrics.snapshot().frames % metricsEvery === 0) {
              link.send(SurfaceChannels.metrics, { surfaceId: message.surfaceId, snapshot: metrics.snapshot() });
            }
          },
        },
        onError: (error) => reportError(message.surfaceId, error),
        onFrame: (info) => {
          const pending = entry.input;
          if (pending.length > 0) {
            entry.input = [];
            engine.input?.(pending);
            if (options.mapper !== undefined) {
              const intents = mapInputToIntents(pending, options.mapper, { surfaceId: entry.id, size: entry.size });
              if (intents.length > 0) options.onIntents?.(intents, entry.id);
            }
          }
          engine.frame(options.state(entry.id), info.dt, info);
          const oldest = oldestTimestamp(pending);
          if (oldest !== undefined) metrics.input(absoluteNow(env) - oldest);
        },
      }),
    };
    hosted.set(message.surfaceId, entry);
    return ok(); // the main side sends the initial resize right after attach

  };

  const surfaceOf = (payload: unknown): Hosted<State> | undefined => {
    const id = (payload as Partial<SurfaceMessage> | null)?.surfaceId;
    return typeof id === 'string' ? hosted.get(id) : undefined;
  };

  const disposers = [
    link.handle(SurfaceChannels.attach, (payload) => attach(payload as AttachMessage)),
    link.handle(SurfaceChannels.detach, (payload) => {
      const id = (payload as Partial<SurfaceMessage> | null)?.surfaceId;
      if (typeof id === 'string') detach(id);
      return ok();
    }),
    link.on(SurfaceChannels.resize, (payload) => {
      const entry = surfaceOf(payload);
      const size = (payload as { size?: SurfaceSize }).size;
      if (entry === undefined || size === undefined) return;
      entry.size = size;
      const backing = backingSize(size);
      entry.canvas.width = backing.width;
      entry.canvas.height = backing.height;
      entry.engine.resize(size);
    }),
    link.on(SurfaceChannels.input, (payload) => {
      const entry = surfaceOf(payload);
      const events = (payload as { events?: readonly CompactInputEvent[] }).events;
      if (entry !== undefined && Array.isArray(events)) entry.input.push(...events);
    }),
    link.on(SurfaceChannels.run, (payload) => {
      const entry = surfaceOf(payload);
      if (entry === undefined) return;
      const running = (payload as { running?: unknown }).running === true;
      const loop = entry.loop;
      if (running) {
        if (loop.state === 'idle') loop.start();
        else if (loop.state === 'paused') loop.resume();
      } else if (loop.state === 'running') loop.pause();
    }),
  ];
  const offClose = link.onClose(() => {
    for (const id of [...hosted.keys()]) detach(id);
  });

  return {
    surfaces: () =>
      [...hosted.values()].map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        engine: entry.engineId,
        running: entry.loop.state === 'running',
        size: entry.size,
        metrics: entry.metrics.snapshot(),
      })),
    dispose() {
      for (const dispose of disposers) dispose();
      offClose();
      for (const id of [...hosted.keys()]) detach(id);
    },
  };
}
