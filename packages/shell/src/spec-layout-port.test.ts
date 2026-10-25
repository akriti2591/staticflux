import { ok, type Result } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createSpecLayoutPort, createSpecRuntime, createSpecVocabulary, defineSpecContribution, defineSpecSection, type ShellSpec, type SpecVocabulary } from './spec.js';

const vocabulary = (): SpecVocabulary => {
  const result = createSpecVocabulary({
    sections: [defineSpecSection({ id: 'lens', cardinality: 'one' }), defineSpecSection({ id: 'tool', pinnable: true }), defineSpecSection({ id: 'panel', placements: ['dock', 'inspector'] })],
    contributions: [
      defineSpecContribution({ section: 'lens', id: 'v/canvas' }),
      ...['a', 'b', 'c'].map((n) => defineSpecContribution({ section: 'tool', id: `v/${n}` as const })),
      defineSpecContribution({ section: 'panel', id: 'v/layers' }),
    ],
  });
  if (!result.ok) throw result.error;
  return result.value;
};

const spec = (tools: readonly string[], panelPlacement?: string): ShellSpec => ({
  id: 'v',
  context: { lens: 'v/canvas' },
  slots: [
    { section: 'lens', id: 'v/canvas' },
    ...tools.map((t) => ({ section: 'tool', id: `v/${t}` as const })),
    ...(panelPlacement === undefined ? [] : [{ section: 'panel', id: 'v/layers' as const, placement: panelPlacement }]),
  ],
});

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
  expect(condition()).toBe(true);
};

/** A wait the test releases by hand. */
function manualWait(): { wait: (ms: number, signal: AbortSignal) => Promise<Result<void>>; release(): void; pending(): number[] } {
  const queue: { ms: number; resolve: () => void }[] = [];
  return {
    wait: (ms, signal) =>
      new Promise((resolve) => {
        const entry = { ms, resolve: () => resolve(ok()) };
        queue.push(entry);
        signal.addEventListener('abort', entry.resolve, { once: true });
      }),
    release: () => {
      for (const entry of queue.splice(0)) entry.resolve();
    },
    pending: () => queue.map((e) => e.ms),
  };
}

describe('createSpecLayoutPort', () => {
  it('entering → present, exiting kept in place until its motion ends, moving across placements', async () => {
    const clock = manualWait();
    const port = createSpecLayoutPort({ wait: clock.wait });
    const runtime = createSpecRuntime({ vocabulary: vocabulary(), port });
    const first = runtime.apply(spec(['a', 'b'], 'dock'));
    await until(() => port.entries('tool@default').length === 2);
    expect(port.entries('tool@default').map((e) => [e.slot.id, e.phase])).toEqual([
      ['v/a', 'entering'],
      ['v/b', 'entering'],
    ]);
    expect(port.mountedContext).toEqual({ lens: 'v/canvas' });
    expect(port.contextStep?.durationMs).toBe(160);
    clock.release();
    await first;
    expect(port.entries('tool@default').every((e) => e.phase === 'present')).toBe(true);

    const second = runtime.apply(spec(['b', 'c'], 'inspector'));
    await until(() => port.entries('tool@default').length === 3);
    expect(port.entries('tool@default').map((e) => [e.slot.id, e.phase])).toEqual([
      ['v/a', 'exiting'],
      ['v/b', 'present'],
      ['v/c', 'entering'],
    ]);
    expect(port.groups()['tool@default']).toEqual(['tool:v/b', 'tool:v/c']);
    expect(port.entries('panel@dock')).toEqual([]);
    expect(port.entries('panel@inspector').map((e) => e.phase)).toEqual(['moving']);
    expect(clock.pending()).toEqual(expect.arrayContaining([120, 200, 160]));
    clock.release();
    await second;
    expect(port.entries('tool@default').map((e) => e.slot.id)).toEqual(['v/b', 'v/c']);
    expect(port.groups()).toEqual({ 'lens@default': ['lens:v/canvas'], 'tool@default': ['tool:v/b', 'tool:v/c'], 'panel@inspector': ['panel:v/layers'] });
  });

  it('reduced motion settles in the same task; dispose empties every group', async () => {
    const port = createSpecLayoutPort();
    const runtime = createSpecRuntime({ vocabulary: vocabulary(), port, reducedMotion: () => true });
    await runtime.apply(spec(['a', 'c']));
    expect(port.entries('tool@default').map((e) => e.phase)).toEqual(['present', 'present']);
    await runtime.apply(spec(['c', 'a']));
    expect(port.groups()['tool@default']).toEqual(['tool:v/c', 'tool:v/a']);
    await runtime.dispose();
    expect(port.groups()).toEqual({});
  });

  it('default wait is a real timer and an abort settles at once', async () => {
    const port = createSpecLayoutPort();
    const runtime = createSpecRuntime({ vocabulary: vocabulary(), port, motion: { enterMs: 120 } });
    const controller = new AbortController();
    const applying = runtime.apply(spec(['a']), { signal: controller.signal });
    await until(() => port.entries('tool@default').length === 1);
    expect(port.entries('tool@default')[0]?.phase).toBe('entering');
    controller.abort();
    expect((await applying).ok).toBe(true);
    expect(port.entries('tool@default').map((e) => e.phase)).toEqual(['present']);
  });
});
