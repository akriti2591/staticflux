/**
 * One page of an opened document as a complete scene IR (C1; IF-29.6, IF-7.10): exactly what Studio's canvas pipeline
 * sends to the render module for a snapshot, without the pipes and without the overlay (selection, guides and the
 * page edge never export).
 *
 * - **Elements** (B1 over B7's repeat view: repeat instances are drawn like any element): the render projection's
 *   snapshot and resources, encoded by B1's scene encoder exactly as the render side does it (`element-port.ts`).
 * - **Images** (B4): the image assets the page's paints name are decoded from the workspace blobs and uploaded
 *   ahead of nothing else (the encoder resolves them by asset key), straight RGBA plus the luminance matte.
 * - **Text** (B2): the text layer's full IR (fonts once per hash, glyph runs carrying their text: scene IR v4), each
 *   glyph group under its text element's node from the projection (B12b P2), so exports keep the canvas's tree order.
 *
 * - **Page fill** (B12, A-1): the page's fill stack is the first element node (a full-page rect under everything), so
 *   PNG, SVG and PDF draw it exactly as the canvas does (D21); `pageFill: false` leaves it out (transparent export).
 *
 * Batches apply in order: elements (a full encode starts with CLEAR), images, text.
 */
import type { BlobStore } from '@staticflux/blob';
import { err, ok, type Result, type Scope } from '@staticflux/core';
import { createRenderProjector, createSceneStore } from '@staticflux/document/render-projection';
import type { NodeId } from '@staticflux/document/v2';
import type { StudioDocument } from '../app/document.js';
import { createImageUploads } from '../app/images.js';
import { createTextLayer, projectedSceneId, type StudioFonts } from '../app/text-layer.js';
import { createElementRenderSource, ElementProjection } from '../elements/projection.js';
import { createElementSceneEncoder, createSceneResources } from '../elements/scene.js';
import { STRUCTURE_PATHS } from '../lenses/structure.js';
import type { LibraryEntry } from '../library/library-doc.js';
import type { ImageDecoder } from '../library/renditions.js';
import { NothingToExportError } from './errors.js';

export interface PageSceneOptions {
  readonly document: StudioDocument;
  readonly page: NodeId;
  readonly fonts: StudioFonts;
  /** Library entries of image assets by asset key (`as_…`, or `as_…@ms_…` pinned). */
  readonly images: (asset: string) => LibraryEntry | undefined;
  readonly blobs: Pick<BlobStore, 'get'>;
  readonly decoder: ImageDecoder;
  readonly signal: AbortSignal;
  readonly scope: Scope;
  /** Draw the page's fill stack (B12 A-1; default true). Export's `transparent` passes false. */
  readonly pageFill?: boolean;
}

export interface PageScene {
  /** Scene IR batches in apply order (elements with CLEAR first, then images, then text). */
  readonly batches: readonly Uint8Array[];
  /** The page box (page units = design px). */
  readonly size: { readonly width: number; readonly height: number };
  /** Scene ids drawing these nodes: elements, and text groups (text inside a selected group or frame too). */
  sceneIds(nodes: readonly NodeId[]): number[];
  /** Image assets the page names that could not be resolved or decoded (they draw nothing). */
  readonly missingImages: readonly string[];
}

const DEFAULT_PAGE = { width: 1080, height: 1350 } as const;

/** The page's size from its part (`page.size`). */
export function pageSize(document: StudioDocument, page: NodeId): { readonly width: number; readonly height: number } {
  const size = document.part(page)?.prop(page, STRUCTURE_PATHS.pageSize) as { width?: unknown; height?: unknown } | undefined;
  const width = typeof size?.width === 'number' && size.width > 0 ? size.width : DEFAULT_PAGE.width;
  const height = typeof size?.height === 'number' && size.height > 0 ? size.height : DEFAULT_PAGE.height;
  return { width, height };
}

/** Build the page's scene (see the module header). */
export async function buildPageScene(options: PageSceneOptions): Promise<Result<PageScene>> {
  const { document, page, scope } = options;
  const part = document.part(page);
  if (part === undefined) return err(NothingToExportError({ message: `The snapshot has no page "${page}".`, details: { page } }));
  const source = createElementRenderSource({ stage: document.view, geometry: document.geometry, kit: document.kit, root: page, orderOf: (id) => part.node(id)?.order, pageFill: options.pageFill !== false });
  scope.defer(() => source.dispose());
  const projector = createRenderProjector(ElementProjection, source);
  source.changes();
  const projection = projector.snapshot();
  const resources = createSceneResources();
  const live = source.resources.snapshot();
  source.takeResources();
  if (live !== undefined && !resources.apply(live)) return err(NothingToExportError({ message: 'The page’s render resources could not be read.', details: { page } }));
  const store = createSceneStore(ElementProjection);
  const applied = store.apply(projection);
  if (!applied.ok) return applied;

  // Pass 1 learns which image assets the paints name; they are uploaded, then pass 2 encodes with their ids.
  const wanted = new Set<string>();
  createElementSceneEncoder({
    images: (asset) => {
      wanted.add(asset);
      return undefined;
    },
  }).encode(store, resources, { full: true });
  const uploads = createImageUploads({ blobs: options.blobs, decoder: options.decoder });
  const missingImages: string[] = [];
  for (const asset of wanted) {
    const entry = options.images(asset) ?? options.images(asset.split('@')[0] as string);
    const uploaded = entry === undefined ? undefined : await uploads.upload({ ...entry, asset: asset as LibraryEntry['asset'] }, options.signal);
    if (uploaded === undefined || !uploaded.ok) missingImages.push(asset);
  }
  const elements = createElementSceneEncoder({ images: (asset, variant) => uploads.images(asset, variant) }).encode(store, resources, { full: true });
  // Text glyphs go under their elements' nodes (B12b P2): tree order, clips, masks and parents' looks apply.
  const sceneParent = projectedSceneId(projector);
  const text = createTextLayer({ document, page, fonts: options.fonts, scope, sceneParent });
  const textIr = text.changes(true)?.ir;
  const assets = uploads.changes(true)?.assets;
  const batches = [elements, assets, textIr].filter((b): b is Uint8Array => b !== undefined && b.length > 0);
  return ok({
    batches,
    size: pageSize(document, page),
    missingImages,
    // A node's scene node draws its subtree, text included (its glyphs are children of the text element's node).
    sceneIds: (nodes) => [...new Set(nodes.flatMap((node) => sceneParent(node) ?? []))],
  });
}
