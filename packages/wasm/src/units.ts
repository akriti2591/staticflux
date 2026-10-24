/**
 * DI units. A Wasm module is a **worker-scoped unit** (R11.14): register
 * `wasmModuleUnit` in the worker's injector; `init` = instantiate, so a consumer
 * that receives the handle can call exports immediately. The unit's scope
 * disposes the instance.
 *
 * @example
 * export const PhysicsToken = token('studio/physics').type<WasmModuleHandle<WasmExportsOf<typeof Physics>>>();
 * const units = [
 *   isolationFactsUnit(),                      // from @staticflux/worker (or the app's IsolationPolicy)
 *   wasmEnvironmentUnit({ chunks: manifestResolver }),
 *   wasmFeaturesUnit(),
 *   wasmModuleUnit({ id: 'studio/physics-unit', provides: PhysicsToken, module: Physics }),
 * ];
 */
import { type ScopeLevel, type Token, type TokenId, token, unit, type UnitDefinition } from '@staticflux/core';
import { IsolationFactsToken } from '@staticflux/worker';
import { detectWasmFeatures, type WasmFeatureFacts } from './features.js';
import { createWasmModule, defaultWasmEnvironment, type WasmEnvironment, type WasmModuleHandle } from './host.js';
import type { WasmExports, WasmModuleDefinition } from './module.js';

export const WasmEnvironmentToken = token('wasm/environment').type<WasmEnvironment>();
export const WasmFeaturesToken = token('wasm/features').type<WasmFeatureFacts>();

/** Engine, fetch, chunk resolver and thread kind (defaults from the platform). */
export function wasmEnvironmentUnit(
  overrides: Partial<WasmEnvironment> = {},
): UnitDefinition<WasmEnvironment, Record<never, never>, 'wasm/environment'> {
  return unit<WasmEnvironment, Record<never, never>, 'wasm/environment'>({
    id: 'wasm/environment-unit',
    provides: WasmEnvironmentToken,
    scope: 'app',
    description: 'WebAssembly engine, fetch port, chunk resolver and thread kind for Wasm modules.',
    create: () => defaultWasmEnvironment(overrides),
  });
}

/** Wasm feature facts (probe validation × isolation facts). */
export function wasmFeaturesUnit(): UnitDefinition<WasmFeatureFacts, { readonly required: { readonly isolation: typeof IsolationFactsToken; readonly environment: typeof WasmEnvironmentToken } }, 'wasm/features'> {
  return unit({
    id: 'wasm/features-unit',
    provides: WasmFeaturesToken,
    scope: 'app',
    deps: { required: { isolation: IsolationFactsToken, environment: WasmEnvironmentToken } },
    description: 'Wasm feature facts: simd, threads, memory64, exceptions, gc + shared-memory availability (R11.16).',
    create: ({ isolation, environment }) => detectWasmFeatures({ engine: environment.engine, isolation }),
  });
}

export interface WasmModuleUnitOptions<E extends WasmExports, Id extends TokenId> {
  readonly id: TokenId;
  readonly provides: Token<WasmModuleHandle<E>, Id>;
  readonly module: WasmModuleDefinition<E>;
  /** Default `app` (of the worker injector the unit is registered in). */
  readonly scope?: ScopeLevel;
  readonly critical?: boolean;
}

export function wasmModuleUnit<E extends WasmExports, const Id extends TokenId>(
  options: WasmModuleUnitOptions<E, Id>,
): UnitDefinition<
  WasmModuleHandle<E>,
  { readonly required: { readonly environment: typeof WasmEnvironmentToken; readonly facts: typeof WasmFeaturesToken } },
  Id
> {
  return unit({
    id: options.id,
    provides: options.provides,
    scope: options.scope ?? 'app',
    ...(options.critical === undefined ? {} : { critical: options.critical }),
    deps: { required: { environment: WasmEnvironmentToken, facts: WasmFeaturesToken } },
    description: options.module.description ?? `Wasm module ${options.module.id} (init = instantiate).`,
    ...(options.module.budget?.compileMs === undefined ? {} : { budget: { initMs: options.module.budget.compileMs } }),
    create: ({ environment, facts }, context) => {
      const handle = createWasmModule(options.module, { environment, facts, telemetry: context.telemetry });
      context.scope.defer(() => handle.dispose());
      return handle;
    },
    init: (handle, context) => handle.load(context.signal),
  });
}
