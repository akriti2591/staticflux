/**
 * `@staticflux/surface/raster` — tiled GPU rendering behind a `RasterBackend` port (Instaflow M1 A6:
 * SF-Δ23 device lifecycle, SF-Δ24 headless surface, SF-Δ29 GPU memory budgets; IF-7.4, 7.5, 7.11).
 * Loaded by render and export workers only; the main surface entry does not pull it in.
 */
export * from './raster-backend.js';
export * from './raster-tiling.js';
export * from './raster-tile-cache.js';
export * from './raster-lane.js';
export * from './tiled-renderer.js';
export * from './headless.js';
export * from './gpu-device.js';
export * from './memory-raster-backend.js';
export {
  GpuDeviceLostError,
  GpuRecoveryOverBudgetError,
  GpuUnavailableError,
  HeadlessRenderError,
  RasterBackendError,
  RasterReadbackError,
} from './raster-errors.js';
