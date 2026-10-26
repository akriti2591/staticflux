/**
 * Tiled renderer (IF-7.4, IF-15.2, R11.45): the frame policy over a `RasterBackend`, with the S1
 * lessons built in.
 *
 * - **Tiles per √2 zoom level**, centre first, cached in a `TileCache` whose bytes live in the
 *   memory ledger (LRU, pressure-evicted).
 * - **Tile preparation off the frame.** A frame only rasterizes tiles that would otherwise be a hole
 *   (no stale copy, no other level, no snapshot under them), and only while it is inside
 *   `inFrameBudgetMs` (a tile is started only if the budget is not used up). Everything else goes to
 *   the prep lane (idle slices), which asks for a new frame when tiles land.
 * - **Scaled previous level while tiles are missing:** cached tiles of other levels are drawn
 *   under the current level (farthest level first), so zooming never shows holes.
 * - **Stale-while-revalidate:** an edit marks tiles stale; they stay on screen until re-rendered. With
 *   `inFrameStaleTiles`, a frame re-renders up to that many stale visible tiles before it composites, so an edit
 *   spanning many tiles is never presented half old, half new.
 * - **Lifted layers:** `lift(nodes)` moves nodes into a layer texture rendered once per zoom;
 *   `drag` only moves its quad (no raster, S1: 0.85 ms p95). `drop` gives the nodes back to the
 *   tiles and keeps drawing the layer until the tiles under it are fresh (no flash, E-2).
 * - **Warm-up and a cached first frame:** until `warmUp` finished, frames never rasterize (the
 *   first Vello render compiles pipelines, S1: ≈ 1 s); a snapshot (`showSnapshot`) is drawn instead.
 *   Metrics `render/first-frame` (first frame with content) and `render/first-sharp-frame`.
 */
import { createNoopTelemetry, err, metric, ok, type Result, type SfError, type Telemetry } from '@staticflux/core';
import type { CachePriority, MemoryBudgetManager } from '@staticflux/runtime';
import { RasterBackendError } from './raster-errors.js';
import {
  type CompositeQuad,
  cameraWorldRect,
  intersects,
  type LayerRaster,
  type RasterBackend,
  type RasterCamera,
  type RasterImage,
  type TileKey,
  unionRect,
  type WorldRect,
} from './raster-backend.js';
import type { TilePrepLane } from './raster-lane.js';
import { createTileCache, type TileCache } from './raster-tile-cache.js';
import { levelForZoom, tileWorldRect, visibleTiles, worldToDevice } from './raster-tiling.js';

export const RenderMetrics = {
  firstFrame: /* @__PURE__ */ metric.mark('render/first-frame', { unit: 'ms', description: 'Renderer created → first frame with content (snapshot or tiles).' }),
  firstSharpFrame: /* @__PURE__ */ metric.mark('render/first-sharp-frame', { unit: 'ms', description: 'Renderer created → first frame with every visible tile fresh (S1 cold frame).' }),
  timeToSharp: /* @__PURE__ */ metric.histogram('render/time-to-sharp', { unit: 'ms', description: 'Zoom-level change → every visible tile fresh (IF-15.2: ≤ 250 ms).' }),
  tilesRendered: /* @__PURE__ */ metric.counter('render/tiles-rendered', { description: 'Tiles rasterized (attrs: lane = frame | prep).' }),
  inFrameRaster: /* @__PURE__ */ metric.histogram('render/in-frame-raster', { unit: 'ms', description: 'Tile raster time spent inside a frame (bounded by the in-frame budget).' }),
  warmUp: /* @__PURE__ */ metric.histogram('render/warm-up', { unit: 'ms', description: 'Pipeline warm-up duration.' }),
} as const;

const SUBSYSTEM = 'surface/raster';

export type RendererPhase = 'cold' | 'warming' | 'ready';

/** A cached frame and the world rect it shows (stored by the app, e.g. next to the document). */
export interface RasterSnapshot {
  readonly image: RasterImage;
  readonly world: WorldRect;
}

export interface LiftedLayer {
  readonly id: number;
  readonly nodes: readonly number[];
}

export interface FrameReport {
  readonly frame: number;
  readonly phase: RendererPhase;
  readonly level: number;
  readonly visible: number;
  /** Visible tiles not fresh after this frame (missing or stale). */
  readonly unsharp: number;
  /** Visible tiles with nothing of their own to draw (no stale copy). */
  readonly missing: number;
  readonly renderedInFrame: number;
  readonly fallbackQuads: number;
  readonly layers: number;
  readonly snapshot: boolean;
  /** Every visible tile fresh and nothing borrowed from another level. */
  readonly sharp: boolean;
  /** Tile preparation queued for idle time. */
  readonly prepScheduled: boolean;
}

export interface TiledRendererOptions<Delta> {
  readonly id?: string;
  readonly backend: RasterBackend<Delta>;
  readonly lane: TilePrepLane;
  /** Ask for a frame (e.g. `requestAnimationFrame` in the render worker). */
  readonly requestFrame: () => void;
  /** Cache memory ledger (`@staticflux/runtime` memory budgets). */
  readonly memory?: Pick<MemoryBudgetManager, 'register'>;
  readonly cachePriority?: CachePriority;
  readonly maxTiles?: number;
  /** Tile raster allowed inside one frame (default 2 ms; a tile starts only while the budget is left). */
  readonly inFrameBudgetMs?: number;
  /**
   * Stale visible tiles re-rendered inside a frame, before it composites (default 0: stale tiles wait for the prep
   * lane). An edit that spans many tiles (a drag of a repeat) otherwise presents a mix of fresh and stale tiles, and
   * tiles late in the centre-first order show the old scene until the edits stop. Counted in tiles, not ms: a tile's
   * CPU time says little about its GPU cost.
   */
  readonly inFrameStaleTiles?: number;
  /** Interest ring prepared around the viewport (default 1). */
  readonly ring?: number;
  /** Straight RGBA background, 0…1 (default white). */
  readonly background?: readonly [number, number, number, number];
  readonly camera?: RasterCamera;
  readonly now?: () => number;
  readonly telemetry?: Telemetry;
}

export interface TiledRenderer<Delta> {
  readonly phase: RendererPhase;
  readonly camera: RasterCamera;
  readonly cache: TileCache;
  setCamera(camera: RasterCamera): void;
  /** Resize the canvas (and the camera viewport) in device pixels. */
  resize(width: number, height: number): Result<void>;
  /** Apply a scene change; tiles under the changed rects go stale. */
  apply(delta: Delta): Result<readonly WorldRect[]>;
  /** Compile pipelines off the frame; frames rasterize only after this. */
  warmUp(signal: AbortSignal): Promise<Result<void>>;
  /** Draw a cached frame until the GPU path is sharp. */
  showSnapshot(snapshot: RasterSnapshot): Result<void>;
  /** Read back the current frame as a snapshot for the next boot. */
  captureSnapshot(signal: AbortSignal): Promise<Result<RasterSnapshot>>;
  lift(nodes: readonly number[]): Result<LiftedLayer>;
  /** Move a lifted layer by a world offset (no raster). */
  drag(layer: number, dx: number, dy: number): void;
  drop(layer: number): Result<void>;
  /** Build and composite one frame. */
  frame(): Result<FrameReport>;
  /** The device was re-created: every texture is gone; re-render from the retained scene. */
  deviceRestored(): void;
  dispose(): void;
}

interface LayerState {
  readonly id: number;
  readonly nodes: readonly number[];
  dx: number;
  dy: number;
  raster: LayerRaster | undefined;
  dirty: boolean;
  /** Set by `drop`: the world rect whose tiles must be fresh before the layer texture is released. */
  dropping: WorldRect | undefined;
  /** World bounds of the nodes, from the backend's invalidation rects. */
  bounds: WorldRect | undefined;
}

const DEFAULT_CAMERA: RasterCamera = { x: 0, y: 0, zoom: 1, width: 1, height: 1 };

export function createTiledRenderer<Delta>(options: TiledRendererOptions<Delta>): Result<TiledRenderer<Delta>> {
  const { backend, lane } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? (() => performance.now());
  const id = options.id ?? backend.id;
  const budgetMs = Math.max(0, options.inFrameBudgetMs ?? 2);
  const staleInFrame = Math.max(0, Math.floor(options.inFrameStaleTiles ?? 0));
  const ring = Math.max(0, options.ring ?? 1);
  const background = options.background ?? [1, 1, 1, 1];
  const tileSize = backend.tileSize;
  const createdAt = now();
  const life = new AbortController();

  const cacheResult = createTileCache({
    release: (slot) => backend.releaseTile(slot),
    tileSize,
    id: `${id}/tiles`,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.maxTiles === undefined ? {} : { maxTiles: options.maxTiles }),
    ...(options.cachePriority === undefined ? {} : { priority: options.cachePriority }),
  });
  if (!cacheResult.ok) return cacheResult;
  const cache = cacheResult.value;

  let camera: RasterCamera = options.camera ?? DEFAULT_CAMERA;
  let phase: RendererPhase = 'cold';
  let frameNo = 0;
  let snapshot: RasterSnapshot | undefined;
  let snapshotUploaded = false;
  let firstFrameReported = false;
  let firstSharpReported = false;
  let levelChangedAt: number | undefined;
  let prepScheduled = false;
  let nextLayer = 1;
  let disposed = false;
  const layers = new Map<number, LayerState>();

  const disposedError = (): SfError => RasterBackendError({ message: 'The tiled renderer was disposed.', details: { renderer: id } });
  const currentLevel = (): number => levelForZoom(camera.zoom);
  const visible = (extraRing = 0): TileKey[] => visibleTiles(camera, currentLevel(), { tileSize, ring: extraRing, bounds: backend.bounds() });

  const renderOne = (key: TileKey, laneName: 'frame' | 'prep'): boolean => {
    const slot = cache.reserve(key);
    const result = backend.renderTile(slot, key, background);
    if (!result.ok) {
      cache.abandon(slot);
      telemetry.event('render.tile-failed', { subsystem: SUBSYSTEM, level: 'critical', attrs: { renderer: id, level: key.level, tx: key.tx, ty: key.ty, code: result.error.code } });
      return false;
    }
    cache.commit(key, slot, result.value.bytes, frameNo);
    telemetry.record(RenderMetrics.tilesRendered, 1, { renderer: id, lane: laneName });
    return true;
  };

  /** Tiles prep should render next: visible unsharp first, then the interest ring. */
  const prepQueue = (): TileKey[] => {
    const inView = visible().filter((k) => !cache.has(k));
    if (ring === 0) return inView;
    const seen = new Set(inView.map((k) => `${k.tx}:${k.ty}`));
    const around = visible(ring).filter((k) => !cache.has(k) && !seen.has(`${k.tx}:${k.ty}`));
    return [...inView, ...around];
  };

  const schedulePrep = (): void => {
    if (prepScheduled || disposed || phase !== 'ready') return;
    prepScheduled = true;
    lane.schedule((budget) => {
      if (disposed || phase !== 'ready') {
        prepScheduled = false;
        return false;
      }
      cache.pin(visible());
      let rendered = 0;
      let queue = prepQueue();
      while (queue.length > 0) {
        const key = queue.shift()!;
        if (renderOne(key, 'prep')) rendered += 1;
        if (budget.shouldYield()) break;
      }
      if (rendered > 0) options.requestFrame();
      queue = prepQueue();
      if (queue.length === 0) prepScheduled = false;
      return queue.length > 0;
    }, life.signal);
  };

  const layerQuad = (layer: LayerState): CompositeQuad | undefined => {
    const raster = layer.raster;
    if (raster === undefined) return undefined;
    const scale = camera.zoom / raster.zoom;
    const x0 = (raster.x / raster.zoom - camera.x + layer.dx) * camera.zoom;
    const y0 = (raster.y / raster.zoom - camera.y + layer.dy) * camera.zoom;
    return { source: { kind: 'layer', layer: layer.id }, dst: [x0, y0, x0 + raster.width * scale, y0 + raster.height * scale] };
  };

  const renderer: TiledRenderer<Delta> = {
    get phase() {
      return phase;
    },
    get camera() {
      return camera;
    },
    cache,
    setCamera(next) {
      if (levelForZoom(next.zoom) !== levelForZoom(camera.zoom)) levelChangedAt = now();
      camera = next;
    },
    resize(width, height) {
      if (disposed) return err(disposedError());
      const result = backend.resize(width, height);
      if (result.ok) camera = { ...camera, width, height };
      return result;
    },
    apply(delta) {
      if (disposed) return err(disposedError());
      const result = backend.apply(delta);
      if (!result.ok) return result;
      cache.invalidate(result.value);
      // A change may touch lifted nodes: re-raster layers whose bounds it hits.
      for (const layer of layers.values()) {
        if (layer.bounds === undefined || result.value.some((r) => intersects(r, layer.bounds!))) layer.dirty = true;
      }
      return result;
    },
    async warmUp(signal) {
      if (disposed) return err(disposedError());
      if (phase === 'ready') return ok(undefined);
      phase = 'warming';
      const started = now();
      const result = await backend.warmUp({ signal });
      if (disposed) return err(disposedError());
      if (!result.ok) {
        phase = 'cold';
        return result;
      }
      telemetry.record(RenderMetrics.warmUp, now() - started, { renderer: id });
      phase = 'ready';
      options.requestFrame();
      return ok(undefined);
    },
    showSnapshot(next) {
      if (disposed) return err(disposedError());
      const uploaded = backend.uploadSnapshot(next.image);
      if (!uploaded.ok) return uploaded;
      snapshot = next;
      snapshotUploaded = true;
      options.requestFrame();
      return ok(undefined);
    },
    async captureSnapshot(signal) {
      if (disposed) return err(disposedError());
      const world = cameraWorldRect(camera);
      const image = await backend.readFrame({ signal });
      return image.ok ? ok({ image: image.value, world }) : image;
    },
    lift(nodes) {
      if (disposed) return err(disposedError());
      const layerId = nextLayer++;
      const rects = backend.setLayer(layerId, nodes);
      if (!rects.ok) return rects;
      cache.invalidate(rects.value);
      const bounds = rects.value.length === 0 ? undefined : rects.value.reduce(unionRect);
      layers.set(layerId, { id: layerId, nodes: [...nodes], dx: 0, dy: 0, raster: undefined, dirty: true, dropping: undefined, bounds });
      options.requestFrame();
      return ok({ id: layerId, nodes: [...nodes] });
    },
    drag(layerId, dx, dy) {
      const layer = layers.get(layerId);
      if (layer === undefined || layer.dropping !== undefined) return;
      layer.dx = dx;
      layer.dy = dy;
    },
    drop(layerId) {
      if (disposed) return err(disposedError());
      const layer = layers.get(layerId);
      if (layer === undefined) return err(RasterBackendError({ message: `Unknown lifted layer ${layerId}.`, details: { layer: layerId } }));
      // Nodes go back to the tiles (their committed positions come through `apply`); keep drawing
      // the layer texture until the tiles under it are fresh.
      const rects = backend.setLayer(layerId, []);
      if (!rects.ok) return rects;
      cache.invalidate(rects.value);
      const moved = layer.bounds === undefined ? undefined : { x0: layer.bounds.x0 + layer.dx, y0: layer.bounds.y0 + layer.dy, x1: layer.bounds.x1 + layer.dx, y1: layer.bounds.y1 + layer.dy };
      const all = [...rects.value, ...(moved === undefined ? [] : [moved])];
      if (moved !== undefined) cache.invalidate([moved]);
      layer.dropping = all.length === 0 ? { x0: 0, y0: 0, x1: 0, y1: 0 } : all.reduce(unionRect);
      options.requestFrame();
      return ok(undefined);
    },
    frame() {
      if (disposed) return err(disposedError());
      frameNo += 1;
      const start = now();
      const level = currentLevel();
      const quads: CompositeQuad[] = [];
      const world = cameraWorldRect(camera);
      let renderedInFrame = 0;
      let fallbackQuads = 0;
      let missing = 0;
      let unsharp = 0;
      let visibleCount = 0;

      if (phase === 'ready') {
        const keys = visible();
        visibleCount = keys.length;
        cache.pin(keys);
        // Holes first: visible tiles with no copy of their own and no other level under them.
        const others = cache.entries().filter((e) => e.key.level !== level && intersects(tileWorldRect(e.key, tileSize), world));
        const covered = (key: TileKey): boolean => {
          const rect = tileWorldRect(key, tileSize);
          return others.some((e) => intersects(tileWorldRect(e.key, tileSize), rect)) || (snapshot !== undefined && intersects(snapshot.world, rect));
        };
        const holes = keys.filter((k) => cache.get(k) === undefined && !covered(k));
        for (const key of holes) {
          if (now() - start >= budgetMs) break;
          if (renderOne(key, 'frame')) renderedInFrame += 1;
        }
        // Then stale visible tiles, so one frame shows one version of the scene (up to `inFrameStaleTiles`).
        if (staleInFrame > 0) {
          const stale = keys.filter((k) => cache.get(k) !== undefined && !cache.has(k)).slice(0, staleInFrame);
          for (const key of stale) if (renderOne(key, 'frame')) renderedInFrame += 1;
        }
        const rasterMs = now() - start;
        if (renderedInFrame > 0) telemetry.record(RenderMetrics.inFrameRaster, rasterMs, { renderer: id });

        const absent = keys.filter((k) => cache.get(k) === undefined);
        missing = absent.length;
        unsharp = keys.filter((k) => !cache.has(k)).length;
        // Snapshot under everything while tiles are missing.
        if (snapshot !== undefined && snapshotUploaded && missing > 0) {
          quads.push({ source: { kind: 'snapshot' }, dst: worldToDevice(camera, snapshot.world) });
        }
        // Other levels under the current one, farthest first, only where the current level is absent.
        if (missing > 0) {
          const absentRects = absent.map((k) => tileWorldRect(k, tileSize));
          const fallback = others
            .filter((e) => absentRects.some((r) => intersects(tileWorldRect(e.key, tileSize), r)))
            .sort((a, b) => Math.abs(b.key.level - level) - Math.abs(a.key.level - level) || a.key.level - b.key.level);
          for (const entry of fallback) {
            cache.touch(entry.key, frameNo);
            quads.push({ source: { kind: 'tile', slot: entry.slot }, dst: worldToDevice(camera, tileWorldRect(entry.key, tileSize)) });
          }
          fallbackQuads = fallback.length;
        }
        for (const key of keys) {
          const entry = cache.get(key);
          if (entry === undefined) continue;
          cache.touch(key, frameNo);
          quads.push({ source: { kind: 'tile', slot: entry.slot }, dst: worldToDevice(camera, tileWorldRect(key, tileSize)) });
        }
        // Lifted layers on top: rendered once per zoom, moved by their quad.
        for (const layer of [...layers.values()]) {
          if (layer.dropping !== undefined) {
            const under = keys.filter((k) => intersects(tileWorldRect(k, tileSize), layer.dropping!));
            if (under.every((k) => cache.has(k))) {
              layers.delete(layer.id);
              releaseLayer(layer.id);
              continue;
            }
          } else if (layer.dirty || layer.raster === undefined || layer.raster.zoom !== camera.zoom) {
            const raster = backend.renderLayer(layer.id, camera.zoom);
            if (raster.ok) {
              layer.raster = raster.value;
              layer.dirty = false;
            }
          }
          const quad = layerQuad(layer);
          if (quad !== undefined) quads.push(quad);
        }
      } else if (snapshot !== undefined && snapshotUploaded) {
        quads.push({ source: { kind: 'snapshot' }, dst: worldToDevice(camera, snapshot.world) });
      }

      const composited = backend.composite({ clear: background, quads });
      if (!composited.ok) return composited;

      const hasContent = quads.length > 0;
      if (!firstFrameReported && hasContent) {
        firstFrameReported = true;
        telemetry.record(RenderMetrics.firstFrame, now() - createdAt, { renderer: id, source: phase === 'ready' ? 'tiles' : 'snapshot' });
      }
      const sharp = phase === 'ready' && unsharp === 0 && fallbackQuads === 0;
      if (sharp) {
        if (!firstSharpReported) {
          firstSharpReported = true;
          telemetry.record(RenderMetrics.firstSharpFrame, now() - createdAt, { renderer: id });
        }
        if (levelChangedAt !== undefined) {
          telemetry.record(RenderMetrics.timeToSharp, now() - levelChangedAt, { renderer: id, level });
          levelChangedAt = undefined;
        }
        if (snapshot !== undefined) {
          snapshot = undefined; // the GPU path is sharp: the cached frame is no longer needed
          snapshotUploaded = false;
        }
      }
      if (phase === 'ready' && (unsharp > 0 || prepQueue().length > 0)) schedulePrep();
      return ok({
        frame: frameNo,
        phase,
        level,
        visible: visibleCount,
        unsharp,
        missing,
        renderedInFrame,
        fallbackQuads,
        layers: layers.size,
        snapshot: quads.some((q) => q.source.kind === 'snapshot'),
        sharp,
        prepScheduled,
      });
    },
    deviceRestored() {
      if (disposed) return;
      cache.forget();
      for (const layer of layers.values()) {
        layer.raster = undefined;
        layer.dirty = true;
      }
      if (snapshot !== undefined) snapshotUploaded = backend.uploadSnapshot(snapshot.image).ok;
      prepScheduled = false;
      options.requestFrame();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      life.abort();
      for (const layerId of layers.keys()) releaseLayer(layerId);
      layers.clear();
      cache.dispose();
    },
  };

  function releaseLayer(layerId: number): void {
    backend.releaseLayer(layerId);
  }

  return ok(renderer);
}
