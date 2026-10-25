/**
 * DI for versioning. The services belong to one open document, so the editor (B0) provides a
 * `VersioningContext` in the document's scope (`feature`) and these units build everything from it:
 *
 *   inject: VersioningContextToken (doc, store, engine, registry, mirror?, host, actor, ids, title)
 *   → VersioningServicesToken (Latest, milestones, export snapshot, panel model; disposed with the scope)
 *   → LatestServiceToken (top-bar save status), MilestonesPanelModelToken (Milestones panel)
 *
 * `ReleasePortToken` is app-wide; M1 provides `unavailableReleasePort` (publishing comes later).
 */
import { type Scope, unit, type UnitDefinition } from '@staticflux/core';
import { createLatestService, type LatestService } from './latest.js';
import { createMilestoneService } from './milestones.js';
import type { NewDocumentServiceOptions } from './new-document.js';
import { createMilestonesPanelModel, type MilestonesPanelPort } from './panel-model.js';
import { createPartCapture } from './parts.js';
import { createExportSnapshotService, type ReleasePort, unavailableReleasePort } from './snapshot.js';
import {
  LatestServiceToken,
  MilestonesPanelModelToken,
  ReleasePortToken,
  type VersioningContext,
  VersioningContextToken,
  type VersioningServices,
  VersioningServicesToken,
} from './tokens.js';

/** Build every versioning service for one open document; all of it is disposed with `scope`. */
export function createVersioningServices(context: VersioningContext, scope: Scope): VersioningServices {
  const registry = context.registry === undefined ? {} : { registry: context.registry };
  const capture = createPartCapture({ store: context.store, ...registry });
  const latest = createLatestService({ doc: context.doc, ...(context.mirror === undefined ? {} : { mirror: context.mirror }) });
  const milestones = createMilestoneService({ doc: context.doc, store: context.store, capture, ...registry, ...(context.mirror === undefined ? {} : { mirror: context.mirror }) });
  const snapshots = createExportSnapshotService({ doc: context.doc, store: context.store, capture, ...registry });
  const documents: NewDocumentServiceOptions = { store: context.store, engine: context.engine, ...registry };
  const panel = createMilestonesPanelModel({
    milestones,
    snapshots,
    documents,
    host: context.host,
    actor: context.actor,
    newAssetId: context.newAssetId,
    title: context.title,
    signal: scope.signal,
  });
  scope.defer(() => {
    latest.dispose();
    milestones.dispose();
  });
  void milestones.refresh(scope.signal);
  return { latest, milestones, snapshots, panel, documents };
}

export const versioningServicesUnit: UnitDefinition<VersioningServices, { required: { context: typeof VersioningContextToken } }, 'instaflow/versioning-services'> =
  /* @__PURE__ */ unit({
    id: 'instaflow/versioning-services',
    provides: VersioningServicesToken,
    scope: 'feature',
    deps: { required: { context: VersioningContextToken } },
    create: ({ context }, ctx) => createVersioningServices(context, ctx.scope),
    description: 'Latest save state, milestones, export snapshots and the Milestones panel model for the open document (B5).',
  });

export const latestServiceUnit: UnitDefinition<LatestService, { required: { services: typeof VersioningServicesToken } }, 'instaflow/latest-service'> = /* @__PURE__ */ unit({
  id: 'instaflow/latest-service',
  provides: LatestServiceToken,
  scope: 'feature',
  deps: { required: { services: VersioningServicesToken } },
  create: ({ services }) => services.latest,
});

export const milestonesPanelModelUnit: UnitDefinition<MilestonesPanelPort, { required: { services: typeof VersioningServicesToken } }, 'instaflow/milestones-panel-model'> =
  /* @__PURE__ */ unit({
    id: 'instaflow/milestones-panel-model',
    provides: MilestonesPanelModelToken,
    scope: 'feature',
    deps: { required: { services: VersioningServicesToken } },
    create: ({ services }) => services.panel,
  });

export const releasePortUnit: UnitDefinition<ReleasePort, Record<never, never>, 'instaflow/release-port'> = /* @__PURE__ */ unit({
  id: 'instaflow/release-port',
  provides: ReleasePortToken,
  scope: 'app',
  create: () => unavailableReleasePort,
});

/** Everything versioning registers (the context unit comes from the editor). */
export const versioningUnits = [versioningServicesUnit, latestServiceUnit, milestonesPanelModelUnit, releasePortUnit] as const;
