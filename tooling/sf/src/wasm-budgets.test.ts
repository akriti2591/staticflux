// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { analyzeWasmBudgets, compressedSize, measureWasmBudgets, parseWasmBudgetConfig, type WasmBudgetCheck } from './wasm-budgets.js';
import { captureIo, type TempDir, tempDir } from './test-helpers.js';

let dirs: TempDir[] = [];
afterEach(() => {
  for (const d of dirs) d.dispose();
  dirs = [];
});
function fixture(): TempDir {
  const d = tempDir();
  dirs.push(d);
  return d;
}

/** Incompressible bytes, so brotli size ≈ raw size and limits are easy to reason about. */
function writeWasm(d: TempDir, path: string, size: number): void {
  d.write(path, '');
  writeFileSync(join(d.root, path), randomBytes(size));
}

describe('compressedSize', () => {
  it('measures brotli (q11), gzip (level 9) and raw sizes', () => {
    const bytes = new TextEncoder().encode('wasm '.repeat(2000));
    expect(compressedSize(bytes, 'none')).toBe(10_000);
    const br = compressedSize(bytes, 'brotli');
    const gz = compressedSize(bytes, 'gzip');
    expect(br).toBeGreaterThan(0);
    expect(br).toBeLessThan(gz);
    expect(gz).toBeLessThan(10_000);
    // Incompressible input stays about its raw size.
    const noise = randomBytes(4096);
    expect(compressedSize(noise, 'brotli')).toBeGreaterThanOrEqual(4096);
  });
});

describe('parseWasmBudgetConfig', () => {
  it('accepts size-limit-shaped checks with category, compression and ratchet', () => {
    const r = parseWasmBudgetConfig([{ name: 'r', category: 'render-wasm', path: 'a/*.wasm', limit: '300 KB', compression: 'brotli', ratchet: false }, { path: ['a', 'b'], limit: '1 KB' }]);
    expect(r.ok).toBe(true);
  });

  it('reports every problem', () => {
    const r = parseWasmBudgetConfig([{ path: 3, limit: 300, compression: 'zstd' }, null]);
    expect(r.ok).toBe(false);
    if (!r.ok) for (const part of ['[0].path', '[0].limit', '[0].compression', '[1] must be an object']) expect(r.error.message).toContain(part);
    expect(parseWasmBudgetConfig({}).ok).toBe(false);
    expect(parseWasmBudgetConfig([{ path: [], limit: '1 KB' }]).ok).toBe(false);
  });
});

describe('measureWasmBudgets / analyzeWasmBudgets', () => {
  const config: WasmBudgetCheck[] = [
    { name: 'render', category: 'render-wasm', path: 'dist/render.*.wasm', limit: '3 KB', ratchet: false },
    { name: 'authoring', category: 'authoring-wasm', path: 'dist/authoring.*.wasm', limit: '1 KB' },
    { name: 'raw both', path: ['dist/render.*.wasm', 'dist/authoring.*.wasm'], compression: 'none', limit: '10 KB' },
    { name: 'export', category: 'export-wasm', path: 'dist/export.*.wasm', limit: '400 KB' },
  ];

  it('measures globbed files by brotli by default, sums several files, and marks missing artifacts', () => {
    const d = fixture();
    writeWasm(d, 'dist/render.0123456789abcdef.wasm', 2000);
    writeWasm(d, 'dist/authoring.0123456789abcdef.wasm', 1500);
    const m = measureWasmBudgets(config, d.root);
    expect(m[0]?.files).toEqual(['dist/render.0123456789abcdef.wasm']);
    expect(m[0]?.size).toBe(compressedSize(readFileSync(join(d.root, 'dist/render.0123456789abcdef.wasm')), 'brotli'));
    expect(m[2]?.size).toBe(3500);
    expect(m[3]).toEqual({ name: 'export', files: [], size: undefined });
  });

  it('flags over-budget checks, keeps categories, and does not ratchet `ratchet: false` ceilings', () => {
    const d = fixture();
    writeWasm(d, 'dist/render.aaaaaaaaaaaaaaaa.wasm', 200); // far below 3 KB, but ratchet: false
    writeWasm(d, 'dist/authoring.aaaaaaaaaaaaaaaa.wasm', 1500); // over 1 KB
    const report = analyzeWasmBudgets(config, d.root);
    const byName = new Map(report.rows.map((r) => [r.name, r]));
    expect(byName.get('render')).toMatchObject({ status: 'ok', category: 'render-wasm' });
    expect(byName.get('authoring')).toMatchObject({ status: 'over', category: 'authoring-wasm' });
    expect(byName.get('raw both')?.status).toBe('ratchet');
    expect(byName.get('raw both')?.category).toBeUndefined();
    expect(byName.get('export')?.status).toBe('no-result');
    expect(report.overCount).toBe(1);
    expect(report.missing).toEqual(['export']);
  });
});

describe('sf wasm size (CLI)', () => {
  const write = (d: TempDir, checks: unknown): void => void d.write('.size-limit.wasm.json', JSON.stringify(checks));

  it('prints a category table; exit 1 when over budget', async () => {
    const d = fixture();
    write(d, [{ name: 'render', category: 'render-wasm', path: 'dist/render.*.wasm', limit: '1 KB' }]);
    writeWasm(d, 'dist/render.aaaaaaaaaaaaaaaa.wasm', 500);
    const io = captureIo(d.root, { env: {} });
    expect(await runCli(['wasm', 'size'], io)).toBe(0);
    expect(io.out[0]).toMatch(/^category\s+check/);
    expect(io.out[0]).toContain('render-wasm');
    writeWasm(d, 'dist/render.aaaaaaaaaaaaaaaa.wasm', 1500);
    expect(await runCli(['wasm', 'size', '--json'], captureIo(d.root, { env: {} }))).toBe(1);
  });

  it('warns about missing artifacts locally and fails with SF_REQUIRE_RUST', async () => {
    const d = fixture();
    write(d, [{ name: 'render', path: 'dist/render.*.wasm', limit: '1 KB' }]);
    const local = captureIo(d.root, { env: {} });
    expect(await runCli(['wasm', 'size'], local)).toBe(0);
    expect(local.errs.join('\n')).toContain('warning: not measured');
    const ci = captureIo(d.root, { env: { SF_REQUIRE_RUST: '1' } });
    expect(await runCli(['wasm', 'size'], ci)).toBe(1);
    expect(ci.errs.join('\n')).toContain('SF-TOOL-010');
    expect(await runCli(['wasm', 'size', '--require-rust'], captureIo(d.root, { env: {} }))).toBe(1);
  });

  it('--write tightens ratchetable budgets only; bad input exits 2', async () => {
    const d = fixture();
    write(d, [
      { name: 'a', path: 'dist/a.wasm', compression: 'none', limit: '10 KB' },
      { name: 'b', path: 'dist/b.wasm', compression: 'none', limit: '10 KB', ratchet: false },
    ]);
    writeWasm(d, 'dist/a.wasm', 1000);
    writeWasm(d, 'dist/b.wasm', 1000);
    expect(await runCli(['wasm', 'size', '--write'], captureIo(d.root, { env: {} }))).toBe(0);
    const after = JSON.parse(readFileSync(join(d.root, '.size-limit.wasm.json'), 'utf8')) as { limit: string }[];
    expect(after.map((c) => c.limit)).toEqual(['1.1 KB', '10 KB']);
    expect(await runCli(['wasm', 'size', '--threshold', 'x'], captureIo(d.root))).toBe(2);
    expect(await runCli(['wasm', 'size', '--config', 'missing.json'], captureIo(d.root))).toBe(2);
    expect(await runCli(['wasm'], captureIo(d.root))).toBe(2);
  });

  it('the repo config covers render (300 KB) and authoring (350 KB) Wasm by brotli (IF-15.1)', () => {
    const json = JSON.parse(readFileSync(new URL('../../../.size-limit.wasm.json', import.meta.url), 'utf8')) as WasmBudgetCheck[];
    expect(parseWasmBudgetConfig(json).ok).toBe(true);
    expect(json.map((c) => [c.category, c.limit, c.compression])).toEqual([
      ['render-wasm', '300 KB', 'brotli'],
      ['authoring-wasm', '350 KB', 'brotli'],
    ]);
  });
});
