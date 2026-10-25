/**
 * `DocumentRepo` contract suite (SF-Δ3). Runs against a repo factory over a
 * fresh `DocumentStore`, so the same cases cover the reference repo with any
 * engine and any store backend.
 *
 * Covers: lazy part loading, reopen = snapshot + log replay, one commit record
 * per cross-part transaction (all-or-nothing), compaction with head CAS, log
 * truncation and the undo horizon, concurrent compaction (lost race → retry),
 * eviction, two documents (tabs) converging through commit records, close.
 *
 * @example
 * runDocumentRepoContract('loro + memory', {
 *   store: () => createMemoryDocumentStore(),
 *   repo: (store, opts) => createDocumentRepo({ store, engine: createLoroEngine(), ...opts }),
 * }, { describe, it });
 */
import type { DocumentRepo, DocumentStore, OpenDocument, PartOp, TransactionMeta } from '@staticflux/document/v2';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue } from './contract-runner.js';

export interface DocumentRepoContractSubject {
  readonly store: () => DocumentStore | Promise<DocumentStore>;
  readonly repo: (store: DocumentStore, options: { readonly undoHorizon?: number }) => DocumentRepo;
  /** Engine handle count (for leak checks), if the engine exposes one. */
  readonly liveHandles?: () => number;
}

export interface DocumentRepoContractOptions {
  readonly skip?: readonly string[];
}

export interface DocumentRepoContractCase {
  readonly name: string;
  run(subject: DocumentRepoContractSubject): Promise<void>;
}

const signal = (): AbortSignal => new AbortController().signal;
const human: TransactionMeta = { actor: { kind: 'human', id: 'h' }, label: 'Edit' };
const agent: TransactionMeta = { actor: { kind: 'agent', id: 'a' }, label: 'Agent' };
const PARTS = ['root', 'page:p1', 'page:p2'] as const;

async function setup(subject: DocumentRepoContractSubject, options: { readonly undoHorizon?: number } = {}) {
  const store = await subject.store();
  const repo = subject.repo(store, options);
  const doc = okValue(await repo.create('as_c', { treeSchema: 1, parts: [...PARTS] }, signal()), 'create');
  for (const id of PARTS) okValue(await doc.part(id, signal()), `load ${id}`);
  okValue(
    await doc.transact(
      human,
      {
        root: [{ op: 'create', node: 'comp', kind: 'composition', parent: null }],
        'page:p1': [
          { op: 'create', node: 'p1', kind: 'page', parent: null },
          { op: 'create', node: 'box', kind: 'shape', parent: 'p1', props: { 'spatial.x': 1 } },
        ],
        'page:p2': [{ op: 'create', node: 'p2', kind: 'page', parent: null }],
      },
      signal(),
    ),
    'seed',
  );
  return { store, repo, doc };
}

const reopen = async (subject: DocumentRepoContractSubject, store: DocumentStore): Promise<OpenDocument> =>
  okValue(await subject.repo(store, {}).open('as_c', signal()), 'reopen');

export const documentRepoContractCases: readonly DocumentRepoContractCase[] = [
  {
    name: 'open reads the head only; parts load lazily from snapshot + log',
    async run(subject) {
      const { store, doc } = await setup(subject);
      okValue(await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'box', path: 'spatial.x', value: 5 }] }, signal()), 'edit');
      const other = await reopen(subject, store);
      assertEqual(other.partIds(), ['page:p1', 'page:p2', 'root'], 'parts known');
      assertEqual(other.partState('page:p1'), 'unloaded', 'not loaded yet');
      const p1 = okValue(await other.part('page:p1', signal()), 'load');
      assertEqual(p1.prop('box', 'spatial.x'), 5, 'log replayed');
      assertEqual(other.partState('page:p2'), 'unloaded', 'other parts stay unloaded');
      assertTrue(other.peer !== doc.peer, 'each open document is its own peer');
    },
  },
  {
    name: 'a cross-part move is one commit record touching both parts; invalid batches apply nothing',
    async run(subject) {
      const { store, doc } = await setup(subject);
      const before = okValue(await store.readLog('as_c', 0, signal()), 'log').length;
      const moved = okValue(doc.moveAcross(agent, { node: 'box', from: 'page:p1', to: 'page:p2', parent: 'p2' }), 'move across');
      okValue(await moved.durable, 'durable');
      assertEqual(Object.keys(moved.record.updates).sort(), ['page:p1', 'page:p2'], 'both parts in one record');
      assertEqual(okValue(await store.readLog('as_c', 0, signal()), 'log').length, before + 1, 'one log entry');
      assertTrue(moved.record.meta.txn !== undefined, 'shared transaction id');
      const other = await reopen(subject, store);
      assertEqual(okValue(await other.part('page:p2', signal()), 'p2').children('p2'), ['box'], 'moved after reopen');
      assertTrue(!okValue(await other.part('page:p1', signal()), 'p1').has('box'), 'gone from source');
      const bad = doc.commit(human, { 'page:p1': [{ op: 'set', node: 'p1', path: 'name', value: 'x' }], 'page:p2': [{ op: 'delete', node: 'ghost' }] });
      assertTrue(!bad.ok, 'invalid batch rejected');
      assertEqual(doc.loadedPart('page:p1')?.prop('p1', 'name'), undefined, 'no part applied');
    },
  },
  {
    name: 'undo history carries one inverse step per commit (across parts) for each actor',
    async run(subject) {
      const { doc } = await setup(subject);
      okValue(doc.moveAcross(agent, { node: 'box', from: 'page:p1', to: 'page:p2', parent: 'p2' }), 'move');
      okValue(await doc.flush(signal()), 'flush');
      const step = doc.undoHistory('a')[0];
      assertEqual(Object.keys(step?.inverse ?? {}).sort(), ['page:p1', 'page:p2'], 'inverse for both parts');
      okValue(await doc.transact({ ...agent, label: 'Undo' }, step?.inverse as Record<string, readonly PartOp[]>, signal()), 'undo');
      assertEqual(doc.loadedPart('page:p1')?.children('p1'), ['box'], 'restored');
      assertEqual(doc.loadedPart('page:p2')?.children('p2'), [], 'removed from target');
    },
  },
  {
    name: 'compaction writes snapshots, bumps the generation by CAS, truncates the log, trims to the undo horizon',
    async run(subject) {
      const { store, doc } = await setup(subject, { undoHorizon: 2 });
      for (let i = 0; i < 4; i += 1) okValue(await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'box', path: 'spatial.x', value: i }] }, signal()), 'edit');
      const head = okValue(await doc.compact(signal()), 'compact');
      assertEqual(head.generation, 2, 'generation');
      assertEqual(okValue(await store.readLog('as_c', 0, signal()), 'log'), [], 'log truncated');
      assertEqual(okValue(await store.readHead('as_c', signal()), 'head')?.generation, 2, 'head swapped');
      const other = await reopen(subject, store);
      assertEqual(okValue(await other.part('page:p1', signal()), 'p1').prop('box', 'spatial.x'), 3, 'state kept');
      assertEqual(other.undoHistory('h').length, 2, 'undo horizon applied');
    },
  },
  {
    name: 'concurrent compactions: the loser retries and no writer’s edit is lost',
    async run(subject) {
      const { store, doc: a } = await setup(subject);
      const b = await reopen(subject, store);
      okValue(await b.part('page:p1', signal()), 'b loads');
      okValue(await a.transact(human, { 'page:p1': [{ op: 'set', node: 'box', path: 'spatial.x', value: 7 }] }, signal()), 'a edit');
      okValue(await b.transact(agent, { 'page:p1': [{ op: 'set', node: 'box', path: 'spatial.y', value: 8 }] }, signal()), 'b edit');
      const [ha, hb] = await Promise.all([a.compact(signal()), b.compact(signal())]);
      assertTrue(okValue(ha, 'a compact').generation !== okValue(hb, 'b compact').generation, 'both swapped, in turn');
      const p1 = okValue(await (await reopen(subject, store)).part('page:p1', signal()), 'p1');
      assertEqual([p1.prop('box', 'spatial.x'), p1.prop('box', 'spatial.y')], [7, 8], 'both edits kept');
    },
  },
  {
    name: 'two documents (tabs) converge by exchanging commit records',
    async run(subject) {
      const { store, doc: a } = await setup(subject);
      const b = await reopen(subject, store);
      okValue(await b.part('page:p1', signal()), 'b loads p1');
      const offA = a.onCommit((r) => okValue(b.applyRemote(r), 'a→b'));
      const offB = b.onCommit((r) => okValue(a.applyRemote(r), 'b→a'));
      okValue(await a.transact(human, { 'page:p1': [{ op: 'set', node: 'box', path: 'name', value: 'A' }], 'page:p2': [{ op: 'set', node: 'p2', path: 'name', value: 'Two' }] }, signal()), 'a');
      okValue(await b.transact(agent, { 'page:p1': [{ op: 'set', node: 'box', path: 'spatial.y', value: 3 }] }, signal()), 'b');
      offA();
      offB();
      assertEqual(b.loadedPart('page:p1')?.prop('box', 'name'), 'A', 'b sees a');
      assertEqual(a.loadedPart('page:p1')?.prop('box', 'spatial.y'), 3, 'a sees b');
      assertEqual(okValue(await b.part('page:p2', signal()), 'b loads p2 later').prop('p2', 'name'), 'Two', 'unloaded part folds remote records in');
    },
  },
  {
    name: 'eviction frees a clean part and it reloads unchanged; close frees everything',
    async run(subject) {
      const { repo, doc } = await setup(subject);
      okValue(await doc.transact(human, { 'page:p1': [{ op: 'set', node: 'box', path: 'spatial.x', value: 4 }] }, signal()), 'edit');
      const before = subject.liveHandles?.();
      okValue(doc.evict('page:p1'), 'evict');
      assertEqual(doc.partState('page:p1'), 'unloaded', 'unloaded');
      if (before !== undefined) assertTrue((subject.liveHandles?.() ?? 0) < before, 'handles freed');
      assertEqual(okValue(await doc.part('page:p1', signal()), 'reload').prop('box', 'spatial.x'), 4, 'unchanged');
      okValue(await doc.close(signal()), 'close');
      assertEqual(doc.state, 'closed', 'closed');
      assertEqual(errOf(doc.commit(human, {}), 'use after close').code, 'SF-DOC-014', 'closed error');
      assertEqual(repo.openAssets(), [], 'repo forgets it');
    },
  },
];

export function runDocumentRepoContract(
  name: string,
  subject: DocumentRepoContractSubject,
  runner: ContractRunner,
  options: DocumentRepoContractOptions = {},
): void {
  runner.describe(`DocumentRepo contract: ${name}`, () => {
    for (const c of documentRepoContractCases) {
      if (options.skip?.includes(c.name) === true) continue;
      runner.it(c.name, () => c.run(subject));
    }
  });
}
