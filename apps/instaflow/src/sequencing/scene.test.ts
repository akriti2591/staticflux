import type { NodeRecord } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { comparePaintKeys, elementBounds, gridSceneOps, gridSceneSnapshot, paintKey } from './scene.js';
import { engine, openScene } from './test-helpers.js';

const record = (kind: string, props: Record<string, number>): NodeRecord => ({ id: 'n', kind, parent: null, order: 'a', props, texts: [], lists: [] });

describe('elementBounds', () => {
  it('is the spatial box grown by half the stroke width, for projected kinds only', () => {
    expect(elementBounds(record('shape', { 'spatial.x': 1, 'spatial.y': 2, 'spatial.w': 10, 'spatial.h': 20 }))).toEqual({ minX: 1, minY: 2, maxX: 11, maxY: 22 });
    expect(elementBounds(record('text', { 'spatial.x': 0, 'spatial.y': 0, 'spatial.w': 10, 'spatial.h': 10, 'style.stroke.width': 4 }))).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 12 });
    expect(elementBounds(record('group', { 'spatial.x': 0 }))).toBeUndefined();
    expect(elementBounds(record('shape', {}))).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('paintKey / comparePaintKeys', () => {
  it('orders by fractional keys from the root down (later siblings and later groups paint on top)', () => {
    const part = openScene();
    const a = paintKey(part, 'e0');
    const b = paintKey(part, 'e1');
    const c = paintKey(part, 'e100');
    expect(a).toHaveLength(2);
    expect(comparePaintKeys(a, b)).toBe(-1);
    expect(comparePaintKeys(b, a)).toBe(1);
    expect(comparePaintKeys(b, c)).toBe(-1); // group g1 above group g0
    expect(comparePaintKeys(a, a)).toBe(0);
    expect(comparePaintKeys(['x'], ['x', 'y'])).toBeLessThan(0);
    expect(paintKey(part, 'missing')).toEqual([]);
    part.dispose();
  });
});

describe('gridSceneOps / gridSceneSnapshot', () => {
  it('lays shapes out on a grid in groups', () => {
    const ops = gridSceneOps({ elements: 250, groupSize: 100, columns: 10, pitch: 50, size: 30 });
    expect(ops.filter((op) => op.op === 'create' && op.kind === 'group')).toHaveLength(3);
    const e12 = ops.find((op) => op.op === 'create' && op.node === 'e12');
    expect(e12).toMatchObject({ parent: 'g0', props: { 'spatial.x': 100, 'spatial.y': 50, 'spatial.w': 30, 'spatial.h': 30 } });
    expect(ops.find((op) => op.op === 'create' && op.node === 'e100')).toMatchObject({ parent: 'g1' });
  });
  it('builds a loadable snapshot', () => {
    const snapshot = gridSceneSnapshot(engine, { elements: 120 });
    if (!snapshot.ok) throw snapshot.error;
    const part = engine.load(snapshot.value, { peer: '3' });
    if (!part.ok) throw part.error;
    expect(part.value.prop('e119', 'spatial.x')).toBe(19 * 60);
    expect(part.value.size()).toBe(122);
    part.value.dispose();
  });
});
