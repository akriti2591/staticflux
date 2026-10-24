/**
 * Wasm feature facts (R11.16): detected with `WebAssembly.validate` on tiny
 * probe modules (same probes as wasm-feature-detect), combined with the
 * cross-origin isolation fact for threads. Facts are data: variants pick
 * builds from them; feature code never sniffs the engine.
 */
import { type IsolationFacts, type SharedMemoryGlobals, sharedMemoryAvailable } from '@staticflux/worker';

export const WASM_FEATURES = ['simd', 'threads', 'memory64', 'exceptions', 'gc'] as const;
export type WasmFeature = (typeof WASM_FEATURES)[number];

/** Probe binaries; each validates only if the engine supports the feature. */
export const WASM_FEATURE_PROBES: Readonly<Record<WasmFeature, Uint8Array<ArrayBuffer>>> = Object.freeze({
  // (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt)
  simd: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
  // shared memory + i32.atomic.load
  threads: new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11,
  ]),
  // (memory i64 1)
  memory64: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]),
  // try / catch_all
  exceptions: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11]),
  // (type (struct (field i8)))
  gc: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 95, 1, 120, 0]),
});

export interface WasmFeatureFacts {
  /** WebAssembly exists at all. */
  readonly supported: boolean;
  /** Engine support per feature (threads = engine can validate atomics + SharedArrayBuffer exists). */
  readonly engine: Readonly<Record<WasmFeature, boolean>>;
  /** Shared memory may actually be used (cross-origin isolated, isolation not off, not embedded). */
  readonly sharedMemory: boolean;
}

/** Feature usable here: engine support, and for threads also shared memory. */
export function wasmFeatureUsable(facts: WasmFeatureFacts, feature: WasmFeature): boolean {
  if (!facts.supported || !facts.engine[feature]) return false;
  return feature === 'threads' ? facts.sharedMemory : true;
}

/** Minimal engine surface used for detection. */
export interface WasmValidator {
  validate(bytes: BufferSource): boolean;
}

export interface DetectWasmFeaturesOptions {
  /** Default `globalThis.WebAssembly`. */
  readonly engine?: WasmValidator | undefined;
  readonly isolation: IsolationFacts;
  readonly globals?: SharedMemoryGlobals;
}

export function detectWasmFeatures(options: DetectWasmFeaturesOptions): WasmFeatureFacts {
  const engine =
    'engine' in options ? options.engine : (globalThis as { WebAssembly?: WasmValidator }).WebAssembly;
  const globals = options.globals ?? (globalThis as SharedMemoryGlobals);
  const none = { simd: false, threads: false, memory64: false, exceptions: false, gc: false };
  if (engine === undefined || typeof engine.validate !== 'function') {
    return Object.freeze({ supported: false, engine: Object.freeze(none), sharedMemory: false });
  }
  const probe = (feature: WasmFeature): boolean => {
    try {
      return engine.validate(WASM_FEATURE_PROBES[feature]);
    } catch {
      return false;
    }
  };
  const detected: Record<WasmFeature, boolean> = { ...none };
  for (const feature of WASM_FEATURES) detected[feature] = probe(feature);
  detected.threads = detected.threads && typeof globals.SharedArrayBuffer === 'function';
  return Object.freeze({
    supported: true,
    engine: Object.freeze(detected),
    sharedMemory: sharedMemoryAvailable(options.isolation, globals),
  });
}
