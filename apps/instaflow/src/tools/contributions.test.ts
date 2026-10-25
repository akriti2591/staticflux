// @vitest-environment node
import { err, ok, type Result } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { elementCapabilities, elementHudActions } from '../elements/contributions.js';
import { P } from '../elements/components.js';
import { createEditorRegistries } from '../spec/registries.js';
import { studioHudActions, studioLenses, studioPanels, studioTools } from '../spec/studio-contributions.js';
import { studioSpec } from '../spec/studio-spec.js';
import { toolCapabilities, toolCapabilityImplementations, toolContributions, toolContributionUnits, toolHudActions, runTransform, selectTool, handTool } from './contributions.js';
import { NothingToTransformError } from './errors.js';
import { authoringBuilt, createToolFixture, agent, human, shape, unwrap } from './testing/fixtures.js';
import { moveValues } from './transform.js';

const run = (signal = new AbortController().signal) => ({ invocationId: 'i1', subject: 'user', origin: undefined, signal, span: undefined, reserved: undefined, reportCost: () => undefined }) as never;

describe('B3 contributions (B0 tokens)', () => {
  it('replaces the Select and Hand placeholders by id and registers with the Studio vocabulary next to B1', () => {
    expect(toolContributions.map((t) => [t.id, t.shortcut])).toEqual([
      ['instaflow/select', 'V'],
      ['instaflow/hand', 'H'],
    ]);
    const mine = new Set(toolContributions.map((t) => t.id));
    const registries = createEditorRegistries({
      lenses: studioLenses,
      tools: [...studioTools.filter((t) => !mine.has(t.id)), selectTool, handTool],
      panels: studioPanels,
      hud: [...studioHudActions, ...elementHudActions, ...toolHudActions],
      capabilities: [...elementCapabilities, ...toolCapabilities],
    });
    expect(registries.ok).toBe(true);
    expect(registries.ok && registries.value.tool('instaflow/select')?.description).toContain('marquee');
    expect(studioSpec.tools).toContain(selectTool.id);
    // B10a adds the flips and Free transform (an editor command, no capability).
    expect(toolHudActions.map((h) => h.capability)).toEqual(['instaflow/rotate-90-cw', 'instaflow/rotate-90-ccw', 'instaflow/flip-horizontal', 'instaflow/flip-vertical', undefined]);
    expect(toolCapabilities.every((c) => c.exposeToAgents && !c.destructive)).toBe(true);
    // Align, centre in container and distribute stay B1's.
    expect(toolCapabilities.some((c) => /align|distribute|center/.test(c.id))).toBe(false);
    const units = toolContributionUnits({ session: () => undefined, actorFor: () => ok(human) });
    expect(units).toHaveLength(toolContributions.length + toolCapabilities.length * 2 + toolHudActions.length);
  });
});

describe.skipIf(!authoringBuilt)('tool capabilities (agents and HUD)', () => {
  it('run as one change set with the run actor; locks, no page, abort and denied actors are errors', async () => {
    const f = await createToolFixture([shape('a', { [P.x]: 0, [P.y]: 0, [P.w]: 40, [P.h]: 20 }), shape('l', { [P.w]: 10, [P.h]: 10, [P.lockScope]: 'position' })]);
    const impls = toolCapabilityImplementations({ session: () => f.tools, actorFor: () => ok(agent) });
    const byId = (id: string) => impls.find((i) => i.capability.id === id) as unknown as { run(input: object, context: never): Promise<Result<{ readonly ops: number }>> };
    expect(unwrap(await byId('instaflow/move-by').run({ nodes: ['a'], dx: 5, dy: 7 }, run()))).toEqual({ ops: 2 });
    expect([f.stage.value('a', P.x), f.stage.value('a', P.y)]).toEqual([5, 7]);
    expect(unwrap(await byId('instaflow/resize-by').run({ nodes: ['a'], dw: 10, dh: 0 }, run()))).toEqual({ ops: 1 });
    expect(f.stage.value('a', P.w)).toBe(50);
    expect(unwrap(await byId('instaflow/rotate-90-cw').run({ nodes: ['a'] }, run())).ops).toBeGreaterThan(0);
    expect(f.stage.value('a', P.rotation)).toBe(90);
    unwrap(await byId('instaflow/rotate-90-ccw').run({ nodes: ['a'] }, run()));
    unwrap(await byId('instaflow/rotate-by').run({ nodes: ['a'], degrees: 45 }, run()));
    expect(f.stage.value('a', P.rotation)).toBe(45);
    expect(f.undo.history(agent.id).undo).toHaveLength(5);
    const locked = await byId('instaflow/move-by').run({ nodes: ['l'], dx: 1, dy: 0 }, run());
    expect(!locked.ok && locked.error.code).toBe('IF-TOOL-002');
    const aborted = new AbortController();
    aborted.abort();
    expect((await byId('instaflow/move-by').run({ nodes: ['a'], dx: 1, dy: 0 }, run(aborted.signal))).ok).toBe(false);
    const closed = toolCapabilityImplementations({ session: () => undefined, actorFor: () => ok(agent) })[0];
    const none = await closed!.run({ nodes: ['a'], dx: 1, dy: 0 } as never, run());
    expect(!none.ok && none.error.code).toBe('IF-TOOL-002');
    const denied = toolCapabilityImplementations({ session: () => f.tools, actorFor: () => err(NothingToTransformError()) })[0];
    expect((await denied!.run({ nodes: ['a'], dx: 1, dy: 0 } as never, run())).ok).toBe(false);
    expect(unwrap(runTransform(f.tools, human, 'Move', ['a'], (start) => moveValues(start, 0, 0)))).toEqual({ ops: 0 });
  });
});
