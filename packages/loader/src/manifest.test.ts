import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  budgetKbOf,
  chunk,
  chunkAttributor,
  chunkClosure,
  chunkSpecifier,
  DEFAULT_CHUNK_BUDGETS_KB,
  fileUrl,
  getChunk,
  isChunkId,
  MANIFEST_FORMAT,
  parseManifest,
  precacheList,
  type SfManifest,
  toImportMap,
  urlsFor,
  urlToChunkMap,
} from './index.js';

const manifest: SfManifest = {
  format: MANIFEST_FORMAT,
  buildId: 'b1',
  base: '/assets/',
  chunks: {
    'lib:shell': { id: 'lib:shell', files: ['shell.aaaaaaaa.js', 'vendor.bbbbbbbb.js'], css: ['shell.cccccccc.css'], deps: [], tier: 'critical', load: 'eager', reason: 'frame', sizeKb: 12 },
    'lib:editor-core': { id: 'lib:editor-core', files: ['editor-core.dddddddd.js', 'vendor.bbbbbbbb.js'], css: [], deps: [], tier: 'on-demand', load: 'lazy', sizeKb: 20 },
    'feature:studio-desktop': {
      id: 'feature:studio-desktop',
      files: ['studio.eeeeeeee.js'],
      css: ['studio.ffffffff.css'],
      deps: ['lib:editor-core'],
      tier: 'on-demand',
      load: 'lazy',
      profiles: ['web:expanded'],
      integrity: { 'studio.eeeeeeee.js': 'sha384-x' },
    },
    'feature:agent-chat': { id: 'feature:agent-chat', files: ['chat.gggggggg.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
    'feature:billing': { id: 'feature:billing', files: ['https://cdn.example/billing.hhhhhhhh.js'], css: [], deps: [], tier: 'speculative', load: 'lazy' },
  },
};

describe('chunk declarations', () => {
  it('defaults to lazy on-demand and keeps literal ids', () => {
    const c = chunk('feature:studio-desktop', { budget: { category: 'heavy' } });
    expect(c).toMatchObject({ kind: 'chunk', id: 'feature:studio-desktop', tier: 'on-demand', load: 'lazy' });
    expectTypeOf(c.id).toEqualTypeOf<'feature:studio-desktop'>();
  });

  it('eager requires a reason (type-level) and keeps it', () => {
    const c = chunk('lib:shell', { load: 'eager', reason: 'frame', tier: 'critical' });
    expect(c.load).toBe('eager');
    if (c.load === 'eager') expect(c.reason).toBe('frame');
    // @ts-expect-error — eager without reason does not type-check (R12.12)
    chunk('lib:x', { load: 'eager' });
  });

  it('budgets resolve from category defaults or overrides', () => {
    expect(budgetKbOf(undefined)).toBeUndefined();
    expect(budgetKbOf({ category: 'feature' })).toBe(DEFAULT_CHUNK_BUDGETS_KB.feature);
    expect(budgetKbOf({ category: 'heavy', maxKb: 180, reason: 'tight' })).toBe(180);
    expect(budgetKbOf({})).toBeUndefined();
  });

  it('validates chunk id shape', () => {
    expect(isChunkId('feature:studio')).toBe(true);
    expect(isChunkId('locale:de/studio')).toBe(true);
    expect(isChunkId('nocolon')).toBe(false);
    expect(isChunkId('feature: x')).toBe(false);
  });
});

describe('manifest', () => {
  it('parses a valid manifest and rejects malformed ones with SF-LOAD-007', () => {
    expect(parseManifest(JSON.parse(JSON.stringify(manifest))).ok).toBe(true);
    const cases: unknown[] = [
      null,
      { ...manifest, format: 'other' },
      { ...manifest, buildId: 1 },
      { ...manifest, chunks: null },
      { ...manifest, chunks: { 'a:b': 1 } },
      { ...manifest, chunks: { 'a:b': { ...manifest.chunks['feature:agent-chat'], id: 'a:c' } } },
      { ...manifest, chunks: { 'a:b': { id: 'a:b', files: [], css: [], deps: [], tier: 'likely', load: 'lazy' } } },
      { ...manifest, chunks: { 'a:b': { id: 'a:b', files: ['x'], css: 'x', deps: [], tier: 'likely', load: 'lazy' } } },
      { ...manifest, chunks: { 'a:b': { id: 'a:b', files: ['x'], css: [], deps: [], tier: 'hot', load: 'lazy' } } },
      { ...manifest, chunks: { 'a:b': { id: 'a:b', files: ['x'], css: [], deps: [], tier: 'likely', load: 'sometimes' } } },
      { ...manifest, chunks: { 'a:b': { id: 'a:b', files: ['x'], css: [], deps: [], tier: 'likely', load: 'eager' } } },
      { ...manifest, chunks: { 'a:b': { id: 'a:b', files: ['x'], css: [], deps: ['z:z'], tier: 'likely', load: 'lazy' } } },
    ];
    for (const value of cases) {
      const parsed = parseManifest(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe('SF-LOAD-007');
    }
  });

  it('getChunk reports unknown ids as SF-LOAD-001', () => {
    const missing = getChunk(manifest, 'feature:nope');
    expect(!missing.ok && missing.error.code).toBe('SF-LOAD-001');
    expect(getChunk(manifest, 'feature:agent-chat').ok).toBe(true);
  });

  it('fileUrl prefixes base unless absolute', () => {
    expect(fileUrl(manifest, 'a.js')).toBe('/assets/a.js');
    expect(fileUrl(manifest, '/x/a.js')).toBe('/x/a.js');
    expect(fileUrl(manifest, 'https://cdn/a.js')).toBe('https://cdn/a.js');
  });

  it('closure lists deps first, once, and tolerates cycles', () => {
    const closure = chunkClosure(manifest, ['feature:studio-desktop', 'lib:editor-core']);
    expect(closure.ok && closure.value.map((c) => c.id)).toEqual(['lib:editor-core', 'feature:studio-desktop']);
    const cyclic: SfManifest = {
      ...manifest,
      chunks: {
        'a:a': { id: 'a:a', files: ['a.js'], css: [], deps: ['b:b'], tier: 'likely', load: 'lazy' },
        'b:b': { id: 'b:b', files: ['b.js'], css: [], deps: ['a:a'], tier: 'likely', load: 'lazy' },
      },
    };
    const c2 = chunkClosure(cyclic, ['a:a']);
    expect(c2.ok && c2.value.map((c) => c.id)).toEqual(['b:b', 'a:a']);
    expect(chunkClosure(manifest, ['x:y']).ok).toBe(false);
  });

  it('urlsFor dedupes shared files and collects css', () => {
    const urls = urlsFor(manifest, ['lib:shell', 'feature:studio-desktop']);
    expect(urls.ok && urls.value).toEqual({
      entries: ['/assets/shell.aaaaaaaa.js', '/assets/editor-core.dddddddd.js', '/assets/studio.eeeeeeee.js'],
      modules: ['/assets/shell.aaaaaaaa.js', '/assets/vendor.bbbbbbbb.js', '/assets/editor-core.dddddddd.js', '/assets/studio.eeeeeeee.js'],
      stylesheets: ['/assets/shell.cccccccc.css', '/assets/studio.ffffffff.css'],
    });
    expect(urlsFor(manifest, ['x:y']).ok).toBe(false);
  });

  it('precacheList emits the critical tier (Workbox shape), profile-aware, revisions for unhashed files', () => {
    expect(precacheList(manifest)).toEqual([
      { url: '/assets/shell.aaaaaaaa.js', revision: null },
      { url: '/assets/vendor.bbbbbbbb.js', revision: null },
      { url: '/assets/shell.cccccccc.css', revision: null },
    ]);
    const withLikely = precacheList(manifest, { tiers: ['likely'], isHashed: () => false });
    expect(withLikely.map((e) => e.url)).toContain('/assets/chat.gggggggg.js');
    expect(withLikely.every((e) => e.revision === 'b1')).toBe(true);
    const onDemand = precacheList(manifest, { tiers: ['on-demand'], profile: 'web:compact' });
    expect(onDemand.map((e) => e.url)).not.toContain('/assets/studio.eeeeeeee.js');
    expect(precacheList(manifest, { tiers: ['on-demand'], profile: 'web:expanded' }).map((e) => e.url)).toContain('/assets/studio.eeeeeeee.js');
  });

  it('toImportMap maps stable specifiers to hashed URLs with integrity', () => {
    const map = toImportMap(manifest);
    expect(map.imports[chunkSpecifier('feature:agent-chat')]).toBe('/assets/chat.gggggggg.js');
    expect(map.integrity).toEqual({ '/assets/studio.eeeeeeee.js': 'sha384-x' });
    const noIntegrity = toImportMap({ ...manifest, chunks: { 'feature:agent-chat': manifest.chunks['feature:agent-chat']! } });
    expect(noIntegrity.integrity).toBeUndefined();
    const remote = toImportMap({
      ...manifest,
      chunks: { 'remote:x': { id: 'remote:x', files: ['r.js'], css: [], deps: [], tier: 'on-demand', load: 'lazy', remote: { entry: 'r.js', module: './X' } } },
    });
    expect(remote.imports).toEqual({});
  });

  it('url → chunk attribution prefers entry files over shared vendor files', () => {
    const map = urlToChunkMap(manifest);
    expect(map.get('/assets/vendor.bbbbbbbb.js')).toBe('lib:shell');
    expect(map.get('/assets/studio.ffffffff.css')).toBe('feature:studio-desktop');
    const attribute = chunkAttributor(manifest);
    expect(attribute('https://app.example/assets/chat.gggggggg.js')).toBe('feature:agent-chat');
    expect(attribute('/assets/editor-core.dddddddd.js')).toBe('lib:editor-core');
    expect(attribute('/other.js')).toBeUndefined();
  });
});
