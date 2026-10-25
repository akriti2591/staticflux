/**
 * Tile geometry (IF-7.4, S1): `tileSize`-pixel tiles per zoom level, one level per √2 of zoom.
 * Level `k` renders at scale `s = 2^(k/2)` device pixels per world unit, so a camera at zoom `z`
 * uses level `round(2·log2 z)` and draws its tiles scaled by `z / s` ∈ [2^-¼, 2^¼].
 * Tiles are ordered from the viewport centre outwards (Manhattan distance, as in Penpot) so the
 * middle of the screen sharpens first; an interest ring of `ring` tiles is prepared ahead of pans.
 * Headless renders beyond texture limits split into chunks with `planChunks`.
 */
import { type RasterCamera, type TileKey, type WorldRect, cameraWorldRect, intersects } from './raster-backend.js';

/** S1: 512 px tiles have no seams (sparse-strip coverage is per pixel) and cost ≈ 6.7 ms CPU each. */
export const DEFAULT_TILE_SIZE = 512;

/** Zoom level for a camera zoom: one level per √2. */
export function levelForZoom(zoom: number): number {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return 0;
  return Math.round(2 * Math.log2(zoom));
}

/** Device pixels per world unit at `level`. */
export function levelScale(level: number): number {
  return 2 ** (level / 2);
}

/** World rectangle covered by a tile. */
export function tileWorldRect(key: TileKey, tileSize: number = DEFAULT_TILE_SIZE): WorldRect {
  const span = tileSize / levelScale(key.level);
  return { x0: key.tx * span, y0: key.ty * span, x1: (key.tx + 1) * span, y1: (key.ty + 1) * span };
}

/** Stable string id of a tile key (`level:tx:ty`). */
export function tileId(key: TileKey): string {
  return `${key.level}:${key.tx}:${key.ty}`;
}

export interface VisibleTilesOptions {
  readonly tileSize?: number;
  /** Extra tiles around the viewport (interest ring). Default 0. */
  readonly ring?: number;
  /** Scene bounds: tiles outside are pure background and never listed. */
  readonly bounds?: WorldRect | undefined;
}

/** Tiles of `level` that cover the camera, centre first (Manhattan order, ties row-major). */
export function visibleTiles(camera: RasterCamera, level: number, options: VisibleTilesOptions = {}): TileKey[] {
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  const ring = options.ring ?? 0;
  const s = levelScale(level);
  const world = cameraWorldRect(camera);
  const x0 = Math.floor((world.x0 * s) / tileSize) - ring;
  const y0 = Math.floor((world.y0 * s) / tileSize) - ring;
  const x1 = Math.floor((world.x1 * s - 1e-9) / tileSize) + ring;
  const y1 = Math.floor((world.y1 * s - 1e-9) / tileSize) + ring;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const out: { key: TileKey; d: number }[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const key = { level, tx, ty };
      if (options.bounds !== undefined && !intersects(tileWorldRect(key, tileSize), options.bounds)) continue;
      out.push({ key, d: Math.abs(tx - cx) + Math.abs(ty - cy) });
    }
  }
  out.sort((a, b) => a.d - b.d || a.key.ty - b.key.ty || a.key.tx - b.key.tx);
  return out.map((e) => e.key);
}

/** Device-pixel destination of a world rect under a camera. */
export function worldToDevice(camera: RasterCamera, rect: WorldRect): [number, number, number, number] {
  return [(rect.x0 - camera.x) * camera.zoom, (rect.y0 - camera.y) * camera.zoom, (rect.x1 - camera.x) * camera.zoom, (rect.y1 - camera.y) * camera.zoom];
}

/** True when `outer` fully contains `inner`. */
export function containsRect(outer: WorldRect, inner: WorldRect): boolean {
  return outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1;
}

export interface Chunk {
  /** Output pixel rectangle of this chunk. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Split a `width × height` output into row-major chunks of at most `max` pixels per side. */
export function planChunks(width: number, height: number, max: number): Chunk[] {
  const size = Math.max(1, Math.floor(max));
  const chunks: Chunk[] = [];
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      chunks.push({ x, y, width: Math.min(size, width - x), height: Math.min(size, height - y) });
    }
  }
  return chunks;
}
