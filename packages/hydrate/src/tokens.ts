/**
 * DI tokens of @staticflux/hydrate. Ports have default units in `units.ts`; re-bind with
 * `bind(unit, { precedence: 'app' })` (e.g. the gate package binds `IslandGateToken`, auth binds
 * `SnapshotIdentityToken`, perf contributes its `FeatureMarks` to `IslandMarksToken`).
 */
import { token } from '@staticflux/core';
import type { AsyncStore } from '@staticflux/storage';
import type { IslandEnv } from './env.js';
import type { IslandGate, IslandHydrator, IslandMarksPort } from './hydrator.js';
import type { ReplayOptions } from './replay.js';
import type { SnapshotLifecycle, SnapshotRegistry, SnapshotSource } from './snapshot.js';

export interface IslandHydratorConfig {
  readonly replay?: ReplayOptions;
  readonly sizeTolerancePx?: number;
}

export interface SnapshotRegistryConfig {
  readonly intervalMs?: number;
  readonly restoreTimeoutMs?: number;
  readonly defaultMaxBytes?: number;
  readonly prefix?: string;
  readonly lifecycle?: SnapshotLifecycle;
  readonly clock?: () => number;
}

// Islands
export const IslandEnvToken = /* @__PURE__ */ token('hydrate/island-env').type<IslandEnv>();
export const IslandGateToken = /* @__PURE__ */ token('hydrate/island-gate').type<IslandGate>();
export const IslandMarksToken = /* @__PURE__ */ token('hydrate/island-marks').multi<IslandMarksPort>();
export const IslandHydratorConfigToken = /* @__PURE__ */ token('hydrate/island-config').type<IslandHydratorConfig>();
export const IslandHydratorToken = /* @__PURE__ */ token('hydrate/island-hydrator').type<IslandHydrator>();

// Snapshots
/** The AsyncStore snapshots live in (bind e.g. storage `namespacedStoreUnit({ storeScope: 'device', namespace: 'snapshots' })`). */
export const SnapshotStoreToken = /* @__PURE__ */ token('hydrate/snapshot-store').type<AsyncStore>();
export const SnapshotSourcesToken = /* @__PURE__ */ token('hydrate/snapshot-sources').multi<SnapshotSource>();
/** Current identity key (opaque hash); default: always anonymous (identity-bound sources never saved). */
export const SnapshotIdentityToken = /* @__PURE__ */ token('hydrate/snapshot-identity').type<() => string | undefined>();
export const SnapshotRegistryConfigToken = /* @__PURE__ */ token('hydrate/snapshot-config').type<SnapshotRegistryConfig>();
export const SnapshotRegistryToken = /* @__PURE__ */ token('hydrate/snapshot-registry').type<SnapshotRegistry>();
