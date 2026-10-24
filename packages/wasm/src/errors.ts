/**
 * Error catalog for @staticflux/wasm (`SF-WASM-*`).
 */
import { defineError } from '@staticflux/core';

export const WasmUnsupportedError = defineError(
  'SF-WASM-001',
  'unavailable',
  'WebAssembly is not available in this environment.',
  'Gate the feature on the `wasm/features` fact (`supported`) and provide a JS fallback implementation.',
);

export const WasmFeatureMissingError = defineError(
  'SF-WASM-002',
  'unavailable',
  'No variant of the Wasm module can run here: a required Wasm feature is missing.',
  'Add a variant without the feature (e.g. a scalar build next to the SIMD build), or move the feature to `features.optional` and check `context.features` in the imports factory.',
);

export const WasmThreadsNeedIsolationError = defineError(
  'SF-WASM-003',
  'unavailable',
  'The Wasm module needs threads (shared memory), but the page is not cross-origin isolated.',
  'Serve COOP `same-origin` + COEP `require-corp`/`credentialless` (isolation: "required"), or declare a non-threaded variant so the module degrades automatically (embedded hosts are never isolated).',
);

export const WasmFetchError = defineError(
  'SF-WASM-004',
  'network',
  'The Wasm binary could not be fetched.',
  'Check the chunk/URL (404 after deploy → reload with the new manifest) and, when isolated, that the response carries CORP/CORS headers.',
);

export const WasmCompileError = defineError(
  'SF-WASM-005',
  'invariant',
  'The Wasm binary failed to compile.',
  'Rebuild the module; check that the variant matches its declared features (a SIMD build loaded as the scalar variant fails here).',
);

export const WasmInstantiateError = defineError(
  'SF-WASM-006',
  'invariant',
  'The Wasm module failed to instantiate (missing/mismatched imports or start function trapped).',
  'Make the `imports` factory provide every import the module declares (see `details.imports`), with matching signatures.',
);

export const WasmMainThreadError = defineError(
  'SF-WASM-007',
  'invariant',
  'A Wasm module was instantiated on the main thread without `allowMainThread`.',
  'Host the module in a worker (register its unit in the worker injector), or declare `allowMainThread: { reason, budgetMs }` for tiny synchronous work.',
);

export const WasmNotReadyError = defineError(
  'SF-WASM-008',
  'invariant',
  'The Wasm module is not instantiated yet (or was disposed).',
  'Resolve the module through its unit (ready = instantiated) or await `handle.load()` before touching exports.',
);

export const WasmExportMissingError = defineError(
  'SF-WASM-009',
  'validation',
  'The Wasm module does not export a declared export.',
  'Check the `exports` list against the module (`WebAssembly.Module.exports`); rebuild with the export enabled.',
);

export const WasmMemoryError = defineError(
  'SF-WASM-010',
  'validation',
  'A memory view is out of bounds or the module exports no memory.',
  'Export the memory (`memory`) or name it with `memoryExport`; allocate inside Wasm and pass the pointer; re-acquire views after memory growth (or use `liveView`).',
);

export const WasmBudgetExceededError = defineError(
  'SF-WASM-011',
  'quota',
  'A Wasm module exceeded its declared budget (binary size, compile time or main-thread call time).',
  'Shrink the module (wasm-opt -Oz, strip debug info), split it, or raise the budget with a documented reason.',
);
