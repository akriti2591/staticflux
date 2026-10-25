/**
 * Reference `RasterBackend` on the CPU (R11.43): axis-aligned colored boxes, rasterized by pixel
 * centre (no anti-aliasing), composited with nearest sampling. It is the fake behind the tiled
 * renderer, headless and device-lifecycle tests, and the second implementation the
 * `RasterBackend` contract suite runs against (the Vello backend is the first). Real pixels, so
 * tiled-vs-region parity and stitching are checked exactly in Node.
 *
 * Device loss is simulated: `lose()` settles the device's `lost` promise and wipes every texture
 * (tiles, layers, snapshot) while the scene (the "retained CPU-side IR") survives; `attach()`
 * creates the next device.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { GpuAdapterFacts } from '@staticflux/platform';
import { RasterBackendError } from './raster-errors.js';
import type { GpuDeviceHandle, GpuLossInfo } from './gpu-device.js';
import {
  type CompositeFrame,
  intersects,
  type LayerRaster,
  type RasterBackend,
  type RasterBackendStats,
  type RasterImage,
  type RasterRegion,
  type TileKey,
  unionRect,
  type WorldRect,
} from './raster-backend.js';
import { DEFAULT_TILE_SIZE, levelScale, tileWorldRect } from './raster-tiling.js';

/** One box: straight RGBA8 color. */
export interface MemoryBox {
  readonly id: number;
  readonly rect: WorldRect;
  readonly color: readonly [number, number, number, number];
}

/** Scene change for the memory backend: boxes to add or replace (z order = first insertion), ids to remove. */
export interface MemoryRasterDelta {
  readonly set?: readonly MemoryBox[];
  readonly remove?: readonly number[];
}

export interface MemoryRasterBackendOptions {
  readonly id?: string;
  readonly tileSize?: number;
  /** Max region side (stands in for `maxTextureDimension2D`). Default 2048. */
  readonly maxRegionSize?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface MemoryRasterBackend extends RasterBackend<MemoryRasterDelta> {
  /** Every port call, in order (method names; `renderTile` with its key). For call-order assertions. */
  readonly log: readonly string[];
  /** Devices created so far. */
  readonly devices: number;
  /** Simulate a GPU device loss (textures gone, scene kept). */
  lose(reason?: string, message?: string): void;
  /** Make the next `attach` fail (`GpuDeviceProvider` failure path). */
  failNextAttach(): void;
  /** Make the next `renderTile` fail. */
  failNextTile(): void;
  readonly warmed: boolean;
  /** The last composited frame (also returned by `readFrame`). */
  readonly frame: RasterImage;
}

interface Texture {
  readonly image: RasterImage;
}

const FACTS: GpuAdapterFacts = {
  status: 'available',
  info: { vendor: 'staticflux', architecture: 'memory', device: '', description: 'StaticFlux reference CPU raster backend' },
  isFallbackAdapter: true,
  features: [],
  limits: {},
};

function blank(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Source-over of a straight RGBA8 color onto a straight RGBA8 pixel. */
function blend(data: Uint8Array, i: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const sa = a / 255;
  const da = data[i + 3]! / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  data[i] = Math.round((r * sa + data[i]! * da * (1 - sa)) / oa);
  data[i + 1] = Math.round((g * sa + data[i + 1]! * da * (1 - sa)) / oa);
  data[i + 2] = Math.round((b * sa + data[i + 2]! * da * (1 - sa)) / oa);
  data[i + 3] = Math.round(oa * 255);
}

function fill(image: RasterImage, color: readonly [number, number, number, number]): void {
  const px = color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  for (let i = 0; i < image.data.length; i += 4) image.data.set(px, i);
}

export function createMemoryRasterBackend(options: MemoryRasterBackendOptions = {}): MemoryRasterBackend {
  const id = options.id ?? 'memory';
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  const maxRegionSize = options.maxRegionSize ?? 2048;
  const boxes = new Map<number, MemoryBox>();
  const lifted = new Map<number, Set<number>>();
  const tiles = new Map<number, Texture>();
  const layerTextures = new Map<number, LayerRaster & Texture>();
  const log: string[] = [];
  let width = options.width ?? 256;
  let height = options.height ?? 256;
  let frame = blank(width, height);
  let snapshot: RasterImage | undefined;
  let devices = 0;
  let attached = false;
  let disposed = false;
  let warmed = false;
  let failAttach = false;
  let failTile = false;
  let resolveLost: ((loss: GpuLossInfo) => void) | undefined;

  const notReady = (method: string): Result<never> =>
    err(RasterBackendError({ message: disposed ? `${method}: the backend was disposed.` : `${method}: no device (attach first).`, details: { backend: id, method } }));

  const liftedIds = (): Set<number> => {
    const all = new Set<number>();
    for (const members of lifted.values()) for (const node of members) all.add(node);
    return all;
  };

  /** Rasterize `ids` (z order) into an image mapping world `origin` at `scale` px per unit. */
  const raster = (image: RasterImage, originX: number, originY: number, scale: number, include: (box: MemoryBox) => boolean): void => {
    for (const box of boxes.values()) {
      if (!include(box)) continue;
      const [r, g, b, a] = box.color;
      // Pixel (i, j) is covered when its centre lies inside the box: x0 ≤ (i + ½)/s + o < x1.
      const i0 = Math.max(0, Math.ceil((box.rect.x0 - originX) * scale - 0.5));
      const i1 = Math.min(image.width, Math.ceil((box.rect.x1 - originX) * scale - 0.5));
      const j0 = Math.max(0, Math.ceil((box.rect.y0 - originY) * scale - 0.5));
      const j1 = Math.min(image.height, Math.ceil((box.rect.y1 - originY) * scale - 0.5));
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) blend(image.data, (j * image.width + i) * 4, r, g, b, a);
    }
  };

  const sourceOf = (frameSource: CompositeFrame['quads'][number]['source']): RasterImage | undefined => {
    switch (frameSource.kind) {
      case 'tile':
        return tiles.get(frameSource.slot)?.image;
      case 'layer':
        return layerTextures.get(frameSource.layer)?.image;
      case 'snapshot':
        return snapshot;
      case 'external':
        return undefined;
    }
  };

  const backend: MemoryRasterBackend = {
    id,
    tileSize,
    maxRegionSize,
    get log() {
      return log;
    },
    get devices() {
      return devices;
    },
    get warmed() {
      return warmed;
    },
    get frame() {
      return frame;
    },
    async attach({ signal }) {
      log.push('attach');
      if (disposed) return notReady('attach');
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      if (failAttach) {
        failAttach = false;
        return err(RasterBackendError({ message: 'attach failed (injected).', details: { backend: id } }));
      }
      devices += 1;
      attached = true;
      // A new device has no textures: tiles, layers and the snapshot are gone.
      tiles.clear();
      layerTextures.clear();
      snapshot = undefined;
      const lost = new Promise<GpuLossInfo>((resolve) => {
        resolveLost = resolve;
      });
      const handle: GpuDeviceHandle = {
        facts: { adapter: { ...FACTS, limits: { maxTextureDimension2D: maxRegionSize } }, features: [], limits: { maxTextureDimension2D: maxRegionSize } },
        lost,
        device: { kind: 'memory', generation: devices },
        destroy: () => {
          if (!attached) return;
          attached = false;
          resolveLost?.({ reason: 'destroyed', message: 'Device was destroyed.' });
        },
      };
      return ok(handle);
    },
    async warmUp({ signal }) {
      log.push('warmUp');
      if (!attached) return notReady('warmUp');
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      warmed = true;
      return ok(undefined);
    },
    apply(delta) {
      log.push('apply');
      if (disposed) return notReady('apply');
      const rects: WorldRect[] = [];
      for (const removed of delta.remove ?? []) {
        const box = boxes.get(removed);
        if (box === undefined) continue;
        rects.push(box.rect);
        boxes.delete(removed);
      }
      for (const box of delta.set ?? []) {
        const old = boxes.get(box.id);
        if (old !== undefined) rects.push(old.rect);
        boxes.set(box.id, box);
        rects.push(box.rect);
      }
      return ok(rects);
    },
    bounds() {
      let out: WorldRect | undefined;
      for (const box of boxes.values()) out = out === undefined ? box.rect : unionRect(out, box.rect);
      return out;
    },
    resize(w, h) {
      log.push('resize');
      if (disposed) return notReady('resize');
      width = Math.max(1, Math.floor(w));
      height = Math.max(1, Math.floor(h));
      frame = blank(width, height);
      return ok(undefined);
    },
    renderTile(slot, key: TileKey, background) {
      log.push(`renderTile ${key.level}:${key.tx}:${key.ty}`);
      if (!attached) return notReady('renderTile');
      if (failTile) {
        failTile = false;
        return err(RasterBackendError({ message: 'renderTile failed (injected).', details: { backend: id, slot } }));
      }
      const world = tileWorldRect(key, tileSize);
      const image = blank(tileSize, tileSize);
      fill(image, background);
      const skip = liftedIds();
      raster(image, world.x0, world.y0, levelScale(key.level), (box) => !skip.has(box.id) && intersects(box.rect, world));
      tiles.set(slot, { image });
      return ok({ bytes: tileSize * tileSize * 4 });
    },
    releaseTile(slot) {
      log.push('releaseTile');
      tiles.delete(slot);
    },
    setLayer(layer, nodes) {
      log.push('setLayer');
      if (disposed) return notReady('setLayer');
      const before = lifted.get(layer) ?? new Set<number>();
      const after = new Set(nodes);
      const rects: WorldRect[] = [];
      for (const node of new Set([...before, ...after])) {
        if (before.has(node) === after.has(node)) continue;
        const box = boxes.get(node);
        if (box !== undefined) rects.push(box.rect);
      }
      lifted.set(layer, after);
      return ok(rects);
    },
    renderLayer(layer, zoom) {
      log.push('renderLayer');
      if (!attached) return notReady('renderLayer');
      const members = lifted.get(layer);
      if (members === undefined) return err(RasterBackendError({ message: `Unknown layer ${layer}.`, details: { backend: id, layer } }));
      let bounds: WorldRect | undefined;
      for (const node of members) {
        const box = boxes.get(node);
        if (box !== undefined) bounds = bounds === undefined ? box.rect : unionRect(bounds, box.rect);
      }
      const b = bounds ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
      const x = Math.floor(b.x0 * zoom) - 1;
      const y = Math.floor(b.y0 * zoom) - 1;
      const w = Math.max(1, Math.ceil(b.x1 * zoom) + 1 - x);
      const h = Math.max(1, Math.ceil(b.y1 * zoom) + 1 - y);
      const image = blank(w, h);
      raster(image, x / zoom, y / zoom, zoom, (box) => members.has(box.id));
      const result = { layer, zoom, x, y, width: w, height: h, bytes: w * h * 4, image };
      layerTextures.set(layer, result);
      const { image: _image, ...placement } = result;
      return ok(placement);
    },
    releaseLayer(layer) {
      log.push('releaseLayer');
      lifted.delete(layer);
      layerTextures.delete(layer);
    },
    uploadSnapshot(image) {
      log.push('uploadSnapshot');
      if (!attached) return notReady('uploadSnapshot');
      snapshot = { width: image.width, height: image.height, data: image.data.slice() };
      return ok(undefined);
    },
    composite(input) {
      log.push('composite');
      if (!attached) return notReady('composite');
      const out = blank(width, height);
      fill(out, input.clear);
      for (const quad of input.quads) {
        const src = sourceOf(quad.source);
        if (src === undefined) {
          return err(RasterBackendError({ message: `composite: unknown ${quad.source.kind} source.`, details: { backend: id, source: { ...quad.source } } }));
        }
        const [dx0, dy0, dx1, dy1] = quad.dst;
        const [u0, v0, u1, v1] = quad.uv ?? [0, 0, 1, 1];
        const alpha = quad.opacity ?? 1;
        const i0 = Math.max(0, Math.ceil(dx0 - 0.5));
        const i1 = Math.min(width, Math.ceil(dx1 - 0.5));
        const j0 = Math.max(0, Math.ceil(dy0 - 0.5));
        const j1 = Math.min(height, Math.ceil(dy1 - 0.5));
        for (let j = j0; j < j1; j++) {
          const v = v0 + ((j + 0.5 - dy0) / (dy1 - dy0)) * (v1 - v0);
          const sy = Math.min(src.height - 1, Math.max(0, Math.floor(v * src.height)));
          for (let i = i0; i < i1; i++) {
            const u = u0 + ((i + 0.5 - dx0) / (dx1 - dx0)) * (u1 - u0);
            const sx = Math.min(src.width - 1, Math.max(0, Math.floor(u * src.width)));
            const s = (sy * src.width + sx) * 4;
            blend(out.data, (j * width + i) * 4, src.data[s]!, src.data[s + 1]!, src.data[s + 2]!, src.data[s + 3]! * alpha);
          }
        }
      }
      frame = out;
      return ok(undefined);
    },
    async readFrame({ signal }) {
      log.push('readFrame');
      if (!attached) return notReady('readFrame');
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      return ok({ width: frame.width, height: frame.height, data: frame.data.slice() });
    },
    async renderRegion(region: RasterRegion, { signal }) {
      log.push('renderRegion');
      if (!attached) return notReady('renderRegion');
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      if (region.width > maxRegionSize || region.height > maxRegionSize) {
        return err(RasterBackendError({ message: `renderRegion: ${region.width}×${region.height} exceeds ${maxRegionSize}.`, details: { backend: id } }));
      }
      const image = blank(region.width, region.height);
      if (region.background !== undefined) fill(image, region.background);
      const scale = region.width / (region.world.x1 - region.world.x0);
      raster(image, region.world.x0, region.world.y0, scale, (box) => intersects(box.rect, region.world));
      return ok(image);
    },
    stats(): RasterBackendStats {
      let layerBytes = 0;
      for (const layer of layerTextures.values()) layerBytes += layer.bytes;
      return { tiles: tiles.size, tileBytes: tiles.size * tileSize * tileSize * 4, layerBytes, otherBytes: width * height * 4 + (snapshot?.data.length ?? 0) };
    },
    dispose() {
      if (disposed) return;
      log.push('dispose');
      disposed = true;
      attached = false;
      tiles.clear();
      layerTextures.clear();
      boxes.clear();
      lifted.clear();
      snapshot = undefined;
    },
    lose(reason = 'unknown', message = 'Device lost (injected).') {
      if (!attached) return;
      attached = false;
      tiles.clear();
      layerTextures.clear();
      snapshot = undefined;
      resolveLost?.({ reason, message });
    },
    failNextAttach() {
      failAttach = true;
    },
    failNextTile() {
      failTile = true;
    },
  };
  return backend;
}
