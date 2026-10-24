// @vitest-environment node
import { chunk, defineBootPlan, parseManifest, type ProfileLike, type SfManifest } from '@staticflux/loader';
import { describe, expect, it } from 'vitest';
import { assetText, type ChunkGroupLike, type CompilationLike, type CompilerLike, fromCompilation, normalizeRequest, resolveDeclarations, type SourceLike } from './compilation.js';
import type { AlterAssetTagsData, HtmlPluginLike } from './html.js';
import { preloadTags, referencedUrls } from './html.js';
import { chunkNameFor, gzipKb, sha384, staticfluxRspack, type StaticfluxRspackOptions, toBuildError, validateOptions } from './plugin.js';
import { RspackOptionsError } from './errors.js';

// ---------------------------------------------------------------- fakes

const groups: ChunkGroupLike[] = [
  {
    name: 'main',
    chunks: [{ name: 'vendors', files: ['js/vendors.11111111.js'] }, { name: 'main', files: ['js/main.22222222.js', 'css/main.33333333.css'] }],
    origins: [{ request: './src/main.ts' }],
  },
  { name: 'lib.shell', chunks: [{ name: 'lib.shell', files: new Set(['js/lib.shell.44444444.js']) }], origins: [{ request: './src/shell.ts' }] },
  {
    name: 'feature.studio',
    chunks: [{ name: null, files: ['js/split.55555555.js'] }, { name: 'feature.studio', files: ['js/feature.studio.66666666.js'], auxiliaryFiles: ['css/studio.77777777.css'] }],
    origins: [{ request: './features/studio' }],
  },
  { name: null, chunks: [{ name: null, files: ['js/88888888.js'] }], origins: [{ request: './features/compact' }, { request: null }] },
  { name: 'css-only', chunks: [{ name: 'css-only', files: ['css/only.css'] }] },
];

const sizes: Record<string, number> = {
  'js/vendors.11111111.js': 30,
  'js/main.22222222.js': 5,
  'js/lib.shell.44444444.js': 10,
  'js/split.55555555.js': 20,
  'js/feature.studio.66666666.js': 40,
  'js/88888888.js': 15,
};

class FakeRawSource implements SourceLike {
  constructor(readonly text: string) {}
  source(): string {
    return this.text;
  }
  size(): number {
    return this.text.length;
  }
}

interface Run {
  readonly compilation: CompilationLike;
  readonly emitted: Map<string, SourceLike>;
  readonly errors: Error[];
  readonly warnings: Error[];
  readonly stage: number | undefined;
}

function fakeCompiler(options: { publicPath?: unknown; webpack?: boolean; groups?: ChunkGroupLike[] } = {}): { compiler: CompilerLike; run(html?: AlterAssetTagsData): Promise<Run>; htmlPlugin: HtmlPluginLike } {
  const thisCompilation: ((c: CompilationLike) => void)[] = [];
  let htmlTap: ((data: AlterAssetTagsData) => Promise<AlterAssetTagsData>) | undefined;
  const compiler: CompilerLike = {
    hooks: { thisCompilation: { tap: (_name, fn) => thisCompilation.push(fn as (c: CompilationLike) => void) } },
    ...(options.webpack === false ? {} : { webpack: { sources: { RawSource: FakeRawSource }, Compilation: { PROCESS_ASSETS_STAGE_REPORT: 5000 } } }),
    options: { output: { publicPath: 'publicPath' in options ? options.publicPath : '/static/' }, context: '/repo' },
  };
  const htmlPlugin: HtmlPluginLike = {
    getCompilationHooks: () => ({ alterAssetTags: { tapPromise: (_name, fn) => (htmlTap = fn) } }),
  };
  return {
    compiler,
    htmlPlugin,
    async run(html) {
      const emitted = new Map<string, SourceLike>();
      const errors: Error[] = [];
      const warnings: Error[] = [];
      const processAssets: (() => void)[] = [];
      let stage: number | undefined;
      const compilation: CompilationLike = {
        hooks: {
          processAssets: {
            tap: (opts, fn) => {
              stage = typeof opts === 'string' ? undefined : opts.stage;
              processAssets.push(() => fn({}));
            },
          },
        },
        chunkGroups: options.groups ?? groups,
        getAsset: (name) => (name in sizes ? { name, source: new FakeRawSource('x'.repeat(sizes[name] ?? 0)) } : undefined),
        emitAsset: (name, source) => emitted.set(name, source),
        errors: { push: (...e) => errors.push(...e) },
        warnings: { push: (...e) => warnings.push(...e) },
      };
      for (const fn of thisCompilation) fn(compilation);
      if (html !== undefined && htmlTap !== undefined) await htmlTap(html);
      for (const fn of processAssets) fn();
      return { compilation, emitted, errors, warnings, stage };
    },
  };
}

const profiles: readonly ProfileLike[] = [
  { key: 'web:expanded', hostMode: 'web', formFactor: 'expanded' },
  { key: 'web:compact', hostMode: 'web', formFactor: 'compact' },
];

const chunks = [
  chunk('lib:shell', { tier: 'critical', load: 'eager', reason: 'shell frame', budget: { maxKb: 5 } }),
  chunk('feature:studio', { deps: ['lib:shell'], profiles: ['web:expanded'], budget: { category: 'feature' } }),
  chunk('feature:studio-compact', { entry: 'src/features/compact.ts', deps: ['lib:shell'], profiles: ['web:compact'] }),
];

const bootPlans = [
  defineBootPlan({ id: 'desktop', match: { formFactors: ['expanded'] }, critical: ['lib:shell'], preload: ['feature:studio'] }),
  defineBootPlan({ id: 'fallback', critical: ['lib:shell'], preload: ['feature:studio-compact'] }),
];

const sizeOf = (_f: string, code: string): number => code.length;

function plugin(extra: Partial<StaticfluxRspackOptions> = {}) {
  return staticfluxRspack({ chunks, bootPlans, profiles, sizeOf, buildId: 'b1', ...extra });
}

const read = (run: Run, name: string): unknown => {
  const source = run.emitted.get(name);
  if (source === undefined) throw new Error(`${name} not emitted`);
  return JSON.parse(String(source.source())) as unknown;
};

// ---------------------------------------------------------------- compilation adapter

describe('fromCompilation / resolveDeclarations', () => {
  it('turns chunk groups into bundler chunks (main chunk first, split chunks as imports, css collected)', () => {
    const out = fromCompilation({ chunkGroups: groups, getAsset: () => undefined });
    const byFile = new Map(out.chunks.map((c) => [c.fileName, c]));
    expect(byFile.get('js/main.22222222.js')).toMatchObject({ name: 'main', imports: ['js/vendors.11111111.js'], css: ['css/main.33333333.css'] });
    expect(byFile.get('js/feature.studio.66666666.js')).toMatchObject({ name: 'feature.studio', imports: ['js/split.55555555.js'], css: ['css/studio.77777777.css'] });
    expect(byFile.get('js/88888888.js')?.name).toBe('sf-group-3');
    expect(byFile.get('js/vendors.11111111.js')).toMatchObject({ imports: [] });
    expect(out.chunks.some((c) => c.fileName.endsWith('.css'))).toBe(false);
    expect([...out.requests]).toEqual([
      ['src/main', 'main'],
      ['src/shell', 'lib.shell'],
      ['features/studio', 'feature.studio'],
      ['features/compact', 'sf-group-3'],
    ]);
  });

  it('merges a chunk that is main in one group and shared in another', () => {
    const out = fromCompilation({
      chunkGroups: [
        { name: 'a', chunks: [{ name: 'a', files: ['a.js'] }] },
        { name: 'b', chunks: [{ name: 'a', files: ['a.js'] }, { name: 'b', files: ['b.js'] }] },
        { name: 'c', chunks: [{ name: 'x', files: ['x.js'] }, { name: 'a', files: ['a.js'] }] },
      ],
      getAsset: () => undefined,
    });
    expect(out.chunks.find((c) => c.fileName === 'b.js')?.imports).toEqual(['a.js']);
    // group c has no chunk named "c": its last JS chunk (a.js) is the main chunk; imports are unioned
    expect(out.chunks.find((c) => c.fileName === 'a.js')).toMatchObject({ name: 'a', imports: ['x.js'] });
  });

  it('measures sizes and integrity from assets (string, Uint8Array, ArrayBuffer)', () => {
    const enc = new TextEncoder();
    const getAsset = (name: string) =>
      name === 'a.js'
        ? { name, source: { source: () => 'abc', size: () => 3 } }
        : name === 'b.js'
          ? { name, source: { source: () => enc.encode('abcd'), size: () => 4 } }
          : name === 'c.js'
            ? { name, source: { source: () => enc.encode('abcde').buffer, size: () => 5 } }
            : undefined;
    expect(assetText({ getAsset }, 'b.js')).toBe('abcd');
    expect(assetText({ getAsset }, 'c.js')).toBe('abcde');
    expect(assetText({ getAsset }, 'missing.js')).toBe('');
    const out = fromCompilation(
      { chunkGroups: [{ name: 'a', chunks: [{ name: 'a', files: ['a.js'] }, { name: 'b', files: ['b.js'] }] }], getAsset },
      { sizeOf, integrityOf: (_f, code) => `h-${code}` },
    );
    expect(out.chunks.map((c) => [c.fileName, c.sizeKb, c.integrity])).toEqual([
      ['a.js', 3, 'h-abc'],
      ['b.js', 4, 'h-abcd'],
    ]);
  });

  it('normalizes requests and matches entries by longest request suffix, defaulting to the chunk name', () => {
    expect(normalizeRequest('../../features\\studio.tsx')).toBe('features/studio');
    const requests = new Map([
      ['studio', 'g1'],
      ['features/studio', 'g2'],
    ]);
    const decls = resolveDeclarations(
      [chunk('feature:a', { entry: 'src/features/studio.ts' }), chunk('feature:b'), chunk('feature:c', { entry: 'named-group' })],
      requests,
      chunkNameFor,
    );
    expect(decls.map((d) => d.entry)).toEqual(['g2', 'feature.b', 'named-group']);
    expect(chunkNameFor('locale:de/studio')).toBe('locale.de_studio');
  });
});

// ---------------------------------------------------------------- plugin

describe('staticfluxRspack()', () => {
  it('validates options', () => {
    expect(validateOptions({ chunks }).ok).toBe(true);
    for (const options of [
      { chunks: [chunk('lib:x'), chunk('lib:x')] },
      { chunks: [{ ...chunk('lib:x'), id: 'bad' as 'lib:x' }] },
      { chunks, bootPlans },
      { chunks, profiles, html: { plugin: fakeCompiler().htmlPlugin, profile: 'tv:big' } },
    ] satisfies StaticfluxRspackOptions[]) {
      const r = validateOptions(options);
      expect(!r.ok && r.error.code).toBe(RspackOptionsError.code);
    }
    expect(() => staticfluxRspack({ chunks, bootPlans })).toThrow(/profiles/);
  });

  it('emits manifest, preloads, precache and report at the REPORT stage', async () => {
    const { compiler, run } = fakeCompiler();
    plugin().apply(compiler);
    const result = await run();
    expect(result.stage).toBe(5000);
    expect(result.errors).toEqual([]);
    expect([...result.emitted.keys()]).toEqual(['sf-manifest.json', 'sf-preloads.json', 'sf-precache.json', 'sf-build-report.json']);
    const manifest = read(result, 'sf-manifest.json') as SfManifest;
    expect(parseManifest(manifest).ok).toBe(true);
    expect(manifest.base).toBe('/static/');
    expect(manifest.chunks['lib:shell']).toMatchObject({ files: ['js/lib.shell.44444444.js'], sizeKb: 10, budgetKb: 5, load: 'eager' });
    expect(manifest.chunks['feature:studio']).toMatchObject({ files: ['js/feature.studio.66666666.js', 'js/split.55555555.js'], css: ['css/studio.77777777.css'], sizeKb: 60 });
    expect(manifest.chunks['feature:studio-compact']?.files).toEqual(['js/88888888.js']);
    const preloads = read(result, 'sf-preloads.json') as Record<string, { plan: string; modulepreload: string[] }>;
    expect(preloads['web:compact']).toMatchObject({ plan: 'fallback', modulepreload: ['/static/js/lib.shell.44444444.js', '/static/js/88888888.js'] });
    expect(read(result, 'sf-precache.json')).toEqual([{ url: '/static/js/lib.shell.44444444.js', revision: null }]);
    expect((read(result, 'sf-build-report.json') as { boot: unknown[] }).boot).toEqual([
      { profile: 'web:expanded', plan: 'desktop', bootKb: 70, eagerKb: 10 },
      { profile: 'web:compact', plan: 'fallback', bootKb: 25, eagerKb: 10 },
    ]);
    // budget overrun of lib:shell is a warning by default
    expect(result.warnings.map((w) => w.message.split('\n')[0])).toEqual([
      'SF-RSPACK-002: Chunk "lib:shell" is 10 KB gzip, budget 5 KB.',
      'SF-RSPACK-002: Chunk "feature:studio" is 60 KB gzip, budget 50 KB.',
    ]);
    expect(result.warnings[0]?.message).toContain('\n  fix: Split or lazy-load');
  });

  it('turns violations into errors with onViolation: error and checks boot/eager budgets', async () => {
    const { compiler, run } = fakeCompiler();
    plugin({ budgets: { onViolation: 'error', bootKb: 50, eagerKb: 5 } }).apply(compiler);
    const result = await run();
    expect(result.warnings).toEqual([]);
    expect(result.errors.map((e) => e.message.split('\n')[0])).toEqual([
      'SF-RSPACK-002: Chunk "lib:shell" is 10 KB gzip, budget 5 KB.',
      'SF-RSPACK-002: Chunk "feature:studio" is 60 KB gzip, budget 50 KB.',
      'SF-RSPACK-002: Boot JS for profile "web:expanded" is 70 KB gzip, budget 50 KB.',
      'SF-RSPACK-002: Eager boot cost for profile "web:expanded" is 10 KB gzip, budget 5 KB.',
      'SF-RSPACK-002: Eager boot cost for profile "web:compact" is 10 KB gzip, budget 5 KB.',
    ]);
  });

  it('reports a manifest build failure as a compilation error and emits nothing', async () => {
    const { compiler, run } = fakeCompiler();
    plugin({ chunks: [...chunks, chunk('feature:ghost')] }).apply(compiler);
    const result = await run();
    expect(result.emitted.size).toBe(0);
    expect(result.errors[0]?.message).toMatch(/^SF-RSPACK-001: SF-LOAD-010: No bundler chunk matches entry "feature.ghost"/);
    expect((result.errors[0]?.cause as { code?: string }).code).toBe('SF-RSPACK-001');
  });

  it('derives base from publicPath (auto → /, override wins) and falls back to its own RawSource', async () => {
    const auto = fakeCompiler({ publicPath: 'auto', webpack: false });
    plugin({ precache: false, reportFileName: false, manifestFileName: 'm.json', preloadsFileName: 'p.json' }).apply(auto.compiler);
    const r1 = await auto.run();
    expect([...r1.emitted.keys()]).toEqual(['m.json', 'p.json']);
    expect((read(r1, 'm.json') as SfManifest).base).toBe('/');
    expect(r1.stage).toBe(5000);
    expect(r1.emitted.get('m.json')?.size()).toBeGreaterThan(10);
    const override = fakeCompiler();
    plugin({ base: 'https://cdn.example/app/', precache: { fileName: 'sw.json', tiers: ['on-demand'] } }).apply(override.compiler);
    const r2 = await override.run();
    expect((read(r2, 'sf-manifest.json') as SfManifest).base).toBe('https://cdn.example/app/');
    expect((read(r2, 'sw.json') as unknown[]).length).toBeGreaterThan(1);
  });

  it('exposes isolation headers for devServer', () => {
    expect(plugin().headers).toEqual({});
    expect(plugin({ isolation: 'preferred', coep: 'credentialless', corp: 'same-site' }).headers).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'same-site',
    });
  });

  it('injects boot preloads through HtmlRspackPlugin alterAssetTags', async () => {
    const fake = fakeCompiler();
    plugin({ html: { plugin: fake.htmlPlugin, profile: 'web:expanded' }, isolation: 'required', sri: true }).apply(fake.compiler);
    const data: AlterAssetTagsData = {
      assetTags: { scripts: [{ tagName: 'script', voidTag: false, attributes: { src: '/static/js/main.22222222.js' } }], styles: [], meta: [] },
    };
    await fake.run(data);
    expect(data.assetTags.styles.map((t) => t.attributes['href'])).toEqual([
      '/static/js/lib.shell.44444444.js',
      '/static/js/feature.studio.66666666.js',
      '/static/js/split.55555555.js',
      '/static/css/studio.77777777.css',
    ]);
    expect(data.assetTags.styles.every((t) => t.attributes['crossorigin'] === 'anonymous')).toBe(true);
    expect(data.assetTags.styles[0]?.attributes['integrity']).toMatch(/^sha384-/);
  });

  it('leaves HTML untouched when the manifest fails', async () => {
    const fake = fakeCompiler();
    plugin({ chunks: [...chunks, chunk('feature:ghost')], html: { plugin: fake.htmlPlugin } }).apply(fake.compiler);
    const data: AlterAssetTagsData = { assetTags: { scripts: [], styles: [], meta: [] } };
    await fake.run(data);
    expect(data.assetTags.styles).toEqual([]);
  });

  it('helpers: preload tags, referenced urls, gzip/sha384, toBuildError', () => {
    const tags = preloadTags({ modulepreload: ['/a.js', '/b.js'], stylesheets: ['/a.css'], crossorigin: true, existing: new Set(['/b.js']) });
    expect(tags.map((t) => t.attributes)).toEqual([
      { rel: 'modulepreload', href: '/a.js', crossorigin: '' },
      { rel: 'preload', as: 'style', href: '/a.css', crossorigin: '' },
    ]);
    expect([...referencedUrls({ assetTags: { scripts: [{ tagName: 'script', voidTag: false, attributes: { src: '/x.js' } }], styles: [{ tagName: 'link', voidTag: true, attributes: { href: '/y.css' } }], meta: [] } })]).toEqual(['/x.js', '/y.css']);
    expect(gzipKb('a', 'x'.repeat(5000))).toBeLessThan(1);
    expect(sha384('a', 'x')).toMatch(/^sha384-/);
    const e = toBuildError(RspackOptionsError({ message: 'boom' }));
    expect(e.message).toBe(`SF-RSPACK-004: boom\n  fix: ${RspackOptionsError.fix}`);
  });
});
