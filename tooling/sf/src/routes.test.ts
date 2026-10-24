// @vitest-environment node
import { bindCapability, defineRoute } from '@staticflux/router';
import { defineFeature, featureRef } from '@staticflux/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { checkRoutes, formatRoutesJson, formatRoutesText, loadRoutesModule, readRoutesExports, ROUTE_ISSUES, type RoutesInput } from './routes.js';
import { captureIo, type TempDir, tempDir } from './test-helpers.js';

const load = async (): Promise<{ mount(): void }> => ({ mount: () => undefined });

// Fixture ids are intentionally un-namespaced to exercise sf's structural reading; cast for the typed APIs.
const fid = (id: string): `${string}/${string}` => id as `${string}/${string}`;

// Real router/runtime values: the structural shapes sf reads must match them.
const features = [
  defineFeature({ id: fid('studio-desktop'), weight: 'heavy', modes: ['expanded'], load }),
  defineFeature({ id: fid('studio-compact'), weight: 'warm', modes: ['compact'], load }),
  defineFeature({ id: fid('chat'), weight: 'cheap', load }),
  defineFeature({ id: fid('chat-embed'), weight: 'cheap', modes: ['embed-iframe'], load }),
  defineFeature({ id: fid('telemetry-panel'), weight: 'cheap', headless: true, load }),
  defineFeature({ id: fid('onboarding'), weight: 'cheap', load }),
];
const root = defineRoute({ id: 'app/root', path: '/', abstract: true });
const routes = [
  root,
  defineRoute({ id: 'studio/editor', path: 'studio/:doc', parent: root, feature: bindCapability('studio/editor', [{ feature: featureRef(fid('studio-desktop')) }, { feature: featureRef(fid('studio-compact')) }]) }),
  defineRoute({ id: 'chat/thread', path: 'chat', parent: root, feature: bindCapability('chat/thread', [{ feature: featureRef(fid('chat')) }, { feature: featureRef(fid('chat-embed')) }]) }),
];
const profiles = ['web:expanded', 'web:compact', 'web:medium'];

function input(): RoutesInput {
  const r = readRoutesExports({ routes, features, profiles }, 'test');
  if (!r.ok) throw r.error;
  return r.value;
}

describe('readRoutesExports', () => {
  it('reads real defineRoute/defineFeature values and profile forms', () => {
    const r = readRoutesExports(
      {
        routes: { a: routes[1] },
        features: { f: features[0] },
        profiles: ['web:expanded', { key: 'pwa:compact', hostMode: 'pwa', formFactor: 'compact' }, { hostMode: 'tv', formFactor: 'expanded' }, { key: 'x', modes: ['a', 'b'] }, { modes: ['c'] }],
      },
      'm',
    );
    expect(r.ok && r.value.profiles).toEqual([
      { key: 'web:expanded', modes: ['web', 'expanded'] },
      { key: 'pwa:compact', modes: ['pwa', 'compact'] },
      { key: 'tv:expanded', modes: ['tv', 'expanded'] },
      { key: 'x', modes: ['a', 'b'] },
      { key: 'c', modes: ['c'] },
    ]);
    expect(r.ok && r.value.routes.map((x) => x.id)).toEqual(['studio/editor']);
  });

  it('builds profiles from hostModes × formFactors', () => {
    const r = readRoutesExports({ routes: [], features: [], hostModes: ['web', 'pwa'], formFactors: ['compact', 'expanded'] }, 'm');
    expect(r.ok && r.value.profiles.map((p) => p.key)).toEqual(['web:compact', 'web:expanded', 'pwa:compact', 'pwa:expanded']);
  });

  it('rejects malformed exports with SF-TOOL-007', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ features: [], profiles }, 'exports no `routes`'],
      [{ routes: [{ id: 'x' }], features: [], profiles }, 'routes[0]'],
      [{ routes: [{ id: 'x/y', path: '/', feature: { capability: 1 } }], features: [], profiles }, 'not a capability binding'],
      [{ routes: [{ id: 'x/y', path: '/', feature: { capability: 'c/d', candidates: [{ feature: 'nope' }] } }], features: [], profiles }, 'candidates[0]'],
      [{ routes: [], profiles }, 'exports no `features`'],
      [{ routes: [], features: [{ id: 'f', modes: 'compact' }], profiles }, 'features[0]'],
      [{ routes: [], features: [], profiles: 'web:expanded' }, 'must be an array'],
      [{ routes: [], features: [], profiles: ['web'] }, 'profiles[0] "web"'],
      [{ routes: [], features: [], profiles: [42] }, 'profiles[0] must be'],
      [{ routes: [], features: [] }, 'declares no profiles'],
    ];
    for (const [exports, message] of cases) {
      const r = readRoutesExports(exports, 'm');
      expect(!r.ok && r.error.code).toBe('SF-TOOL-007');
      expect(!r.ok && r.error.message).toContain(message);
    }
  });
});

describe('checkRoutes (R18.7)', () => {
  it('reports every route/profile without a matching feature as an error', () => {
    const result = checkRoutes(input());
    expect(result.rows).toEqual([
      { route: 'studio/editor', path: '/studio/:doc', capability: 'studio/editor', selected: { 'web:expanded': 'studio-desktop', 'web:compact': 'studio-compact', 'web:medium': null } },
      { route: 'chat/thread', path: '/chat', capability: 'chat/thread', selected: { 'web:expanded': 'chat', 'web:compact': 'chat', 'web:medium': 'chat' } },
    ]);
    expect(result.unbound).toEqual(['app/root']);
    expect(result.errorCount).toBe(1);
    const [error] = result.issues;
    expect(error).toMatchObject({ severity: 'error', code: ROUTE_ISSUES.noFeature, route: 'studio/editor', profile: 'web:medium' });
    expect(error?.message).toContain('studio-desktop [expanded], studio-compact [compact]');
  });

  it('warns about shadowed candidates and notes unrouted (non-headless) features', () => {
    const result = checkRoutes(input());
    expect(result.issues.filter((i) => i.severity === 'warning').map((i) => [i.code, i.feature])).toEqual([[ROUTE_ISSUES.shadowed, 'chat-embed']]);
    expect(result.issues.filter((i) => i.severity === 'info').map((i) => i.feature)).toEqual(['onboarding']);
  });

  it('uses candidate modes over manifest modes, and flags unknown features and empty bindings', () => {
    const result = checkRoutes({
      routes: [
        { id: 'a/b', path: '/b', feature: { capability: 'a/b', candidates: [{ feature: { id: 'ghost' }, modes: ['compact'] }, { feature: { id: 'chat' }, modes: ['expanded'] }] } },
        { id: 'a/c', path: '/c', feature: { capability: 'a/c', candidates: [] } },
      ],
      features: [{ id: 'chat' }],
      profiles: [
        { key: 'web:compact', modes: ['web', 'compact'] },
        { key: 'web:expanded', modes: ['web', 'expanded'] },
        { key: 'web:medium', modes: ['web', 'medium'] },
      ],
    });
    expect(result.rows[0]?.selected).toEqual({ 'web:compact': 'ghost', 'web:expanded': 'chat', 'web:medium': null });
    expect(result.rows[1]?.selected).toEqual({ 'web:compact': null, 'web:expanded': null, 'web:medium': null });
    expect(result.issues.filter((i) => i.severity === 'error').map((i) => i.code).sort()).toEqual([ROUTE_ISSUES.noCandidates, ROUTE_ISSUES.noFeature, ROUTE_ISSUES.unknownFeature].sort());
  });

  it('formats a text matrix and JSON', () => {
    const result = checkRoutes(input());
    const text = formatRoutesText(result);
    expect(text).toContain('Routes: 2 bound, 1 without capability · profiles: 3 · errors: 1 · warnings: 1 · info: 1');
    expect(text).toContain('SF-ROUTES-NO-FEATURE');
    expect(text).toMatch(/studio\/editor\s+studio-desktop\s+studio-compact\s+MISSING/);
    expect((JSON.parse(formatRoutesJson(result)) as { errorCount: number }).errorCount).toBe(1);
    const empty = formatRoutesText(checkRoutes({ routes: [], features: [], profiles: [{ key: 'a', modes: ['a'] }] }));
    expect(empty).not.toContain('Route × profile');
  });
});

describe('sf routes', () => {
  let dir: TempDir | undefined;
  afterEach(() => dir?.dispose());

  const source = (complete: boolean) => `
const ref = (id) => ({ id });
export const features = [
  { kind: 'feature', id: 'studio-desktop', modes: ['expanded'] },
  { kind: 'feature', id: 'studio-compact', modes: ['compact'${complete ? ", 'medium'" : ''}] },
];
export const routes = [
  { kind: 'route', id: 'studio/editor', path: '/studio', feature: { kind: 'feature-selector', capability: 'studio/editor', candidates: [{ feature: ref('studio-desktop') }, { feature: ref('studio-compact') }], leave: 'unmount' } },
];
export const hostModes = ['web', 'embed-iframe'];
export const formFactors = ['compact', 'medium', 'expanded'];
`;

  it('exits 0 when complete, 1 with missing features, 2 on usage/load errors', async () => {
    dir = tempDir({ importable: true });
    dir.write('ok.mjs', source(true));
    dir.write('bad.mjs', source(false));
    const ok = captureIo(dir.root);
    expect(await runCli(['routes', 'ok.mjs'], ok)).toBe(0);
    expect(ok.out.join('\n')).toContain('errors: 0');
    const bad = captureIo(dir.root);
    expect(await runCli(['routes', 'bad.mjs', '--json'], bad)).toBe(1);
    const json = JSON.parse(bad.out.join('')) as { issues: { code: string; profile?: string }[] };
    expect(json.issues.filter((i) => i.code === 'SF-ROUTES-NO-FEATURE').map((i) => i.profile)).toEqual(['web:medium', 'embed-iframe:medium']);
    const usage = captureIo(dir.root);
    expect(await runCli(['routes'], usage)).toBe(2);
    expect(await runCli(['routes', 'missing.mjs'], usage)).toBe(2);
    dir.write('empty.mjs', 'export const routes = [];');
    expect(await runCli(['routes', 'empty.mjs'], usage)).toBe(2);
    expect(usage.errs.join('\n')).toMatch(/SF-TOOL-005[\s\S]*SF-TOOL-001[\s\S]*SF-TOOL-007/);
  });

  it('loadRoutesModule imports from disk', async () => {
    dir = tempDir({ importable: true });
    dir.write('ok.mjs', source(true));
    const r = await loadRoutesModule('ok.mjs', dir.root);
    expect(r.ok && r.value.profiles).toHaveLength(6);
  });
});
