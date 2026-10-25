/**
 * The browser `CanvasRaster` (B8; B9: in the render module's worker): A6's Vello `RasterBackend` on the transferred
 * `OffscreenCanvas`, behind the framework's tiled renderer
 * and GPU device lifecycle (`@staticflux/surface/raster`). Scene IR batches go to the renderer; `present` schedules
 * frames on `requestAnimationFrame` until every visible tile is sharp (tile prep runs in the same frames, a few
 * tiles per frame so input stays responsive).
 *
 * Camera: Studio's camera maps page → CSS px (`screen = page × zoom + t`); the raster camera maps world → device px,
 * so origin = −t / zoom and zoom × devicePixelRatio.
 */
import { err, ok, type Result } from '@staticflux/core';
import { createGpuDevice, createTiledRenderer, manualTilePrepLane, type RasterCamera, type TiledRenderer } from '@staticflux/surface/raster';
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

/** Tiles prepared per animation frame (SwiftShader frames are slow; a real GPU does many more). */
export const TILES_PER_FRAME = 4;

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
    inFrameBudgetMs: 0,
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
      const report = renderer.frame();
      lane.run({ maxSlices: TILES_PER_FRAME });
      if (!report.ok || !report.value.sharp || lane.pending > 0) schedule();
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
