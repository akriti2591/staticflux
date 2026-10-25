/**
 * Resource-manager units (demotion, budgets, memory pressure). Not needed for the first frame:
 * apps may defer this module (e.g. core `deferredUnits`) — nothing resolves the resource manager
 * until a feature is demoted.
 */
import { box, unit, type UnitDefinition } from '@staticflux/core';
import type { MemoryPressure, ReactiveInput, ResourceBudgets, ResourceManager } from './resource-manager.js';
import { createResourceManager } from './resource-manager.js';
import { FeatureHostToken, MemoryPressureToken, ResourceManagerToken } from './tokens.js';

export const nominalMemoryPressureUnit = unit({
  id: 'runtime/nominal-memory-pressure-unit',
  provides: MemoryPressureToken,
  scope: 'app',
  create: (): ReactiveInput<MemoryPressure> => box<MemoryPressure>('nominal'),
  description: 'Default memory-pressure fact (always nominal). The platform package binds the real one.',
});

export interface ResourceManagerUnitOptions {
  readonly budgets?: Partial<ResourceBudgets>;
  readonly pressureBudgets?: { readonly moderate?: Partial<ResourceBudgets>; readonly critical?: Partial<ResourceBudgets> };
}

export type ResourceManagerUnit = UnitDefinition<
  ResourceManager,
  { readonly required: { readonly host: typeof FeatureHostToken; readonly pressure: typeof MemoryPressureToken } },
  'runtime/resource-manager'
>;

/** A resource-manager unit with app-specific framework budgets (e.g. per device tier). */
/* @__NO_SIDE_EFFECTS__ */
export function resourceManagerUnitWith(options: ResourceManagerUnitOptions = {}): ResourceManagerUnit {
  return unit({
    id: 'runtime/resource-manager-unit',
    provides: ResourceManagerToken,
    scope: 'app',
    deps: { required: { host: FeatureHostToken, pressure: MemoryPressureToken } },
    create: ({ host, pressure }, ctx) => {
      const manager = createResourceManager({
        host,
        pressure,
        telemetry: ctx.telemetry,
        ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
        ...(options.pressureBudgets === undefined ? {} : { pressureBudgets: options.pressureBudgets }),
      });
      ctx.scope.defer(() => manager.dispose());
      return manager;
    },
    description: 'Resource manager: demotion by weight/retention, LRU, budgets, memory pressure.',
  });
}

export const resourceManagerUnit = resourceManagerUnitWith();

