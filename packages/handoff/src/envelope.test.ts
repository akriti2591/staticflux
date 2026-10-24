import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createEnvelope, isEnvelope, parseEnvelope, validateWith } from './envelope.js';
import { defineHandoff, effectiveTtl, lifetimeKind } from './slot.js';
import { defineError } from '@staticflux/core';

interface DraftV2 {
  readonly title: string;
  readonly blocks: readonly string[];
}
const isDraft = (v: unknown): v is DraftV2 =>
  typeof v === 'object' && v !== null && typeof (v as DraftV2).title === 'string' && Array.isArray((v as DraftV2).blocks);

describe('snapshot envelope', () => {
  it('creates envelopes with optional expiry', () => {
    expect(createEnvelope({ key: 'studio/draft', version: 1, data: { a: 1 }, now: 1000 })).toEqual({
      v: 1,
      key: 'studio/draft',
      version: 1,
      createdAt: 1000,
      data: { a: 1 },
    });
    const withTtl = createEnvelope({ key: 'studio/draft', version: 1, data: null, now: 1000, ttlMs: 500 });
    expect(withTtl.expiresAt).toBe(1500);
    expect(isEnvelope(withTtl)).toBe(true);
  });

  it('rejects malformed values', () => {
    for (const bad of [null, 'x', 1, {}, { v: 2, key: 'a/b', version: 1, createdAt: 0, data: 1 }, { v: 1, key: 'a/b', version: 1.5, createdAt: 0, data: 1 }, { v: 1, key: 'a/b', version: 1, createdAt: 0 }, { v: 1, key: 'a/b', version: 1, createdAt: 0, expiresAt: 'x', data: 1 }]) {
      expect(isEnvelope(bad)).toBe(false);
      const r = parseEnvelope(bad, { key: 'a/b', version: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SF-HANDOFF-001');
    }
  });

  it('checks key, expiry and newer versions', () => {
    const env = createEnvelope({ key: 'a/b', version: 2, data: 1, now: 0, ttlMs: 10 });
    const wrongKey = parseEnvelope(env, { key: 'a/c', version: 2 });
    expect(!wrongKey.ok && wrongKey.error.code).toBe('SF-HANDOFF-002');
    const expired = parseEnvelope(env, { key: 'a/b', version: 2, now: 10 });
    expect(!expired.ok && expired.error.code).toBe('SF-HANDOFF-004');
    expect(parseEnvelope(env, { key: 'a/b', version: 2, now: 9 }).ok).toBe(true);
    expect(parseEnvelope(env, { key: 'a/b', version: 2 }).ok).toBe(true); // no clock: no expiry check
    const newer = parseEnvelope(env, { key: 'a/b', version: 1 });
    expect(!newer.ok && newer.error.code).toBe('SF-HANDOFF-003');
  });

  it('migrates step by step and validates the result', () => {
    const v1 = createEnvelope({ key: 'studio/draft', version: 1, data: { text: 'hello' }, now: 0 });
    const migrations = {
      1: (d: unknown) => ({ title: (d as { text: string }).text, body: '' }),
      2: (d: unknown) => ({ title: (d as { title: string }).title, blocks: [] }),
    };
    const r = parseEnvelope<DraftV2>(v1, { key: 'studio/draft', version: 3, migrations, schema: isDraft });
    expect(r).toEqual(ok({ ...v1, version: 3, data: { title: 'hello', blocks: [] } }));
    const missing = parseEnvelope(v1, { key: 'studio/draft', version: 3, migrations: { 1: migrations[1] } });
    expect(!missing.ok && missing.error.message).toMatch(/No migration from version 2/);
    const throws = parseEnvelope(v1, {
      key: 'studio/draft',
      version: 2,
      migrations: {
        1: () => {
          throw new Error('boom');
        },
      },
    });
    expect(!throws.ok && throws.error.code).toBe('SF-HANDOFF-003');
    const invalid = parseEnvelope(v1, { key: 'studio/draft', version: 1, schema: isDraft });
    expect(!invalid.ok && invalid.error.code).toBe('SF-HANDOFF-005');
  });

  it('accepts Result-returning schemas', () => {
    const Bad = defineError('SF-TEST-HO1', 'validation', 'bad', 'fix');
    const schema = { parse: (v: unknown) => (typeof v === 'number' ? ok(v * 2) : err(Bad())) };
    expect(validateWith(schema, 2)).toEqual(ok(4));
    const r = validateWith(schema, 'x');
    expect(!r.ok && r.error.code).toBe('SF-HANDOFF-005');
    expect(validateWith(undefined, 'any')).toEqual(ok('any'));
  });
});

describe('slots', () => {
  it('validates declarations', () => {
    expect(() => defineHandoff({ key: 'a/b', version: 0, lifetime: 'one-shot', scope: 'tab' })).toThrow(/version/);
    expect(() => defineHandoff({ key: 'a/b', version: 1, lifetime: { ttlMs: 0 }, scope: 'tab' })).toThrow(/ttlMs/);
    const slot = defineHandoff<number>({ key: 'a/b', version: 1, lifetime: 'session', scope: 'memory', description: 'd' });
    expect(slot).toMatchObject({ kind: 'handoff-slot', key: 'a/b', schema: undefined, description: 'd' });
    expect(Object.isFrozen(slot)).toBe(true);
  });

  it('computes lifetime kinds and effective TTLs', () => {
    expect(lifetimeKind('one-shot')).toBe('one-shot');
    expect(lifetimeKind({ ttlMs: 5 })).toBe('ttl');
    const ttl = defineHandoff<number>({ key: 'a/b', version: 1, lifetime: { ttlMs: 1000 }, scope: 'tab', maxAgeMs: 500 });
    expect(effectiveTtl(ttl)).toBe(500);
    expect(effectiveTtl(ttl, 100)).toBe(100);
    const oneShot = defineHandoff<number>({ key: 'a/c', version: 1, lifetime: 'one-shot', scope: 'tab' });
    expect(effectiveTtl(oneShot)).toBeUndefined();
  });
});
