/**
 * Library DI tokens and the context the app provides. Type-only imports, so the main-thread panel
 * depends on the tokens without pulling the services in.
 */
import type { BlobStore } from '@staticflux/blob';
import { token } from '@staticflux/core';
import type { Actor } from '@staticflux/stage';
import type { LibraryDocument } from './library-doc.js';
import type { BlobAssetKind } from './kinds.js';
import type { IngestService, MediaProbe } from './ingest.js';
import type { Library } from './library.js';
import type { LibraryHost, LibraryPanelModel, ObjectUrls } from './panel-model.js';
import type { AssetId } from './records.js';
import type { ImageDecoder, ImageEncoder, RenditionQueue, ThumbnailRenderer } from './renditions.js';

/** What the app provides in the workspace scope (`feature`). */
export interface LibraryContext {
  /** The open library document (`openLibraryDocument(repo, signal)` when the workspace opens). */
  readonly document: LibraryDocument;
  /** The workspace blob store (`@staticflux/blob`). */
  readonly blobs: BlobStore;
  readonly actor: () => Actor;
  readonly newAssetId: () => AssetId;
  readonly host: LibraryHost;
  readonly decoder: ImageDecoder;
  /** `sceneThumbnailRenderer` (A6) where a raster backend exists, else `scaleThumbnailRenderer`. */
  readonly renderer: ThumbnailRenderer;
  readonly encoder: ImageEncoder;
  /** Media probes per kind (default: images through `decoder`). */
  readonly probes?: Readonly<Partial<Record<BlobAssetKind, MediaProbe>>>;
  readonly urls?: ObjectUrls;
}

export interface LibraryServices {
  readonly library: Library;
  readonly ingest: IngestService;
  readonly renditions: RenditionQueue;
  readonly panel: LibraryPanelModel;
}

export const LibraryContextToken = /* @__PURE__ */ token('instaflow/library-context').type<LibraryContext>();
export const LibraryServicesToken = /* @__PURE__ */ token('instaflow/library-services').type<LibraryServices>();
export const LibraryPanelModelToken = /* @__PURE__ */ token('instaflow/library-panel-model').type<LibraryPanelModel>();
