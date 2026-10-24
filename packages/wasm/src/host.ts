/**
 * Loading and instantiating Wasm modules (R11.14, R11.15): resolve the selected
 * variant's source (loader chunk → URL, URL, inline bytes), fetch through an
 * injected port, compile with `compileStreaming` (fallback: `compile` from an
 * ArrayBuffer), instantiate with the imports factory, check exports, and expose
 * memory views. The handle's lifecycle is a typed machine; the unit's `init`
 * is "instantiate" (see units.ts).
 *
 * Main-thread instantiation is refused unless the module declares
 * `allowMainThread: { reason, budgetMs }`; then every exported function call is
 * timed and overruns are reported.
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
import type { ColumnSet, Layout, LayoutFields, StructView } from '@staticflux/worker';
import {
  WasmBudgetExceededError,
  WasmCompileError,
  WasmExportMissingError,
  WasmFetchError,
  WasmInstantiateError,
  WasmMainThreadError,
  WasmMemoryError,
  WasmNotReadyError,
  WasmUnsupportedError,
} from './errors.js';
import type { WasmFeatureFacts } from './features.js';
import {
  type SelectedWasmVariant,
  selectWasmVariant,
  usableFeatures,
  type WasmExports,
  type WasmImportContext,
  type WasmModuleDefinition,
  type WasmSource,
} from './module.js';

// ---------------------------------------------------------------- ports

/** The WebAssembly surface used here (default `globalThis.WebAssembly`). */
export interface WasmEngine {
  validate(bytes: BufferSource): boolean;
  compile(bytes: BufferSource): Promise<WebAssembly.Module>;
  compileStreaming?: ((source: Response | PromiseLike<Response>) => Promise<WebAssembly.Module>) | undefined;
  instantiate(module: WebAssembly.Module, imports?: WebAssembly.Imports): Promise<WebAssembly.Instance>;
  createMemory(descriptor: WebAssembly.MemoryDescriptor): WebAssembly.Memory;
}

export interface WasmFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type WasmFetch = (url: string, init: { readonly signal: AbortSignal; readonly mode: 'cors'; readonly credentials: 'same-origin' }) => Promise<WasmFetchResponse>;

/** Resolves loader chunk ids to URLs (bound by the loader's manifest). */
export interface WasmChunkResolver {
  url(chunk: string): Result<string>;
}

export type ThreadKind = 'main' | 'worker';

export interface WasmEnvironment {
  readonly engine: WasmEngine | undefined;
  readonly fetch: WasmFetch | undefined;
  readonly chunks: WasmChunkResolver | undefined;
  /** Where this code runs. Main-thread instantiation needs `allowMainThread`. */
  readonly thread: ThreadKind;
  readonly now: () => number;
}

interface WebAssemblyGlobal {
  validate(bytes: BufferSource): boolean;
  compile(bytes: BufferSource): Promise<WebAssembly.Module>;
  compileStreaming?: (source: Response | PromiseLike<Response>) => Promise<WebAssembly.Module>;
  instantiate(module: WebAssembly.Module, imports?: WebAssembly.Imports): Promise<WebAssembly.Instance>;
  Memory: new (descriptor: WebAssembly.MemoryDescriptor) => WebAssembly.Memory;
}

/** Wrap the platform `WebAssembly` object (undefined when absent). */
export function platformWasmEngine(globals: { WebAssembly?: unknown } = globalThis): WasmEngine | undefined {
  const wasm = globals.WebAssembly as WebAssemblyGlobal | undefined;
  if (wasm === undefined || typeof wasm.compile !== 'function') return undefined;
  return {
    validate: (bytes) => wasm.validate(bytes),
    compile: (bytes) => wasm.compile(bytes),
    compileStreaming: typeof wasm.compileStreaming === 'function' ? (source) => (wasm.compileStreaming as NonNullable<WebAssemblyGlobal['compileStreaming']>)(source) : undefined,
    instantiate: (module, imports) => wasm.instantiate(module, imports),
    createMemory: (descriptor) => new wasm.Memory(descriptor),
  };
}

/** `worker` inside a worker global scope (or no DOM), `main` where a `document` exists. */
export function detectThreadKind(globals: { document?: unknown; WorkerGlobalScope?: unknown } = globalThis as never): ThreadKind {
  if (typeof globals.WorkerGlobalScope === 'function') return 'worker';
  return globals.document === undefined ? 'worker' : 'main';
}

export function defaultWasmEnvironment(overrides: Partial<WasmEnvironment> = {}): WasmEnvironment {
  const fetchFn = (globalThis as { fetch?: WasmFetch }).fetch;
  return {
    engine: 'engine' in overrides ? overrides.engine : platformWasmEngine(),
    fetch: 'fetch' in overrides ? overrides.fetch : typeof fetchFn === 'function' ? fetchFn.bind(globalThis) : undefined,
    chunks: overrides.chunks,
    thread: overrides.thread ?? detectThreadKind(),
    now: overrides.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now())),
  };
}

// ---------------------------------------------------------------- lifecycle

export const WasmModuleLifecycle = defineMachine({
  id: 'wasm/module',
  initial: 'idle',
  states: ['idle', 'fetching', 'compiling', 'instantiating', 'ready', 'failed', 'disposed'],
  transitions: {
    idle: { fetch: 'fetching', compile: 'compiling', dispose: 'disposed' },
    fetching: { compile: 'compiling', fail: 'failed', dispose: 'disposed' },
    compiling: { instantiate: 'instantiating', fail: 'failed', dispose: 'disposed' },
    instantiating: { ready: 'ready', fail: 'failed', dispose: 'disposed' },
    ready: { dispose: 'disposed' },
    failed: { fetch: 'fetching', compile: 'compiling', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type WasmModuleState = (typeof WasmModuleLifecycle.states)[number];
type WasmModuleEvent = 'fetch' | 'compile' | 'instantiate' | 'ready' | 'fail' | 'dispose';

export const WasmMetrics = {
  moduleBytes: metric.gauge('wasm/module-bytes', { unit: 'By', description: 'Size of the loaded Wasm binary' }),
  compileTime: metric.histogram('wasm/compile-time', { unit: 'ms' }),
  instantiateTime: metric.histogram('wasm/instantiate-time', { unit: 'ms' }),
  mainThreadOverBudget: metric.counter('wasm/main-thread-over-budget', { description: 'Main-thread Wasm calls over budgetMs' }),
} as const;

// ---------------------------------------------------------------- handle

export interface LiveView<F extends LayoutFields> {
  /** The view, re-bound when memory grew (the old ArrayBuffer is detached by growth). */
  get(): Result<StructView<F>>;
}

export interface WasmModuleInspection {
  readonly id: string;
  readonly state: WasmModuleState;
  readonly variant: string | undefined;
  readonly thread: ThreadKind;
  readonly bytes: number | undefined;
  readonly compileMs: number | undefined;
  readonly instantiateMs: number | undefined;
  readonly streaming: boolean;
  readonly mainThreadOverruns: number;
  readonly error: Readonly<Record<string, unknown>> | undefined;
}

export interface WasmModuleHandle<E extends WasmExports> {
  readonly id: string;
  /** Reactive lifecycle state. */
  readonly state: WasmModuleState;
  readonly machine: Machine<WasmModuleState, WasmModuleEvent>;
  readonly variant: SelectedWasmVariant | undefined;
  /** Select, fetch, compile and instantiate (single-flight; retry after failure). */
  load(signal?: AbortSignal): Promise<Result<void>>;
  /** Exports (timed wrappers on the main thread). Throws SF-WASM-008 before `ready`. */
  readonly exports: E;
  /** The module memory (exported `memoryExport`, or the one made by `context.memory`). */
  memory(): Result<WebAssembly.Memory>;
  /** Struct view over linear memory at `ptr` (re-acquire after growth, or use `liveView`). */
  view<F extends LayoutFields>(layout: Layout<F>, ptr: number, count?: number): Result<StructView<F>>;
  liveView<F extends LayoutFields>(layout: Layout<F>, ptr: number, count?: number): LiveView<F>;
  /** SoA columns living in linear memory (R11.19). */
  columns<F extends LayoutFields>(layout: Layout<F>, ptr: number, capacity: number): Result<ColumnSet<F>>;
  bytes(ptr: number, length: number): Result<Uint8Array>;
  inspect(): WasmModuleInspection;
  dispose(): void;
}

export interface CreateWasmModuleOptions {
  readonly environment: WasmEnvironment;
  readonly facts: WasmFeatureFacts;
  readonly telemetry?: Telemetry;
}

const SUBSYSTEM = 'wasm/module';

export function createWasmModule<E extends WasmExports>(
  definition: WasmModuleDefinition<E>,
  options: CreateWasmModuleOptions,
): WasmModuleHandle<E> {
  const env = options.environment;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const machine = createMachine(WasmModuleLifecycle);
  let variant: SelectedWasmVariant | undefined;
  let exportsValue: E | undefined;
  let importedMemory: WebAssembly.Memory | undefined;
  let inflight: Promise<Result<void>> | undefined;
  let lastError: SfError | undefined;
  const stats = { bytes: undefined as number | undefined, compileMs: undefined as number | undefined, instantiateMs: undefined as number | undefined, streaming: false, overruns: 0 };

  const isDisposed = (): boolean => machine.state === 'disposed';
  const send = (event: WasmModuleEvent): void => {
    if (machine.can(event)) machine.send(event);
  };
  const disposedError = (): SfError => WasmNotReadyError({ message: `Wasm module "${definition.id}" was disposed.`, details: { module: definition.id } });

  const fail = (error: SfError): Result<never> => {
    lastError = error;
    send('fail');
    telemetry.event('wasm.load-failed', {
      subsystem: SUBSYSTEM,
      level: 'critical',
      attrs: { module: definition.id, code: error.code, variant: variant?.id ?? 'none' },
    });
    return err(error);
  };

  const resolveUrl = (source: Exclude<WasmSource, { bytes: BufferSource }>): Result<string> => {
    if ('url' in source) return ok(source.url);
    if (env.chunks === undefined) {
      return err(WasmFetchError({ message: `No chunk resolver bound for chunk "${source.chunk}".`, fix: 'Bind the loader manifest as `chunks` in the Wasm environment.', details: { chunk: source.chunk } }));
    }
    return env.chunks.url(source.chunk);
  };

  const checkSize = (bytes: number | undefined): void => {
    if (bytes === undefined) return;
    stats.bytes = bytes;
    telemetry.record(WasmMetrics.moduleBytes, bytes, { module: definition.id, variant: variant?.id ?? 'base' });
    const budget = definition.budget?.bytes;
    if (budget !== undefined && bytes > budget) {
      const error = WasmBudgetExceededError({ message: `Wasm module "${definition.id}" is ${bytes} bytes (budget ${budget}).`, details: { module: definition.id, bytes, budget } });
      telemetry.event('wasm.budget-exceeded', { subsystem: SUBSYSTEM, level: 'critical', attrs: { module: definition.id, code: error.code, bytes, budget, kind: 'bytes' } });
    }
  };

  const compileSource = async (engine: WasmEngine, source: WasmSource, signal: AbortSignal): Promise<Result<WebAssembly.Module>> => {
    const compileBytes = async (bytes: BufferSource): Promise<Result<WebAssembly.Module>> => {
      send('compile');
      try {
        return ok(await engine.compile(bytes));
      } catch (error) {
        return err(WasmCompileError({ cause: error, message: `Compiling "${definition.id}" failed: ${toSfError(error).message}`, details: { module: definition.id } }));
      }
    };
    if ('bytes' in source) {
      checkSize(source.bytes.byteLength);
      return compileBytes(source.bytes);
    }
    const url = resolveUrl(source);
    if (!url.ok) return url;
    if (env.fetch === undefined) return err(WasmFetchError({ message: 'No fetch port available.', details: { module: definition.id } }));
    send('fetch');
    let response: WasmFetchResponse;
    try {
      response = await env.fetch(url.value, { signal, mode: 'cors', credentials: 'same-origin' });
    } catch (error) {
      const sf = toSfError(error);
      return err(sf.kind === 'aborted' ? sf : WasmFetchError({ cause: error, details: { module: definition.id, url: url.value } }));
    }
    if (!response.ok) {
      return err(WasmFetchError({ message: `Fetching "${url.value}" failed with HTTP ${response.status}.`, details: { module: definition.id, url: url.value, status: response.status } }));
    }
    if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
    const contentType = response.headers.get('content-type') ?? '';
    const length = Number(response.headers.get('content-length') ?? Number.NaN);
    const streamable =
      engine.compileStreaming !== undefined &&
      contentType.split(';')[0]?.trim() === 'application/wasm' &&
      typeof Response === 'function' &&
      response instanceof Response;
    if (streamable) {
      if (Number.isFinite(length)) checkSize(length);
      send('compile');
      stats.streaming = true;
      try {
        return ok(await (engine.compileStreaming as NonNullable<WasmEngine['compileStreaming']>)(response as Response));
      } catch (error) {
        return err(WasmCompileError({ cause: error, message: `Streaming compile of "${definition.id}" failed: ${toSfError(error).message}`, details: { module: definition.id, url: url.value } }));
      }
    }
    // Fallback: wrong MIME type, no compileStreaming (older Safari), or a non-Response port.
    stats.streaming = false;
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      return err(WasmFetchError({ cause: error, details: { module: definition.id, url: url.value } }));
    }
    checkSize(buffer.byteLength);
    return compileBytes(buffer);
  };

  const timedExports = (raw: WebAssembly.Exports): E => {
    const allowance = definition.allowMainThread;
    if (env.thread !== 'main' || allowance === undefined) return raw as E;
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== 'function') {
        wrapped[name] = value;
        continue;
      }
      const fn = value as (...args: unknown[]) => unknown;
      wrapped[name] = (...args: unknown[]): unknown => {
        const start = env.now();
        try {
          return fn(...args);
        } finally {
          const elapsed = env.now() - start;
          if (elapsed > allowance.budgetMs) {
            stats.overruns += 1;
            telemetry.record(WasmMetrics.mainThreadOverBudget, 1, { module: definition.id, export: name });
            telemetry.event('wasm.main-thread-over-budget', {
              subsystem: SUBSYSTEM,
              level: 'critical',
              attrs: { module: definition.id, export: name, elapsedMs: elapsed, budgetMs: allowance.budgetMs, code: WasmBudgetExceededError.code },
            });
          }
        }
      };
    }
    return Object.freeze(wrapped) as E;
  };

  const run = async (signal: AbortSignal): Promise<Result<void>> => {
    const span = telemetry.span('wasm.load', { subsystem: SUBSYSTEM, attrs: { module: definition.id, thread: env.thread } });
    const finish = (result: Result<void>): Result<void> => {
      if (result.ok) span.end('ok');
      else span.end(result.error.kind === 'aborted' ? 'cancelled' : 'error', result.error);
      return result;
    };
    if (env.thread === 'main' && definition.allowMainThread === undefined) {
      return finish(fail(WasmMainThreadError({ details: { module: definition.id } })));
    }
    const engine = env.engine;
    if (engine === undefined || !options.facts.supported) return finish(fail(WasmUnsupportedError({ details: { module: definition.id } })));
    const selected = selectWasmVariant(definition, options.facts);
    if (!selected.ok) return finish(fail(selected.error));
    variant = selected.value;
    span.set('variant', variant.id);

    const compileStart = env.now();
    const compiled = await compileSource(engine, variant.source, signal);
    if (isDisposed()) return finish(err(disposedError()));
    if (signal.aborted) return finish(fail(AbortedError({ cause: signal.reason })));
    if (!compiled.ok) return finish(fail(compiled.error));
    stats.compileMs = env.now() - compileStart;
    telemetry.record(WasmMetrics.compileTime, stats.compileMs, { module: definition.id, variant: variant.id, streaming: stats.streaming });
    const compileBudget = definition.budget?.compileMs;
    if (compileBudget !== undefined && stats.compileMs > compileBudget) {
      telemetry.event('wasm.budget-exceeded', { subsystem: SUBSYSTEM, level: 'critical', attrs: { module: definition.id, kind: 'compile', ms: stats.compileMs, budget: compileBudget, code: WasmBudgetExceededError.code } });
    }

    send('instantiate');
    const chosen = variant;
    const context: WasmImportContext = {
      variant: chosen,
      features: usableFeatures(definition, chosen, options.facts),
      memory(descriptor) {
        importedMemory = engine.createMemory({
          initial: descriptor.initial,
          ...(descriptor.maximum === undefined ? {} : { maximum: descriptor.maximum }),
          ...(chosen.threads ? { shared: true, maximum: descriptor.maximum ?? descriptor.initial } : {}),
        });
        return importedMemory;
      },
    };
    const instantiateStart = env.now();
    let instance: WebAssembly.Instance;
    try {
      const imports = definition.imports?.(context) ?? {};
      instance = await engine.instantiate(compiled.value, imports);
    } catch (error) {
      return finish(fail(WasmInstantiateError({ cause: error, message: `Instantiating "${definition.id}" failed: ${toSfError(error).message}`, details: { module: definition.id, variant: chosen.id } })));
    }
    if (isDisposed()) return finish(err(disposedError()));
    stats.instantiateMs = env.now() - instantiateStart;
    telemetry.record(WasmMetrics.instantiateTime, stats.instantiateMs, { module: definition.id, variant: chosen.id });
    const missing = (definition.exports ?? []).filter((name) => !(name in instance.exports));
    if (missing.length > 0) {
      return finish(fail(WasmExportMissingError({ message: `"${definition.id}" does not export: ${missing.join(', ')}.`, details: { module: definition.id, missing } })));
    }
    exportsValue = timedExports(instance.exports);
    lastError = undefined;
    send('ready');
    return finish(ok());
  };

  const memoryOf = (): Result<WebAssembly.Memory> => {
    if (machine.state !== 'ready' || exportsValue === undefined) return err(WasmNotReadyError({ details: { module: definition.id } }));
    const exported = (exportsValue as Record<string, unknown>)[definition.memoryExport ?? 'memory'];
    if (typeof exported === 'object' && exported !== null && 'buffer' in exported) return ok(exported as WebAssembly.Memory);
    if (importedMemory !== undefined) return ok(importedMemory);
    return err(WasmMemoryError({ message: `"${definition.id}" has no memory export "${definition.memoryExport ?? 'memory'}".`, details: { module: definition.id } }));
  };

  const handle: WasmModuleHandle<E> = {
    id: definition.id,
    machine,
    get state() {
      return machine.state;
    },
    get variant() {
      return variant;
    },
    load(signal = new AbortController().signal) {
      if (machine.state === 'ready') return Promise.resolve(ok());
      if (machine.state === 'disposed') return Promise.resolve(err(disposedError()));
      if (signal.aborted) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      inflight ??= run(signal).finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    get exports(): E {
      if (machine.state !== 'ready' || exportsValue === undefined) throw WasmNotReadyError({ details: { module: definition.id, state: machine.state } });
      return exportsValue;
    },
    memory: memoryOf,
    view(layout, ptr, count = 1) {
      const memory = memoryOf();
      if (!memory.ok) return memory;
      return layout.view(memory.value.buffer, { byteOffset: ptr, count });
    },
    liveView<F extends LayoutFields>(layout: Layout<F>, ptr: number, count = 1): LiveView<F> {
      let cached: StructView<F> | undefined;
      return {
        get() {
          const memory = memoryOf();
          if (!memory.ok) return memory;
          if (cached !== undefined && cached.buffer === memory.value.buffer) return ok(cached);
          const view = layout.view(memory.value.buffer, { byteOffset: ptr, count });
          if (view.ok) cached = view.value;
          return view;
        },
      };
    },
    columns(layout, ptr, capacity) {
      const memory = memoryOf();
      if (!memory.ok) return memory;
      return layout.columns({ capacity, buffer: memory.value.buffer, byteOffset: ptr });
    },
    bytes(ptr, length) {
      const memory = memoryOf();
      if (!memory.ok) return memory;
      const buffer = memory.value.buffer;
      if (!Number.isInteger(ptr) || !Number.isInteger(length) || ptr < 0 || length < 0 || ptr + length > buffer.byteLength) {
        return err(WasmMemoryError({ details: { module: definition.id, ptr, length, memoryBytes: buffer.byteLength } }));
      }
      return ok(new Uint8Array(buffer, ptr, length));
    },
    inspect: () => ({
      id: definition.id,
      state: machine.state,
      variant: variant?.id,
      thread: env.thread,
      bytes: stats.bytes,
      compileMs: stats.compileMs,
      instantiateMs: stats.instantiateMs,
      streaming: stats.streaming,
      mainThreadOverruns: stats.overruns,
      error: lastError?.toJSON(),
    }),
    dispose() {
      send('dispose');
      exportsValue = undefined;
      importedMemory = undefined;
    },
  };
  return handle;
}
