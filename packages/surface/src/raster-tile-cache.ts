/**
 * GPU tile cache (SF-Δ29, IF-15.7): tile key → backend texture slot, least recently used first,
 * with its bytes registered in the thread's memory ledger (`@staticflux/runtime` memory budgets,
 * kind `gpu`). Over budget or under memory pressure the ledger calls back and the cache drops
 * LRU tiles, never the ones pinned by the frame being drawn. Slots are small integers reused
 * after release so the backend can keep a dense texture table.
 */
import { ok, type Result } from '@staticflux/core';
import type { CachePriority, EvictionReason, MemoryBudgetManager, MemoryCacheHandle } from '@staticflux/runtime';
import { intersects, type TileKey, type WorldRect } from './raster-backend.js';
import { DEFAULT_TILE_SIZE, levelScale, tileId, tileWorldRect } from './raster-tiling.js';

/** Anti-aliasing reaches up to this many device pixels past geometry: invalidation is padded by it. */
export const AA_PAD_PX = 2;

export interface TileEntry {
  readonly key: TileKey;
  readonly slot: number;
  readonly bytes: number;
  lastUsed: number;
  /** Content changed since it was rendered: still drawable (no holes), re-rendered off the frame. */
  stale: boolean;
}

export interface TileCacheOptions {
  /** Release a slot's texture (the backend's `releaseTile`). */
  readonly release: (slot: number) => void;
  readonly tileSize?: number;
  /** Hard cap on tiles regardless of bytes (default unlimited; S1 used 256). */
  readonly maxTiles?: number;
  /** Ledger to register with (kind `gpu`). Without one the cache only honours `maxTiles`. */
  readonly memory?: Pick<MemoryBudgetManager, 'register'>;
  /** Ledger id (default `surface/tiles`). */
  readonly id?: string;
  readonly priority?: CachePriority;
}

export interface TileCache {
  readonly size: number;
  readonly bytes: number;
  /** The ledger handle, when registered. */
  readonly memory: MemoryCacheHandle | undefined;
  /** Any cached entry, fresh or stale. */
  get(key: TileKey): TileEntry | undefined;
  /** A fresh (not stale) entry exists. */
  has(key: TileKey): boolean;
  /** Mark used in frame `frame` (LRU clock). */
  touch(key: TileKey, frame: number): void;
  /** Reserve a slot for a tile about to be rendered (evicts first when at `maxTiles`). */
  reserve(key: TileKey): number;
  /** Record a rendered tile (`bytes` from the backend) and report to the ledger. */
  commit(key: TileKey, slot: number, bytes: number, frame: number): void;
  /** Give back a reserved slot whose render failed. */
  abandon(slot: number): void;
  /** Mark every tile intersecting any rect stale (kept until re-rendered). Returns the number marked. */
  invalidate(rects: readonly WorldRect[]): number;
  /** Drop LRU tiles until `bytes` are freed (pinned tiles stay). Returns bytes freed. */
  evict(bytes: number, reason?: EvictionReason): number;
  /** Tiles that must survive eviction while the current frame is built. */
  pin(keys: readonly TileKey[]): void;
  /** Every cached entry (any order). */
  entries(): readonly TileEntry[];
  /** Forget everything without releasing slots (the device was lost: textures are gone). */
  forget(): void;
  /** Release every slot. */
  clear(): void;
  dispose(): void;
}

export function createTileCache(options: TileCacheOptions): Result<TileCache> {
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  const maxTiles = options.maxTiles ?? Number.POSITIVE_INFINITY;
  const tiles = new Map<string, TileEntry>();
  const free: number[] = [];
  const reserved = new Set<number>();
  let nextSlot = 0;
  let bytes = 0;
  let pinned = new Set<string>();
  let handle: MemoryCacheHandle | undefined;

  const report = (): void => handle?.report(bytes);

  const drop = (id: string, entry: TileEntry, release: boolean): void => {
    tiles.delete(id);
    bytes -= entry.bytes;
    if (release) options.release(entry.slot);
    free.push(entry.slot);
  };

  const evictLru = (want: number): number => {
    if (want <= 0) return 0;
    const victims = [...tiles.entries()].filter(([id]) => !pinned.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let freed = 0;
    for (const [id, entry] of victims) {
      if (freed >= want) break;
      drop(id, entry, true);
      freed += entry.bytes;
    }
    return freed;
  };

  const cache: TileCache = {
    get size() {
      return tiles.size;
    },
    get bytes() {
      return bytes;
    },
    get memory() {
      return handle;
    },
    get: (key) => tiles.get(tileId(key)),
    has: (key) => tiles.get(tileId(key))?.stale === false,
    touch(key, frame) {
      const entry = tiles.get(tileId(key));
      if (entry !== undefined) entry.lastUsed = frame;
    },
    reserve(key) {
      const existing = tiles.get(tileId(key));
      if (existing !== undefined) return existing.slot; // re-render (stale) into the same slot
      while (tiles.size + reserved.size >= maxTiles && tiles.size > 0) {
        const before = tiles.size;
        evictLru(1);
        if (tiles.size === before) break; // everything pinned
      }
      const slot = free.pop() ?? nextSlot++;
      reserved.add(slot);
      return slot;
    },
    commit(key, slot, tileBytes, frame) {
      reserved.delete(slot);
      const id = tileId(key);
      const old = tiles.get(id);
      if (old !== undefined && old.slot !== slot) drop(id, old, true);
      else if (old !== undefined) {
        tiles.delete(id);
        bytes -= old.bytes;
      }
      tiles.set(id, { key, slot, bytes: tileBytes, lastUsed: frame, stale: false });
      bytes += tileBytes;
      report();
    },
    abandon(slot) {
      // A stale entry keeps its slot (its old pixels are still drawable).
      if (reserved.delete(slot)) {
        options.release(slot);
        free.push(slot);
      }
    },
    invalidate(rects) {
      if (rects.length === 0) return 0;
      let marked = 0;
      for (const entry of tiles.values()) {
        if (entry.stale) continue;
        const t = tileWorldRect(entry.key, tileSize);
        const pad = AA_PAD_PX / levelScale(entry.key.level);
        const world = { x0: t.x0 - pad, y0: t.y0 - pad, x1: t.x1 + pad, y1: t.y1 + pad };
        if (rects.some((r) => intersects(world, r))) {
          entry.stale = true;
          marked += 1;
        }
      }
      return marked;
    },
    evict(want) {
      const freed = evictLru(want);
      if (freed > 0) report();
      return freed;
    },
    pin(keys) {
      pinned = new Set(keys.map(tileId));
    },
    entries: () => [...tiles.values()],
    forget() {
      tiles.clear();
      free.length = 0;
      reserved.clear();
      nextSlot = 0;
      bytes = 0;
      report();
    },
    clear() {
      for (const [id, entry] of [...tiles]) drop(id, entry, true);
      report();
    },
    dispose() {
      cache.clear();
      handle?.dispose();
      handle = undefined;
    },
  };

  if (options.memory !== undefined) {
    const registered = options.memory.register({
      id: options.id ?? 'surface/tiles',
      kind: 'gpu',
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      // The ledger calls back synchronously; report() inside is ignored while it enforces.
      evict: (want) => evictLru(want),
    });
    if (!registered.ok) return registered;
    handle = registered.value;
  }
  return ok(cache);
}
