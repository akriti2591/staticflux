// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CORNER_PATHS, P } from './components.js';
import { appearanceEditOps, appearanceModel, NEW_ITEMS, swatchOf } from './inspector.js';
import { createFixture, KIT, shape, unwrap } from './testing/fixtures.js';

describe('appearance inspector (headless)', () => {
  it('models stacks as written (tokens kept), sources, corners and brand tokens by type', async () => {
    const f = await createFixture([
      shape('a', { [P.fills]: [{ paint: '@primary' }], [P.radius]: '@radius-md', [P.effects]: '@shadow-md', [P.opacity]: 0.5, [P.blend]: 'multiply', [P.smoothing]: 0.25 }),
      shape('b', { [P.inherit]: { kit: KIT, class: 'outline' }, [P.radiusTL]: 4 }),
    ]);
    const a = appearanceModel(f.stage, 'a', f.kit);
    expect(a).toMatchObject({ fills: [{ paint: '@primary' }], strokes: [], effects: [], effectsPreset: '@shadow-md', radius: '@radius-md', cornersLinked: true, opacity: 0.5, blend: 'multiply', smoothing: 0.25 });
    expect(a?.sources.radius).toEqual({ arc: 'local', token: 'radius-md' });
    expect(a?.tokens.colors).toEqual(['@accent', '@ink', '@primary']);
    expect(a?.tokens.sizes).toEqual(['@radius-md']);
    expect(a?.tokens.effects).toEqual(['@shadow-md']);
    const b = appearanceModel(f.stage, 'b', f.kit);
    expect(b?.strokes).toEqual([{ paint: '@ink', width: 2 }]);
    expect(b?.sources.strokes.arc).toBe('inherit');
    expect(b?.cornersLinked).toBe(false);
    expect(appearanceModel(f.stage, 'nope')).toBeUndefined();
  });

  it('turns panel edits into one validated set per edit', async () => {
    const f = await createFixture([shape('a', { [P.fills]: [{ paint: '#000' }, { paint: '#fff' }], [P.radius]: 6 })]);
    const model = appearanceModel(f.stage, 'a', f.kit)!;
    const set = (ops: ReturnType<typeof appearanceEditOps>) => (unwrap(ops)[0] as { value: unknown }).value;
    expect(set(appearanceEditOps(model, { op: 'add', stack: 'fills', item: NEW_ITEMS.fills }))).toHaveLength(3);
    expect(set(appearanceEditOps(model, { op: 'remove', stack: 'fills', index: 0 }))).toEqual([{ paint: '#fff' }]);
    expect(set(appearanceEditOps(model, { op: 'move', stack: 'fills', from: 0, to: 1 }))).toEqual([{ paint: '#fff' }, { paint: '#000' }]);
    expect(set(appearanceEditOps(model, { op: 'toggle', stack: 'fills', index: 1 }))).toEqual([{ paint: '#000' }, { paint: '#fff', visible: false }]);
    expect(set(appearanceEditOps(model, { op: 'update', stack: 'fills', index: 0, patch: { opacity: 0.5 } }))).toEqual([{ paint: '#000', opacity: 0.5 }, { paint: '#fff' }]);
    expect(appearanceEditOps(model, { op: 'update', stack: 'fills', index: 0, patch: { paint: 'tomato' } }).ok).toBe(false);
    expect(appearanceEditOps(model, { op: 'remove', stack: 'strokes', index: 0 }).ok).toBe(false);
    expect(appearanceEditOps(model, { op: 'move', stack: 'fills', from: 0, to: 5 }).ok).toBe(false);
    expect(set(appearanceEditOps(model, { op: 'set', path: P.opacity, value: 0.3 }))).toBe(0.3);
    expect(appearanceEditOps(model, { op: 'set', path: P.smoothing, value: 3 }).ok).toBe(false);
    const unlink = unwrap(appearanceEditOps(model, { op: 'link-corners', linked: false }));
    expect(unlink.map((o) => (o as { path: string; value: unknown }).value)).toEqual([6, 6, 6, 6]);
    expect(unlink.map((o) => (o as { path: string }).path)).toEqual([...CORNER_PATHS]);
    expect(unwrap(appearanceEditOps(model, { op: 'link-corners', linked: true })).every((o) => (o as { value: unknown }).value === null)).toBe(true);
    f.seed(unwrap(appearanceEditOps(model, { op: 'add', stack: 'effects', item: '@shadow-md' })));
    expect(f.stage.value('a', P.effects)).toEqual(['@shadow-md']);
  });

  it('swatches resolve tokens and gradients', async () => {
    const f = await createFixture();
    expect(swatchOf('@primary', f.kit)).toBe('#ff5c39');
    expect(swatchOf({ kind: 'linear', stops: [{ offset: 0, color: '#00ff00' }] })).toBe('#00ff00');
    expect(swatchOf('@nope', f.kit)).toBeUndefined();
    expect(swatchOf(undefined)).toBeUndefined();
  });
});
