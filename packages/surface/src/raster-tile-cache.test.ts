import { box } from '@staticflux/core';
import type { MemoryPressure } from '@staticflux/runtime';
import { createMemoryBudgets } from '@staticflux/runtime/memory';
import { describe, expect, it } from 'vitest';
import { createTileCache, type TileCache } from './raster-tile-cache.js';

const TILE_BYTES = 512 * 512 * 4; // 1 MiB

function make(options: Partial<Parameters<typeof createTileCache>[0]> = {}): { cache: TileCache; released: number[] } {
  const released: number[] = [];
  const result = createTileCache({ release: (slot) => released.push(slot), ...options });
  if (!result.ok) throw result.error;
  return { cache: result.value, released };
}

function put(cache: TileCache, tx: number, frame = 1, level = 0): number {
  const key = { level, tx, ty: 0 };
  const slot = cache.reserve(key);
  cache.commit(key, slot, TILE_BYTES, frame);
  return slot;
}

describe('createTileCache', () => {
  it('reserves dense slots, commits tiles and reuses released slots', () => {
    const { cache, released } = make();
    expect(put(cache, 0)).toBe(0);
    expect(put(cache, 1)).toBe(1);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(2 * TILE_BYTES);
    expect(cache.has({ level: 0, tx: 0, ty: 0 })).toBe(true);
    cache.evict(TILE_BYTES); // LRU: both used in frame 1 → the first inserted wins the tie
    expect(released).toEqual([0]);
    expect(put(cache, 2)).toBe(0);
  });

  it('evicts least recently used tiles first and never pinned ones', () => {
    const { cache, released } = make();
    put(cache, 0, 1);
    put(cache, 1, 2);
    put(cache, 2, 3);
    cache.touch({ level: 0, tx: 0, ty: 0 }, 4);
    cache.pin([{ level: 0, tx: 1, ty: 0 }]);
    expect(cache.evict(2 * TILE_BYTES)).toBe(2 * TILE_BYTES);
    expect(released.sort()).toEqual([0, 2]);
    expect(cache.has({ level: 0, tx: 1, ty: 0 })).toBe(true);
  });

  it('honours maxTiles by evicting before reserving', () => {
    const { cache, released } = make({ maxTiles: 2 });
    put(cache, 0, 1);
    put(cache, 1, 2);
    put(cache, 2, 3);
    expect(cache.size).toBe(2);
    expect(released).toEqual([0]);
  });

  it('invalidation marks tiles stale (still drawable) and re-renders reuse the slot', () => {
    const { cache, released } = make();
    const slot = put(cache, 0);
    put(cache, 3);
    expect(cache.invalidate([{ x0: 10, y0: 10, x1: 20, y1: 20 }])).toBe(1);
    expect(cache.has({ level: 0, tx: 0, ty: 0 })).toBe(false);
    expect(cache.get({ level: 0, tx: 0, ty: 0 })?.stale).toBe(true);
    expect(cache.invalidate([{ x0: 10, y0: 10, x1: 20, y1: 20 }])).toBe(0); // already stale
    expect(cache.reserve({ level: 0, tx: 0, ty: 0 })).toBe(slot);
    cache.commit({ level: 0, tx: 0, ty: 0 }, slot, TILE_BYTES, 2);
    expect(cache.has({ level: 0, tx: 0, ty: 0 })).toBe(true);
    expect(cache.bytes).toBe(2 * TILE_BYTES);
    expect(released).toEqual([]);
    expect(cache.invalidate([])).toBe(0);
  });

  it('abandon() releases a fresh reservation but keeps a stale tile', () => {
    const { cache, released } = make();
    const fresh = cache.reserve({ level: 0, tx: 5, ty: 0 });
    cache.abandon(fresh);
    expect(released).toEqual([fresh]);
    const kept = put(cache, 0);
    cache.invalidate([{ x0: 0, y0: 0, x1: 1, y1: 1 }]);
    cache.abandon(cache.reserve({ level: 0, tx: 0, ty: 0 }));
    expect(released).toEqual([fresh]);
    expect(cache.get({ level: 0, tx: 0, ty: 0 })?.slot).toBe(kept);
  });

  it('forget() drops entries without releasing (device lost); clear() releases them', () => {
    const { cache, released } = make();
    put(cache, 0);
    put(cache, 1);
    cache.forget();
    expect(cache.size).toBe(0);
    expect(released).toEqual([]);
    expect(put(cache, 4)).toBe(0); // slots restart
    cache.clear();
    expect(released).toEqual([0]);
    expect(cache.entries()).toEqual([]);
  });

  it('registers its bytes with the memory ledger and is evicted over budget and under pressure', () => {
    const pressure = box<MemoryPressure>('nominal');
    const memory = createMemoryBudgets({ budgets: { gpu: 4 * TILE_BYTES }, pressure });
    const { cache, released } = make({ memory, id: 'test/tiles' });
    expect(cache.memory?.id).toBe('test/tiles');
    for (let tx = 0; tx < 6; tx++) put(cache, tx, tx);
    expect(cache.size).toBe(4);
    expect(released).toEqual([0, 1]);
    expect(memory.usage('gpu').bytes).toBe(4 * TILE_BYTES);
    cache.pin([{ level: 0, tx: 5, ty: 0 }]);
    pressure.set('critical'); // budget → 1 tile
    expect(cache.size).toBe(1);
    expect(cache.has({ level: 0, tx: 5, ty: 0 })).toBe(true);
    expect(memory.usage('gpu').bytes).toBe(TILE_BYTES);
    cache.dispose();
    expect(memory.usage('gpu').caches).toEqual([]);
  });

  it('fails when the ledger rejects the registration (duplicate id)', () => {
    const memory = createMemoryBudgets();
    expect(createTileCache({ release: () => undefined, memory }).ok).toBe(true);
    const second = createTileCache({ release: () => undefined, memory });
    expect(!second.ok && second.error.code).toBe('SF-MEM-001');
  });
});
