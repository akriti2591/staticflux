// @vitest-environment node
import { err, ok, type Result } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { elementCapabilities, elementHudActions } from '../elements/contributions.js';
import { P } from '../elements/components.js';
import { createEditorRegistries } from '../spec/registries.js';
import { studioHudActions, studioLenses, studioPanels, studioTools } from '../spec/studio-contributions.js';
import { studioSpec } from '../spec/studio-spec.js';
import { FREE_TRANSFORM_HUD, handTool, runTransform, runTransformSteps, selectTool, TOOL_HUD_COMMANDS, toolCapabilities, toolCapabilityImplementations, toolContributions, toolContributionUnits, toolHudActions } from './contributions.js';
import { createToolCommands } from './keyboard.js';
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

describe.skipIf(!authoringBuilt)('B10a capabilities (agents can call every transform)', () => {
  it('flip, skew and set-transform: one change set each, with a pivot; inputs are validated; locks apply', async () => {
    const f = await createToolFixture([shape('a', { [P.x]: 0, [P.y]: 0, [P.w]: 40, [P.h]: 20 }), shape('b', { [P.x]: 100, [P.y]: 0, [P.w]: 40, [P.h]: 20 }), shape('l', { [P.w]: 10, [P.h]: 10, [P.lockScope]: 'position' })]);
    const impls = toolCapabilityImplementations({ session: () => f.tools, actorFor: () => ok(agent) });
    const byId = (id: string) => impls.find((i) => i.capability.id === id) as unknown as { run(input: object, context: never): Promise<Result<{ readonly ops: number }>> };
    const cap = (id: string) => toolCapabilities.find((c) => c.id === id);
    expect(['instaflow/flip-horizontal', 'instaflow/flip-vertical', 'instaflow/skew-by', 'instaflow/set-transform'].every((id) => cap(id)?.exposeToAgents === true)).toBe(true);
    unwrap(await byId('instaflow/flip-horizontal').run({ nodes: ['a'] }, run()));
    expect([f.stage.value('a', P.flipX), f.stage.value('a', P.x)]).toEqual([true, 0]);
    // About a page pivot: the bottom edge of b mirrors b below it.
    unwrap(await byId('instaflow/flip-vertical').run({ nodes: ['b'], pivot: { x: 140, y: 20 } }, run()));
    expect(f.stage.value('b', P.flipY)).toBe(true);
    expect(f.stage.value('b', P.y)).toBeCloseTo(20, 9);
    unwrap(await byId('instaflow/skew-by').run({ nodes: ['a'], x: 20, y: 0 }, run()));
    expect(Math.abs(f.stage.value('a', P.skewX) as number)).toBeCloseTo(20, 9);
    unwrap(await byId('instaflow/rotate-by').run({ nodes: ['a'], degrees: 90, pivot: { x: 0, y: 0 } }, run()));
    expect(f.stage.value('a', P.rotation)).toBeCloseTo(90, 9);
    expect(f.undo.history(agent.id).undo).toHaveLength(4);
    // set-transform: the given fields in order, one undo step.
    expect(unwrap(await byId('instaflow/set-transform').run({ nodes: ['b'], x: 300, w: 80, linked: true, rotation: 15 }, run())).ops).toBeGreaterThan(0);
    expect([f.stage.value('b', P.w), f.stage.value('b', P.h), f.stage.value('b', P.rotation)]).toEqual([80, 40, 15]);
    expect(f.undo.history(agent.id).undo).toHaveLength(5);
    const bad = await byId('instaflow/set-transform').run({ nodes: ['b'], skew: 89 }, run());
    expect(!bad.ok && bad.error.code).toBe('IF-XF-001');
    expect(unwrap(await byId('instaflow/set-transform').run({ nodes: ['b'] }, run()))).toEqual({ ops: 0 });
    const locked = await byId('instaflow/flip-horizontal').run({ nodes: ['l'] }, run());
    expect(!locked.ok && locked.error.code).toBe('IF-TOOL-002');
    expect(f.undo.history(agent.id).undo).toHaveLength(5);
    const aborted = new AbortController();
    aborted.abort();
    expect((await byId('instaflow/set-transform').run({ nodes: ['b'], x: 1 }, run(aborted.signal))).ok).toBe(false);
    const setOf = (env: Parameters<typeof toolCapabilityImplementations>[0]) => toolCapabilityImplementations(env).find((i) => i.capability.id === 'instaflow/set-transform') as unknown as { run(input: object, context: never): Promise<Result<unknown>> };
    const closed = await setOf({ session: () => undefined, actorFor: () => ok(agent) }).run({ nodes: ['b'], x: 1 }, run());
    expect(!closed.ok && closed.error.code).toBe('IF-TOOL-002');
    const denied = await setOf({ session: () => f.tools, actorFor: () => err(NothingToTransformError()) }).run({ nodes: ['b'], x: 1 }, run());
    expect(denied.ok).toBe(false);
  });

  it('runTransformSteps leaves no preview behind and shows an active session again; Free transform is an editor HUD command', async () => {
    const f = await createToolFixture([shape('a', { [P.x]: 0, [P.y]: 0, [P.w]: 40, [P.h]: 20 })]);
    f.view.select(['a']);
    const k = createToolCommands(f.tools);
    const enter = TOOL_HUD_COMMANDS[FREE_TRANSFORM_HUD];
    expect(enter === undefined ? undefined : unwrap(enter(k))).toEqual({ kind: 'mode', state: 'active' });
    unwrap(k.nudge(5, 0)); // staged: x 5 shown
    unwrap(runTransformSteps(f.tools, human, 'Transform', ['a'], [(start) => ok(moveValues(start, 0, 7))]));
    expect([f.stage.value('a', P.x), f.stage.value('a', P.y)]).toEqual([5, 7]); // the session's x preview is back
    unwrap(k.cancelTransform());
    expect([f.stage.value('a', P.x), f.stage.value('a', P.y)]).toEqual([0, 7]);
    const failing = runTransformSteps(f.tools, human, 'Transform', ['a'], [() => err(NothingToTransformError())]);
    expect(failing.ok).toBe(false);
    expect(f.session.opinions('a')).toBeUndefined();
    expect(toolHudActions.find((h) => h.id === FREE_TRANSFORM_HUD)?.capability).toBeUndefined();
  });
});
