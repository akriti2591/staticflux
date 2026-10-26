/**
 * One export job (C1; IF-29.5–29.12, ARCHITECTURE §3.5), in the export worker: open the frozen snapshot, compose
 * each page's scene, and make the files.
 *
 * - **PNG**: the render module's headless surface (Vello, the canvas's compositor; chunked past the device's texture
 *   limit, cancellable between chunks) at `scale` px per design px, over the page colour or transparent, encoded by
 *   `@staticflux/surface/image` (deterministic PNG). Selection exports render only the selection (isolated by the
 *   export Wasm: holders keep their clips and opacity, masks keep masking).
 * - **SVG / PDF**: the export Wasm records the scene through the render crate's one traversal and writes it; the
 *   features its format cannot express (D21's rasterize list) are planned as raster patches, rendered here by the
 *   same headless surface and handed back. PDF puts every page in one file; SVG writes one file per page.
 *
 * The job writes nothing anywhere (D10): it reads the snapshot's blobs and returns bytes. Every step checks the
 * signal; progress goes out per page and per rendered chunk.
 *
 * Machine `instaflow/export-job` (LIFECYCLES §31): queued → opening → composing ⇄ rendering → writing → done;
 * any non-terminal state → failed | cancelled.
 */
import type { BlobStore } from '@staticflux/blob';
import { AbortedError, createMachine, createScope, defineMachine, err, ok, type Result, type SfError } from '@staticflux/core';
import type { CrdtEngine, DocumentStore, NodeId } from '@staticflux/document/v2';
import { encodePng, type RasterImage } from '@staticflux/surface/image';
import { createHeadlessSurface, type RasterBackend } from '@staticflux/surface/raster';
import type { StudioFonts } from '../app/text-layer.js';
import type { BrandKitSpec } from '../elements/brand-kit.js';
import type { GeometryService } from '../elements/geometry.js';
import type { LibraryEntry } from '../library/library-doc.js';
import type { ImageDecoder } from '../library/renditions.js';
import { ExportRenderError, ExportWriteError, NothingToExportError } from './errors.js';
import { decodePlan, type ExporterWasm, type ExportWasm } from './export-module.js';
import { EXPORT_FORMATS, type ExportFile, exportFileName, type ExportOptions, MAX_EXPORT_PIXELS, PAGE_BACKGROUND, PATCH_SCALE } from './formats.js';
import { buildPageScene, type PageScene } from './scene.js';
import { type ExportSnapshot, openSnapshotDocument } from './snapshot-document.js';

export const ExportJobLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/export-job',
  initial: 'queued',
  states: ['queued', 'opening', 'composing', 'rendering', 'writing', 'done', 'failed', 'cancelled'],
  transitions: {
    queued: { open: 'opening', fail: 'failed', cancel: 'cancelled' },
    opening: { compose: 'composing', fail: 'failed', cancel: 'cancelled' },
    composing: { render: 'rendering', fail: 'failed', cancel: 'cancelled' },
    rendering: { compose: 'composing', write: 'writing', fail: 'failed', cancel: 'cancelled' },
    writing: { done: 'done', fail: 'failed', cancel: 'cancelled' },
  },
  terminal: ['done', 'failed', 'cancelled'],
});
export type ExportJobState = (typeof ExportJobLifecycle.states)[number];

/** What the job exports (built by the editor and main from the person's choice). */
export interface ExportJobRequest {
  readonly snapshot: ExportSnapshot;
  readonly options: ExportOptions;
  /** The design's title (file names, SVG title, PDF info). */
  readonly title: string;
  /** Pages in export order (one for `page` and `selection`). */
  readonly pages: readonly NodeId[];
  /** The selection (`scope: 'selection'`). */
  readonly selection: readonly NodeId[];
  /** Library entries of the workspace's image assets (the page's image paints are resolved from these). */
  readonly images: readonly LibraryEntry[];
}

export interface ExportProgress {
  readonly state: ExportJobState;
  /** 0…1 over the whole job. */
  readonly fraction: number;
  /** The page being exported (0-based) and how many there are. */
  readonly page: number;
  readonly pages: number;
}

export interface ExportResult {
  readonly files: readonly ExportFile[];
  /** Raster patches the vector writers needed (D21). */
  readonly patches: number;
  /** Image assets that could not be drawn (missing or undecodable). */
  readonly missingImages: readonly string[];
}

/** The render module as the job uses it: a headless Vello backend (any `RasterBackend` in tests). */
export type ExportRaster = Pick<RasterBackend<Uint8Array>, 'id' | 'apply' | 'renderRegion' | 'maxRegionSize'> & { dispose(): void };

/** What the export worker loaded (the browser entry's pieces; fixtures in tests). */
export interface ExportJobEnv {
  readonly engine: CrdtEngine;
  readonly geometry: GeometryService;
  readonly fonts: StudioFonts;
  readonly decoder: ImageDecoder;
  readonly brand?: BrandKitSpec;
  /** A headless raster (made once per job, on first need). */
  raster(signal: AbortSignal): Promise<Result<ExportRaster>>;
  /** The export Wasm (loaded lazily: SVG, PDF and selection exports only). */
  vector(signal: AbortSignal): Promise<Result<ExportWasm>>;
}

export interface ExportJobIo {
  readonly store: Pick<DocumentStore, 'getBlob'>;
  readonly blobs: Pick<BlobStore, 'get'>;
}

export interface ExportJobHooks {
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: ExportProgress) => void;
  readonly onState?: (state: ExportJobState) => void;
}

type Region = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

const utf8 = /* @__PURE__ */ new TextEncoder();

/** Run one export (see the module header). Cancelling returns AbortedError and the job ends `cancelled`. */
export async function runExportJob(request: ExportJobRequest, env: ExportJobEnv, io: ExportJobIo, hooks: ExportJobHooks): Promise<Result<ExportResult>> {
  const machine = createMachine(ExportJobLifecycle);
  const { signal } = hooks;
  const scope = createScope('instaflow/export-job');
  const move = (event: 'open' | 'compose' | 'render' | 'write' | 'done'): void => {
    if (machine.can(event)) {
      machine.send(event);
      hooks.onState?.(machine.state);
    }
  };
  const format = EXPORT_FORMATS[request.options.format];
  const pages = request.options.scope === 'pages' ? request.pages : request.pages.slice(0, 1);
  const progress = (page: number, within: number): void => hooks.onProgress?.({ state: machine.state, fraction: Math.min(1, (page + within) / Math.max(1, pages.length)), page, pages: pages.length });
  let raster: ExportRaster | undefined;
  let exporter: ExporterWasm | undefined;
  const finish = (result: Result<ExportResult>): Result<ExportResult> => {
    raster?.dispose();
    exporter?.free();
    void scope.dispose();
    if (result.ok) move('done');
    else if (result.error.kind === 'aborted' || signal.aborted) {
      if (machine.can('cancel')) machine.send('cancel');
      hooks.onState?.(machine.state);
      return err(AbortedError({ cause: signal.reason }));
    } else if (machine.can('fail')) {
      machine.send('fail');
      hooks.onState?.(machine.state);
    }
    return result;
  };
  const aborted = (): Result<never> => err(AbortedError({ cause: signal.reason }));
  const getRaster = async (): Promise<Result<ExportRaster>> => {
    if (raster !== undefined) return ok(raster);
    const made = await env.raster(signal);
    if (!made.ok) return err(made.error.kind === 'aborted' ? made.error : ExportRenderError({ cause: made.error, details: { step: 'raster' } }));
    raster = made.value;
    return ok(raster);
  };
  const getExporter = async (): Promise<Result<ExporterWasm>> => {
    if (exporter !== undefined) return ok(exporter);
    const wasm = await env.vector(signal);
    if (!wasm.ok) return wasm;
    exporter = new wasm.value.Exporter();
    return ok(exporter);
  };
  const call = <T>(what: string, fn: () => T): Result<T> => {
    try {
      return ok(fn());
    } catch (cause) {
      return err(ExportWriteError({ cause, message: `The export writer failed (${what}): ${String((cause as Error)?.message ?? cause)}`, details: { step: what } }));
    }
  };
  const render = async (r: ExportRaster, world: Region, width: number, height: number, background: readonly [number, number, number, number], onChunk?: (done: number, total: number) => void): Promise<Result<RasterImage>> => {
    const surface = createHeadlessSurface({ backend: r, maxPixels: MAX_EXPORT_PIXELS });
    const out = await surface.render({ world, width, height, background, signal, ...(onChunk === undefined ? {} : { onProgress: onChunk }) });
    return out.ok || out.error.kind === 'aborted' ? out : err(ExportRenderError({ cause: out.error, details: { width, height } }));
  };

  if (signal.aborted) return finish(aborted());
  move('open');
  const opened = await openSnapshotDocument({ store: io.store, snapshot: request.snapshot, engine: env.engine, geometry: env.geometry, ...(env.brand === undefined ? {} : { brand: env.brand }), signal, scope });
  if (!opened.ok) return finish(opened);
  const document = opened.value;
  const images = new Map(request.images.map((e) => [e.asset as string, e]));
  const files: ExportFile[] = [];
  const missing = new Set<string>();
  let patches = 0;
  // B12 (A-1): a page export draws the page's own fill stack (a scene node, D21 parity) over nothing; `transparent`
  // leaves that node out. A selection export keeps the plain page colour behind it unless transparent.
  const background = request.options.transparent || request.options.scope !== 'selection' ? undefined : PAGE_BACKGROUND;
  const rgbaBackground: readonly [number, number, number, number] = background === undefined ? [0, 0, 0, 0] : [background[0] / 255, background[1] / 255, background[2] / 255, background[3] / 255];
  const bgBytes = background === undefined ? new Uint8Array() : Uint8Array.from(background);

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index] as NodeId;
    if (signal.aborted) return finish(aborted());
    move('compose');
    progress(index, 0);
    const built = await buildPageScene({ document, page, fonts: env.fonts, images: (a) => images.get(a), blobs: io.blobs, decoder: env.decoder, signal, scope, pageFill: request.options.transparent !== true });
    if (!built.ok) return finish(built);
    const scene: PageScene = built.value;
    for (const m of scene.missingImages) missing.add(m);

    // What to draw: the page box, or the selection's own bounds and only its scene nodes.
    let region: Region = { x0: 0, y0: 0, x1: scene.size.width, y1: scene.size.height };
    let batches: readonly Uint8Array[] = scene.batches;
    if (request.options.scope === 'selection' || format.kind === 'vector') {
      const x = await getExporter();
      if (!x.ok) return finish(x);
      for (const batch of scene.batches) {
        const applied = call('apply', () => x.value.apply(batch));
        if (!applied.ok) return finish(applied);
      }
      if (request.options.scope === 'selection') {
        const ids = Uint32Array.from(scene.sceneIds(request.selection));
        const b = ids.length === 0 ? undefined : call('bounds', () => x.value.bounds(ids));
        if (b === undefined || !b.ok || b.value.length !== 4) return finish(b !== undefined && !b.ok ? b : err(NothingToExportError({ details: { selection: request.selection.length } })));
        const [x0, y0, x1, y1] = b.value as unknown as [number, number, number, number];
        region = { x0, y0, x1, y1 };
        const isolated = call('isolate', () => x.value.isolate(ids));
        if (!isolated.ok) return finish(isolated);
        batches = [isolated.value];
        const reapplied = call('apply selection', () => x.value.apply(isolated.value));
        if (!reapplied.ok) return finish(reapplied);
      }
    }
    if (!(region.x1 > region.x0 && region.y1 > region.y0)) return finish(err(NothingToExportError({ details: { page } })));

    move('render');
    if (format.kind === 'raster') {
      const scale = request.options.scale;
      const width = Math.max(1, Math.round((region.x1 - region.x0) * scale));
      const height = Math.max(1, Math.round((region.y1 - region.y0) * scale));
      const r = await getRaster();
      if (!r.ok) return finish(r);
      for (const batch of batches) {
        const applied = r.value.apply(batch);
        if (!applied.ok) return finish(err(ExportRenderError({ cause: applied.error, details: { step: 'apply' } })));
      }
      const image = await render(r.value, region, width, height, rgbaBackground, (done, total) => progress(index, (0.8 * done) / total));
      if (!image.ok) return finish(image);
      move('write');
      const png = await encodePng(image.value, { signal });
      if (!png.ok) return finish(png);
      files.push({ name: exportFileName(request.title, request.options.format, { index, count: pages.length }), mime: format.mime, bytes: png.value });
      continue;
    }

    // Vector: patches first (rendered by the same headless surface), then the writer.
    const x = exporter as ExporterWasm;
    const planned = call('plan', () => decodePlan(x.plan(format.wire ?? 0, region.x0, region.y0, region.x1, region.y1, PATCH_SCALE)));
    if (!planned.ok) return finish(planned);
    for (const [k, p] of planned.value.entries()) {
      const r = await getRaster();
      if (!r.ok) return finish(r);
      const applied = r.value.apply(p.ir);
      if (!applied.ok) return finish(err(ExportRenderError({ cause: applied.error, details: { step: 'patch scene', node: p.node } })));
      const w = Math.max(1, Math.round((p.world.x1 - p.world.x0) * PATCH_SCALE));
      const h = Math.max(1, Math.round((p.world.y1 - p.world.y0) * PATCH_SCALE));
      const pixels = await render(r.value, p.world, w, h, [0, 0, 0, 0]);
      if (!pixels.ok) return finish(pixels);
      const handed = call('patch', () => x.patch(p.node, w, h, pixels.value.data));
      if (!handed.ok) return finish(handed);
      patches += 1;
      progress(index, (0.8 * (k + 1)) / planned.value.length);
    }
    move('write');
    const width = region.x1 - region.x0;
    const height = region.y1 - region.y0;
    if (format.multiPage) {
      const added = call('pdf page', () => x.pdf_page(region.x0, region.y0, region.x1, region.y1, width, height, bgBytes));
      if (!added.ok) return finish(added);
    } else {
      const svg = call('svg', () => x.svg(region.x0, region.y0, region.x1, region.y1, width, height, bgBytes, request.title));
      if (!svg.ok) return finish(svg);
      files.push({ name: exportFileName(request.title, request.options.format, { index, count: pages.length }), mime: format.mime, bytes: utf8.encode(svg.value) });
    }
    progress(index, 1);
  }
  if (format.multiPage && exporter !== undefined) {
    const x = exporter;
    const pdf = call('pdf', () => x.pdf_finish(request.title));
    if (!pdf.ok) return finish(pdf);
    files.push({ name: exportFileName(request.title, request.options.format), mime: format.mime, bytes: pdf.value });
  }
  hooks.onProgress?.({ state: machine.state, fraction: 1, page: pages.length - 1, pages: pages.length });
  return finish(ok({ files, patches, missingImages: [...missing] }));
}

/** Errors that ended a job, as the person reads them. */
export function describeExportError(error: SfError): string {
  return error.kind === 'aborted' ? 'Export cancelled.' : error.message;
}
