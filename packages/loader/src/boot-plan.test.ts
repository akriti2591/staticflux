import { createMemorySink, createTelemetry, type SpanEndRecord } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createChunkLoader,
  defineBootPlan,
  eagerReport,
  emitProfilePreloads,
  MANIFEST_FORMAT,
  planChunks,
  type ProfileLike,
  runBootPlan,
  selectBootPlan,
  type SfManifest,
  validateBootPlan,
} from './index.js';

const manifest: SfManifest = {
  format: MANIFEST_FORMAT,
  buildId: 'b',
  base: '/a/',
  chunks: {
    'lib:shell': { id: 'lib:shell', files: ['shell.aaaaaaaa.js'], css: ['shell.aaaaaaaa.css'], deps: [], tier: 'critical', load: 'eager', reason: 'shell frame', sizeKb: 12 },
    'lib:history-memory': { id: 'lib:history-memory', files: ['hist.bbbbbbbb.js'], css: [], deps: [], tier: 'on-demand', load: 'lazy', profiles: ['embed-agent-host:compact'], sizeKb: 2 },
    'lib:host-bridge': { id: 'lib:host-bridge', files: ['bridge.cccccccc.js'], css: [], deps: [], tier: 'on-demand', load: 'lazy', profiles: ['embed-agent-host:compact'] },
    'feature:studio-desktop': { id: 'feature:studio-desktop', files: ['studio.dddddddd.js'], css: [], deps: ['lib:shell'], tier: 'on-demand', load: 'lazy', profiles: ['web:expanded'], sizeKb: 80 },
    'feature:studio-mobile': { id: 'feature:studio-mobile', files: ['studio-m.eeeeeeee.js'], css: [], deps: ['lib:shell'], tier: 'on-demand', load: 'lazy', profiles: ['web:compact'] },
    'lib:editor-eager': { id: 'lib:editor-eager', files: ['ed.ffffffff.js'], css: [], deps: [], tier: 'on-demand', load: 'eager', reason: 'deep links', eagerProfiles: ['web:expanded'], sizeKb: 5 },
  },
};

const profile = (hostMode: string, formFactor: string): ProfileLike => ({ hostMode, formFactor, key: `${hostMode}:${formFactor}` });

const fallback = defineBootPlan({ id: 'default', critical: ['lib:shell'] });
const webExpanded = defineBootPlan({
  id: 'web-expanded',
  match: { hostModes: ['web', 'pwa'], formFactors: ['expanded', 'medium'] },
  critical: ['lib:shell'],
  preload: ['feature:studio-desktop'],
  shellPreset: 'desktop',
  historyStrategy: 'navigation-api',
});
const webAny = defineBootPlan({ id: 'web', match: { hostModes: ['web'] }, critical: ['lib:shell'], preload: ['feature:studio-mobile'] });
const embed = defineBootPlan({
  id: 'embed',
  match: { hostModes: ['embed-agent-host'] },
  critical: ['lib:shell'],
  eager: [{ chunk: 'lib:history-memory', reason: 'memory history synchronized with host' }],
  hostBridge: 'lib:host-bridge',
  historyStrategy: 'memory',
});
const plans = [fallback, webAny, webExpanded, embed];

describe('boot plans', () => {
  it('defaults lists and keeps declared fields', () => {
    expect(fallback).toMatchObject({ kind: 'boot-plan', critical: ['lib:shell'], eager: [], preload: [] });
    expect(planChunks(embed)).toEqual(['lib:shell', 'lib:history-memory', 'lib:host-bridge']);
  });

  it('selects the most specific matching plan (ties: declaration order)', () => {
    const pick = (p: ProfileLike): string | false => {
      const r = selectBootPlan(plans, p);
      return r.ok && r.value.id;
    };
    expect(pick(profile('web', 'expanded'))).toBe('web-expanded');
    expect(pick(profile('web', 'compact'))).toBe('web');
    expect(pick(profile('pwa', 'compact'))).toBe('default');
    expect(pick(profile('embed-agent-host', 'compact'))).toBe('embed');
    const none = selectBootPlan([webAny], profile('pwa', 'compact'));
    expect(!none.ok && none.error.code).toBe('SF-LOAD-009');
  });

  it('validates eager reasons at runtime (R12.12)', () => {
    expect(validateBootPlan(embed).ok).toBe(true);
    const bad = { ...embed, eager: [{ chunk: 'lib:x', reason: '' }] } as typeof embed;
    const r = validateBootPlan(bad);
    expect(!r.ok && r.error.code).toBe('SF-LOAD-006');
  });

  it('emits per-profile preload manifests; other modes\' chunks are excluded', () => {
    const emitted = emitProfilePreloads(manifest, plans, [profile('web', 'expanded'), profile('web', 'compact'), profile('embed-agent-host', 'compact')]);
    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    const out = emitted.value;
    expect(out['web:expanded']).toMatchObject({ plan: 'web-expanded', modulepreload: ['/a/shell.aaaaaaaa.js', '/a/studio.dddddddd.js'], stylesheets: ['/a/shell.aaaaaaaa.css'] });
    expect(out['web:compact']?.modulepreload).toEqual(['/a/shell.aaaaaaaa.js', '/a/studio-m.eeeeeeee.js']);
    expect(out['embed-agent-host:compact']?.modulepreload).toEqual(['/a/shell.aaaaaaaa.js', '/a/hist.bbbbbbbb.js', '/a/bridge.cccccccc.js']);
    expect(out['web:expanded']?.precache.map((p) => p.url)).toEqual(['/a/shell.aaaaaaaa.js', '/a/shell.aaaaaaaa.css', '/a/studio.dddddddd.js']);
    const failing = emitProfilePreloads(manifest, [webAny], [profile('pwa', 'compact')]);
    expect(failing.ok).toBe(false);
    const unknown = emitProfilePreloads(manifest, [defineBootPlan({ id: 'x', critical: ['lib:nope'] })], [profile('web', 'compact')]);
    expect(!unknown.ok && unknown.error.code).toBe('SF-LOAD-001');
  });

  it('reports eager boot cost per profile from declarations and plans', () => {
    const web = eagerReport(manifest, webExpanded, 'web:expanded');
    expect(web.entries).toEqual([
      { chunk: 'lib:shell', reason: 'shell frame', sizeKb: 12, source: 'declaration' },
      { chunk: 'lib:editor-eager', reason: 'deep links', sizeKb: 5, source: 'declaration' },
    ]);
    expect(web.totalKb).toBe(17);
    const emb = eagerReport(manifest, embed, 'embed-agent-host:compact');
    expect(emb.entries.map((e) => [e.chunk, e.source])).toEqual([
      ['lib:shell', 'declaration'],
      ['lib:history-memory', 'plan'],
    ]);
    expect(eagerReport(manifest, undefined).entries).toHaveLength(2);
  });

  it('runBootPlan preloads, loads critical then eager (spans with reasons), fails boot on critical failure', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ random: () => 0.5 });
    telemetry.addSink(sink);
    const importer = vi.fn(async (url: string) => ({ url }));
    const loader = createChunkLoader({ manifest, telemetry, importer, document: undefined, retry: { attempts: 1 }, profile: () => 'embed-agent-host:compact' });
    const run = await runBootPlan(embed, { loader, telemetry, profile: 'embed-agent-host:compact' });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.eager).toEqual([
      { chunk: 'lib:shell', ok: true },
      { chunk: 'lib:history-memory', ok: true },
    ]);
    expect(loader.state('lib:host-bridge')).toBe('preloaded');
    expect(importer.mock.calls.map((c) => c[0])).toEqual(['/a/shell.aaaaaaaa.js', '/a/hist.bbbbbbbb.js']);
    const eagerSpans = sink.records.filter((r): r is SpanEndRecord => r.type === 'span' && r.name === 'boot.eager');
    expect(eagerSpans.map((s) => s.attrs['reason'])).toEqual(['shell frame', 'memory history synchronized with host']);
    const planSpan = sink.records.find((r): r is SpanEndRecord => r.type === 'span' && r.name === 'boot.plan');
    expect(planSpan?.attrs).toMatchObject({ plan: 'embed', eagerKb: 14 });
    expect(sink.records.filter((r) => r.type === 'metric' && r.metric === 'loader/eager-boot-cost')).toHaveLength(2);

    const webLoader = createChunkLoader({ manifest, telemetry, importer, document: undefined, retry: { attempts: 1 }, profile: () => 'web:compact' });
    const skipped = await runBootPlan(webExpanded, { loader: webLoader, telemetry, profile: 'web:compact' });
    expect(skipped.ok).toBe(true);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'boot.preload-skipped')).toBe(true);

    const failingLoader = createChunkLoader({ manifest, importer: async () => Promise.reject(new TypeError('x')), document: undefined, retry: { attempts: 1 } });
    const failed = await runBootPlan(fallback, { loader: failingLoader });
    expect(!failed.ok && failed.error.code).toBe('SF-LOAD-003');
    const invalid = await runBootPlan({ ...embed, eager: [{ chunk: 'lib:shell', reason: '' }] }, { loader });
    expect(!invalid.ok && invalid.error.code).toBe('SF-LOAD-006');

    const eagerFails = createChunkLoader({ manifest, importer, document: undefined, retry: { attempts: 1 }, canLoad: (id) => id !== 'lib:history-memory' });
    const partial = await runBootPlan(embed, { loader: eagerFails });
    // No profile given: profile-scoped eager declarations apply too.
    expect(partial.ok && partial.value.eager).toEqual([
      { chunk: 'lib:shell', ok: true },
      { chunk: 'lib:editor-eager', ok: true },
      { chunk: 'lib:history-memory', ok: false },
    ]);
  });
});
