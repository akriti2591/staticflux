import { describe, expect, it } from 'vitest';
import type { DocumentCRDTv2, PartOp, TransactionMeta } from './crdt-v2.js';
import { createLoroEngine } from './loro-crdt.js';
import {
  createRenderProjector,
  createSceneStore,
  defineRenderProjection,
  NO_SLOT,
  PROJECTION_HEADER_BYTES,
  projectValue,
  type SceneStore,
} from './render-projection.js';

const meta: TransactionMeta = { actor: { kind: 'user', id: 'u' }, label: 'test' };
const Scene = defineRenderProjection({
  id: 'test/scene',
  kinds: ['shape', 'text'],
  fields: { x: { path: 'spatial.x' }, y: { path: 'spatial.y' }, w: { path: 'spatial.w', type: 'f32', default: 1 }, op: { path: 'spatial.opacity', type: 'f32', default: 1 } },
});
const shape = (id: string, x: number, y: number, parent: string | null = null): PartOp => ({
  op: 'create',
  node: id,
  kind: 'shape',
  parent,
  props: { 'spatial.x': x, 'spatial.y': y, 'spatial.w': 10 },
});

function commit(part: DocumentCRDTv2, ops: readonly PartOp[]) {
  const result = part.transact(meta, ops);
  if (!result.ok) throw result.error;
  return result.value.change;
}

function apply(store: SceneStore, payload: Uint8Array | undefined) {
  if (payload === undefined) throw new Error('expected a payload');
  const result = store.apply(payload);
  if (!result.ok) throw result.error;
  return result.value;
}

/** Live (id → x, y) pairs a store holds. */
function contents(store: SceneStore<'x' | 'y' | 'w' | 'op'>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  store.forEach((slot) => {
    out[store.idOf(slot) as string] = [store.column('x')[slot] as number, store.column('y')[slot] as number];
  });
  return out;
}

describe('defineRenderProjection', () => {
  it('freezes fields with defaults and hashes the declaration', () => {
    expect(Scene.fields.map((f) => [f.name, f.type, f.default])).toEqual([
      ['x', 'f64', 0],
      ['y', 'f64', 0],
      ['w', 'f32', 1],
      ['op', 'f32', 1],
    ]);
    expect(Scene.fieldIndex).toEqual({ x: 0, y: 1, w: 2, op: 3 });
    const other = defineRenderProjection({ id: 'test/scene', kinds: ['shape', 'text'], fields: { x: { path: 'spatial.x' } } });
    expect(other.hash).not.toBe(Scene.hash);
    expect(Object.isFrozen(Scene)).toBe(true);
  });
  it('throws for no kinds or duplicate kinds', () => {
    expect(() => defineRenderProjection({ id: 'x', kinds: [], fields: {} })).toThrow(/kinds/);
    expect(() => defineRenderProjection({ id: 'x', kinds: ['a', 'a'], fields: {} })).toThrow(/twice/);
  });
});

describe('projectValue', () => {
  it('keeps finite numbers, maps booleans and falls back otherwise', () => {
    expect(projectValue(3.5, 0)).toBe(3.5);
    expect(projectValue(true, 0)).toBe(1);
    expect(projectValue(false, 9)).toBe(0);
    expect(projectValue(Number.NaN, 7)).toBe(7);
    expect(projectValue('12', 7)).toBe(7);
    expect(projectValue(undefined, 2)).toBe(2);
  });
});

describe('createRenderProjector + createSceneStore', () => {
  it('snapshot then deltas rebuild the same scene on the render side', () => {
    const part = createLoroEngine().create({ peer: '1' });
    commit(part, [{ op: 'create', node: 'frame', kind: 'group', parent: null }, shape('a', 1, 2, 'frame'), shape('b', 3, 4)]);
    const projector = createRenderProjector(Scene, part);
    const store = createSceneStore(Scene, { capacity: 16 });
    expect(apply(store, projector.snapshot())).toMatchObject({ kind: 'snapshot', upserts: 2, deletes: 0 });
    expect(projector.size).toBe(2);
    expect(contents(store)).toEqual({ a: [1, 2], b: [3, 4] });
    const a = projector.slotOf('a') as number;
    expect(store.kindOf(a)).toBe('shape');
    expect(store.parentOf(a)).toBe(NO_SLOT); // the group is not projected
    expect(store.orderOf(a)).toBeTypeOf('string');
    expect(store.column('w')[a]).toBe(10);
    expect(store.column('op')[a]).toBe(1); // default
    expect(projector.nodeOf(a)).toBe('a');
    expect(projector.values('a')).toEqual([1, 2, 10, 1]);

    // update + create + delete in one change, with a superseded gesture
    const change = commit(part, [{ op: 'set', node: 'a', path: 'spatial.x', value: 50 }, shape('c', 7, 8), { op: 'delete', node: 'b' }]);
    const report = apply(store, projector.project(change, { supersedes: [42] }));
    expect(report).toMatchObject({ kind: 'delta', deletes: 1, upserts: 2, supersedes: [42] });
    expect(contents(store)).toEqual({ a: [50, 2], c: [7, 8] });
    expect(store.count).toBe(2);

    // A property outside the fields projects nothing; a bare supersede still produces a payload.
    expect(projector.project(commit(part, [{ op: 'set', node: 'a', path: 'name', value: 'A' }]))).toBeUndefined();
    expect(apply(store, projector.project(commit(part, [{ op: 'set', node: 'a', path: 'name', value: 'B' }]), { supersedes: [7] }))).toMatchObject({ upserts: 0, supersedes: [7] });
    part.dispose();
  });

  it('reuses freed slots only after the delete is on the wire, and snapshots keep known slots', () => {
    const part = createLoroEngine().create({ peer: '1' });
    commit(part, [shape('a', 0, 0), shape('b', 0, 0)]);
    const projector = createRenderProjector(Scene, part);
    const store = createSceneStore(Scene);
    apply(store, projector.snapshot());
    const slotB = projector.slotOf('b');
    // delete b and create d in the same change: d must not take b's slot (the store deletes first anyway)
    apply(store, projector.project(commit(part, [{ op: 'delete', node: 'b' }, shape('d', 9, 9)])));
    expect(projector.slotOf('d')).not.toBe(slotB);
    apply(store, projector.project(commit(part, [shape('e', 5, 5)])));
    expect(projector.slotOf('e')).toBe(slotB); // reused later
    expect(contents(store)).toEqual({ a: [0, 0], d: [9, 9], e: [5, 5] });
    const before = projector.slotOf('a');
    const fresh = createSceneStore(Scene);
    apply(fresh, projector.snapshot());
    expect(projector.slotOf('a')).toBe(before);
    expect(contents(fresh)).toEqual(contents(store));
    part.dispose();
  });

  it('carries structure for moves and resolves projected parents', () => {
    const part = createLoroEngine().create({ peer: '1' });
    commit(part, [{ op: 'create', node: 't', kind: 'text', parent: null, props: { 'spatial.x': 1 } }, shape('child', 2, 2)]);
    const projector = createRenderProjector(Scene, part);
    const store = createSceneStore(Scene);
    apply(store, projector.snapshot());
    apply(store, projector.project(commit(part, [{ op: 'move', node: 'child', parent: 't' }])));
    expect(store.parentOf(projector.slotOf('child') as number)).toBe(projector.slotOf('t'));
    expect(store.kindOf(projector.slotOf('t') as number)).toBe('text');
    part.dispose();
  });

  it('honours the include filter: a node filtered out later is deleted on the render side', () => {
    const part = createLoroEngine().create({ peer: '1' });
    commit(part, [shape('a', 0, 0), shape('b', 1, 1)]);
    const projector = createRenderProjector(Scene, part, { include: (node) => node.props['spatial.hidden'] !== true });
    const store = createSceneStore(Scene);
    apply(store, projector.snapshot());
    const hide = commit(part, [{ op: 'set', node: 'b', path: 'spatial.hidden', value: true }, { op: 'set', node: 'b', path: 'spatial.x', value: 3 }]);
    apply(store, projector.project(hide));
    expect(contents(store)).toEqual({ a: [0, 0] });
    expect(projector.slotOf('b')).toBeUndefined();
    part.dispose();
  });

  it('grows columns past the initial capacity and bumps the layout', () => {
    const part = createLoroEngine().create({ peer: '1' });
    commit(part, Array.from({ length: 40 }, (_, i) => shape(`n${i}`, i, -i)));
    const projector = createRenderProjector(Scene, part);
    const store = createSceneStore(Scene, { capacity: 16 });
    const layout = store.layout;
    apply(store, projector.snapshot());
    expect(store.capacity).toBeGreaterThanOrEqual(40);
    expect(store.layout).toBeGreaterThan(layout);
    expect(store.slots).toBe(40);
    expect(store.column('x')[39]).toBe(39);
    store.clear();
    expect(store.count).toBe(0);
    expect(store.alive(0)).toBe(false);
    part.dispose();
  });

  it('decodes payloads that are views into a SharedArrayBuffer at an offset (the shared medium)', () => {
    const part = createLoroEngine().create({ peer: '1' });
    commit(part, [shape('a', 4, 5), shape('b', 6, 7)]);
    const payload = createRenderProjector(Scene, part).snapshot();
    const shared = new Uint8Array(new SharedArrayBuffer(payload.byteLength + 64), 24, payload.byteLength);
    shared.set(payload);
    const store = createSceneStore(Scene);
    apply(store, shared);
    expect(contents(store)).toEqual({ a: [4, 5], b: [6, 7] });
    part.dispose();
  });

  it('rejects payloads of another projection and truncated payloads', () => {
    const part = createLoroEngine().create({ peer: '1' });
    commit(part, [shape('a', 0, 0)]);
    const payload = createRenderProjector(Scene, part).snapshot();
    const other = createSceneStore(defineRenderProjection({ id: 'other', kinds: ['shape'], fields: { x: { path: 'spatial.x' } } }));
    const mismatch = other.apply(payload);
    expect(!mismatch.ok && mismatch.error.code).toBe('SF-DOC-020');
    const store = createSceneStore(Scene);
    const short = store.apply(payload.subarray(0, PROJECTION_HEADER_BYTES - 1));
    expect(!short.ok && short.error.code).toBe('SF-DOC-021');
    const truncated = store.apply(payload.subarray(0, payload.byteLength - 8));
    expect(!truncated.ok && truncated.error.code).toBe('SF-DOC-021');
    const garbage = new Uint8Array(64);
    const notOurs = store.apply(garbage);
    expect(!notOurs.ok && notOurs.error.code).toBe('SF-DOC-020');
    part.dispose();
  });
});

describe('RenderProjectionSource', () => {
  it('a projector reads any per-node source, not only a part (e.g. a composed stage view)', () => {
    const Proj = defineRenderProjection({ id: 'test/source', kinds: ['box'], fields: { x: { path: 'r.x' } } });
    const records = [{ id: 'a', kind: 'box', parent: null, order: 'a', props: { 'r.x': 7 }, texts: [], lists: [] }];
    const source = { node: (id: string) => records.find((r) => r.id === id), forEachNode: (visit: (r: (typeof records)[number]) => boolean | void) => records.forEach((r) => visit(r)) };
    const projector = createRenderProjector(Proj, source);
    const store = createSceneStore(Proj);
    expect(store.apply(projector.snapshot()).ok).toBe(true);
    expect(store.column('x')[projector.slotOf('a') as number]).toBe(7);
  });
});
