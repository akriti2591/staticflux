/**
 * Telemetry subsystems and declared metrics of @staticflux/hydrate.
 */
import { metric, type Subsystem } from '@staticflux/core';

export const HYDRATE_SUBSYSTEMS = {
  island: 'hydrate/island',
  snapshot: 'hydrate/snapshot',
} as const satisfies Record<string, Subsystem>;

export const hydrateMetrics = {
  /** Static markup present (prerendered = first render; attrs: feature, chunk, method `prerendered`). */
  islandStatic: /* @__PURE__ */ metric.mark('hydrate/island-static', { description: 'Island static markup present at scan (feature.first-render of a prerendered island).' }),
  /** Island interactive (attrs: feature, chunk, strategy, method `island-hydrate`). */
  islandInteractive: /* @__PURE__ */ metric.mark('hydrate/island-interactive', { description: 'Island hydrated: handlers attached (feature.interactive).' }),
  islandDuration: /* @__PURE__ */ metric.histogram('hydrate/island-duration', { unit: 'ms', description: 'Trigger → hydrated (attrs: chunk, strategy, outcome).' }),
  eventsReplayed: /* @__PURE__ */ metric.counter('hydrate/events-replayed', { description: 'User events captured before hydration and replayed after (attrs: chunk, type).' }),
  eventsDropped: /* @__PURE__ */ metric.counter('hydrate/events-dropped', { description: 'Captured events dropped (target gone, queue full, hydration failed).' }),
  layoutShiftRisk: /* @__PURE__ */ metric.counter('hydrate/layout-shift-risk', { description: 'Islands whose size changed during hydration or mismatched the declared size (R12.19).' }),
  snapshotRestored: /* @__PURE__ */ metric.counter('hydrate/snapshot-restored', { description: 'Snapshots applied at boot (attrs: source).' }),
  snapshotDropped: /* @__PURE__ */ metric.counter('hydrate/snapshot-dropped', { description: 'Snapshots dropped (attrs: source, reason).' }),
  snapshotAge: /* @__PURE__ */ metric.histogram('hydrate/snapshot-age', { unit: 'ms', description: 'Age of restored snapshots (attrs: source).' }),
  snapshotBytes: /* @__PURE__ */ metric.histogram('hydrate/snapshot-bytes', { unit: 'By', description: 'Saved snapshot size (attrs: source).' }),
  restoreDuration: /* @__PURE__ */ metric.histogram('hydrate/restore-duration', { unit: 'ms', description: 'Boot snapshot restore duration (attrs: outcome).' }),
} as const;
