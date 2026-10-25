/**
 * The Vello GPU implementation of `RasterBackend` (IF-7.4): adapts the render Wasm (`Engine`,
 * `create_gpu`) to the framework port. Scene batches are the binary scene IR (`scene-ir.ts`).
 *
 * - `attach` creates a fresh device through wgpu (a new adapter every time) and installs it; the
 *   retained scene and images survive, so the device lifecycle (`createGpuDevice`) re-attaches after
 *   a loss with no document reload (IF-7.11). Facts come from the raw `GPUDevice`.
 * - Readbacks are serialized (the engine has one pending copy) and cancellable.
 * - Engine exceptions become `SF-SURF-014` (`RasterBackendError`), device creation failures
 *   `SF-SURF-010`, readback failures `SF-SURF-015`. Nothing throws across the port.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import { describeGpuAdapter } from '@staticflux/platform';
import {
  type CompositeFrame,
  type GpuDeviceHandle,
  type GpuLossInfo,
  GpuUnavailableError,
  type LayerRaster,
  type RasterBackend,
  RasterBackendError,
  type RasterBackendStats,
  type RasterImage,
  RasterReadbackError,
  type RasterRegion,
  readGpuLimits,
  type TileKey,
  type WorldRect,
} from '@staticflux/surface/raster';
import type { RenderEngineWasm, RenderWasm } from './render-module.js';

export interface VelloBackendOptions {
  readonly wasm: RenderWasm;
  /** The transferred `OffscreenCanvas` to present to, or null for a headless (export) backend. */
  readonly canvas?: unknown;
  readonly width?: number;
  readonly height?: number;
  readonly id?: string;
}

const SOURCE_KIND = { tile: 0, layer: 1, snapshot: 2, external: 3 } as const;

interface RawDevice {
  readonly lost?: Promise<{ readonly reason: string; readonly message: string }>;
  readonly features?: Iterable<string>;
  readonly limits?: object;
  readonly adapterInfo?: object;
  destroy?(): void;
}

function rectsOf(flat: Float64Array | readonly number[]): WorldRect[] {
  const out: WorldRect[] = [];
  for (let i = 0; i + 3 < flat.length; i += 4) out.push({ x0: flat[i]!, y0: flat[i + 1]!, x1: flat[i + 2]!, y1: flat[i + 3]! });
  return out;
}

function message(cause: unknown): string {
  return typeof cause === 'string' ? cause : String((cause as Error)?.message ?? cause);
}

export function createVelloRasterBackend(options: VelloBackendOptions): RasterBackend<Uint8Array> {
  const { wasm } = options;
  const id = options.id ?? 'vello';
  const engine: RenderEngineWasm = new wasm.Engine();
  let width = Math.max(1, options.width ?? 1);
  let height = Math.max(1, options.height ?? 1);
  let disposed = false;
  /** Serializes readbacks: the engine holds one pending copy at a time. */
  let readQueue: Promise<unknown> = Promise.resolve();

  const failed = (method: string, cause?: unknown): Result<never> =>
    err(RasterBackendError({ ...(cause === undefined ? {} : { cause }), message: `${id}.${method}: ${cause === undefined ? 'the backend was disposed' : message(cause)}`, details: { backend: id, method } }));

  /** Run an engine call, mapping a throw to SF-SURF-014. */
  const call = <T>(method: string, fn: () => T): Result<T> => {
    if (disposed) return failed(method);
    try {
      return ok(fn());
    } catch (cause) {
      return failed(method, cause);
    }
  };

  const readback = (method: string, begin: () => Promise<unknown>, signal: AbortSignal, w: number, h: number): Promise<Result<RasterImage>> => {
    const run = async (): Promise<Result<RasterImage>> => {
      if (disposed) return failed(method);
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      let started: Promise<unknown>;
      try {
        started = begin();
      } catch (cause) {
        return failed(method, cause);
      }
      try {
        await started; // the map completes even if aborted meanwhile; the copy is then dropped
      } catch (cause) {
        engine.cancel_readback();
        return err(RasterReadbackError({ cause, message: `${id}.${method}: ${message(cause)}`, details: { backend: id } }));
      }
      if (signal.aborted) {
        engine.cancel_readback();
        return err(AbortedError({ cause: signal.reason }));
      }
      try {
        const data = engine.finish_readback();
        return ok({ width: w, height: h, data });
      } catch (cause) {
        return err(RasterReadbackError({ cause, message: `${id}.${method}: ${message(cause)}`, details: { backend: id } }));
      }
    };
    const next = readQueue.then(run, run);
    readQueue = next.catch(() => undefined);
    return next;
  };

  const backend: RasterBackend<Uint8Array> = {
    id,
    tileSize: engine.tile_size(),
    get maxRegionSize() {
      return disposed ? 0 : engine.max_target();
    },
    async attach({ signal }) {
      if (disposed) return failed('attach');
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      if (engine.has_gpu()) engine.drop_gpu();
      let gpu;
      try {
        gpu = await wasm.create_gpu(options.canvas ?? null, width, height);
      } catch (cause) {
        return err(GpuUnavailableError({ cause, message: `${id}: creating the GPU device failed: ${message(cause)}`, details: { backend: id } }));
      }
      if (disposed || signal.aborted) {
        gpu.free();
        return disposed ? failed('attach') : err(AbortedError({ cause: signal.reason }));
      }
      const installed = call('attach', () => engine.install_gpu(gpu));
      if (!installed.ok) return installed;
      const raw = (engine.raw_device() ?? {}) as RawDevice;
      const adapter = await describeGpuAdapter({ info: raw.adapterInfo, features: raw.features, limits: raw.limits } as Parameters<typeof describeGpuAdapter>[0]);
      const handle: GpuDeviceHandle = {
        facts: { adapter, features: [...(raw.features ?? [])].sort(), limits: readGpuLimits(raw.limits) },
        lost: (raw.lost ?? new Promise<never>(() => undefined)).then((info): GpuLossInfo => ({ reason: info.reason, message: info.message })),
        device: raw,
        destroy: () => {
          if (!disposed) engine.drop_gpu();
        },
      };
      return ok(handle);
    },
    async warmUp({ signal }) {
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      const started = call('warmUp', () => engine.warm_up());
      if (!started.ok) return started;
      try {
        await started.value;
      } catch (cause) {
        return failed('warmUp', cause);
      }
      return signal.aborted ? err(AbortedError({ cause: signal.reason })) : ok(undefined);
    },
    apply(delta) {
      const result = call('apply', () => engine.apply(delta));
      return result.ok ? ok(rectsOf(result.value)) : result;
    },
    bounds() {
      if (disposed) return undefined;
      const b = engine.bounds();
      return b.length === 4 ? { x0: b[0]!, y0: b[1]!, x1: b[2]!, y1: b[3]! } : undefined;
    },
    resize(w, h) {
      const result = call('resize', () => engine.resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))));
      if (result.ok) {
        width = Math.max(1, Math.round(w));
        height = Math.max(1, Math.round(h));
      }
      return result;
    },
    renderTile(slot, key: TileKey, background) {
      const result = call('renderTile', () => engine.render_tile(slot, key.level, key.tx, key.ty, Float32Array.from(background)));
      return result.ok ? ok({ bytes: result.value }) : result;
    },
    releaseTile(slot) {
      if (!disposed) engine.release_tile(slot);
    },
    setLayer(layer, nodes) {
      const result = call('setLayer', () => engine.set_layer(layer, Uint32Array.from(nodes)));
      return result.ok ? ok(rectsOf(result.value)) : result;
    },
    renderLayer(layer, zoom) {
      const result = call('renderLayer', () => engine.render_layer(layer, zoom));
      if (!result.ok) return result;
      const [x, y, w, h, bytes] = result.value;
      const raster: LayerRaster = { layer, zoom, x: x!, y: y!, width: w!, height: h!, bytes: bytes! };
      return ok(raster);
    },
    releaseLayer(layer) {
      if (!disposed) engine.release_layer(layer);
    },
    uploadSnapshot(image) {
      return call('uploadSnapshot', () => engine.upload_snapshot(image.width, image.height, image.data));
    },
    composite(frame: CompositeFrame) {
      const quads = new Float32Array(frame.quads.length * 9);
      const sources = new Uint32Array(frame.quads.length);
      frame.quads.forEach((quad, i) => {
        const [u0, v0, u1, v1] = quad.uv ?? [0, 0, 1, 1];
        quads.set([...quad.dst, u0, v0, u1, v1, quad.opacity ?? 1], i * 9);
        const s = quad.source;
        const ref = s.kind === 'tile' ? s.slot : s.kind === 'layer' ? s.layer : s.kind === 'external' ? s.id : 0;
        sources[i] = ((SOURCE_KIND[s.kind] << 24) | (ref & 0x00ff_ffff)) >>> 0;
      });
      return call('composite', () => engine.composite(Float32Array.from(frame.clear), quads, sources, frame.present !== false));
    },
    readFrame({ signal }) {
      return readback('readFrame', () => engine.begin_read_frame(), signal, width, height);
    },
    renderRegion(region: RasterRegion, { signal }) {
      const { world } = region;
      const bg = Float32Array.from(region.background ?? [0, 0, 0, 0]);
      return readback('renderRegion', () => engine.begin_region(world.x0, world.y0, world.x1, world.y1, region.width, region.height, bg), signal, region.width, region.height);
    },
    stats(): RasterBackendStats {
      if (disposed) return { tiles: 0, tileBytes: 0, layerBytes: 0, otherBytes: 0 };
      const [tiles, tileBytes, layerBytes, otherBytes] = engine.stats();
      return { tiles: tiles!, tileBytes: tileBytes!, layerBytes: layerBytes!, otherBytes: otherBytes! };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        engine.drop_gpu();
      } finally {
        engine.free();
      }
    },
  };
  return backend;
}

/** wgpu errors no scope caught since the last call (validation, out of memory). */
export function takeRenderErrors(wasm: RenderWasm): readonly string[] {
  return wasm.take_errors();
}
