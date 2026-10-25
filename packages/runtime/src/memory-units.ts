/**
 * The cache memory ledger as a DI unit (SF-Δ29). Lives in `@staticflux/runtime/memory` with the
 * ledger itself, so main-thread boot bundles that never cache GPU textures or frames do not pay for it.
 */
import { unit, type UnitDefinition } from '@staticflux/core';
import { createMemoryBudgets, type MemoryBudgetManager, type MemoryBudgets } from './memory-budgets.js';
import { MemoryBudgetsToken, MemoryPressureToken } from './tokens.js';

export interface MemoryBudgetsUnitOptions {
  readonly budgets?: Partial<MemoryBudgets>;
}

export type MemoryBudgetsUnit = UnitDefinition<
  MemoryBudgetManager,
  { readonly required: { readonly pressure: typeof MemoryPressureToken } },
  'runtime/memory-budgets'
>;

/**
 * The cache memory ledger (SF-Δ29) for this injector's thread. Caches (GPU tiles, decoded frames)
 * register with it; it evicts them under budget overruns and memory pressure, before features are demoted.
 */
/* @__NO_SIDE_EFFECTS__ */
export function memoryBudgetsUnitWith(options: MemoryBudgetsUnitOptions = {}): MemoryBudgetsUnit {
  return unit({
    id: 'runtime/memory-budgets-unit',
    provides: MemoryBudgetsToken,
    scope: 'app',
    deps: { required: { pressure: MemoryPressureToken } },
    create: ({ pressure }, ctx) => {
      const memory = createMemoryBudgets({ pressure, telemetry: ctx.telemetry, ...(options.budgets === undefined ? {} : { budgets: options.budgets }) });
      ctx.scope.defer(() => memory.dispose());
      return memory;
    },
    description: 'Cache memory ledger: GPU/media bytes per kind, LRU eviction callbacks, pressure-tightened budgets.',
  });
}

export const memoryBudgetsUnit = memoryBudgetsUnitWith();
