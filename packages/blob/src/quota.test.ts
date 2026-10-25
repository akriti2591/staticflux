import { describe, expect, it } from 'vitest';
import { checkQuota, detectStorageManager, estimateStorage, requestPersistence, type StorageManagerLike } from './quota.js';

const code = (r: { ok: boolean; error?: { code: string } }): string => (r.ok ? 'ok' : (r.error?.code ?? '?'));

describe('requestPersistence', () => {
  it('asks only when not yet persisted', async () => {
    let asked = 0;
    const storage: StorageManagerLike = { persisted: async () => false, persist: async () => (asked++, true) };
    expect(await requestPersistence(storage)).toEqual({ ok: true, value: { persisted: true, requested: true } });
    expect(await requestPersistence({ ...storage, persisted: async () => true })).toEqual({ ok: true, value: { persisted: true, requested: false } });
    expect(asked).toBe(1);
  });

  it('reports a denial, a missing API and a throwing API', async () => {
    expect(await requestPersistence({ persist: async () => false })).toEqual({ ok: true, value: { persisted: false, requested: true } });
    expect(code(await requestPersistence({}))).toBe('SF-BLOB-009');
    expect(code(await requestPersistence({ persist: () => Promise.reject(new DOMException('x', 'SecurityError')) }))).toBe('SF-BLOB-004');
  });
});

describe('estimateStorage', () => {
  it('derives available space and ratio', async () => {
    const facts = await estimateStorage({ estimate: async () => ({ usage: 25, quota: 100 }), persisted: async () => true });
    expect(facts).toEqual({ ok: true, value: { usage: 25, quota: 100, available: 75, ratio: 0.25, persisted: true } });
    expect(await estimateStorage({ estimate: async () => ({}) })).toEqual({ ok: true, value: { usage: 0, quota: 0, available: 0, ratio: 0, persisted: false } });
    expect(code(await estimateStorage({}))).toBe('SF-BLOB-009');
    expect(code(await estimateStorage({ estimate: () => Promise.reject(new Error('x')) }))).toBe('SF-BLOB-007');
  });
});

describe('checkQuota', () => {
  const facts = { usage: 0, quota: 1000, available: 1000, ratio: 0, persisted: false };

  it('passes while the reserve stays free and fails with SF-BLOB-001 otherwise', () => {
    expect(checkQuota(facts, 400, 100).ok).toBe(true);
    const over = checkQuota(facts, 950, 100);
    expect(code(over)).toBe('SF-BLOB-001');
    expect(checkQuota({ ...facts, quota: 0 }, 1e12).ok).toBe(true);
  });
});

describe('detectStorageManager', () => {
  it('returns navigator.storage when present', () => {
    const nav = globalThis.navigator as unknown as { storage?: unknown };
    const original = Object.getOwnPropertyDescriptor(nav, 'storage');
    const fake = { estimate: async () => ({}) };
    Object.defineProperty(nav, 'storage', { value: fake, configurable: true });
    expect(detectStorageManager()).toBe(fake);
    if (original === undefined) delete nav.storage;
    else Object.defineProperty(nav, 'storage', original);
  });
});
