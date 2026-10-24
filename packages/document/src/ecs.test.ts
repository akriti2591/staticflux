import { describe, expect, it, vi } from 'vitest';
import {
  createIdGenerator,
  createLwwMap,
  createWorld,
  defineComponent,
  defineSystem,
  defineTextComponent,
  isFieldValue,
  keyBetween,
  validateValues,
} from './index.js';

const Transform = defineComponent('test/transform', { x: 'f64', y: 'f64', z: 'i32', visible: 'bool' }, { visible: true });
const Label = defineComponent('test/label', { text: 'string', meta: 'json', level: 'u8' });
const Body = defineTextComponent('test/body');

describe('components', () => {
  it('declares typed defaults', () => {
    expect(Transform.defaults).toEqual({ x: 0, y: 0, z: 0, visible: true });
    expect(Label.defaults).toEqual({ text: '', meta: null, level: 0 });
    expect(Body.storage).toBe('text');
    expect(Object.isFrozen(Transform)).toBe(true);
  });

  it('validates field values', () => {
    expect(validateValues(Transform, { x: 1.5, z: 3 }).ok).toBe(true);
    const unknown = validateValues(Transform, { nope: 1 });
    expect(!unknown.ok && unknown.error.code).toBe('SF-DOC-003');
    expect(validateValues(Transform, { z: 1.5 }).ok).toBe(false);
    expect(validateValues(Transform, { visible: 'yes' }).ok).toBe(false);
    expect(isFieldValue('u8', 256)).toBe(false);
    expect(isFieldValue('u8', 255)).toBe(true);
    expect(isFieldValue('json', { a: 1 })).toBe(true);
    expect(isFieldValue('json', undefined)).toBe(false);
    expect(isFieldValue('string', 1)).toBe(false);
  });
});

describe('deterministic ids', () => {
  it('are client-prefixed and continue after observing existing ids', () => {
    const ids = createIdGenerator(35);
    expect(ids.next()).toBe('z-1');
    expect(ids.next()).toBe('z-2');
    ids.observe('z-a');
    ids.observe('other-zz');
    expect(ids.next()).toBe('z-b');
    expect(createIdGenerator(35).next()).toBe('z-1');
  });
});

describe('fractional keys', () => {
  it('always produce a key strictly between the bounds', () => {
    const cases: [string | undefined, string | undefined][] = [
      [undefined, undefined],
      ['a', undefined],
      [undefined, 'a'],
      ['a', 'b'],
      ['a', 'a1'],
      ['az', 'b'],
      ['zz', undefined],
      [undefined, '01'],
      ['0', '1'],
    ];
    for (const [a, b] of cases) {
      const key = keyBetween(a, b);
      if (a !== undefined) expect(key > a).toBe(true);
      if (b !== undefined) expect(key < b).toBe(true);
    }
    let lo: string | undefined;
    const hi = 'b';
    for (let i = 0; i < 50; i += 1) {
      const key = keyBetween(lo, hi);
      expect(key < hi && (lo === undefined || key > lo)).toBe(true);
      lo = key;
    }
    expect(keyBetween('b', 'a') > 'b').toBe(true);
  });
});

describe('world (SoA)', () => {
  it('stores struct components in typed columns and grows', () => {
    const world = createWorld([Transform, Label, Body]);
    for (let i = 0; i < 20; i += 1) {
      const id = `e${String(i).padStart(2, '0')}`;
      world.addEntity(id);
      world.writeStruct(id, Transform, { x: i, visible: i % 2 === 0 });
    }
    const store = world.store(Transform);
    expect(store.size).toBe(20);
    expect(store.column('x')).toBeInstanceOf(Float64Array);
    expect(store.column('visible')).toBeInstanceOf(Uint8Array);
    expect(world.get('e05', Transform)).toEqual({ x: 5, y: 0, z: 0, visible: false });
    const row = store.row('e07') as number;
    expect(store.entityAt(row)).toBe('e07');
    expect((store.column('x') as Float64Array)[row]).toBe(7);
  });

  it('swap-removes rows and keeps lookups consistent', () => {
    const world = createWorld([Transform, Label]);
    for (const id of ['a', 'b', 'c']) {
      world.addEntity(id);
      world.writeStruct(id, Transform, { x: id.charCodeAt(0) });
      world.writeStruct(id, Label, { text: id });
    }
    world.removeComponent('a', Label);
    expect(world.get('c', Label)?.text).toBe('c');
    expect(world.hasComponent('a', Label)).toBe(false);
    world.removeEntity('b');
    expect(world.has('b')).toBe(false);
    expect(world.get('c', Transform)?.x).toBe('c'.charCodeAt(0));
    expect(world.store(Transform).entities()).toEqual(['a', 'c']);
    world.removeComponent('zzz', Transform);
  });

  it('queries are sorted and support `without`', () => {
    const world = createWorld([Transform, Label, Body]);
    for (const id of ['c', 'a', 'b']) world.addEntity(id);
    world.writeStruct('c', Transform, {});
    world.writeStruct('a', Transform, {});
    world.writeStruct('a', Label, {});
    world.writeText('b', Body, 'hi');
    world.writeText('c', Body, 'yo');
    expect(world.entities()).toEqual(['a', 'b', 'c']);
    expect(world.query([Transform])).toEqual(['a', 'c']);
    expect(world.query([Transform], { without: [Label] })).toEqual(['c']);
    expect(world.query([Body, Transform])).toEqual(['c']);
    expect(world.query([], { without: [Body] })).toEqual(['a']);
    expect(world.text('b', Body)).toBe('hi');
    expect(world.component('test/label')).toBe(Label);
  });

  it('defineSystem keeps the declaration as data', () => {
    const run = vi.fn();
    const system = defineSystem({ id: 'test/count', query: [Body], run });
    expect(Object.isFrozen(system)).toBe(true);
  });
});

describe('LWW map', () => {
  it('higher clock wins, then higher actor; diff by state vector', () => {
    const a = createLwwMap(1);
    const b = createLwwMap(2);
    const ea = a.set('k', 'from-a');
    const eb = b.set('k', 'from-b'); // same clock, higher actor
    expect(a.merge([eb])).toEqual(['k']);
    expect(b.merge([ea])).toEqual([]);
    expect(a.get('k')).toBe('from-b');
    expect(b.get('k')).toBe('from-b');
    const later = a.set('k', 'a-later');
    expect(later.clock).toBe(2);
    b.merge([later]);
    expect(b.get('k')).toBe('a-later');
    expect(a.diff(b.stateVector())).toEqual([]);
    a.set('other', 1);
    expect(a.diff(b.stateVector()).map((e) => e.key)).toEqual(['other']);
    expect(a.has('other')).toBe(true);
    expect([...a.keys()].sort()).toEqual(['k', 'other']);
    expect(a.clock).toBe(3);
  });
});
