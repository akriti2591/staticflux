// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { collectErrorCatalog, type ErrorCatalog, isErrorCatalogCurrent, serializeErrorCatalog, writeErrorCatalog } from './error-catalog.js';
import { captureIo, type TempDir, tempDir } from './test-helpers.js';

const def = (code: string, summary = `summary ${code}`): string =>
  `Object.assign(() => undefined, { code: '${code}', kind: 'validation', summary: '${summary}', fix: 'fix ${code}' })`;

let dir: TempDir;
afterEach(() => dir.dispose());

function repo(): TempDir {
  const d = tempDir({ importable: true });
  d.write('packages/alpha/dist/index.js', `export const A1 = ${def('SF-ALPHA-001')};\nexport const notAnError = { code: 'x' };\nexport const helper = () => 1;`);
  d.write('packages/beta/dist/index.js', `export const B1 = ${def('SF-BETA-001')};\nexport const B2 = ${def('SF-BETA-002')};`);
  return d;
}

describe('collectErrorCatalog', () => {
  it('collects exported definitions from packages/*/dist/index.js plus registered ones, sorted', async () => {
    dir = repo();
    const result = await collectErrorCatalog({ cwd: dir.root, listDefinitions: () => [{ code: 'SF-AAA-001', kind: 'network', summary: 's', fix: 'f' }] });
    expect(result.loaded).toHaveLength(2);
    expect(result.catalog.errors.map((e) => e.code)).toEqual(['SF-AAA-001', 'SF-ALPHA-001', 'SF-BETA-001', 'SF-BETA-002']);
    expect(result.catalog.errors[1]).toEqual({ code: 'SF-ALPHA-001', kind: 'validation', summary: 'summary SF-ALPHA-001', fix: 'fix SF-ALPHA-001' });
    expect(result.failures).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("uses core's listErrorDefinitions by default (includes sf's own codes)", async () => {
    dir = repo();
    const result = await collectErrorCatalog({ cwd: dir.root, modules: ['packages/alpha/dist/index.js'] });
    const codes = result.catalog.errors.map((e) => e.code);
    expect(codes).toContain('SF-TOOL-001');
    expect(codes).toContain('SF-CORE-000');
    expect(codes).toContain('SF-ALPHA-001');
  });

  it('dedupes identical definitions and reports conflicting ones', async () => {
    dir = repo();
    dir.write('dup.mjs', `export const same = ${def('SF-BETA-001')};\nexport const clash = ${def('SF-BETA-002', 'different')};`);
    const result = await collectErrorCatalog({ cwd: dir.root, modules: ['packages/*/dist/index.js', 'dup.mjs'], listDefinitions: () => [] });
    expect(result.catalog.errors.filter((e) => e.code === 'SF-BETA-001')).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.code).toBe('SF-TOOL-006');
    expect(result.conflicts[0]?.message).toContain('SF-BETA-002');
  });

  it('records import failures without aborting', async () => {
    dir = repo();
    dir.write('packages/gamma/dist/index.js', "throw new Error('needs a browser');");
    const result = await collectErrorCatalog({ cwd: dir.root, listDefinitions: () => [] });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe('SF-TOOL-001');
    expect(result.failures[0]?.message).toContain('needs a browser');
    expect(result.catalog.errors).toHaveLength(3);
  });

  it('uses an injected importer', async () => {
    dir = tempDir();
    dir.write('virtual.js', '');
    const result = await collectErrorCatalog({
      cwd: dir.root,
      modules: ['virtual.js'],
      listDefinitions: () => [],
      importer: async () => ({ X: { code: 'SF-V-001', kind: 'auth', summary: 's', fix: 'f' } }),
    });
    expect(result.catalog.errors.map((e) => e.code)).toEqual(['SF-V-001']);
  });
});

describe('writing and checking', () => {
  const catalog: ErrorCatalog = { version: 1, description: 'd', errors: [{ code: 'SF-X-001', kind: 'unknown', summary: 's', fix: 'f' }] };

  it('writes deterministic JSON, reports unchanged on rewrite, and checks staleness', () => {
    dir = tempDir();
    const path = join(dir.root, 'docs', 'errors.json');
    expect(isErrorCatalogCurrent(path, catalog)).toBe(false);
    expect(writeErrorCatalog(path, catalog)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(serializeErrorCatalog(catalog));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(catalog);
    expect(writeErrorCatalog(path, catalog)).toBe(false);
    expect(isErrorCatalogCurrent(path, catalog)).toBe(true);
    writeFileSync(path, '{}');
    expect(isErrorCatalogCurrent(path, catalog)).toBe(false);
  });
});

describe('sf errors', () => {
  it('writes docs/errors.json by default', async () => {
    dir = repo();
    const io = captureIo(dir.root);
    expect(await runCli(['errors'], io)).toBe(0);
    const written = JSON.parse(readFileSync(join(dir.root, 'docs/errors.json'), 'utf8')) as ErrorCatalog;
    expect(written.errors.map((e) => e.code)).toContain('SF-BETA-002');
    expect(written.errors.every((e) => typeof e.fix === 'string' && typeof e.kind === 'string')).toBe(true);
    expect(io.out[0]).toContain('Wrote');
  });

  it('--check fails when stale and passes after writing; --out and --json work', async () => {
    dir = repo();
    const io = captureIo(dir.root);
    expect(await runCli(['errors', '--check', '--out', 'out/e.json'], io)).toBe(1);
    expect(existsSync(join(dir.root, 'out/e.json'))).toBe(false);
    expect(await runCli(['errors', '--out=out/e.json'], io)).toBe(0);
    expect(await runCli(['errors', '--check', '--out', 'out/e.json'], io)).toBe(0);
    const json = captureIo(dir.root);
    expect(await runCli(['errors', '--json'], json)).toBe(0);
    expect((JSON.parse(json.out.join('')) as ErrorCatalog).version).toBe(1);
  });

  it('import failures are warnings unless --strict', async () => {
    dir = repo();
    dir.write('packages/gamma/dist/index.js', "throw new Error('boom');");
    const io = captureIo(dir.root);
    expect(await runCli(['errors'], io)).toBe(0);
    expect(io.errs.join('\n')).toContain('warning: SF-TOOL-001');
    expect(await runCli(['errors', '--strict'], io)).toBe(1);
  });

  it('conflicts fail the command', async () => {
    dir = repo();
    dir.write('dup.mjs', `export const clash = ${def('SF-BETA-002', 'different')};`);
    const io = captureIo(dir.root);
    expect(await runCli(['errors', 'packages/*/dist/index.js', 'dup.mjs'], io)).toBe(1);
    expect(io.errs.join('\n')).toContain('SF-TOOL-006');
  });
});
