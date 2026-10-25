// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P } from './components.js';
import { applyClassOps, detachClassOps, overridesOf, resetOverrideOps, styleSource } from './styles.js';
import { createFixture, KIT, shape } from './testing/fixtures.js';

describe('style classes and local overrides (stage provenance)', () => {
  it('an element inherits its class; a local value overrides it and resetting brings the class back', async () => {
    const f = await createFixture([shape('a', { [P.inherit]: { kit: KIT, class: 'outline' } }), shape('b', {})]);
    expect(f.stage.value('a', P.strokes)).toEqual([{ paint: '@ink', width: 2 }]);
    expect(styleSource(f.stage, 'a', P.strokes)).toEqual({ arc: 'inherit', node: 'outline' });
    expect(overridesOf(f.stage, 'a')).toEqual([]);
    f.seed([{ op: 'set', node: 'a', path: P.strokes, value: [{ paint: '#ff0000', width: 4 }] }]);
    const overrides = overridesOf(f.stage, 'a');
    expect(overrides.map((o) => [o.path, o.local, o.inherited])).toEqual([[P.strokes, [{ paint: '#ff0000', width: 4 }], [{ paint: '@ink', width: 2 }]]]);
    expect(styleSource(f.stage, 'a', P.strokes).arc).toBe('local');
    f.seed(resetOverrideOps(f.stage, 'a'));
    expect(f.stage.value('a', P.strokes)).toEqual([{ paint: '@ink', width: 2 }]);
    expect(styleSource(f.stage, 'b', P.strokes)).toEqual({ arc: 'default' });
  });

  it('applies and removes a class; detaching keeps the values (token references, not colours)', async () => {
    const f = await createFixture([shape('a', {})]);
    f.seed(applyClassOps(['a'], { kit: KIT, class: 'card' }));
    expect(f.stage.value('a', P.radius)).toBe(12);
    expect(styleSource(f.stage, 'a', P.radius).token).toBe('radius-md');
    const detach = detachClassOps(f.stage, 'a', [P.radius, P.fills, P.strokes]);
    expect(detach).toEqual([
      { op: 'set', node: 'a', path: P.radius, value: '@radius-md' },
      { op: 'set', node: 'a', path: P.fills, value: [{ paint: '@primary' }] },
      { op: 'set', node: 'a', path: P.inherit, value: null },
    ]);
    f.seed(detach);
    expect(f.stage.value('a', P.radius)).toBe(12);
    expect(styleSource(f.stage, 'a', P.radius).arc).toBe('local');
    f.seed(applyClassOps(['a'], null));
    expect(detachClassOps(f.stage, 'missing', [P.radius])).toEqual([]);
    expect(overridesOf(f.stage, 'missing')).toEqual([]);
  });
});
