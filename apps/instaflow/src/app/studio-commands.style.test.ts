// @vitest-environment node
/** B11b slice 4: Copy / Paste style, Select same, opacity steps and the align keys' input. */
import { ok, type Result } from '@staticflux/core';
import type { PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import type { CanvasTab } from './canvas-tab.js';
import {
  CopyStyleCapability,
  implementStudioCommands,
  keyCommandInput,
  OpacityStepCapability,
  PasteStyleCapability,
  SelectSameCapability,
  STUDIO_KEY_COMMANDS,
  STUDIO_SELECTION_COMMANDS,
} from './studio-commands.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';

const shape = (node: string, x: number, fill: string, extra: Record<string, unknown> = {}): PartOp => ({
  op: 'create',
  node,
  kind: 'shape',
  parent: 'p1',
  props: { [P.x]: x, [P.y]: 10, [P.w]: 50, [P.h]: 50, [P.fills]: [{ paint: fill }], ...extra } as never,
});

const run = { invocationId: 'i', subject: 'user' as const, origin: undefined, signal: new AbortController().signal, span: undefined as never, reserved: undefined, reportCost: () => undefined };

async function rig() {
  const f = await createStudioFixture();
  const doc = f.document;
  const tab = { page: 'p1' } as unknown as CanvasTab;
  const impls = new Map(implementStudioCommands({ tab: () => tab, document: doc, actorFor: () => ok(person) }).map((i) => [i.capability.id as string, i]));
  const call = async (id: string, input: unknown): Promise<Result<{ ops: number; select?: string[] }>> =>
    (await (impls.get(id) as { run(i: unknown, r: unknown): Promise<Result<unknown>> | Result<unknown> }).run(input, run)) as Result<{ ops: number; select?: string[] }>;
  return { f, doc, call };
}

describe.skipIf(!authoringBuilt)('style commands (B11b slice 4)', () => {
  it('Paste style needs a Copy style; it writes fills, strokes, effects, corners and layer in one step', async () => {
    const { f, doc, call } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([shape('a', 0, '#ff0000', { [P.opacity]: 0.5, [P.radius]: 8 }), shape('b', 100, '#00ff00')])));
    const early = await call(PasteStyleCapability.id, { nodes: ['b'] });
    expect(early.ok).toBe(false);
    expect(unwrap(await call(CopyStyleCapability.id, { nodes: ['a'] })).ops).toBe(0);
    const pasted = unwrap(await call(PasteStyleCapability.id, { nodes: ['b'] }));
    expect(pasted.ops).toBeGreaterThan(0);
    expect(doc.view.value('b', P.fills)).toEqual([{ paint: '#ff0000' }]);
    expect(doc.view.value('b', P.opacity)).toBe(0.5);
    expect(doc.view.value('b', P.radius)).toBe(8);
    unwrap(await doc.undo.undo(person, f.signal));
    expect(doc.view.value('b', P.fills)).toEqual([{ paint: '#00ff00' }]);
    expect(doc.view.value('b', P.opacity)).toBeUndefined();
    await f.scope.dispose();
  });

  it('Paste style only one part touches only its paths', async () => {
    const { f, doc, call } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([shape('a', 0, '#ff0000', { [P.opacity]: 0.5 }), shape('b', 100, '#00ff00')])));
    unwrap(await call(CopyStyleCapability.id, { nodes: ['a'] }));
    unwrap(await call(PasteStyleCapability.id, { nodes: ['b'], only: 'layer' }));
    expect(doc.view.value('b', P.opacity)).toBe(0.5);
    expect(doc.view.value('b', P.fills)).toEqual([{ paint: '#00ff00' }]);
    await f.scope.dispose();
  });

  it('Select same fill selects every element with the first one’s top fill; kind compares shapes', async () => {
    const { f, doc, call } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([shape('a', 0, '#ff0000'), shape('b', 100, '#00ff00'), shape('c', 200, '#ff0000')])));
    expect(unwrap(await call(SelectSameCapability.id, { nodes: ['a'], by: 'fill' })).select?.sort()).toEqual(['a', 'c']);
    expect(unwrap(await call(SelectSameCapability.id, { nodes: ['b'], by: 'kind' })).select?.sort()).toEqual(['a', 'b', 'c']);
    await f.scope.dispose();
  });

  it('opacity steps clamp to 0…1 and do nothing at the limit', async () => {
    const { f, doc, call } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([shape('a', 0, '#ff0000', { [P.opacity]: 0.95 })])));
    unwrap(await call(OpacityStepCapability.id, { nodes: ['a'], delta: 0.1 }));
    expect(doc.view.value('a', P.opacity)).toBe(1);
    expect(unwrap(await call(OpacityStepCapability.id, { nodes: ['a'], delta: 0.1 })).ops).toBe(0);
    unwrap(await call(OpacityStepCapability.id, { nodes: ['a'], delta: -0.1 }));
    expect(doc.view.value('a', P.opacity)).toBe(0.9);
    await f.scope.dispose();
  });
});

describe('style and align keys (B11b slice 4)', () => {
  it('the new capabilities run on every element selection', () => {
    for (const id of [CopyStyleCapability.id, PasteStyleCapability.id, SelectSameCapability.id, OpacityStepCapability.id]) expect(STUDIO_SELECTION_COMMANDS).toContain(id);
  });

  it('an align key aligns one element to the page, several to their selection; opacity keys carry their delta', () => {
    const align = STUDIO_KEY_COMMANDS.find((k) => k.def.id === 'instaflow/align-left-key');
    const up = STUDIO_KEY_COMMANDS.find((k) => k.def.id === 'instaflow/opacity-up-key');
    expect(align === undefined || up === undefined).toBe(false);
    if (align === undefined || up === undefined) return;
    expect(keyCommandInput(align, ['a'])).toEqual({ nodes: ['a'], target: 'page' });
    expect(keyCommandInput(align, ['a', 'b'])).toEqual({ nodes: ['a', 'b'] });
    expect(keyCommandInput(up, ['a'])).toEqual({ nodes: ['a'], delta: 0.1 });
    expect(up.group).toBe('Style');
  });
});
