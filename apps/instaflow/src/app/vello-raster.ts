/**
 * The browser `CanvasRaster` (B8; B9: in the render module's worker): A6's Vello `RasterBackend` on the transferred
 * `OffscreenCanvas`, behind the framework's tiled renderer
 * and GPU device lifecycle (`@staticflux/surface/raster`). Scene IR batches go to the renderer; `present` schedules
 * frames on `requestAnimationFrame` until every visible tile is sharp (`studioFrame`).
 *
 * Each frame first re-renders the visible tiles an edit made stale (up to `STALE_TILES_PER_FRAME`), then composites,
 * so one frame shows one version of the scene; the interest ring and missing tiles are prepared a few per frame
 * (`TILES_PER_FRAME`). With stale tiles left to the prep lane, a drag of a repeat presented a mix: tiles late in the
 * centre-first order (the bottom row) kept the old copies until the pointer stopped (FIX-DRAG-STUTTER).
 *
 * Camera: Studio's camera maps page → CSS px (`screen = page × zoom + t`); the raster camera maps world → device px,
 * so origin = −t / zoom and zoom × devicePixelRatio.
 */
import { err, ok, type Result } from '@staticflux/core';
import { createGpuDevice, createTiledRenderer, type FrameReport, type ManualTilePrepLane, manualTilePrepLane, type RasterCamera, type TiledRenderer } from '@staticflux/surface/raster';
import type { RenderWasm } from '../render/render-module.js';
import { createVelloRasterBackend } from '../render/vello-backend.js';
import type { CanvasCamera, CanvasRaster } from './element-port.js';
import { CanvasBackendError } from './errors.js';

export interface VelloRasterOptions {
  readonly wasm: RenderWasm;
  /** The canvas transferred to this worker (`transferControlToOffscreen` on main). */
  readonly canvas: { width: number; height: number };
  /** CSS px. */
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio?: number;
  /** Straight RGBA 0…1 behind the scene (the page colour). */
  readonly background?: readonly [number, number, number, number];
  readonly raf?: (callback: () => void) => unknown;
  readonly signal: AbortSignal;
}

/**
 * Studio's raster background (B11b, STUDIO-UX-SPEC §1): transparent, so the canvas region's mist room and the page card
 * (drawn by the chrome behind the canvas) show where the scene draws nothing; the page's own fill stack is the first
 * node of the scene (B12 A-1).
 */
export const STUDIO_BACKGROUND: readonly [number, number, number, number] = Object.freeze([0, 0, 0, 0]) as readonly [number, number, number, number];

/** Tiles prepared per animation frame (SwiftShader frames are slow; a real GPU does many more). */
export const TILES_PER_FRAME = 4;

/**
 * Stale visible tiles re-rendered inside a frame before it composites (see the module header). A cap, not a target:
 * a 4K viewport at DPR 2 shows about 60 tiles of 512 px.
 */
export const STALE_TILES_PER_FRAME = 64;

/** Studio's tile policy for `createTiledRenderer`: no hole raster in the frame (a snapshot or another level covers), stale visible tiles re-rendered in it. */
export const STUDIO_TILE_POLICY = Object.freeze({ inFrameBudgetMs: 0, inFrameStaleTiles: STALE_TILES_PER_FRAME });

/**
 * One Studio raster frame: composite (re-rendering stale visible tiles first, `inFrameStaleTiles`), then prepare up
 * to `TILES_PER_FRAME` more off the composite. Returns whether another frame is owed.
 */
export function studioFrame<D>(renderer: TiledRenderer<D>, lane: ManualTilePrepLane): { readonly report: Result<FrameReport>; readonly again: boolean } {
  const report = renderer.frame();
  lane.run({ maxSlices: TILES_PER_FRAME });
  return { report, again: !report.ok || !report.value.sharp || lane.pending > 0 };
}

/** Map Studio's camera to the raster camera (see the module header). */
export function rasterCamera(camera: CanvasCamera, width: number, height: number, dpr: number): RasterCamera {
  return { x: -camera.tx / camera.zoom, y: -camera.ty / camera.zoom, zoom: camera.zoom * dpr, width: Math.max(1, Math.round(width * dpr)), height: Math.max(1, Math.round(height * dpr)) };
}

/** Worker rAF (Chrome has it in dedicated workers), else a 16 ms timeout. */
const defaultRaf = (): ((cb: () => void) => unknown) => {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  return typeof raf === 'function' ? (cb) => raf.call(globalThis, cb) : (cb) => setTimeout(cb, 16);
};

export async function createVelloRaster(options: VelloRasterOptions): Promise<Result<CanvasRaster>> {
  const dpr = options.devicePixelRatio ?? 1;
  let width = options.width;
  let height = options.height;
  const raf = options.raf ?? defaultRaf();
  const failed = (step: string, cause: unknown): Result<never> => err(CanvasBackendError({ cause, details: { step } }));
  const offscreen = options.canvas;
  try {
    offscreen.width = Math.max(1, Math.round(width * dpr));
    offscreen.height = Math.max(1, Math.round(height * dpr));
  } catch (cause) {
    return failed('canvas', cause);
  }
  const backend = createVelloRasterBackend({ wasm: options.wasm, canvas: offscreen, width: Math.round(width * dpr), height: Math.round(height * dpr), id: 'studio-canvas' });
  const device = createGpuDevice({ id: 'studio-canvas', provider: { acquire: (o) => backend.attach(o) } });
  const attached = await device.attach();
  if (!attached.ok) return failed('device', attached.error);
  const lane = manualTilePrepLane();
  let pending = false;
  let disposed = false;
  let camera: CanvasCamera = { tx: 0, ty: 0, zoom: 1 };
  const created = createTiledRenderer({
    backend,
    lane,
    requestFrame: () => schedule(),
    camera: rasterCamera(camera, width, height, dpr),
    ...STUDIO_TILE_POLICY,
    background: options.background ?? [1, 1, 1, 1],
  });
  if (!created.ok) return failed('renderer', created.error);
  const renderer: TiledRenderer<Uint8Array> = created.value;
  device.onRecovered(() => renderer.deviceRestored());
  const resized = renderer.resize(Math.round(width * dpr), Math.round(height * dpr));
  if (!resized.ok) return failed('resize', resized.error);
  const warm = await renderer.warmUp(options.signal);
  if (!warm.ok) return failed('warm-up', warm.error);
  function schedule(): void {
    if (pending || disposed) return;
    pending = true;
    raf(() => {
      pending = false;
      if (disposed) return;
      renderer.setCamera(rasterCamera(camera, width, height, dpr));
      if (studioFrame(renderer, lane).again) schedule();
    });
  }
  const raster: CanvasRaster = {
    apply(batch) {
      const applied = renderer.apply(batch);
      return applied.ok ? ok() : applied;
    },
    setCamera(next) {
      camera = next;
    },
    present() {
      schedule();
      return ok();
    },
    resize(w, h) {
      width = w;
      height = h;
      const pixels = { width: Math.max(1, Math.round(w * dpr)), height: Math.max(1, Math.round(h * dpr)) };
      // The transferred canvas keeps its pixel size until it is set here; the engine then reconfigures its surface.
      Object.assign(offscreen, pixels);
      const r = renderer.resize(pixels.width, pixels.height);
      schedule();
      return r;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.dispose();
      backend.dispose();
    },
  };
  options.signal.addEventListener('abort', () => raster.dispose(), { once: true });
  return ok(raster);
}
