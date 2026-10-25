/**
 * BENCH (not a unit test): CPU cost of the tiled renderer's policy per frame, which must stay a small
 * fraction of the 8.3 ms frame budget (IF-15.2). Run on demand; timings are never asserted in CI:
 *
 *   pnpm vitest bench --run --reporter=verbose packages/surface/src/raster.bench.ts
 *
 * GPU timings (warm-up, first sharp frame, drag, device-loss recovery) are printed by `pnpm test:gpu`
 * (`apps/instaflow/src/render/render.gpu.test.ts`); absolute numbers need a real GPU (S1 owner run).
 */
import { ok } from '@staticflux/core';
import { describe, test } from 'vitest';
import type { RasterBackend, RasterCamera } from './raster-backend.js';
import { manualTilePrepLane } from './raster-lane.js';
import { createTileCache } from './raster-tile-cache.js';
import { levelForZoom, visibleTiles } from './raster-tiling.js';
import { createTiledRenderer } from './tiled-renderer.js';

const CAMERA_4K: RasterCamera = { x: 1000, y: 1000, zoom: 0.7, width: 3840, height: 2160 };
const BOUNDS = { x0: 0, y0: 0, x1: 6000, y1: 6000 };

/** A backend that draws nothing: measures the TypeScript policy alone. */
function nullBackend(): RasterBackend<null> {
  return {
    id: 'null',
    tileSize: 512,
    maxRegionSize: 4096,
    attach: async () =>
      ok({
        facts: { adapter: { status: 'available', info: { vendor: '', architecture: '', device: '', description: '' }, isFallbackAdapter: false, features: [], limits: {} }, features: [], limits: {} },
        lost: new Promise(() => undefined),
        destroy: () => undefined,
      }),
    warmUp: async () => ok(undefined),
    apply: () => ok([]),
    bounds: () => BOUNDS,
    resize: () => ok(undefined),
    renderTile: () => ok({ bytes: 512 * 512 * 4 }),
    releaseTile: () => undefined,
    setLayer: () => ok([]),
    renderLayer: (layer, zoom) => ok({ layer, zoom, x: 0, y: 0, width: 100, height: 100, bytes: 40_000 }),
    releaseLayer: () => undefined,
    uploadSnapshot: () => ok(undefined),
    composite: () => ok(undefined),
    readFrame: async () => ok({ width: 1, height: 1, data: new Uint8Array(4) }),
    renderRegion: async (r) => ok({ width: r.width, height: r.height, data: new Uint8Array(r.width * r.height * 4) }),
    stats: () => ({ tiles: 0, tileBytes: 0, layerBytes: 0, otherBytes: 0 }),
    dispose: () => undefined,
  };
}

describe('raster policy', () => {
  test('tile planning and cache', async ({ bench }) => {
    const cache = createTileCache({ release: () => undefined, maxTiles: 256 });
    if (!cache.ok) throw cache.error;
    let tx = 0;
    await bench.compare(
      bench('visibleTiles: 4K viewport + interest ring', () => {
        visibleTiles(CAMERA_4K, levelForZoom(CAMERA_4K.zoom), { ring: 1, bounds: BOUNDS });
      }),
      bench('tile cache: reserve + commit, LRU eviction at 256 tiles', () => {
        const key = { level: 0, tx: tx++ % 1024, ty: 0 };
        cache.value.commit(key, cache.value.reserve(key), 512 * 512 * 4, tx);
      }),
    );
  });

  test('frame', async ({ bench }) => {
    const created = createTiledRenderer({ backend: nullBackend(), lane: manualTilePrepLane(), requestFrame: () => undefined, camera: CAMERA_4K, inFrameBudgetMs: 1e9 });
    if (!created.ok) throw created.error;
    const renderer = created.value;
    await renderer.warmUp(new AbortController().signal);
    renderer.frame();
    const lifted = renderer.lift([1, 2, 3]);
    if (!lifted.ok) throw lifted.error;
    let n = 0;
    await bench('frame(): pan + drag a lifted layer, every tile cached (4K, null backend)', () => {
      n += 1;
      renderer.setCamera({ ...CAMERA_4K, x: 1000 + (n % 2) });
      renderer.drag(lifted.value.id, n % 50, 0);
      renderer.frame();
    }).run();
  });
});
