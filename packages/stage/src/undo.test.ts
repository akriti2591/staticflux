import { err, ok } from '@staticflux/core';
import { createMemoryDocumentStore, type OpenDocument } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { transactionMeta } from './actor.js';
import { createUndoService, DEFAULT_UNDO_LIMIT, type UndoMeta, type UndoOutcome, type UndoService } from './undo.js';
import { LockedPathError } from './errors.js';
import { agent, alice, bob, openSeeded, reopen, setX, signal, unwrap, x } from './test-helpers.js';

const applied = (o: UndoOutcome): Extract<UndoOutcome, { kind: 'applied' }> => {
  if (o.kind !== 'applied') throw new Error(`expected applied, got ${o.kind}: ${JSON.stringify(o)}`);
  return o;
};
const conflict = (o: UndoOutcome): Extract<UndoOutcome, { kind: 'conflict' }> => {
  if (o.kind !== 'conflict') throw new Error(`expected conflict, got ${o.kind}`);
  return o;
};

/** Two sessions (tabs / peers) on one asset, records relayed both ways through their undo services. */
async function twoPeers() {
  const { store, doc: a } = await openSeeded();
  unwrap(await a.flush(signal));
  const b = await reopen(store);
  const ua = createUndoService({ doc: a });
  const ub = createUndoService({ doc: b });
  a.onCommit((r) => void ub.applyRemote(r));
  b.onCommit((r) => void ua.applyRemote(r));
  return { store, a, b, ua, ub };
}

describe('undo service: steps', () => {
  it('undoes and redoes one commit as one step with a readable label', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'Move box', setX('box', 10)));
    expect(undo.peek(alice.id, 'undo')).toMatchObject({ actor: alice.id, label: 'Move box', commits: 1, parts: ['page:p1'] });
    const out = applied(unwrap(await undo.undo(alice, signal)));
    expect(out.step.label).toBe('Move box');
    expect(out.record.meta.label).toBe('Undo Move box');
    expect((out.record.meta as UndoMeta).undoOf).toBe(out.step.key);
    expect(x(doc)).toBe(0);
    expect(undo.canUndo(alice.id)).toBe(false);
    expect(undo.peek(alice.id, 'redo')?.label).toBe('Move box');
    const redone = applied(unwrap(await undo.redo(alice, signal)));
    expect(redone.record.meta.label).toBe('Redo Move box');
    expect(x(doc)).toBe(10);
    expect(undo.canRedo(alice.id)).toBe(false);
    expect(undo.canUndo(alice.id)).toBe(true);
    applied(unwrap(await undo.undo(alice, signal)));
    expect(x(doc)).toBe(0);
  });

  it('reports empty stacks', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    expect(unwrap(await undo.undo(alice, signal))).toEqual({ kind: 'empty', direction: 'undo' });
    expect(unwrap(await undo.redo(alice, signal))).toEqual({ kind: 'empty', direction: 'redo' });
    expect(undo.peek(alice.id, 'undo')).toBeUndefined();
    expect(undo.history(alice.id)).toEqual({ undo: [], redo: [] });
  });

  it('one gesture is one step', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    const g = unwrap(undo.gesture(alice, 'Drag', 'page:p1'));
    for (let i = 1; i <= 20; i += 1) unwrap(g.stage([{ op: 'set', node: 'box', path: 'spatial.x', value: i }]));
    unwrap(g.commit());
    expect(undo.history(alice.id).undo).toHaveLength(1);
    expect(x(doc)).toBe(20);
    applied(unwrap(await undo.undo(alice, signal)));
    expect(x(doc)).toBe(0);
  });

  it('groups one capability invocation (or one change set) into one step', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    const run = { ...agent, invocationId: 'inv-1' };
    unwrap(undo.commit(run, 'Tidy', setX('box', 5)));
    unwrap(undo.commit(run, 'Tidy', setX('card', 6)));
    unwrap(undo.commit(run, 'Tidy', setX('box', 7)));
    unwrap(undo.commit(agent, 'Apply change set', setX('card', 8), { changeSet: 'cs_1' }));
    unwrap(undo.commit(agent, 'Apply change set', setX('box', 9), { changeSet: 'cs_1' }));
    const steps = undo.history(agent.id).undo;
    expect(steps.map((s) => [s.label, s.commits])).toEqual([
      ['Apply change set', 2],
      ['Tidy', 3],
    ]);
    expect(steps[0]?.changeSet).toBe('cs_1');
    expect(steps[1]?.invocation).toBe('inv-1');
    applied(unwrap(await undo.undo(agent, signal)));
    expect([x(doc), x(doc, 'card')]).toEqual([7, 6]);
    applied(unwrap(await undo.undo(agent, signal)));
    expect([x(doc), x(doc, 'card')]).toEqual([0, 100]);
    applied(unwrap(await undo.redo(agent, signal)));
    expect([x(doc), x(doc, 'card')]).toEqual([7, 6]);
  });

  it('a cross-page move is one step and undoes as one commit touching both parts', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(doc.moveAcross(transactionMeta(alice, 'Move to page 2'), { node: 'box', from: 'page:p1', to: 'page:p2', parent: 'p2' }));
    expect(doc.loadedPart('page:p2')?.has('box')).toBe(true);
    expect(undo.peek(alice.id, 'undo')?.parts).toEqual(['page:p1', 'page:p2']);
    const out = applied(unwrap(await undo.undo(alice, signal)));
    expect(Object.keys(out.record.updates).sort()).toEqual(['page:p1', 'page:p2']);
    expect(doc.loadedPart('page:p1')?.has('box')).toBe(true);
    expect(doc.loadedPart('page:p2')?.has('box')).toBe(false);
  });

  it('a new edit clears the actor’s redo stack only', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'A', setX('box', 1)));
    unwrap(undo.commit(bob, 'B', setX('card', 2)));
    applied(unwrap(await undo.undo(alice, signal)));
    applied(unwrap(await undo.undo(bob, signal)));
    unwrap(undo.commit(alice, 'A2', setX('box', 3)));
    expect(undo.canRedo(alice.id)).toBe(false);
    expect(undo.canRedo(bob.id)).toBe(true);
    expect(undo.actors()).toEqual([alice.id, bob.id, 'seed']);
  });

  it('keeps 200 steps per actor (D9) and a configurable limit', async () => {
    const { doc } = await openSeeded();
    expect(DEFAULT_UNDO_LIMIT).toBe(200);
    const undo = createUndoService({ doc, limit: 3 });
    for (let i = 1; i <= 5; i += 1) unwrap(undo.commit(alice, `Step ${i}`, setX('box', i)));
    expect(undo.history(alice.id).undo.map((s) => s.label)).toEqual(['Step 5', 'Step 4', 'Step 3']);
    for (let i = 0; i < 3; i += 1) applied(unwrap(await undo.undo(alice, signal)));
    expect(x(doc)).toBe(2);
    expect((await undo.undo(alice, signal)).ok && undo.canUndo(alice.id)).toBe(false);
  });

  it('ignores commits without a transaction id (not undoable)', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(doc.commit({ actor: { kind: 'human', id: alice.id }, label: 'raw' }, setX('box', 4)));
    expect(undo.canUndo(alice.id)).toBe(false);
  });
});

describe('undo service: per actor', () => {
  it('undo never reverts another actor’s edit; interleaved edits on other paths survive', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'A x', setX('box', 1)));
    unwrap(undo.commit(agent, 'Agent y', setX('box', 2, 'spatial.y')));
    unwrap(undo.commit(alice, 'A card', setX('card', 3)));
    applied(unwrap(await undo.undo(agent, signal)));
    expect([x(doc), x(doc, 'box', 'spatial.y'), x(doc, 'card')]).toEqual([1, 0, 3]);
    applied(unwrap(await undo.undo(alice, signal)));
    applied(unwrap(await undo.undo(alice, signal)));
    expect([x(doc), x(doc, 'card')]).toEqual([0, 100]);
  });

  it('flags an undo over another actor’s later overwrite (S4: the human’s undo would give x = 0)', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'Set x', setX('box', 10)));
    unwrap(undo.commit(agent, 'Agent x', setX('box', 20)));
    const flagged = conflict(unwrap(await undo.undo(alice, signal)));
    expect(flagged.conflicts).toEqual([
      { kind: 'overwritten', part: 'page:p1', node: 'box', path: 'spatial.x', expected: 10, current: 20, restore: 0, by: [agent.id], ops: [0] },
    ]);
    expect(x(doc)).toBe(20); // nothing written
    expect(undo.canUndo(alice.id)).toBe(true); // step kept for the user's decision
    const kept = applied(unwrap(await undo.undo(alice, signal, { onConflict: 'keep-theirs' })));
    expect(kept.resolved).toHaveLength(1);
    expect(x(doc)).toBe(20);
    expect(undo.canUndo(alice.id)).toBe(false);
    expect(undo.canRedo(alice.id)).toBe(false); // nothing was undone, so nothing to redo
  });

  it('overwrite restores the actor’s value on request', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'Set x', setX('box', 10)));
    unwrap(undo.commit(agent, 'Agent x', setX('box', 20)));
    const out = applied(unwrap(await undo.undo(alice, signal, { onConflict: 'overwrite' })));
    expect(out.resolved.map((c) => c.kind)).toEqual(['overwritten']);
    expect(x(doc)).toBe(0);
    // redo reverts the undo: back to what was there before it (the agent's value)
    applied(unwrap(await undo.redo(alice, signal)));
    expect(x(doc)).toBe(20);
  });

  it('keep-theirs restores only what nobody touched', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'Both', { 'page:p1': [{ op: 'set', node: 'box', path: 'spatial.x', value: 10 }, { op: 'set', node: 'card', path: 'spatial.x', value: 11 }] }));
    unwrap(undo.commit(agent, 'Agent', setX('box', 20)));
    expect(conflict(unwrap(await undo.undo(alice, signal))).conflicts.map((c) => c.node)).toEqual(['box']);
    applied(unwrap(await undo.undo(alice, signal, { onConflict: 'keep-theirs' })));
    expect([x(doc), x(doc, 'card')]).toEqual([20, 100]);
    // redo re-applies only what the undo changed
    applied(unwrap(await undo.redo(alice, signal)));
    expect([x(doc), x(doc, 'card')]).toEqual([20, 11]);
  });

  it('does not flag when the other actor wrote the same value back, or wrote another path', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'Set x', setX('box', 10)));
    unwrap(undo.commit(agent, 'Agent y', setX('box', 5, 'spatial.y')));
    unwrap(undo.commit(agent, 'Agent x', setX('box', 30)));
    unwrap(undo.commit(agent, 'Agent x back', setX('box', 10)));
    applied(unwrap(await undo.undo(alice, signal)));
    expect([x(doc), x(doc, 'box', 'spatial.y')]).toEqual([0, 5]);
  });

  it('flags a redo over a later overwrite too', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'Set x', setX('box', 10)));
    applied(unwrap(await undo.undo(alice, signal)));
    unwrap(undo.commit(agent, 'Agent x', setX('box', 40)));
    const out = conflict(unwrap(await undo.redo(alice, signal)));
    expect(out.direction).toBe('redo');
    expect(out.conflicts[0]).toMatchObject({ kind: 'overwritten', expected: 0, current: 40, restore: 10 });
  });

  it('flags structural conflicts: node deleted, node moved, created node edited', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'Set x', setX('box', 10)));
    unwrap(undo.commit(agent, 'Delete box', { 'page:p1': [{ op: 'delete', node: 'box' }] }));
    expect(conflict(unwrap(await undo.undo(alice, signal))).conflicts[0]).toMatchObject({ kind: 'deleted', node: 'box', by: [agent.id] });
    const dropped = applied(unwrap(await undo.undo(alice, signal, { onConflict: 'overwrite' })));
    expect(dropped.resolved.map((c) => c.kind).sort()).toEqual(['deleted', 'invalid']);

    unwrap(undo.commit(bob, 'Move card', { 'page:p1': [{ op: 'move', node: 'card', parent: null }] }));
    unwrap(undo.commit(agent, 'Move card back', { 'page:p1': [{ op: 'move', node: 'card', parent: 'p1' }] }));
    expect(conflict(unwrap(await undo.undo(bob, signal))).conflicts[0]).toMatchObject({ kind: 'moved', node: 'card', expected: null, current: 'p1', restore: 'p1', by: [agent.id] });

    unwrap(undo.commit(bob, 'Create', { 'page:p1': [{ op: 'create', node: 'new', kind: 'shape', parent: 'p1' }] }));
    unwrap(undo.commit(agent, 'Style new', setX('new', 3)));
    expect(conflict(unwrap(await undo.undo(bob, signal))).conflicts[0]).toMatchObject({ kind: 'edited', node: 'new', by: [agent.id] });
  });

  it('flags an inverse that no longer validates, and repairs it under overwrite', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(doc.commit(transactionMeta(alice, 'Add sibling'), { 'page:p1': [{ op: 'create', node: 'sib', kind: 'shape', parent: 'p1' }] }));
    // card after box: move card to the end (after "sib"), then the agent deletes "box" (card's old predecessor)
    unwrap(undo.commit(bob, 'Reorder card', { 'page:p1': [{ op: 'move', node: 'card', parent: 'p1' }] }));
    unwrap(undo.commit(agent, 'Delete box', { 'page:p1': [{ op: 'delete', node: 'box' }] }));
    const out = conflict(unwrap(await undo.undo(bob, signal)));
    expect(out.conflicts.map((c) => c.kind)).toEqual(['invalid']);
    expect(out.conflicts[0]?.code).toBe('SF-DOC-008');
    const fixed = applied(unwrap(await undo.undo(bob, signal, { onConflict: 'overwrite' })));
    expect(fixed.resolved).toEqual([]); // repaired (stale position dropped), not lost
    expect(doc.loadedPart('page:p1')?.node('card')?.parent).toBe('p1');
  });

  it('text undo is anchored: concurrent typing by others survives without a conflict', async () => {
    const { doc } = await openSeeded();
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'Add text', { 'page:p1': [{ op: 'create', node: 't', kind: 'text', parent: 'p1', texts: { 'text.content': { text: 'Hello world', spans: [] } } }] }));
    unwrap(undo.commit(alice, 'Type', { 'page:p1': [{ op: 'text.insert', node: 't', path: 'text.content', at: 5, text: ' big' }] }));
    unwrap(undo.commit(agent, 'Type', { 'page:p1': [{ op: 'text.insert', node: 't', path: 'text.content', at: 0, text: '>> ' }] }));
    applied(unwrap(await undo.undo(alice, signal)));
    expect(doc.loadedPart('page:p1')?.text('t', 'text.content')?.text).toBe('>> Hello world');
  });
});

describe('undo service: peers, persistence, guard', () => {
  it('two peers: each actor undoes only its own edits and both converge', async () => {
    const { a, b, ua, ub } = await twoPeers();
    unwrap(ua.commit(alice, 'A', setX('box', 1)));
    unwrap(ub.commit(agent, 'Agent', setX('card', 2)));
    applied(unwrap(await ub.undo(agent, signal)));
    expect([x(a), x(a, 'card'), x(b), x(b, 'card')]).toEqual([1, 100, 1, 100]);
    // the agent's undo arrived in A too: A's copy of the agent stack is consumed
    expect(ua.canUndo(agent.id)).toBe(false);
    expect(ua.canRedo(agent.id)).toBe(true);
    unwrap(ub.commit(agent, 'Agent x', setX('box', 9)));
    expect(conflict(unwrap(await ua.undo(alice, signal))).conflicts[0]?.by).toEqual([agent.id]);
  });

  it('persists stacks across reload and compaction (undo/redo links in commit meta)', async () => {
    const store = createMemoryDocumentStore();
    const { doc } = await openSeeded(store);
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'One', setX('box', 1)));
    unwrap(undo.commit(alice, 'Two', setX('box', 2)));
    unwrap(undo.commit(alice, 'Three', setX('box', 3)));
    applied(unwrap(await undo.undo(alice, signal)));
    unwrap(await doc.flush(signal));
    unwrap(await doc.compact(signal));
    unwrap(undo.commit(bob, 'Bob', setX('card', 5)));
    unwrap(await doc.close(signal, { compact: false }));

    const reopened = await reopen(store);
    const again = createUndoService({ doc: reopened });
    expect(again.history(alice.id)).toEqual(undo.history(alice.id));
    expect(again.history(alice.id).undo.map((s) => s.label)).toEqual(['Two', 'One']);
    expect(again.peek(alice.id, 'redo')?.label).toBe('Three');
    applied(unwrap(await again.redo(alice, signal)));
    expect(x(reopened)).toBe(3);
    applied(unwrap(await again.undo(bob, signal)));
    expect(x(reopened, 'card')).toBe(100);
  });

  it('flags history-unavailable after shallow compaction instead of guessing', async () => {
    const store = createMemoryDocumentStore();
    const { doc } = await openSeeded(store);
    const undo = createUndoService({ doc });
    unwrap(undo.commit(alice, 'One', setX('box', 1)));
    unwrap(undo.commit(bob, 'Bob', setX('card', 2)));
    unwrap(await doc.compact(signal, { history: 'shallow' }));
    unwrap(await doc.close(signal, { compact: false }));
    const reopened = await reopen(store);
    const again = createUndoService({ doc: reopened });
    expect(conflict(unwrap(await again.undo(alice, signal))).conflicts[0]?.kind).toBe('history-unavailable');
    applied(unwrap(await again.undo(alice, signal, { onConflict: 'overwrite' })));
    expect(x(reopened)).toBe(0);
  });

  it('ingest is idempotent and applyRemote reports bad records', async () => {
    const { a, b, ub } = await twoPeers();
    const committed = unwrap(a.commit(transactionMeta(alice, 'A'), setX('box', 1)));
    ub.ingest(committed.record);
    ub.ingest(committed.record);
    expect(ub.history(alice.id).undo).toHaveLength(1);
    expect(ub.applyRemote({ ...committed.record, updates: { 'page:p1': new Uint8Array([1, 2]) } }).ok).toBe(false);
    expect(x(b)).toBe(1);
  });

  it('runs every write through the guard (locks), undo and redo included', async () => {
    const { doc } = await openSeeded();
    let locked = false;
    const undo = createUndoService({ doc, guard: () => (locked ? err(LockedPathError()) : ok()) });
    unwrap(undo.commit(alice, 'A', setX('box', 1)));
    locked = true;
    expect(undo.commit(alice, 'B', setX('box', 2)).ok).toBe(false);
    expect(unwrap(undo.gesture(alice, 'G', 'page:p1')).stage([{ op: 'set', node: 'box', path: 'spatial.x', value: 3 }]).ok).toBe(true);
    const undone = await undo.undo(alice, signal);
    expect(undone.ok ? '' : undone.error.code).toBe('SF-STAGE-001');
    expect(x(doc)).toBe(1);
  });

  it('serializes concurrent undo calls and stops after dispose', async () => {
    const { doc } = await openSeeded();
    const undo: UndoService = createUndoService({ doc });
    unwrap(undo.commit(alice, 'A', setX('box', 1)));
    unwrap(undo.commit(alice, 'B', setX('box', 2)));
    const [first, second] = await Promise.all([undo.undo(alice, signal), undo.undo(alice, signal)]);
    expect([unwrap(first).kind, unwrap(second).kind]).toEqual(['applied', 'applied']);
    expect(x(doc)).toBe(0);
    const aborted = new AbortController();
    aborted.abort();
    unwrap(undo.commit(alice, 'C', setX('box', 3)));
    const abortedResult = await undo.undo(alice, aborted.signal);
    expect(abortedResult.ok ? '' : abortedResult.error.kind).toBe('aborted');
    undo.dispose();
    expect(undo.disposed).toBe(true);
    const after = await undo.undo(alice, signal);
    expect(after.ok ? '' : after.error.code).toBe('SF-STAGE-005');
    expect(undo.commit(alice, 'D', setX('box', 4)).ok).toBe(false);
    expect(undo.gesture(alice, 'G', 'page:p1').ok).toBe(false);
    expect(undo.applyRemote({ peer: '1', meta: transactionMeta(alice, 'x'), updates: {}, inverse: {} }).ok).toBe(false);
    undo.dispose();
  });

  it('reports a missing part as an error', async () => {
    const { doc } = await openSeeded();
    const fake: OpenDocument = { ...doc, part: async () => err(LockedPathError()) } as unknown as OpenDocument;
    const undo = createUndoService({ doc: { commit: (m, c) => doc.commit(m, c), part: fake.part, undoHistory: (a) => doc.undoHistory(a), onCommit: (l) => doc.onCommit(l), applyRemote: (r) => doc.applyRemote(r) } });
    unwrap(undo.commit(alice, 'A', setX('box', 1)));
    expect((await undo.undo(alice, signal)).ok).toBe(false);
  });
});
