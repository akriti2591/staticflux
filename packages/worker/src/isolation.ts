/**
 * Cross-origin isolation facts as seen by channels, Wasm and surfaces
 * (R11.16, R11.16a). This is the small port those layers consume; the app's
 * `IsolationPolicy` (platform) binds the real value. Feature code never reads
 * `crossOriginIsolated` itself: channels pick shared vs transfer paths from
 * these facts.
 */
import { token, unit, type UnitDefinition } from '@staticflux/core';

/** Per-app isolation choice (R11.16a). */
export type IsolationMode = 'required' | 'preferred' | 'off';

export interface IsolationFacts {
  /** Platform fact: `globalThis.crossOriginIsolated`. */
  readonly crossOriginIsolated: boolean;
  /** App choice. `off` never uses shared memory even when isolated. Default `preferred`. */
  readonly mode?: IsolationMode;
  /** Embedded hosts cannot set COOP/COEP: always fall back. */
  readonly embedded?: boolean;
}

/** Shared-memory globals (injectable for tests). */
export interface SharedMemoryGlobals {
  readonly SharedArrayBuffer?: unknown;
  readonly Atomics?: unknown;
  readonly crossOriginIsolated?: boolean;
}

/** Read the platform fact (no app choice). */
export function detectIsolationFacts(
  globals: SharedMemoryGlobals = globalThis as SharedMemoryGlobals,
  mode: IsolationMode = 'preferred',
): IsolationFacts {
  return { crossOriginIsolated: globals.crossOriginIsolated === true, mode };
}

/** True when shared memory (SharedArrayBuffer + Atomics) may be used for cross-thread channels. */
export function sharedMemoryAvailable(
  facts: IsolationFacts,
  globals: SharedMemoryGlobals = globalThis as SharedMemoryGlobals,
): boolean {
  if (facts.mode === 'off' || facts.embedded === true || !facts.crossOriginIsolated) return false;
  return typeof globals.SharedArrayBuffer === 'function' && typeof globals.Atomics === 'object' && globals.Atomics !== null;
}

export const IsolationFactsToken = /* @__PURE__ */ token('worker/isolation-facts').type<IsolationFacts>();

/** Default binding: platform fact + declared mode. Apps with an IsolationPolicy bind their own. */
export function isolationFactsUnit(
  options: { readonly mode?: IsolationMode; readonly embedded?: boolean; readonly globals?: SharedMemoryGlobals } = {},
): UnitDefinition<IsolationFacts, Record<never, never>, 'worker/isolation-facts'> {
  return unit<IsolationFacts, Record<never, never>, 'worker/isolation-facts'>({
    id: 'worker/isolation-facts-unit',
    provides: IsolationFactsToken,
    scope: 'app',
    description: 'Cross-origin isolation facts for channels / Wasm / surfaces (R11.16a).',
    create: () => {
      const facts = detectIsolationFacts(options.globals, options.mode ?? 'preferred');
      return Object.freeze(options.embedded === undefined ? facts : { ...facts, embedded: options.embedded });
    },
  });
}
