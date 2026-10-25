// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RENDER_THRESHOLDS } from './compare.js';
import { createGoldenStore, GOLDEN_LIMITS, goldenUpdateRequested, UPDATE_GOLDENS_ENV } from './golden.js';
import { createImage, mapPixels, syntheticImage } from './image.js';
import { decodePng, encodePng } from './png.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-golden-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const rings = syntheticImage('rings', 32, 32, { cell: 3 });

describe('committed goldens', () => {
  it('matches the committed synthetic-rings golden (regenerate with `pnpm goldens:update golden.test`)', () => {
    const store = createGoldenStore({ dir: new URL('./__goldens__', import.meta.url) });
    const outcome = store.assert('synthetic-rings', rings);
    expect(outcome.status === 'match' || store.update).toBe(true);
    expect(statSync(store.path('synthetic-rings')).size).toBeLessThan(GOLDEN_LIMITS.maxBytes);
  });
});

describe('goldenUpdateRequested', () => {
  it('reads SF_UPDATE_GOLDENS', () => {
    expect(UPDATE_GOLDENS_ENV).toBe('SF_UPDATE_GOLDENS');
    expect(goldenUpdateRequested({})).toBe(false);
    expect(goldenUpdateRequested({ SF_UPDATE_GOLDENS: '0' })).toBe(false);
    expect(goldenUpdateRequested({ SF_UPDATE_GOLDENS: '1' })).toBe(true);
    expect(goldenUpdateRequested({ SF_UPDATE_GOLDENS: 'TRUE' })).toBe(true);
  });
});

describe('createGoldenStore', () => {
  it('fails on a missing golden outside update mode (CI never creates goldens)', () => {
    const store = createGoldenStore({ dir: tempDir(), update: false });
    const r = store.check('fresh', rings);
    expect(!r.ok && r.error.code).toBe('SF-TEST-008');
    expect(!r.ok && r.error.fix).toContain('pnpm goldens:update');
    expect(existsSync(store.path('fresh'))).toBe(false);
    expect(() => store.assert('fresh', rings)).toThrow(expect.objectContaining({ code: 'SF-TEST-008' }));
  });

  it('writes a missing golden in update mode, then matches it', () => {
    const dir = tempDir();
    const writer = createGoldenStore({ dir, update: true });
    expect(writer.check('rings', rings)).toMatchObject({ ok: true, value: { status: 'written', comparison: undefined } });
    const decoded = decodePng(new Uint8Array(readFileSync(join(dir, 'rings.png'))));
    expect(decoded.ok && decoded.value.data).toEqual(rings.data);
    const reader = createGoldenStore({ dir, update: false });
    const match = reader.check('rings', rings);
    expect(match.ok && match.value.status).toBe('match');
    expect(match.ok && match.value.comparison?.ssim).toBe(1);
    expect(reader.read('rings').ok).toBe(true);
  });

  it('reports a mismatch with actual and diff artifacts in __failures__', () => {
    const dir = tempDir();
    createGoldenStore({ dir, update: true }).assert('rings', rings);
    const changed = mapPixels(rings, (p, x, y) => (x > 20 && y > 20 ? [255, 0, 0, 255] : p));
    const r = createGoldenStore({ dir, update: false }).check('rings', changed);
    if (r.ok) throw new Error('expected a mismatch');
    expect(r.error.code).toBe('SF-TEST-009');
    expect(r.error.details['actual']).toBe(join(dir, '__failures__', 'rings.actual.png'));
    expect(existsSync(r.error.details['actual'] as string)).toBe(true);
    expect(existsSync(r.error.details['diff'] as string)).toBe(true);
    expect((r.error.details['failures'] as string[]).some((f) => f.startsWith('max channel delta'))).toBe(true);
  });

  it('update mode replaces a mismatching golden but leaves a matching one untouched', () => {
    const dir = tempDir();
    const store = createGoldenStore({ dir, update: true });
    store.assert('rings', rings);
    const before = readFileSync(store.path('rings'));
    writeFileSync(store.path('rings'), before); // same bytes; check below must not rewrite
    const mtime = statSync(store.path('rings')).mtimeMs;
    const nearly = mapPixels(rings, ([r, g, b, a], x, y) => [x === 0 && y === 0 ? r + 1 : r, g, b, a]);
    expect(store.check('rings', nearly)).toMatchObject({ ok: true, value: { status: 'match' } });
    expect(statSync(store.path('rings')).mtimeMs).toBe(mtime);
    const different = createImage(32, 32, [0, 0, 255, 255]);
    expect(store.check('rings', different)).toMatchObject({ ok: true, value: { status: 'updated' } });
    expect(readFileSync(store.path('rings'))).toEqual(Buffer.from(encodePng(different)));
  });

  it('treats a size change as a mismatch (or an update in update mode)', () => {
    const dir = tempDir();
    createGoldenStore({ dir, update: true }).assert('rings', rings);
    const bigger = syntheticImage('rings', 40, 32, { cell: 3 });
    const r = createGoldenStore({ dir, update: false }).check('rings', bigger);
    expect(!r.ok && r.error.code).toBe('SF-TEST-009');
    expect(!r.ok && r.error.details['failures']).toEqual(['size 40×32 ≠ golden 32×32']);
    expect(createGoldenStore({ dir, update: true }).check('rings', bigger)).toMatchObject({ ok: true, value: { status: 'updated' } });
  });

  it('uses the given thresholds (default sameBackend)', () => {
    const dir = tempDir();
    const store = createGoldenStore({ dir, update: false });
    createGoldenStore({ dir, update: true }).assert('rings', rings);
    const off3 = mapPixels(rings, ([r, g, b, a], x) => [x === 5 ? r - 3 : r, g, b, a]);
    expect(store.check('rings', off3).ok).toBe(false);
    expect(store.check('rings', off3, RENDER_THRESHOLDS.gpuVsCpu).ok).toBe(true);
    expect(createGoldenStore({ dir, update: false, thresholds: RENDER_THRESHOLDS.gpuVsCpu }).check('rings', off3).ok).toBe(true);
  });

  it('keeps goldens small and few: slug names, pixel and byte limits (SF-TEST-010)', () => {
    const store = createGoldenStore({ dir: tempDir(), update: true });
    for (const name of ['Bad', '../escape', 'a b', '', '-x']) expect(!store.check(name, rings).ok && store.check(name, rings)).toMatchObject({ error: { code: 'SF-TEST-010' } });
    const huge = createImage(257, 256);
    expect(store.check('huge', huge)).toMatchObject({ ok: false, error: { code: 'SF-TEST-010' } });
    const noisy = syntheticImage('noise', 128, 128);
    const tooBig = store.check('noisy', noisy);
    expect(!tooBig.ok && tooBig.error.code).toBe('SF-TEST-010');
    expect(!tooBig.ok && tooBig.error.message).toContain('limit 32768');
    expect(existsSync(store.path('noisy'))).toBe(false);
    expect(createGoldenStore({ dir: tempDir(), update: true, maxBytes: 100_000 }).check('noisy', noisy).ok).toBe(true);
  });

  it('accepts file URLs and a custom failure directory; reports corrupt goldens', () => {
    const dir = tempDir();
    const failures = join(dir, 'out');
    const store = createGoldenStore({ dir: pathToFileURL(dir), failureDir: pathToFileURL(failures), update: false });
    expect(store.dir).toBe(dir);
    writeFileSync(store.path('broken'), 'not a png');
    expect(store.check('broken', rings)).toMatchObject({ ok: false, error: { code: 'SF-TEST-007' } });
    createGoldenStore({ dir, update: true }).assert('rings', rings);
    const r = store.check('rings', createImage(32, 32, [9, 9, 9, 255]));
    expect(!r.ok && r.error.details['actual']).toBe(join(failures, 'rings.actual.png'));
    expect(store.check('rings', { width: 2, height: 2, data: new Uint8Array(1) })).toMatchObject({ ok: false, error: { code: 'SF-TEST-006' } });
  });
});
