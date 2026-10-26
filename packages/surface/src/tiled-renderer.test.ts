import { box, createMemorySink, createTelemetry } from '@staticflux/core';
import type { MemoryPressure } from '@staticflux/runtime';
import { createMemoryBudgets } from '@staticflux/runtime/memory';
import { describe, expect, it } from 'vitest';
import { createGpuDevice } from './gpu-device.js';
import { createMemoryRasterBackend, type MemoryBox, type MemoryRasterBackend, type MemoryRasterDelta } from './memory-raster-backend.js';
import type { RasterBackend, RasterCamera, RasterImage } from './raster-backend.js';
import { manualTilePrepLane } from './raster-lane.js';
import { createTiledRenderer, type TiledRenderer } from './tiled-renderer.js';

const TILE = 64;
const RED: MemoryBox['color'] = [255, 0, 0, 255];
const BLUE: MemoryBox['color'] = [0, 0, 255, 255];
const GREEN: MemoryBox['color'] = [0, 160, 0, 255];

/** A 2×2-tile viewport (128 px) over a scene of a few boxes. */
const CAMERA: RasterCamera = { x: 0, y: 0, zoom: 1, width: 128, height: 128 };

interface Setup {
  backend: MemoryRasterBackend;
  renderer: TiledRenderer<MemoryRasterDelta>;
  lane: ReturnType<typeof manualTilePrepLane>;
  clock: { t: number };
  frames: { requested: number };
  sink: ReturnType<typeof createMemorySink>;
}

async function setup(options: { budgetMs?: number; tileCostMs?: number; warm?: boolean; memory?: Parameters<typeof createTiledRenderer>[0]['memory']; ring?: number; staleTiles?: number } = {}): Promise<Setup> {
  const backend = createMemoryRasterBackend({ tileSize: TILE, width: 128, height: 128, maxRegionSize: 128 });
  const clock = { t: 0 };
  const cost = options.tileCostMs ?? 7; // S1: ≈ 6.7 ms CPU per 512 px tile
  const timed: RasterBackend<MemoryRasterDelta> = {
    ...backend,
    renderTile: (slot, key, background) => {
      clock.t += cost;
      return backend.renderTile(slot, key, background);
    },
  };
  const lane = manualTilePrepLane();
  const frames = { requested: 0 };
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  const created = createTiledRenderer({
    id: 'test',
    backend: timed,
    lane,
    requestFrame: () => frames.requested++,
    now: () => clock.t,
    inFrameBudgetMs: options.budgetMs ?? 2,
    ring: options.ring ?? 0,
    ...(options.staleTiles === undefined ? {} : { inFrameStaleTiles: options.staleTiles }),
    camera: CAMERA,
    telemetry,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
  });
  if (!created.ok) throw created.error;
  await backend.attach({ signal: new AbortController().signal });
  backend.apply({
    set: [
      { id: 1, rect: { x0: 10, y0: 10, x1: 50, y1: 50 }, color: RED },
      { id: 2, rect: { x0: 70, y0: 20, x1: 120, y1: 100 }, color: BLUE },
      { id: 3, rect: { x0: 30, y0: 80, x1: 60, y1: 110 }, color: GREEN },
    ],
  });
  if (options.warm !== false) await created.value.warmUp(new AbortController().signal);
  return { backend, renderer: created.value, lane, clock, frames, sink };
}

function px(image: RasterImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
}

async function expected(backend: MemoryRasterBackend, camera: RasterCamera = CAMERA): Promise<RasterImage> {
  const r = await backend.renderRegion(
    { world: { x0: camera.x, y0: camera.y, x1: camera.x + camera.width / camera.zoom, y1: camera.y + camera.height / camera.zoom }, width: camera.width, height: camera.height, background: [1, 1, 1, 1] },
    { signal: new AbortController().signal },
  );
  if (!r.ok) throw r.error;
  return r.value;
}

function frame(renderer: TiledRenderer<MemoryRasterDelta>) {
  const r = renderer.frame();
  if (!r.ok) throw r.error;
  return r.value;
}

const metricNames = (sink: Setup['sink']): string[] => sink.records.filter((r) => r.type === 'metric').map((r) => (r as { metric: string }).metric);

describe('tiled renderer: warm-up and the cached first frame (S1)', () => {
  it('never rasterizes before warm-up; draws the snapshot instead and reports first-frame', async () => {
    const { backend, renderer, sink } = await setup({ warm: false });
    const shot: RasterImage = { width: 2, height: 2, data: new Uint8Array([200, 200, 200, 255, 200, 200, 200, 255, 200, 200, 200, 255, 200, 200, 200, 255]) };
    expect(renderer.showSnapshot({ image: shot, world: { x0: 0, y0: 0, x1: 128, y1: 128 } }).ok).toBe(true);
    const cold = frame(renderer);
    expect(cold).toMatchObject({ phase: 'cold', snapshot: true, renderedInFrame: 0, sharp: false });
    expect(backend.log.some((l) => l.startsWith('renderTile'))).toBe(false);
    expect(px(backend.frame, 5, 5)).toEqual([200, 200, 200, 255]);
    expect(metricNames(sink)).toContain('render/first-frame');
    expect(metricNames(sink)).not.toContain('render/first-sharp-frame');
  });

  it('after warm-up the first sharp frame drops the snapshot and is reported', async () => {
    const { backend, renderer, lane, sink } = await setup({ warm: false });
    renderer.showSnapshot({ image: { width: 1, height: 1, data: new Uint8Array([9, 9, 9, 255]) }, world: { x0: 0, y0: 0, x1: 128, y1: 128 } });
    expect(renderer.phase).toBe('cold');
    await renderer.warmUp(new AbortController().signal);
    expect(renderer.phase).toBe('ready');
    expect(backend.warmed).toBe(true);
    const first = frame(renderer);
    expect(first.snapshot).toBe(true); // snapshot covers the holes, so nothing renders in-frame
    expect(first.renderedInFrame).toBe(0);
    lane.run();
    const sharp = frame(renderer);
    expect(sharp).toMatchObject({ sharp: true, snapshot: false, unsharp: 0 });
    expect(metricNames(sink)).toContain('render/first-sharp-frame');
    expect(metricNames(sink)).toContain('render/warm-up');
    expect(backend.frame.data).toEqual((await expected(backend)).data);
  });
});

describe('tiled renderer: tile preparation off the frame', () => {
  it('renders at most what fits the in-frame budget, prepares the rest in the lane', async () => {
    const { backend, renderer, lane, frames, sink } = await setup({ budgetMs: 2, tileCostMs: 7 });
    const first = frame(renderer);
    expect(first.visible).toBe(4);
    expect(first.renderedInFrame).toBe(1); // a tile starts only while the budget is left: one 7 ms tile
    expect(first.missing).toBe(3);
    expect(first.prepScheduled).toBe(true);
    expect(lane.pending).toBe(1);
    const before = frames.requested;
    lane.run({ tilesPerSlice: 1 });
    expect(frames.requested).toBeGreaterThan(before); // lane asks for a frame when tiles land
    const second = frame(renderer);
    expect(second).toMatchObject({ sharp: true, renderedInFrame: 0, missing: 0 });
    expect(backend.frame.data).toEqual((await expected(backend)).data);
    expect(sink.records.filter((r) => r.type === 'metric' && (r as { metric: string }).metric === 'render/tiles-rendered').map((r) => (r as unknown as { attrs: { lane: string } }).attrs.lane)).toEqual(['frame', 'prep', 'prep', 'prep']);
  });

  it('with a zero budget the frame never rasterizes', async () => {
    const { backend, renderer, lane } = await setup({ budgetMs: 0 });
    expect(frame(renderer).renderedInFrame).toBe(0);
    expect(backend.log.filter((l) => l.startsWith('renderTile'))).toHaveLength(0);
    lane.run();
    expect(frame(renderer).sharp).toBe(true);
  });

  it('prepares the interest ring after the visible tiles', async () => {
    const { backend, renderer, lane } = await setup({ budgetMs: 0, ring: 1 });
    frame(renderer);
    lane.run();
    const rendered = backend.log.filter((l) => l.startsWith('renderTile'));
    expect(rendered.slice(0, 4).sort()).toEqual(['renderTile 0:0:0', 'renderTile 0:0:1', 'renderTile 0:1:0', 'renderTile 0:1:1']);
    // bounds clip the ring to tiles that hold content (x up to 120, y up to 110): nothing outside
    expect(rendered).toHaveLength(4);
  });

  it('a failing tile is reported and retried by the lane', async () => {
    const { backend, renderer, lane, sink } = await setup({ budgetMs: 100, tileCostMs: 1 });
    backend.failNextTile();
    const first = frame(renderer);
    expect(first.renderedInFrame).toBe(3);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'render.tile-failed')).toBe(true);
    lane.run();
    expect(frame(renderer).sharp).toBe(true);
  });
});

describe('tiled renderer: zoom shows the scaled previous level, never holes', () => {
  it('draws other levels under missing tiles and reports time-to-sharp', async () => {
    const { backend, renderer, lane, clock, sink } = await setup({ budgetMs: 0 });
    frame(renderer);
    lane.run();
    expect(frame(renderer).sharp).toBe(true);
    renderer.setCamera({ ...CAMERA, zoom: 2 }); // level 2: shows world 0…64
    clock.t += 5;
    const zoomed = frame(renderer);
    expect(zoomed.level).toBe(2);
    expect(zoomed.fallbackQuads).toBeGreaterThan(0);
    expect(zoomed.renderedInFrame).toBe(0);
    // No hole: the red box (world 10…50 → device 20…100) is visible from the level-0 tiles.
    expect(px(backend.frame, 60, 60)).toEqual([255, 0, 0, 255]);
    lane.run();
    const sharp = frame(renderer);
    expect(sharp).toMatchObject({ sharp: true, fallbackQuads: 0 });
    expect(backend.frame.data).toEqual((await expected(backend, { ...CAMERA, zoom: 2 })).data);
    expect(metricNames(sink)).toContain('render/time-to-sharp');
  });
});

describe('tiled renderer: edits are stale-while-revalidate', () => {
  it('keeps stale tiles on screen until they are re-rendered off the frame', async () => {
    const { backend, renderer, lane } = await setup({ budgetMs: 0 });
    frame(renderer);
    lane.run();
    frame(renderer);
    const rects = renderer.apply({ set: [{ id: 1, rect: { x0: 10, y0: 10, x1: 50, y1: 50 }, color: GREEN }] });
    expect(rects.ok && rects.value).toHaveLength(2);
    const stale = frame(renderer);
    expect(stale).toMatchObject({ missing: 0, unsharp: 1, sharp: false, renderedInFrame: 0 });
    expect(px(backend.frame, 20, 20)).toEqual([255, 0, 0, 255]); // old pixels, no hole
    lane.run();
    expect(frame(renderer).sharp).toBe(true);
    expect(px(backend.frame, 20, 20)).toEqual([0, 160, 0, 255]);
  });
});

describe('tiled renderer: stale visible tiles re-rendered in the frame (inFrameStaleTiles)', () => {
  // A move of every box (a repeat's copies) makes all four tiles stale. Without in-frame refresh the next frames
  // composite a mix: the tiles late in the centre-first order keep the old picture (FIX-DRAG-STUTTER).
  const moveAll = { set: [
    { id: 1, rect: { x0: 14, y0: 14, x1: 54, y1: 54 }, color: RED },
    { id: 2, rect: { x0: 74, y0: 24, x1: 124, y1: 104 }, color: BLUE },
    { id: 3, rect: { x0: 34, y0: 84, x1: 64, y1: 114 }, color: GREEN },
  ] };

  it('composites every stale visible tile fresh in the frame that follows the edit', async () => {
    const { backend, renderer, lane } = await setup({ budgetMs: 0, staleTiles: 16 });
    frame(renderer);
    lane.run();
    frame(renderer);
    renderer.apply(moveAll);
    const next = frame(renderer);
    expect(next).toMatchObject({ visible: 4, unsharp: 0, sharp: true, renderedInFrame: 4 });
    const want = await expected(backend);
    expect(backend.frame.data).toEqual(want.data);
  });

  it('is capped, and off by default (stale tiles wait for the prep lane)', async () => {
    const capped = await setup({ budgetMs: 0, staleTiles: 1 });
    frame(capped.renderer);
    capped.lane.run();
    frame(capped.renderer);
    capped.renderer.apply(moveAll);
    expect(frame(capped.renderer)).toMatchObject({ unsharp: 3, renderedInFrame: 1 });

    const off = await setup({ budgetMs: 0 });
    frame(off.renderer);
    off.lane.run();
    frame(off.renderer);
    off.renderer.apply(moveAll);
    expect(frame(off.renderer)).toMatchObject({ unsharp: 4, renderedInFrame: 0, sharp: false });
  });
});

describe('tiled renderer: drag through the lifted layer', () => {
  it('lift → drag (no raster) → apply the commit → drop keeps the layer until tiles are fresh', async () => {
    const { backend, renderer, lane } = await setup({ budgetMs: 0 });
    frame(renderer);
    lane.run();
    frame(renderer);
    const lifted = renderer.lift([1]);
    expect(lifted.ok).toBe(true);
    if (!lifted.ok) return;
    frame(renderer); // layer rendered once; tiles under it stale
    lane.run();
    frame(renderer);
    const rastersBefore = backend.log.filter((l) => l === 'renderLayer').length;
    const tilesBefore = backend.log.filter((l) => l.startsWith('renderTile')).length;
    for (let dx = 1; dx <= 30; dx += 1) {
      renderer.drag(lifted.value.id, dx, 0);
      frame(renderer);
    }
    expect(backend.log.filter((l) => l === 'renderLayer').length).toBe(rastersBefore); // drag only moves a quad
    expect(backend.log.filter((l) => l.startsWith('renderTile')).length).toBe(tilesBefore);
    // red box moved by 30: world 40…80; old place (15, 15) shows white, new place (75, 30) red
    expect(px(backend.frame, 15, 15)).toEqual([255, 255, 255, 255]);
    expect(px(backend.frame, 75, 15)).toEqual([255, 0, 0, 255]);
    // commit: the editor applies the move, then drops
    renderer.apply({ set: [{ id: 1, rect: { x0: 40, y0: 10, x1: 80, y1: 50 }, color: RED }] });
    expect(renderer.drop(lifted.value.id).ok).toBe(true);
    const dropping = frame(renderer);
    expect(dropping.layers).toBe(1); // still drawn: tiles under it are stale
    expect(px(backend.frame, 75, 15)).toEqual([255, 0, 0, 255]);
    lane.run();
    const done = frame(renderer);
    expect(done.layers).toBe(0);
    expect(backend.log).toContain('releaseLayer');
    expect(frame(renderer).sharp).toBe(true);
    expect(backend.frame.data).toEqual((await expected(backend)).data);
  });

  it('re-rasters a layer when the zoom changes or its content is edited', async () => {
    const { backend, renderer, lane } = await setup({ budgetMs: 0 });
    const lifted = renderer.lift([2]);
    if (!lifted.ok) throw lifted.error;
    frame(renderer);
    lane.run();
    renderer.setCamera({ ...CAMERA, zoom: 1.5 });
    frame(renderer);
    renderer.apply({ set: [{ id: 2, rect: { x0: 70, y0: 20, x1: 120, y1: 100 }, color: GREEN }] });
    frame(renderer);
    expect(backend.log.filter((l) => l === 'renderLayer')).toHaveLength(3);
    expect(renderer.drop(999).ok).toBe(false);
    renderer.drag(999, 1, 1); // unknown layer: ignored
  });
});

describe('tiled renderer: GPU memory budgets (SF-Δ29)', () => {
  it('registers tile bytes; pressure evicts tiles that are not on screen', async () => {
    const pressure = box<MemoryPressure>('nominal');
    const memory = createMemoryBudgets({ budgets: { gpu: 64 * TILE * TILE * 4 }, pressure });
    const { renderer, lane } = await setup({ budgetMs: 0, memory });
    frame(renderer);
    lane.run();
    renderer.setCamera({ ...CAMERA, zoom: 2 });
    frame(renderer);
    lane.run();
    frame(renderer);
    const before = memory.usage('gpu');
    expect(before.caches[0]?.id).toBe('test/tiles');
    expect(before.bytes).toBe(renderer.cache.size * TILE * TILE * 4);
    memory.setBudgets({ gpu: 4 * TILE * TILE * 4 });
    expect(renderer.cache.size).toBe(4); // only the 4 visible (pinned) tiles survive
    expect(frame(renderer).sharp).toBe(true);
  });
});

describe('tiled renderer: device loss', () => {
  it('re-attaches through the device lifecycle and re-renders from the retained scene', async () => {
    const { backend, renderer, lane } = await setup({ budgetMs: 0 });
    const device = createGpuDevice({ id: 'test', provider: { acquire: (o) => backend.attach(o) }, sleep: async () => undefined });
    await device.attach();
    frame(renderer);
    lane.run();
    frame(renderer);
    const lifted = renderer.lift([3]);
    if (!lifted.ok) throw lifted.error;
    frame(renderer);
    device.onRecovered(() => renderer.deviceRestored());
    const recovered = new Promise((resolve) => device.onRecovered(resolve));
    backend.lose();
    expect(renderer.frame().ok).toBe(false); // no device: composite fails, nothing crashes
    await recovered;
    expect(renderer.cache.size).toBe(0);
    frame(renderer);
    lane.run();
    const after = frame(renderer);
    expect(after.sharp).toBe(true);
    expect(backend.frame.data).toEqual((await expected(backend)).data);
    device.dispose();
  });
});

describe('tiled renderer: snapshots and lifecycle', () => {
  it('captures a snapshot that another renderer shows on its cold start', async () => {
    const { renderer, lane } = await setup({ budgetMs: 0 });
    frame(renderer);
    lane.run();
    frame(renderer);
    const shot = await renderer.captureSnapshot(new AbortController().signal);
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    expect(shot.value.world).toEqual({ x0: 0, y0: 0, x1: 128, y1: 128 });
    const next = await setup({ warm: false });
    next.renderer.showSnapshot(shot.value);
    frame(next.renderer);
    expect(next.backend.frame.data).toEqual(shot.value.image.data);
  });

  it('resize updates the camera; dispose releases layers and fails later calls', async () => {
    const { backend, renderer } = await setup();
    expect(renderer.resize(256, 64).ok).toBe(true);
    expect(renderer.camera).toMatchObject({ width: 256, height: 64 });
    renderer.lift([1]);
    renderer.dispose();
    renderer.dispose();
    expect(backend.log).toContain('releaseLayer');
    expect(renderer.frame().ok).toBe(false);
    expect(renderer.apply({}).ok).toBe(false);
    expect(renderer.lift([1]).ok).toBe(false);
    expect((await renderer.warmUp(new AbortController().signal)).ok).toBe(false);
    expect(renderer.showSnapshot({ image: { width: 1, height: 1, data: new Uint8Array(4) }, world: { x0: 0, y0: 0, x1: 1, y1: 1 } }).ok).toBe(false);
    expect(renderer.resize(1, 1).ok).toBe(false);
    expect((await renderer.captureSnapshot(new AbortController().signal)).ok).toBe(false);
  });

  it('a failed warm-up leaves the renderer cold', async () => {
    const { renderer } = await setup({ warm: false });
    const controller = new AbortController();
    controller.abort();
    expect((await renderer.warmUp(controller.signal)).ok).toBe(false);
    expect(renderer.phase).toBe('cold');
  });
});
