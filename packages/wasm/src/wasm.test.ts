import { createInjector, createMemorySink, createTelemetry, err, ok, token, unwrap } from '@staticflux/core';
import { isolationFactsUnit } from '@staticflux/worker';
import { defineLayout } from '@staticflux/worker/channels';
import { describe, expect, it } from 'vitest';
import {
  createWasmModule,
  defaultWasmEnvironment,
  defineWasmModule,
  describeWasmModule,
  detectThreadKind,
  detectWasmFeatures,
  platformWasmEngine,
  selectWasmVariant,
  usableFeatures,
  WASM_FEATURES,
  WasmCompileError,
  type WasmEnvironment,
  WasmEnvironmentToken,
  wasmEnvironmentUnit,
  WasmExportMissingError,
  type WasmExports,
  type WasmExportsOf,
  type WasmFeatureFacts,
  WasmFeatureMissingError,
  WasmFeaturesToken,
  wasmFeaturesUnit,
  wasmFeatureUsable,
  WasmFetchError,
  type WasmFetchResponse,
  WasmInstantiateError,
  WasmMainThreadError,
  WasmMemoryError,
  type WasmModuleHandle,
  wasmModuleUnit,
  WasmNotReadyError,
  WasmThreadsNeedIsolationError,
  WasmUnsupportedError,
} from './index.js';

// (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add) (memory (export "memory") 1))
const ADD_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 0x10, 2, 3, 0x61, 0x64, 0x64, 0, 0,
  6, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 2, 0, 0x0a, 9, 1, 7, 0, 0x20, 0, 0x20, 1, 0x6a, 0x0b,
]);

// (module (import "env" "log" (func (param i32))) (func (export "run") i32.const 42 call 0))
const LOG_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 2, 0x60, 1, 0x7f, 0, 0x60, 0, 0, 2, 0x0b, 1, 3, 0x65, 0x6e, 0x76, 3, 0x6c, 0x6f, 0x67, 0, 0, 3, 2,
  1, 1, 7, 7, 1, 3, 0x72, 0x75, 0x6e, 0, 1, 0x0a, 8, 1, 6, 0, 0x41, 0x2a, 0x10, 0, 0x0b,
]);

// (module (import "env" "memory" (memory 1)) (func (export "load") (param i32) (result i32) local.get 0 i32.load))
const LOAD_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 2, 0x0f, 1, 3, 0x65, 0x6e, 0x76, 6, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,
  2, 0, 1, 3, 2, 1, 0, 7, 8, 1, 4, 0x6c, 0x6f, 0x61, 0x64, 0, 0, 0x0a, 9, 1, 7, 0, 0x20, 0, 0x28, 2, 0, 0x0b,
]);

type AddExports = { add(a: number, b: number): number; memory: WebAssembly.Memory };

const isolated = { crossOriginIsolated: true } as const;
const notIsolated = { crossOriginIsolated: false } as const;

function facts(overrides: Partial<Record<(typeof WASM_FEATURES)[number], boolean>> = {}, sharedMemory = false): WasmFeatureFacts {
  return {
    supported: true,
    engine: { simd: true, threads: true, memory64: true, exceptions: true, gc: true, ...overrides },
    sharedMemory,
  };
}

function env(overrides: Partial<WasmEnvironment> = {}): WasmEnvironment {
  return defaultWasmEnvironment({ thread: 'worker', fetch: undefined, ...overrides });
}

/** happy-dom swaps the global Response, which Node's compileStreaming rejects: stream via the body instead. */
const streamed: unknown[] = [];
function streamingEngine(): NonNullable<ReturnType<typeof platformWasmEngine>> {
  const base = platformWasmEngine() as NonNullable<ReturnType<typeof platformWasmEngine>>;
  return {
    ...base,
    compileStreaming: async (source) => {
      const resolved = await source;
      streamed.push(resolved);
      return base.compile(await resolved.arrayBuffer());
    },
  };
}

const allFacts = (): WasmFeatureFacts => detectWasmFeatures({ isolation: notIsolated });

function response(bytes: Uint8Array, headers: Record<string, string> = {}, status = 200): WasmFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer as ArrayBuffer),
  };
}

// ---------------------------------------------------------------- features

describe('feature facts', () => {
  it('detects engine features with validate() probes (all supported in Node 22)', () => {
    const detected = detectWasmFeatures({ isolation: notIsolated });
    expect(detected.supported).toBe(true);
    for (const feature of WASM_FEATURES) expect(detected.engine[feature]).toBe(true);
    expect(detected.sharedMemory).toBe(false);
    expect(wasmFeatureUsable(detected, 'threads')).toBe(false);
    expect(wasmFeatureUsable(detected, 'simd')).toBe(true);
    const isolatedFacts = detectWasmFeatures({ isolation: isolated });
    expect(isolatedFacts.sharedMemory).toBe(true);
    expect(wasmFeatureUsable(isolatedFacts, 'threads')).toBe(true);
  });

  it('maps validate() results, throwing probes, and missing engines', () => {
    const seen: number[] = [];
    const partial = detectWasmFeatures({
      engine: {
        validate: (bytes) => {
          const length = (bytes as Uint8Array).byteLength;
          seen.push(length);
          if (length === 13) throw new Error('boom'); // memory64 probe
          return length !== 31; // simd probe
        },
      },
      isolation: isolated,
    });
    expect(partial.engine).toEqual({ simd: false, threads: true, memory64: false, exceptions: true, gc: true });
    expect(seen).toHaveLength(5);
    expect(detectWasmFeatures({ engine: undefined, isolation: isolated }).supported).toBe(false);
    const noSab = detectWasmFeatures({ isolation: isolated, globals: { crossOriginIsolated: true, Atomics } });
    expect(noSab.engine.threads).toBe(false);
    expect(noSab.sharedMemory).toBe(false);
    expect(wasmFeatureUsable({ ...facts(), supported: false }, 'simd')).toBe(false);
  });

  it('detects the thread kind', () => {
    expect(detectThreadKind({ document: {} })).toBe('main');
    expect(detectThreadKind({})).toBe('worker');
    expect(detectThreadKind({ document: {}, WorkerGlobalScope: function WorkerGlobalScope() {} })).toBe('worker');
    expect(platformWasmEngine({})).toBeUndefined();
    expect(platformWasmEngine()?.validate(ADD_WASM)).toBe(true);
  });
});

// ---------------------------------------------------------------- variants

describe('variant selection', () => {
  const Physics = defineWasmModule<AddExports>({
    id: 'test/physics',
    source: { chunk: 'wasm:physics' },
    features: { optional: ['exceptions'] },
    variants: [
      { id: 'mt-simd', source: { chunk: 'wasm:physics-mt-simd' }, requires: ['threads', 'simd'] },
      { id: 'simd', source: { chunk: 'wasm:physics-simd' }, requires: ['simd'] },
    ],
    budget: { bytes: 1000 },
    warmup: 'idle',
  });

  it('picks the first usable variant in preference order', () => {
    expect(unwrap(selectWasmVariant(Physics, facts({}, true))).id).toBe('mt-simd');
    expect(unwrap(selectWasmVariant(Physics, facts({}, false))).id).toBe('simd'); // not isolated → no threads
    const scalar = unwrap(selectWasmVariant(Physics, facts({ simd: false }, true)));
    expect(scalar).toMatchObject({ id: 'base', threads: false, source: { chunk: 'wasm:physics' } });
    expect(unwrap(selectWasmVariant(Physics, facts({}, true))).threads).toBe(true);
  });

  it('fails with a typed error and fix when no variant can run', () => {
    const ThreadsOnly = defineWasmModule({ id: 'test/mt', source: { bytes: ADD_WASM }, features: { required: ['threads'] } });
    const needsIsolation = selectWasmVariant(ThreadsOnly, facts({}, false));
    expect(needsIsolation.ok ? undefined : needsIsolation.error.code).toBe(WasmThreadsNeedIsolationError.code);
    expect(needsIsolation.ok ? undefined : needsIsolation.error.fix).toContain('COOP');
    const engineLacks = selectWasmVariant(ThreadsOnly, facts({ threads: false }, true));
    expect(engineLacks.ok ? undefined : engineLacks.error.code).toBe(WasmFeatureMissingError.code);
    const Gc = defineWasmModule({ id: 'test/gc', source: { bytes: ADD_WASM }, features: { required: ['gc'] } });
    const missing = selectWasmVariant(Gc, facts({ gc: false }));
    expect(missing.ok ? undefined : missing.error.details).toMatchObject({ missing: ['gc'], tried: ['base'] });
    const unsupported = selectWasmVariant(Gc, { ...facts(), supported: false });
    expect(unsupported.ok ? undefined : unsupported.error.code).toBe(WasmUnsupportedError.code);
  });

  it('reports usable features (required + available optional) and a chunk manifest entry', () => {
    const selected = unwrap(selectWasmVariant(Physics, facts({}, false)));
    expect(usableFeatures(Physics, selected, facts({}, false))).toEqual({
      simd: true,
      threads: false,
      memory64: false,
      exceptions: true,
      gc: false,
    });
    expect(usableFeatures(Physics, selected, facts({ exceptions: false })).exceptions).toBe(false);
    expect(describeWasmModule(Physics)).toEqual({
      id: 'test/physics',
      budgetCategory: 'wasm',
      warmup: 'idle',
      chunks: ['wasm:physics', 'wasm:physics-mt-simd', 'wasm:physics-simd'],
      budgetBytes: 1000,
      mainThread: undefined,
      variants: [
        { id: 'mt-simd', requires: ['threads', 'simd'] },
        { id: 'simd', requires: ['simd'] },
        { id: 'base', requires: [] },
      ],
    });
    expect(describeWasmModule(defineWasmModule({ id: 'test/inline', source: { url: '/a.wasm' } })).chunks).toEqual([]);
  });
});

// ---------------------------------------------------------------- loading & instantiation

describe('createWasmModule', () => {
  const Add = defineWasmModule<AddExports>({ id: 'test/add', source: { bytes: ADD_WASM }, exports: ['add', 'memory'] });

  it('compiles and instantiates inline bytes; walks the lifecycle', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const handle = createWasmModule(Add, { environment: env(), facts: allFacts(), telemetry });
    const states: string[] = [];
    handle.machine.onTransition((r) => states.push(r.to));
    expect(handle.state).toBe('idle');
    expect(() => handle.exports).toThrow(expect.objectContaining({ code: WasmNotReadyError.code }));
    const first = handle.load();
    expect(handle.load()).toBe(first); // single-flight
    expect((await first).ok).toBe(true);
    expect(states).toEqual(['compiling', 'instantiating', 'ready']);
    expect(handle.exports.add(2, 3)).toBe(5);
    expect(handle.variant?.id).toBe('base');
    expect((await handle.load()).ok).toBe(true);
    expect(handle.inspect()).toMatchObject({ id: 'test/add', state: 'ready', variant: 'base', bytes: ADD_WASM.byteLength, streaming: false });
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'wasm.load' && r.status === 'ok')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'wasm/module-bytes' && r.value === ADD_WASM.byteLength)).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'wasm/compile-time')).toBe(true);
    handle.dispose();
    expect(handle.state).toBe('disposed');
    expect(() => handle.exports).toThrow();
    expect((await handle.load()).ok).toBe(false);
    expect(handle.memory().ok).toBe(false);
  });

  it('exposes layout views, columns and bytes over linear memory, re-bound after growth', async () => {
    const handle = createWasmModule(Add, { environment: env(), facts: allFacts() });
    unwrap(await handle.load());
    const Vec = defineLayout({ name: 'Vec', fields: { x: 'f32', y: 'f32', id: 'u32' } });
    const view = unwrap(handle.view(Vec, 64, 4));
    view.at(1).id = 99;
    const memory = unwrap(handle.memory());
    expect(new Uint32Array(memory.buffer, 64 + Vec.stride + 8, 1)[0]).toBe(99);
    expect(Array.from(unwrap(handle.bytes(64 + Vec.stride + 8, 1)))).toEqual([99]);
    expect(handle.bytes(65_530, 100).ok).toBe(false);
    const negative = handle.bytes(-1, 1);
    expect(negative.ok ? undefined : negative.error.code).toBe(WasmMemoryError.code);
    expect(handle.view(Vec, 65_536, 1).ok).toBe(false);

    const live = handle.liveView(Vec, 64, 4);
    const before = unwrap(live.get());
    expect(unwrap(live.get())).toBe(before); // cached while memory is unchanged
    memory.grow(1);
    const after = unwrap(live.get());
    expect(after).not.toBe(before);
    expect(after.get(1, 'id')).toBe(99);
    expect(after.buffer.byteLength).toBe(2 * 65_536);

    const Column = defineLayout({ fields: { x: 'f64', flags: 'u8' } });
    const cols = unwrap(handle.columns(Column, 1024, 8));
    cols.column('x')[2] = 4.5;
    expect(new Float64Array(unwrap(handle.memory()).buffer, 1024, 8)[2]).toBe(4.5);
    handle.dispose();
    expect(live.get().ok).toBe(false);
    expect(handle.view(Vec, 0).ok).toBe(false);
    expect(handle.columns(Column, 0, 1).ok).toBe(false);
    expect(handle.bytes(0, 1).ok).toBe(false);
  });

  it('builds imports from the factory (context.memory) and uses an imported memory for views', async () => {
    const logged: number[] = [];
    const Log = defineWasmModule<{ run(): void }>({
      id: 'test/log',
      source: { bytes: LOG_WASM },
      imports: () => ({ env: { log: (value: number) => logged.push(value) } }),
    });
    const log = createWasmModule(Log, { environment: env(), facts: allFacts() });
    unwrap(await log.load());
    log.exports.run();
    expect(logged).toEqual([42]);
    const noMemory = log.memory();
    expect(noMemory.ok ? undefined : noMemory.error.code).toBe(WasmMemoryError.code);

    const contexts: unknown[] = [];
    const Load = defineWasmModule<{ load(ptr: number): number }>({
      id: 'test/load',
      source: { bytes: LOAD_WASM },
      imports: (context) => {
        contexts.push(context.features);
        return { env: { memory: context.memory({ initial: 1, maximum: 2 }) } };
      },
    });
    const load = createWasmModule(Load, { environment: env(), facts: allFacts() });
    unwrap(await load.load());
    new Uint32Array(unwrap(load.memory()).buffer)[4] = 1234;
    expect(load.exports.load(16)).toBe(1234);
    expect(contexts).toHaveLength(1);
  });

  it('creates shared memory for threaded variants', async () => {
    let shared: unknown;
    const threadFlags: boolean[] = [];
    const Threads = defineWasmModule<AddExports>({
      id: 'test/threads',
      source: { bytes: ADD_WASM },
      variants: [{ id: 'mt', source: { bytes: ADD_WASM }, requires: ['threads'] }],
      imports: (context) => {
        shared = context.memory({ initial: 1, maximum: 4 }).buffer;
        threadFlags.push(context.variant.threads, context.features.threads);
        return {};
      },
    });
    const handle = createWasmModule(Threads, { environment: env(), facts: detectWasmFeatures({ isolation: isolated }) });
    unwrap(await handle.load());
    expect(handle.variant?.id).toBe('mt');
    expect(shared).toBeInstanceOf(SharedArrayBuffer);
    // Not isolated: the non-threaded base build is used; no feature-code change.
    const fallback = createWasmModule(Threads, { environment: env(), facts: detectWasmFeatures({ isolation: notIsolated }) });
    unwrap(await fallback.load());
    expect(fallback.variant?.id).toBe('base');
    expect(shared).toBeInstanceOf(ArrayBuffer);
    expect(threadFlags).toEqual([true, true, false, false]);
  });

  it('fails instantiation with SF-WASM-006 when imports are missing, and SF-WASM-009 for missing exports', async () => {
    const NoImports = defineWasmModule({ id: 'test/no-imports', source: { bytes: LOG_WASM } });
    const handle = createWasmModule(NoImports, { environment: env(), facts: allFacts() });
    const result = await handle.load();
    expect(result.ok ? undefined : result.error.code).toBe(WasmInstantiateError.code);
    expect(handle.state).toBe('failed');
    expect(handle.inspect().error).toMatchObject({ code: WasmInstantiateError.code });

    const Missing = defineWasmModule<{ sub(): number }>({ id: 'test/missing', source: { bytes: ADD_WASM }, exports: ['sub'] });
    const missing = await createWasmModule(Missing, { environment: env(), facts: allFacts() }).load();
    expect(missing.ok ? undefined : missing.error.details).toMatchObject({ missing: ['sub'] });
    expect(missing.ok ? undefined : missing.error.code).toBe(WasmExportMissingError.code);
  });

  it('fails compilation with SF-WASM-005 and can retry after failure', async () => {
    let bytes: Uint8Array = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 99]);
    const Broken = defineWasmModule({ id: 'test/broken', source: { url: '/broken.wasm' } });
    const handle = createWasmModule(Broken, { environment: env({ fetch: () => Promise.resolve(response(bytes)) }), facts: allFacts() });
    const first = await handle.load();
    expect(first.ok ? undefined : first.error.code).toBe(WasmCompileError.code);
    expect(handle.state).toBe('failed');
    bytes = ADD_WASM;
    expect((await handle.load()).ok).toBe(true);
    expect(handle.state).toBe('ready');
  });

  it('refuses the main thread without allowMainThread (SF-WASM-007)', async () => {
    const handle = createWasmModule(Add, { environment: env({ thread: 'main' }), facts: allFacts() });
    const result = await handle.load();
    expect(result.ok ? undefined : result.error.code).toBe(WasmMainThreadError.code);
  });

  it('times main-thread calls against budgetMs when allowed', async () => {
    let now = 0;
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const Tiny = defineWasmModule<AddExports>({
      id: 'test/tiny',
      source: { bytes: ADD_WASM },
      allowMainThread: { reason: 'checksum of a 16-byte id on input', budgetMs: 1 },
    });
    const handle = createWasmModule(Tiny, { environment: env({ thread: 'main', now: () => now }), facts: allFacts(), telemetry });
    unwrap(await handle.load());
    expect(handle.exports.add(1, 1)).toBe(2);
    expect(handle.inspect().mainThreadOverruns).toBe(0);
    const add = handle.exports.add;
    now = 0;
    const slowNow = (): number => (now += 5);
    const slow = createWasmModule(Tiny, { environment: env({ thread: 'main', now: slowNow }), facts: allFacts(), telemetry });
    unwrap(await slow.load());
    slow.exports.add(1, 2);
    expect(slow.inspect().mainThreadOverruns).toBe(1);
    expect(slow.exports.memory).toBeDefined(); // non-functions pass through
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'wasm.main-thread-over-budget')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'wasm/main-thread-over-budget')).toBe(true);
    expect(typeof add).toBe('function');
  });

  it('fails when WebAssembly is missing (SF-WASM-001)', async () => {
    const handle = createWasmModule(Add, { environment: env({ engine: undefined }), facts: allFacts() });
    const result = await handle.load();
    expect(result.ok ? undefined : result.error.code).toBe(WasmUnsupportedError.code);
    const variantless = createWasmModule(
      defineWasmModule({ id: 'test/gc-only', source: { bytes: ADD_WASM }, features: { required: ['gc'] } }),
      { environment: env(), facts: facts({ gc: false }) },
    );
    expect((await variantless.load()).ok).toBe(false);
  });
});

describe('fetching', () => {
  it('compiles with compileStreaming for application/wasm Responses', async () => {
    const Remote = defineWasmModule<AddExports>({ id: 'test/remote', source: { url: 'https://cdn.example/add.wasm' } });
    const requests: { url: string; mode: string; credentials: string }[] = [];
    const handle = createWasmModule(Remote, {
      environment: env({
        engine: streamingEngine(),
        fetch: (url, init) => {
          requests.push({ url, mode: init.mode, credentials: init.credentials });
          return Promise.resolve(
            new Response(ADD_WASM, { headers: { 'content-type': 'application/wasm; charset=binary', 'content-length': String(ADD_WASM.byteLength) } }),
          );
        },
      }),
      facts: allFacts(),
    });
    const states: string[] = [];
    handle.machine.onTransition((r) => states.push(r.to));
    unwrap(await handle.load());
    expect(handle.exports.add(20, 22)).toBe(42);
    expect(handle.inspect()).toMatchObject({ streaming: true, bytes: ADD_WASM.byteLength });
    expect(states).toEqual(['fetching', 'compiling', 'instantiating', 'ready']);
    expect(requests).toEqual([{ url: 'https://cdn.example/add.wasm', mode: 'cors', credentials: 'same-origin' }]);
    expect(streamed).toHaveLength(1);
  });

  it('falls back to compile(arrayBuffer) for a wrong MIME type or a non-Response port', async () => {
    const Remote = defineWasmModule<AddExports>({ id: 'test/remote2', source: { url: '/add.wasm' } });
    const wrongMime = createWasmModule(Remote, {
      environment: env({ engine: streamingEngine(), fetch: () => Promise.resolve(new Response(ADD_WASM, { headers: { 'content-type': 'application/octet-stream' } })) }),
      facts: allFacts(),
    });
    const before = streamed.length;
    unwrap(await wrongMime.load());
    expect(wrongMime.inspect().streaming).toBe(false);
    expect(streamed.length).toBe(before);
    const noStreaming = createWasmModule(Remote, {
      environment: env({
        engine: { ...(platformWasmEngine() as NonNullable<ReturnType<typeof platformWasmEngine>>), compileStreaming: undefined },
        fetch: () => Promise.resolve(response(ADD_WASM, { 'content-type': 'application/wasm' })),
      }),
      facts: allFacts(),
    });
    unwrap(await noStreaming.load());
    expect(noStreaming.exports.add(1, 2)).toBe(3);
  });

  it('reports streaming compile errors', async () => {
    const Remote = defineWasmModule({ id: 'test/remote3', source: { url: '/bad.wasm' } });
    const handle = createWasmModule(Remote, {
      environment: env({
        engine: streamingEngine(),
        fetch: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/wasm' } })),
      }),
      facts: allFacts(),
    });
    const result = await handle.load();
    expect(result.ok ? undefined : result.error.code).toBe(WasmCompileError.code);
  });

  it('resolves loader chunks through the chunk resolver', async () => {
    const Chunked = defineWasmModule<AddExports>({ id: 'test/chunked', source: { chunk: 'wasm:add' } });
    const urls: string[] = [];
    const handle = createWasmModule(Chunked, {
      environment: env({
        chunks: { url: (chunk) => (chunk === 'wasm:add' ? ok('/assets/add.123.wasm') : err(WasmFetchError())) },
        fetch: (url) => {
          urls.push(url);
          return Promise.resolve(response(ADD_WASM));
        },
      }),
      facts: allFacts(),
    });
    unwrap(await handle.load());
    expect(urls).toEqual(['/assets/add.123.wasm']);
    const unresolved = await createWasmModule(Chunked, { environment: env({ fetch: () => Promise.resolve(response(ADD_WASM)) }), facts: allFacts() }).load();
    expect(unresolved.ok ? undefined : unresolved.error.code).toBe(WasmFetchError.code);
  });

  it('maps HTTP errors, network errors, missing fetch, body errors and aborts', async () => {
    const Remote = defineWasmModule({ id: 'test/net', source: { url: '/x.wasm' } });
    const make = (fetch: WasmEnvironment['fetch']): WasmModuleHandle<WasmExports> =>
      createWasmModule(Remote, { environment: env({ fetch }), facts: allFacts() });
    const notFound = await make(() => Promise.resolve(response(ADD_WASM, {}, 404))).load();
    expect(notFound.ok ? undefined : notFound.error.details).toMatchObject({ status: 404 });
    const network = await make(() => Promise.reject(new TypeError('Failed to fetch'))).load();
    expect(network.ok ? undefined : network.error.code).toBe(WasmFetchError.code);
    const noFetch = await make(undefined).load();
    expect(noFetch.ok ? undefined : noFetch.error.code).toBe(WasmFetchError.code);
    const badBody = await make(() => Promise.resolve({ ...response(ADD_WASM), arrayBuffer: () => Promise.reject(new Error('reset')) })).load();
    expect(badBody.ok ? undefined : badBody.error.code).toBe(WasmFetchError.code);

    const controller = new AbortController();
    const aborting = await make(() => {
      controller.abort();
      return Promise.resolve(response(ADD_WASM));
    }).load(controller.signal);
    expect(aborting.ok ? undefined : aborting.error.kind).toBe('aborted');
    const abortedFetch = await make(() => Promise.reject(new DOMException('aborted', 'AbortError'))).load();
    expect(abortedFetch.ok ? undefined : abortedFetch.error.kind).toBe('aborted');
    const pre = new AbortController();
    pre.abort();
    expect((await make(() => Promise.resolve(response(ADD_WASM))).load(pre.signal)).ok).toBe(false);
  });

  it('reports size and compile-time budget overruns', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    let now = 0;
    const Big = defineWasmModule({ id: 'test/big', source: { bytes: ADD_WASM }, budget: { bytes: 10, compileMs: 1 } });
    const handle = createWasmModule(Big, { environment: env({ now: () => (now += 10) }), facts: allFacts(), telemetry });
    unwrap(await handle.load());
    const events = sink.records.filter((r) => r.type === 'event' && r.name === 'wasm.budget-exceeded');
    expect(events.map((e) => (e.type === 'event' ? e.attrs.kind : undefined))).toEqual(['bytes', 'compile']);
  });

  it('stops when disposed during loading', async () => {
    let release: (r: WasmFetchResponse) => void = () => undefined;
    const Remote = defineWasmModule({ id: 'test/slow', source: { url: '/slow.wasm' } });
    const handle = createWasmModule(Remote, {
      environment: env({ fetch: () => new Promise((resolve) => (release = resolve)) }),
      facts: allFacts(),
    });
    const loading = handle.load();
    await Promise.resolve();
    handle.dispose();
    release(response(ADD_WASM));
    const result = await loading;
    expect(result.ok ? undefined : result.error.code).toBe(WasmNotReadyError.code);
    expect(handle.state).toBe('disposed');
  });
});

// ---------------------------------------------------------------- units

describe('units', () => {
  it('provides a worker-scoped module whose init instantiates it', async () => {
    const Add = defineWasmModule<AddExports>({ id: 'test/add-unit', source: { bytes: ADD_WASM } });
    const AddToken = token('test/add').type<WasmModuleHandle<WasmExportsOf<typeof Add>>>();
    const injector = createInjector({
      units: [
        isolationFactsUnit({ globals: { crossOriginIsolated: false } }),
        wasmEnvironmentUnit({ thread: 'worker' }),
        wasmFeaturesUnit(),
        wasmModuleUnit({ id: 'test/add-unit', provides: AddToken, module: Add }),
      ],
    });
    const handle = unwrap(await injector.get(AddToken));
    expect(handle.state).toBe('ready');
    expect(handle.exports.add(4, 5)).toBe(9);
    expect(unwrap(await injector.get(WasmFeaturesToken)).sharedMemory).toBe(false);
    expect(unwrap(await injector.get(WasmEnvironmentToken)).thread).toBe('worker');
    await injector.dispose();
    expect(handle.state).toBe('disposed');
  });

  it('fails the unit when the module may not run here', async () => {
    const Add = defineWasmModule<AddExports>({ id: 'test/add-main', source: { bytes: ADD_WASM }, budget: { compileMs: 50 } });
    const AddToken = token('test/add-main').type<WasmModuleHandle<AddExports>>();
    const injector = createInjector({
      units: [
        isolationFactsUnit(),
        wasmEnvironmentUnit({ thread: 'main' }),
        wasmFeaturesUnit(),
        wasmModuleUnit({ id: 'test/add-main-unit', provides: AddToken, module: Add, critical: false }),
      ],
    });
    const result = await injector.get(AddToken);
    expect(result.ok).toBe(false);
    await injector.dispose();
  });
});
