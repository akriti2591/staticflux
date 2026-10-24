import { createMemorySink, createTelemetry, defineError, err, ok, token, unit } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  bootApp,
  CommandPolicyToken,
  defineFeature,
  FeatureHostToken,
  FeatureLoaderToken,
  type FeatureLoader,
  FeatureManifestsToken,
  manifestFeatureLoader,
  FrameSchedulerToken,
  PausedRequestPolicyToken,
  ResourceManagerToken,
  runtimeUnits,
  SubsystemsToken,
  SupervisorToken,
} from './index.js';

const Boom = defineError('SF-TEST-BOOT', 'unavailable', 'boom', 'test');
const ShellToken = token('test/shell').type<{ ready: boolean }>();

const editorFeature = defineFeature({ id: 'test/editor', weight: 'warm', load: async () => ({}) });
const editorContribution = unit({
  id: 'test/editor-manifest',
  provides: FeatureManifestsToken,
  scope: 'app',
  create: () => editorFeature as never,
});

describe('bootApp', () => {
  it('boots injector → supervisor → critical units → running, with app.boot/boot.core/boot.critical spans', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const shellInit = vi.fn(() => ok());
    const shellUnit = unit({ id: 'test/shell-unit', provides: ShellToken, scope: 'app', critical: true, create: () => ({ ready: true }), init: shellInit });
    const result = await bootApp({ telemetry, units: [...runtimeUnits, shellUnit, editorContribution], sleep: async () => ok() });
    if (!result.ok) throw result.error;
    const app = result.value;
    expect(app.supervisor.state).toBe('running');
    expect(shellInit).toHaveBeenCalledOnce();
    expect((await app.injector.get(SupervisorToken)).ok && app.supervisor).toBeTruthy();
    const host = await app.injector.get(FeatureHostToken);
    expect(host.ok && host.value.has('test/editor')).toBe(true);
    expect((await app.injector.get(ResourceManagerToken)).ok).toBe(true);

    const spans = sink.records.filter((r) => r.type === 'span');
    const boot = spans.find((s) => s.name === 'app.boot');
    const core = spans.find((s) => s.name === 'boot.core');
    const critical = spans.find((s) => s.name === 'boot.critical' && s.subsystem === 'runtime/app');
    expect(boot && core && critical).toBeTruthy();
    expect(core?.parentSpanId).toBe(boot?.context.spanId);
    expect(critical?.parentSpanId).toBe(boot?.context.spanId);
    expect(critical?.status).toBe('ok');
    await app.shutdown();
    expect(app.supervisor.state).toBe('terminated');
  });

  it('fails with SF-APP-006 when a critical unit fails, and terminates', async () => {
    const failing = unit({ id: 'test/shell-unit', provides: ShellToken, scope: 'app', critical: true, create: () => ({ ready: false }), init: () => err(Boom()) });
    const result = await bootApp({ units: [failing] });
    expect(!result.ok && result.error.code).toBe('SF-APP-006');
  });

  it('registers contributed subsystems once; the frame scheduler pauses with the app', async () => {
    const extra = unit({
      id: 'test/extra-subsystem',
      provides: SubsystemsToken,
      scope: 'app',
      create: () => ({ id: 'test/extra', start: () => undefined }) as never,
    });
    const result = await bootApp({ units: [...runtimeUnits, extra], sleep: async () => ok() });
    if (!result.ok) throw result.error;
    const { supervisor, injector } = result.value;
    await supervisor.settled();
    expect(supervisor.inspect().map((s) => s.id).sort()).toEqual(['runtime/frame-scheduler', 'test/extra']);
    const scheduler = await injector.get(FrameSchedulerToken);
    if (!scheduler.ok) throw scheduler.error;
    await supervisor.pause();
    expect(scheduler.value.paused).toBe(true);
    await supervisor.resume();
    expect(scheduler.value.paused).toBe(false);
    expect(await supervisor.reinitialize()).toEqual(ok());
    await supervisor.settled();
    expect(supervisor.inspect()).toHaveLength(2);
    expect(supervisor.state).toBe('running');
    expect(scheduler.value.paused).toBe(false);
  });

  it('uses bound command and paused-request policies', async () => {
    const commandPolicy = unit({ id: 'test/policy', provides: CommandPolicyToken, scope: 'app', create: () => () => ({ allow: false, reason: 'shell says no' }) });
    const pausedPolicy = unit({ id: 'test/paused-policy', provides: PausedRequestPolicyToken, scope: 'app', create: () => () => 'reject' as const });
    const result = await bootApp({ units: [commandPolicy, pausedPolicy] });
    if (!result.ok) throw result.error;
    const denied = await result.value.supervisor.request({ command: 'refresh', source: 'test/feature' });
    expect(!denied.ok && denied.error.code).toBe('SF-APP-003');
    await result.value.supervisor.pause();
    const rejected = await result.value.supervisor.whenRunnable({ kind: 'read' });
    expect(rejected.ok).toBe(false);
  });

  it('the feature host refuses work while the app is paused (I-1)', async () => {
    const result = await bootApp({ units: [...runtimeUnits, editorContribution] });
    if (!result.ok) throw result.error;
    const host = await result.value.injector.get(FeatureHostToken);
    if (!host.ok) throw host.error;
    await result.value.supervisor.pause();
    const blocked = await host.value.activate('test/editor');
    expect(!blocked.ok && blocked.error.code).toBe('SF-APP-001');
    await result.value.supervisor.resume();
    expect((await host.value.activate('test/editor')).ok).toBe(true);
  });

  it('shutdown disposes the injector (unit scopes clean up)', async () => {
    const cleanup = vi.fn();
    const resource = unit({
      id: 'test/resource',
      provides: ShellToken,
      scope: 'app',
      create: (_d, ctx) => {
        ctx.scope.defer(cleanup);
        return { ready: true };
      },
    });
    const result = await bootApp({ units: [resource] });
    if (!result.ok) throw result.error;
    await result.value.injector.get(ShellToken);
    await result.value.shutdown();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('the feature host loads modules through a bound FeatureLoaderToken (regression: no DI loader)', async () => {
    const seen: string[] = [];
    const loaderUnit = unit({
      id: 'test/feature-loader',
      provides: FeatureLoaderToken,
      scope: 'app',
      create: (): FeatureLoader => async (manifest, signal) => {
        seen.push(manifest.id);
        return manifestFeatureLoader(manifest, signal);
      },
    });
    const result = await bootApp({ units: [...runtimeUnits, editorContribution, loaderUnit] });
    if (!result.ok) throw result.error;
    const host = await result.value.injector.get(FeatureHostToken);
    if (!host.ok) throw host.error;
    expect((await host.value.activate('test/editor')).ok).toBe(true);
    expect(seen).toEqual(['test/editor']);
    await result.value.shutdown();
  });

  it('a bound feature loader that fails is surfaced as the activation error', async () => {
    const loaderUnit = unit({
      id: 'test/failing-feature-loader',
      provides: FeatureLoaderToken,
      scope: 'app',
      create: (): FeatureLoader => async () => err(Boom()),
    });
    const result = await bootApp({ units: [...runtimeUnits, editorContribution, loaderUnit] });
    if (!result.ok) throw result.error;
    const host = await result.value.injector.get(FeatureHostToken);
    if (!host.ok) throw host.error;
    const activated = await host.value.activate('test/editor');
    expect(activated.ok).toBe(false);
    await result.value.shutdown();
  });

  it('without a FeatureLoaderToken binding the host falls back to manifest.load', async () => {
    const load = vi.fn(async () => ({}));
    const feature = defineFeature({ id: 'test/plain', weight: 'warm', load });
    const contributionUnit = unit({ id: 'test/plain-manifest', provides: FeatureManifestsToken, scope: 'app', create: () => feature as never });
    const result = await bootApp({ units: [...runtimeUnits, contributionUnit] });
    if (!result.ok) throw result.error;
    const host = await result.value.injector.get(FeatureHostToken);
    if (!host.ok) throw host.error;
    expect((await host.value.activate('test/plain')).ok).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    await result.value.shutdown();
  });
});
