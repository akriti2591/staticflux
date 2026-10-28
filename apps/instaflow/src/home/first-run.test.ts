import { describe, expect, it } from 'vitest';
import { FIRST_RUN_KEY, formatBytes, markFirstRunSeen, readFirstRun, readStorageFacts, requestPersistence, resetFirstRun } from './first-run.js';
import { createPreviewSource, PREVIEW_MAX_BYTES } from './previews.js';
import type { HomeEntry } from './index-record.js';

const memory = (): Storage => {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k), clear: () => map.clear(), key: () => null, length: 0 } as Storage;
};

describe('first run (HOME-FILES §1.4)', () => {
  it('is unseen until answered or dismissed; Reset hints forgets it; unreadable storage never nags', () => {
    const storage = memory();
    expect(readFirstRun(storage)).toEqual({ seen: false });
    markFirstRunSeen(storage);
    expect(storage.getItem(FIRST_RUN_KEY)).toBe('seen');
    expect(readFirstRun(storage)).toEqual({ seen: true });
    resetFirstRun(storage);
    expect(readFirstRun(storage)).toEqual({ seen: false });
    expect(readFirstRun({ getItem: () => { throw new Error('blocked'); } })).toEqual({ seen: true });
    markFirstRunSeen({ setItem: () => { throw new Error('blocked'); } });
    resetFirstRun({ removeItem: () => { throw new Error('blocked'); } });
  });

  it('reads storage facts tolerantly and asks for persistence (false when refused or missing)', async () => {
    expect(await readStorageFacts({ estimate: async () => ({ usage: 5, quota: 9 }), persisted: async () => true })).toEqual({ usage: 5, quota: 9, persisted: true });
    expect(await readStorageFacts({ estimate: () => Promise.reject(new Error('x')) })).toEqual({ usage: undefined, quota: undefined, persisted: undefined });
    expect(await readStorageFacts(undefined)).toEqual({ usage: undefined, quota: undefined, persisted: undefined });
    expect(await requestPersistence({ persist: async () => true })).toBe(true);
    expect(await requestPersistence({ persist: async () => false })).toBe(false);
    expect(await requestPersistence({ persist: () => Promise.reject(new Error('x')) })).toBe(false);
    expect(await requestPersistence(undefined)).toBe(false);
  });

  it('formats bytes in decimal units', () => {
    expect(formatBytes(1_234_567_890, 'en-GB')).toBe('1.2 GB');
    expect(formatBytes(4_500_000, 'en-GB')).toBe('4.5 MB');
    expect(formatBytes(2_400, 'en-GB')).toBe('2 KB');
    expect(formatBytes(12, 'en-GB')).toBe('12 B');
  });
});

describe('media previews', () => {
  const image: HomeEntry = { asset: 'as_i', kind: 'image', title: 'Lamp', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-01T00:00:00.000Z', lens: 'pixel', mime: 'image/png', size: 3, digest: 'sha256:aa' };

  it('reads an image once by digest, makes one URL, revokes it with the signal; skips what it cannot show', async () => {
    let opened = 0;
    const reads: string[] = [];
    const revoked: string[] = [];
    const controller = new AbortController();
    const source = createPreviewSource({
      open: async () => {
        opened += 1;
        return { get: async (d: unknown) => (reads.push(String(d)), { ok: true as const, value: new Uint8Array([1, 2, 3]) }) } as never;
      },
      urls: { create: () => `blob:${reads.length}`, revoke: (u) => void revoked.push(u) },
      signal: controller.signal,
    });
    expect(await source(image)).toBe('blob:1');
    expect(await source({ ...image, asset: 'as_same' })).toBe('blob:1');
    expect(opened).toBe(1);
    expect(reads).toEqual(['sha256:aa']);
    expect(await source({ ...image, mime: 'font/ttf' })).toBeUndefined();
    expect(await source({ ...image, digest: 'sha256:bb', size: PREVIEW_MAX_BYTES + 1 })).toBeUndefined();
    const { digest: _digest, ...noDigest } = image;
    expect(await source(noDigest)).toBeUndefined();
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(revoked).toEqual(['blob:1']);
    expect(await source({ ...image, digest: 'sha256:cc' })).toBeUndefined();
  });

  it('#64: a design shows its cover (by the cover digest, as an image), a newer cover is read again', async () => {
    const reads: string[] = [];
    const types: string[] = [];
    const source = createPreviewSource({
      open: async () => ({ get: async (d: unknown) => (reads.push(String(d)), { ok: true as const, value: new Uint8Array([137, 80, 78, 71]) }) }) as never,
      urls: { create: (b) => (types.push(b.type), `blob:${reads.length}`), revoke: () => undefined },
      signal: new AbortController().signal,
    });
    const design: HomeEntry = { asset: 'as_d', kind: 'composition', title: 'Flyer', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-01T00:00:00.000Z', lens: 'layout', cover: 'sha256:c1' };
    expect(await source(design)).toBe('blob:1');
    expect(await source({ ...design, cover: 'sha256:c2' })).toBe('blob:2');
    expect(reads).toEqual(['sha256:c1', 'sha256:c2']);
    expect(types).toEqual(['image/png', 'image/png']);
    const { cover: _cover, ...plain } = design;
    expect(await source(plain)).toBeUndefined();
  });

  it('a failed read shows no preview', async () => {
    const source = createPreviewSource({ open: async () => ({ get: async () => ({ ok: false, error: new Error('gone') }) }) as never, signal: new AbortController().signal });
    expect(await source({ ...image, digest: 'sha256:dd' })).toBeUndefined();
  });
});
