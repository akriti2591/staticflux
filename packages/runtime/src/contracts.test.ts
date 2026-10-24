import { createMachine, createMemorySink, createTelemetry } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_COMMANDS,
  APP_STATES,
  appMachine,
  createFrameScheduler,
  createMemoryArchiveStore,
  defaultCommandPolicy,
  defaultPausedRequestPolicy,
  defineFeature,
  defineSubsystem,
  normalizeReadinessMark,
  READINESS_MARKS,
  featureMachine,
  featureRef,
  frameSchedulerSubsystem,
  SNAPSHOT_FORMAT,
  subsystemMachine,
  traceMachine,
} from './index.js';

describe('machines mirror docs/LIFECYCLES.md', () => {
  it('app: starting → core-ready → running ⇄ degraded / paused; reinitialize; shutdown from anywhere', () => {
    const m = createMachine(appMachine);
    expect(m.send('run').ok).toBe(false);
    for (const event of ['core-ready', 'run', 'degrade', 'recover', 'pause', 'resume', 'reinitialize', 'core-ready', 'run'] as const) {
      expect(m.send(event).ok).toBe(true);
    }
    expect(m.state).toBe('running');
    expect(m.send('shutdown').ok).toBe(true);
    expect(m.send('terminate').ok).toBe(true);
    expect(m.can('core-ready')).toBe(false);
    for (const state of APP_STATES.filter((s) => s !== 'shutting-down' && s !== 'terminated')) {
      expect(createMachine(appMachine, { initial: state }).can('shutdown')).toBe(true);
    }
  });

  it('allowed commands per state match the table', () => {
    expect(ALLOWED_COMMANDS.starting).toEqual(['abort', 'shutdown']);
    expect(ALLOWED_COMMANDS.paused).toEqual(['resume', 'shutdown']);
    expect(ALLOWED_COMMANDS.running).toEqual(ALLOWED_COMMANDS.degraded);
    expect(ALLOWED_COMMANDS.terminated).toEqual([]);
  });

  it('subsystem: failed → restarting → starting; failed → given-up; any → stopping → stopped', () => {
    const m = createMachine(subsystemMachine);
    for (const event of ['start', 'started', 'pause', 'resume', 'fail', 'restart', 'start', 'fail', 'give-up', 'stop', 'stopped', 'start'] as const) {
      expect(m.send(event).ok).toBe(true);
    }
    expect(m.state).toBe('starting');
    expect(createMachine(subsystemMachine, { initial: 'given-up' }).can('restart')).toBe(false);
  });

  it('feature: the full graph incl. archive, failure and retry paths', () => {
    const m = createMachine(featureMachine);
    const path = [
      'load', 'loaded', 'activate', 'activated', 'mount', 'mounted', 'hide', 'show', 'unmount', 'unmounted',
      'deactivate', 'deactivated', 'archive', 'activate', 'fail', 'retry-activate', 'activated', 'deactivate',
      'deactivated', 'evict', 'load', 'fail', 'retry-load', 'loaded',
    ] as const;
    for (const event of path) expect(m.send(event).ok, event).toBe(true);
    expect(m.state).toBe('loaded');
    expect(createMachine(featureMachine, { initial: 'activated' }).can('archive')).toBe(false);
    expect(createMachine(featureMachine, { initial: 'mounted' }).can('deactivate')).toBe(false);
    expect(createMachine(featureMachine, { initial: 'mounting' }).send('mount-failed').ok).toBe(true);
  });

  it('traceMachine emits lifecycle.<machine>.<from>→<to> (critical states at critical level)', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const m = createMachine(subsystemMachine);
    const stop = traceMachine(m, telemetry, 'runtime/app', { attrs: { subsystem: 'x/y' }, criticalStates: ['failed'] });
    m.send('start');
    m.send('fail');
    stop();
    m.send('restart');
    const events = sink.records.filter((r) => r.type === 'event');
    expect(events.map((e) => [e.name, e.level])).toEqual([
      ['lifecycle.subsystem.idle→starting', 'verbose'],
      ['lifecycle.subsystem.starting→failed', 'critical'],
    ]);
  });
});

describe('policies', () => {
  it('default command policy lets features request pause/resume/refresh only', () => {
    expect(defaultCommandPolicy({ command: 'refresh', source: 'auth/session' }, { state: 'running' })).toEqual({ allow: true });
    const denied = defaultCommandPolicy({ command: 'reinitialize', source: 'x/y' }, { state: 'running' });
    expect(denied).toMatchObject({ allow: false });
  });

  it('default paused-request policy never auto-replays non-idempotent mutations (R4.6)', () => {
    expect(defaultPausedRequestPolicy({ kind: 'read' })).toBe('queue');
    expect(defaultPausedRequestPolicy({ kind: 'task' })).toBe('queue');
    expect(defaultPausedRequestPolicy({ kind: 'mutation' })).toBe('reject');
    expect(defaultPausedRequestPolicy({ kind: 'mutation', idempotent: true })).toBe('queue');
  });
});

describe('contracts', () => {
  it('memory archive store clones values in and out', async () => {
    const store = createMemoryArchiveStore();
    const data = { nested: { n: 1 } };
    await store.put({ format: SNAPSHOT_FORMAT, id: 'x/y', version: 1, createdAt: 0, epoch: 0, data });
    data.nested.n = 2;
    const read = await store.get('x/y');
    expect(read.ok && read.value?.data).toEqual({ nested: { n: 1 } });
    expect(await store.keys()).toEqual({ ok: true, value: ['x/y'] });
    const bad = await store.put({ format: SNAPSHOT_FORMAT, id: 'x/z', version: 1, createdAt: 0, epoch: 0, data: { fn: () => 1 } });
    expect(!bad.ok && bad.error.code).toBe('SF-FT-009');
    await store.delete('x/y');
    expect(store.size).toBe(0);
    expect(await store.get('x/missing')).toEqual({ ok: true, value: undefined });
  });

  it('defineFeature / featureRef / defineSubsystem are typed identities', () => {
    const manifest = defineFeature({ id: 'studio/desktop', weight: 'heavy', modes: ['expanded'], load: async () => ({}) });
    expect(manifest.kind).toBe('feature');
    expect(manifest.id).toBe('studio/desktop');
    expect(typeof manifest.load).toBe('function');
    const ref = featureRef('studio/desktop');
    expect(ref.id).toBe(manifest.id);
    expect(Object.isFrozen(ref)).toBe(true);
    const sub = defineSubsystem({ id: 'worker/document', start: () => undefined });
    expect(sub.id).toBe('worker/document');
  });

  it('readiness marks are camelCase; the kebab-case first-render is a normalized deprecated alias', () => {
    expect(READINESS_MARKS).toEqual(['firstRender', 'interactive', 'complete']);
    expect(normalizeReadinessMark('first-render')).toBe('firstRender');
    expect(normalizeReadinessMark('complete')).toBe('complete');
    const legacy = defineFeature({ id: 'test/legacy', weight: 'warm', readiness: { 'first-render': 'feature', interactive: 'feature' }, load: async () => ({}) });
    expect(legacy.readiness).toEqual({ firstRender: 'feature', interactive: 'feature' });
    const canonical = defineFeature({ id: 'test/canonical', weight: 'warm', readiness: { firstRender: 'framework', complete: 'feature' }, load: async () => ({}) });
    expect(canonical.readiness).toEqual({ firstRender: 'framework', complete: 'feature' });
  });

  it('frameSchedulerSubsystem pauses and resumes the scheduler; stop leaves it usable', async () => {
    const scheduler = createFrameScheduler({ raf: (cb) => cb(0), macrotask: (cb) => cb(), idle: () => undefined });
    const sub = frameSchedulerSubsystem(scheduler);
    const ctx = {} as never;
    await sub.pause?.(ctx);
    expect(scheduler.paused).toBe(true);
    await sub.resume?.(ctx);
    expect(scheduler.paused).toBe(false);
    await sub.pause?.(ctx);
    await sub.stop?.('reinitialize', ctx);
    expect(scheduler.paused).toBe(false);
    expect((await scheduler.postTask(() => 1)).ok).toBe(true);
  });
});
