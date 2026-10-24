import { createMemorySink, createScope, createTelemetry, type MetricRecord } from '@staticflux/core';
import { gateResource, type DecidePort } from '@staticflux/ui';
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryKeyValue,
  createSurfaceManager,
  defineCoachSequence,
  defineCoachTarget,
  defineSurface,
  type SurfaceManagerOptions,
} from './index.js';
import { manualVisibility, settle } from '@staticflux/ui/testing';

const dialog = (id: `${string}/${string}`, priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal') =>
  defineSurface({ id, kind: 'dialog', scope: 'feature', priority, render: () => id });
const toast = (id: `${string}/${string}`, priority: 'normal' | 'urgent' = 'normal') =>
  defineSurface({ id, kind: 'toast', scope: 'app', priority, render: () => id });

function setup(options: SurfaceManagerOptions = {}) {
  const clock = createManualClock();
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  const manager = createSurfaceManager({ clock, telemetry, ...options });
  const scope = createScope('feature');
  const owner = { scope, level: 'feature' as const };
  const metrics = (id: string): MetricRecord[] =>
    sink.records.filter((r): r is MetricRecord => r.type === 'metric' && r.metric === id);
  return { manager, clock, owner, scope, sink, metrics };
}

describe('surface machine & lifecycle', () => {
  it('requested → queued → showing → dismissing → dismissed, with an outcome', async () => {
    const { manager, owner } = setup();
    const confirm = defineSurface<{ name: string }, boolean>({
      id: 'test/confirm',
      kind: 'dialog',
      scope: 'feature',
      render: ({ props }) => props.name,
    });
    const handle = manager.request(confirm, { owner, props: { name: 'x' } });
    await settle(1);
    expect(handle.state).toBe('showing');
    expect(manager.topModal).toBe(handle);
    handle.dismiss('action', true);
    const outcome = await handle.closed;
    expect(outcome).toMatchObject({ state: 'dismissed', reason: 'action', result: true });
    expect(handle.state).toBe('dismissed');
    expect(manager.active).toHaveLength(0);
  });

  it('is scope-bound: disposing the owner scope dismisses its surfaces (I-7)', async () => {
    const { manager, owner, scope } = setup();
    const a = manager.request(dialog('test/a'), { owner });
    const b = manager.request(toast('test/t'), { owner: { scope } });
    await settle(1);
    await scope.dispose();
    expect((await a.closed).reason).toBe('scope-ended');
    expect((await b.closed).reason).toBe('scope-ended');
  });

  it('rejects requests for disposed scopes or longer-lived owners with SF-MSG-001', async () => {
    const { manager, scope } = setup();
    const viewDialog = defineSurface({ id: 'test/view-dialog', kind: 'dialog', scope: 'view', render: () => '' });
    const appOwned = manager.request(viewDialog, { owner: { scope, level: 'app' } });
    expect(await appOwned.closed).toMatchObject({ state: 'rejected', reason: 'scope' });
    expect((await appOwned.closed).error?.code).toBe('SF-MSG-001');
    await scope.dispose();
    const late = manager.request(dialog('test/late'), { owner: { scope } });
    expect((await late.closed).error?.code).toBe('SF-MSG-001');
  });

  it('emits shown / dismissed / dwell metrics and lifecycle events (R13.10)', async () => {
    const { manager, owner, clock, metrics, sink } = setup();
    const handle = manager.request(dialog('test/metric'), { owner });
    await settle(1);
    clock.advance(1200);
    handle.dismiss('escape');
    await handle.closed;
    expect(metrics('messaging/surface-shown')[0]?.attrs).toMatchObject({ surface: 'test/metric', kind: 'dialog' });
    expect(metrics('messaging/surface-dismissed')[0]?.attrs).toMatchObject({ reason: 'escape' });
    expect(metrics('messaging/surface-dwell')[0]?.value).toBe(1200);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'lifecycle.messaging/surface.queued→showing')).toBe(true);
  });

  it('a request signal cancels the surface', async () => {
    const { manager, owner } = setup();
    const controller = new AbortController();
    const handle = manager.request(dialog('test/sig'), { owner, signal: controller.signal });
    await settle(1);
    controller.abort();
    expect((await handle.closed).reason).toBe('programmatic');
  });
});

describe('attention arbitration (R13.7)', () => {
  it('modals: equal priority queues; higher priority suspends the current one; stack opts in', async () => {
    const { manager, owner } = setup();
    const first = manager.request(dialog('test/first'), { owner });
    const second = manager.request(dialog('test/second'), { owner });
    await settle(1);
    expect(first.state).toBe('showing');
    expect(second.state).toBe('queued');
    const urgent = manager.request(dialog('test/urgent', 'urgent'), { owner });
    await settle(1);
    expect(urgent.state).toBe('showing');
    expect(first.state).toBe('suspended');
    const confirm = manager.request(dialog('test/confirm', 'low'), { owner, stack: true });
    await settle(1);
    expect(confirm.state).toBe('showing');
    expect(urgent.state).toBe('suspended');
    confirm.dismiss('action');
    await confirm.closed;
    expect(urgent.state).toBe('showing');
    urgent.dismiss('user');
    await urgent.closed;
    expect(first.state).toBe('showing');
    first.dismiss('user');
    await first.closed;
    expect(second.state).toBe('showing');
  });

  it('toasts: concurrency cap, urgent bypasses it, auto-dismiss with the clock', async () => {
    const { manager, clock } = setup({ toastConcurrency: 2, defaultToastMs: 1000 });
    const owner = { scope: createScope('app'), level: 'app' as const };
    const t1 = manager.request(toast('test/t1'), { owner });
    const t2 = manager.request(toast('test/t2'), { owner });
    const t3 = manager.request(toast('test/t3'), { owner });
    const urgent = manager.request(toast('test/t-urgent', 'urgent'), { owner });
    await settle(1);
    expect([t1.state, t2.state, t3.state, urgent.state]).toEqual(['showing', 'showing', 'queued', 'showing']);
    clock.advance(1000);
    expect((await t1.closed).reason).toBe('timeout');
    expect(t3.state).toBe('showing');
    clock.advance(60_000);
    expect(urgent.state).toBe('showing'); // urgent toasts are sticky by default
  });

  it('banners are deduplicated and capped', async () => {
    const { manager, metrics } = setup({ bannerConcurrency: 1 });
    const owner = { scope: createScope('session'), level: 'session' as const };
    const lowBalance = defineSurface({ id: 'billing/low-balance', kind: 'banner', scope: 'session', render: () => 'low' });
    const offline = defineSurface({ id: 'app/offline', kind: 'banner', scope: 'session', render: () => 'offline' });
    const a = manager.request(lowBalance, { owner });
    const b = manager.request(lowBalance, { owner });
    const c = manager.request(offline, { owner });
    await settle(1);
    expect(b).toBe(a);
    expect(metrics('messaging/surface-deduped')).toHaveLength(1);
    expect(a.state).toBe('showing');
    expect(c.state).toBe('queued');
  });

  it('tooltips replace each other; popovers show immediately; Escape closes transient first', async () => {
    const { manager, owner } = setup();
    const tip = (id: `${string}/${string}`) => defineSurface({ id, kind: 'tooltip', scope: 'feature', render: () => id });
    const t1 = manager.request(tip('test/tip1'), { owner });
    await settle(1);
    const t2 = manager.request(tip('test/tip2'), { owner });
    await settle(1);
    expect((await t1.closed).reason).toBe('replaced');
    expect(t2.state).toBe('showing');
    const modal = manager.request(dialog('test/m'), { owner });
    const pop = manager.request(defineSurface({ id: 'test/pop', kind: 'popover', scope: 'feature', render: () => '' }), { owner });
    await settle(1);
    expect(pop.state).toBe('showing');
    expect(manager.dismissTop()).toBe(true);
    expect(t2.state).toBe('dismissed');
    manager.dismissTop();
    expect(pop.state).toBe('dismissed');
    manager.dismissTop();
    expect(modal.state).toBe('dismissed');
    expect(manager.dismissTop()).toBe(false);
  });

  it('non-dismissible surfaces ignore Escape', async () => {
    const { manager, owner } = setup();
    const sticky = defineSurface({ id: 'test/reconnecting', kind: 'dialog', scope: 'feature', dismissible: false, render: () => '' });
    const handle = manager.request(sticky, { owner });
    await settle(1);
    expect(manager.dismissTop()).toBe(false);
    expect(handle.state).toBe('showing');
  });
});

describe('coach marks (R13.8)', () => {
  const AiButton = defineCoachTarget('studio/ai-button');
  const aiCoach = defineSurface({ id: 'studio/ai-coach', kind: 'coach-mark', scope: 'feature', target: AiButton, render: () => 'Try AI' });

  it('waits for its target to be registered and visible; suppressed by modals and busy users', async () => {
    const visibility = manualVisibility();
    const { manager, owner } = setup({ visibility });
    const coach = manager.request(aiCoach, { owner });
    await settle(1);
    expect(coach.state).toBe('queued');
    const button = document.createElement('button');
    const unregister = manager.targets.register(AiButton, button);
    expect(coach.state).toBe('queued');
    visibility.show(button);
    expect(manager.targets.available(AiButton)).toBe(true);
    expect(coach.state).toBe('showing');
    const modal = manager.request(dialog('test/modal'), { owner });
    await settle(1);
    expect(coach.state).toBe('suspended');
    modal.dismiss('user');
    await modal.closed;
    expect(coach.state).toBe('showing');
    manager.setUserBusy(true);
    expect(coach.state).toBe('suspended');
    manager.setUserBusy(false);
    expect(coach.state).toBe('showing');
    unregister();
    expect(coach.state).toBe('suspended');
  });

  it('is shown once per user: seen persisted on user dismissal, later requests rejected', async () => {
    const seen = createMemoryKeyValue<boolean>();
    const visibility = manualVisibility();
    const { manager, owner } = setup({ seen, visibility });
    const button = document.createElement('button');
    manager.targets.register(AiButton, button);
    visibility.show(button);
    const first = manager.request(aiCoach, { owner });
    await settle(1);
    expect(first.state).toBe('showing');
    first.dismiss('completed');
    await first.closed;
    await settle(1);
    expect(seen.entries.get('messaging/seen/studio/ai-coach')).toBe(true);
    const again = manager.request(aiCoach, { owner });
    expect(await again.closed).toMatchObject({ state: 'rejected', reason: 'seen' });
  });

  it('gives up after targetTimeoutMs (SF-MSG-005)', async () => {
    const { manager, owner, clock } = setup();
    const timed = defineSurface({ id: 'test/timed-coach', kind: 'coach-mark', scope: 'feature', target: AiButton, targetTimeoutMs: 500, render: () => '' });
    const handle = manager.request(timed, { owner });
    await settle(1);
    clock.advance(500);
    const outcome = await handle.closed;
    expect(outcome.reason).toBe('target-missing');
    expect(outcome.error?.code).toBe('SF-MSG-005');
  });

  it('sequences show steps in order and skip seen steps', async () => {
    const seen = createMemoryKeyValue<boolean>([['messaging/seen/test/step-2', true]]);
    const { manager, owner } = setup({ seen });
    const T = defineCoachTarget('test/target');
    manager.targets.register(T, document.createElement('div'));
    await settle(1);
    const step = (id: `${string}/${string}`) => defineSurface({ id, kind: 'coach-mark', scope: 'feature', target: T, render: () => id });
    const tour = defineCoachSequence({ id: 'test/tour', steps: [step('test/step-1'), step('test/step-2'), step('test/step-3')] });
    const run = manager.startSequence(tour, { owner });
    await settle(1);
    const first = manager.showing('coach-mark')[0];
    expect(first?.def.id).toBe('test/step-1');
    expect(first?.step).toEqual({ index: 1, total: 3 });
    first?.dismiss('completed');
    await settle(2);
    const third = manager.showing('coach-mark')[0];
    expect(third?.def.id).toBe('test/step-3');
    third?.dismiss('completed');
    expect(await run.done).toBe(true);
    expect(seen.entries.get('messaging/seen/test/tour')).toBe(true);
  });
});

describe('gating (R13.9)', () => {
  it('a denied surface resolves to its upsell surface', async () => {
    const decide: DecidePort = { decide: (r) => (r.id === 'surface:billing/premium-export' ? { effect: 'deny', reason: 'plan:free' } : { effect: 'allow' }) };
    const { manager, owner, metrics } = setup({ decide });
    const upsell = defineSurface({ id: 'billing/upsell', kind: 'dialog', scope: 'feature', render: () => 'Upgrade' });
    const premium = defineSurface({
      id: 'billing/premium-export',
      kind: 'dialog',
      scope: 'feature',
      gate: gateResource('surface', 'surface:billing/premium-export'),
      upsell,
      render: () => 'Export',
    });
    const handle = manager.request(premium, { owner });
    const outcome = await handle.closed;
    expect(outcome).toMatchObject({ state: 'rejected', reason: 'gated' });
    expect(outcome.error?.code).toBe('SF-MSG-002');
    await settle(1);
    expect(outcome.redirect?.def.id).toBe('billing/upsell');
    expect(outcome.redirect?.state).toBe('showing');
    expect(metrics('messaging/surface-rejected')[0]?.attrs).toMatchObject({ reason: 'gated' });
  });

  it('dismissing a surface while its gate decision is pending cancels it', async () => {
    let release!: () => void;
    const decide: DecidePort = { decide: () => new Promise((resolve) => (release = () => resolve({ effect: 'allow' }))) };
    const { manager, owner } = setup({ decide });
    const gated = defineSurface({ id: 'test/gated', kind: 'dialog', scope: 'feature', gate: gateResource('surface', 'surface:test/gated'), render: () => '' });
    const handle = manager.request(gated, { owner });
    handle.dismiss();
    release();
    expect((await handle.closed).reason).toBe('cancelled');
  });
});

describe('definitions', () => {
  it('validates routable kinds and coach targets', () => {
    expect(() => defineSurface({ id: 'test/bad', kind: 'toast', scope: 'app', routable: { key: 'x' }, render: () => '' })).toThrow();
    expect(() => defineSurface({ id: 'test/bad2', kind: 'coach-mark', scope: 'app', render: () => '' })).toThrow();
    expect(() => defineCoachSequence({ id: 'test/seq', steps: [dialog('test/not-coach') as never] })).toThrow();
  });

  it('exit duration keeps surfaces in dismissing; reduced motion skips it', async () => {
    const { manager, owner, clock } = setup({ exitMs: 150 });
    const handle = manager.request(dialog('test/exit'), { owner });
    await settle(1);
    handle.dismiss('user');
    expect(handle.state).toBe('dismissing');
    clock.advance(150);
    expect(handle.state).toBe('dismissed');
    const reduced = setup({ exitMs: 150, reducedMotion: () => true });
    const quick = reduced.manager.request(dialog('test/exit2'), { owner: reduced.owner });
    await settle(1);
    quick.dismiss('user');
    expect(quick.state).toBe('dismissed');
  });
});
