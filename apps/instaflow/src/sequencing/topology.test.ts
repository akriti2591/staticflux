import { describe, expect, it } from 'vitest';
import { bootFailure, GestureTargetGoneError, RenderPortError, SequencingBootError, SequencingRoleError, summarizeCause } from './errors.js';
import { RenderTickFlag, SequencingTopologyFlag } from './flags.js';
import { MAIN_TICK_PACING } from './pacing.js';
import { resolveSequencingSettings } from './sequencing.bindings.js';
import { DEFAULT_SEQUENCING_SETTINGS, planSequencing, workerFor } from './topology.js';

const isolated = { crossOriginIsolated: true };
const notIsolated = { crossOriginIsolated: false };

describe('planSequencing', () => {
  it('D15 default: one worker hosts both modules over local pipes; input crosses on shared memory when isolated', () => {
    expect(DEFAULT_SEQUENCING_SETTINGS.topology).toBe('colocated');
    const plan = planSequencing(DEFAULT_SEQUENCING_SETTINGS, { isolation: isolated });
    expect(plan.workers).toEqual([{ name: 'pipeline', roles: ['editor', 'render'] }]);
    expect(plan.media).toEqual({ input: 'shared', modules: 'local', tick: 'shared' });
  });
  it('split: one worker each, shared pipes when isolated, message pipes otherwise', () => {
    expect(planSequencing({ topology: 'split' }, { isolation: isolated }).media).toEqual({ input: 'shared', modules: 'shared', tick: 'shared' });
    const plan = planSequencing({ topology: 'split' }, { isolation: notIsolated });
    expect(plan.media).toEqual({ input: 'message', modules: 'message', tick: 'message' });
    expect(plan.workers.map((w) => w.roles)).toEqual([['editor'], ['render']]);
  });
  it('takes media overrides (tests run every medium on every topology)', () => {
    expect(planSequencing({ topology: 'colocated' }, { isolation: isolated, media: { input: 'message' } }).media).toEqual({ input: 'message', modules: 'local', tick: 'shared' });
  });
  it('workerFor finds the worker hosting a role', () => {
    const split = planSequencing({ topology: 'split' }, { isolation: isolated });
    expect(workerFor(split, 'render')?.name).toBe('render');
    expect(workerFor(planSequencing({ topology: 'colocated' }, { isolation: isolated }), 'editor')?.name).toBe('pipeline');
    expect(workerFor({ ...split, workers: [] }, 'editor')).toBeUndefined();
  });
});

describe('flags and bindings', () => {
  it('declares typed, pre-auth-safe boot flags with the D15 defaults', () => {
    expect(SequencingTopologyFlag).toMatchObject({ key: 'instaflow/sequencing-topology', defaultValue: 'colocated', preAuthSafe: true });
    expect(SequencingTopologyFlag.schema.values).toEqual(['colocated', 'split']);
    expect(RenderTickFlag).toMatchObject({ key: 'instaflow/render-tick', defaultValue: 'worker-raf' });
    expect(RenderTickFlag.schema.parse('main-raf').ok).toBe(true);
    expect(RenderTickFlag.schema.parse('vsync').ok).toBe(false);
  });
  it('resolveSequencingSettings maps flag values through variant tables', () => {
    const values = new Map<unknown, unknown>([
      [SequencingTopologyFlag, 'split'],
      [RenderTickFlag, 'main-raf'],
    ]);
    const settings = resolveSequencingSettings(<T>(flag: { defaultValue: T }) => (values.get(flag) ?? flag.defaultValue) as T);
    expect(settings).toMatchObject({ topology: 'split', pacing: MAIN_TICK_PACING, renderPort: 'default' });
    const defaults = resolveSequencingSettings(<T>(flag: { defaultValue: T }) => flag.defaultValue);
    expect(defaults).toEqual(DEFAULT_SEQUENCING_SETTINGS);
  });
});

describe('errors', () => {
  it('have stable codes and fixes', () => {
    for (const [error, code] of [
      [GestureTargetGoneError, 'IF-ENG-001'],
      [SequencingBootError, 'IF-SEQ-001'],
      [SequencingRoleError, 'IF-SEQ-002'],
      [RenderPortError, 'IF-SEQ-003'],
    ] as const) {
      expect(error.code).toBe(code);
      expect(error.fix.length).toBeGreaterThan(20);
      expect(error().code).toBe(code);
    }
  });
});

describe('bootFailure / summarizeCause', () => {
  it('keeps the cause chain in the message and in plain-data details (wire errors drop `cause`)', () => {
    const inner = RenderPortError({ message: 'no port', details: { port: 'vello' } });
    const failure = bootFailure('start pipeline', SequencingRoleError({ cause: inner }));
    expect(failure.code).toBe('IF-SEQ-001');
    expect(failure.message).toContain('"start pipeline": IF-SEQ-002');
    expect(failure.message).toContain('IF-SEQ-003: no port');
    expect(failure.details['causes']).toEqual([
      { code: 'IF-SEQ-002', message: SequencingRoleError.summary },
      { code: 'IF-SEQ-003', message: 'no port', details: { port: 'vello' } },
    ]);
    // Re-wrapping a failure that crossed a link continues with its recorded chain.
    const relayed = bootFailure('start editor', SequencingBootError({ message: failure.message, details: failure.details }));
    expect(summarizeCause(relayed).map((c) => c.code)).toEqual(['IF-SEQ-001', 'IF-SEQ-001', 'IF-SEQ-002', 'IF-SEQ-003']);
    expect(bootFailure('spawn').message).toBe('Sequencing boot failed at "spawn".');
    expect(summarizeCause(new Error('plain'))[0]?.message).toBe('plain');
  });
});
