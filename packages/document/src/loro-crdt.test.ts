import { describe, expect, it } from 'vitest';
import type { DocumentCRDTv2, PartOp, PeerId, TransactionMeta } from './crdt-v2.js';
import { createLoroEngine, loroLiveHandles, loroWasmMemoryBytes } from './loro-crdt.js';

/** Counts and equality only, never wall-clock: the timeout just keeps a loaded CI runner from failing it. */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

const engine = createLoroEngine();
const human: TransactionMeta = { actor: { kind: 'human', id: 'guest-1' }, label: 'Edit' };
const agent: TransactionMeta = { actor: { kind: 'agent', id: 'agent-7' }, label: 'Agent edit' };

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** root → [g1 → [a, b, c], g2, t (text "alpha beta gamma")] */
function seed(peer: PeerId = '1'): DocumentCRDTv2 {
  const doc = engine.create({ peer });
  ok(
    doc.transact(human, [
      { op: 'create', node: 'root', kind: 'composition', parent: null },
      { op: 'create', node: 'g1', kind: 'group', parent: 'root' },
      { op: 'create', node: 'g2', kind: 'group', parent: 'root' },
      { op: 'create', node: 'a', kind: 'shape', parent: 'g1', props: { 'spatial.x': 0, name: 'A' } },
      { op: 'create', node: 'b', kind: 'shape', parent: 'g1', props: { 'spatial.x': 0 } },
      { op: 'create', node: 'c', kind: 'shape', parent: 'g1', props: { 'spatial.x': 0 } },
      { op: 'create', node: 't', kind: 'text', parent: 'root', texts: { 'text.content': { text: 'alpha beta gamma', spans: [] } } },
    ]),
  );
  return doc;
}

function sync(a: DocumentCRDTv2, b: DocumentCRDTv2): void {
  ok(b.import(a.exportUpdates(b.version())));
  ok(a.import(b.exportUpdates(a.version())));
}

const undo = (doc: DocumentCRDTv2, inverse: readonly PartOp[], meta = human) => ok(doc.transact({ ...meta, label: 'Undo' }, inverse));

describe('Loro DocumentCRDTv2: tree, props, order', () => {
  it('creates nodes, reads one node at a time and keeps sibling order', () => {
    const doc = seed();
    expect(doc.children(null)).toEqual(['root']);
    expect(doc.children('g1')).toEqual(['a', 'b', 'c']);
    const a = doc.node('a');
    expect(a).toMatchObject({ id: 'a', kind: 'shape', parent: 'g1', props: { 'spatial.x': 0, name: 'A' }, texts: [], lists: [] });
    expect(typeof a?.order).toBe('string');
    expect(doc.node('t')?.texts).toEqual(['text.content']);
    expect(doc.prop('a', 'name')).toBe('A');
    expect(doc.size()).toBe(7);
    doc.dispose();
  });

  it('places nodes by after / before / index and orders by fractional key', () => {
    const doc = seed();
    ok(doc.transact(human, [{ op: 'create', node: 'x', kind: 'shape', parent: 'g1', position: { after: 'a' } }]));
    ok(doc.transact(human, [{ op: 'create', node: 'y', kind: 'shape', parent: 'g1', position: { before: 'a' } }]));
    ok(doc.transact(human, [{ op: 'create', node: 'z', kind: 'shape', parent: 'g1', position: { index: 2 } }]));
    ok(doc.transact(human, [{ op: 'create', node: 'w', kind: 'shape', parent: 'g1', position: { after: null } }]));
    expect(doc.children('g1')).toEqual(['w', 'y', 'a', 'z', 'x', 'b', 'c']);
    const orders = doc.children('g1').map((id) => doc.node(id)?.order as string);
    expect([...orders].sort()).toEqual(orders);
    ok(doc.transact(human, [{ op: 'move', node: 'c', parent: 'g1', position: { after: 'w' } }]));
    expect(doc.children('g1')).toEqual(['w', 'c', 'y', 'a', 'z', 'x', 'b']);
    ok(doc.transact(human, [{ op: 'move', node: 'w', parent: 'g1' }]));
    expect(doc.children('g1').at(-1)).toBe('w');
    doc.dispose();
  });

  it('rejects cycles and invalid ops atomically (nothing applied)', () => {
    const doc = seed();
    const before = doc.frontier();
    const cycle = doc.transact(human, [{ op: 'move', node: 'root', parent: 'a' }]);
    expect(cycle.ok ? '' : cycle.error.code).toBe('SF-DOC-009');
    const batch = doc.transact(human, [
      { op: 'set', node: 'a', path: 'spatial.x', value: 5 },
      { op: 'set', node: 'missing', path: 'spatial.x', value: 1 },
    ]);
    expect(batch.ok ? '' : batch.error.code).toBe('SF-DOC-008');
    expect(doc.prop('a', 'spatial.x')).toBe(0);
    expect(doc.frontier()).toBe(before);
    const reserved = doc.check([{ op: 'set', node: 'a', path: 'kind', value: 'x' }]);
    expect(reserved.ok ? '' : reserved.error.code).toBe('SF-DOC-003');
    const exists = doc.check([{ op: 'create', node: 'a', kind: 'shape', parent: null }]);
    expect(exists.ok ? '' : exists.error.code).toBe('SF-DOC-019');
    // ops later in a batch see earlier ones (create then move under it, delete then use fails)
    expect(doc.check([{ op: 'create', node: 'n', kind: 'group', parent: 'root' }, { op: 'move', node: 'a', parent: 'n' }]).ok).toBe(true);
    expect(doc.check([{ op: 'delete', node: 'g1' }, { op: 'set', node: 'a', path: 'name', value: 'x' }]).ok).toBe(false);
    doc.dispose();
  });

  it('resolves concurrent cyclic moves without a cycle (movable tree)', () => {
    const p1 = seed('1');
    const p2 = ok(p1.fork('2'));
    ok(p1.transact(human, [{ op: 'move', node: 'g1', parent: 'g2' }]));
    ok(p2.transact(agent, [{ op: 'move', node: 'g2', parent: 'g1' }]));
    sync(p1, p2);
    const parentChain = (doc: DocumentCRDTv2, id: string): string[] => {
      const out: string[] = [];
      for (let n = doc.node(id); n !== undefined && n.parent !== null; n = doc.node(n.parent)) out.push(n.parent);
      return out;
    };
    expect(parentChain(p1, 'g1')).toEqual(parentChain(p2, 'g1'));
    expect(parentChain(p1, 'g1')).not.toContain('g1');
    expect(parentChain(p1, 'g2')).not.toContain('g2');
    p1.dispose();
    p2.dispose();
  });
});

describe('Loro DocumentCRDTv2: inverse ops (undo)', () => {
  it('reverts set, move, create and delete (with the whole subtree and its text)', () => {
    const doc = seed();
    const set = ok(doc.transact(human, [{ op: 'set', node: 'a', path: 'spatial.x', value: 10 }, { op: 'set', node: 'a', path: 'role', value: 'cta' }]));
    undo(doc, set.inverse);
    expect(doc.node('a')?.props).toEqual({ 'spatial.x': 0, name: 'A' });

    const move = ok(doc.transact(human, [{ op: 'move', node: 'b', parent: 'g2' }]));
    expect(doc.children('g2')).toEqual(['b']);
    undo(doc, move.inverse);
    expect(doc.children('g1')).toEqual(['a', 'b', 'c']);

    ok(doc.transact(human, [{ op: 'text.mark', node: 't', path: 'text.content', from: 0, to: 5, key: 'bold', value: true }]));
    ok(doc.transact(human, [{ op: 'move', node: 't', parent: 'g1', position: { after: 'a' } }]));
    const del = ok(doc.transact(human, [{ op: 'delete', node: 'g1' }]));
    expect(doc.has('a')).toBe(false);
    expect(doc.has('t')).toBe(false);
    undo(doc, del.inverse);
    expect(doc.children('root')).toEqual(['g1', 'g2']);
    expect(doc.children('g1')).toEqual(['a', 't', 'b', 'c']);
    expect(doc.node('a')?.props).toEqual({ 'spatial.x': 0, name: 'A' });
    expect(doc.text('t', 'text.content')).toEqual({ text: 'alpha beta gamma', spans: [{ start: 0, end: 5, marks: { bold: true } }] });

    const created = ok(doc.transact(human, [{ op: 'create', node: 'n', kind: 'shape', parent: 'g2' }]));
    undo(doc, created.inverse);
    expect(doc.has('n')).toBe(false);
    doc.dispose();
  });

  it('undoes an agent text insert after a concurrent human insert before it (S4 failure case)', () => {
    const human1 = seed('10');
    const agentPeer = ok(human1.fork('20'));
    const agentCommit = ok(agentPeer.transact(agent, [{ op: 'text.insert', node: 't', path: 'text.content', at: 6, text: 'AGENT ' }]));
    ok(human1.transact(human, [{ op: 'text.insert', node: 't', path: 'text.content', at: 0, text: 'Hey ' }]));
    sync(human1, agentPeer);
    expect(human1.text('t', 'text.content')?.text).toBe('Hey alpha AGENT beta gamma');
    // "after reload": the inverse is plain data (anchored), applied on a peer that never saw the forward commit locally
    const reloaded = ok(engine.load(human1.exportSnapshot(), { peer: '30' }));
    undo(reloaded, agentCommit.inverse, agent);
    expect(reloaded.text('t', 'text.content')?.text).toBe('Hey alpha beta gamma');
    for (const d of [human1, agentPeer, reloaded]) d.dispose();
  });

  it('restores deleted text with its marks, and reverts marks', () => {
    const doc = seed();
    ok(doc.transact(human, [{ op: 'text.mark', node: 't', path: 'text.content', from: 0, to: 10, key: 'bold', value: true }]));
    const del = ok(doc.transact(human, [{ op: 'text.delete', node: 't', path: 'text.content', from: 3, to: 13 }]));
    expect(doc.text('t', 'text.content')?.text).toBe('alpmma');
    undo(doc, del.inverse);
    expect(doc.text('t', 'text.content')).toEqual({ text: 'alpha beta gamma', spans: [{ start: 0, end: 10, marks: { bold: true } }] });
    const mark = ok(doc.transact(human, [{ op: 'text.mark', node: 't', path: 'text.content', from: 6, to: 16, key: 'bold', value: null }]));
    expect(doc.text('t', 'text.content')?.spans).toEqual([{ start: 0, end: 6, marks: { bold: true } }]);
    undo(doc, mark.inverse);
    expect(doc.text('t', 'text.content')?.spans).toEqual([{ start: 0, end: 10, marks: { bold: true } }]);
    doc.dispose();
  });

  it('keeps another actor’s later overwrite out of a property undo only by policy (inverse restores the prior value)', () => {
    const doc = seed();
    const mine = ok(doc.transact(human, [{ op: 'set', node: 'a', path: 'spatial.x', value: 10 }]));
    ok(doc.transact(agent, [{ op: 'set', node: 'a', path: 'spatial.x', value: 20 }]));
    // The inverse is data: an undo service (A8) compares the current value with the commit's result and flags it (D14).
    expect(mine.inverse).toEqual([{ op: 'set', node: 'a', path: 'spatial.x', value: 0 }]);
    const changed = ok(doc.changedSince(mine.after));
    expect(changed.nodes.get('a')).toMatchObject({ paths: ['spatial.x'], actors: ['agent-7'] });
    doc.dispose();
  });
});

describe('Loro DocumentCRDTv2: text, lists, anchors', () => {
  it('anchors follow concurrent edits; `after` sticks to the preceding character', () => {
    const doc = seed();
    const before = doc.anchor('t', 'text.content', 6, 'before') as string;
    const after = doc.anchor('t', 'text.content', 6, 'after') as string;
    const start = doc.anchor('t', 'text.content', 0, 'after') as string;
    ok(doc.transact(human, [{ op: 'text.insert', node: 't', path: 'text.content', at: 6, text: 'XX' }]));
    expect(doc.resolve(before as never)).toBe(8);
    expect(doc.resolve(after as never)).toBe(6);
    ok(doc.transact(human, [{ op: 'text.insert', node: 't', path: 'text.content', at: 0, text: '>' }]));
    expect(doc.resolve(before as never)).toBe(9);
    expect(doc.resolve(start as never)).toBe(0);
    expect(doc.anchor('t', 'text.content', 999)).toBeUndefined();
    expect(doc.resolve('garbage' as never)).toBeUndefined();
    // anchored ops
    ok(doc.transact(human, [{ op: 'text.insert', node: 't', path: 'text.content', at: before as never, text: '|' }]));
    expect(doc.text('t', 'text.content')?.text).toBe('>alpha XX|beta gamma');
    doc.dispose();
  });

  it('merges concurrent text and marks; inserts take marks', () => {
    const p1 = seed('1');
    const p2 = ok(p1.fork('2'));
    ok(p1.transact(human, [{ op: 'text.insert', node: 't', path: 'text.content', at: 0, text: 'Big ', marks: { bold: true } }]));
    ok(p2.transact(agent, [{ op: 'text.mark', node: 't', path: 'text.content', from: 11, to: 16, key: 'link', value: 'https://x.test' }]));
    sync(p1, p2);
    expect(p1.text('t', 'text.content')).toEqual(p2.text('t', 'text.content'));
    expect(p1.text('t', 'text.content')).toEqual({
      text: 'Big alpha beta gamma',
      spans: [
        { start: 0, end: 4, marks: { bold: true } },
        { start: 15, end: 20, marks: { link: 'https://x.test' } },
      ],
    });
    p1.dispose();
    p2.dispose();
  });

  it('supports movable lists with inverses', () => {
    const doc = seed();
    ok(doc.transact(human, [{ op: 'create', node: 'l', kind: 'shape', parent: 'root', lists: { 'style.effects': ['a', 'b', 'c'] } }]));
    const move = ok(doc.transact(human, [{ op: 'list.move', node: 'l', path: 'style.effects', from: 0, to: 2 }]));
    expect(doc.list('l', 'style.effects')).toEqual(['b', 'c', 'a']);
    undo(doc, move.inverse);
    const edits = ok(
      doc.transact(human, [
        { op: 'list.insert', node: 'l', path: 'style.effects', at: 1, value: { blur: 2 } },
        { op: 'list.set', node: 'l', path: 'style.effects', at: 0, value: 'A' },
        { op: 'list.delete', node: 'l', path: 'style.effects', at: 2, count: 2 },
      ]),
    );
    expect(doc.list('l', 'style.effects')).toEqual(['A', { blur: 2 }]);
    undo(doc, edits.inverse);
    expect(doc.list('l', 'style.effects')).toEqual(['a', 'b', 'c']);
    expect(doc.check([{ op: 'list.delete', node: 'l', path: 'style.effects', at: 2, count: 5 }]).ok).toBe(false);
    doc.dispose();
  });
});

describe('Loro DocumentCRDTv2: versions, changedSince, fork, snapshots, events', () => {
  it('reports per-node changes since a base with commit meta, filtered by scope', () => {
    const doc = seed();
    const base = doc.frontier();
    ok(doc.transact(human, [{ op: 'set', node: 'a', path: 'spatial.x', value: 1 }, { op: 'move', node: 'c', parent: 'g2' }]));
    ok(doc.transact({ ...agent, changeSet: 'cs_1' }, [{ op: 'text.insert', node: 't', path: 'text.content', at: 0, text: 'Hi ' }, { op: 'create', node: 'n', kind: 'shape', parent: 'g2' }]));
    ok(doc.transact(human, [{ op: 'delete', node: 'b' }]));
    const all = ok(doc.changedSince(base));
    expect(all.commits.map((c) => c.meta?.actor.id)).toEqual(['guest-1', 'agent-7', 'guest-1']);
    expect(all.commits[1]?.meta?.changeSet).toBe('cs_1');
    expect(Object.fromEntries(all.nodes)).toEqual({
      a: { created: false, deleted: false, moved: false, paths: ['spatial.x'], actors: ['guest-1'] },
      c: { created: false, deleted: false, moved: true, paths: [], actors: ['guest-1'] },
      t: { created: false, deleted: false, moved: false, paths: ['text.content'], actors: ['agent-7'] },
      n: { created: true, deleted: false, moved: false, paths: [], actors: ['agent-7'] },
      b: { created: false, deleted: true, moved: false, paths: [], actors: ['guest-1'] },
    });
    expect([...ok(doc.changedSince(base, { subtree: 'g2' })).nodes.keys()].sort()).toEqual(['b', 'c', 'n']);
    expect([...ok(doc.changedSince(base, { nodes: ['a', 't'] })).nodes.keys()].sort()).toEqual(['a', 't']);
    expect([...ok(doc.changedSince(base, { paths: ['text.'] })).nodes.keys()].sort()).toEqual(['b', 'c', 'n', 't']);
    expect(ok(doc.changedSince(doc.frontier())).nodes.size).toBe(0);
    expect(doc.compare(base, doc.frontier())).toBe(-1);
    expect(doc.compare(doc.frontier(), doc.frontier())).toBe(0);
    doc.dispose();
  });

  it('shallow snapshots keep state, drop history: older bases become unavailable', () => {
    const doc = seed();
    const base = doc.frontier();
    ok(doc.transact(human, [{ op: 'set', node: 'a', path: 'spatial.x', value: 7 }]));
    const shallow = ok(engine.load(doc.exportShallowSnapshot(), { peer: '9' }));
    expect(shallow.prop('a', 'spatial.x')).toBe(7);
    expect(shallow.text('t', 'text.content')?.text).toBe('alpha beta gamma');
    const r = shallow.changedSince(base);
    expect(r.ok ? '' : r.error.code).toBe('SF-DOC-010');
    expect(ok(shallow.changedSince(shallow.frontier())).nodes.size).toBe(0);
    // still merges new edits from the full-history peer
    ok(doc.transact(human, [{ op: 'set', node: 'b', path: 'spatial.x', value: 3 }]));
    ok(shallow.import(doc.exportUpdates(shallow.version())));
    expect(shallow.prop('b', 'spatial.x')).toBe(3);
    const bad = doc.changedSince('not-a-frontier' as never);
    expect(bad.ok).toBe(false);
    doc.dispose();
    shallow.dispose();
  });

  it('forks at a version and at head; forks are independent peers', () => {
    const doc = seed();
    const base = doc.frontier();
    ok(doc.transact(human, [{ op: 'set', node: 'a', path: 'spatial.x', value: 5 }]));
    const old = ok(doc.fork('5', base));
    expect(old.prop('a', 'spatial.x')).toBe(0);
    expect(old.peer).toBe('5');
    ok(old.transact(agent, [{ op: 'set', node: 'b', path: 'spatial.x', value: 9 }]));
    expect(doc.prop('b', 'spatial.x')).toBe(0);
    sync(doc, old);
    expect(doc.prop('a', 'spatial.x')).toBe(5);
    expect(doc.prop('b', 'spatial.x')).toBe(9);
    old.dispose();
    doc.dispose();
  });

  it('emits one change per commit and per import, by node', () => {
    const p1 = seed('1');
    const p2 = ok(engine.load(p1.exportSnapshot(), { peer: '2' }));
    const seen1: unknown[] = [];
    const seen2: unknown[] = [];
    const off1 = p1.observe((c) => seen1.push({ origin: c.origin, created: c.created, updated: Object.fromEntries(c.updated), label: c.meta?.label }));
    p2.observe((c) => seen2.push({ origin: c.origin, created: c.created, moved: c.moved, updated: Object.fromEntries(c.updated) }));
    const commit = ok(p1.transact(human, [{ op: 'set', node: 'a', path: 'spatial.x', value: 4 }, { op: 'create', node: 'n', kind: 'shape', parent: 'g2', texts: { 'text.content': { text: 'x', spans: [] } } }]));
    expect(seen1).toEqual([{ origin: 'local', created: ['n'], updated: { a: ['spatial.x'], n: ['text.content'] }, label: 'Edit' }]);
    expect(commit.change.created).toEqual(['n']);
    ok(p2.import(commit.update));
    expect(seen2).toEqual([{ origin: 'remote', created: ['n'], moved: [], updated: { a: ['spatial.x'], n: ['text.content'] } }]);
    off1();
    ok(p1.transact(human, [{ op: 'set', node: 'a', path: 'spatial.x', value: 5 }]));
    expect(seen1).toHaveLength(1);
    p1.dispose();
    p2.dispose();
  });

  it('rejects garbage updates and snapshots', () => {
    const doc = seed();
    const r = doc.import(new Uint8Array([1, 2, 3]));
    expect(r.ok ? '' : r.error.code).toBe('SF-DOC-006');
    const l = engine.load(new Uint8Array([9, 9]), { peer: '3' });
    expect(l.ok ? '' : l.error.code).toBe('SF-DOC-006');
    doc.dispose();
  });

  it('is unusable after dispose', () => {
    const doc = seed();
    doc.dispose();
    expect(doc.disposed).toBe(true);
    expect(doc.has('a')).toBe(false);
    const r = doc.transact(human, []);
    expect(r.ok ? '' : r.error.code).toBe('SF-DOC-014');
    doc.dispose();
  });
});

describe('Loro adapter handle accounting (D14 leak rule)', () => {
  it('returns every handle: the live count is unchanged after a full open/edit/read/close cycle', () => {
    const start = loroLiveHandles();
    const doc = seed();
    const peer = ok(doc.fork('2'));
    ok(peer.transact(agent, [{ op: 'text.insert', node: 't', path: 'text.content', at: 0, text: 'x' }, { op: 'delete', node: 'g1' }]));
    sync(doc, peer);
    doc.subtree('root');
    doc.forEachNode(() => undefined);
    doc.changedSince(doc.frontier());
    doc.anchor('t', 'text.content', 1);
    expect(loroLiveHandles()).toBe(start + 6); // two open parts × (doc, tree, ids)
    doc.dispose();
    peer.dispose();
    expect(loroLiveHandles()).toBe(start);
    expect(engine.liveHandles()).toBe(start);
  });

  // Heavy by design (a 2,000-node snapshot loaded 30 times; ~2.5 s alone): its own timeout so a busy machine can't fail it.
  it('keeps Wasm memory flat over repeated open/edit/close cycles (leak test)', { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const start = loroLiveHandles();
    const snapshot = (() => {
      const doc = engine.create({ peer: '1' });
      const ops: PartOp[] = [{ op: 'create', node: 'root', kind: 'composition', parent: null }];
      for (let i = 0; i < 2000; i += 1) ops.push({ op: 'create', node: `n${i}`, kind: 'shape', parent: 'root', props: { 'spatial.x': i } });
      ok(doc.transact(human, ops));
      const bytes = doc.exportSnapshot();
      doc.dispose();
      return bytes;
    })();
    const cycle = (): void => {
      const doc = ok(engine.load(snapshot, { peer: '2' }));
      for (const id of doc.children('root').slice(0, 50)) doc.node(id);
      ok(doc.transact(human, [{ op: 'set', node: 'n1', path: 'spatial.x', value: 1 }]));
      doc.dispose();
    };
    for (let i = 0; i < 5; i += 1) cycle(); // warm up allocator
    const before = loroWasmMemoryBytes();
    for (let i = 0; i < 25; i += 1) cycle();
    const after = loroWasmMemoryBytes();
    expect(typeof before).toBe('number'); // Node build exposes Wasm memory; the browser build may not
    if (before !== undefined && after !== undefined) expect(after - before).toBeLessThan(4 * 1024 * 1024);
    expect(loroLiveHandles()).toBe(start);
  });
});
