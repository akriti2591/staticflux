// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P } from './components.js';
import { boxCenter, containerBounds, containerGrids, containerOf, elementBounds, gridLines, hitElement, intersectBox, isElement, localOutline, maskOf, pageTransform, siblingBounds, unionBox } from './layout.js';
import { resolveElement } from './resolve.js';
import { authoringBuilt, createFixture, loadGeometry, shape, unwrap } from './testing/fixtures.js';

describe('box helpers and layout grids (no Wasm)', () => {
  it('unions, intersects and centres boxes', () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const b = { minX: 5, minY: 5, maxX: 20, maxY: 8 };
    expect(unionBox(undefined, a)).toBe(a);
    expect(unionBox(a, b)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 10 });
    expect(intersectBox(a, b)).toEqual({ minX: 5, minY: 5, maxX: 10, maxY: 8 });
    expect(intersectBox(a, { minX: 50, minY: 50, maxX: 60, maxY: 60 })).toEqual({ minX: 50, minY: 50, maxX: 50, maxY: 50 });
    expect(boxCenter(a)).toEqual([5, 5]);
    expect(isElement('frame') && isElement('text') && !isElement('page') && !isElement(undefined)).toBe(true);
  });

  it('columns (stretch and fixed), rows, a baseline grid and hidden grids', () => {
    const box = { minX: 0, minY: 0, maxX: 1000, maxY: 400 };
    const cols = gridLines(box, [{ kind: 'columns', count: 4, gutter: 20, margin: 40, align: 'stretch' }]);
    expect(cols.columns).toEqual([
      [40, 255],
      [275, 490],
      [510, 725],
      [745, 960],
    ]);
    expect(cols.x).toContain(40);
    const centered = gridLines(box, [{ kind: 'columns', count: 2, gutter: 10, margin: 0, align: 'center', size: 100 }]);
    expect(centered.columns).toEqual([
      [395, 495],
      [505, 605],
    ]);
    const end = gridLines(box, [{ kind: 'rows', count: 1, gutter: 0, margin: 10, align: 'end', size: 50 }]);
    expect(end.rows).toEqual([[340, 390]]);
    const base = gridLines({ minX: 0, minY: 0, maxX: 16, maxY: 8 }, [{ kind: 'grid', size: 8 }]);
    expect(base.x).toEqual([0, 8, 16]);
    expect(base.y).toEqual([0, 8]);
    expect(gridLines(box, [{ kind: 'grid', size: 8, visible: false }]).x).toEqual([]);
    expect(gridLines(box, [{ kind: 'columns', count: 50, gutter: 30, margin: 0, align: 'stretch' }]).columns).toEqual([]);
  });
});

describe.skipIf(!authoringBuilt)('page-space geometry queries', () => {
  it('bounds of rotated, nested, stroked, shadowed and masked elements', async () => {
    const g = await loadGeometry();
    const f = await createFixture([
      shape('fr', { [P.x]: 100, [P.y]: 100, [P.w]: 400, [P.h]: 300, [P.grids]: [{ kind: 'columns', count: 2, gutter: 0, margin: 0, align: 'stretch' }] }, 'p1', 'frame'),
      shape('a', { [P.x]: 10, [P.y]: 10, [P.w]: 100, [P.h]: 50, [P.rotation]: 90 }, 'fr'),
      shape('b', { [P.x]: 200, [P.y]: 0, [P.w]: 20, [P.h]: 20, [P.strokes]: [{ paint: '#000', width: 4 }], [P.effects]: [{ kind: 'drop-shadow', x: 0, y: 8, blur: 4, color: '#0008' }] }, 'fr'),
      shape('g', { [P.x]: 0, [P.y]: 0 }, 'p1', 'group'),
      shape('m', { [P.x]: 0, [P.y]: 0, [P.w]: 50, [P.h]: 50, [P.shape]: 'ellipse', [P.maskMode]: 'clip' }, 'g'),
      shape('c', { [P.x]: 0, [P.y]: 0, [P.w]: 100, [P.h]: 100, [P.fills]: [{ paint: '#f00' }] }, 'g'),
    ]);
    const ctx = f.ctx(g);
    const a = unwrap(elementBounds(ctx, 'a'));
    expect(a.geometry.minX).toBeCloseTo(135, 9);
    expect(a.geometry.maxX).toBeCloseTo(185, 9);
    expect(a.geometry.minY).toBeCloseTo(85, 9);
    expect(a.geometry.maxY).toBeCloseTo(185, 9);
    expect(a.center[0]).toBeCloseTo(160, 9);
    const b = unwrap(elementBounds(ctx, 'b'));
    // stroke reaches 2 px; the shadow grows that by 3σ = 6 and moves 8 down
    expect(b.ink).toEqual({ minX: 292, minY: 98, maxX: 328, maxY: 136 });
    expect(pageTransform(ctx, "b").map((v) => v + 0)).toEqual([1, 0, 0, 1, 300, 100]);
    expect(unwrap(containerOf(ctx, 'a')).center).toEqual([300, 250]);
    expect(unwrap(containerBounds(ctx, 'p1')).bounds).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 800 });
    expect(containerBounds(ctx, 'a').ok).toBe(false);
    expect(siblingBounds(ctx, 'a').map((s) => s.node)).toEqual(['b']);
    expect(unwrap(containerGrids(ctx, 'fr')).lines.x).toEqual([100, 300, 500]);
    // the mask clips the masked element's ink to the ellipse box
    expect(maskOf(ctx, 'c')?.id).toBe('m');
    expect(maskOf(ctx, 'm')).toBeUndefined();
    expect(unwrap(elementBounds(ctx, 'c')).ink).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 50 });
    const group = unwrap(elementBounds(ctx, 'g')).geometry;
    expect([group.minX, group.minY, group.maxX, group.maxY].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 0, 100, 100]);
    expect(elementBounds(ctx, 'p1').ok).toBe(false);
  });

  it('hits honour fill, stroke and masks (inverted too)', async () => {
    const g = await loadGeometry();
    const f = await createFixture([
      shape('g', {}, 'p1', 'group'),
      shape('m', { [P.w]: 50, [P.h]: 50, [P.shape]: 'ellipse', [P.maskMode]: 'alpha' }, 'g'),
      shape('c', { [P.w]: 100, [P.h]: 100, [P.fills]: [{ paint: '#f00' }] }, 'g'),
      shape('s', { [P.x]: 300, [P.w]: 100, [P.h]: 100, [P.strokes]: [{ paint: '#000', width: 4 }] }),
    ]);
    const ctx = f.ctx(g);
    expect(unwrap(hitElement(ctx, 'c', 25, 25))).toBe('fill');
    expect(unwrap(hitElement(ctx, 'c', 90, 90))).toBe('none'); // outside the mask
    expect(unwrap(hitElement(ctx, 'g', 25, 25))).toBe('fill');
    f.seed([{ op: 'set', node: 'm', path: P.maskInvert, value: true }]);
    expect(unwrap(hitElement(ctx, 'c', 25, 25))).toBe('none');
    expect(unwrap(hitElement(ctx, 'c', 90, 90))).toBe('fill');
    expect(unwrap(hitElement(ctx, 's', 350, 50))).toBe('none'); // no fill
    expect(unwrap(hitElement(ctx, 's', 301, 50))).toBe('stroke');
    expect(unwrap(hitElement(ctx, 'p1', 1, 1))).toBe('none');
  });

  it('a plain group outlines as the union of its children (groups as boolean operands, B7)', async () => {
    const g = await loadGeometry();
    const f = await createFixture([
      shape('u', { [P.boolean]: 'union', [P.fills]: [{ paint: '#f00' }] }, 'p1', 'group'),
      shape('inner', { [P.x]: 10 }, 'u', 'group'),
      shape('l', { [P.w]: 20, [P.h]: 20 }, 'inner'),
      shape('r', { [P.x]: 30, [P.w]: 20, [P.h]: 20 }, 'inner'),
      shape('empty', {}, 'p1', 'group'),
    ]);
    const ctx = f.ctx(g);
    expect(unwrap(elementBounds(ctx, 'u')).geometry).toEqual({ minX: 10, minY: 0, maxX: 60, maxY: 20 });
    expect(unwrap(hitElement(ctx, 'u', 15, 5))).toBe('fill');
    expect(unwrap(hitElement(ctx, 'u', 35, 5))).toBe('none'); // between the two operands of the inner group
    const empty = resolveElement(f.stage, 'empty');
    expect(unwrap(localOutline(ctx, empty!)).verbs).toHaveLength(0);
  });
});
