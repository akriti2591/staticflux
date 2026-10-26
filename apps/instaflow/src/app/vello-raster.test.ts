// @vitest-environment node
// FIX-DRAG-STUTTER: Studio's tile policy over the framework's tiled renderer and the memory backend (no GPU). A quick
// drag of a 6×6 grid repeat moves every copy with each pointer move, so every visible tile goes stale every move.
import { createMemoryRasterBackend, createTiledRenderer, type MemoryBox, type MemoryRasterBackend, type MemoryRasterDelta, manualTilePrepLane, type RasterCamera } from '@staticflux/surface/raster';
import { describe, expect, it } from 'vitest';
import { rasterCamera, STALE_TILES_PER_FRAME, STUDIO_TILE_POLICY, studioFrame, TILES_PER_FRAME } from './vello-raster.js';

const TILE = 64;
/** 4×4 tiles of 64 px. */
const CAMERA: RasterCamera = { x: 0, y: 0, zoom: 1, width: 256, height: 256 };
const TANGERINE: MemoryBox['color'] = [255, 92, 57, 255];

/** A 6×6 grid of 30 px copies, 40 px apart, starting at (8 + dx, 8 + dy). */
const grid = (dx: number, dy: number): MemoryRasterDelta => ({
  set: Array.from({ length: 36 }, (_, i) => {
    const x0 = 8 + dx + (i % 6) * 40;
    const y0 = 8 + dy + Math.floor(i / 6) * 40;
    return { id: i + 1, rect: { x0, y0, x1: x0 + 30, y1: y0 + 30 }, color: TANGERINE };
  }),
});

async function expectedFrame(backend: MemoryRasterBackend): Promise<Uint8Array> {
  const r = await backend.renderRegion({ world: { x0: 0, y0: 0, x1: 256, y1: 256 }, width: 256, height: 256, background: [1, 1, 1, 1] }, { signal: new AbortController().signal });
  if (!r.ok) throw r.error;
  return r.value.data;
}

/** One frame per move (a quick drag: the pointer moves every frame); counts the frames that showed a stale picture. */
async function dragJourney(policy: { readonly inFrameBudgetMs: number; readonly inFrameStaleTiles: number }) {
  const backend = createMemoryRasterBackend({ tileSize: TILE, width: 256, height: 256 });
  await backend.attach({ signal: new AbortController().signal });
  const lane = manualTilePrepLane();
  const created = createTiledRenderer({ backend, lane, requestFrame: () => undefined, camera: CAMERA, ring: 0, ...policy });
  if (!created.ok) throw created.error;
  const renderer = created.value;
  await renderer.warmUp(new AbortController().signal);
  renderer.apply(grid(0, 0));
  for (let i = 0; i < 20 && studioFrame(renderer, lane).again; i++);
  let torn = 0;
  let bottomRowStale = 0;
  let maxInFrame = 0;
  const moves = 12;
  for (let m = 1; m <= moves; m++) {
    renderer.apply(grid(m * 2, m));
    const { report } = studioFrame(renderer, lane);
    if (!report.ok) throw report.error;
    maxInFrame = Math.max(maxInFrame, report.value.renderedInFrame);
    if (!Buffer.from(backend.frame.data).equals(Buffer.from(await expectedFrame(backend)))) torn += 1;
    if (!renderer.cache.has({ level: 0, tx: 1, ty: 3 })) bottomRowStale += 1;
  }
  // Frames after the last move until the picture is current.
  let settle = 0;
  while (!Buffer.from(backend.frame.data).equals(Buffer.from(await expectedFrame(backend))) && settle < 20) {
    studioFrame(renderer, lane);
    settle += 1;
  }
  return { moves, torn, bottomRowStale, settle, maxInFrame };
}

describe('Studio raster tile policy (FIX-DRAG-STUTTER)', () => {
  it('a quick drag of a 6×6 repeat shows the current picture in every frame: no stale bottom row, settled at once', async () => {
    const r = await dragJourney(STUDIO_TILE_POLICY);
    // Budget: every frame of the drag is current (0 torn), nothing to catch up after it, at most the visible tiles
    // (16) rasterized in one frame.
    expect(r).toEqual({ moves: 12, torn: 0, bottomRowStale: 0, settle: 0, maxInFrame: 16 });
  });

  it('the old policy (stale tiles left to the prep lane, 4 a frame) tears every frame and starves the bottom row', async () => {
    const r = await dragJourney({ inFrameBudgetMs: 0, inFrameStaleTiles: 0 });
    expect(r.torn).toBe(r.moves);
    expect(r.bottomRowStale).toBe(r.moves);
    expect(r.settle).toBeGreaterThanOrEqual(Math.ceil(16 / TILES_PER_FRAME));
  });

  it('caps the in-frame refresh and maps Studio’s camera to device pixels', () => {
    expect(STUDIO_TILE_POLICY.inFrameStaleTiles).toBe(STALE_TILES_PER_FRAME);
    expect(STALE_TILES_PER_FRAME).toBeGreaterThanOrEqual(60); // a 4K viewport at DPR 2
    expect(rasterCamera({ tx: 100, ty: 50, zoom: 0.5 }, 800, 600, 2)).toEqual({ x: -200, y: -100, zoom: 1, width: 1600, height: 1200 });
  });
});
