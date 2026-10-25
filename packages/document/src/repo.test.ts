import { describe, expect, it } from 'vitest';
import type { CommitRecord } from './commit-record.js';
import type { PartOp, PeerId, TransactionMeta } from './crdt-v2.js';
import { HeadConflictError } from './errors.js';
import { createLoroEngine } from './loro-crdt.js';
import { createDocumentRepo, type DocumentRepoOptions, type OpenDocument } from './repo.js';
import { createMemoryDocumentStore, type DocumentStore } from './store.js';

const engine = createLoroEngine();
const signal = new AbortController().signal;
const human: TransactionMeta = { actor: { kind: 'human', id: 'h1' }, label: 'Edit' };
const agent: TransactionMeta = { actor: { kind: 'agent', id: 'a1' }, label: 'Agent edit' };

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

let peerSeq = 100;
const repoOn = (store: DocumentStore, extra: Partial<DocumentRepoOptions> = {}) =>
  createDocumentRepo({ store, engine, peer: () => `${(peerSeq += 1)}` as PeerId, ...extra });

/** Asset with a document-level part (root: composition + page stubs) and two page parts. */
async function seeded(store = createMemoryDocumentStore(), extra: Partial<DocumentRepoOptions> = {}) {
  const repo = repoOn(store, extra);
  const doc = unwrap(await repo.create('as_1', { treeSchema: 1, parts: ['root', 'page:p1', 'page:p2'] }, signal));
  for (const id of doc.partIds()) unwrap(await doc.part(id, signal));
  unwrap(
    await doc.transact(
      human,
      {
        root: [
          { op: 'create', node: 'comp', kind: 'composition', parent: null },
          { op: 'create', node: 'p1', kind: 'page', parent: 'comp' },
          { op: 'create', node: 'p2', kind: 'page', parent: 'comp' },
        ],
        'page:p1': [
          { op: 'create', node: 'p1', kind: 'page', parent: null },
          { op: 'create', node: 'card', kind: 'group', parent: 'p1', props: { 'spatial.x': 10 } },
          { op: 'create', node: 'title', kind: 'text', parent: 'card', texts: { 'text.content': { text: 'Sale', spans: [] } } },
        ],
        'page:p2': [{ op: 'create', node: 'p2', kind: 'page', parent: null }],
      },
      signal,
    ),
  );
  return { store, repo, doc };
}

const x = (doc: OpenDocument, part: string, node: string): unknown => doc.loadedPart(part)?.prop(node, 'spatial.x');

describe('DocumentRepo: create, open, lazy parts, replay', () => {
  it('reopens from snapshots + log with parts loaded lazily', async () => {
    const { store, doc } = await seeded();
    unwrap(await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 42 }] }, signal));
    const loaded: string[] = [];
    const other = repoOn(store, { hooks: { onPartLoaded: (_a, p) => loaded.push(p) } });
    const reopened = unwrap(await other.open('as_1', signal));
    expect(reopened.partIds()).toEqual(['page:p1', 'page:p2', 'root']);
    expect(reopened.partState('page:p1')).toBe('unloaded');
    expect(reopened.loadedPart('page:p1')).toBeUndefined();
    const p1 = unwrap(await reopened.part('page:p1', signal));
    expect(reopened.partState('page:p1')).toBe('loaded');
    expect(p1.prop('card', 'spatial.x')).toBe(42);
    expect(p1.text('title', 'text.content')?.text).toBe('Sale');
    expect(loaded).toEqual(['page:p1']);
    expect(reopened.peer).not.toBe(doc.peer); // each session is its own peer
    const missing = await reopened.part('page:nope', signal);
    expect(missing.ok ? '' : missing.error.code).toBe('SF-DOC-013');
  });

  it('shares one open document per asset and refuses unknown assets and engines', async () => {
    const store = createMemoryDocumentStore();
    const repo = repoOn(store);
    const created = unwrap(await repo.create('as_2', { treeSchema: 3, app: { milestones: [] } }, signal));
    expect(created.head()).toMatchObject({ generation: 1, engine: 'loro/1', treeSchema: 3, logFrom: 1, undoHorizon: 200, app: { milestones: [] } });
    expect(created.partIds()).toEqual(['root']);
    const [a, b] = await Promise.all([repo.open('as_2', signal), repo.open('as_2', signal)]);
    expect(unwrap(a)).toBe(created);
    expect(unwrap(b)).toBe(created);
    expect(repo.get('as_2')).toBe(created);
    expect(repo.openAssets()).toEqual(['as_2']);
    expect((await repo.create('as_2', { treeSchema: 1 }, signal)).ok).toBe(false);
    const fresh = repoOn(store);
    const unknown = await fresh.open('as_missing', signal);
    expect(unknown.ok ? '' : unknown.error.code).toBe('SF-DOC-013');
    const otherEngine = createDocumentRepo({ store, engine: { ...engine, id: 'other/1' } });
    expect((await otherEngine.open('as_2', signal)).ok).toBe(false);
    const again = await repoOn(store).create('as_2', { treeSchema: 1 }, signal);
    expect(again.ok ? '' : again.error.code).toBe('SF-DOC-011');
  });

  it('creates new parts on demand and persists them through the log', async () => {
    const { store, doc } = await seeded();
    const page = unwrap(doc.createPart('page:p3'));
    expect(unwrap(doc.createPart('page:p3'))).toBe(page);
    unwrap(await doc.transact(human, { 'page:p3': [{ op: 'create', node: 'p3', kind: 'page', parent: null }] }, signal));
    const reopened = unwrap(await repoOn(store).open('as_1', signal));
    expect(reopened.partIds()).toContain('page:p3');
    expect(unwrap(await reopened.part('page:p3', signal)).has('p3')).toBe(true);
    unwrap(doc.evict('page:p2'));
    expect(doc.createPart('page:p2').ok).toBe(false); // exists, but not loaded
  });
});

describe('DocumentRepo: commits', () => {
  it('moves a node between pages as ONE record touching both parts, undoable as one step', async () => {
    const { store, doc } = await seeded();
    const sent: CommitRecord[] = [];
    doc.onCommit((r) => sent.push(r));
    const committed = unwrap(doc.moveAcross(agent, { node: 'card', from: 'page:p1', to: 'page:p2', parent: 'p2' }));
    expect(Object.keys(committed.record.updates).sort()).toEqual(['page:p1', 'page:p2']);
    expect(committed.record.meta.txn).toMatch(/.+/);
    expect(sent).toHaveLength(1);
    const durable = unwrap(await committed.durable);
    expect(durable.seq).toBeGreaterThan(0);
    const p1 = doc.loadedPart('page:p1');
    const p2 = doc.loadedPart('page:p2');
    expect(p1?.has('card')).toBe(false);
    expect(p2?.children('p2')).toEqual(['card']);
    expect(p2?.children('card')).toEqual(['title']);
    expect(p2?.text('title', 'text.content')?.text).toBe('Sale');
    // both parts' changes are summarised in the commit
    expect(committed.changes['page:p2']?.created.sort()).toEqual(['card', 'title']);
    const step = doc.undoHistory('a1')[0];
    expect(Object.keys(step?.inverse ?? {}).sort()).toEqual(['page:p1', 'page:p2']);
    unwrap(await doc.transact({ ...agent, label: 'Undo' }, step?.inverse as Record<string, readonly PartOp[]>, signal));
    expect(p1?.children('card')).toEqual(['title']);
    expect(p2?.has('card')).toBe(false);
    // the log holds the move as one entry
    const log = unwrap(await store.readLog('as_1', 1, signal));
    expect(log).toHaveLength(3);
  });

  it('validates every part before applying any (all-or-nothing across parts)', async () => {
    const { doc } = await seeded();
    const before = doc.loadedPart('page:p1')?.frontier();
    const r = doc.commit(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 1 }], 'page:p2': [{ op: 'delete', node: 'ghost' }] });
    expect(r.ok ? '' : r.error.code).toBe('SF-DOC-008');
    expect(doc.loadedPart('page:p1')?.frontier()).toBe(before);
    unwrap(doc.evict('page:p2'));
    const unloaded = doc.commit(human, { 'page:p2': [{ op: 'delete', node: 'p2' }] });
    expect(unloaded.ok ? '' : unloaded.error.code).toBe('SF-DOC-013');
    expect(doc.moveAcross(human, { node: 'card', from: 'page:p1', to: 'page:p2', parent: 'p2' }).ok).toBe(false);
    expect(doc.moveAcross(human, { node: 'ghost', from: 'page:p1', to: 'page:p1', parent: 'p1' }).ok).toBe(false);
    unwrap(await doc.part('page:p2', signal));
    expect(doc.moveAcross(human, { node: 'ghost', from: 'page:p1', to: 'page:p2', parent: 'p2' }).ok).toBe(false);
    unwrap(doc.moveAcross(human, { node: 'title', from: 'page:p1', to: 'page:p1', parent: 'p1', position: { after: null } }));
    expect(doc.loadedPart('page:p1')?.children('p1')).toEqual(['title', 'card']);
  });

  it('commits a gesture as one record', async () => {
    const { store, doc } = await seeded();
    const gesture = unwrap(doc.gesture(human, 'page:p1'));
    for (let i = 1; i <= 50; i += 1) gesture.stage([{ op: 'set', node: 'card', path: 'spatial.x', value: i }]);
    const committed = unwrap(gesture.commit());
    unwrap(await (committed as NonNullable<typeof committed>).durable);
    expect(x(doc, 'page:p1', 'card')).toBe(50);
    expect(unwrap(await store.readLog('as_1', 1, signal))).toHaveLength(2);
    expect(doc.gesture(human, 'page:none').ok).toBe(false);
  });

  it('applies records from another tab; unloaded parts fold them in on load', async () => {
    const { store, doc: tabA } = await seeded();
    const tabB = unwrap(await repoOn(store).open('as_1', signal));
    unwrap(await tabB.part('page:p1', signal));
    tabA.onCommit((record) => unwrap(tabB.applyRemote(record)));
    tabB.onCommit((record) => unwrap(tabA.applyRemote(record)));
    unwrap(await tabA.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 1 }], 'page:p2': [{ op: 'set', node: 'p2', path: 'name', value: 'Two' }] }, signal));
    unwrap(await tabB.transact(agent, { 'page:p1': [{ op: 'text.insert', node: 'title', path: 'text.content', at: 4, text: '!' }] }, signal));
    expect(x(tabB, 'page:p1', 'card')).toBe(1);
    expect(tabA.loadedPart('page:p1')?.text('title', 'text.content')?.text).toBe('Sale!');
    expect(tabB.partState('page:p2')).toBe('unloaded');
    expect(unwrap(await tabB.part('page:p2', signal)).prop('p2', 'name')).toBe('Two');
    expect(tabA.applyRemote({ peer: '1', meta: human, updates: { 'page:p1': new Uint8Array([1]) }, inverse: {} }).ok).toBe(false);
  });

  it('keeps a failed append in memory, reports it, and retries it in order', async () => {
    const store = createMemoryDocumentStore();
    const errors: string[] = [];
    const { doc } = await seeded(store, { hooks: { onPersistError: (_a, e) => errors.push(e.code) } });
    store.failNext('appendLog', HeadConflictError({ message: 'disk busy' }));
    const first = unwrap(doc.commit(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 1 }] }));
    expect((await first.durable).ok).toBe(false);
    expect(errors).toEqual(['SF-DOC-011']);
    expect(doc.stats().parts.find((p) => p.id === 'page:p1')?.pending).toBe(1);
    expect(doc.evict('page:p1').ok).toBe(false); // never drop unacknowledged edits
    const second = unwrap(doc.commit(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 2 }] }));
    const durable = unwrap(await second.durable);
    unwrap(await doc.flush(signal));
    const log = unwrap(await store.readLog('as_1', 1, signal));
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(durable.seq).toBe(3);
    expect(doc.stats().parts.find((p) => p.id === 'page:p1')?.pending).toBe(0);
    const reopened = unwrap(await repoOn(store).open('as_1', signal));
    expect(unwrap(await reopened.part('page:p1', signal)).prop('card', 'spatial.x')).toBe(2);
  });
});

describe('DocumentRepo: compaction, undo horizon, eviction, close', () => {
  it('folds the log into snapshots, swaps the head by CAS and truncates the log', async () => {
    const { store, doc } = await seeded();
    for (let i = 0; i < 5; i += 1) unwrap(await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: i }] }, signal));
    unwrap(doc.evict('page:p2')); // unloaded parts with log records are folded too
    const compacted: number[] = [];
    const head = unwrap(await doc.compact(signal));
    compacted.push(head.generation);
    expect(head.generation).toBe(2);
    expect(head.logFrom).toBe(7);
    expect(doc.head()).toBe(head);
    expect(unwrap(await store.readLog('as_1', 1, signal))).toEqual([]);
    expect(doc.stats().logRecords).toBe(0);
    expect(doc.state).toBe('open');
    const reopened = unwrap(await repoOn(store).open('as_1', signal));
    expect(unwrap(await reopened.part('page:p1', signal)).prop('card', 'spatial.x')).toBe(4);
    expect(unwrap(await reopened.part('page:p2', signal)).has('p2')).toBe(true);
    expect(reopened.undoHistory('h1')).toHaveLength(6);
    expect(compacted).toEqual([2]);
  });

  it('keeps only the undo horizon per actor at compaction', async () => {
    const { store, doc } = await seeded(createMemoryDocumentStore(), { undoHorizon: 3 });
    for (let i = 0; i < 6; i += 1) unwrap(await doc.transact(i % 2 === 0 ? human : agent, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: i }] }, signal));
    expect(doc.undoHistory()).toHaveLength(6); // 4 human + 3 agent, trimmed to 3 each
    unwrap(await doc.compact(signal));
    const reopened = unwrap(await repoOn(store).open('as_1', signal));
    // newest first; each inverse restores the value before that step (the agent wrote 1 and 3 in between)
    expect(reopened.undoHistory('h1').map((e) => (e.inverse['page:p1']?.[0] as { value: unknown }).value)).toEqual([3, 1, 10]);
    expect(reopened.undoHistory('a1')).toHaveLength(3);
    unwrap(await reopened.part('page:p1', signal));
    unwrap(await reopened.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 99 }] }, signal));
    expect(reopened.undoHistory('h1')).toHaveLength(3);
    expect(reopened.undoHistory('h1')[0]?.seq).toBeGreaterThan(0);
  });

  it('retries compaction after losing the head race and keeps both writers’ edits', async () => {
    const { store, doc: tabA } = await seeded();
    const tabB = unwrap(await repoOn(store).open('as_1', signal));
    unwrap(await tabB.part('page:p1', signal));
    unwrap(await tabA.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 7 }] }, signal));
    unwrap(await tabB.transact(agent, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.y', value: 8 }] }, signal));
    unwrap(await tabA.compact(signal));
    const head = unwrap(await tabB.compact(signal));
    expect(head.generation).toBe(3);
    const reopened = unwrap(await repoOn(store).open('as_1', signal));
    const p1 = unwrap(await reopened.part('page:p1', signal));
    expect([p1.prop('card', 'spatial.x'), p1.prop('card', 'spatial.y')]).toEqual([7, 8]);
    expect(reopened.undoHistory().map((e) => e.meta.actor.id).sort()).toEqual(['a1', 'h1', 'h1']);
  });

  it('supports shallow compaction (size, not age)', async () => {
    const { store, doc } = await seeded();
    const base = doc.loadedPart('page:p1')?.frontier();
    for (let i = 0; i < 20; i += 1) unwrap(await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: i }] }, signal));
    unwrap(await doc.compact(signal, { history: 'shallow' }));
    const reopened = unwrap(await repoOn(store).open('as_1', signal));
    const p1 = unwrap(await reopened.part('page:p1', signal));
    expect(p1.prop('card', 'spatial.x')).toBe(19);
    expect(base !== undefined && p1.changedSince(base).ok).toBe(false);
  });

  it('evicts clean parts (hook) and reloads them unchanged', async () => {
    const evicted: string[] = [];
    const { doc } = await seeded(createMemoryDocumentStore(), { hooks: { onPartEvicted: (_a, p) => evicted.push(p) }, now: () => 1234 });
    unwrap(await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 5 }] }, signal));
    const before = engine.liveHandles();
    unwrap(doc.evict('page:p1'));
    unwrap(doc.evict('page:p1'));
    expect(engine.liveHandles()).toBe(before - 3);
    expect(evicted).toEqual(['page:p1']);
    expect(doc.stats().parts.find((p) => p.id === 'page:p1')).toEqual({ id: 'page:p1', state: 'unloaded', lastUsedAt: 1234, pending: 0 });
    expect(unwrap(await doc.part('page:p1', signal)).prop('card', 'spatial.x')).toBe(5);
  });

  it('compacts automatically once the log passes the byte threshold', async () => {
    const compactions: number[] = [];
    const { doc } = await seeded(createMemoryDocumentStore(), { compactAfterBytes: 1, hooks: { onCompacted: (_a, h) => compactions.push(h.generation) } });
    unwrap(await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 1 }] }, signal));
    await doc.flush(signal);
    for (let i = 0; i < 20 && compactions.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(compactions.length).toBeGreaterThan(0);
  });

  it('closes: flush, compact, free every part, refuse further use', async () => {
    const { store, repo, doc } = await seeded();
    const handles = engine.liveHandles();
    unwrap(await doc.close(signal));
    expect(doc.state).toBe('closed');
    expect(engine.liveHandles()).toBe(handles - 9);
    expect(repo.get('as_1')).toBeUndefined();
    expect(unwrap(await store.readHead('as_1', signal))?.generation).toBe(2);
    const r = doc.commit(human, {});
    expect(r.ok ? '' : r.error.code).toBe('SF-DOC-014');
    expect((await doc.part('root', signal)).ok).toBe(false);
    expect(doc.createPart('x').ok).toBe(false);
    expect((await doc.compact(signal)).ok).toBe(false);
    unwrap(await doc.close(signal));
    const reopened = unwrap(await repo.open('as_1', signal));
    expect(reopened).not.toBe(doc);
    await repo.dispose(signal);
    expect(repo.openAssets()).toEqual([]);
  });

  it('transact honours an aborted signal after applying (the commit still becomes durable)', async () => {
    const { store, doc } = await seeded();
    const controller = new AbortController();
    controller.abort();
    const r = await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'card', path: 'spatial.x', value: 3 }] }, controller.signal);
    expect(r.ok ? '' : r.error.code).toBe('SF-CORE-002');
    unwrap(await doc.flush(signal));
    expect(unwrap(await store.readLog('as_1', 1, signal))).toHaveLength(2);
    expect((await doc.flush(controller.signal)).ok).toBe(false);
  });
});
