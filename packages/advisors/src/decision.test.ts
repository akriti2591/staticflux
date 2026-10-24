import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type AdvisoryPurpose,
  argmax,
  clamp,
  defineDecisionPoint,
  heuristicDistribution,
  normalize,
  type OptionOf,
  type QuestionOf,
  stableKey,
} from './index.js';

const NextFeature = defineDecisionPoint({
  id: 'loader/next-feature',
  purpose: 'warmup',
  options: ['studio', 'chat', 'none'] as const,
  latency: 'sync',
  heuristic: (q: { from: string }) => (q.from === 'studio' ? 'chat' : 'none'),
});

describe('decision points', () => {
  it('keeps typed question and closed options', () => {
    expectTypeOf<QuestionOf<typeof NextFeature>>().toEqualTypeOf<{ from: string }>();
    expectTypeOf<OptionOf<typeof NextFeature>>().toEqualTypeOf<'studio' | 'chat' | 'none'>();
    expect(NextFeature.budgetMs).toBe(1);
    expect(NextFeature.minConfidence).toBe(0);
    expect(Object.isFrozen(NextFeature)).toBe(true);
  });

  it('has no authorization purpose (R19.9)', () => {
    expectTypeOf<'authorization'>().not.toMatchTypeOf<AdvisoryPurpose>();
    expectTypeOf<'entitlement'>().not.toMatchTypeOf<AdvisoryPurpose>();
    defineDecisionPoint({
      id: 'x/y',
      // @ts-expect-error advisors are never used for authorization
      purpose: 'authorization',
      options: ['a'] as const,
      latency: 'sync',
      heuristic: () => 'a',
    });
  });

  it('rejects empty or duplicate option sets', () => {
    expect(() => defineDecisionPoint({ id: 'x/y', purpose: 'warmup', options: [], latency: 'sync', heuristic: () => 'a' })).toThrow();
    expect(() =>
      defineDecisionPoint({ id: 'x/y', purpose: 'warmup', options: ['a', 'a'], latency: 'sync', heuristic: () => 'a' }),
    ).toThrow();
  });

  it('defaults budgets per latency class and a stable cache key', () => {
    const idle = defineDecisionPoint({ id: 'x/idle', purpose: 'prefetch', options: ['a'], latency: 'idle', heuristic: () => 'a' });
    const bg = defineDecisionPoint({ id: 'x/bg', purpose: 'retention', options: ['a'], latency: 'background', heuristic: () => 'a' });
    expect(idle.budgetMs).toBe(50);
    expect(bg.budgetMs).toBe(500);
    expect(bg.cacheKey({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(stableKey(undefined)).toBe('undefined');
  });
});

describe('distribution helpers', () => {
  const options = ['a', 'b', 'c'] as const;
  it('normalizes, drops invalid values and unknown keys', () => {
    expect(normalize(options, { a: 1, b: 3, c: -1, d: 100 } as Record<string, number>)).toEqual({ a: 0.25, b: 0.75, c: 0 });
    expect(normalize(options, { a: Number.NaN })).toEqual({ a: 0, b: 0, c: 0 });
  });
  it('argmax picks the first best, undefined without mass', () => {
    expect(argmax(options, { a: 0.4, b: 0.4, c: 0.2 })).toBe('a');
    expect(argmax(options, { a: 0, b: 0, c: 0 })).toBeUndefined();
  });
  it('clamps and renormalizes', () => {
    expect(clamp(options, { a: 0.5, b: 0.25, c: 0.25 }, (o) => o !== 'a')).toEqual({ a: 0, b: 0.5, c: 0.5 });
    const full = { a: 1, b: 0, c: 0 };
    expect(clamp(options, full, undefined)).toBe(full);
  });
  it('turns heuristic answers into distributions', () => {
    expect(heuristicDistribution(NextFeature, { from: 'studio' })).toEqual({ studio: 0, chat: 1, none: 0 });
    const soft = defineDecisionPoint({
      id: 'x/soft',
      purpose: 'warmup',
      options,
      latency: 'sync',
      heuristic: () => ({ a: 1, b: 1 }),
    });
    expect(heuristicDistribution(soft, undefined)).toEqual({ a: 0.5, b: 0.5, c: 0 });
  });
});
