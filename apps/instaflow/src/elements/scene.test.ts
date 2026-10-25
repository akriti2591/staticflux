// @vitest-environment node
import { createRenderProjector, createSceneStore } from '@staticflux/document/render-projection';
import type { NodeRecord } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { createResourceTable, ElementProjection, type Look } from './projection.js';
import { createElementSceneEncoder, createSceneResources, gridOverlayBatch, lumaToAlpha, sceneIdOf } from './scene.js';

/** A hand-made projection source (no stage): records with numeric render props. */
function source(records: NodeRecord[]) {
  const byId = new Map(records.map((r) => [r.id, r]));
  return { node: (id: string) => byId.get(id), forEachNode: (visit: (r: NodeRecord) => boolean | void) => records.forEach((r) => visit(r)) };
}

const record = (id: string, parent: string | null, order: string, props: Record<string, number>, kind = 'shape'): NodeRecord => ({
  id,
  kind,
  parent,
  order,
  props: { 'render.a': 1, 'render.d': 1, 'render.flags': 1, 'render.opacity': 1, 'render.w': 10, 'render.h': 10, ...props },
  texts: [],
  lists: [],
});

const look = (over: Partial<Look> = {}): Look => ({ geometry: { kind: 'rect', radii: [0, 0, 0, 0], smooth: false }, fills: [{ paint: { kind: 'solid', color: [255, 0, 0, 255] }, opacity: 1, blend: 'normal' }], strokes: [], effects: [], ...over });

describe('element scene encoder', () => {
  it('encodes upserts in sibling order (parents first), only changes after that, and removes', () => {
    const table = createResourceTable();
    const plain = table.intern({ kind: 'look', value: look() });
    const rounded = table.intern({ kind: 'look', value: look({ geometry: { kind: 'frame', radii: [4, 0, 4, 0], clip: true, smooth: false }, effects: [{ kind: 'background-blur', radius: 3 }] }) });
    const records = [record('f', null, 'a', { 'render.look': rounded }, 'frame'), record('x', 'f', 'b', { 'render.look': plain }), record('y', 'f', 'a', { 'render.look': plain, 'render.mask': 0x80 | 2 })];
    const projector = createRenderProjector(ElementProjection, source(records));
    const store = createSceneStore(ElementProjection);
    const resources = createSceneResources();
    resources.apply(table.take() as Uint8Array);
    store.apply(projector.snapshot());
    const encoder = createElementSceneEncoder();
    const first = encoder.encode(store, resources, { full: true }) as Uint8Array;
    expect(new DataView(first.buffer).getUint32(8, true)).toBe(4); // clear + 3 upserts
    expect(encoder.encode(store, resources)).toBeUndefined();
    const slot = projector.slotOf('x') as number;
    expect(sceneIdOf(slot)).toBe(slot * 2 + 2);
    const deleted = projector.project({ origin: 'local', created: [], deleted: ['x'], moved: [], updated: new Map() });
    store.apply(deleted as Uint8Array);
    const removal = encoder.encode(store, resources) as Uint8Array;
    expect(removal[12]).toBe(3); // REMOVE
    encoder.reset();
    expect(new DataView((encoder.encode(store, resources) as Uint8Array).buffer).getUint32(8, true)).toBe(2);
  });

  it('draws a group until its look arrives, then re-encodes when it does', () => {
    const projector = createRenderProjector(ElementProjection, source([record('a', null, 'a', { 'render.look': 7 })]));
    const store = createSceneStore(ElementProjection);
    store.apply(projector.snapshot());
    const resources = createSceneResources();
    const encoder = createElementSceneEncoder();
    expect(encoder.encode(store, resources)).toBeDefined();
    expect(encoder.encode(store, resources)).toBeUndefined();
    resources.apply(new TextEncoder().encode(JSON.stringify({ format: 'instaflow.scene-resources/1', define: [[7, 'look', look()]], drop: [] })));
    expect(encoder.encode(store, resources)).toBeDefined();
  });

  it('luminance to alpha and the non-printing layout-grid overlay', () => {
    expect([...lumaToAlpha(Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 128]))]).toEqual([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128]);
    const batch = gridOverlayBatch({ x: [0, 10, 20, 50], y: [5], columns: [[10, 20]], rows: [] }, { minX: 0, minY: 0, maxX: 50, maxY: 40 }, { firstId: 100 });
    // clear + 1 column + 2 free vertical lines (0, 50) + 1 horizontal line
    expect(new DataView(batch.buffer).getUint32(8, true)).toBe(5);
  });
});
