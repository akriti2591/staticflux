/**
 * Wasm module declarations (R11.14–R11.16). A module is data: a logical id, a
 * source (loader chunk, URL, or inline bytes), an imports factory, required /
 * optional features, feature variants in preference order, a size budget, and
 * an explicit main-thread allowance. `selectWasmVariant` picks the build from
 * feature facts; the base source is the last fallback.
 *
 * @example
 * export const Physics = defineWasmModule<{ step(dt: number): void; memory: WebAssembly.Memory }>({
 *   id: 'studio/physics',
 *   source: { chunk: 'wasm:physics' },
 *   variants: [
 *     { id: 'simd-threads', source: { chunk: 'wasm:physics-mt-simd' }, requires: ['simd', 'threads'] },
 *     { id: 'simd', source: { chunk: 'wasm:physics-simd' }, requires: ['simd'] },
 *   ],
 *   imports: ({ memory }) => ({ env: { memory: memory({ initial: 16, maximum: 256 }) } }),
 *   exports: ['step', 'memory'],
 *   budget: { bytes: 300_000 },
 * });
 */
import { err, ok, type Result } from '@staticflux/core';
import { WasmFeatureMissingError, WasmThreadsNeedIsolationError, WasmUnsupportedError } from './errors.js';
import { type WasmFeature, type WasmFeatureFacts, wasmFeatureUsable } from './features.js';

export type WasmModuleId = `${string}/${string}`;

/** Where the binary comes from. `chunk` is a loader chunk id resolved through the manifest. */
export type WasmSource =
  | { readonly chunk: string }
  | { readonly url: string }
  | { readonly bytes: BufferSource };

export interface WasmVariantDeclaration {
  readonly id: string;
  readonly source: WasmSource;
  /** Features this build needs (in addition to the module's `features.required`). */
  readonly requires: readonly WasmFeature[];
}

export interface WasmMemoryDescriptor {
  readonly initial: number;
  readonly maximum?: number;
}

/** Passed to the imports factory. */
export interface WasmImportContext {
  readonly variant: SelectedWasmVariant;
  /** Usable features (required + available optional). */
  readonly features: Readonly<Record<WasmFeature, boolean>>;
  /** Create the module memory: shared when the selected variant uses threads. */
  memory(descriptor: WasmMemoryDescriptor): WebAssembly.Memory;
}

export interface MainThreadAllowance {
  /** Why this module may run on the main thread (reviewed; shows in devtools). */
  readonly reason: string;
  /** Budget per exported call; overruns are reported (SF-WASM-011 event). */
  readonly budgetMs: number;
}

export interface WasmBudget {
  /** Binary size budget (own budget category `wasm`). */
  readonly bytes?: number;
  readonly compileMs?: number;
}

export type WasmWarmup = 'eager' | 'idle' | 'on-intent' | 'on-demand';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WasmExports = Record<string, any>;

export interface WasmModuleDeclaration<E extends WasmExports> {
  readonly id: WasmModuleId;
  /** Base build (fallback when no variant matches). */
  readonly source: WasmSource;
  readonly imports?: (context: WasmImportContext) => WebAssembly.Imports;
  readonly features?: { readonly required?: readonly WasmFeature[]; readonly optional?: readonly WasmFeature[] };
  /** Preferred builds first. */
  readonly variants?: readonly WasmVariantDeclaration[];
  /** Exports that must exist (checked after instantiation). */
  readonly exports?: readonly (keyof E & string)[];
  /** Name of the exported memory used by views. Default `memory`. */
  readonly memoryExport?: string;
  readonly allowMainThread?: MainThreadAllowance;
  readonly budget?: WasmBudget;
  /** Warmup tier for the loader (prefetch/compile ahead). Default `on-demand`. */
  readonly warmup?: WasmWarmup;
  readonly description?: string;
}

export interface WasmModuleDefinition<E extends WasmExports = WasmExports> extends WasmModuleDeclaration<E> {
  readonly kind: 'wasm-module';
  /** Phantom carrier for the export types. */
  readonly __exports?: E;
}

export function defineWasmModule<E extends WasmExports>(declaration: WasmModuleDeclaration<E>): WasmModuleDefinition<E> {
  return Object.freeze({ ...declaration, kind: 'wasm-module' as const });
}

export type WasmExportsOf<D> = D extends WasmModuleDefinition<infer E> ? E : never;

export interface SelectedWasmVariant {
  /** Variant id, or `base`. */
  readonly id: string;
  readonly source: WasmSource;
  readonly requires: readonly WasmFeature[];
  readonly threads: boolean;
}

/** Pick the first variant whose features are all usable; the base source is last. */
export function selectWasmVariant<E extends WasmExports>(definition: WasmModuleDefinition<E>, facts: WasmFeatureFacts): Result<SelectedWasmVariant> {
  if (!facts.supported) return err(WasmUnsupportedError({ details: { module: definition.id } }));
  const required = definition.features?.required ?? [];
  const candidates: SelectedWasmVariant[] = [
    ...(definition.variants ?? []).map((v) => {
      const requires = [...new Set([...required, ...v.requires])];
      return { id: v.id, source: v.source, requires, threads: requires.includes('threads') };
    }),
    { id: 'base', source: definition.source, requires: [...required], threads: required.includes('threads') },
  ];
  const missing = new Set<WasmFeature>();
  for (const candidate of candidates) {
    const unusable = candidate.requires.filter((feature) => !wasmFeatureUsable(facts, feature));
    if (unusable.length === 0) return ok(candidate);
    for (const feature of unusable) missing.add(feature);
  }
  const details = { module: definition.id, missing: [...missing], tried: candidates.map((c) => c.id) };
  // Threads are the only feature that the app can unlock (by isolating).
  if (missing.has('threads') && facts.engine.threads && !facts.sharedMemory) {
    return err(WasmThreadsNeedIsolationError({ details }));
  }
  return err(
    WasmFeatureMissingError({
      message: `No variant of "${definition.id}" can run here; missing: ${[...missing].join(', ')}.`,
      details,
    }),
  );
}

/** Usable-feature map for the imports factory: required ones of the variant plus available optional ones. */
export function usableFeatures<E extends WasmExports>(
  definition: WasmModuleDefinition<E>,
  variant: SelectedWasmVariant,
  facts: WasmFeatureFacts,
): Readonly<Record<WasmFeature, boolean>> {
  const optional = new Set(definition.features?.optional ?? []);
  const has = (feature: WasmFeature): boolean =>
    variant.requires.includes(feature) || (optional.has(feature) && wasmFeatureUsable(facts, feature));
  return Object.freeze({
    simd: has('simd'),
    threads: has('threads'),
    memory64: has('memory64'),
    exceptions: has('exceptions'),
    gc: has('gc'),
  });
}

/** Manifest entry for the loader / budget tooling (Wasm is its own budget category). */
export interface WasmChunkDescription {
  readonly id: WasmModuleId;
  readonly budgetCategory: 'wasm';
  readonly warmup: WasmWarmup;
  readonly chunks: readonly string[];
  readonly budgetBytes: number | undefined;
  readonly mainThread: MainThreadAllowance | undefined;
  readonly variants: readonly { readonly id: string; readonly requires: readonly WasmFeature[] }[];
}

export function describeWasmModule<E extends WasmExports>(definition: WasmModuleDefinition<E>): WasmChunkDescription {
  const chunkOf = (source: WasmSource): string | undefined => ('chunk' in source ? source.chunk : undefined);
  const chunks = [definition.source, ...(definition.variants ?? []).map((v) => v.source)]
    .map(chunkOf)
    .filter((c): c is string => c !== undefined);
  return {
    id: definition.id,
    budgetCategory: 'wasm',
    warmup: definition.warmup ?? 'on-demand',
    chunks,
    budgetBytes: definition.budget?.bytes,
    mainThread: definition.allowMainThread,
    variants: [
      ...(definition.variants ?? []).map((v) => ({ id: v.id, requires: v.requires })),
      { id: 'base', requires: definition.features?.required ?? [] },
    ],
  };
}
