/**
 * GPU device lifecycle (SF-Δ23, IF-7.11, R11.44). One machine per GPU surface or render module:
 *
 *   idle → attaching → running;  attaching → failed;  running → lost → attaching (recovery);
 *   lost → failed (attempts exhausted);  failed → attaching (manual retry);  * → disposed.
 *
 * `device.lost` (any reason except our own `dispose`) moves `running → lost` and starts recovery:
 * a **new** adapter and device (an adapter is consumed by its first device), then `restore` rebuilds
 * GPU objects from the retained CPU-side scene. No document reload. The time from loss to
 * `running` is reported (`surface/gpu-recovery`); over the budget (1 s) it is flagged with
 * SF-SURF-012 but recovery still completes. Attempts back off; after `maxAttempts` the machine
 * goes to `failed` with SF-SURF-011.
 *
 * The device itself comes from a `GpuDeviceProvider`: `webGpuDeviceProvider(navigator.gpu)` when
 * TypeScript owns the device, or a backend's own provider when the device lives in Wasm (wgpu), in
 * which case the backend returns the raw `GPUDevice` so the lifecycle can watch `lost`.
 */
import {
  AbortedError,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  type Machine,
  metric,
  ok,
  type Result,
  type SfError,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import { describeGpuAdapter, type GpuAdapterFacts } from '@staticflux/platform';
import { GpuDeviceLostError, GpuRecoveryOverBudgetError, GpuUnavailableError } from './raster-errors.js';

export const GpuDeviceLifecycle = defineMachine({
  id: 'surface/gpu-device',
  initial: 'idle',
  states: ['idle', 'attaching', 'running', 'lost', 'failed', 'disposed'],
  transitions: {
    idle: { attach: 'attaching', dispose: 'disposed' },
    attaching: { attached: 'running', fail: 'failed', dispose: 'disposed' },
    running: { lose: 'lost', dispose: 'disposed' },
    lost: { attach: 'attaching', fail: 'failed', dispose: 'disposed' },
    failed: { attach: 'attaching', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type GpuDeviceState = (typeof GpuDeviceLifecycle.states)[number];
export type GpuDeviceEvent = 'attach' | 'attached' | 'fail' | 'lose' | 'dispose';

/** GPU facts for one device (SF-Δ23): the adapter it came from plus what the device was granted. */
export interface GpuDeviceFacts {
  readonly adapter: GpuAdapterFacts;
  /** Features enabled on the device, sorted. */
  readonly features: readonly string[];
  /** Numeric device limits (what was granted, not what the adapter could do). */
  readonly limits: Readonly<Record<string, number>>;
}

export interface GpuLossInfo {
  /** `destroyed` when someone called `device.destroy()`; `unknown` for resets, crashes, TDRs. */
  readonly reason: 'destroyed' | 'unknown' | string;
  readonly message: string;
}

/** A live device as the lifecycle sees it. */
export interface GpuDeviceHandle {
  readonly facts: GpuDeviceFacts;
  /** Settles once when the device is lost (`GPUDevice.lost`). */
  readonly lost: Promise<GpuLossInfo>;
  /** The raw `GPUDevice` (opaque to the framework). */
  readonly device?: unknown;
  /** Destroy the device (its `lost` then settles with reason `destroyed`). */
  destroy(): void;
}

export interface GpuDeviceProvider {
  /** Request a fresh adapter and device. Never reuse an adapter: it is consumed by its first device. */
  acquire(options: { readonly signal: AbortSignal }): Promise<Result<GpuDeviceHandle>>;
}

export interface GpuRecoveryPolicy {
  /** Loss → running budget (default 1000 ms, IF-7.11). */
  readonly budgetMs?: number;
  /** Re-attach attempts per loss (default 3). */
  readonly maxAttempts?: number;
  /** Delay before attempt n (index n-1; default [0, 100, 400]; the last value repeats). */
  readonly backoffMs?: readonly number[];
}

export interface GpuDeviceOptions {
  readonly id: string;
  readonly provider: GpuDeviceProvider;
  /** Rebuild GPU state on a new device (pipelines, uploads) from retained CPU-side state. */
  readonly restore?: (handle: GpuDeviceHandle, context: { readonly signal: AbortSignal; readonly recovery: boolean }) => Result<void> | Promise<Result<void>>;
  readonly recovery?: GpuRecoveryPolicy;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly telemetry?: Telemetry;
}

export interface GpuRecoveryRecord {
  readonly loss: GpuLossInfo;
  readonly attempts: number;
  readonly ms: number;
  readonly ok: boolean;
  readonly overBudget: boolean;
}

export interface GpuDevice {
  readonly id: string;
  readonly state: GpuDeviceState;
  readonly machine: Machine<GpuDeviceState, GpuDeviceEvent>;
  /** The current device (undefined unless `running`). */
  readonly handle: GpuDeviceHandle | undefined;
  readonly facts: GpuDeviceFacts | undefined;
  /** First attach (or a retry from `failed`). */
  attach(options?: { readonly signal?: AbortSignal }): Promise<Result<GpuDeviceFacts>>;
  /** Resolves when `running` (immediately if it is); fails once `failed` or `disposed`. */
  whenRunning(signal?: AbortSignal): Promise<Result<GpuDeviceHandle>>;
  onLost(listener: (loss: GpuLossInfo) => void): () => void;
  onRecovered(listener: (record: GpuRecoveryRecord) => void): () => void;
  /** Recoveries so far (newest last). */
  recoveries(): readonly GpuRecoveryRecord[];
  dispose(): void;
}

export const GpuDeviceMetrics = {
  recovery: /* @__PURE__ */ metric.histogram('surface/gpu-recovery', { unit: 'ms', description: 'GPU device loss → running again (IF-7.11 budget 1 s).' }),
  losses: /* @__PURE__ */ metric.counter('surface/gpu-device-lost', { description: 'GPU device losses (attrs: surface, reason).' }),
} as const;

const SUBSYSTEM = 'surface/gpu';

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const done = new AbortController();
    const timer = setTimeout(() => {
      done.abort();
      resolve();
    }, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true, signal: done.signal },
    );
  });

export function createGpuDevice(options: GpuDeviceOptions): GpuDevice {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;
  const budgetMs = options.recovery?.budgetMs ?? 1000;
  const maxAttempts = Math.max(1, options.recovery?.maxAttempts ?? 3);
  const backoff = options.recovery?.backoffMs ?? [0, 100, 400];
  const machine = createMachine(GpuDeviceLifecycle);
  const life = new AbortController();
  const lostListeners = new Set<(loss: GpuLossInfo) => void>();
  const recoveredListeners = new Set<(record: GpuRecoveryRecord) => void>();
  const waiters = new Set<{ resolve: (r: Result<GpuDeviceHandle>) => void; signal: AbortSignal | undefined; onAbort: () => void }>();
  const history: GpuRecoveryRecord[] = [];
  let handle: GpuDeviceHandle | undefined;
  let lastError: SfError | undefined;
  /** True from a loss until recovery succeeds or gives up (the machine passes through `failed` between attempts). */
  let recovering = false;
  /** Bumped per device so a stale `lost` from a replaced device is ignored. */
  let generation = 0;

  const settleWaiters = (result: Result<GpuDeviceHandle>): void => {
    for (const waiter of [...waiters]) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiters.delete(waiter);
      waiter.resolve(result);
    }
  };

  const send = (event: GpuDeviceEvent): void => {
    machine.send(event);
  };

  /** Acquire + restore once. On success the handle is installed and watched. */
  const tryAttach = async (signal: AbortSignal, recovery: boolean): Promise<Result<GpuDeviceHandle>> => {
    let acquired: Result<GpuDeviceHandle>;
    try {
      acquired = await options.provider.acquire({ signal });
    } catch (cause) {
      acquired = err(GpuUnavailableError({ cause, message: `Acquiring a GPU device failed: ${String(cause)}` }));
    }
    if (!acquired.ok) return acquired;
    const next = acquired.value;
    if (signal.aborted || life.signal.aborted) {
      next.destroy();
      return err(AbortedError({ cause: signal.reason }));
    }
    if (options.restore !== undefined) {
      let restored: Result<void>;
      try {
        restored = await options.restore(next, { signal, recovery });
      } catch (cause) {
        restored = err(toSfError(cause));
      }
      if (!restored.ok) {
        next.destroy();
        return restored;
      }
    }
    return ok(next);
  };

  const install = (next: GpuDeviceHandle): void => {
    handle = next;
    generation += 1;
    const mine = generation;
    void next.lost.then((loss) => {
      if (mine !== generation || life.signal.aborted) return; // replaced or disposed by us
      onLoss(loss);
    });
  };

  const onLoss = (loss: GpuLossInfo): void => {
    if (machine.state !== 'running') return;
    handle = undefined;
    send('lose');
    telemetry.event('surface.gpu-device-lost', { subsystem: SUBSYSTEM, level: 'critical', attrs: { surface: options.id, reason: loss.reason, message: loss.message } });
    telemetry.record(GpuDeviceMetrics.losses, 1, { surface: options.id, reason: loss.reason });
    for (const listener of [...lostListeners]) listener(loss);
    void recover(loss);
  };

  const recover = async (loss: GpuLossInfo): Promise<void> => {
    recovering = true;
    const started = now();
    let attempts = 0;
    let last: SfError | undefined;
    while (attempts < maxAttempts && !life.signal.aborted) {
      const delay = backoff[Math.min(attempts, backoff.length - 1)] ?? 0;
      attempts += 1;
      if (delay > 0) await sleep(delay, life.signal);
      if (life.signal.aborted) return;
      send('attach');
      const result = await tryAttach(life.signal, true);
      if (life.signal.aborted) return;
      if (result.ok) {
        recovering = false;
        install(result.value);
        send('attached');
        const ms = now() - started;
        const overBudget = ms > budgetMs;
        const record: GpuRecoveryRecord = { loss, attempts, ms, ok: true, overBudget };
        history.push(record);
        telemetry.record(GpuDeviceMetrics.recovery, ms, { surface: options.id, attempts });
        telemetry.event('surface.gpu-device-recovered', { subsystem: SUBSYSTEM, level: 'standard', attrs: { surface: options.id, attempts, ms } });
        if (overBudget) {
          const error = GpuRecoveryOverBudgetError({ details: { surface: options.id, ms, budgetMs, attempts } });
          telemetry.event('surface.gpu-recovery-over-budget', { subsystem: SUBSYSTEM, level: 'critical', attrs: { surface: options.id, ms, budgetMs, code: error.code } });
        }
        for (const listener of [...recoveredListeners]) listener(record);
        settleWaiters(ok(result.value));
        return;
      }
      last = result.error;
      // attaching → failed; the next attempt goes failed → attaching (still the same recovery).
      send('fail');
    }
    recovering = false;
    if (life.signal.aborted) return;
    const error = GpuDeviceLostError({ cause: last, details: { surface: options.id, attempts, reason: loss.reason } });
    lastError = error;
    const record: GpuRecoveryRecord = { loss, attempts, ms: now() - started, ok: false, overBudget: now() - started > budgetMs };
    history.push(record);
    telemetry.event('surface.gpu-recovery-failed', { subsystem: SUBSYSTEM, level: 'critical', attrs: { surface: options.id, attempts, code: error.code } });
    for (const listener of [...recoveredListeners]) listener(record);
    settleWaiters(err(error));
  };

  const device: GpuDevice = {
    id: options.id,
    get state() {
      return machine.state;
    },
    machine,
    get handle() {
      return handle;
    },
    get facts() {
      return handle?.facts;
    },
    async attach(attachOptions = {}) {
      if (machine.state === 'running' && handle !== undefined) return ok(handle.facts);
      if (!machine.can('attach') || machine.state === 'lost' || recovering) {
        if (machine.state === 'lost' || recovering) {
          const running = await device.whenRunning(attachOptions.signal);
          return running.ok ? ok(running.value.facts) : running;
        }
        return err(GpuUnavailableError({ message: `Cannot attach a GPU device while it is ${machine.state}.`, details: { surface: options.id, state: machine.state } }));
      }
      send('attach');
      const signal = attachOptions.signal === undefined ? life.signal : AbortSignal.any([attachOptions.signal, life.signal]);
      const result = await tryAttach(signal, false);
      if (machine.state === 'disposed') return err(AbortedError({ message: 'The GPU device was disposed while attaching.' }));
      if (!result.ok) {
        lastError = result.error;
        send('fail');
        settleWaiters(err(result.error));
        return result;
      }
      install(result.value);
      send('attached');
      telemetry.event('surface.gpu-device-attached', {
        subsystem: SUBSYSTEM,
        level: 'standard',
        attrs: { surface: options.id, architecture: result.value.facts.adapter.info.architecture, fallback: result.value.facts.adapter.isFallbackAdapter },
      });
      settleWaiters(ok(result.value));
      return ok(result.value.facts);
    },
    whenRunning(signal) {
      if (machine.state === 'running' && handle !== undefined) return Promise.resolve(ok(handle));
      if (machine.state === 'disposed') return Promise.resolve(err(AbortedError({ message: 'The GPU device was disposed.' })));
      if (machine.state === 'failed' && !recovering) return Promise.resolve(err(lastError ?? GpuUnavailableError({ details: { surface: options.id } })));
      if (signal?.aborted === true) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          signal,
          onAbort: (): void => {
            waiters.delete(waiter);
            resolve(err(AbortedError({ cause: signal?.reason })));
          },
        };
        // sf-lint-disable-next-line no-bare-listener -- removed in settleWaiters() when the device settles, or fires once on abort
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        waiters.add(waiter);
      });
    },
    onLost(listener) {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    onRecovered(listener) {
      recoveredListeners.add(listener);
      return () => recoveredListeners.delete(listener);
    },
    recoveries: () => [...history],
    dispose() {
      if (machine.state === 'disposed') return;
      life.abort();
      send('dispose');
      const current = handle;
      handle = undefined;
      current?.destroy();
      settleWaiters(err(AbortedError({ message: 'The GPU device was disposed.' })));
      lostListeners.clear();
      recoveredListeners.clear();
    },
  };
  return device;
}

// ---------------------------------------------------------------- WebGPU provider (TypeScript-owned devices)

interface GpuAdapterLike {
  readonly features?: Iterable<string>;
  readonly limits?: object;
  readonly info?: object;
  requestDevice(descriptor?: { readonly label?: string; readonly requiredFeatures?: readonly string[]; readonly requiredLimits?: Record<string, number> }): Promise<GpuDeviceLike>;
}

interface GpuDeviceLike {
  readonly features?: Iterable<string>;
  readonly limits?: object;
  readonly lost: Promise<{ readonly reason: string; readonly message: string }>;
  destroy(): void;
}

export interface GpuLike {
  requestAdapter(options?: { readonly powerPreference?: 'high-performance' | 'low-power' }): Promise<GpuAdapterLike | null>;
}

export interface WebGpuProviderOptions {
  /** `navigator.gpu` (injected; tests pass testkit's `createFakeGpu().gpu`). */
  readonly gpu: GpuLike | undefined | null;
  readonly powerPreference?: 'high-performance' | 'low-power';
  readonly label?: string;
  /** Features to enable when the adapter has them. */
  readonly optionalFeatures?: readonly string[];
  /** Features without which the device is unusable (missing → SF-SURF-010). */
  readonly requiredFeatures?: readonly string[];
  /** Limits to request: `'adapter'` asks for everything the adapter offers (S1: Vello wants big textures). */
  readonly requiredLimits?: 'adapter' | Readonly<Record<string, number>>;
}

/** Numeric limits of a `GPUSupportedLimits`-like object (accessors live on the prototype). */
export function readGpuLimits(limits: object | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (limits === undefined) return out;
  const raw = limits as Record<string, unknown>;
  for (let proto: object | null = limits; proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || key in out) continue;
      const value = raw[key];
      if (typeof value === 'number') out[key] = value;
    }
  }
  return out;
}

/** A provider over `navigator.gpu`: a fresh adapter per acquire, facts from adapter and device. */
export function webGpuDeviceProvider(options: WebGpuProviderOptions): GpuDeviceProvider {
  return {
    async acquire({ signal }) {
      const gpu = options.gpu;
      if (gpu === undefined || gpu === null || typeof gpu.requestAdapter !== 'function') {
        return err(GpuUnavailableError({ message: 'navigator.gpu is not available.', details: { status: 'no-api' } }));
      }
      let adapter: GpuAdapterLike | null;
      try {
        adapter = await gpu.requestAdapter(options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference });
      } catch (cause) {
        return err(GpuUnavailableError({ cause, details: { status: 'no-adapter' } }));
      }
      if (adapter === null) return err(GpuUnavailableError({ message: 'requestAdapter() returned null.', details: { status: 'no-adapter' } }));
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      const adapterFacts = await describeGpuAdapter(adapter as Parameters<typeof describeGpuAdapter>[0]);
      const available = new Set(adapterFacts.features);
      const missing = (options.requiredFeatures ?? []).filter((f) => !available.has(f));
      if (missing.length > 0) {
        return err(GpuUnavailableError({ message: `The GPU adapter lacks required features: ${missing.join(', ')}.`, details: { status: 'missing-features', missing } }));
      }
      const features = [...new Set([...(options.requiredFeatures ?? []), ...(options.optionalFeatures ?? []).filter((f) => available.has(f))])];
      const requiredLimits = options.requiredLimits === 'adapter' ? adapterFacts.limits : options.requiredLimits;
      let raw: GpuDeviceLike;
      try {
        raw = await adapter.requestDevice({
          ...(options.label === undefined ? {} : { label: options.label }),
          ...(features.length === 0 ? {} : { requiredFeatures: features }),
          ...(requiredLimits === undefined ? {} : { requiredLimits: { ...requiredLimits } }),
        });
      } catch (cause) {
        return err(GpuUnavailableError({ cause, message: `requestDevice() failed: ${String((cause as Error)?.message ?? cause)}`, details: { status: 'request-device-failed' } }));
      }
      if (signal.aborted) {
        raw.destroy();
        return err(AbortedError({ cause: signal.reason }));
      }
      const facts: GpuDeviceFacts = { adapter: adapterFacts, features: [...(raw.features ?? [])].sort(), limits: readGpuLimits(raw.limits) };
      return ok({
        facts,
        device: raw,
        lost: raw.lost.then((info) => ({ reason: info.reason, message: info.message })),
        destroy: () => raw.destroy(),
      });
    },
  };
}
