// @vitest-environment node
/**
 * B11b's Studio commands (delete, duplicate, lock, undo, redo) over a real Studio document: one undo step each, the
 * selection output, and the round trip the pill makes (group → delete → undo × 2 brings the elements back, text
 * included).
 */
import { ok, type Result } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { runElementAction } from '../elements/capabilities.js';
import { P } from '../elements/components.js';
import { placeTextOps } from '../text/commands.js';
import { runRepeatAction } from '../repeat/capabilities.js';
import type { CanvasTab } from './canvas-tab.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';
import { DeleteCapability, DuplicateCapability, implementStudioCommands, LockCapability, lockOps, RedoCapability, STUDIO_KEY_COMMANDS, UndoCapability } from './studio-commands.js';

const rect = (node: string, x: number): PartOp => ({ op: 'create', node, kind: 'shape', parent: 'p1', props: { [P.x]: x, [P.y]: 10, [P.w]: 50, [P.h]: 50, [P.fills]: [{ paint: '#ff5c39' }] } });

const run = { invocationId: 'i', subject: 'user' as const, origin: undefined, signal: new AbortController().signal, span: undefined as never, reserved: undefined, reportCost: () => undefined };

async function rig() {
  const f = await createStudioFixture();
  const doc = f.document;
  const tab = {
    page: 'p1',
    undo: async (): Promise<Result<void>> => {
      const r = await doc.undo.undo(person, f.signal);
      return r.ok ? ok() : r;
    },
    redo: async (): Promise<Result<void>> => {
      const r = await doc.undo.redo(person, f.signal);
      return r.ok ? ok() : r;
    },
  } as unknown as CanvasTab;
  const impls = new Map(implementStudioCommands({ tab: () => tab, document: doc, actorFor: () => ok(person) }).map((i) => [i.capability.id as string, i]));
  const invoke = async (id: string, input: unknown) => unwrap((await (impls.get(id) as { run(i: unknown, r: unknown): Promise<Result<unknown>> | Result<unknown> }).run(input, run)) as Result<unknown>) as { ops: number; select?: string[] };
  return { f, doc, invoke };
}

const children = (doc: Awaited<ReturnType<typeof rig>>['doc']): string[] => [...doc.view.children('p1')];

describe.skipIf(!authoringBuilt)('Studio commands (B11b)', () => {
  it('delete, duplicate and lock write one change set each; duplicate selects the copies; undo and redo move one step', async () => {
    const { f, doc, invoke } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([rect('a', 0), rect('b', 100)])));
    const copy = await invoke(DuplicateCapability.id, { nodes: ['a'] });
    expect(copy.select).toHaveLength(1);
    expect(doc.view.value(copy.select?.[0] as NodeId, P.x)).toBe(24);
    await invoke(LockCapability.id, { nodes: ['a'] });
    expect(doc.view.value('a', P.lockScope)).toBe('all');
    await invoke(LockCapability.id, { nodes: ['a'] }); // toggles back
    expect(doc.view.value('a', P.lockScope)).toBeUndefined();
    await invoke(DeleteCapability.id, { nodes: ['b'] });
    expect(children(doc)).not.toContain('b');
    await invoke(UndoCapability.id, {});
    expect(children(doc)).toContain('b');
    await invoke(RedoCapability.id, {});
    expect(children(doc)).not.toContain('b');
    await f.scope.dispose();
  });

  it('group → delete → undo × 2 restores every element, text included (the pill round trip)', async () => {
    const { f, doc, invoke } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([rect('a', 0)])));
    unwrap(doc.commitOps('p1', person, 'Add text', unwrap(placeTextOps({ node: 't', parent: 'p1', x: 10, y: 200, text: 'Hello' }))));
    const grouped = unwrap(runElementAction({ context: () => doc.context(), target: () => doc.target('p1'), actorFor: () => ok(person) }, 'group', { nodes: ['a', 't'] }, person));
    const group = grouped.select?.[0] as NodeId;
    expect(doc.view.read(group)?.kind).toBe('group');
    await invoke(DeleteCapability.id, { nodes: [group] });
    expect(children(doc)).toEqual([]);
    await invoke(UndoCapability.id, {});
    expect(children(doc)).toEqual([group]); // the delete comes back as the group, children inside
    expect([...doc.view.children(group)].sort()).toEqual(['a', 't']);
    await invoke(UndoCapability.id, {});
    expect(children(doc).sort()).toEqual(['a', 't']);
    await f.scope.dispose();
  });

  it('duplicating a repeat copies its source and parameters, never its derived instances (B11b fix)', async () => {
    const { f, doc, invoke } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([rect('a', 0)])));
    unwrap(runRepeatAction({ context: () => doc.context(), target: () => doc.target('p1'), actorFor: () => ok(person) }, 'repeat-radial', { nodes: ['a'] }, person));
    const repeat = doc.base.read('a')?.parent as NodeId;
    expect(doc.view.children(repeat).some((n) => doc.view.isDerived(n))).toBe(true);
    const copy = await invoke(DuplicateCapability.id, { nodes: [repeat] });
    const twin = copy.select?.[0] as NodeId;
    expect(doc.base.read(twin)?.kind).toBe(doc.base.read(repeat)?.kind);
    // The copy holds a copy of the source (its own instances are derived again from its parameters).
    expect(doc.base.children(twin)).toHaveLength(1);
    expect(doc.view.children(twin).some((n) => doc.view.isDerived(n))).toBe(true);
    await f.scope.dispose();
  });

  it('lockOps: omitted `locked` locks when any is unlocked, unlocks when all are locked', async () => {
    const { f, doc } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([rect('a', 0), rect('b', 100)])));
    expect(lockOps(doc, ['a', 'b'])).toHaveLength(2);
    expect(lockOps(doc, ['a', 'b'], false)).toEqual([]);
    await f.scope.dispose();
  });

  it('every key command names a capability and keeps B8 ids for undo, redo, delete and duplicate', () => {
    const ids = STUDIO_KEY_COMMANDS.map((k) => k.def.id);
    expect(ids).toEqual(expect.arrayContaining(['instaflow/undo', 'instaflow/redo', 'instaflow/delete', 'instaflow/duplicate']));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
