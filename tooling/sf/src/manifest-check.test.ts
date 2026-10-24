// @vitest-environment node
import { chunk, createManifest } from '@staticflux/loader';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { checkManifest, formatManifestText, MANIFEST_ISSUES } from './manifest-check.js';
import { captureIo, type TempDir, tempDir } from './test-helpers.js';

// A real manifest from the loader's builder: the structural checks must accept it.
function realManifest(): unknown {
  const built = createManifest({
    buildId: 'b1',
    base: '/assets/',
    declarations: [
      chunk('lib:shell', { entry: 'shell', tier: 'critical', load: 'eager', reason: 'shell frame', budget: { maxKb: 20 } }),
      chunk('feature:studio', { entry: 'studio', deps: ['lib:shell'], budget: { category: 'feature' }, profiles: ['web:expanded'] }),
      chunk('feature:remote', { tier: 'on-demand', budget: { category: 'feature' } }),
    ],
    output: {
      chunks: [
        { fileName: 'shell-aaaaaaaa.js', name: 'shell', imports: [], sizeKb: 12, integrity: 'sha384-x' },
        { fileName: 'studio-bbbbbbbb.js', name: 'studio', imports: [], css: ['studio.css'], sizeKb: 30 },
      ],
    },
    remotes: { 'feature:remote': { entry: 'https://cdn/remoteEntry.js', module: './Panel', shared: { lit: '^3.0.0' } } },
  });
  if (!built.ok) throw built.error;
  return JSON.parse(JSON.stringify(built.value.manifest)) as unknown;
}

type Mutable = { chunks: Record<string, Record<string, unknown>> } & Record<string, unknown>;

describe('checkManifest', () => {
  it('accepts a loader-built manifest', () => {
    const result = checkManifest(realManifest());
    expect(result.errorCount).toBe(0);
    expect(result.buildId).toBe('b1');
    expect(result.eagerTotalKb).toBe(12);
    expect(result.chunks.map((c) => c.id)).toEqual(['lib:shell', 'feature:studio', 'feature:remote']);
    expect(result.issues).toEqual([]);
  });

  it('collects every schema problem instead of stopping at the first', () => {
    const m = realManifest() as Mutable;
    m['format'] = 'sf-manifest/0';
    delete m['buildId'];
    m['base'] = 1;
    const shell = m.chunks['lib:shell'] as Record<string, unknown>;
    shell['id'] = 'lib:other';
    shell['files'] = [];
    shell['css'] = 'x';
    shell['tier'] = 'hot';
    shell['load'] = 'sometimes';
    shell['sizeKb'] = 'big';
    shell['profiles'] = 'web';
    shell['integrity'] = { a: 1 };
    m.chunks['feature:remote'] = { ...m.chunks['feature:remote'], remote: { entry: 1 } };
    m.chunks['bad key'] = 5 as unknown as Record<string, unknown>;
    m.chunks['nokind'] = { ...m.chunks['feature:studio'], id: 'nokind', deps: 'x' };
    const result = checkManifest(m);
    const codes = result.issues.map((i) => i.code);
    expect(codes.filter((c) => c === MANIFEST_ISSUES.format)).toHaveLength(1);
    expect(codes).toContain(MANIFEST_ISSUES.idMismatch);
    expect(codes).toContain(MANIFEST_ISSUES.remote);
    expect(codes.filter((c) => c === MANIFEST_ISSUES.shape).length).toBeGreaterThanOrEqual(10);
    expect(result.issues.some((i) => i.message.includes('"nokind" is not a `kind:name`'))).toBe(true);
    // the unparseable size leaves the budget unmeasured (info), everything else is an error
    expect(result.issues.filter((i) => i.severity !== 'error').map((i) => i.code)).toEqual([MANIFEST_ISSUES.unmeasured]);
    expect(result.errorCount).toBe(result.issues.length - 1);
  });

  it('reports dangling deps, cycles, budget overruns, eager without reason and unmeasured budgets', () => {
    const m = realManifest() as Mutable;
    (m.chunks['feature:studio'] as Record<string, unknown>)['deps'] = ['lib:shell', 'lib:ghost'];
    (m.chunks['lib:shell'] as Record<string, unknown>)['deps'] = ['feature:studio'];
    (m.chunks['lib:shell'] as Record<string, unknown>)['sizeKb'] = 25;
    delete (m.chunks['lib:shell'] as Record<string, unknown>)['reason'];
    m.chunks['lib:unmeasured'] = { id: 'lib:unmeasured', files: ['u.js'], css: [], deps: [], tier: 'likely', load: 'lazy', budgetKb: 10 };
    const result = checkManifest(m, { maxEagerKb: 20 });
    expect(result.issues.map((i) => [i.severity, i.code])).toEqual([
      ['error', MANIFEST_ISSUES.eagerReason],
      ['error', MANIFEST_ISSUES.danglingDep],
      ['error', MANIFEST_ISSUES.eagerBudget],
      // No build report: the full closure is only an upper bound of the budgeted cost.
      ['warning', MANIFEST_ISSUES.overBudget],
      ['warning', MANIFEST_ISSUES.cycle],
      ['info', MANIFEST_ISSUES.unmeasured],
    ]);
    expect(result.issues.find((i) => i.code === MANIFEST_ISSUES.overBudget)?.message).toContain('pass the build report');
    expect(result.issues.find((i) => i.code === MANIFEST_ISSUES.cycle)?.message).toBe('Dependency cycle: feature:studio → lib:shell → feature:studio.');
    expect(result.issues.find((i) => i.code === MANIFEST_ISSUES.danglingDep)?.message).toContain('"lib:ghost"');
  });

  it('regression: with the build report, chunk budgets apply to bytes beyond the boot set (not the shared closure)', () => {
    const m = realManifest() as Mutable;
    (m.chunks['feature:studio'] as Record<string, unknown>)['sizeKb'] = 80; // closure incl. boot/shared code
    const report = {
      format: 'sf-build-report/1',
      chunks: [
        { chunk: 'lib:shell', sizeKb: 12, incrementalKb: 12, budgetKb: 20 },
        { chunk: 'feature:studio', sizeKb: 80, incrementalKb: 18, budgetKb: 50 },
      ],
      boot: [{ profile: '*', bootKb: 140, eagerKb: 12 }],
    };
    const fine = checkManifest(m, { report, maxBootKb: 150 });
    expect(fine.issues).toEqual([]);
    expect(fine.boot).toEqual([{ profile: '*', bootKb: 140 }]);
    expect(fine.chunks.find((c) => c.id === 'feature:studio')?.incrementalKb).toBe(18);
    expect(formatManifestText(fine)).toContain('boot * 140 KB');

    const heavy = { ...report, chunks: [{ chunk: 'feature:studio', sizeKb: 80, incrementalKb: 51, budgetKb: 50 }] };
    const over = checkManifest(m, { report: heavy, maxBootKb: 120 });
    expect(over.issues.map((i) => [i.severity, i.code, i.message])).toEqual([
      ['error', MANIFEST_ISSUES.overBudget, 'Chunk "feature:studio" adds 51 KB gzip beyond the boot set, budget 50 KB.'],
      ['error', MANIFEST_ISSUES.bootBudget, 'Boot JS for profile "*" is 140 KB gzip, budget 120 KB (R12.7).'],
    ]);

    // A chunk missing from the report falls back to its closure, as an error (report given).
    const shellOver = realManifest() as Mutable;
    (shellOver.chunks['lib:shell'] as Record<string, unknown>)['sizeKb'] = 25;
    expect(checkManifest(shellOver, { report: { format: 'sf-build-report/1', chunks: [], boot: [] } }).issues.map((i) => [i.severity, i.code])).toEqual([
      ['error', MANIFEST_ISSUES.overBudget],
    ]);
    // A malformed report is an error; the check then falls back to closure warnings.
    expect(checkManifest(m, { report: { format: 'nope' } }).issues.map((i) => [i.severity, i.code])).toEqual([
      ['error', MANIFEST_ISSUES.report],
      ['warning', MANIFEST_ISSUES.overBudget],
    ]);
    expect(checkManifest(realManifest(), { maxBootKb: 1 }).issues.map((i) => [i.severity, i.code])).toEqual([['warning', MANIFEST_ISSUES.bootBudget]]);
  });

  it('rejects non-objects and missing chunks', () => {
    expect(checkManifest([]).issues[0]?.code).toBe(MANIFEST_ISSUES.format);
    expect(checkManifest(null).errorCount).toBe(1);
    const r = checkManifest({ format: 'sf-manifest/1', buildId: 'x', base: '/' });
    expect(r.issues.map((i) => i.message)).toEqual(['`chunks` must be an object keyed by logical chunk id.']);
  });

  it('formats a readable table', () => {
    const text = formatManifestText(checkManifest(realManifest()));
    expect(text).toContain('Manifest b1: 3 chunks · eager 12 KB · errors: 0');
    expect(text).toMatch(/feature:remote\s+on-demand\s+lazy\s+1\s+remote\s+-\s+50/);
    expect(text).toMatch(/lib:shell\s+critical\s+eager\s+1\s+12\s+-\s+20/);
    const bad = formatManifestText(checkManifest({ format: 'x' }));
    expect(bad).toContain('Manifest (no buildId)');
    expect(bad).toContain('ERRORS');
  });
});

describe('sf manifest', () => {
  let dir: TempDir | undefined;
  afterEach(() => dir?.dispose());

  it('exits 0 on a valid manifest, 1 on issues, 2 on usage/read errors', async () => {
    dir = tempDir();
    dir.write('ok.json', JSON.stringify(realManifest()));
    const over = realManifest() as Mutable;
    (over.chunks['feature:studio'] as Record<string, unknown>)['sizeKb'] = 99;
    dir.write('over.json', JSON.stringify(over));
    dir.write('broken.json', '{');
    const ok = captureIo(dir.root);
    expect(await runCli(['manifest', 'ok.json'], ok)).toBe(0);
    expect(ok.out.join('\n')).toContain('errors: 0');
    const eager = captureIo(dir.root);
    expect(await runCli(['manifest', 'ok.json', '--max-eager-kb', '10', '--json'], eager)).toBe(1);
    expect((JSON.parse(eager.out.join('')) as { issues: { code: string }[] }).issues.map((i) => i.code)).toEqual([MANIFEST_ISSUES.eagerBudget]);
    // Without a report the closure overrun is a warning (exit 0) …
    const closure = captureIo(dir.root);
    expect(await runCli(['manifest', 'over.json'], closure)).toBe(0);
    expect(closure.out.join('\n')).toContain('SF-MANIFEST-OVER-BUDGET');
    // … the report (explicit, or sf-build-report.json next to the manifest) decides.
    dir.write('heavy-report.json', JSON.stringify({ format: 'sf-build-report/1', chunks: [{ chunk: 'feature:studio', sizeKb: 99, incrementalKb: 60, budgetKb: 50 }], boot: [] }));
    const bad = captureIo(dir.root);
    expect(await runCli(['manifest', 'over.json', '--report', 'heavy-report.json'], bad)).toBe(1);
    expect(bad.out.join('\n')).toContain('adds 60 KB gzip beyond the boot set');
    dir.write('dist/sf-manifest.json', JSON.stringify(over));
    dir.write('dist/sf-build-report.json', JSON.stringify({ format: 'sf-build-report/1', chunks: [{ chunk: 'feature:studio', sizeKb: 99, incrementalKb: 9, budgetKb: 50 }], boot: [{ profile: '*', bootKb: 140, eagerKb: 12 }] }));
    const sibling = captureIo(dir.root);
    expect(await runCli(['manifest', 'dist/sf-manifest.json', '--max-boot-kb', '150'], sibling)).toBe(0);
    expect(sibling.out.join('\n')).toContain('boot * 140 KB');
    expect(await runCli(['manifest', 'dist/sf-manifest.json', '--max-boot-kb', '100'], captureIo(dir.root))).toBe(1);
    expect(await runCli(['manifest', 'dist/sf-manifest.json', '--no-report', '--max-boot-kb', '100'], captureIo(dir.root))).toBe(0);
    const usage = captureIo(dir.root);
    expect(await runCli(['manifest'], usage)).toBe(2);
    expect(await runCli(['manifest', 'missing.json'], usage)).toBe(2);
    expect(await runCli(['manifest', 'broken.json'], usage)).toBe(2);
    expect(await runCli(['manifest', 'ok.json', '--max-eager-kb=abc'], usage)).toBe(2);
    expect(usage.errs.join('\n')).toMatch(/SF-TOOL-005[\s\S]*SF-TOOL-003[\s\S]*SF-TOOL-004[\s\S]*SF-TOOL-005/);
  });
});
