import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  createRateLimiter,
  DEFAULT_PLUGIN_LIMITS,
  definePluginEvent,
  definePluginManifest,
  effectiveLimits,
  estimateBytes,
  isAllowedEntryUrl,
  validateManifest,
} from './index.js';

const valid = {
  id: 'acme/counter' as const,
  version: '1.2.3-beta.1',
  name: 'Counter',
  entry: { kind: 'iframe', url: 'https://plugins.example/counter.js' },
  capabilities: ['test/echo', 'test/echo'],
  events: ['studio/selection'],
  permissions: ['render'],
  limits: { callTimeoutMs: 500 },
};

describe('validateManifest', () => {
  it('accepts a valid manifest and dedupes lists', () => {
    const result = validateManifest(valid);
    expect(result.ok && result.value).toEqual({ ...valid, capabilities: ['test/echo'] });
    expect(result.ok && Object.isFrozen(result.value)).toBe(true);
    expect(validateManifest({ ...valid, entry: { kind: 'iframe', code: 'console.log(1)' }, limits: undefined }).ok).toBe(true);
    expect(validateManifest({ ...valid, entry: { kind: 'worker', url: './w.js' } }).ok).toBe(true);
  });

  it.each([
    ['not an object', 1, 'manifest'],
    ['array', [], 'manifest'],
    ['unknown field', { ...valid, eval: true }, 'eval: unknown field'],
    ['bad id', { ...valid, id: 'counter' }, 'id:'],
    ['bad version', { ...valid, version: '1' }, 'version:'],
    ['bad name', { ...valid, name: 3 }, 'name:'],
    ['javascript url', { ...valid, entry: { kind: 'iframe', url: 'javascript:alert(1)' } }, 'entry.url'],
    ['data url', { ...valid, entry: { kind: 'worker', url: 'data:text/javascript,1' } }, 'entry.url'],
    ['bad entry kind', { ...valid, entry: { kind: 'eval', url: 'x' } }, 'entry:'],
    ['entry not object', { ...valid, entry: 'x' }, 'entry:'],
    ['huge inline code', { ...valid, entry: { kind: 'iframe', code: 'x'.repeat(600 * 1024) } }, 'entry.code'],
    ['bad capability', { ...valid, capabilities: ['nope'] }, 'capabilities:'],
    ['bad events', { ...valid, events: 'x' }, 'events:'],
    ['bad permission', { ...valid, permissions: ['network'] }, 'permissions:'],
    ['unknown limit', { ...valid, limits: { cpu: 1 } }, 'limits.cpu'],
    ['negative limit', { ...valid, limits: { callTimeoutMs: -1 } }, 'limits.callTimeoutMs'],
    ['limits not object', { ...valid, limits: 3 }, 'limits:'],
  ])('rejects %s (SF-SBX-001)', (_name, input, issue) => {
    const result = validateManifest(input);
    expect(!result.ok && result.error.code).toBe('SF-SBX-001');
    expect(!result.ok && String(result.error.details['issues'])).toContain(issue);
  });

  it('definePluginManifest freezes; definePluginEvent is typed data', () => {
    const m = definePluginManifest({ ...valid, entry: { kind: 'iframe', url: './x.js' }, capabilities: [], events: [], permissions: [] });
    expect(Object.isFrozen(m)).toBe(true);
    expect(definePluginEvent('studio/selection').type<{ ids: string[] }>()).toEqual({ kind: 'plugin-event', id: 'studio/selection' });
  });
});

describe('isAllowedEntryUrl', () => {
  it.each([
    ['https://cdn.example/p.js', true],
    ['/plugins/p.js', true],
    ['./p.js', true],
    ['../p.js', true],
    ['blob:https://app.example/uuid', true],
    ['http://localhost:5173/p.js', true],
    ['http://evil.example/p.js', false],
    ['//evil.example/p.js', false],
    ['javascript:alert(1)', false],
    ['data:text/javascript,1', false],
    ['p.js', false],
    ['', false],
  ])('%s → %s', (url, expected) => {
    expect(isAllowedEntryUrl(url)).toBe(expected);
  });
});

describe('effectiveLimits', () => {
  it('uses the ceiling by default and clamps requests to it', () => {
    const m = validateManifest(valid);
    if (!m.ok) throw m.error;
    expect(effectiveLimits(m.value)).toEqual({ ...DEFAULT_PLUGIN_LIMITS, callTimeoutMs: 500 });
    expect(effectiveLimits({ ...m.value, limits: { callTimeoutMs: 1e9 } }).callTimeoutMs).toBe(DEFAULT_PLUGIN_LIMITS.callTimeoutMs);
    const { limits: _omit, ...withoutLimits } = m.value;
    expect(effectiveLimits(withoutLimits)).toEqual(DEFAULT_PLUGIN_LIMITS);
  });
});

describe('estimateBytes', () => {
  it('estimates strings, numbers, binary, maps, sets and nesting', () => {
    expect(estimateBytes('abc')).toBe(6);
    expect(estimateBytes(1)).toBe(8);
    expect(estimateBytes(null)).toBe(1);
    expect(estimateBytes(true)).toBe(1);
    expect(estimateBytes(undefined)).toBe(1);
    expect(estimateBytes(10n)).toBe(8);
    expect(estimateBytes(new ArrayBuffer(100))).toBe(100);
    expect(estimateBytes(new Uint8Array(50))).toBe(50);
    expect(estimateBytes(new Map([['a', 1]]))).toBe(10);
    expect(estimateBytes(new Set(['ab']))).toBe(4);
    expect(estimateBytes([1, 2])).toBe(24);
    expect(estimateBytes({ ab: 'c' })).toBe(6);
    const shared = { x: 1 };
    expect(estimateBytes([shared, shared])).toBe(8 + 2 + 8);
  });

  it('stops early above the budget and treats very deep values as oversized', () => {
    expect(estimateBytes('x'.repeat(1000), 10)).toBeGreaterThan(10);
    expect(estimateBytes(['x'.repeat(100), 'y'.repeat(1e6)], 10)).toBeLessThan(1000);
    let deep: unknown = 1;
    for (let i = 0; i < 100; i += 1) deep = [deep];
    expect(estimateBytes(deep, 1e6)).toBeGreaterThan(1e6);
    expect(estimateBytes(new Map([['k', 'x'.repeat(100)]]), 10)).toBeGreaterThan(10);
    expect(estimateBytes(new Set(['x'.repeat(100)]), 10)).toBeGreaterThan(10);
    expect(estimateBytes({ a: 'x'.repeat(100) }, 10)).toBeGreaterThan(10);
    expect(estimateBytes(() => undefined)).toBe(8);
  });
});

describe('createRateLimiter', () => {
  it('is a token bucket that refills over time', () => {
    let now = 0;
    const limiter = createRateLimiter(2, () => now);
    expect(limiter.available).toBe(2);
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
    now = 500;
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
    now = 10_000;
    expect(limiter.available).toBe(2);
    expect(ok(limiter.take())).toEqual(ok(true));
  });
});
