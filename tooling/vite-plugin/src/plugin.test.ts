// @vitest-environment node
import { chunk, defineBootPlan, parseManifest, type ProfileLike, type RollupLikeOutput, type SfManifest } from '@staticflux/loader';
import { describe, expect, it } from 'vitest';
import { ALL_PROFILES, buildReportJson, computeArtifacts } from './artifacts.js';
import { chunkNameFor, devBundlerOutput, devUrlOf, isModuleEntry, moduleEntries, RESOLVED_VIRTUAL_CHUNKS_ID, renderChunksModule, VIRTUAL_CHUNKS_ID } from './chunks-module.js';
import { preloadTags, renderTags } from './html.js';
import { crossOriginFor, isolationHeaders } from './isolation.js';
import { buildDeclarations, gzipKb, sha384, staticflux, type StaticfluxViteOptions, validateOptions } from './plugin.js';

// ---------------------------------------------------------------- fixtures

const ROOT = '/repo';
const profiles: readonly ProfileLike[] = [
  { key: 'web:expanded', hostMode: 'web', formFactor: 'expanded' },
  { key: 'web:compact', hostMode: 'web', formFactor: 'compact' },
];

const chunks = [
  chunk('lib:shell', { entry: 'src/shell.ts', tier: 'critical', load: 'eager', reason: 'shell frame before core-ready', budget: { maxKb: 20 } }),
  chunk('lib:vendor', { tier: 'critical' }),
  chunk('feature:studio', { entry: 'src/features/studio.ts', deps: ['lib:shell'], profiles: ['web:expanded'], budget: { category: 'feature' } }),
  chunk('feature:studio-compact', { entry: './src/features/studio-compact.ts', deps: ['lib:shell'], profiles: ['web:compact'] }),
];

const bootPlans = [
  defineBootPlan({ id: 'desktop', match: { formFactors: ['expanded'] }, critical: ['lib:shell'], preload: ['feature:studio'] }),
  defineBootPlan({ id: 'compact', match: { formFactors: ['compact'] }, critical: ['lib:shell'], preload: ['feature:studio-compact'] }),
];

const js = (fileName: string, size: number, extra: Partial<RollupLikeOutput> = {}): RollupLikeOutput => ({
  type: 'chunk',
  fileName,
  imports: [],
  code: 'x'.repeat(size),
  ...extra,
});

function fakeBundle(): Record<string, RollupLikeOutput> {
  const entries: RollupLikeOutput[] = [
    js('assets/index-AAAAAAAA.js', 3, { name: 'index', facadeModuleId: `${ROOT}/index.html`, imports: ['assets/lib.shell-BBBBBBBB.js'] }),
    js('assets/lib.shell-BBBBBBBB.js', 10, { name: 'lib.shell', facadeModuleId: `${ROOT}/src/shell.ts`, imports: ['assets/lib.vendor-CCCCCCCC.js'], viteMetadata: { importedCss: new Set(['assets/shell-DDDDDDDD.css']) } }),
    js('assets/lib.vendor-CCCCCCCC.js', 15, { name: 'lib.vendor' }),
    js('assets/feature.studio-EEEEEEEE.js', 40, { name: 'feature.studio', facadeModuleId: `${ROOT}/src/features/studio.ts`, imports: ['assets/lib.vendor-CCCCCCCC.js'] }),
    js('assets/feature.studio-compact-FFFFFFFF.js', 20, { name: 'feature.studio-compact', facadeModuleId: `${ROOT}/src/features/studio-compact.ts` }),
    { type: 'asset', fileName: 'assets/shell-DDDDDDDD.css' },
    { type: 'asset', fileName: 'index.html' },
  ];
  return Object.fromEntries(entries.map((e) => [e.fileName, e]));
}

/** Size = characters (1 char = 1 KB) so expectations stay readable. */
const sizeOf = (_file: string, code: string): number => code.length;

interface Emitted {
  readonly type: string;
  readonly fileName?: string;
  readonly source?: string;
  readonly id?: string;
  readonly name?: string;
}

function fakeContext(): { emitted: Emitted[]; warnings: string[]; emitFile(f: Emitted): string; warn(m: string): void; error(m: string): never } {
  const emitted: Emitted[] = [];
  const warnings: string[] = [];
  return {
    emitted,
    warnings,
    emitFile(f) {
      emitted.push(f);
      return `ref-${emitted.length}`;
    },
    warn(m) {
      warnings.push(m);
    },
    error(m) {
      throw new Error(m);
    },
  };
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
function hook(plugin: unknown, name: string): AnyFn {
  const h = (plugin as Record<string, unknown>)[name];
  if (typeof h === 'function') return h as AnyFn;
  if (typeof h === 'object' && h !== null && typeof (h as { handler?: unknown }).handler === 'function') return (h as { handler: AnyFn }).handler;
  throw new Error(`no hook ${name}`);
}

function makePlugin(extra: Partial<StaticfluxViteOptions> = {}, command: 'build' | 'serve' = 'build') {
  const plugin = staticflux({ chunks, bootPlans, profiles, sizeOf, buildId: 'b1', ...extra });
  const logs: string[] = [];
  hook(plugin, 'configResolved').call(plugin, { root: ROOT, base: '/', command, logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`warn ${m}`) } });
  return { plugin, logs };
}

function runGenerate(plugin: unknown, bundle = fakeBundle()): ReturnType<typeof fakeContext> {
  const ctx = fakeContext();
  hook(plugin, 'generateBundle').call(ctx, {}, bundle);
  return ctx;
}

function emittedJson(ctx: ReturnType<typeof fakeContext>, fileName: string): unknown {
  const file = ctx.emitted.find((e) => e.fileName === fileName);
  if (file?.source === undefined) throw new Error(`${fileName} not emitted`);
  return JSON.parse(file.source) as unknown;
}

// ---------------------------------------------------------------- options

describe('validateOptions / staticflux()', () => {
  it('accepts valid options', () => {
    expect(validateOptions({ chunks, bootPlans, profiles }).ok).toBe(true);
  });

  it('rejects bad ids, duplicates, plans without profiles, unknown html profile and undeclared remotes', () => {
    const cases: StaticfluxViteOptions[] = [
      { chunks: [{ ...chunk('lib:x'), id: 'nope' as 'lib:x' }] },
      { chunks: [chunk('lib:x'), chunk('lib:x')] },
      { chunks, bootPlans },
      { chunks, bootPlans, profiles, html: { profile: 'tv:large' } },
      { chunks, remotes: { 'feature:remote': { entry: 'https://cdn/remoteEntry.js', module: './Panel' } } },
    ];
    for (const options of cases) {
      const r = validateOptions(options);
      expect(!r.ok && r.error.code).toBe('SF-VITE-004');
    }
    expect(() => staticflux({ chunks, bootPlans })).toThrow(/profiles/);
  });

  it('defaults entry-less declarations to the file-safe chunk name', () => {
    const decls = buildDeclarations(chunks);
    expect(decls.find((d) => d.id === 'lib:vendor')?.entry).toBe('lib.vendor');
    expect(decls.find((d) => d.id === 'lib:shell')?.entry).toBe('src/shell.ts');
  });
});

// ---------------------------------------------------------------- chunk mapping

describe('logical chunk mapping', () => {
  it('names chunks file-safely and recognizes module entries', () => {
    expect(chunkNameFor('feature:studio-desktop')).toBe('feature.studio-desktop');
    expect(chunkNameFor('locale:de/studio')).toBe('locale.de_studio');
    expect(isModuleEntry('src/a.ts')).toBe(true);
    expect(isModuleEntry('a.tsx')).toBe(true);
    expect(isModuleEntry('vendor')).toBe(false);
  });

  it('resolves virtual:sf-chunks to import() thunks keyed by logical id', () => {
    const { plugin } = makePlugin();
    expect(hook(plugin, 'resolveId').call(plugin, VIRTUAL_CHUNKS_ID)).toBe(RESOLVED_VIRTUAL_CHUNKS_ID);
    expect(hook(plugin, 'resolveId').call(plugin, './other')).toBeUndefined();
    const source = hook(plugin, 'load').call(plugin, RESOLVED_VIRTUAL_CHUNKS_ID) as string;
    expect(source).toContain('"feature:studio": () => import("/repo/src/features/studio.ts")');
    expect(source).toContain('"lib:shell": () => import("/repo/src/shell.ts")');
    expect(source).not.toContain('lib:vendor');
    expect(source.indexOf('feature:studio"')).toBeLessThan(source.indexOf('lib:shell'));
    expect(hook(plugin, 'load').call(plugin, '/repo/src/x.ts')).toBeUndefined();
  });

  it('the virtual module works as an ES module', async () => {
    const source = renderChunksModule([{ id: 'lib:a', name: 'lib.a', file: 'data:text/javascript,export const v = 1' }]);
    const mod = (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`)) as {
      chunkIds: string[];
      importChunk(id: string): Promise<{ v: number }>;
    };
    expect(mod.chunkIds).toEqual(['lib:a']);
    expect((await mod.importChunk('lib:a')).v).toBe(1);
    await expect(mod.importChunk('lib:missing')).rejects.toThrow(/SF-LOAD-001/);
  });

  it('emits module-path declarations as named chunks in build only', () => {
    const { plugin } = makePlugin();
    const ctx = fakeContext();
    hook(plugin, 'buildStart').call(ctx);
    expect(ctx.emitted).toEqual([
      { type: 'chunk', id: '/repo/src/shell.ts', name: 'lib.shell', preserveSignature: 'allow-extension' },
      { type: 'chunk', id: '/repo/src/features/studio.ts', name: 'feature.studio', preserveSignature: 'allow-extension' },
      { type: 'chunk', id: '/repo/src/features/studio-compact.ts', name: 'feature.studio-compact', preserveSignature: 'allow-extension' },
    ]);
    const serve = makePlugin({}, 'serve');
    const serveCtx = fakeContext();
    hook(serve.plugin, 'buildStart').call(serveCtx);
    expect(serveCtx.emitted).toEqual([]);
    const off = makePlugin({ emitEntryChunks: false });
    const offCtx = fakeContext();
    hook(off.plugin, 'buildStart').call(offCtx);
    expect(offCtx.emitted).toEqual([]);
  });

  it('maps dev URLs inside and outside the root', () => {
    expect(devUrlOf('/repo/src/a.ts', ROOT)).toBe('/src/a.ts');
    expect(devUrlOf('/elsewhere/b.ts', ROOT)).toBe('/@fs/elsewhere/b.ts');
    const out = devBundlerOutput(chunks, ROOT);
    expect(out.chunks.map((c) => c.fileName)).toEqual(['/src/shell.ts', '/@id/__x00__virtual:sf-chunks', '/src/features/studio.ts', '/src/features/studio-compact.ts']);
    expect(moduleEntries(chunks, ROOT)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- generateBundle

describe('generateBundle', () => {
  it('emits sf-manifest.json from the bundle (logical id → hashed files, css, deps, sizes)', () => {
    const { plugin, logs } = makePlugin();
    const ctx = runGenerate(plugin);
    const manifest = emittedJson(ctx, 'sf-manifest.json') as SfManifest;
    expect(parseManifest(manifest).ok).toBe(true);
    expect(manifest.buildId).toBe('b1');
    expect(manifest.base).toBe('/');
    expect(manifest.chunks['lib:shell']).toMatchObject({
      files: ['assets/lib.shell-BBBBBBBB.js', 'assets/lib.vendor-CCCCCCCC.js'],
      css: ['assets/shell-DDDDDDDD.css'],
      load: 'eager',
      reason: 'shell frame before core-ready',
      sizeKb: 25,
      budgetKb: 20,
    });
    expect(manifest.chunks['lib:vendor']?.files).toEqual(['assets/lib.vendor-CCCCCCCC.js']);
    expect(manifest.chunks['feature:studio']).toMatchObject({ deps: ['lib:shell'], profiles: ['web:expanded'], sizeKb: 55 });
    expect(logs.some((l) => l.includes('4 logical chunks'))).toBe(true);
  });

  it('emits per-profile preloads (other profiles\' code excluded), precache list and the build report', () => {
    const { plugin } = makePlugin();
    const ctx = runGenerate(plugin);
    const preloads = emittedJson(ctx, 'sf-preloads.json') as Record<string, { plan: string; modulepreload: string[]; precache: { url: string }[] }>;
    expect(preloads['web:expanded']?.plan).toBe('desktop');
    expect(preloads['web:expanded']?.modulepreload).toEqual(['/assets/lib.shell-BBBBBBBB.js', '/assets/lib.vendor-CCCCCCCC.js', '/assets/feature.studio-EEEEEEEE.js']);
    expect(preloads['web:compact']?.modulepreload).toContain('/assets/feature.studio-compact-FFFFFFFF.js');
    expect(preloads['web:compact']?.modulepreload).not.toContain('/assets/feature.studio-EEEEEEEE.js');
    const precache = emittedJson(ctx, 'sf-precache.json') as { url: string; revision: string | null }[];
    expect(precache.map((p) => p.url)).toEqual(['/assets/lib.shell-BBBBBBBB.js', '/assets/lib.vendor-CCCCCCCC.js', '/assets/shell-DDDDDDDD.css']);
    expect(precache.every((p) => p.revision === null)).toBe(true);
    const report = emittedJson(ctx, 'sf-build-report.json') as { format: string; boot: { profile: string; bootKb: number; eagerKb: number }[] };
    expect(report.format).toBe('sf-build-report/1');
    expect(report.boot).toEqual([
      { profile: 'web:expanded', plan: 'desktop', bootKb: 65, eagerKb: 25 },
      { profile: 'web:compact', plan: 'compact', bootKb: 45, eagerKb: 25 },
    ]);
  });

  it('honours custom file names and disabled outputs', () => {
    const { plugin } = makePlugin({ manifestFileName: 'm.json', preloadsFileName: 'p.json', precache: false, reportFileName: false });
    const ctx = runGenerate(plugin);
    expect(ctx.emitted.map((e) => e.fileName)).toEqual(['m.json', 'p.json']);
    const tiers = makePlugin({ precache: { fileName: 'sw.json', tiers: ['likely'] }, reportFileName: 'r.json' });
    const ctx2 = runGenerate(tiers.plugin);
    expect(ctx2.emitted.map((e) => e.fileName)).toEqual(['sf-manifest.json', 'sf-preloads.json', 'sw.json', 'r.json']);
  });

  it('warns on budget violations by default (chunk, boot, eager)', () => {
    const { plugin } = makePlugin({ budgets: { bootKb: 50, eagerKb: 20 } });
    const ctx = runGenerate(plugin);
    expect(ctx.warnings).toEqual([
      'SF-VITE-002: Chunk "lib:shell" is 25 KB gzip, budget 20 KB.',
      'SF-VITE-002: Chunk "feature:studio" is 55 KB gzip, budget 50 KB.',
      'SF-VITE-002: Boot JS for profile "web:expanded" is 65 KB gzip, budget 50 KB.',
      'SF-VITE-002: Eager boot cost for profile "web:expanded" is 25 KB gzip, budget 20 KB.',
      'SF-VITE-002: Eager boot cost for profile "web:compact" is 25 KB gzip, budget 20 KB.',
    ]);
    const report = emittedJson(ctx, 'sf-build-report.json') as { violations: { kind: string }[] };
    expect(report.violations.map((v) => v.kind)).toEqual(['chunk', 'chunk', 'boot', 'eager', 'eager']);
  });

  it('fails the build on violations with onViolation: error', () => {
    const { plugin } = makePlugin({ budgets: { onViolation: 'error' } });
    expect(() => runGenerate(plugin)).toThrow(/SF-VITE-002: budget exceeded:\n {2}- Chunk "lib:shell"/);
  });

  it('fails with SF-VITE-001 when a declaration matches no bundled chunk', () => {
    const { plugin } = makePlugin({ chunks: [...chunks, chunk('feature:ghost', { entry: 'src/ghost.ts' })] });
    expect(() => runGenerate(plugin)).toThrow(/SF-VITE-001: SF-LOAD-010: No bundler chunk matches entry "src\/ghost.ts"/);
  });

  it('fails with SF-VITE-003 when a profile has no boot plan', () => {
    const { plugin } = makePlugin({ profiles: [...profiles, { key: 'embed-iframe:compact', hostMode: 'embed-iframe', formFactor: 'medium' }] });
    expect(() => runGenerate(plugin)).toThrow(/SF-VITE-003: SF-LOAD-009/);
  });

  it('adds sha384 integrity with sri: true and passes remotes through', () => {
    const remote = chunk('feature:remote-panel', { tier: 'on-demand' });
    const { plugin } = makePlugin({ sri: true, chunks: [...chunks, remote], remotes: { 'feature:remote-panel': { entry: 'https://cdn.example/remoteEntry.js', module: './Panel' } } });
    const manifest = emittedJson(runGenerate(plugin), 'sf-manifest.json') as SfManifest;
    expect(manifest.chunks['lib:shell']?.integrity?.['assets/lib.shell-BBBBBBBB.js']).toMatch(/^sha384-/);
    expect(manifest.chunks['feature:remote-panel']).toMatchObject({ files: ['https://cdn.example/remoteEntry.js'], remote: { module: './Panel' } });
  });

  it('uses gzip and sha384 helpers by default', () => {
    expect(gzipKb('a.js', 'x'.repeat(10_000))).toBeLessThan(1);
    expect(sha384('a.js', 'x')).toMatch(/^sha384-[A-Za-z0-9+/=]{64}$/);
  });
});

// ---------------------------------------------------------------- transformIndexHtml

describe('transformIndexHtml', () => {
  const html = '<html><head><script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script><link rel="modulepreload" crossorigin href="/assets/lib.shell-BBBBBBBB.js"></head></html>';

  it('injects the html profile\'s boot preloads (skipping URLs already present), bare crossorigin when isolation is off', () => {
    const { plugin } = makePlugin();
    const tags = hook(plugin, 'transformIndexHtml').call({}, html, { path: '/index.html', filename: '/repo/index.html', bundle: fakeBundle() }) as { attrs: Record<string, unknown> }[];
    expect(tags.map((t) => t.attrs)).toEqual([
      { rel: 'modulepreload', href: '/assets/lib.vendor-CCCCCCCC.js', crossorigin: true },
      { rel: 'modulepreload', href: '/assets/feature.studio-EEEEEEEE.js', crossorigin: true },
      { rel: 'preload', as: 'style', href: '/assets/shell-DDDDDDDD.css', crossorigin: true },
    ]);
  });

  it('uses an explicit crossorigin under isolation and the chosen profile', () => {
    const { plugin } = makePlugin({ isolation: 'required', html: { profile: 'web:compact' }, sri: true });
    const tags = hook(plugin, 'transformIndexHtml').call({}, '<html></html>', { path: '/', filename: 'x', bundle: fakeBundle() }) as { attrs: Record<string, unknown> }[];
    expect(tags.map((t) => t.attrs['href'])).toContain('/assets/feature.studio-compact-FFFFFFFF.js');
    expect(tags.every((t) => t.attrs['crossorigin'] === 'anonymous')).toBe(true);
    expect(tags[0]?.attrs['integrity']).toMatch(/^sha384-/);
    const creds = makePlugin({ isolation: 'preferred', crossorigin: 'use-credentials' });
    const t2 = hook(creds.plugin, 'transformIndexHtml').call({}, '', { path: '/', filename: 'x', bundle: fakeBundle() }) as { attrs: Record<string, unknown> }[];
    expect(t2[0]?.attrs['crossorigin']).toBe('use-credentials');
  });

  it('falls back to the critical + eager boot set without boot plans', () => {
    const plugin = staticflux({ chunks, sizeOf });
    hook(plugin, 'configResolved').call(plugin, { root: ROOT, base: '/', command: 'build', logger: { info: () => undefined, warn: () => undefined } });
    const tags = hook(plugin, 'transformIndexHtml').call({}, '', { path: '/', filename: 'x', bundle: fakeBundle() }) as { attrs: Record<string, unknown> }[];
    expect(tags.map((t) => t.attrs['href'])).toEqual(['/assets/lib.shell-BBBBBBBB.js', '/assets/lib.vendor-CCCCCCCC.js', '/assets/shell-DDDDDDDD.css']);
    const ctx = runGenerate(plugin);
    expect(ctx.emitted.map((e) => e.fileName)).toEqual(['sf-manifest.json', 'sf-precache.json', 'sf-build-report.json']);
  });

  it('does nothing in dev, with html: false, or when the manifest fails', () => {
    const { plugin } = makePlugin();
    expect(hook(plugin, 'transformIndexHtml').call({}, html, { path: '/', filename: 'x' })).toBeUndefined();
    const off = makePlugin({ html: false });
    expect(hook(off.plugin, 'transformIndexHtml').call({}, html, { path: '/', filename: 'x', bundle: fakeBundle() })).toBeUndefined();
    const broken = makePlugin({ chunks: [...chunks, chunk('feature:ghost', { entry: 'src/ghost.ts' })] });
    expect(hook(broken.plugin, 'transformIndexHtml').call({}, html, { path: '/', filename: 'x', bundle: fakeBundle() })).toBeUndefined();
  });
});

// ---------------------------------------------------------------- dev / preview servers

interface FakeRes {
  headers: Record<string, string>;
  statusCode: number;
  body: string | undefined;
  setHeader(n: string, v: string): void;
  end(b?: string): void;
}
const fakeRes = (): FakeRes => ({
  headers: {},
  statusCode: 0,
  body: undefined,
  setHeader(n, v) {
    this.headers[n] = v;
  },
  end(b) {
    this.body = b;
  },
});
type Mw = (req: { url?: string }, res: FakeRes, next: () => void) => void;
function fakeServer(): { middlewares: { use(fn: Mw): void }; stack: Mw[] } {
  const stack: Mw[] = [];
  return { stack, middlewares: { use: (fn) => stack.push(fn) } };
}
function run(stack: readonly Mw[], url: string): { res: FakeRes; passed: boolean } {
  const res = fakeRes();
  let passed = false;
  const step = (i: number): void => {
    const mw = stack[i];
    if (mw === undefined) {
      passed = true;
      return;
    }
    mw({ url }, res, () => step(i + 1));
  };
  step(0);
  return { res, passed };
}

describe('dev and preview servers', () => {
  it('serves COOP/COEP/CORP when isolation is on', () => {
    const { plugin } = makePlugin({ isolation: 'required', coep: 'credentialless' }, 'serve');
    const server = fakeServer();
    hook(plugin, 'configureServer').call(plugin, server);
    const { res, passed } = run(server.stack, '/src/main.ts');
    expect(passed).toBe(true);
    expect(res.headers).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    const preview = fakeServer();
    hook(plugin, 'configurePreviewServer').call(plugin, preview);
    expect(run(preview.stack, '/').res.headers['Cross-Origin-Embedder-Policy']).toBe('credentialless');
  });

  it('serves no isolation headers when isolation is off', () => {
    const { plugin } = makePlugin({}, 'serve');
    const server = fakeServer();
    hook(plugin, 'configureServer').call(plugin, server);
    expect(run(server.stack, '/x').res.headers).toEqual({});
    const preview = fakeServer();
    hook(plugin, 'configurePreviewServer').call(plugin, preview);
    expect(preview.stack).toHaveLength(0);
  });

  it('serves a dev sf-manifest.json that points at source modules', () => {
    const { plugin } = makePlugin({}, 'serve');
    const server = fakeServer();
    hook(plugin, 'configureServer').call(plugin, server);
    const { res, passed } = run(server.stack, '/sf-manifest.json?t=1');
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json');
    const manifest = JSON.parse(res.body ?? '') as SfManifest;
    expect(parseManifest(manifest).ok).toBe(true);
    expect(manifest.buildId).toBe('dev');
    expect(manifest.chunks['feature:studio']?.files).toEqual(['/src/features/studio.ts']);
    expect(manifest.chunks['lib:vendor']?.files).toEqual(['/@id/__x00__virtual:sf-chunks']);
  });

  it('answers 500 with the error code when the dev manifest cannot be built', () => {
    const { plugin, logs } = makePlugin({ chunks: [chunk('feature:a', { entry: 'src/a.ts', deps: ['lib:missing'] })], bootPlans: [], profiles: [] }, 'serve');
    const server = fakeServer();
    hook(plugin, 'configureServer').call(plugin, server);
    const { res } = run(server.stack, '/sf-manifest.json');
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body ?? '')).toMatchObject({ code: 'SF-LOAD-010' });
    expect(logs.some((l) => l.startsWith('warn'))).toBe(true);
  });
});

// ---------------------------------------------------------------- pure helpers

describe('helpers', () => {
  it('isolation headers and crossorigin per mode', () => {
    expect(isolationHeaders({ isolation: 'off', coep: 'require-corp', corp: 'same-origin' })).toEqual({});
    expect(isolationHeaders({ isolation: 'preferred', coep: 'require-corp', corp: 'same-site' })['Cross-Origin-Resource-Policy']).toBe('same-site');
    expect(crossOriginFor('off')).toBe(true);
    expect(crossOriginFor('required')).toBe('anonymous');
    expect(crossOriginFor('off', 'use-credentials')).toBe('use-credentials');
  });

  it('renders preload tags as HTML', () => {
    const tags = preloadTags({ modulepreload: ['/a.js'], stylesheets: ['/a.css'], crossorigin: true, integrity: new Map([['/a.js', 'sha384-x"y']]) });
    expect(renderTags(tags)).toBe('<link rel="modulepreload" href="/a.js" crossorigin integrity="sha384-x&quot;y">\n<link rel="preload" as="style" href="/a.css" crossorigin>');
  });

  it('computeArtifacts without plans reports one boot set for all profiles', () => {
    const output = { chunks: [{ fileName: 'a-12345678.js', name: 'lib.a', imports: [], sizeKb: 5 }] };
    const r = computeArtifacts(output, { base: '/', declarations: buildDeclarations([chunk('lib:a', { tier: 'critical' })]), budgets: { bootKb: 4 } });
    expect(r.ok && r.value.boot).toEqual([{ profile: ALL_PROFILES, plan: undefined, bootKb: 5, eagerKb: 0 }]);
    expect(r.ok && r.value.violations.map((v) => v.kind)).toEqual(['boot']);
    expect(r.ok && r.value.manifest.buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(r.ok && r.value.preloads).toBeUndefined();
  });

  it('regression: feature chunk budgets count only bytes not already in the boot set', () => {
    const output = {
      chunks: [
        { fileName: 'index-11111111.js', name: 'index', moduleId: '/r/index.html', imports: ['shared-22222222.js'], sizeKb: 1 },
        { fileName: 'shared-22222222.js', name: 'shared', imports: [], sizeKb: 64 },
        { fileName: 'feature.a-33333333.js', name: 'feature.a', moduleId: '/r/src/a.ts', imports: ['shared-22222222.js'], sizeKb: 1.5 },
        { fileName: 'feature.b-44444444.js', name: 'feature.b', moduleId: '/r/src/b.ts', imports: ['shared-22222222.js', 'own-55555555.js'], sizeKb: 2 },
        { fileName: 'own-55555555.js', name: 'own', imports: [], sizeKb: 49 },
      ],
    };
    const declarations = buildDeclarations([
      chunk('feature:a', { entry: 'src/a.ts', budget: { category: 'feature' } }),
      chunk('feature:b', { entry: 'src/b.ts', budget: { category: 'feature' } }),
    ]);
    const r = computeArtifacts(output, { base: '/', declarations, entries: ['index-11111111.js'] });
    if (!r.ok) throw r.error;
    expect(r.value.chunkCosts).toEqual([
      { chunk: 'feature:a', sizeKb: 65.5, incrementalKb: 1.5, budgetKb: 50 },
      { chunk: 'feature:b', sizeKb: 115, incrementalKb: 51, budgetKb: 50 },
    ]);
    expect(r.value.violations).toEqual([
      { kind: 'chunk', subject: 'feature:b', actualKb: 51, budgetKb: 50, message: 'Chunk "feature:b" is 51 KB gzip, budget 50 KB.' },
    ]);
    expect(r.value.report.overBudget).toEqual([{ chunk: 'feature:b', sizeKb: 51, budgetKb: 50 }]);
    expect((buildReportJson(r.value) as { chunks: unknown[] }).chunks).toHaveLength(2);
    // Without the entry the shared code is not boot code: the full closure counts (old behaviour).
    const noEntry = computeArtifacts(output, { base: '/', declarations });
    expect(noEntry.ok && noEntry.value.violations.map((v) => v.subject)).toEqual(['feature:a', 'feature:b']);
  });

  it('regression: without boot plans the boot set defaults to the entry chunk static closure (not 0 KB)', () => {
    // No boot plans / profiles at all.
    const plugin = staticflux({ chunks: [chunk('feature:studio', { entry: 'src/features/studio.ts', budget: { category: 'feature' } })], sizeOf, buildId: 'b1', budgets: { bootKb: 10 } });
    hook(plugin, 'configResolved').call(plugin, { root: ROOT, base: '/', command: 'build', logger: { info: () => undefined, warn: () => undefined } });
    const bundle = fakeBundle();
    bundle['assets/index-AAAAAAAA.js'] = { ...(bundle['assets/index-AAAAAAAA.js'] as RollupLikeOutput), isEntry: true } as RollupLikeOutput;
    // Emitted logical chunks are bundler entries too; they must not count as app entries.
    bundle['assets/feature.studio-EEEEEEEE.js'] = { ...(bundle['assets/feature.studio-EEEEEEEE.js'] as RollupLikeOutput), isEntry: true } as RollupLikeOutput;
    const ctx = runGenerate(plugin, bundle);
    const report = emittedJson(ctx, 'sf-build-report.json') as { boot: { profile: string; bootKb: number }[]; chunks: { chunk: string; incrementalKb: number }[] };
    expect(report.boot).toEqual([{ profile: ALL_PROFILES, bootKb: 28, eagerKb: 0 }]); // index 3 + lib.shell 10 + lib.vendor 15
    expect(report.chunks.find((c) => c.chunk === 'feature:studio')?.incrementalKb).toBe(40); // vendor already booted
    expect(ctx.warnings).toEqual(['SF-VITE-002: Boot JS for profile "*" is 28 KB gzip, budget 10 KB.']);
  });

  it('bootEntries add dynamically imported boot modules to the boot set', () => {
    const output = {
      chunks: [
        { fileName: 'index-11111111.js', name: 'index', moduleId: '/r/index.html', imports: [], sizeKb: 1 },
        { fileName: 'boot-22222222.js', name: 'boot', moduleId: '/r/src/boot-browser.ts', imports: ['shared-33333333.js'], sizeKb: 20 },
        { fileName: 'shared-33333333.js', name: 'shared', imports: [], sizeKb: 60 },
        { fileName: 'feature.a-44444444.js', name: 'feature.a', moduleId: '/r/src/a.ts', imports: ['shared-33333333.js'], sizeKb: 2 },
      ],
    };
    const declarations = buildDeclarations([chunk('feature:a', { entry: 'src/a.ts', budget: { category: 'feature' } })]);
    const r = computeArtifacts(output, { base: '/', declarations, entries: ['index-11111111.js'], bootEntries: ['src/boot-browser.ts'] });
    if (!r.ok) throw r.error;
    expect(r.value.boot).toEqual([{ profile: ALL_PROFILES, plan: undefined, bootKb: 81, eagerKb: 0 }]);
    expect(r.value.chunkCosts).toEqual([{ chunk: 'feature:a', sizeKb: 62, incrementalKb: 2, budgetKb: 50 }]);
    expect(r.value.violations).toEqual([]);
  });

  it('per-profile boot sets: a chunk outside the plan counts only bytes beyond that profile boot set', () => {
    const extra = chunk('feature:settings', { entry: 'src/features/settings.ts', budget: { maxKb: 5 } });
    const { plugin } = makePlugin({ chunks: [...chunks, extra] });
    const bundle = fakeBundle();
    bundle['assets/feature.settings-GGGGGGGG.js'] = js('assets/feature.settings-GGGGGGGG.js', 4, {
      name: 'feature.settings',
      facadeModuleId: `${ROOT}/src/features/settings.ts`,
      imports: ['assets/lib.vendor-CCCCCCCC.js'],
    });
    const ctx = runGenerate(plugin, bundle);
    const report = emittedJson(ctx, 'sf-build-report.json') as { chunks: { chunk: string; sizeKb: number; incrementalKb: number }[] };
    expect(report.chunks.find((c) => c.chunk === 'feature:settings')).toEqual({ chunk: 'feature:settings', sizeKb: 19, incrementalKb: 4, budgetKb: 5 });
    expect(ctx.warnings.some((w) => w.includes('feature:settings'))).toBe(false);
  });
});
