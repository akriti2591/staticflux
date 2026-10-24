import { describe, expect, expectTypeOf, it } from 'vitest';
import { type Infer, s, toJsonSchema, validate } from './index.js';

const Input = s.object(
  {
    src: s.string({ format: 'uri', description: 'Image URL' }),
    alt: s.optional(s.string({ maxLength: 5 })),
    width: s.optional(s.number({ min: 1, max: 4000, integer: true })),
    position: s.enum(['start', 'end'] as const),
    tags: s.array(s.string({ minLength: 1 }), { maxItems: 2 }),
    visible: s.boolean(),
  },
  { description: 'Insert image' },
);

describe('schema DSL', () => {
  it('infers types with optional keys', () => {
    type T = Infer<typeof Input>;
    expectTypeOf<T>().toEqualTypeOf<{
      readonly src: string;
      readonly position: 'start' | 'end';
      readonly tags: readonly string[];
      readonly visible: boolean;
      readonly alt?: string;
      readonly width?: number;
    }>();
  });

  it('accepts valid values and omits absent/undefined optionals', () => {
    const result = validate(Input, {
      src: 'https://x.test/a.png',
      alt: undefined,
      position: 'end',
      tags: ['a'],
      visible: true,
    });
    expect(result).toEqual({
      ok: true,
      value: { src: 'https://x.test/a.png', position: 'end', tags: ['a'], visible: true },
    });
    expect(result.ok && 'alt' in result.value).toBe(false);
  });

  it('collects every issue with paths', () => {
    const result = validate(Input, {
      src: 'not a url',
      alt: 'too long',
      width: 1.5,
      position: 'middle',
      tags: ['', 'b', 'c'],
      visible: 'yes',
      extra: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SF-CAP-002');
    expect(result.error.kind).toBe('validation');
    const issues = result.error.details['issues'] as { path: string; message: string }[];
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/extra', '/src', '/alt', '/width', '/position', '/tags', '/tags/0', '/visible']),
    );
  });

  it('reports missing required fields and wrong container types', () => {
    const missing = validate(Input, {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      const issues = missing.error.details['issues'] as { path: string; message: string }[];
      expect(issues.filter((i) => i.message === 'required').map((i) => i.path)).toEqual([
        '/src',
        '/position',
        '/tags',
        '/visible',
      ]);
    }
    expect(validate(Input, null).ok).toBe(false);
    expect(validate(Input, []).ok).toBe(false);
    expect(validate(s.array(s.number()), 'x').ok).toBe(false);
    expect(validate(s.number(), Number.NaN).ok).toBe(false);
    expect(validate(s.number({ min: 2 }), 1).ok).toBe(false);
    expect(validate(s.number({ max: 2 }), 3).ok).toBe(false);
    expect(validate(s.string({ minLength: 2 }), 'a').ok).toBe(false);
    expect(validate(s.string({ pattern: '^[a-z]+$' }), 'A1').ok).toBe(false);
    expect(validate(s.string({ pattern: '^[a-z]+$' }), 'ab').ok).toBe(true);
    expect(validate(s.array(s.number(), { minItems: 1 }), []).ok).toBe(false);
  });

  it('exports JSON Schema for agents', () => {
    expect(toJsonSchema(Input)).toEqual({
      type: 'object',
      description: 'Insert image',
      additionalProperties: false,
      required: ['src', 'position', 'tags', 'visible'],
      properties: {
        src: { type: 'string', format: 'uri', description: 'Image URL' },
        alt: { type: 'string', maxLength: 5 },
        width: { type: 'integer', minimum: 1, maximum: 4000 },
        position: { type: 'string', enum: ['start', 'end'] },
        tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 2 },
        visible: { type: 'boolean' },
      },
    });
    expect(toJsonSchema(s.number())).toEqual({ type: 'number' });
    expect(toJsonSchema(s.array(s.boolean(), { minItems: 1 }))).toEqual({
      type: 'array',
      items: { type: 'boolean' },
      minItems: 1,
    });
    expect(toJsonSchema(s.string({ pattern: '^a' }))).toEqual({ type: 'string', pattern: '^a' });
  });

  it('rejects nonsensical declarations', () => {
    expect(() => s.enum([])).toThrow();
    // @ts-expect-error optional items are not allowed at the type level either
    expect(() => s.array(s.optional(s.string()))).toThrow();
  });
});
