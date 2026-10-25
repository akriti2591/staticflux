// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P } from './components.js';
import {
  checkElementValue,
  colorToRgba,
  isClassRef,
  isColorValue,
  isEffectValue,
  isFillValue,
  isLayoutGridValue,
  isPaintValue,
  isSizeValue,
  isStrokeValue,
  isTokenRef,
  rgbaToHex,
  tokenName,
  validateElementOps,
} from './values.js';

const stops = [{ offset: 0, color: '#fff' }, { offset: 1, color: '@ink' }];

describe('element values', () => {
  it('tokens and colours', () => {
    expect(tokenName('@primary')).toBe('primary');
    expect(tokenName('@radius-md')).toBe('radius-md');
    expect(tokenName('primary')).toBeUndefined();
    expect(isTokenRef('@1x')).toBe(false);
    expect(colorToRgba('#ff000080')).toEqual([255, 0, 0, 128]);
    expect(colorToRgba('rgb(1, 2, 3)')).toEqual([1, 2, 3, 255]);
    expect(colorToRgba('tomato')).toBeUndefined();
    expect(rgbaToHex([255, 92, 57, 255])).toBe('#ff5c39');
    expect(rgbaToHex([0, 0, 0, 128])).toBe('#00000080');
    expect(isColorValue('@ink') && isColorValue('#abc') && !isColorValue(3)).toBe(true);
  });

  it('paints: colour, linear, radial, conic, image', () => {
    expect(isPaintValue('#fff')).toBe(true);
    expect(isPaintValue({ kind: 'linear', from: [0, 0], to: [1, 1], stops })).toBe(true);
    expect(isPaintValue({ kind: 'radial', center: [0.5, 0.5], radius: 0.5, stops })).toBe(true);
    expect(isPaintValue({ kind: 'radial', center: [0.5, 0.5], radius: 0, stops })).toBe(false);
    expect(isPaintValue({ kind: 'conic', center: [0.5, 0.5], angle: 90, stops })).toBe(true);
    expect(isPaintValue({ kind: 'image', asset: { asset: 'as_1' }, fit: 'tile' })).toBe(true);
    expect(isPaintValue({ kind: 'image', asset: { asset: 'as_1' }, fit: 'zoom' })).toBe(false);
    expect(isPaintValue({ kind: 'linear', from: [0, 0], to: [1, 1], stops: [] })).toBe(false);
    expect(isPaintValue({ kind: 'linear', from: [0, 0], to: [1, 1], stops: [{ offset: 2, color: '#fff' }] })).toBe(false);
    expect(isPaintValue({ kind: 'sparkles' })).toBe(false);
  });

  it('fill, stroke and effect stack items', () => {
    expect(isFillValue({ paint: '#fff', opacity: 0.5, blend: 'multiply', visible: false, id: 'f1' })).toBe(true);
    expect(isFillValue({ paint: '#fff', opacity: 2 })).toBe(false);
    expect(isFillValue({ paint: '#fff', blend: 'glow' })).toBe(false);
    expect(isStrokeValue({ paint: '@ink', width: '@radius-md', sides: [1, 2, 3, 4], align: 'outside', dash: [4, 2], dashOffset: 1, cap: 'round', join: 'bevel', miter: 4 })).toBe(true);
    expect(isStrokeValue({ paint: '@ink', width: -1 })).toBe(false);
    expect(isStrokeValue({ paint: '@ink', width: 1, sides: [1, 2] })).toBe(false);
    expect(isStrokeValue({ paint: '@ink', width: 1, dash: [-1] })).toBe(false);
    for (const effect of [
      { kind: 'drop-shadow', x: 0, y: 4, blur: 8, spread: 1, color: '#0003' },
      { kind: 'inner-shadow', x: 1, y: 1, blur: 2, color: '@ink' },
      { kind: 'outer-glow', blur: 10, color: '#ff5c39' },
      { kind: 'inner-glow', blur: 10, spread: 2, color: '#ff5c39' },
      { kind: 'layer-blur', radius: 4 },
      { kind: 'background-blur', radius: 20, visible: false },
      '@shadow-md',
    ]) {
      expect(isEffectValue(effect), JSON.stringify(effect)).toBe(true);
    }
    expect(isEffectValue({ kind: 'drop-shadow', x: 0, blur: 1, color: '#000' })).toBe(false);
    expect(isEffectValue({ kind: 'layer-blur', radius: -1 })).toBe(false);
    expect(isEffectValue({ kind: 'bevel' })).toBe(false);
  });

  it('sizes, grids and class references', () => {
    expect(isSizeValue(0) && isSizeValue('@radius-md') && !isSizeValue(-1) && !isSizeValue('12')).toBe(true);
    expect(isLayoutGridValue({ kind: 'columns', count: 12, gutter: 20, margin: 40, align: 'stretch' })).toBe(true);
    expect(isLayoutGridValue({ kind: 'rows', count: 4, gutter: 8, margin: 0, align: 'center', size: 50, visible: false, color: '#f00' })).toBe(true);
    expect(isLayoutGridValue({ kind: 'grid', size: 8 })).toBe(true);
    expect(isLayoutGridValue({ kind: 'grid', size: 0 })).toBe(false);
    expect(isLayoutGridValue({ kind: 'columns', count: 0, gutter: 0, margin: 0, align: 'stretch' })).toBe(false);
    expect(isClassRef({ kit: { asset: 'as_kit' }, class: 'card' })).toBe(true);
    expect(isClassRef({ class: '' })).toBe(false);
  });

  it('checks writes (null always removes)', () => {
    expect(checkElementValue(P.fills, [{ paint: '#fff' }]).ok).toBe(true);
    expect(checkElementValue(P.fills, [{ paint: 'tomato' }]).ok).toBe(false);
    const bad = checkElementValue(P.strokes, [{ paint: '#000' }]);
    expect(!bad.ok && bad.error.code).toBe('IF-EL-001');
    expect(checkElementValue(P.fills, null).ok).toBe(true);
    expect(checkElementValue(P.effects, '@shadow-md').ok).toBe(true);
    expect(checkElementValue(P.smoothing, 1.5).ok).toBe(false);
    expect(checkElementValue(P.vertexRadii, [1, null, '@radius-md']).ok).toBe(true);
    expect(checkElementValue(P.radiusInner, 'x').ok).toBe(false);
    expect(checkElementValue('spatial.x', 'anything').ok).toBe(true); // field types are the registry's job
    expect(validateElementOps([{ op: 'create', node: 'a', kind: 'shape', parent: null, props: { [P.sides]: 2 } }]).ok).toBe(false);
    expect(validateElementOps([{ op: 'set', node: 'a', path: P.opacity, value: 0.5 }, { op: 'delete', node: 'b' }]).ok).toBe(true);
  });
});
