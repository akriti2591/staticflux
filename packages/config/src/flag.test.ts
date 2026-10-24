import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineFlag, type FlagValueOf, flagType, flagValue, variantKeyOf, variantValue } from './index.js';

declare module './flag.js' {
  interface FlagRegistry {
    'test/registered': boolean;
    'test/variant': 'A' | 'B';
  }
}

export const Registered = defineFlag({
  key: 'test/registered',
  type: flagType.boolean(),
  default: false,
  owner: 'team-test',
  preAuthSafe: true,
  description: 'Registered boolean.',
});

export const Variant = defineFlag({
  key: 'test/variant',
  type: flagType.enum(['A', 'B']),
  default: 'A',
  owner: 'team-test',
  preAuthSafe: false,
  description: 'Experiment arm.',
});

describe('flag schemas', () => {
  it('boolean / string', () => {
    expect(flagType.boolean().parse(true).ok).toBe(true);
    const bad = flagType.boolean().parse('true');
    expect(!bad.ok && bad.error.code).toBe('SF-CFG-001');
    expect(flagType.string().parse('x').ok).toBe(true);
    expect(flagType.string().parse(1).ok).toBe(false);
    expect(flagType.boolean().values).toEqual([true, false]);
  });

  it('number with bounds', () => {
    const n = flagType.number({ min: 1, max: 10, integer: true });
    expect(n.parse(5)).toEqual({ ok: true, value: 5 });
    expect(n.parse(0).ok).toBe(false);
    expect(n.parse(11).ok).toBe(false);
    expect(n.parse(1.5).ok).toBe(false);
    expect(n.parse(Number.NaN).ok).toBe(false);
    expect(n.parse('5').ok).toBe(false);
    expect(flagType.number().parse(-3.5).ok).toBe(true);
  });

  it('enum', () => {
    const e = flagType.enum(['A', 'B']);
    expect(e.type).toBe('string');
    expect(e.values).toEqual(['A', 'B']);
    expect(e.parse('B').ok).toBe(true);
    const bad = e.parse('C');
    expect(!bad.ok && bad.error.message).toContain('A | B');
  });

  it('object with guard', () => {
    const isLimits = (v: unknown): v is { max: number } => typeof (v as { max?: unknown }).max === 'number';
    const o = flagType.object(isLimits, 'limits');
    expect(o.parse({ max: 3 }).ok).toBe(true);
    expect(o.parse({ max: '3' }).ok).toBe(false);
    expect(o.parse(null).ok).toBe(false);
    expect(o.parse(undefined).ok).toBe(false);
  });
});

describe('defineFlag', () => {
  it('produces a frozen typed declaration', () => {
    expect(Registered).toMatchObject({ kind: 'flag', key: 'test/registered', defaultValue: false, owner: 'team-test', preAuthSafe: true });
    expect(Object.isFrozen(Registered)).toBe(true);
    expectTypeOf<FlagValueOf<typeof Variant>>().toEqualTypeOf<'A' | 'B'>();
    expectTypeOf(Variant.key).toEqualTypeOf<'test/variant'>();
  });

  it('type-checks registered keys and defaults', () => {
    defineFlag({
      key: 'test/registered',
      // @ts-expect-error registered as boolean, declared as string
      type: flagType.string(),
      default: 'x',
      owner: 'o',
      preAuthSafe: false,
      description: '',
    });
    defineFlag({
      key: 'test/unregistered',
      type: flagType.enum(['x', 'y']),
      // @ts-expect-error default must be a schema value
      default: 'z',
      owner: 'o',
      preAuthSafe: false,
      description: '',
    });
    expect(true).toBe(true);
  });

  it('variant helpers', () => {
    expect(variantValue(Registered, 'true')).toBe(true);
    expect(variantValue(Registered, 'false')).toBe(false);
    expect(variantValue(Variant, 'B')).toBe('B');
    expect(variantKeyOf(true)).toBe('true');
    expect(variantKeyOf(false)).toBe('false');
    expect(variantKeyOf('A')).toBe('A');
    expect(variantKeyOf(3)).toBeUndefined();
    expect(flagValue(Variant, 'B')).toEqual({ flag: Variant, value: 'B' });
  });
});
