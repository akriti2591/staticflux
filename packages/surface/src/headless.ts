/**
 * Headless surface (SF-Δ24 headless part, R11.46): render a world region to pixels without a canvas,
 * for export (C1 PNG), agent screenshots and parity tests. Outputs larger than the backend's
 * `maxRegionSize` (the device's texture limit) are rendered in chunks and stitched; each chunk maps
 * an exact sub-rectangle of the world, so the result equals one big render (S1: tiles have no seams).
 * Cancellable between chunks; progress is reported per chunk.
 *
 * ```ts
 * const surface = createHeadlessSurface({ backend });
 * const png = await surface.render({ world: page.bounds, width: 4961, height: 7016, signal });
 * ```
 */
import { AbortedError, createNoopTelemetry, err, metric, ok, type Result, type Telemetry } from '@staticflux/core';
import { HeadlessRenderError } from './raster-errors.js';
import type { RasterBackend, RasterImage, WorldRect } from './raster-backend.js';
import { planChunks } from './raster-tiling.js';

export const HeadlessMetrics = {
  render: /* @__PURE__ */ metric.histogram('surface/headless-render', { unit: 'ms', description: 'Headless render of one output (all chunks).' }),
  chunks: /* @__PURE__ */ metric.counter('surface/headless-chunks', { description: 'Chunks rendered by headless surfaces.' }),
} as const;

/** 1 GiB of RGBA output by default (≈ 16k × 16k). */
export const DEFAULT_HEADLESS_MAX_PIXELS = 256 * 1024 * 1024;

export interface HeadlessRenderRequest {
  readonly world: WorldRect;
  readonly width: number;
  readonly height: number;
  readonly background?: readonly [number, number, number, number];
  readonly signal?: AbortSignal;
  /** Called after each chunk with the number done and the total. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface HeadlessSurfaceOptions {
  readonly backend: Pick<RasterBackend<unknown>, 'renderRegion' | 'maxRegionSize' | 'id'>;
  /** Chunk edge (default and maximum: the backend's `maxRegionSize`). */
  readonly chunkSize?: number;
  readonly maxPixels?: number;
  readonly telemetry?: Telemetry;
  readonly now?: () => number;
}

export interface HeadlessSurface {
  render(request: HeadlessRenderRequest): Promise<Result<RasterImage>>;
}

export function createHeadlessSurface(options: HeadlessSurfaceOptions): HeadlessSurface {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? (() => performance.now());
  const maxPixels = options.maxPixels ?? DEFAULT_HEADLESS_MAX_PIXELS;
  return {
    async render(request) {
      const { width, height, world } = request;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        return err(HeadlessRenderError({ message: `Headless output must have positive integer size, got ${width}×${height}.`, details: { width, height } }));
      }
      if (width * height > maxPixels) {
        return err(HeadlessRenderError({ message: `Headless output ${width}×${height} exceeds ${maxPixels} pixels.`, details: { width, height, maxPixels } }));
      }
      if (!(world.x1 > world.x0) || !(world.y1 > world.y0)) {
        return err(HeadlessRenderError({ message: 'The world rect of a headless render must have a positive area.', details: { ...world } }));
      }
      const signal = request.signal ?? new AbortController().signal;
      const chunkSize = Math.max(1, Math.min(options.chunkSize ?? options.backend.maxRegionSize, options.backend.maxRegionSize));
      const chunks = planChunks(width, height, chunkSize);
      const out = new Uint8Array(width * height * 4);
      const sx = (world.x1 - world.x0) / width;
      const sy = (world.y1 - world.y0) / height;
      const started = now();
      let done = 0;
      for (const chunk of chunks) {
        if (signal.aborted) return err(AbortedError({ cause: signal.reason, details: { done, total: chunks.length } }));
        const region = {
          world: { x0: world.x0 + chunk.x * sx, y0: world.y0 + chunk.y * sy, x1: world.x0 + (chunk.x + chunk.width) * sx, y1: world.y0 + (chunk.y + chunk.height) * sy },
          width: chunk.width,
          height: chunk.height,
          ...(request.background === undefined ? {} : { background: request.background }),
        };
        const pixels = await options.backend.renderRegion(region, { signal });
        if (!pixels.ok) return pixels;
        if (pixels.value.width !== chunk.width || pixels.value.height !== chunk.height || pixels.value.data.length !== chunk.width * chunk.height * 4) {
          return err(HeadlessRenderError({ message: 'The backend returned a chunk of the wrong size.', details: { expected: [chunk.width, chunk.height], got: [pixels.value.width, pixels.value.height] } }));
        }
        const rowBytes = chunk.width * 4;
        for (let row = 0; row < chunk.height; row++) {
          out.set(pixels.value.data.subarray(row * rowBytes, (row + 1) * rowBytes), ((chunk.y + row) * width + chunk.x) * 4);
        }
        done += 1;
        telemetry.record(HeadlessMetrics.chunks, 1, { backend: options.backend.id });
        request.onProgress?.(done, chunks.length);
      }
      if (signal.aborted) return err(AbortedError({ cause: signal.reason, details: { done, total: chunks.length } }));
      telemetry.record(HeadlessMetrics.render, now() - started, { backend: options.backend.id, chunks: chunks.length });
      return ok({ width, height, data: out });
    },
  };
}
