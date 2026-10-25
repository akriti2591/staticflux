import { describe, expect, it } from 'vitest';
import type { NodeRecord, PartOp, TransactionMeta } from './crdt-v2.js';
import { createLoroEngine } from './loro-crdt.js';
import { bindSpatialIndex, type Box, createSpatialIndex, inkBox, isValidBox } from './spatial-index.js';

const meta: TransactionMeta = { actor: { kind: 'user', id: 'u' }, label: 'test' };
const box = (minX: number, minY: number, maxX: number, maxY: number): Box => ({ minX, minY, maxX, maxY });
const rect = (id: string, x: number, y: number, w = 10, h = 10, stroke = 0): PartOp => ({
  op: 'create',
  node: id,
  kind: 'shape',
  parent: null,
  props: { 'spatial.x': x, 'spatial.y': y, 'spatial.w': w, 'spatial.h': h, 'style.stroke.width': stroke },
});
const boundsOf = (node: NodeRecord): Box | undefined => {
  if (node.kind !== 'shape') return undefined;
  const x = node.props['spatial.x'] as number;
  const y = node.props['spatial.y'] as number;
  const outset = ((node.props['style.stroke.width'] as number | undefined) ?? 0) / 2;
  return inkBox(box(x, y, x + (node.props['spatial.w'] as number), y + (node.props['spatial.h'] as number)), outset);
};

describe('inkBox / isValidBox', () => {
  it('grows every side by a number and each side by an object, clamping negative outsets', () => {
    expect(inkBox(box(0, 0, 10, 10), 2)).toEqual(box(-2, -2, 12, 12));
    expect(inkBox(box(0, 0, 10, 10), { left: 1, top: 2, right: 3, bottom: -4 })).toEqual(box(-1, -2, 13, 10));
    expect(inkBox(box(0, 0, 10, 10))).toEqual(box(0, 0, 10, 10));
  });
  it('rejects NaN, infinite and inverted boxes', () => {
    expect(isValidBox(box(0, 0, 1, 1))).toBe(true);
    expect(isValidBox(box(0, 0, 0, 0))).toBe(true);
    expect(isValidBox(box(Number.NaN, 0, 1, 1))).toBe(false);
    expect(isValidBox(box(0, 0, Infinity, 1))).toBe(false);
    expect(isValidBox(box(2, 0, 1, 1))).toBe(false);
  });
});

describe('createSpatialIndex', () => {
  it('sets, moves, deletes and searches keyed boxes', () => {
    const index = createSpatialIndex<string>();
    index.set('a', box(0, 0, 10, 10));
    index.set('b', box(20, 20, 30, 30));
    expect(index.size).toBe(2);
    expect(index.search(box(5, 5, 25, 25)).sort()).toEqual(['a', 'b']);
    index.set('a', box(100, 100, 110, 110)); // move
    expect(index.size).toBe(2);
    expect(index.search(box(0, 0, 15, 15))).toEqual([]);
    expect(index.get('a')).toEqual(box(100, 100, 110, 110));
    expect(index.has('a')).toBe(true);
    expect(index.delete('a')).toBe(true);
    expect(index.delete('a')).toBe(false);
    expect(index.get('a')).toBeUndefined();
    index.set('c', box(Number.NaN, 0, 1, 1)); // invalid → not indexed
    expect(index.has('c')).toBe(false);
  });
  it('hit tests points half-open on the max side, with tolerance', () => {
    const index = createSpatialIndex<number>();
    index.set(1, box(0, 0, 10, 10));
    index.set(2, box(5, 5, 15, 15));
    expect(index.hit(0, 0)).toEqual([1]);
    expect(index.hit(10, 10)).toEqual([2]);
    expect(index.hit(7, 7).sort()).toEqual([1, 2]);
    expect(index.hit(15, 15)).toEqual([]);
    expect(index.hit(15.5, 15.5, 1)).toEqual([2]);
  });
  it('bulk loads (replacing contents) and clears', () => {
    const index = createSpatialIndex<number>({ maxEntries: 4 });
    index.set(999, box(0, 0, 1, 1));
    const entries: [number, Box][] = Array.from({ length: 200 }, (_, i) => [i, box(i * 10, 0, i * 10 + 5, 5)]);
    index.load([...entries, [500, box(1, 1, 0, 0)]]);
    expect(index.size).toBe(200);
    expect(index.has(999)).toBe(false);
    expect(index.search(box(100, 0, 125, 5)).sort((a, b) => a - b)).toEqual([10, 11, 12]);
    index.clear();
    expect(index.size).toBe(0);
    expect(index.search(box(-1e9, -1e9, 1e9, 1e9))).toEqual([]);
  });
});

describe('bindSpatialIndex', () => {
  it('rebuilds from the part and follows creates, moves, updates and deletes', () => {
    const part = createLoroEngine().create({ peer: '1' });
    expect(part.transact(meta, [rect('a', 0, 0), rect('b', 50, 50), { op: 'create', node: 'g', kind: 'group', parent: null }]).ok).toBe(true);
    const spatial = bindSpatialIndex({ part, bounds: boundsOf, paths: ['spatial.', 'style.'] });
    spatial.rebuild();
    expect(spatial.index.size).toBe(2); // the group has no bounds
    expect(spatial.index.hit(5, 5)).toEqual(['a']);

    const moved = part.transact(meta, [{ op: 'set', node: 'a', path: 'spatial.x', value: 200 }, rect('c', 300, 300)]);
    if (!moved.ok) throw moved.error;
    spatial.apply(moved.value.change);
    expect(spatial.index.hit(5, 5)).toEqual([]);
    expect(spatial.index.hit(205, 5)).toEqual(['a']);
    expect(spatial.index.hit(305, 305)).toEqual(['c']);

    const stroked = part.transact(meta, [{ op: 'set', node: 'b', path: 'style.stroke.width', value: 8 }]);
    if (!stroked.ok) throw stroked.error;
    spatial.apply(stroked.value.change);
    expect(spatial.index.hit(47, 47)).toEqual(['b']); // ink bounds: 4 px outset

    const before = spatial.stats.reindexed;
    const named = part.transact(meta, [{ op: 'set', node: 'b', path: 'name', value: 'B' }]);
    if (!named.ok) throw named.error;
    spatial.apply(named.value.change);
    expect(spatial.stats.reindexed).toBe(before); // path outside `paths`

    const deleted = part.transact(meta, [{ op: 'delete', node: 'c' }]);
    if (!deleted.ok) throw deleted.error;
    spatial.apply(deleted.value.change);
    expect(spatial.index.has('c')).toBe(false);
    expect(spatial.stats).toMatchObject({ removed: 1, rebuilds: 1 });
    part.dispose();
  });
  it('follows remote imports through the part change feed', () => {
    const engine = createLoroEngine();
    const local = engine.create({ peer: '1' });
    const remote = engine.create({ peer: '2' });
    const spatial = bindSpatialIndex({ part: local, bounds: boundsOf });
    const stop = spatial.follow();
    const created = remote.transact(meta, [rect('r', 10, 10)]);
    if (!created.ok) throw created.error;
    expect(local.import(remote.exportUpdates()).ok).toBe(true);
    expect(spatial.index.hit(15, 15)).toEqual(['r']);
    stop();
    expect(remote.transact(meta, [{ op: 'set', node: 'r', path: 'spatial.x', value: 500 }]).ok).toBe(true);
    expect(local.import(remote.exportUpdates()).ok).toBe(true);
    expect(spatial.index.hit(15, 15)).toEqual(['r']); // no longer following
    local.dispose();
    remote.dispose();
  });
});
