// @vitest-environment node
/**
 * The inspector's rules as data (B11b): sections per kind, row summaries, gradient edits, dash presets, effect
 * presets, blend groups, page presets.
 */
import { describe, expect, it } from 'vitest';
import {
  blendGroupsComplete,
  colorAt,
  dashPatch,
  dashPresetOf,
  EFFECT_PRESETS,
  effectPreset,
  effectRowSummary,
  effectsSummary,
  gradientAngle,
  gradientFrom,
  inspectorSections,
  layerSummary,
  leadColor,
  linearEnds,
  pagePresetOf,
  pageSizePresets,
  paintKind,
  paintRowSummary,
  reversed,
  strokeRowSummary,
  withAngle,
  withKind,
  withStop,
  withStopAdded,
  withStopRemoved,
} from './inspector-model.js';

const linear = { kind: 'linear' as const, from: [0, 0.5] as const, to: [1, 0.5] as const, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#FFFFFF' }] };

describe('inspector model', () => {
  it('sections: corners only where the selection has corners; nothing selected is Page and Document', () => {
    expect(inspectorSections('shape', 'rectangle').map((s) => s.id)).toEqual(['transform', 'fill', 'stroke', 'corners', 'effects', 'layer']);
    expect(inspectorSections('shape', 'ellipse').map((s) => s.id)).toEqual(['transform', 'fill', 'stroke', 'effects', 'layer']);
    expect(inspectorSections('none', undefined).map((s) => s.id)).toEqual(['page', 'document']);
    expect(inspectorSections('shape', 'rectangle').filter((s) => s.collapsed === true).map((s) => s.id)).toEqual(['corners', 'effects', 'layer']);
  });

  it('row summaries: solid, token, gradient, image, stroke', () => {
    expect(paintRowSummary('#ff5c39')).toEqual({ title: '#FF5C39' });
    expect(paintRowSummary('@cream', () => '#fff4e0')).toEqual({ title: '@cream', detail: '#FFF4E0' });
    expect(paintRowSummary('@nope')).toEqual({ title: '@nope', detail: 'not in this brand kit' });
    expect(paintRowSummary(linear)).toEqual({ title: 'Linear · 2 stops · 0°' });
    expect(paintRowSummary({ kind: 'radial', center: [0.5, 0.5], radius: 0.5, stops: linear.stops })).toEqual({ title: 'Radial · 2 stops' });
    expect(paintRowSummary({ kind: 'image', asset: { asset: 'a' }, fit: 'contain' })).toEqual({ title: 'Image · Fit' });
    expect(strokeRowSummary({ paint: '#16151a', width: 2, align: 'inside' })).toEqual({ title: '#16151A · 2 px · Inside' });
    expect(paintKind(undefined)).toBe('solid');
  });

  it('gradients: angle ↔ ends, type switch keeps stops, reverse, stops add / remove / move', () => {
    expect(gradientAngle(linear)).toBe(0);
    expect(linearEnds(90)).toEqual({ from: [0.5, 0], to: [0.5, 1] });
    expect(gradientAngle({ ...linear, ...linearEnds(45) })).toBe(45);
    expect(gradientAngle(withAngle(linear, 405))).toBe(45);
    const radial = withKind(linear, 'radial');
    expect(radial).toEqual({ kind: 'radial', center: [0.5, 0.5], radius: 0.5, stops: linear.stops });
    expect(withKind(withAngle(linear, 90), 'conic')).toMatchObject({ kind: 'conic', angle: 90 });
    expect(withKind(radial, 'linear')).toMatchObject({ kind: 'linear', from: [0, 0.5], to: [1, 0.5] });
    expect(reversed({ ...linear, stops: [{ offset: 0.2, color: '#000000' }, { offset: 1, color: '#FFFFFF' }] }).stops).toEqual([{ offset: 0, color: '#FFFFFF' }, { offset: 0.8, color: '#000000' }]);
    expect(colorAt(linear.stops, 0.5)).toBe('#808080');
    const three = withStopAdded(linear, 0.5);
    expect(three.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    expect(withStopRemoved(three, 1).stops).toHaveLength(2);
    expect(withStopRemoved(linear, 0).stops).toHaveLength(2); // never below two
    expect(withStop(three, 0, { offset: 0.9 }).stops.map((s) => s.offset)).toEqual([0.5, 0.9, 1]);
    expect(gradientFrom('#ff5c39').stops).toEqual([{ offset: 0, color: '#FF5C39' }, { offset: 1, color: '#FF5C3900' }]);
    expect(leadColor(three)).toBe('#000000');
  });

  it('dash presets follow the width; effect summaries; layer summary', () => {
    expect(dashPatch('dashed', 2)).toEqual({ dash: [6, 4], cap: 'butt' });
    expect(dashPresetOf({ width: 2, ...dashPatch('dotted', 2) })).toBe('dotted');
    expect(dashPresetOf({ width: 2, dash: [1, 7] })).toBe('custom');
    expect(dashPresetOf({ width: 2 })).toBe('solid');
    expect(effectRowSummary({ kind: 'drop-shadow', x: 0, y: 4, blur: 12, color: '#16151A40' })).toBe('Shadow · 0 4 12 · 25 %');
    expect(effectRowSummary({ kind: 'layer-blur', radius: 4 })).toBe('Blur · 4');
    expect(effectsSummary({ effects: [], effectsPreset: '@shadow-md' })).toBe('@shadow-md');
    expect(effectsSummary({ effects: [{ kind: 'layer-blur', radius: 2 }, { kind: 'layer-blur', radius: 3 }] })).toBe('2 effects');
    expect(layerSummary(0.5, 'multiply')).toBe('50 % · Multiply');
    expect(layerSummary(1, 'normal')).toBe('');
    expect(blendGroupsComplete()).toBe(true);
    expect(effectPreset('bevel-soft')?.items).toHaveLength(2);
    expect(EFFECT_PRESETS.flatMap((g) => g.presets).every((p) => p.items.length > 0)).toBe(true);
  });

  it('page presets come from Home’s formats, one per size', () => {
    const presets = pageSizePresets();
    expect(presets.map((p) => `${p.width}x${p.height}`)).toEqual(['1080x1350', '1080x1920', '1920x1080', '1240x1754']);
    expect(pagePresetOf(1080, 1920)?.id).toBe('story');
    expect(pagePresetOf(10, 10)).toBeUndefined();
  });
});
