/**
 * DI units for @staticflux/hydrate.
 *
 *   createInjector({ units: [...loaderUnits, manifestUnit(m), ...islandUnits,
 *     epochSourceUnit, ...snapshotUnits(), snapshotStoreUnit, storeSnapshotUnit({ … })] })
 *   const hydrator = unwrap(await app.get(IslandHydratorToken));
 *   hydrator.start(document.body, { injector: app });
 *
 * `snapshotRegistryUnitAt(level)` is `critical`: its `init` restores every snapshot (time-boxed)
 * during boot — before features start fetching — then starts autosave. Use the `session` level
 * when sources are session-scoped stores/resources (a unit may only require longer-lived units).
 */
import { contribution, ok, type ScopeLevel, type Token, type TokenId, unit } from '@staticflux/core';
import { EpochSourceToken } from '@staticflux/data';
import { ChunkLoaderToken } from '@staticflux/loader';
import { browserIslandEnv } from './env.js';
import { allowAllIslands, createIslandHydrator } from './hydrator.js';
import { createSnapshotRegistry, type SnapshotSource } from './snapshot.js';
import { type SnapshotableStore, storeSnapshotSource, type StoreSnapshotSourceOptions } from './sources.js';
import {
  IslandEnvToken,
  IslandGateToken,
  IslandHydratorConfigToken,
  IslandHydratorToken,
  IslandMarksToken,
  SnapshotIdentityToken,
  SnapshotRegistryConfigToken,
  SnapshotRegistryToken,
  SnapshotSourcesToken,
  SnapshotStoreToken,
} from './tokens.js';

export const islandEnvUnit = unit({
  id: 'hydrate/island-env-unit',
  provides: IslandEnvToken,
  scope: 'app',
  create: () => browserIslandEnv(),
  description: 'Browser seams for islands (IntersectionObserver, idle callback, rAF, measuring).',
});

export const allowAllIslandGateUnit = unit({
  id: 'hydrate/allow-all-island-gate-unit',
  provides: IslandGateToken,
  scope: 'app',
  create: () => allowAllIslands,
  description: 'Default island gate (allow all). The chunk gate (loader `check`) still applies.',
});

export const islandHydratorConfigUnit = unit({
  id: 'hydrate/island-config-unit',
  provides: IslandHydratorConfigToken,
  scope: 'app',
  create: () => ({}),
});

export const islandHydratorUnit = unit({
  id: 'hydrate/island-hydrator-unit',
  provides: IslandHydratorToken,
  scope: 'app',
  deps: {
    required: {
      loader: ChunkLoaderToken,
      env: IslandEnvToken,
      gate: IslandGateToken,
      marks: IslandMarksToken,
      config: IslandHydratorConfigToken,
    },
  },
  create: ({ loader, env, gate, marks, config }, ctx) => {
    const hydrator = createIslandHydrator({ loader, env, gate, marks, telemetry: ctx.telemetry, scope: ctx.scope, ...config });
    ctx.scope.defer(() => hydrator.dispose());
    return hydrator;
  },
  description: 'Islands hydrator over prerendered HTML (R12.4). Call `start(root, { injector })` at boot.',
});

export const islandUnits = [islandEnvUnit, allowAllIslandGateUnit, islandHydratorConfigUnit, islandHydratorUnit] as const;

export const anonymousSnapshotIdentityUnit = unit({
  id: 'hydrate/anonymous-identity-unit',
  provides: SnapshotIdentityToken,
  scope: 'app',
  create: () => (): string | undefined => undefined,
  description: 'Default identity: anonymous. Bind the auth identity key so identity-bound snapshots are saved.',
});

export const snapshotRegistryConfigUnit = unit({
  id: 'hydrate/snapshot-config-unit',
  provides: SnapshotRegistryConfigToken,
  scope: 'app',
  create: () => ({}),
});

/** The snapshot registry at `level` (critical: restores during boot, then autosaves). */
export function snapshotRegistryUnitAt(level: ScopeLevel) {
  return unit({
    id: 'hydrate/snapshot-registry-unit',
    provides: SnapshotRegistryToken,
    scope: level,
    critical: true,
    deps: {
      required: {
        store: SnapshotStoreToken,
        sources: SnapshotSourcesToken,
        identity: SnapshotIdentityToken,
        config: SnapshotRegistryConfigToken,
        epoch: EpochSourceToken,
      },
    },
    create: ({ store, sources, identity, config, epoch }, ctx) => {
      const registry = createSnapshotRegistry({ store, sources, identity, epoch, telemetry: ctx.telemetry, ...config });
      ctx.scope.defer(async () => {
        await registry.save('hide');
        await registry.dispose();
      });
      return registry;
    },
    // Snapshot problems never fail boot: they are reported and the app boots without them.
    init: async (registry, ctx) => {
      await registry.restore(ctx.signal);
      registry.start();
      void registry.prune();
      return ok();
    },
    budget: { initMs: 250 },
    description: 'Restores declared store snapshots at boot (instant UI) and saves them on hide/interval (R12.4).',
  });
}

export const snapshotRegistryUnit = snapshotRegistryUnitAt('app');

export function snapshotUnits(level: ScopeLevel = 'app') {
  return [anonymousSnapshotIdentityUnit, snapshotRegistryConfigUnit, snapshotRegistryUnitAt(level)] as const;
}

/** Contribute a `defineStore` owner (provided by `store`) as a snapshot source. */
export function storeSnapshotUnit<S>(options: StoreSnapshotSourceOptions & {
  readonly unitId: TokenId;
  readonly store: Token<SnapshotableStore<S>>;
  readonly scope?: ScopeLevel;
  readonly order?: number;
}) {
  return contribution({
    id: options.unitId,
    provides: SnapshotSourcesToken,
    scope: options.scope ?? 'app',
    ...(options.order === undefined ? {} : { order: options.order }),
    deps: { required: { owner: options.store } },
    create: ({ owner }): SnapshotSource => storeSnapshotSource(owner as SnapshotableStore<S>, options) as SnapshotSource,
    description: 'Store snapshot source (R12.4).',
  });
}
