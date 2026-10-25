import { createMemorySink, createTelemetry, err, ok, type Result } from '@staticflux/core';
import { type DecidePort, gateResource } from '@staticflux/ui';
import { describe, expect, it } from 'vitest';
import {
  appliesIn,
  applySpecDiff,
  clampSpecMotion,
  createSpecRuntime,
  createSpecVocabulary,
  DEFAULT_PLACEMENT,
  DEFAULT_SPEC_MOTION,
  defineSpecContribution,
  defineSpecSection,
  diffSpecs,
  EMPTY_LAYOUT,
  groupKey,
  layoutGroups,
  longestIncreasingSubsequence,
  type ShellSpec,
  slotKey,
  type SpecMountPort,
  type SpecMotionStep,
  specIssues,
  specMotionStep,
  SpecRuntimeLifecycle,
  type SpecVocabulary,
  validateSpec,
} from './spec.js';

const lens = defineSpecSection({ id: 'lens', cardinality: 'one' });
const tool = defineSpecSection({ id: 'tool', pinnable: true });
const panel = defineSpecSection({ id: 'panel', pinnable: true, placements: ['dock', 'inspector'] });
const premium = gateResource('ui-slot', 'test/premium');

const contributions = [
  defineSpecContribution({ section: 'lens', id: 'test/canvas', label: 'Canvas' }),
  defineSpecContribution({ section: 'lens', id: 'test/pixel', label: 'Pixel' }),
  ...['a', 'b', 'c', 'd', 'e'].map((n) => defineSpecContribution({ section: 'tool', id: `test/${n}` as const, label: n.toUpperCase() })),
  defineSpecContribution({ section: 'tool', id: 'test/heal', label: 'Heal', when: { lens: ['test/pixel'] } }),
  defineSpecContribution({ section: 'panel', id: 'test/layers', label: 'Layers' }),
  defineSpecContribution({ section: 'panel', id: 'test/props', label: 'Properties', placements: ['inspector'] }),
  defineSpecContribution({ section: 'panel', id: 'test/premium', label: 'Premium', gate: premium }),
];

const vocab = (): SpecVocabulary => {
  const result = createSpecVocabulary({ sections: [lens, tool, panel], contributions });
  if (!result.ok) throw result.error;
  return result.value;
};

const spec = (id: string, tools: readonly string[], extra: Partial<ShellSpec> = {}, lensId = 'test/canvas'): ShellSpec => ({
  id,
  context: { lens: lensId },
  slots: [{ section: 'lens', id: lensId as `${string}/${string}` }, ...tools.map((t) => ({ section: 'tool', id: `test/${t}` as const }))],
  ...extra,
});

const denyPremium: DecidePort = { decide: (r) => (r.id === premium.id ? { effect: 'deny', reason: 'upgrade' } : { effect: 'allow' }) };

const validated = async (s: ShellSpec, decide?: DecidePort) => {
  const result = await validateSpec(s, vocab(), decide === undefined ? {} : { decide });
  if (!result.ok) throw result.error;
  return result.value;
};

interface Call {
  readonly op: 'mount' | 'move' | 'unmount' | 'context';
  readonly key: string;
  readonly step: SpecMotionStep;
}

function recordingPort(fail: (op: Call['op'], key: string) => boolean = () => false): SpecMountPort & { calls: Call[] } {
  const calls: Call[] = [];
  const result = (op: Call['op'], key: string): Result<void> => (fail(op, key) ? err(new Error('boom') as never) : ok());
  return {
    calls,
    mount: (slot, _after, step) => (calls.push({ op: 'mount', key: slot.key, step }), result('mount', slot.key)),
    move: (m, step) => (calls.push({ op: 'move', key: m.slot.key, step }), result('move', m.slot.key)),
    unmount: (slot, step) => (calls.push({ op: 'unmount', key: slot.key, step }), result('unmount', slot.key)),
    context: (changes, _ctx, step) => (calls.push({ op: 'context', key: changes.map((c) => c.key).join(','), step }), ok()),
  };
}

describe('spec model', () => {
  it('defineSpecSection / defineSpecContribution freeze data with defaults', () => {
    expect(tool).toMatchObject({ kind: 'spec-section', cardinality: 'many', pinnable: true, placements: [DEFAULT_PLACEMENT], label: 'tool' });
    expect(Object.isFrozen(tool)).toBe(true);
    const c = defineSpecContribution({ section: 'tool', id: 'x/y' });
    expect(c).toMatchObject({ kind: 'spec-contribution', label: 'x/y' });
  });

  it('slotKey and groupKey', () => {
    expect(slotKey('tool', 'test/a')).toBe('tool:test/a');
    expect(groupKey({ section: 'panel', placement: 'dock' })).toBe('panel@dock');
  });

  it('createSpecVocabulary rejects duplicates, unknown sections and stray placements', () => {
    expect(vocab().list('tool').map((c) => c.id)).toContain('test/heal');
    expect(vocab().section('panel')?.placements).toEqual(['dock', 'inspector']);
    const dupSection = createSpecVocabulary({ sections: [tool, tool], contributions: [] });
    expect(!dupSection.ok && dupSection.error.code).toBe('SF-SHELL-008');
    const dup = createSpecVocabulary({ sections: [tool], contributions: [contributions[2]!, contributions[2]!] });
    expect(!dup.ok && dup.error.code).toBe('SF-SHELL-008');
    const unknown = createSpecVocabulary({ sections: [tool], contributions: [contributions[0]!] });
    expect(!unknown.ok && unknown.error.code).toBe('SF-SHELL-010');
    const stray = createSpecVocabulary({ sections: [panel], contributions: [defineSpecContribution({ section: 'panel', id: 'x/p', placements: ['tray'] })] });
    expect(!stray.ok && stray.error.code).toBe('SF-SHELL-010');
  });
});

describe('validateSpec', () => {
  it('resolves slots with placements and per-group indices', async () => {
    const v = await validated({ ...spec('s', ['a', 'b']), slots: [...spec('s', ['a', 'b']).slots, { section: 'panel', id: 'test/layers' }, { section: 'panel', id: 'test/props' }] });
    expect(v.slots.map((s) => [s.key, s.placement, s.index])).toEqual([
      ['lens:test/canvas', 'default', 0],
      ['tool:test/a', 'default', 0],
      ['tool:test/b', 'default', 1],
      ['panel:test/layers', 'dock', 0],
      ['panel:test/props', 'inspector', 0],
    ]);
  });

  it('collects every issue with its own code and fix (unknown ids, context, placement, cardinality, pins)', async () => {
    const result = await validateSpec(
      {
        id: 'bad',
        context: { lens: 'test/canvas' },
        slots: [
          { section: 'tool', id: 'test/a' },
          { section: 'tool', id: 'test/a' },
          { section: 'tool', id: 'test/nope' },
          { section: 'nope', id: 'test/a' },
          { section: 'tool', id: 'test/heal' },
          { section: 'panel', id: 'test/props', placement: 'dock' },
        ],
        pinned: ['lens:test/canvas'],
      },
      vocab(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SF-SHELL-009');
    const codes = specIssues(result.error).map((i) => [i.code, i.slot ?? i.section]);
    expect(codes).toEqual([
      ['SF-SHELL-013', 'tool:test/a'],
      ['SF-SHELL-010', 'tool:test/nope'],
      ['SF-SHELL-010', 'nope:test/a'],
      ['SF-SHELL-011', 'tool:test/heal'],
      ['SF-SHELL-013', 'panel:test/props'],
      ['SF-SHELL-013', 'lens'],
      ['SF-SHELL-013', 'lens:test/canvas'],
    ]);
    expect(specIssues(result.error).every((i) => i.fix.length > 0)).toBe(true);
  });

  it('gates every slot through the decide port (SF-SHELL-012 with the reason)', async () => {
    const s = { ...spec('g', ['a']), slots: [...spec('g', ['a']).slots, { section: 'panel', id: 'test/premium' as const }] };
    expect((await validateSpec(s, vocab())).ok).toBe(true);
    const denied = await validateSpec(s, vocab(), { decide: denyPremium });
    expect(!denied.ok && specIssues(denied.error)).toMatchObject([{ code: 'SF-SHELL-012', slot: 'panel:test/premium', details: { reason: 'upgrade' } }]);
  });

  it('appliesIn checks every `when` key; specIssues is empty for other errors; aborts', async () => {
    expect(appliesIn({ when: { lens: ['x'] } }, { lens: 'x' })).toBe(true);
    expect(appliesIn({ when: { lens: ['x'] } }, {})).toBe(false);
    expect(appliesIn({}, {})).toBe(true);
    expect(specIssues(new Error('x') as never)).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    const aborted = await validateSpec(spec('a', ['a']), vocab(), { signal: controller.signal });
    expect(!aborted.ok && aborted.error.code).toBe('SF-CORE-002');
  });
});

describe('diffSpecs', () => {
  it('longestIncreasingSubsequence', () => {
    expect(longestIncreasingSubsequence([])).toEqual([]);
    expect(longestIncreasingSubsequence([0, 1, 2])).toEqual([0, 1, 2]);
    expect(longestIncreasingSubsequence([2, 0, 1])).toEqual([1, 2]);
    expect(longestIncreasingSubsequence([3, 1, 2, 0, 4]).length).toBe(3);
  });

  it('from empty mounts everything in display order; equal specs are empty', async () => {
    const next = await validated(spec('s', ['a', 'b']));
    const first = diffSpecs(EMPTY_LAYOUT, next);
    expect(first.mount.map((s) => s.key)).toEqual(['lens:test/canvas', 'tool:test/a', 'tool:test/b']);
    expect(first.context).toEqual([{ key: 'lens', from: undefined, to: 'test/canvas' }]);
    const again = diffSpecs(first.target, next);
    expect(again.empty).toBe(true);
    expect(again.kept).toHaveLength(3);
  });

  it('is minimal: a reorder moves only the slots outside the longest kept run; nothing is remounted', async () => {
    const before = diffSpecs(EMPTY_LAYOUT, await validated(spec('s', ['a', 'b', 'c', 'd']))).target;
    const diff = diffSpecs(before, await validated(spec('t', ['b', 'c', 'd', 'a', 'e'])));
    expect(diff.unmount).toEqual([]);
    expect(diff.mount.map((s) => s.key)).toEqual(['tool:test/e']);
    expect(diff.move.map((m) => [m.slot.key, m.from.index, m.slot.index])).toEqual([['tool:test/a', 0, 3]]);
    expect(layoutGroups(applySpecDiff(before, diff))).toEqual(layoutGroups(diff.target));
  });

  it('anchors each move and mount after a slot that is already in place', async () => {
    const before = diffSpecs(EMPTY_LAYOUT, await validated(spec('s', ['a', 'b', 'c']))).target;
    const diff = diffSpecs(before, await validated(spec('t', ['e', 'c', 'a', 'd', 'b'])));
    expect(diff.move.map((m) => [m.slot.key, m.after])).toEqual([['tool:test/c', undefined]]);
    expect([...diff.after]).toEqual([
      ['tool:test/c', undefined],
      ['tool:test/e', undefined],
      ['tool:test/d', 'tool:test/a'],
    ]);
    expect(layoutGroups(applySpecDiff(before, diff))['tool@default']).toEqual(['tool:test/e', 'tool:test/c', 'tool:test/a', 'tool:test/d', 'tool:test/b']);
  });

  it('unmounts in reverse display order and moves across placements', async () => {
    const withPanels = (placement: string) => ({ ...spec('p', ['a', 'b', 'c']), slots: [...spec('p', ['a', 'b', 'c']).slots, { section: 'panel', id: 'test/layers' as const, placement }] });
    const before = diffSpecs(EMPTY_LAYOUT, await validated(withPanels('dock'))).target;
    const diff = diffSpecs(before, await validated({ ...withPanels('inspector'), slots: withPanels('inspector').slots.filter((s) => s.id !== 'test/a' && s.id !== 'test/b') }));
    expect(diff.unmount.map((s) => s.key)).toEqual(['tool:test/b', 'tool:test/a']);
    expect(diff.move.map((m) => [m.slot.key, m.from.placement, m.slot.placement])).toEqual([['panel:test/layers', 'dock', 'inspector']]);
  });

  it('retains pinned slots the next spec omits, after their old predecessor', async () => {
    const before = diffSpecs(EMPTY_LAYOUT, await validated(spec('s', ['a', 'b', 'c']))).target;
    const diff = diffSpecs(before, await validated(spec('t', ['a', 'c', 'd'])), { pinned: new Set(['tool:test/b']) });
    expect(diff.retained).toEqual(['tool:test/b']);
    expect(diff.unmount).toEqual([]);
    expect(layoutGroups(diff.target)['tool@default']).toEqual(['tool:test/a', 'tool:test/b', 'tool:test/c', 'tool:test/d']);
    const first = diffSpecs(before, await validated(spec('u', ['c'])), { pinned: new Set(['tool:test/a']) });
    expect(layoutGroups(first.target)['tool@default']).toEqual(['tool:test/a', 'tool:test/c']);
    const alone = diffSpecs(before, await validated(spec('v', [])), { pinned: new Set(['tool:test/b']) });
    expect(layoutGroups(alone.target)['tool@default']).toEqual(['tool:test/b']);
  });
});

describe('spec motion', () => {
  it('clamps to 120–200 ms and drops to 0 under reduced motion', () => {
    expect(clampSpecMotion({ enterMs: 20, moveMs: 900 })).toMatchObject({ enterMs: 120, moveMs: 200, exitMs: DEFAULT_SPEC_MOTION.exitMs });
    expect(clampSpecMotion({ enterMs: Number.NaN }).enterMs).toBe(120);
    expect(specMotionStep(DEFAULT_SPEC_MOTION, 'mount', false)).toMatchObject({ durationMs: 160, reduced: false });
    expect(specMotionStep(DEFAULT_SPEC_MOTION, 'unmount', true).durationMs).toBe(0);
    for (const kind of ['mount', 'move', 'unmount', 'context'] as const) {
      const ms = specMotionStep(DEFAULT_SPEC_MOTION, kind, false).durationMs;
      expect(ms).toBeGreaterThanOrEqual(120);
      expect(ms).toBeLessThanOrEqual(200);
    }
  });
});

describe('createSpecRuntime', () => {
  it('drives the port in order: unmounts (reverse), moves, context, mounts (display order)', async () => {
    const port = recordingPort();
    const runtime = createSpecRuntime({ vocabulary: vocab(), port });
    expect(runtime.state).toBe('empty');
    await runtime.apply(spec('s', ['a', 'b', 'c', 'd']));
    expect(runtime.state).toBe('mounted');
    port.calls.length = 0;
    const applied = await runtime.apply(spec('t', ['d', 'b', 'e'], {}, 'test/pixel'));
    expect(applied.ok).toBe(true);
    expect(port.calls.map((c) => `${c.op} ${c.key}`)).toEqual([
      'unmount tool:test/c',
      'unmount tool:test/a',
      'unmount lens:test/canvas',
      'move tool:test/d',
      'context lens',
      'mount lens:test/pixel',
      'mount tool:test/e',
    ]);
    expect(runtime.layout.slots.map((s) => s.key)).toEqual(['lens:test/pixel', 'tool:test/d', 'tool:test/b', 'tool:test/e']);
    expect(port.calls.every((c) => c.step.durationMs >= 120 && c.step.durationMs <= 200)).toBe(true);
  });

  it('reduced motion: every step is 0 ms', async () => {
    const port = recordingPort();
    const runtime = createSpecRuntime({ vocabulary: vocab(), port, reducedMotion: () => true });
    await runtime.apply(spec('s', ['a']));
    expect(port.calls.every((c) => c.step.durationMs === 0 && c.step.reduced)).toBe(true);
  });

  it('rejects invalid or gated specs without touching the port', async () => {
    const port = recordingPort();
    const runtime = createSpecRuntime({ vocabulary: vocab(), port, decide: denyPremium });
    const denied = await runtime.apply({ ...spec('g', []), slots: [...spec('g', []).slots, { section: 'panel', id: 'test/premium' }] });
    expect(!denied.ok && denied.error.code).toBe('SF-SHELL-009');
    expect(port.calls).toEqual([]);
    expect(runtime.state).toBe('empty');
    // A per-apply decide port (e.g. an agent subject) overrides the default.
    expect((await runtime.apply({ ...spec('g', []), slots: [...spec('g', []).slots, { section: 'panel', id: 'test/premium' }] }, { decide: { decide: () => ({ effect: 'allow' }) } })).ok).toBe(true);
  });

  it('pins: a new spec never removes a pinned slot; specs add pins; unpin lets the next spec remove it', async () => {
    const port = recordingPort();
    const runtime = createSpecRuntime({ vocabulary: vocab(), port });
    await runtime.apply(spec('s', ['a', 'b'], { pinned: ['tool:test/a'] }));
    expect([...runtime.pinned]).toEqual(['tool:test/a']);
    expect(runtime.pin('tool:test/b').ok).toBe(true);
    expect(runtime.pin('lens:test/canvas').ok).toBe(false);
    expect(runtime.pin('tool:test/zzz').ok).toBe(false);
    const applied = await runtime.apply(spec('t', ['c']));
    expect(applied.ok && applied.value.diff.retained).toEqual(['tool:test/a', 'tool:test/b']);
    expect(runtime.layout.slots.map((s) => s.key)).toEqual(['lens:test/canvas', 'tool:test/a', 'tool:test/b', 'tool:test/c']);
    expect(runtime.unpin('tool:test/b').ok).toBe(true);
    expect(runtime.unpin('tool:test/b').ok).toBe(false);
    await runtime.apply(spec('u', ['c']));
    expect(runtime.layout.slots.map((s) => s.key)).toEqual(['lens:test/canvas', 'tool:test/a', 'tool:test/c']);
  });

  it('gating wins over pinning: a retained pin that is now denied is dropped; revalidate unmounts denied slots', async () => {
    let allow = true;
    const decide: DecidePort = { decide: (r) => (r.id !== premium.id || allow ? { effect: 'allow' } : { effect: 'deny', reason: 'upgrade' }) };
    const runtime = createSpecRuntime({ vocabulary: vocab(), port: recordingPort(), decide });
    const withPremium = { ...spec('s', ['a']), slots: [...spec('s', ['a']).slots, { section: 'panel', id: 'test/premium' as const }], pinned: ['panel:test/premium' as const] };
    await runtime.apply(withPremium);
    allow = false;
    const next = await runtime.apply(spec('t', ['a']));
    expect(next.ok && next.value.droppedPins).toEqual(['panel:test/premium']);
    expect(runtime.layout.slots.some((s) => s.key === 'panel:test/premium')).toBe(false);
    allow = true;
    await runtime.apply({ ...withPremium, pinned: [] });
    allow = false;
    const revalidated = await runtime.revalidate();
    expect(revalidated.ok && revalidated.value?.diff.unmount.map((s) => s.key)).toEqual(['panel:test/premium']);
    expect((await createSpecRuntime({ vocabulary: vocab(), port: recordingPort() }).revalidate()).ok).toBe(true);
  });

  it('preview validates and diffs without mounting; validate passes through', async () => {
    const port = recordingPort();
    const runtime = createSpecRuntime({ vocabulary: vocab(), port });
    const preview = await runtime.preview(spec('s', ['a']));
    expect(preview.ok && preview.value.diff.mount).toHaveLength(2);
    expect(port.calls).toEqual([]);
    expect((await runtime.validate(spec('s', ['nope']))).ok).toBe(false);
    expect((await runtime.preview(spec('s', ['nope']))).ok).toBe(false);
  });

  it('port failures are reported (SF-SHELL-014) and the layout reflects what really mounted', async () => {
    const port = recordingPort((op, key) => (op === 'mount' && key === 'tool:test/b') || (op === 'unmount' && key === 'tool:test/c'));
    const runtime = createSpecRuntime({ vocabulary: vocab(), port });
    const first = await runtime.apply(spec('s', ['a', 'b', 'c']));
    expect(first.ok && first.value.failures.map((f) => [f.code, (f.details as { slot: string }).slot])).toEqual([['SF-SHELL-014', 'tool:test/b']]);
    expect(runtime.layout.slots.map((s) => s.key)).toEqual(['lens:test/canvas', 'tool:test/a', 'tool:test/c']);
    const second = await runtime.apply(spec('t', ['a']));
    expect(second.ok && second.value.failures).toHaveLength(1);
    expect(runtime.layout.slots.map((s) => s.key)).toContain('tool:test/c');
    const throwing: SpecMountPort = { ...recordingPort(), mount: () => Promise.reject(new Error('thrown')) };
    const third = await createSpecRuntime({ vocabulary: vocab(), port: throwing }).apply(spec('s', []));
    expect(third.ok && third.value.failures).toHaveLength(1);
  });

  it('serializes applies, notifies listeners, emits telemetry, honours abort, and disposes', async () => {
    const memory = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(memory);
    const port = recordingPort();
    const runtime = createSpecRuntime({ vocabulary: vocab(), port, telemetry });
    const seen: string[] = [];
    const off = runtime.onApplied((a) => seen.push(a.spec.spec.id));
    await Promise.all([runtime.apply(spec('one', ['a'])), runtime.apply(spec('two', ['b']))]);
    expect(seen).toEqual(['one', 'two']);
    off();
    expect(memory.records.some((r) => 'name' in r && r.name === 'shell.spec.applied')).toBe(true);
    const controller = new AbortController();
    controller.abort();
    const aborted = await runtime.apply(spec('three', ['c']), { signal: controller.signal });
    expect(!aborted.ok && aborted.error.code).toBe('SF-CORE-002');
    port.calls.length = 0;
    await runtime.dispose();
    expect(port.calls.map((c) => `${c.op} ${c.key}`)).toEqual(['unmount tool:test/b', 'unmount lens:test/canvas']);
    expect(port.calls.every((c) => c.step.durationMs === 0)).toBe(true);
    expect(runtime.state).toBe('disposed');
    expect(runtime.layout.slots).toEqual([]);
    const late = await runtime.apply(spec('four', []));
    expect(!late.ok && late.error.code).toBe('SF-SHELL-015');
    await runtime.dispose();
  });

  it('mirrors the documented lifecycle', () => {
    expect(SpecRuntimeLifecycle.transitions.mounted).toEqual({ apply: 'applying', dispose: 'disposed' });
    expect(SpecRuntimeLifecycle.transitions.applying).toEqual({ settle: 'mounted', clear: 'empty', dispose: 'disposed' });
  });
});
