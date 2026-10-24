/**
 * Errors of @staticflux/hydrate (`SF-HYD-*`).
 * 001–009: islands · 020–029: snapshots · 030–039: build-side serialization.
 */
import { defineError } from '@staticflux/core';

export const IslandMarkerInvalidError = defineError(
  'SF-HYD-001',
  'validation',
  'An island marker is malformed (missing/invalid chunk id or unknown hydrate strategy).',
  'Emit markers with `renderIslandMarker()`; `chunk` must be a logical chunk id (`feature:x`) and `hydrate` one of visible|idle|interaction|eager|never.',
);

export const IslandPropsInvalidError = defineError(
  'SF-HYD-002',
  'validation',
  'Island props could not be parsed or failed the island module\'s props validation.',
  'Serialize props with `serializeIslandProps()` at prerender time and keep the island module\'s `props` schema in sync with what the prerender step emits.',
);

export const IslandDeniedError = defineError(
  'SF-HYD-003',
  'forbidden',
  'An island was not hydrated because the gate (or the chunk gate/profile check) denied its chunk.',
  'Expected for gated features: the island keeps its static markup. Call `handle.retry()` after the gate decision changes (e.g. after login).',
);

export const IslandLoadFailedError = defineError(
  'SF-HYD-004',
  'network',
  'The island\'s chunk failed to load.',
  'Inspect `cause` (a `SF-LOAD-*` error). The static markup stays; call `handle.retry()` (e.g. when back online).',
);

export const IslandModuleInvalidError = defineError(
  'SF-HYD-005',
  'invariant',
  'The island chunk does not export the island contract (`hydrate(element, context)`).',
  'Export `hydrate` (or `export default defineIsland({ hydrate })`) from the chunk entry; with `export="name"` the named export must be an island module.',
);

export const IslandHydrateFailedError = defineError(
  'SF-HYD-006',
  'unknown',
  'The island module\'s `hydrate()` threw or returned an error.',
  'Inspect `cause`. `hydrate` must attach behaviour to the existing DOM; queued user events are dropped when it fails.',
);

export const IslandLayoutShiftRiskError = defineError(
  'SF-HYD-007',
  'invariant',
  'An island changed size during hydration, or its static markup does not match its declared size (layout shift risk, R12.19).',
  'Make the prerendered markup size-stable: render the same box server-side, declare `size="WxH"` matching it, and avoid inserting/removing content in `hydrate()`.',
);

export const IslandEagerWithoutReasonError = defineError(
  'SF-HYD-008',
  'validation',
  'An island declared `hydrate="eager"` without a `reason`; it was downgraded to `idle` (R12.12).',
  'Add `reason="…"` (`data-sf-reason`) explaining why it must hydrate during boot, or use visible/idle/interaction.',
);

export const SnapshotVersionMismatchError = defineError(
  'SF-HYD-020',
  'conflict',
  'A persisted snapshot has a version with no migration path to the current version; it was dropped.',
  'Expected after deploys that change a store schema. Add a migration (`migrations[fromVersion]`) to keep users\' state across the change.',
);

export const SnapshotIdentityMismatchError = defineError(
  'SF-HYD-021',
  'auth',
  'A snapshot bound to another identity was found; it was dropped and not restored.',
  'Expected after an account switch. Call `registry.clearIdentityBound()` on logout so other identities never see stale snapshots.',
);

export const SnapshotOverBudgetError = defineError(
  'SF-HYD-022',
  'quota',
  'A snapshot exceeded its byte budget; it was not saved (and the previous one was removed).',
  'Snapshot less (select the visible slice in `capture`) or raise `maxBytes` with a reason; large state belongs in an archive, not the boot snapshot.',
);

export const SnapshotCorruptError = defineError(
  'SF-HYD-023',
  'validation',
  'A persisted snapshot envelope is malformed; it was dropped.',
  'Usually written by an older/foreign build. Nothing to do; if it repeats, check that only the snapshot registry writes under its key prefix.',
);

export const SnapshotRestoreFailedError = defineError(
  'SF-HYD-024',
  'validation',
  'A snapshot could not be applied (schema validation or store header mismatch); it was dropped.',
  'Bump the store/source version when the shape changes and add a migration; never change a schema without bumping its version.',
);

export const SnapshotStorageError = defineError(
  'SF-HYD-025',
  'unavailable',
  'The snapshot store failed to read or write.',
  'Inspect `cause` (`SF-STORE-*`). Boot continues without snapshots; bind a working AsyncStore to `SnapshotStoreToken`.',
);

export const SnapshotSourceDuplicateError = defineError(
  'SF-HYD-026',
  'invariant',
  'Two snapshot sources were registered with the same id.',
  'Give each snapshot source a unique id (normally the store id).',
);

export const SnapshotRestoreTimeoutError = defineError(
  'SF-HYD-027',
  'timeout',
  'Restoring snapshots exceeded its time box; boot continued without them.',
  'The snapshot store is slow (cold IndexedDB). Keep snapshots small, or raise `restoreTimeoutMs` with a reason.',
);

export const SnapshotUnknownSourceError = defineError(
  'SF-HYD-028',
  'not-found',
  'No snapshot source is registered with this id.',
  'Register the source (`registry.register(source)` or a `SnapshotSourcesToken` contribution) before restoring it.',
);

export const PropsNotSerializableError = defineError(
  'SF-HYD-030',
  'validation',
  'Island props contain values that are not plain JSON data (functions, symbols, bigint, cycles, class instances, non-finite numbers).',
  'Pass only plain data as island props; derive everything else inside `hydrate()`.',
);
