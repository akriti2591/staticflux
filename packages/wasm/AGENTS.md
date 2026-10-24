# @staticflux/wasm — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core`, `@staticflux/worker`).
**Budget:** not on the boot path; ships in the worker bundle that hosts the module (~4.9 KB brotli for the whole
package). Wasm binaries are their own budget category (`budget.bytes`, `describeWasmModule` → `budgetCategory: 'wasm'`).

## Purpose
Wasm modules as declared, worker-scoped units (R11.14–R11.16): feature facts (SIMD, threads, memory64, exceptions,
GC) detected with `WebAssembly.validate` probes and combined with cross-origin isolation; variants that pick builds
from those facts; loading through injected ports with `compileStreaming` (fallback `compile` from an ArrayBuffer);
instantiation as `init`; layout views / SoA columns over linear memory (with `@staticflux/worker` layouts).

## Public API (by file)
- `features.ts` — `WASM_FEATURES`, `WASM_FEATURE_PROBES`, `detectWasmFeatures({ engine?, isolation, globals? })` →
  `WasmFeatureFacts { supported, engine: Record<feature, boolean>, sharedMemory }`, `wasmFeatureUsable(facts, feature)`
  (threads need engine support **and** shared memory).
- `module.ts` — `defineWasmModule<Exports>({ id, source: { chunk } | { url } | { bytes }, imports(ctx), features:
  { required, optional }, variants: [{ id, source, requires }], exports, memoryExport, allowMainThread: { reason,
  budgetMs }, budget: { bytes, compileMs }, warmup })`, `selectWasmVariant` (preference order, base last; typed
  SF-WASM-002/003), `usableFeatures`, `describeWasmModule` (loader/budget manifest entry), `WasmExportsOf`.
- `host.ts` — ports `WasmEngine` (`platformWasmEngine()`), `WasmFetch`, `WasmChunkResolver`, `ThreadKind`
  (`detectThreadKind()`), `defaultWasmEnvironment()`; `WasmModuleLifecycle` machine; `createWasmModule(def,
  { environment, facts, telemetry })` → `WasmModuleHandle` (`load(signal)` single-flight, `exports`, `memory()`,
  `view(layout, ptr, count)`, `liveView` (re-binds after `memory.grow`), `columns(layout, ptr, capacity)`,
  `bytes(ptr, len)`, `inspect()`, `dispose()`); `WasmMetrics`.
- `units.ts` — `WasmEnvironmentToken`/`wasmEnvironmentUnit`, `WasmFeaturesToken`/`wasmFeaturesUnit` (requires
  `IsolationFactsToken` from `@staticflux/worker`), `wasmModuleUnit({ id, provides, module })` (init = instantiate).
- `errors.ts` — `SF-WASM-001` … `SF-WASM-011`.

## Lifecycle (`wasm/module`)
`idle → fetching → compiling → instantiating → ready`; inline bytes go `idle → compiling`; any loading state
`→ failed` (retry: `failed → fetching|compiling`); `* → disposed` (a load in flight resolves SF-WASM-008).

## Rules
- Register module units in the **worker** injector. Main-thread instantiation fails with SF-WASM-007 unless the
  module declares `allowMainThread: { reason, budgetMs }`; then every exported call is timed and overruns emit
  `wasm.main-thread-over-budget` (+ `wasm/main-thread-over-budget` counter).
- Never sniff engines in feature code: declare variants; threaded builds are picked only when shared memory is
  usable (isolated, not embedded, isolation not `off`), otherwise the next variant (or SF-WASM-003 with the fix).
- Use `context.memory(descriptor)` in the imports factory: it creates shared memory for threaded variants.
- Linear memory views are invalidated by `memory.grow` (the ArrayBuffer detaches): re-acquire or use `liveView`.
- Streaming compile needs `content-type: application/wasm`; other responses fall back to `compile` (logged as
  `streaming: false` in `inspect()`). Size over `budget.bytes` emits `wasm.budget-exceeded`.

## Test
`pnpm vitest run packages/wasm` (hand-written inline binaries: `add`/`memory`, an `env.log` import, an imported
memory; fake fetch/engine ports).
