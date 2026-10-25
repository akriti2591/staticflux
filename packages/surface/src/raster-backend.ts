/**
 * The `RasterBackend` port (IF-7.4, R11.43): what a tiled, GPU-composited renderer needs from a
 * rasterizer such as Vello. The framework owns the **policy** (which tiles, when, cache and memory
 * budgets, device lifecycle, headless tiling); a backend owns the **pixels** (scene state, tile and
 * layer textures, the compositor, readback). The scene format is the backend's own (`Delta`): the
 * framework never looks inside it, it only learns which world rectangles changed.
 *
 * Coordinates: the scene lives in world units. A camera maps world → device pixels with
 * `device = (world - origin) * zoom`. Tiles are `tileSize` device pixels square at zoom level `k`
 * (scale `2^(k/2)`, so one level per √2 of zoom; see raster-tiling.ts).
 *
 * Pixels crossing the port are straight-alpha RGBA8 without row padding (`RasterImage`, the same
 * shape as testkit's `RgbaImage`).
 */
import type { Result } from '@staticflux/core';
import type { GpuDeviceHandle } from './gpu-device.js';

/** Axis-aligned rectangle in world units (`x0 ≤ x1`, `y0 ≤ y1`). */
export interface WorldRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** One tile: zoom level `level` (scale 2^(level/2)), column `tx`, row `ty`. */
export interface TileKey {
  readonly level: number;
  readonly tx: number;
  readonly ty: number;
}

/** World → device mapping of a viewport. */
export interface RasterCamera {
  /** World coordinates of the viewport's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** Device pixels per world unit. */
  readonly zoom: number;
  /** Viewport size in device pixels. */
  readonly width: number;
  readonly height: number;
}

/** Straight-alpha RGBA8 pixels, rows packed (`data.length === width * height * 4`). */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** What a composited quad samples. `external` (video frames) is reserved for M3. */
export type CompositeSource =
  | { readonly kind: 'tile'; readonly slot: number }
  | { readonly kind: 'layer'; readonly layer: number }
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'external'; readonly id: number };

/** A textured quad in device pixels. `uv` defaults to the whole source. */
export interface CompositeQuad {
  readonly source: CompositeSource;
  /** Destination `[x0, y0, x1, y1]` in device pixels (may extend past the viewport). */
  readonly dst: readonly [number, number, number, number];
  readonly uv?: readonly [number, number, number, number];
  /** 0…1, default 1. */
  readonly opacity?: number;
}

export interface CompositeFrame {
  /** Background (straight RGBA, 0…1) cleared before the quads, which are drawn in order. */
  readonly clear: readonly [number, number, number, number];
  readonly quads: readonly CompositeQuad[];
  /** Present to the canvas (false for headless frames that are only read back). Default true. */
  readonly present?: boolean;
}

/** Device-pixel placement of a rasterized lifted layer at the zoom it was rendered for. */
export interface LayerRaster {
  readonly layer: number;
  readonly zoom: number;
  /** Device-pixel position of the texture's top-left corner at `zoom` and zero drag (world · zoom). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** GPU bytes the layer texture holds. */
  readonly bytes: number;
}

export interface RasterRegion {
  /** World rectangle mapped onto the whole output. */
  readonly world: WorldRect;
  /** Output size in device pixels (≤ `maxRegionSize` per side). */
  readonly width: number;
  readonly height: number;
  /** Straight RGBA background, 0…1 (default transparent). */
  readonly background?: readonly [number, number, number, number];
}

export interface RasterBackendStats {
  readonly tiles: number;
  readonly tileBytes: number;
  readonly layerBytes: number;
  /** Frame targets, snapshot, atlases and other textures the backend knows about. */
  readonly otherBytes: number;
}

/**
 * A rasterizer behind the tiled renderer, the headless surface and the device lifecycle.
 * Every method returns a `Result`; nothing throws across the port (engine panics become SF-SURF-014).
 */
export interface RasterBackend<Delta = Uint8Array> {
  readonly id: string;
  /** Tile edge in device pixels (512 for Vello, S1). */
  readonly tileSize: number;
  /** Largest region `renderRegion` accepts per side (≤ the device's `maxTextureDimension2D`). */
  readonly maxRegionSize: number;
  /**
   * Create (or, after a loss, re-create) the GPU device, the compositor and the canvas
   * configuration, then rebuild every GPU object from the retained CPU-side scene (images
   * re-uploaded; tile slots and layer textures are gone and must be rendered again).
   */
  attach(options: { readonly signal: AbortSignal }): Promise<Result<GpuDeviceHandle>>;
  /** Compile the rasterizer's pipelines with a tiny scene (hides the cold first frame, S1: ≈ 1 s). */
  warmUp(options: { readonly signal: AbortSignal }): Promise<Result<void>>;
  /** Apply a scene change (snapshot or delta, backend format). Returns the world rects whose pixels changed. */
  apply(delta: Delta): Result<readonly WorldRect[]>;
  /** Scene content bounds (tiles outside are never rendered), or undefined for an empty scene. */
  bounds(): WorldRect | undefined;
  /** Resize the presented canvas (device pixels). */
  resize(width: number, height: number): Result<void>;
  /**
   * Rasterize one tile into texture `slot` (allocated on first use) over `background` (straight RGBA,
   * 0…1; opaque, so a tile fully covers other levels drawn under it). Nodes in lifted layers are skipped.
   */
  renderTile(slot: number, key: TileKey, background: readonly [number, number, number, number]): Result<{ readonly bytes: number }>;
  /** Free a tile texture. Unknown slots are ignored. */
  releaseTile(slot: number): void;
  /**
   * Set the nodes lifted into `layer` (they leave the tiles; `[]` gives them back). Returns the
   * world rects of every node that entered or left, whose tiles must be re-rendered.
   */
  setLayer(layer: number, nodes: readonly number[]): Result<readonly WorldRect[]>;
  /** Rasterize a lifted layer at `zoom` (re-raster only when zoom or content changes). */
  renderLayer(layer: number, zoom: number): Result<LayerRaster>;
  /** Free a layer's texture and membership (after `setLayer(layer, [])` once its tiles are fresh). Unknown layers are ignored. */
  releaseLayer(layer: number): void;
  /** Upload a cached frame (shown until the GPU path is warm, S1). */
  uploadSnapshot(image: RasterImage): Result<void>;
  /** Draw quads into the frame target, then present it unless `present === false`. */
  composite(frame: CompositeFrame): Result<void>;
  /** Read back the last composited frame. */
  readFrame(options: { readonly signal: AbortSignal }): Promise<Result<RasterImage>>;
  /** Render a world region straight to pixels, bypassing tiles (headless export, parity checks). */
  renderRegion(region: RasterRegion, options: { readonly signal: AbortSignal }): Promise<Result<RasterImage>>;
  stats(): RasterBackendStats;
  /** Release every GPU and CPU resource. Idempotent; later calls fail with SF-SURF-014. */
  dispose(): void;
}

/** Union of two rects. */
export function unionRect(a: WorldRect, b: WorldRect): WorldRect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** True when the rects overlap with a non-empty intersection. */
export function intersects(a: WorldRect, b: WorldRect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** World rect a camera shows. */
export function cameraWorldRect(camera: RasterCamera): WorldRect {
  return { x0: camera.x, y0: camera.y, x1: camera.x + camera.width / camera.zoom, y1: camera.y + camera.height / camera.zoom };
}
