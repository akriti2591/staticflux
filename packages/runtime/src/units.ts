/**
 * DI units for the runtime services. Apps register them (e.g. `...runtimeUnits`)
 * and override any of them with `bind(..., { precedence: 'app' })`.
 */
import { box, ok, unit, type UnitDefinition } from '@staticflux/core';
import { createMemoryArchiveStore } from './archive.js';
import { createFeatureHost } from './feature-host.js';
import type { MemoryPressure, ReactiveInput, ResourceBudgets, ResourceManager } from './resource-manager.js';
import { createResourceManager } from './resource-manager.js';
import { createFrameScheduler, type FrameScheduler } from './scheduler.js';
import { defineSubsystem, type Subsystem } from './subsystem.js';
import {
  AppInjectorToken,
  ArchiveStoreToken,
  FeatureHostToken,
  FeatureManifestsToken,
  FrameSchedulerToken,
  MemoryPressureToken,
  ResourceManagerToken,
  SubsystemsToken,
  SupervisorToken,
} from './tokens.js';

export const frameSchedulerUnit = unit({
  id: 'runtime/frame-scheduler-unit',
  provides: FrameSchedulerToken,
  scope: 'app',
  create: (_deps, ctx) => {
    const scheduler = createFrameScheduler({ telemetry: ctx.telemetry });
    ctx.scope.defer(() => scheduler.dispose());
    return scheduler;
  },
  description: 'Frame scheduler: coalesced flush, measure/mutate phases, prioritized tasks, yieldToMain.',
});

/** The frame scheduler as a supervised subsystem: app pause stops frames and tasks (I-1). */
export function frameSchedulerSubsystem(scheduler: FrameScheduler): Subsystem {
  return defineSubsystem({
    id: 'runtime/frame-scheduler',
    critical: false,
    start: () => undefined,
    pause: () => scheduler.pause(),
    resume: () => scheduler.resume(),
    // Disposal belongs to the unit scope; a reinitialize must leave the scheduler usable.
    stop: () => scheduler.resume(),
    description: 'Pauses/resumes the frame scheduler with the app.',
  });
}

export const frameSchedulerSubsystemUnit = unit({
  id: 'runtime/frame-scheduler-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { scheduler: FrameSchedulerToken } },
  // Multi-token contribution: each unit contributes one item (core types the value as the list).
  create: ({ scheduler }) => frameSchedulerSubsystem(scheduler) as never,
});

export const memoryArchiveStoreUnit = unit({
  id: 'runtime/memory-archive-store-unit',
  provides: ArchiveStoreToken,
  scope: 'app',
  create: () => createMemoryArchiveStore(),
  description: 'In-memory ArchiveStore (bind an IndexedDB/OPFS store in production).',
});

export const nominalMemoryPressureUnit = unit({
  id: 'runtime/nominal-memory-pressure-unit',
  provides: MemoryPressureToken,
  scope: 'app',
  create: (): ReactiveInput<MemoryPressure> => box<MemoryPressure>('nominal'),
  description: 'Default memory-pressure fact (always nominal). The platform package binds the real one.',
});

export const featureHostUnit = unit({
  id: 'runtime/feature-host-unit',
  provides: FeatureHostToken,
  scope: 'app',
  deps: {
    required: { injector: AppInjectorToken, archive: ArchiveStoreToken, features: FeatureManifestsToken },
    lazy: { supervisor: SupervisorToken },
  },
  create: ({ injector, archive, features, supervisor }, ctx) => {
    const host = createFeatureHost({
      injector,
      archive,
      features,
      telemetry: ctx.telemetry,
      gate: (operation) => supervisor.value?.assertRunnable(operation) ?? ok(),
    });
    ctx.scope.defer(() => host.dispose());
    return host;
  },
  description: 'Feature host: feature lifecycle, feature injectors, ref-counting, archive.',
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

/** Every runtime service unit with defaults. `bootApp` provides SupervisorToken and AppInjectorToken. */
export const runtimeUnits = [
  frameSchedulerUnit,
  frameSchedulerSubsystemUnit,
  memoryArchiveStoreUnit,
  nominalMemoryPressureUnit,
  featureHostUnit,
  resourceManagerUnit,
] as const;
