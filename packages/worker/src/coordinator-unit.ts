/**
 * DI unit for the multi-tab coordinator (R11.9).
 *
 * @example
 * export const StudioTabsToken = token('studio/tabs').type<TabCoordinator>();
 * export const studioTabsUnit = tabCoordinatorUnit({
 *   id: 'studio/tabs-unit',
 *   provides: StudioTabsToken,
 *   options: () => ({ id: 'studio/tabs', owned: [ownedResource(PrefsReplica, ({ restored }) => createJsonSource(restored ?? defaults))],
 *                     sharedWorker: sharedWorkerSpawner(() => new SharedWorker(url, { type: 'module' })) }),
 * });
 */
import { type ScopeLevel, type Token, type TokenId, token, unit, type UnitContext, type UnitDefinition } from '@staticflux/core';
import { createTabCoordinator, type TabCoordinator, type TabCoordinatorOptions } from './coordinator.js';

/** Default token for apps with one coordinator. */
export const TabCoordinatorToken = token('worker/tab-coordinator').type<TabCoordinator>();

export interface TabCoordinatorUnitOptions<Id extends TokenId> {
  readonly id: TokenId;
  readonly provides: Token<TabCoordinator, Id>;
  /** Default `app`. */
  readonly scope?: ScopeLevel;
  readonly critical?: boolean;
  /** Build the options; the unit's telemetry is used unless they set one. */
  readonly options: (context: UnitContext) => TabCoordinatorOptions;
}

/** `init` starts the coordinator (ready = every replica live); the unit scope disposes it (leader steps down). */
export function tabCoordinatorUnit<const Id extends TokenId>(
  options: TabCoordinatorUnitOptions<Id>,
): UnitDefinition<TabCoordinator, Record<never, never>, Id> {
  return unit<TabCoordinator, Record<never, never>, Id>({
    id: options.id,
    provides: options.provides,
    scope: options.scope ?? 'app',
    ...(options.critical === undefined ? {} : { critical: options.critical }),
    description: 'Multi-tab coordinator: one owner per resource across tabs (SharedWorker or Web Locks leader).',
    create: (_deps, context) => {
      const coordinator = createTabCoordinator({ telemetry: context.telemetry, ...options.options(context) });
      context.scope.defer(() => coordinator.dispose());
      return coordinator;
    },
    init: (coordinator, context) => coordinator.start(context.signal),
  });
}
