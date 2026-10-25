/**
 * Versioning DI tokens and the context the editor provides. Type-only imports, so the main-thread
 * contributions (panel, save status) depend on the tokens without pulling the services in.
 */
import { token } from '@staticflux/core';
import type { ComponentRegistry, CrdtEngine, DocumentStore, OpenDocument } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import type { LatestService, MirrorStatusSource } from './latest.js';
import type { MilestoneService, MirrorFlush } from './milestones.js';
import type { NewDocumentServiceOptions } from './new-document.js';
import type { MilestonesPanelModel, VersioningHost } from './panel-model.js';
import type { AssetId } from './records.js';
import type { ExportSnapshotService, ReleasePort } from './snapshot.js';

/** What the editor (B0) provides in the open document's scope. */
export interface VersioningContext {
  readonly doc: OpenDocument;
  readonly store: DocumentStore;
  readonly engine: CrdtEngine;
  readonly registry?: ComponentRegistry;
  /** The folder mirror when the workspace is mirrored (`@staticflux/blob` `FolderMirror`). */
  readonly mirror?: MirrorStatusSource & MirrorFlush;
  readonly host: VersioningHost;
  readonly actor: () => Actor;
  readonly newAssetId: () => AssetId;
  readonly title: () => string;
}

export interface VersioningServices {
  readonly latest: LatestService;
  readonly milestones: MilestoneService;
  readonly snapshots: ExportSnapshotService;
  readonly panel: MilestonesPanelModel;
  /** Options for "New document from milestone" and templates. */
  readonly documents: NewDocumentServiceOptions;
}

export const VersioningContextToken = /* @__PURE__ */ token('instaflow/versioning-context').type<VersioningContext>();
export const VersioningServicesToken = /* @__PURE__ */ token('instaflow/versioning-services').type<VersioningServices>();
export const LatestServiceToken = /* @__PURE__ */ token('instaflow/latest-service').type<LatestService>();
export const MilestonesPanelModelToken = /* @__PURE__ */ token('instaflow/milestones-panel-model').type<MilestonesPanelModel>();
export const ReleasePortToken = /* @__PURE__ */ token('instaflow/release-port').type<ReleasePort>();

/** Milestone name and note limits (shared by the service, the command schema and the panel). */
export const MAX_MILESTONE_NAME = 120;
export const MAX_MILESTONE_NOTE = 2000;
