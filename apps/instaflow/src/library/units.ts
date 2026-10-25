/**
 * DI for the library. The library belongs to the open workspace, so the app provides a
 * `LibraryContext` in the workspace scope (`feature`) and these units build everything from it:
 *
 *   inject: LibraryContextToken (library document, blob store, actor, ids, host, decoder/renderer/encoder)
 *   → LibraryServicesToken (library, ingest, rendition queue, panel model; disposed with the scope)
 *   → LibraryPanelModelToken (the Assets panel)
 *
 * The rendition queue resumes at once: thumbnails missing from an earlier session are produced in the
 * background (IF-3.9).
 */
import { type Scope, unit, type UnitDefinition } from '@staticflux/core';
import { createIngestService } from './ingest.js';
import { createLibrary } from './library.js';
import { createLibraryPanelModel, type LibraryPanelModel } from './panel-model.js';
import { createRenditionQueue } from './renditions.js';
import { decoderMediaProbe } from './thumbnails.js';
import { type LibraryContext, LibraryContextToken, LibraryPanelModelToken, type LibraryServices, LibraryServicesToken } from './tokens.js';

/** Build every library service for one workspace; all of it is disposed with `scope`. */
export function createLibraryServices(context: LibraryContext, scope: Scope): LibraryServices {
  const library = createLibrary({ source: { part: context.document.part, commit: (meta, changes) => context.document.doc.commit(meta, changes) }, actor: context.actor });
  const renditions = createRenditionQueue({ library, blobs: context.blobs, decoder: context.decoder, renderer: context.renderer, encoder: context.encoder });
  const ingest = createIngestService({
    library,
    blobs: context.blobs,
    probes: context.probes ?? { image: decoderMediaProbe(context.decoder) },
    newAssetId: context.newAssetId,
    actor: context.actor,
    onListed: (entry) => void renditions.request(entry.asset),
  });
  const panel = createLibraryPanelModel({ library, ingest, blobs: context.blobs, host: context.host, ...(context.urls === undefined ? {} : { urls: context.urls }), signal: scope.signal });
  scope.defer(() => {
    ingest.dispose();
    renditions.dispose();
    library.dispose();
  });
  renditions.resume();
  return { library, ingest, renditions, panel };
}

export const libraryServicesUnit: UnitDefinition<LibraryServices, { required: { context: typeof LibraryContextToken } }, 'instaflow/library-services'> = /* @__PURE__ */ unit({
  id: 'instaflow/library-services',
  provides: LibraryServicesToken,
  scope: 'feature',
  deps: { required: { context: LibraryContextToken } },
  create: ({ context }, ctx) => createLibraryServices(context, ctx.scope),
  description: 'The workspace library: asset list, ingest, renditions and the Assets panel model (B4).',
});

export const libraryPanelModelUnit: UnitDefinition<LibraryPanelModel, { required: { services: typeof LibraryServicesToken } }, 'instaflow/library-panel-model'> = /* @__PURE__ */ unit({
  id: 'instaflow/library-panel-model',
  provides: LibraryPanelModelToken,
  scope: 'feature',
  deps: { required: { services: LibraryServicesToken } },
  create: ({ services }) => services.panel,
});

/** Everything the library registers (the context unit comes from the app). */
export const libraryUnits = [libraryServicesUnit, libraryPanelModelUnit] as const;
