import { bind, createInjector, createMemorySink, createTelemetry, unit } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  BootPlannerToken,
  bootPlanUnit,
  browserLoaderEnv,
  ChunkGateToken,
  ChunkLoaderToken,
  defineBootPlan,
  defineSpeculationRule,
  type LoaderEnv,
  LoaderEnvToken,
  LoaderProfileToken,
  loaderUnits,
  MANIFEST_FORMAT,
  manifestUnit,
  RemoteStrategyToken,
  type SfManifest,
  SpeculationEngineToken,
  speculationRuleUnit,
  WarmupAdvisorsToken,
  WarmupFactsToken,
  WarmupToken,
  NOMINAL_WARMUP_FACTS,
  type LoadStrategy,
} from './index.js';
import { contribution } from '@staticflux/core';

const manifest: SfManifest = {
  format: MANIFEST_FORMAT,
  buildId: 'b',
  base: '/',
  chunks: {
    'lib:shell': { id: 'lib:shell', files: ['shell.js'], css: [], deps: [], tier: 'critical', load: 'lazy' },
    'feature:agent-chat': { id: 'feature:agent-chat', files: ['chat.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
    'feature:billing': { id: 'feature:billing', files: ['billing.js'], css: [], deps: [], tier: 'speculative', load: 'lazy' },
    'remote:x': { id: 'remote:x', files: ['https://r/entry.js'], css: [], deps: [], tier: 'on-demand', load: 'lazy', remote: { entry: 'https://r/entry.js', module: './X' } },
  },
};

function testEnv(importer: LoaderEnv['importer']): LoaderEnv {
  return {
    document: undefined,
    importer,
    idle: (cb) => setTimeout(cb, 0),
    timer: (cb, ms) => {
      const h = setTimeout(cb, ms);
      return () => clearTimeout(h);
    },
    resourceTiming: () => undefined,
    intersectionObserver: undefined,
  };
}

describe('loader units', () => {
  it('wires loader, warmup, speculation and boot planner with overridable ports', async () => {
    const importer = vi.fn(async (url: string) => ({ url }));
    const sink = createMemorySink();
    const telemetry = createTelemetry({ random: () => 0.5 });
    telemetry.addSink(sink);
    const remote: LoadStrategy = { kind: 'federation', load: async () => ({ ok: true, value: 'remote-module' }) };
    const injector = createInjector({
      telemetry,
      units: [
        ...loaderUnits,
        manifestUnit(manifest),
        bind(unit({ id: 'test/env', provides: LoaderEnvToken, scope: 'app', create: () => testEnv(importer) }), { precedence: 'app' }),
        bind(unit({ id: 'test/gate', provides: ChunkGateToken, scope: 'app', create: () => (id: string) => id !== 'feature:billing' }), { precedence: 'app' }),
        bind(unit({ id: 'test/profile', provides: LoaderProfileToken, scope: 'app', create: () => () => ({ key: 'web:expanded', hostMode: 'web', formFactor: 'expanded' }) }), { precedence: 'app' }),
        bind(unit({ id: 'test/facts', provides: WarmupFactsToken, scope: 'app', create: () => () => NOMINAL_WARMUP_FACTS }), { precedence: 'app' }),
        contribution({ id: 'test/remote', provides: RemoteStrategyToken, scope: 'app', create: () => remote }),
        contribution({ id: 'test/advisor', provides: WarmupAdvisorsToken, scope: 'app', create: () => ({ id: 'a', rank: (c: readonly string[]) => [...c].reverse() as never }) }),
        speculationRuleUnit(defineSpeculationRule({ id: 'billing/cta', chunks: ['feature:billing'], eagerness: 'eager' })),
        bootPlanUnit(defineBootPlan({ id: 'default', critical: ['lib:shell'] })),
      ],
    });
    const loader = await injector.get(ChunkLoaderToken);
    expect(loader.ok).toBe(true);
    if (!loader.ok) return;
    expect(await loader.value.load('feature:agent-chat')).toEqual({ ok: true, value: { url: '/chat.js' } });
    expect(await loader.value.load('remote:x')).toEqual({ ok: true, value: 'remote-module' });
    const denied = await loader.value.load('feature:billing');
    expect(!denied.ok && denied.error.code).toBe('SF-LOAD-002');

    const planner = await injector.get(BootPlannerToken);
    expect(planner.ok && planner.value.current().ok).toBe(true);
    const run = planner.ok ? await planner.value.run() : undefined;
    expect(run?.ok).toBe(true);

    const engine = await injector.get(SpeculationEngineToken);
    expect(engine.ok && engine.value.signal('billing/cta', 'viewport')).toBe('triggered');
    if (engine.ok) await engine.value.settled();

    const warmup = await injector.get(WarmupToken);
    expect(warmup.ok).toBe(true);
    if (warmup.ok) expect((await warmup.value.warmLikely()).results).toEqual([{ id: 'feature:agent-chat', outcome: 'already-loaded' }]);
    await injector.dispose();
    if (warmup.ok) expect(warmup.value.state).toBe('disposed');
  });

  it('boot planner falls back without a profile, and errors without a fallback plan', async () => {
    const make = (plans: readonly ReturnType<typeof defineBootPlan>[]) =>
      createInjector({
        units: [
          ...loaderUnits,
          manifestUnit(manifest),
          bind(unit({ id: 'test/env', provides: LoaderEnvToken, scope: 'app', create: () => testEnv(async () => ({})) }), { precedence: 'app' }),
          ...plans.map((p) => bootPlanUnit(p)),
        ],
      });
    const withFallback = await make([defineBootPlan({ id: 'web', match: { hostModes: ['web'] } }), defineBootPlan({ id: 'any' })]).get(BootPlannerToken);
    expect(withFallback.ok && withFallback.value.current()).toMatchObject({ ok: true, value: { id: 'any' } });
    const without = await make([defineBootPlan({ id: 'web', match: { hostModes: ['web'] } })]).get(BootPlannerToken);
    expect(without.ok && without.value.current().ok).toBe(false);
    const run = without.ok ? await without.value.run() : undefined;
    expect(run?.ok === false && run.error.code).toBe('SF-LOAD-009');
  });

  it('browser env is feature-detected', () => {
    const env = browserLoaderEnv();
    expect(typeof env.importer).toBe('function');
    expect(typeof env.idle).toBe('function');
    expect(env.resourceTiming('/nope.js')).toBeUndefined();
  });
});
