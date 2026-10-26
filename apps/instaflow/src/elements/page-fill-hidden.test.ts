// @vitest-environment node
// B12: the page fill stack (A-1, IF-37.7–37.8) and hidden elements (A-2, IF-37.9) in the render projection.
import { createRenderProjector, createSceneStore } from '@staticflux/document/render-projection';
import { describe, expect, it } from 'vitest';
import { appearanceEditOps, pageAppearanceModel } from './inspector.js';
import { P } from './components.js';
import { createElementRenderSource, ElementProjection, PAGE_FILL_DEFAULT, pageBox, pageFillId, pageFills } from './projection.js';
import { createElementSceneEncoder, createSceneResources } from './scene.js';
import { authoringBuilt, createFixture, loadGeometry, shape, unwrap } from './testing/fixtures.js';
import { createElementIndex, hitTest, hitTestBrute, marqueeSelect, rectFrom } from '../tools/hit-test.js';

const fill = { [P.w]: 10, [P.h]: 10, [P.fills]: [{ paint: '#f00' }] };

describe.skipIf(!authoringBuilt)('page fill and hidden elements in the projection', () => {
  it('draws the page fill stack first (default white, none when empty), only when asked', async () => {
    const g = await loadGeometry();
    const f = await createFixture([shape('a', fill)]);
    const plain = createElementRenderSource({ stage: f.stage, geometry: g, kit: f.kit, root: 'p1' });
    expect(plain.node(pageFillId('p1'))).toBeUndefined(); // element-only scenes are unchanged
    const source = createElementRenderSource({ stage: f.stage, geometry: g, kit: f.kit, root: 'p1', orderOf: (id) => f.part.node(id)?.order, pageFill: true });
    const projector = createRenderProjector(ElementProjection, source);
    const store = createSceneStore(ElementProjection);
    const resources = createSceneResources();
    store.apply(projector.snapshot());
    resources.apply(source.takeResources() as Uint8Array);
    const record = source.node(pageFillId('p1'));
    expect(record?.parent).toBeNull();
    expect(record?.props['render.w']).toBe(1000);
    expect(record?.props['render.h']).toBe(800);
    const look = resources.look(record?.props['render.look'] as number);
    expect(look?.fills).toEqual([{ paint: { kind: 'solid', color: [255, 255, 255, 255] }, opacity: 1, blend: 'normal' }]);
    expect(look?.strokes).toEqual([]);
    // first in paint order: its order key sorts before every element's
    expect((record?.order ?? 'x') < (source.node('a')?.order ?? '')).toBe(true);
    const encoder = createElementSceneEncoder();
    expect(encoder.encode(store, resources, { full: true })).toBeDefined();

    // A gradient over a colour; strokes on the page are never drawn.
    f.seed([
      { op: 'set', node: 'p1', path: P.fills, value: [{ paint: '#000' }, { paint: { kind: 'linear', stops: [{ offset: 0, color: '@primary' }, { offset: 1, color: '#fff' }] }, opacity: 0.5 }] },
      { op: 'set', node: 'p1', path: P.strokes, value: [{ paint: '#000', width: 4 }] },
    ]);
    const change = source.changes();
    expect(change?.updated.has(pageFillId('p1'))).toBe(true);
    resources.apply(source.takeResources() as Uint8Array);
    const next = resources.look(source.node(pageFillId('p1'))?.props['render.look'] as number);
    expect(next?.fills.map((x) => x.paint.kind)).toEqual(['solid', 'linear']);
    expect(next?.strokes).toEqual([]);
    expect(source.issues(pageFillId('p1'))).toEqual([]);

    f.seed([{ op: 'set', node: 'p1', path: P.fills, value: [] }]);
    expect(source.changes()?.deleted).toEqual([pageFillId('p1')]);
    source.dispose();
    plain.dispose();
  });

  it('reads page fills and size for the Page section; edits go through the appearance edits', async () => {
    const f = await createFixture();
    expect(pageFills(f.stage, 'p1')).toBe(PAGE_FILL_DEFAULT);
    expect(pageBox(f.stage, 'p1')).toEqual({ width: 1000, height: 800 });
    const model = pageAppearanceModel(f.stage, 'p1', f.kit);
    expect(model?.fills).toEqual([{ paint: '#ffffff' }]);
    const ops = appearanceEditOps(model!, { op: 'add', stack: 'fills', item: { paint: '#ff5c39', opacity: 0.6 } });
    expect(ops.ok && ops.value).toEqual([{ op: 'set', node: 'p1', path: P.fills, value: [{ paint: '#ffffff' }, { paint: '#ff5c39', opacity: 0.6 }] }]);
    f.seed(ops.ok ? ops.value : []);
    expect(pageFills(f.stage, 'p1')).toHaveLength(2);
    expect(pageAppearanceModel(f.stage, 'nope')).toBeUndefined();
  });

  it('hit tests and marquees skip hidden elements; a page fill is never hit', async () => {
    const g = await loadGeometry();
    const f = await createFixture([shape('a', fill), shape('gr', {}, 'p1', 'group'), shape('b', { ...fill, [P.x]: 50 }, 'gr'), { op: 'set', node: 'p1', path: P.fills, value: [{ paint: '#0f0' }] }]);
    const ctx = { stage: f.stage, geometry: g, kit: f.kit };
    const index = createElementIndex(ctx, 'p1');
    expect(unwrap(hitTest(ctx, index, 5, 5))?.target).toBe('a');
    expect(unwrap(hitTest(ctx, index, 500, 500))).toBeUndefined(); // the page's fill is not an element
    f.seed([{ op: 'set', node: 'a', path: P.hidden, value: true }]);
    expect(unwrap(hitTest(ctx, index, 5, 5))).toBeUndefined();
    expect(unwrap(hitTest(ctx, index, 55, 5))?.target).toBe('gr');
    f.seed([{ op: 'set', node: 'gr', path: P.hidden, value: true }]);
    expect(unwrap(hitTest(ctx, index, 55, 5))).toBeUndefined();
    expect(unwrap(hitTestBrute(ctx, 'p1', 55, 5))).toBeUndefined();
    expect(unwrap(marqueeSelect(ctx, index, rectFrom(0, 0, 100, 100)))).toEqual([]);
    index.dispose();
  });

  it('leaves hidden elements and everything inside them out; showing them draws them again', async () => {
    const g = await loadGeometry();
    const f = await createFixture([shape('a', fill), shape('gr', {}, 'p1', 'group'), shape('b', fill, 'gr'), shape('c', fill, 'gr')]);
    const source = createElementRenderSource({ stage: f.stage, geometry: g, kit: f.kit, root: 'p1' });
    const projector = createRenderProjector(ElementProjection, source);
    projector.snapshot();
    f.seed([{ op: 'set', node: 'a', path: P.hidden, value: true }]);
    expect(source.changes()?.deleted).toEqual(['a']);
    f.seed([{ op: 'set', node: 'gr', path: P.hidden, value: true }]);
    expect([...(source.changes()?.deleted ?? [])].sort()).toEqual(['b', 'c', 'gr']);
    expect(source.node('b')).toBeUndefined();
    f.seed([
      { op: 'set', node: 'gr', path: P.hidden, value: null },
      { op: 'set', node: 'a', path: P.hidden, value: null },
    ]);
    expect([...(source.changes()?.created ?? [])].sort()).toEqual(['a', 'b', 'c', 'gr']);
    source.dispose();
  });
});
