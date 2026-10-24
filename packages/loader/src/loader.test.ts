import { createMemorySink, createTelemetry, type SpanEndRecord, type TelemetryRecord } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  checkShared,
  chunkLoadFunction,
  ChunkFetchError,
  classifyCodeSource,
  createChunkLoader,
  crossOriginPolicy,
  dynamicImportStrategy,
  federationStrategy,
  importMapStrategy,
  installImportMap,
  type LoaderDocument,
  type LoaderElement,
  MANIFEST_FORMAT,
  type RemoteContainer,
  satisfiesRange,
  type SfManifest,
} from './index.js';

const manifest: SfManifest = {
  format: MANIFEST_FORMAT,
  buildId: 'b1',
  base: '/assets/',
  chunks: {
    'lib:editor-core': { id: 'lib:editor-core', files: ['editor-core.js', 'vendor.js'], css: ['editor.css'], deps: [], tier: 'on-demand', load: 'lazy' },
    'feature:studio-desktop': {
      id: 'feature:studio-desktop',
      files: ['studio.js'],
      css: [],
      deps: ['lib:editor-core'],
      tier: 'on-demand',
      load: 'lazy',
      profiles: ['web:expanded'],
      integrity: { 'studio.js': 'sha384-s' },
    },
    'feature:agent-chat': { id: 'feature:agent-chat', files: ['https://cdn.example/chat.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
    'feature:billing': { id: 'feature:billing', files: ['billing.js'], css: [], deps: [], tier: 'speculative', load: 'lazy' },
    'remote:inspector': {
      id: 'remote:inspector',
      files: ['https://team.example/remoteEntry.js'],
      css: [],
      deps: [],
      tier: 'on-demand',
      load: 'lazy',
      remote: { entry: 'https://team.example/remoteEntry.js', module: './Inspector', shared: { mobx: '^7.0.0' } },
    },
  },
};

interface FakeElement extends LoaderElement {
  readonly tag: string;
  readonly attrs: Record<string, string>;
}

function fakeDocument(): LoaderDocument & { readonly appended: FakeElement[] } {
  const appended: FakeElement[] = [];
  return {
    appended,
    createElement(tag) {
      const attrs: Record<string, string> = {};
      return {
        tag,
        attrs,
        textContent: null,
        setAttribute(name: string, value: string) {
          attrs[name] = value;
        },
      } as FakeElement;
    },
    head: { appendChild: (node) => appended.push(node as FakeElement) },
  };
}

const fastRetry = { attempts: 3, baseDelayMs: 0, jitter: 'none' as const };

function setup(overrides: Partial<Parameters<typeof createChunkLoader>[0]> = {}) {
  const sink = createMemorySink();
  let t = 0;
  const telemetry = createTelemetry({ now: () => (t += 5), random: () => 0.5 });
  telemetry.addSink(sink);
  const document = fakeDocument();
  const importer = vi.fn(async (url: string) => ({ url }));
  const loader = createChunkLoader({ manifest, telemetry, importer, document, retry: fastRetry, resourceTiming: () => ({ transferSize: 300 }), ...overrides });
  return { loader, importer, document, sink, telemetry };
}

const spans = (records: readonly TelemetryRecord[], name: string): SpanEndRecord[] =>
  records.filter((r): r is SpanEndRecord => r.type === 'span' && r.name === name);

describe('chunk loader', () => {
  it('loads deps first, injects modulepreload/stylesheet links once, and dedupes concurrent loads', async () => {
    const { loader, importer, document } = setup({ profile: () => 'web:expanded' });
    const [a, b] = await Promise.all([loader.load('feature:studio-desktop'), loader.load('feature:studio-desktop')]);
    expect(a).toEqual({ ok: true, value: { url: '/assets/studio.js' } });
    expect(b.ok && a.ok && b.value === a.value).toBe(true);
    expect(importer.mock.calls.map((c) => c[0])).toEqual(['/assets/editor-core.js', '/assets/studio.js']);
    expect(document.appended.map((e) => `${e.attrs['rel']} ${e.attrs['href']}`)).toEqual([
      'modulepreload /assets/editor-core.js',
      'modulepreload /assets/vendor.js',
      'stylesheet /assets/editor.css',
      'modulepreload /assets/studio.js',
    ]);
    expect(document.appended[3]?.attrs['integrity']).toBe('sha384-s');
    await loader.load('feature:studio-desktop');
    expect(importer).toHaveBeenCalledTimes(2);
    expect(loader.state('feature:studio-desktop')).toBe('loaded');
    expect(loader.urlOf('feature:studio-desktop')).toEqual({ ok: true, value: '/assets/studio.js' });
    expect(loader.urlOf('x:y').ok).toBe(false);
  });

  it('never fetches a denied chunk or a chunk with a denied dependency (I-8)', async () => {
    const canLoad = vi.fn((id: string) => (id === 'lib:editor-core' ? { allow: false as const, reason: 'upgrade' } : true));
    const { loader, importer, document, sink } = setup({ canLoad });
    const denied = await loader.load('feature:studio-desktop');
    expect(!denied.ok && denied.error.code).toBe('SF-LOAD-002');
    expect(!denied.ok && denied.error.details).toMatchObject({ chunk: 'lib:editor-core', reason: 'upgrade' });
    expect(importer).not.toHaveBeenCalled();
    expect(document.appended).toHaveLength(0);
    expect(loader.preload('feature:studio-desktop').ok).toBe(false);
    expect(document.appended).toHaveLength(0);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'loader/chunk-denied')).toBe(true);
    const plainDeny = setup({ canLoad: () => false });
    const r = await plainDeny.loader.load('feature:billing');
    expect(!r.ok && r.error.details['reason']).toBe('denied');
    const allowObj = setup({ canLoad: () => ({ allow: true }) });
    expect((await allowObj.loader.load('feature:billing')).ok).toBe(true);
  });

  it('never fetches chunks scoped to another profile (R12.10)', async () => {
    const { loader, importer } = setup({ profile: () => 'web:compact' });
    const r = await loader.load('feature:studio-desktop');
    expect(!r.ok && r.error.code).toBe('SF-LOAD-008');
    expect(importer).not.toHaveBeenCalled();
    expect(loader.check('feature:billing').ok).toBe(true);
  });

  it('unknown chunk ids fail with SF-LOAD-001', async () => {
    const { loader } = setup();
    const r = await loader.load('feature:nope');
    expect(!r.ok && r.error.code).toBe('SF-LOAD-001');
  });

  it('retries failed imports with cache-busting URLs and reports failures as SF-LOAD-003', async () => {
    let calls = 0;
    const importer = vi.fn(async (url: string) => {
      calls += 1;
      if (calls < 3) throw new TypeError('Failed to fetch dynamically imported module');
      return { url };
    });
    const { loader, sink } = setup({ importer });
    const r = await loader.load('feature:billing');
    expect(r.ok).toBe(true);
    expect(importer.mock.calls.map((c) => c[0])).toEqual(['/assets/billing.js', '/assets/billing.js?sf-retry=1', '/assets/billing.js?sf-retry=2']);
    const span = spans(sink.records, 'chunk.load')[0];
    expect(span?.attrs).toMatchObject({ chunk: 'feature:billing', attempts: 3, strategy: 'dynamic-import', codeSource: 'network', origin: 'demand' });
    expect(loader.inspect().find((c) => c.id === 'feature:billing')?.attempts).toBe(3);

    const failing = setup({ importer: async () => Promise.reject(new TypeError('boom')) });
    const f = await failing.loader.load('feature:billing');
    expect(!f.ok && f.error.code).toBe(ChunkFetchError.code);
    expect(failing.loader.state('feature:billing')).toBe('failed');
    expect(spans(failing.sink.records, 'chunk.load')[0]?.status).toBe('error');
    expect(failing.sink.records.some((r) => r.type === 'metric' && r.metric === 'loader/chunk-failed')).toBe(true);
    expect(failing.sink.records.some((r) => r.type === 'event' && r.name === 'lifecycle.loader/chunk.loading→failed')).toBe(true);
  });

  it('a failed chunk can be loaded again later', async () => {
    let fail = true;
    const { loader } = setup({ importer: async (url) => (fail ? Promise.reject(new TypeError('x')) : { url }), retry: { attempts: 1 } });
    expect((await loader.load('feature:billing')).ok).toBe(false);
    fail = false;
    expect((await loader.load('feature:billing')).ok).toBe(true);
    expect(loader.state('feature:billing')).toBe('loaded');
  });

  it('returns aborted for aborted signals', async () => {
    const { loader, importer } = setup();
    const controller = new AbortController();
    controller.abort();
    const r = await loader.load('feature:billing', { signal: controller.signal });
    expect(!r.ok && r.error.kind).toBe('aborted');
    expect(importer).not.toHaveBeenCalled();
  });

  it('aborting mid-flight resolves the caller with aborted', async () => {
    let release!: () => void;
    const importer = vi.fn(() => new Promise<unknown>((resolve) => (release = () => resolve({}))));
    const { loader } = setup({ importer });
    const controller = new AbortController();
    const pending = loader.load('feature:billing', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const r = await pending;
    expect(!r.ok && r.error.kind).toBe('aborted');
    release();
  });

  it('applies the isolation policy crossorigin to injected tags (R11.16b)', () => {
    const { loader, document } = setup({ isolation: crossOriginPolicy({ origin: 'https://app.example', mode: 'anonymous' }) });
    loader.preload('feature:agent-chat');
    loader.preload('feature:billing');
    expect(document.appended.map((e) => [e.attrs['href'], e.attrs['crossorigin']])).toEqual([
      ['https://cdn.example/chat.js', 'anonymous'],
      ['/assets/billing.js', undefined],
    ]);
    const all = crossOriginPolicy({ origin: 'https://app.example', mode: 'use-credentials', sameOrigin: true });
    expect(all.crossOriginFor('/x.js')).toBe('use-credentials');
    const same = crossOriginPolicy({ origin: 'https://app.example', mode: 'anonymous' });
    expect(same.crossOriginFor('https://app.example/x.js')).toBeUndefined();
  });

  it('preload marks chunks preloaded and counts a warmup hit on later demand', async () => {
    const { loader, sink } = setup();
    expect(loader.preload('feature:billing', { origin: 'speculative' }).ok).toBe(true);
    expect(loader.state('feature:billing')).toBe('preloaded');
    expect(loader.wasted()).toEqual(['feature:billing']);
    await loader.load('feature:billing');
    expect(loader.wasted()).toEqual([]);
    const hits = sink.records.filter((r) => r.type === 'metric' && r.metric === 'loader/warmup-hit');
    expect(hits).toHaveLength(1);
    expect(loader.inspect().find((c) => c.id === 'feature:billing')).toMatchObject({ warmedBy: 'speculative', demanded: true, state: 'loaded' });
  });

  it('works without a document (workers)', async () => {
    const { loader } = setup({ document: undefined });
    expect(loader.preload('feature:billing').ok).toBe(true);
    expect((await loader.load('feature:billing')).ok).toBe(true);
  });

  it('chunkLoadFunction adapts to a throwing load(signal) (runtime FeatureManifest.load)', async () => {
    const { loader } = setup({ canLoad: (id) => id !== 'feature:billing' });
    const load = chunkLoadFunction<{ url: string }>(loader, 'feature:agent-chat');
    await expect(load(new AbortController().signal)).resolves.toEqual({ url: 'https://cdn.example/chat.js' });
    await expect(chunkLoadFunction(loader, 'feature:billing')(new AbortController().signal)).rejects.toMatchObject({ code: 'SF-LOAD-002' });
  });

  it('classifies code source from resource timing', () => {
    expect(classifyCodeSource(undefined)).toBe('unknown');
    expect(classifyCodeSource({ workerStart: 3, transferSize: 0 })).toBe('sw');
    expect(classifyCodeSource({ deliveryType: 'cache' })).toBe('http-cache');
    expect(classifyCodeSource({ transferSize: 0, decodedBodySize: 10 })).toBe('http-cache');
    expect(classifyCodeSource({ transferSize: 100 })).toBe('network');
    expect(classifyCodeSource({})).toBe('unknown');
  });
});

describe('strategies', () => {
  it('import-map strategy imports bare specifiers, falling back to URLs on retry', async () => {
    let calls = 0;
    const importer = vi.fn(async (s: string) => {
      calls += 1;
      if (calls === 1) throw new TypeError('x');
      return s;
    });
    const { loader } = setup({ strategy: importMapStrategy(importer) });
    const r = await loader.load('feature:billing');
    expect(importer.mock.calls.map((c) => c[0])).toEqual(['@sf/chunk/feature:billing', '/assets/billing.js?sf-retry=1']);
    expect(r).toEqual({ ok: true, value: '/assets/billing.js?sf-retry=1' });
  });

  it('installImportMap injects one importmap script or reports SF-LOAD-011', () => {
    const document = fakeDocument();
    expect(installImportMap(document, manifest, { supports: () => true }).ok).toBe(true);
    const script = document.appended[0];
    expect(script?.attrs['type']).toBe('importmap');
    expect(JSON.parse(script?.textContent ?? '{}').imports['@sf/chunk/feature:billing']).toBe('/assets/billing.js');
    const unsupported = installImportMap(fakeDocument(), manifest, { supports: () => false });
    expect(!unsupported.ok && unsupported.error.code).toBe('SF-LOAD-011');
    // default feature detection (happy-dom) does not throw
    expect(typeof installImportMap(fakeDocument(), manifest).ok).toBe('boolean');
  });

  it('dynamic import strategy maps abort errors to aborted (not retried)', async () => {
    const strategy = dynamicImportStrategy(async () => {
      throw new DOMException('x', 'AbortError');
    });
    const r = await strategy.load({ chunk: manifest.chunks['feature:billing']!, manifest, attempt: 1, signal: new AbortController().signal });
    expect(!r.ok && r.error.kind).toBe('aborted');
  });

  describe('federation', () => {
    const container = (overrides: Partial<RemoteContainer> = {}): RemoteContainer & { init: ReturnType<typeof vi.fn> } => ({
      init: vi.fn(),
      get: vi.fn(async (module: string) => () => ({ module })),
      ...overrides,
    }) as RemoteContainer & { init: ReturnType<typeof vi.fn> };

    it('loads exposed modules; container initialized once with host singletons', async () => {
      const c = container();
      const loadContainer = vi.fn(async () => c);
      const shared = { mobx: { version: '7.1.0', get: () => 'mobx' } };
      const { loader, document } = setup({ remoteStrategy: federationStrategy({ shared, loadContainer }) });
      const r = await loader.load('remote:inspector');
      expect(r).toEqual({ ok: true, value: { module: './Inspector' } });
      expect(c.init).toHaveBeenCalledWith(shared);
      expect(document.appended).toHaveLength(0);
      const strategy = federationStrategy({ shared, loadContainer });
      const chunkDef = manifest.chunks['remote:inspector']!;
      await strategy.load({ chunk: chunkDef, manifest, attempt: 1, signal: new AbortController().signal });
      await strategy.load({ chunk: chunkDef, manifest, attempt: 2, signal: new AbortController().signal });
      expect(loadContainer).toHaveBeenCalledTimes(2); // once per strategy instance
    });

    it('shared version mismatch is a typed error (SF-LOAD-004), never retried', async () => {
      const loadContainer = vi.fn(async () => container());
      const { loader } = setup({ remoteStrategy: federationStrategy({ shared: { mobx: { version: '6.9.0', get: () => 0 } }, loadContainer }) });
      const r = await loader.load('remote:inspector');
      expect(!r.ok && r.error.code).toBe('SF-LOAD-004');
      expect(!r.ok && r.error.details).toMatchObject({ shared: 'mobx', required: '^7.0.0', provided: '6.9.0' });
      expect(loadContainer).not.toHaveBeenCalled();
      const strict = federationStrategy({
        shared: { mobx: { version: '7.1.0', get: () => 0 } },
        loadContainer: async () => container({ requiredShared: { lit: '^3.0.0' } }),
      });
      const s = await strict.load({ chunk: manifest.chunks['remote:inspector']!, manifest, attempt: 1, signal: new AbortController().signal });
      expect(!s.ok && s.error.code).toBe('SF-LOAD-004');
    });

    it('container load / init / missing module failures are SF-LOAD-005', async () => {
      const req = { chunk: manifest.chunks['remote:inspector']!, manifest, attempt: 1, signal: new AbortController().signal };
      const shared = { mobx: { version: '7.0.0', get: () => 0 } };
      const a = await federationStrategy({ shared, loadContainer: async () => Promise.reject(new Error('404')) }).load(req);
      expect(!a.ok && a.error.code).toBe('SF-LOAD-005');
      const b = await federationStrategy({ shared, loadContainer: async () => container({ init: () => Promise.reject(new Error('x')) }) }).load(req);
      expect(!b.ok && b.error.code).toBe('SF-LOAD-005');
      const c = await federationStrategy({ shared, loadContainer: async () => container({ get: async () => Promise.reject(new Error('nope')) }) }).load(req);
      expect(!c.ok && c.error.code).toBe('SF-LOAD-005');
      const d = await federationStrategy({ shared, importer: async () => ({ notAContainer: true }) }).load(req);
      expect(!d.ok && d.error.code).toBe('SF-LOAD-005');
      const e = await federationStrategy({ shared, importer: async () => container() }).load(req);
      expect(e.ok).toBe(true);
      const f = await federationStrategy({ shared }).load({ ...req, chunk: manifest.chunks['feature:billing']! });
      expect(!f.ok && f.error.code).toBe('SF-LOAD-005');
    });

    it('checkShared reports missing singletons', () => {
      const r = checkShared('remote:x', {}, { lit: '^3' });
      expect(!r.ok && r.error.details['provided']).toBeNull();
      expect(checkShared('remote:x', { lit: { version: '3.3.3', get: () => 0 } }, { lit: '^3' }).ok).toBe(true);
    });
  });

  it('satisfiesRange covers the operators used for singletons', () => {
    const table: [string, string, boolean][] = [
      ['7.1.0', '^7.0.0', true],
      ['8.0.0', '^7.0.0', false],
      ['6.9.0', '^7.0.0', false],
      ['0.3.1', '^0.3.0', true],
      ['0.4.0', '^0.3.0', false],
      ['0.0.3', '^0.0.3', true],
      ['0.0.4', '^0.0.3', false],
      ['7.1.5', '~7.1.0', true],
      ['7.2.0', '~7.1.0', false],
      ['7.1.0', '7.1.0', true],
      ['7.1.1', '7.1.0', false],
      ['7.9.9', '7', true],
      ['7.2.1', '7.2', true],
      ['7.3.0', '7.2', false],
      ['1.0.0', '*', true],
      ['2.0.0', '>=1.0.0 <2.0.0', false],
      ['1.5.0', '>=1.0.0 <2.0.0', true],
      ['1.0.0', '>1.0.0', false],
      ['1.0.0', '<=1.0.0', true],
      ['3.0.0', '^2.0.0 || ^3.0.0', true],
      ['x.y', '^1.0.0', false],
      ['1.0.0', '^abc', false],
      ['1.0.0', '=1.0.0', true],
    ];
    for (const [version, range, expected] of table) expect([version, range, satisfiesRange(version, range)]).toEqual([version, range, expected]);
  });
});
