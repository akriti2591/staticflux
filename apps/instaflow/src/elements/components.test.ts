// @vitest-environment node
import { migrateComponentValues } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { createElementRegistry, ELEMENT_COMPONENTS, ELEMENT_KIND_COMPONENTS, Geometry, Lineage, Mask, P, spatialDefault, Style, tokenPath } from './components.js';

describe('element components', () => {
  it('are versioned v2 components with unique ids; style is version 2', () => {
    const ids = ELEMENT_COMPONENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Style.version).toBe(2);
    expect(Geometry.version).toBe(1);
    expect(Mask.schema).toHaveProperty('mode');
    expect(Lineage.schema).toEqual({ key: 'string' });
  });

  it('migrates style v1 (DOCUMENT-FORMAT draft) to v2 stacks', () => {
    const v1 = {
      fill: { color: { token: 'color.primary' } },
      stroke: { color: '#16151a', width: 3, align: 'inside' },
      radius: 8,
      effects: [{ kind: 'layer-blur', radius: 2 }],
    };
    const r = migrateComponentValues(Style, v1, 1);
    expect(r.ok && r.value).toEqual({
      fills: [{ paint: '@primary' }],
      strokes: [{ paint: '#16151a', width: 3, align: 'inside' }],
      radius: 8,
      effects: [{ kind: 'layer-blur', radius: 2 }],
    });
    const gradient = migrateComponentValues(Style, { fill: { gradient: { from: [0, 0], to: [1, 0], stops: [] } } }, 1);
    expect(gradient.ok && gradient.value['fills']).toEqual([{ paint: { kind: 'linear', from: [0, 0], to: [1, 0], stops: [] } }]);
    const image = migrateComponentValues(Style, { fill: { image: { asset: 'as_1' } } }, 1);
    expect(image.ok && image.value['fills']).toEqual([{ paint: { kind: 'image', asset: { asset: 'as_1' }, fit: 'cover' } }]);
    expect(migrateComponentValues(Style, { fill: 'oops' }, 1).ok).toBe(true);
    expect(migrateComponentValues(Style, {}, 3).ok).toBe(false);
  });

  it('a registry validates paths per kind and generates JSON Schema', () => {
    const registry = createElementRegistry();
    expect(registry.validate(P.x, 10, 'shape').ok).toBe(true);
    expect(registry.validate(P.clip, true, 'shape').ok).toBe(false); // frame component not on shapes
    expect(registry.validate(P.clip, true, 'frame').ok).toBe(true);
    expect(registry.validate(P.shape, 'hexagon', 'shape').ok).toBe(false);
    expect(registry.validate(P.matchKey, 'lk_1', 'image').ok).toBe(true);
    expect(registry.validate(P.maskMode, 'luminance', 'group').ok).toBe(true);
    expect(registry.validate(tokenPath('primary'), '#fff').ok).toBe(true);
    expect(registry.validate('role', 'cta').ok).toBe(true);
    expect(registry.validate('role', 'mystery').ok).toBe(false);
    const schema = registry.jsonSchema() as { $defs: Record<string, { 'x-version': number }> };
    expect(schema.$defs['style']?.['x-version']).toBe(2);
    expect(ELEMENT_KIND_COMPONENTS['image']).toContain('source');
    const extended = createElementRegistry({ kinds: { text: ['spatial', 'mask', 'lineage'] }, version: 7 });
    expect(extended.version).toBe(7);
    expect(extended.validate(P.maskMode, 'alpha', 'text').ok).toBe(true);
  });

  it('exposes defaults and token paths', () => {
    expect(spatialDefault(P.anchorX)).toBe(0.5);
    expect(spatialDefault(P.opacity)).toBe(1);
    expect(spatialDefault('nope')).toBeUndefined();
    expect(tokenPath('ink')).toBe('brand.tokens.ink');
  });
});
