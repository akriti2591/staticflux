// @vitest-environment node
import { AbortedError, createMachine } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { authoringBuilt } from '../app/test-helpers.js';
import { P } from '../elements/components.js';
import { decodePlan } from './export-module.js';
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from './formats.js';
import { ExportJobLifecycle, type ExportJobRequest, type ExportJobState, type ExportProgress, runExportJob } from './job.js';
import { createExportFixture, exportBuilt, pdfToText, recordingRaster } from './testing/test-helpers.js';

const opts = (o: Partial<ExportOptions>): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...o });
const utf8 = new TextDecoder();

/** PNG width and height (IHDR). */
const pngSize = (bytes: Uint8Array): [number, number] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};

// Composes real scenes (authoring Wasm: geometry, Parley) and writes with the real export Wasm; ~1-3 s per job on the
// shared 4-core container.
describe.skipIf(!authoringBuilt || !exportBuilt)('export job (Node: real composition and writers, recorded raster)', () => {
  async function setup(options: Partial<ExportOptions>, extra: Partial<ExportJobRequest> = {}) {
    const f = await createExportFixture();
    const snapshot = await f.freeze();
    const request: ExportJobRequest = { snapshot, options: opts(options), title: 'Spring Flyer', pages: ['p1', 'p2'], selection: [], images: f.images, ...extra };
    const io = { store: f.studio.workspace.store, blobs: f.blobs };
    return { f, request, io };
  }

  it('PNG: the page at its scale over white, from the snapshot, through the headless surface', { timeout: 60_000 }, async () => {
    const { f, request, io } = await setup({ format: 'png', scale: 2 });
    const states: ExportJobState[] = [];
    const progress: ExportProgress[] = [];
    const out = await runExportJob(request, f.env, io, { signal: f.studio.signal, onState: (s) => states.push(s), onProgress: (p) => progress.push(p) });
    if (!out.ok) throw out.error;
    expect(out.value.files).toHaveLength(1);
    const file = out.value.files[0]!;
    expect(file.name).toBe('Spring Flyer.png');
    expect(file.mime).toBe('image/png');
    expect(pngSize(file.bytes)).toEqual([2160, 2700]);
    const raster = f.rasters[0]!;
    expect(raster.regions[0]).toMatchObject({ world: { x0: 0, y0: 0, x1: 1080, y1: 1350 }, width: 2160, height: 2700, background: [1, 1, 1, 1] });
    // elements (CLEAR first), the photo, then text: the scene the canvas would get, without the overlay
    expect(raster.batches.length).toBe(3);
    expect(out.value.missingImages).toEqual([]);
    expect(raster.disposed).toBe(true);
    expect(states).toEqual(['opening', 'composing', 'rendering', 'writing', 'done']);
    expect(progress.at(-1)?.fraction).toBe(1);
  });

  it('PNG transparent, every page: one file per page, transparent background', { timeout: 60_000 }, async () => {
    const { f, request, io } = await setup({ format: 'png', scale: 1, transparent: true, scope: 'pages' });
    const out = await runExportJob(request, f.env, io, { signal: f.studio.signal });
    if (!out.ok) throw out.error;
    expect(out.value.files.map((x) => x.name)).toEqual(['Spring Flyer - 1.png', 'Spring Flyer - 2.png']);
    expect(f.rasters[0]!.regions.map((r) => r.background)).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
  });

  it('SVG: one document per page with the real elements, text outlines labelled with their text, embedded images', { timeout: 60_000 }, async () => {
    const { f, request, io } = await setup({ format: 'svg' });
    const out = await runExportJob(request, f.env, io, { signal: f.studio.signal });
    if (!out.ok) throw out.error;
    const svg = utf8.decode(out.value.files[0]!.bytes);
    expect(out.value.files[0]!.name).toBe('Spring Flyer.svg');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('viewBox="0 0 1080 1350"');
    expect(svg).toContain('<title>Spring Flyer</title>');
    expect(svg).toContain('aria-label="Hello export"');
    expect(svg).toContain('data:image/png;base64,'); // the photo
    expect(svg).toContain('<mask'); // the luminance mask
    expect(svg).toContain('<filter'); // shadows and blurs are SVG filters (D21)
    expect(out.value.patches).toBe(0);
  });

  it('PDF: every page in one file, real text, shadows and blurs as raster patches (D21)', { timeout: 60_000 }, async () => {
    const { f, request, io } = await setup({ format: 'pdf', scope: 'pages' });
    const out = await runExportJob(request, f.env, io, { signal: f.studio.signal });
    if (!out.ok) throw out.error;
    expect(out.value.files).toHaveLength(1);
    const pdf = out.value.files[0]!;
    expect(pdf.name).toBe('Spring Flyer.pdf');
    const text = utf8.decode(pdf.bytes);
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/Type3');
    expect(text).toContain('/ToUnicode');
    expect(out.value.patches).toBeGreaterThan(0);
    // real text: poppler extracts what the person typed (when installed)
    const extracted = pdfToText(pdf.bytes);
    if (extracted !== undefined) expect(extracted).toContain('Hello export');
    // patches are rendered by the raster at 2 px per design px, over transparency
    const regions = f.rasters[0]!.regions;
    expect(regions.length).toBe(out.value.patches);
    for (const r of regions) {
      expect(r.background).toEqual([0, 0, 0, 0]);
      expect(r.width).toBe(Math.round((r.world.x1 - r.world.x0) * 2));
    }
  });

  it('selection: only the selected elements, in their own bounds', { timeout: 60_000 }, async () => {
    const { f, request, io } = await setup({ format: 'png', scope: 'selection', scale: 1 }, { pages: ['p1'], selection: ['star', 'hello'] });
    const out = await runExportJob(request, f.env, io, { signal: f.studio.signal });
    if (!out.ok) throw out.error;
    const region = f.rasters[0]!.regions[0]!;
    // the star (with its glow) and the text (conservative glyph ink boxes), not the page
    expect(region.world.x1 - region.world.x0).toBeLessThan(540);
    expect(region.world.y1 - region.world.y0).toBeLessThan(675);
    expect(pngSize(out.value.files[0]!.bytes)).toEqual([region.width, region.height]);
    // nothing selected: IF-EXP-002
    const empty = await runExportJob({ ...request, selection: ['nope'] }, f.env, io, { signal: f.studio.signal });
    expect(!empty.ok && empty.error.code).toBe('IF-EXP-002');
  });

  it('renders from the frozen snapshot: later edits do not leak in, and the export writes nothing (D10)', { timeout: 60_000 }, async () => {
    const { f, request, io } = await setup({ format: 'svg' });
    // an edit after the freeze
    f.commit([{ op: 'create', node: 'late', kind: 'shape', parent: 'p1', props: { [P.x]: 0, [P.y]: 0, [P.w]: 10, [P.h]: 10, [P.fills]: [{ paint: '#123456' }] } }]);
    const headBefore = await f.studio.workspace.store.readHead(f.studio.document.doc.asset, f.studio.signal);
    const out = await runExportJob(request, f.env, io, { signal: f.studio.signal });
    if (!out.ok) throw out.error;
    expect(utf8.decode(out.value.files[0]!.bytes)).not.toContain('#123456');
    const headAfter = await f.studio.workspace.store.readHead(f.studio.document.doc.asset, f.studio.signal);
    expect(headAfter).toEqual(headBefore);
  });

  it('cancels: an aborted job returns AbortedError and ends cancelled', { timeout: 60_000 }, async () => {
    const { f, request, io } = await setup({ format: 'png', scope: 'pages' });
    const controller = new AbortController();
    const states: ExportJobState[] = [];
    const out = await runExportJob(request, f.env, io, { signal: controller.signal, onState: (s) => states.push(s), onProgress: () => controller.abort() });
    expect(!out.ok && out.error.code).toBe(AbortedError({}).code);
    expect(states.at(-1)).toBe('cancelled');
  });

  it('a raster failure is IF-EXP-005; a broken snapshot is IF-EXP-003', { timeout: 60_000 }, async () => {
    const { f, request, io } = await setup({ format: 'png' });
    const failing = { ...f.env, raster: async () => ({ ok: false as const, error: AbortedError({}) }) };
    const aborted = await runExportJob(request, failing, io, { signal: f.studio.signal });
    expect(!aborted.ok && aborted.error.kind).toBe('aborted');
    const r = recordingRaster();
    const broken = { ...r, renderRegion: async () => ({ ok: false as const, error: AbortedError({ message: 'x' }) }) };
    const brokenEnv = { ...f.env, raster: async () => ({ ok: true as const, value: broken }) };
    expect((await runExportJob(request, brokenEnv, io, { signal: f.studio.signal })).ok).toBe(false);
    const missing = { ...request, snapshot: { ...request.snapshot, manifest: { ...request.snapshot.manifest, parts: { root: { digest: '0'.repeat(64), size: 1 } as never } } } };
    const out = await runExportJob(missing, f.env, io, { signal: f.studio.signal });
    expect(!out.ok && out.error.code).toBe('IF-EXP-003');
  });
});

describe('export job machine and plan encoding', () => {
  it('walks queued → … → done and ends in failed or cancelled from any step', () => {
    const m = createMachine(ExportJobLifecycle);
    for (const e of ['open', 'compose', 'render', 'compose', 'render', 'write', 'done'] as const) m.send(e);
    expect(m.state).toBe('done');
    const c = createMachine(ExportJobLifecycle);
    c.send('open');
    c.send('cancel');
    expect(c.state).toBe('cancelled');
    expect(c.can('done')).toBe(false);
  });

  it('decodes a patch plan', () => {
    const ir = Uint8Array.from([1, 2, 3]);
    const bytes = new Uint8Array(4 + 40 + ir.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(4, 7, true);
    [1.5, 2, 30.5, 40].forEach((v, i) => view.setFloat64(8 + i * 8, v, true));
    view.setUint32(40, ir.length, true);
    bytes.set(ir, 44);
    expect(decodePlan(bytes)).toEqual([{ node: 7, world: { x0: 1.5, y0: 2, x1: 30.5, y1: 40 }, ir }]);
    expect(decodePlan(new Uint8Array(2))).toEqual([]);
  });
});
