import { describe, expect, it } from 'vitest';
import {
  componentJsonSchema,
  createComponentRegistry,
  defineComponent,
  field,
  fieldJsonSchema,
  fieldStorage,
  isFieldValueV2,
  migrateComponentValues,
} from './components.js';

const Spatial = defineComponent('spatial', { x: 'f64', y: 'f64', rotation: 'f64', anchor: 'vec2' }, { defaults: { rotation: 0 } });
const Temporal = defineComponent('temporal', { start: 'ticks', duration: 'ticks' });
const Style = defineComponent(
  'style',
  { fill: 'color', blend: field.enum(['normal', 'multiply']), vars: field.map('f64'), effects: field.list('json') },
  { version: 2, migrations: { 2: (v) => ({ ...v, fill: (v['color'] as string | undefined) ?? null, color: null }) } },
);
const Text = defineComponent('text', { content: 'richtext', link: field.ref('node') });
const Source = defineComponent('source', { asset: field.ref('asset'), count: 'u8', frame: 'i32', loop: 'bool', label: 'string', extra: 'json' });

const registry = createComponentRegistry({
  version: 3,
  components: [Spatial, Temporal, Style, Text, Source],
  roles: ['headline', 'body'],
  kinds: { shape: ['spatial', 'style'], text: ['spatial', 'text'], video: ['spatial', 'temporal', 'source'] },
});

describe('defineComponent', () => {
  it('freezes a versioned definition with defaults', () => {
    expect(Style).toMatchObject({ kind: 'component/v2', id: 'style', version: 2 });
    expect(Spatial.defaults).toEqual({ rotation: 0 });
    expect(Object.isFrozen(Style)).toBe(true);
  });

  it('rejects bad ids, field names and missing migrations (definition-time programmer errors)', () => {
    expect(() => defineComponent('Bad.Id', {})).toThrow(/component id/);
    expect(() => defineComponent('ok', { 'a.b': 'f64' })).toThrow(/field name/);
    expect(() => defineComponent('ok', {}, { version: 3, migrations: { 2: (v) => v } })).toThrow(/version 3/);
    expect(() => defineComponent('ok', {}, { version: 0 })).toThrow(/version/);
  });
});

describe('field types', () => {
  it('validates every field type', () => {
    const cases: [Parameters<typeof isFieldValueV2>[0], unknown, boolean][] = [
      ['f64', 1.5, true],
      ['f64', Number.NaN, false],
      ['i32', 2 ** 31, false],
      ['u8', 255, true],
      ['u8', 256, false],
      ['ticks', 705_600_000 * 3600, true],
      ['ticks', 1.5, false],
      ['bool', false, true],
      ['string', 'x', true],
      ['color', '#ff00aa', true],
      ['color', 'oklch(70% 0.1 200)', true],
      ['color', 'red', true],
      ['color', '#12', false],
      ['color', 'rgb(1,2', false],
      ['vec2', [1, 2], true],
      ['vec2', [1], false],
      ['richtext', { text: 'a', spans: [] }, true],
      ['richtext', { text: 1 }, false],
      ['json', { a: [1] }, true],
      [field.enum(['a', 'b']), 'b', true],
      [field.enum(['a', 'b']), 'c', false],
      [field.ref('node'), 'n1', true],
      [field.ref('node'), '', false],
      [field.ref('asset'), { asset: 'as_1', at: 'latest' }, true],
      [field.ref('asset'), { asset: 'as_1', where: 'x' }, false],
      [field.map('f64'), { gap: 4 }, true],
      [field.map('f64'), { gap: 'x' }, false],
      [field.list('u8'), [1, 2], true],
      [field.list('u8'), [1, 300], false],
    ];
    for (const [spec, value, expected] of cases) expect([spec, value, isFieldValueV2(spec, value)]).toEqual([spec, value, expected]);
  });

  it('maps field types to storage', () => {
    expect(fieldStorage('richtext')).toBe('text');
    expect(fieldStorage(field.list('f64'))).toBe('list');
    expect(fieldStorage(field.map('f64'))).toBe('map');
    expect(fieldStorage('vec2')).toBe('register');
  });

  it('generates JSON Schema per field and component', () => {
    expect(fieldJsonSchema('u8')).toEqual({ type: 'integer', minimum: 0, maximum: 255 });
    expect(fieldJsonSchema(field.enum(['a']))).toEqual({ type: 'string', enum: ['a'] });
    expect(fieldJsonSchema(field.map('bool'))).toEqual({ type: 'object', additionalProperties: { type: 'boolean' } });
    expect(fieldJsonSchema(field.list('string'))).toEqual({ type: 'array', items: { type: 'string' } });
    expect(fieldJsonSchema(field.ref('asset'))).toMatchObject({ type: 'object', required: ['asset'] });
    for (const spec of ['f64', 'i32', 'ticks', 'bool', 'string', 'color', 'vec2', 'richtext', 'json', field.ref('node')] as const) {
      expect(typeof fieldJsonSchema(spec)).toBe('object');
    }
    expect(componentJsonSchema(Temporal)).toEqual({
      type: 'object',
      properties: { start: { type: 'integer', description: 'Time in integer ticks.' }, duration: { type: 'integer', description: 'Time in integer ticks.' } },
      additionalProperties: false,
      'x-version': 1,
    });
  });
});

describe('migrateComponentValues', () => {
  it('runs every step and drops nulls', () => {
    const r = migrateComponentValues(Style, { color: '#fff', blend: 'normal' }, 1);
    expect(r.ok && r.value).toEqual({ fill: '#fff', blend: 'normal' });
    const same = migrateComponentValues(Style, { fill: '#000' }, 2);
    expect(same.ok && same.value).toEqual({ fill: '#000' });
  });

  it('fails on unknown versions and throwing migrations', () => {
    const future = migrateComponentValues(Style, {}, 3);
    expect(future.ok ? '' : future.error.code).toBe('SF-DOC-016');
    const broken = defineComponent('broken', {}, { version: 2, migrations: { 2: () => { throw new Error('boom'); } } });
    const r = migrateComponentValues(broken, {}, 1);
    expect(r.ok ? '' : r.error.code).toBe('SF-DOC-016');
  });
});

describe('createComponentRegistry', () => {
  it('resolves paths, including first-class role/name and map keys', () => {
    expect(registry.resolve('spatial.x')).toMatchObject({ field: 'x', spec: 'f64', storage: 'register' });
    expect(registry.resolve('style.vars.gap')).toMatchObject({ field: 'vars', key: 'gap', spec: 'f64', storage: 'register' });
    expect(registry.resolve('style.vars')).toBeUndefined();
    expect(registry.resolve('text.content')?.storage).toBe('text');
    expect(registry.resolve('style.effects')?.storage).toBe('list');
    expect(registry.resolve('role')?.spec).toEqual({ type: 'enum', values: ['headline', 'body'] });
    expect(registry.resolve('name')?.spec).toBe('string');
    expect(registry.resolve('spatial.x.y')).toBeUndefined();
    expect(registry.component('style')).toBe(Style);
    expect(registry.versions()).toEqual({ spatial: 1, temporal: 1, style: 2, text: 1, source: 1 });
    expect(() => createComponentRegistry({ version: 1, components: [Spatial, Spatial] })).toThrow(/duplicate/);
  });

  it('validates values, kinds and roles', () => {
    expect(registry.validate('spatial.x', 3).ok).toBe(true);
    expect(registry.validate('spatial.x', null).ok).toBe(true);
    const wrong = registry.validate('spatial.x', 'a');
    expect(wrong.ok ? '' : wrong.error.code).toBe('SF-DOC-003');
    const unknown = registry.validate('nope.x', 1);
    expect(unknown.ok ? '' : unknown.error.code).toBe('SF-DOC-001');
    expect(registry.validate('spatial.zzz', 1).ok).toBe(false);
    expect(registry.validate('role', 'headline').ok).toBe(true);
    expect(registry.validate('role', 'villain').ok).toBe(false);
    expect(registry.validate('temporal.start', 1, 'shape').ok).toBe(false);
    expect(registry.validate('temporal.start', 1, 'video').ok).toBe(true);
    expect(registry.validate('temporal.start', 1, 'unlisted-kind').ok).toBe(true);
  });

  it('validates part ops (creates, sets, text and list paths, kinds of existing nodes)', () => {
    const kindOf = (node: string): string | undefined => (node === 'v' ? 'video' : node === 's' ? 'shape' : undefined);
    expect(
      registry.validateOps(
        [
          { op: 'create', node: 't', kind: 'text', parent: null, props: { 'spatial.x': 1, role: 'body' }, texts: { 'text.content': { text: 'hi', spans: [] } } },
          { op: 'set', node: 't', path: 'text.link', value: 'n2' },
          { op: 'text.insert', node: 't', path: 'text.content', at: 0, text: '!' },
          { op: 'set', node: 'v', path: 'temporal.start', value: 10 },
          { op: 'list.insert', node: 's', path: 'style.effects', at: 0, value: { blur: 1 } },
          { op: 'move', node: 's', parent: null },
          { op: 'delete', node: 'v' },
        ],
        kindOf,
      ).ok,
    ).toBe(true);
    const bad = [
      [{ op: 'set', node: 's', path: 'temporal.start', value: 1 }],
      [{ op: 'set', node: 's', path: 'text.content', value: 'plain' }],
      [{ op: 'text.insert', node: 's', path: 'spatial.x', at: 0, text: 'x' }],
      [{ op: 'list.insert', node: 's', path: 'style.fill', at: 0, value: 1 }],
      [{ op: 'create', node: 'x', kind: 'shape', parent: null, texts: { 'spatial.x': { text: '', spans: [] } } }],
      [{ op: 'create', node: 'x', kind: 'shape', parent: null, lists: { 'style.effects': 'nope' } }],
    ] as const;
    for (const ops of bad) expect(registry.validateOps(ops as never, kindOf).ok).toBe(false);
  });

  it('generates a registry JSON Schema and a property-path schema for change sets', () => {
    const schema = registry.jsonSchema();
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Object.keys(schema['$defs'] as object)).toEqual(['source', 'spatial', 'style', 'temporal', 'text']);
    expect(schema['x-roles']).toEqual(['headline', 'body']);
    const paths = registry.pathSchema({ kind: 'shape', nullable: true });
    expect(Object.keys(paths['properties'] as object).sort()).toEqual(['name', 'role', 'spatial.anchor', 'spatial.rotation', 'spatial.x', 'spatial.y', 'style.blend', 'style.fill']);
    expect(paths['patternProperties']).toEqual({ '^style\\.vars\\..+$': { anyOf: [{ type: 'number' }, { type: 'null' }] } });
    expect(paths['additionalProperties']).toBe(false);
    const all = createComponentRegistry({ version: 1, components: [Temporal] }).pathSchema();
    expect((all['properties'] as Record<string, unknown>)['role']).toEqual({ type: 'string' });
  });
});
