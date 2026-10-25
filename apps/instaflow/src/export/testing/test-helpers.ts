/**
 * Test-only fixtures for exports (never imported by app code): the export Wasm loaded in Node (`pnpm build` →
 * engine/dist), a recording raster standing in for the render module (Node has no WebGPU: it returns a flat image of
 * the requested size and records the batches it was given), a Studio document with content and image assets, its
 * frozen snapshot (B5), and the job environment over the Node Wasm fixtures.
 */
import { createBlobStore, createMemoryObjectStore } from '@staticflux/blob';
import { ok, type Result } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import type { RasterImage } from '@staticflux/surface/image';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioFixture, type StudioFixture, unwrap } from '../../app/test-helpers.js';
import { P } from '../../elements/components.js';
import { checkerPixels, elementSceneOps } from '../../elements/testing/scene-fixture.js';
import type { LibraryEntry } from '../../library/library-doc.js';
import type { ImageDecoder } from '../../library/renditions.js';
import { placeTextOps } from '../../text/commands.js';
import { ENGINE_DIST } from '../../text/test-helpers.js';
import { createPartCapture } from '../../versioning/parts.js';
import { createExportSnapshotService } from '../../versioning/snapshot.js';
import { type ExportWasm, loadExportModule } from '../export-module.js';
import type { ExportJobEnv, ExportRaster } from '../job.js';
import type { ExportSnapshot } from '../snapshot-document.js';

/** True when `pnpm build` produced the export Wasm. */
export const exportBuilt = existsSync(new URL('sf-wasm-manifest.json', ENGINE_DIST)) && readFileSync(new URL('sf-wasm-manifest.json', ENGINE_DIST), 'utf8').includes('"export"');

let cached: Promise<ExportWasm> | undefined;

/** The export Wasm in Node (file-system fetch, bytes for the glue). */
export function loadExportInNode(): Promise<ExportWasm> {
  cached ??= (async () => {
    const loaded = await loadExportModule({
      manifestUrl: new URL('sf-wasm-manifest.json', ENGINE_DIST).href,
      fetch: async (url) => ({ ok: true, status: 200, json: async () => JSON.parse(readFileSync(new URL(url), 'utf8')) as unknown }),
      importModule: (url) => import(/* @vite-ignore */ url),
      wasmSource: async (url) => readFileSync(new URL(url)),
    });
    if (!loaded.ok) throw loaded.error;
    return loaded.value;
  })();
  return cached;
}

/** A raster that records what it was given and draws a flat colour (straight RGBA) of the requested size. */
export interface RecordingExportRaster extends ExportRaster {
  readonly batches: Uint8Array[];
  readonly regions: { readonly world: { x0: number; y0: number; x1: number; y1: number }; readonly width: number; readonly height: number; readonly background: readonly number[] }[];
  readonly disposed: boolean;
}

export function recordingRaster(color: readonly [number, number, number, number] = [200, 40, 60, 255], maxRegionSize = 4096): RecordingExportRaster {
  const batches: Uint8Array[] = [];
  const regions: RecordingExportRaster['regions'] = [];
  let disposed = false;
  return {
    id: 'recording-export',
    maxRegionSize,
    batches,
    regions,
    get disposed() {
      return disposed;
    },
    apply(batch) {
      batches.push(batch);
      return ok([]);
    },
    async renderRegion(region) {
      regions.push({ world: { ...region.world }, width: region.width, height: region.height, background: [...(region.background ?? [0, 0, 0, 0])] });
      const data = new Uint8Array(region.width * region.height * 4);
      for (let i = 0; i < data.length; i += 4) data.set(color, i);
      return ok<RasterImage>({ width: region.width, height: region.height, data });
    },
    dispose() {
      disposed = true;
    },
  };
}

/** Decodes any bytes to the 16 × 16 checker (Place tests). */
export const checkerDecoder: ImageDecoder = { decode: async () => ok({ width: 16, height: 16, data: checkerPixels() }) };

export interface ExportFixture {
  readonly studio: StudioFixture;
  /** The workspace's blob store with the photo's bytes. */
  readonly blobs: ReturnType<typeof createBlobStore>;
  readonly images: readonly LibraryEntry[];
  readonly rasters: RecordingExportRaster[];
  /** The job environment over the Node fixtures (rasters recorded, the real export Wasm). */
  readonly env: ExportJobEnv;
  freeze(): Promise<ExportSnapshot>;
  /** Commit ops on page `page` (one undo step). */
  commit(ops: readonly PartOp[], page?: NodeId): void;
}

/**
 * A two-page design: page 1 holds B1's element scene (every appearance feature, a mask, a boolean, an image `as_photo`)
 * and a text element "Hello export"; page 2 a single rect.
 */
export async function createExportFixture(): Promise<ExportFixture> {
  const studio = await createStudioFixture({ pages: 2 });
  const blobs = createBlobStore(createMemoryObjectStore());
  const photo = unwrap(await blobs.put(new Uint8Array([137, 80, 78, 71]), { mime: 'image/png' }));
  const images: LibraryEntry[] = [
    { asset: 'as_photo' as LibraryEntry['asset'], kind: 'image', title: 'Photo', createdAt: '2026-10-25T00:00:00.000Z', folder: '', favorite: false, tags: [], mime: 'image/png', content: photo, renditions: {} },
  ];
  const person = { kind: 'human' as const, id: 'g-ada', displayName: 'Ada', via: 'direct' as const };
  const commit = (ops: readonly PartOp[], page: NodeId = 'p1'): void => {
    unwrap(studio.document.commitOps(page, person, 'fixture', ops));
  };
  commit(elementSceneOps());
  commit(unwrap(placeTextOps({ node: 'hello', parent: 'p1', x: 10, y: 140, text: 'Hello export' })));
  commit([{ op: 'create', node: 'r2', kind: 'shape', parent: 'p2', props: { [P.x]: 100, [P.y]: 100, [P.w]: 200, [P.h]: 120, [P.fills]: [{ paint: '#3b6cff' }] } }], 'p2');
  const snapshots = createExportSnapshotService({ doc: studio.document.doc, store: studio.workspace.store, capture: createPartCapture({ store: studio.workspace.store }) });
  const rasters: RecordingExportRaster[] = [];
  const env: ExportJobEnv = {
    engine: studio.workspace.engine,
    geometry: studio.document.geometry,
    fonts: studio.fonts,
    decoder: checkerDecoder,
    raster: async (): Promise<Result<ExportRaster>> => {
      const r = recordingRaster();
      rasters.push(r);
      return ok(r);
    },
    vector: async () => ok(await loadExportInNode()),
  };
  return {
    studio,
    blobs,
    images,
    rasters,
    env,
    async freeze() {
      const frozen = unwrap(await snapshots.freeze(studio.signal));
      return { id: frozen.id, ref: frozen.ref, manifest: frozen.manifest };
    },
    commit,
  };
}

/** `pdftotext` of a PDF (poppler), or undefined when the tool is not installed. */
export function pdfToText(pdf: Uint8Array): string | undefined {
  const probe = spawnSync('pdftotext', ['-v']);
  if (probe.error !== undefined) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'sf-export-'));
  try {
    const file = join(dir, 'in.pdf');
    writeFileSync(file, pdf);
    const out = spawnSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
    return out.status === 0 ? out.stdout : undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
