import { describe, expect, it } from 'vitest';
import { cameraWorldRect, intersects, unionRect } from './raster-backend.js';
import { containsRect, DEFAULT_TILE_SIZE, levelForZoom, levelScale, planChunks, tileId, tileWorldRect, visibleTiles, worldToDevice } from './raster-tiling.js';

describe('zoom levels (one per √2)', () => {
  it('maps zoom to the nearest √2 level and back', () => {
    expect(levelForZoom(1)).toBe(0);
    expect(levelForZoom(2)).toBe(2);
    expect(levelForZoom(Math.SQRT2)).toBe(1);
    expect(levelForZoom(0.25)).toBe(-4);
    expect(levelForZoom(1.18)).toBe(0); // < 2^¼
    expect(levelForZoom(1.2)).toBe(1); // > 2^¼
    expect(levelScale(1)).toBeCloseTo(Math.SQRT2, 12);
    expect(levelScale(-4)).toBe(0.25);
  });

  it('treats non-positive or non-finite zoom as level 0', () => {
    expect(levelForZoom(0)).toBe(0);
    expect(levelForZoom(-1)).toBe(0);
    expect(levelForZoom(Number.NaN)).toBe(0);
    expect(levelForZoom(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('every camera zoom draws its level at a scale within [2^-¼, 2^¼]', () => {
    for (let z = 0.05; z < 40; z *= 1.07) {
      const ratio = z / levelScale(levelForZoom(z));
      expect(ratio).toBeGreaterThanOrEqual(2 ** -0.25 - 1e-9);
      expect(ratio).toBeLessThanOrEqual(2 ** 0.25 + 1e-9);
    }
  });
});

describe('tiles', () => {
  it('tile world rects tile the plane at each level', () => {
    expect(tileWorldRect({ level: 0, tx: 1, ty: 2 })).toEqual({ x0: 512, y0: 1024, x1: 1024, y1: 1536 });
    expect(tileWorldRect({ level: 2, tx: 1, ty: 0 })).toEqual({ x0: 256, y0: 0, x1: 512, y1: 256 });
    expect(tileWorldRect({ level: -2, tx: -1, ty: 0 }, 256)).toEqual({ x0: -512, y0: 0, x1: 0, y1: 512 });
    expect(tileId({ level: -3, tx: 4, ty: -5 })).toBe('-3:4:-5');
    expect(DEFAULT_TILE_SIZE).toBe(512);
  });

  it('lists the tiles covering a camera, centre first (Manhattan order)', () => {
    const camera = { x: 0, y: 0, zoom: 1, width: 1536, height: 1024 };
    const keys = visibleTiles(camera, 0);
    expect(keys).toHaveLength(6);
    // centre of a 3×2 grid is (1, 0.5): tiles (1,0) and (1,1) first
    expect(keys.slice(0, 2)).toEqual([
      { level: 0, tx: 1, ty: 0 },
      { level: 0, tx: 1, ty: 1 },
    ]);
    expect(new Set(keys.map(tileId)).size).toBe(6);
  });

  it('does not include a tile that only touches the viewport edge', () => {
    const keys = visibleTiles({ x: 0, y: 0, zoom: 1, width: 512, height: 512 }, 0);
    expect(keys).toEqual([{ level: 0, tx: 0, ty: 0 }]);
  });

  it('adds an interest ring and skips tiles outside the scene bounds', () => {
    const camera = { x: 0, y: 0, zoom: 1, width: 512, height: 512 };
    expect(visibleTiles(camera, 0, { ring: 1 })).toHaveLength(9);
    const inside = visibleTiles(camera, 0, { ring: 1, bounds: { x0: 0, y0: 0, x1: 2000, y1: 2000 } });
    expect(inside.map(tileId).sort()).toEqual(['0:0:0', '0:0:1', '0:1:0', '0:1:1']);
    expect(visibleTiles(camera, 0, { bounds: { x0: 5000, y0: 5000, x1: 6000, y1: 6000 } })).toEqual([]);
  });

  it('uses the level scale, not the camera zoom, for the grid', () => {
    const camera = { x: 0, y: 0, zoom: 1.1, width: 512, height: 512 }; // world 0…465
    expect(visibleTiles(camera, levelForZoom(1.1)).map(tileId)).toEqual(['0:0:0']);
  });

  it('maps world rects to device pixels and tests containment', () => {
    const camera = { x: 100, y: 50, zoom: 2, width: 800, height: 600 };
    expect(worldToDevice(camera, { x0: 100, y0: 50, x1: 110, y1: 60 })).toEqual([0, 0, 20, 20]);
    expect(cameraWorldRect(camera)).toEqual({ x0: 100, y0: 50, x1: 500, y1: 350 });
    expect(containsRect({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 1, y0: 1, x1: 10, y1: 10 })).toBe(true);
    expect(containsRect({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 1, y0: 1, x1: 11, y1: 10 })).toBe(false);
    expect(intersects({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 1, y0: 0, x1: 2, y1: 1 })).toBe(false);
    expect(unionRect({ x0: 0, y0: 5, x1: 1, y1: 6 }, { x0: -1, y0: 0, x1: 0, y1: 1 })).toEqual({ x0: -1, y0: 0, x1: 1, y1: 6 });
  });
});

describe('planChunks', () => {
  it('splits an output into row-major chunks within the limit', () => {
    const chunks = planChunks(150, 100, 64);
    expect(chunks).toHaveLength(6);
    expect(chunks[0]).toEqual({ x: 0, y: 0, width: 64, height: 64 });
    expect(chunks[2]).toEqual({ x: 128, y: 0, width: 22, height: 64 });
    expect(chunks[5]).toEqual({ x: 128, y: 64, width: 22, height: 36 });
    expect(chunks.reduce((n, c) => n + c.width * c.height, 0)).toBe(150 * 100);
    expect(planChunks(10, 10, 4096)).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
    expect(planChunks(3, 2, 0)).toHaveLength(6); // limit clamps to 1
  });
});
