import { describe, expect, it } from 'vitest';
import { type BundlerOutput, chunk, type ChunkDeclaration, createManifest, fromRollupBundle, parseManifest } from './index.js';

const output: BundlerOutput = {
  chunks: [
    { fileName: 'shell.aaaaaaaa.js', name: 'shell', moduleId: '/repo/src/shell/index.ts', imports: ['vendor.bbbbbbbb.js'], css: ['shell.css'], sizeKb: 10, integrity: 'sha384-s' },
    { fileName: 'vendor.bbbbbbbb.js', name: 'vendor', imports: [], sizeKb: 15 },
    { fileName: 'studio.cccccccc.js', name: 'studio', moduleId: 'C:\\repo\\src\\features\\studio\\index.ts', imports: ['vendor.bbbbbbbb.js', 'editor.dddddddd.js'], css: ['studio.css'], sizeKb: 40 },
    { fileName: 'editor.dddddddd.js', name: 'editor', imports: ['vendor.bbbbbbbb.js'], css: ['studio.css', 'editor.css'], sizeKb: 30 },
    { fileName: 'chat.eeeeeeee.js', name: 'chat', moduleId: '/repo/src/features/chat/index.ts', imports: [] },
  ],
};

const declarations: readonly ChunkDeclaration[] = [
  chunk('lib:shell', { entry: 'src/shell/index.ts', load: 'eager', reason: 'shell frame', tier: 'critical', budget: { category: 'lib' } }),
  chunk('feature:studio-desktop', { entry: './src/features/studio/index.ts', budget: { category: 'feature' }, deps: ['lib:shell'], profiles: ['web:expanded'] }),
  chunk('feature:agent-chat', { entry: 'chat', tier: 'likely', budget: { category: 'feature' } }),
];

describe('createManifest (build plugin helper)', () => {
  it('maps declarations to hashed files, css, deps, size, budgets and integrity', () => {
    const built = createManifest({ buildId: 'sha1', base: '/assets/', declarations, output });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { manifest, report } = built.value;
    expect(parseManifest(JSON.parse(JSON.stringify(manifest))).ok).toBe(true);
    expect(manifest.chunks['lib:shell']).toEqual({
      id: 'lib:shell',
      files: ['shell.aaaaaaaa.js', 'vendor.bbbbbbbb.js'],
      css: ['shell.css'],
      deps: [],
      tier: 'critical',
      load: 'eager',
      reason: 'shell frame',
      sizeKb: 25,
      budgetKb: 50,
      integrity: { 'shell.aaaaaaaa.js': 'sha384-s' },
    });
    const studio = manifest.chunks['feature:studio-desktop'];
    expect(studio?.files).toEqual(['studio.cccccccc.js', 'vendor.bbbbbbbb.js', 'editor.dddddddd.js']);
    expect(studio?.css).toEqual(['studio.css', 'editor.css']);
    expect(studio?.deps).toEqual(['lib:shell']);
    expect(studio?.profiles).toEqual(['web:expanded']);
    expect(studio?.sizeKb).toBe(85);
    expect(manifest.chunks['feature:agent-chat']?.sizeKb).toBeUndefined();
    expect(report.overBudget).toEqual([{ chunk: 'feature:studio-desktop', sizeKb: 85, budgetKb: 50 }]);
    expect(report.eager).toEqual([{ chunk: 'lib:shell', reason: 'shell frame', sizeKb: 25, profiles: undefined }]);
    expect(report.eagerTotalKb).toBe(25);
  });

  it('records federated remotes without local files', () => {
    const built = createManifest({
      buildId: 'b',
      base: '/',
      declarations: [chunk('remote:inspector', {})],
      output: { chunks: [] },
      remotes: { 'remote:inspector': { entry: 'https://team.example/remoteEntry.js', module: './Inspector', shared: { mobx: '^7.0.0' } } },
    });
    expect(built.ok && built.value.manifest.chunks['remote:inspector']).toMatchObject({
      files: ['https://team.example/remoteEntry.js'],
      remote: { module: './Inspector' },
    });
  });

  it('fails with typed errors: eager without reason, unknown entry, undeclared dep', () => {
    const noReason = { ...chunk('lib:x', { entry: 'shell' }), load: 'eager', reason: ' ' } as ChunkDeclaration;
    const a = createManifest({ buildId: 'b', base: '/', declarations: [noReason], output });
    expect(!a.ok && a.error.code).toBe('SF-LOAD-006');
    const b = createManifest({ buildId: 'b', base: '/', declarations: [chunk('lib:missing', { entry: 'src/nowhere.ts' })], output });
    expect(!b.ok && b.error.code).toBe('SF-LOAD-010');
    const c = createManifest({ buildId: 'b', base: '/', declarations: [chunk('lib:y', { entry: 'shell', deps: ['lib:z'] })], output });
    expect(!c.ok && c.error.code).toBe('SF-LOAD-010');
  });

  it('fromRollupBundle adapts Rollup/Vite output (assets skipped, css, size and integrity measured)', () => {
    const adapted = fromRollupBundle(
      {
        'a.js': { type: 'chunk', fileName: 'a.js', name: 'a', facadeModuleId: '/src/a.ts', imports: ['b.js'], code: 'xxxx', viteMetadata: { importedCss: new Set(['a.css']) } },
        'b.js': { type: 'chunk', fileName: 'b.js', name: 'b', facadeModuleId: null, code: 'yy' },
        'a.css': { type: 'asset', fileName: 'a.css' },
      },
      { sizeOf: (_f, code) => code.length, integrityOf: (f) => `sha-${f}` },
    );
    expect(adapted.chunks).toEqual([
      { fileName: 'a.js', name: 'a', moduleId: '/src/a.ts', imports: ['b.js'], css: ['a.css'], sizeKb: 4, integrity: 'sha-a.js' },
      { fileName: 'b.js', name: 'b', imports: [], sizeKb: 2, integrity: 'sha-b.js' },
    ]);
    const plain = fromRollupBundle({ 'c.js': { type: 'chunk', fileName: 'c.js' } });
    expect(plain.chunks).toEqual([{ fileName: 'c.js', imports: [] }]);
  });
});
