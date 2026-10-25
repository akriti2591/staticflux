/**
 * `DocumentCRDTv2` contract suite (SF-Δ4/Δ5, M1 exit criterion "N-peer convergence").
 * Every CRDT engine (Loro today; an LWW fallback or another engine later) runs it.
 *
 * - Deterministic cases: tree/order, cycle safety, LWW properties, rich text and
 *   anchors, inverse ops, `changedSince`, snapshots, forks, handle accounting.
 * - A **property test** (fast-check): N peers apply random moves, reorders, text
 *   inserts/deletes/marks, sets, creates and deletes while the network is
 *   randomly partitioned and healed. After a final heal every peer must hold the
 *   same content (identical canonical part bytes) and a valid tree, and every
 *   engine handle must be released.
 *
 * @example
 * runDocumentCrdtContract('loro', createLoroEngine(), { describe, it });
 */
import { type CrdtEngine, type DocumentCRDTv2, encodeCanonicalPart, type PartOp, type PeerId, type TransactionMeta } from '@staticflux/document/v2';
import fc from 'fast-check';
import { assertEqual, assertTrue, type ContractRunner, okValue } from './contract-runner.js';

export interface DocumentCrdtContractOptions {
  /** Property-test runs (default 30). */
  readonly numRuns?: number;
  /** Fixed seed for reproducing a failure (fast-check prints it). */
  readonly seed?: number;
  /** Peers per run: 2…maxPeers (default 4). */
  readonly maxPeers?: number;
  /** Actions per run (default 40). */
  readonly maxSteps?: number;
  readonly skip?: readonly string[];
}

export interface DocumentCrdtContractCase {
  readonly name: string;
  run(engine: CrdtEngine, options: DocumentCrdtContractOptions): Promise<void>;
}

const human: TransactionMeta = { actor: { kind: 'human', id: 'h' }, label: 'Edit' };
const agent: TransactionMeta = { actor: { kind: 'agent', id: 'a' }, label: 'Agent' };
const TEXT = 'text.content';

/** root → g0…g2 (each with e0…e2) + text node `t`. */
function seedOps(): PartOp[] {
  const ops: PartOp[] = [{ op: 'create', node: 'root', kind: 'page', parent: null }];
  for (let g = 0; g < 3; g += 1) {
    ops.push({ op: 'create', node: `g${g}`, kind: 'group', parent: 'root' });
    for (let e = 0; e < 3; e += 1) ops.push({ op: 'create', node: `g${g}e${e}`, kind: 'shape', parent: `g${g}`, props: { 'spatial.x': e } });
  }
  ops.push({ op: 'create', node: 't', kind: 'text', parent: 'root', texts: { [TEXT]: { text: 'alpha beta', spans: [] } } });
  return ops;
}

function seeded(engine: CrdtEngine, peer: PeerId): DocumentCRDTv2 {
  const doc = engine.create({ peer });
  okValue(doc.transact(human, seedOps()), 'seed');
  return doc;
}

function syncPair(from: DocumentCRDTv2, to: DocumentCRDTv2): void {
  okValue(to.import(from.exportUpdates(to.version())), `sync ${from.peer}→${to.peer}`);
}

function syncAll(peers: readonly DocumentCRDTv2[]): void {
  for (let round = 0; round < 2; round += 1) {
    for (const a of peers) for (const b of peers) if (a !== b) syncPair(a, b);
  }
}

function fingerprint(doc: DocumentCRDTv2): string {
  const encoded = okValue(encodeCanonicalPart(doc, { part: 'p' }), 'canonical encoding');
  return new TextDecoder().decode(encoded.bytes);
}

/** Every live node is reachable exactly once from the top level, and parent links match child lists. */
function assertValidTree(doc: DocumentCRDTv2, label: string): void {
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    assertTrue(depth < 10_000, `${label}: tree too deep (cycle?)`);
    for (const child of doc.children(parent)) {
      assertTrue(!seen.has(child), `${label}: node ${child} reachable twice`);
      seen.add(child);
      assertEqual(doc.node(child)?.parent ?? null, parent, `${label}: parent of ${child}`);
      walk(child, depth + 1);
    }
  };
  walk(null, 0);
  assertEqual(seen.size, doc.size(), `${label}: reachable nodes vs size()`);
}

function liveIds(doc: DocumentCRDTv2): string[] {
  const ids: string[] = [];
  doc.forEachNode((n) => {
    ids.push(n.id);
  });
  return ids;
}

// ---------------------------------------------------------------- property test model

type Kind = 'move' | 'reorder' | 'insert' | 'erase' | 'mark' | 'set' | 'create' | 'delete';
type Action =
  | { readonly t: 'op'; readonly peer: number; readonly kind: Kind; readonly a: number; readonly b: number; readonly c: number; readonly s: string }
  | { readonly t: 'partition'; readonly groups: readonly number[] }
  | { readonly t: 'sync' }
  | { readonly t: 'heal' };

const opArb: fc.Arbitrary<Action> = fc.record({
  t: fc.constant('op' as const),
  peer: fc.nat(7),
  kind: fc.constantFrom<Kind>('move', 'move', 'reorder', 'reorder', 'insert', 'insert', 'erase', 'mark', 'set', 'set', 'create', 'delete'),
  a: fc.nat(10_000),
  b: fc.nat(10_000),
  c: fc.nat(10_000),
  s: fc.constantFrom('x', 'yz', ' ', 'Hé', 'abc'),
});
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: opArb, weight: 8 },
  { arbitrary: fc.record({ t: fc.constant('partition' as const), groups: fc.array(fc.nat(2), { minLength: 8, maxLength: 8 }) }), weight: 1 },
  { arbitrary: fc.constant<Action>({ t: 'sync' }), weight: 2 },
  { arbitrary: fc.constant<Action>({ t: 'heal' }), weight: 1 },
);

function concreteOp(doc: DocumentCRDTv2, action: Extract<Action, { t: 'op' }>, created: number): PartOp | undefined {
  const ids = liveIds(doc);
  const movable = ids.filter((id) => id !== 'root');
  const pick = (list: readonly string[], n: number): string | undefined => (list.length === 0 ? undefined : list[n % list.length]);
  const text = doc.text('t', TEXT)?.text;
  switch (action.kind) {
    case 'move': {
      const node = pick(movable, action.a);
      const parent = pick(ids, action.b);
      return node === undefined || parent === undefined ? undefined : { op: 'move', node, parent };
    }
    case 'reorder': {
      const node = pick(movable, action.a);
      if (node === undefined) return undefined;
      const parent = doc.node(node)?.parent ?? null;
      const target = pick(
        doc.children(parent).filter((s) => s !== node),
        action.b,
      );
      if (target === undefined) return undefined;
      return { op: 'move', node, parent, position: action.c % 2 === 0 ? { after: target } : { before: target } };
    }
    case 'insert':
      if (text === undefined) return undefined;
      return { op: 'text.insert', node: 't', path: TEXT, at: action.a % (text.length + 1), text: action.s };
    case 'erase': {
      if (text === undefined || text.length === 0) return undefined;
      const from = action.a % text.length;
      return { op: 'text.delete', node: 't', path: TEXT, from, to: from + 1 + (action.b % Math.min(3, text.length - from)) };
    }
    case 'mark': {
      if (text === undefined || text.length === 0) return undefined;
      const from = action.a % text.length;
      const to = from + 1 + (action.b % (text.length - from));
      const key = action.c % 2 === 0 ? 'bold' : 'link';
      return { op: 'text.mark', node: 't', path: TEXT, from, to, key, value: action.c % 5 === 0 ? null : key === 'bold' ? true : `u${action.c % 3}` };
    }
    case 'set': {
      const node = pick(ids, action.a);
      const path = ['spatial.x', 'spatial.y', 'name'][action.b % 3] as string;
      return node === undefined ? undefined : { op: 'set', node, path, value: path === 'name' ? `n${action.c % 7}` : action.c % 100 };
    }
    case 'create': {
      const parent = pick(ids, action.a);
      return parent === undefined ? undefined : { op: 'create', node: `${doc.peer}-${created}`, kind: 'shape', parent, props: { 'spatial.x': action.c % 50 } };
    }
    case 'delete': {
      const node = pick(
        movable.filter((id) => id !== 't'),
        action.a,
      );
      return node === undefined || action.b % 3 !== 0 ? undefined : { op: 'delete', node };
    }
  }
}

/** Runs one scenario; returns how many ops were applied (so the property cannot pass vacuously). */
function runScenario(engine: CrdtEngine, peerCount: number, actions: readonly Action[]): number {
  const baseline = engine.liveHandles();
  const peers: DocumentCRDTv2[] = [];
  let applied = 0;
  try {
    const origin = seeded(engine, '1');
    peers.push(origin);
    const snapshot = origin.exportSnapshot();
    for (let i = 1; i < peerCount; i += 1) peers.push(okValue(engine.load(snapshot, { peer: `${i + 1}` as PeerId }), 'load peer'));
    let groups: readonly number[] = peers.map(() => 0);
    let created = 0;
    for (const action of actions) {
      if (action.t === 'partition') groups = peers.map((_, i) => action.groups[i] ?? 0);
      else if (action.t === 'heal') groups = peers.map(() => 0);
      else if (action.t === 'sync') {
        for (const a of peers) for (const b of peers) if (a !== b && groups[peers.indexOf(a)] === groups[peers.indexOf(b)]) syncPair(a, b);
      } else {
        const doc = peers[action.peer % peers.length] as DocumentCRDTv2;
        created += 1;
        const op = concreteOp(doc, action, created);
        if (op === undefined || !doc.check([op]).ok) continue;
        okValue(doc.transact(action.peer % 2 === 0 ? human : agent, [op]), `apply ${op.op}`);
        applied += 1;
      }
    }
    syncAll(peers);
    const expected = fingerprint(peers[0] as DocumentCRDTv2);
    peers.forEach((doc, i) => {
      assertValidTree(doc, `peer ${i}`);
      assertEqual(fingerprint(doc), expected, `peer ${i} converged`);
      assertEqual(doc.text('t', TEXT), (peers[0] as DocumentCRDTv2).text('t', TEXT), `peer ${i} rich text`);
      assertEqual((peers[0] as DocumentCRDTv2).compare(doc.frontier(), (peers[0] as DocumentCRDTv2).frontier()), 0, `peer ${i} frontier`);
    });
  } finally {
    for (const doc of peers) doc.dispose();
  }
  assertEqual(engine.liveHandles(), baseline, 'engine handles released after the run');
  return applied;
}

// ---------------------------------------------------------------- cases

export const documentCrdtContractCases: readonly DocumentCrdtContractCase[] = [
  {
    name: 'tree: creates nodes, reads them one at a time, orders siblings by position',
    async run(engine) {
      const doc = seeded(engine, '1');
      try {
        assertEqual(doc.children(null), ['root'], 'top level');
        assertEqual(doc.children('root'), ['g0', 'g1', 'g2', 't'], 'children');
        okValue(doc.transact(human, [{ op: 'create', node: 'n', kind: 'shape', parent: 'g0', position: { after: 'g0e0' } }]), 'create after');
        okValue(doc.transact(human, [{ op: 'move', node: 'g0e2', parent: 'g0', position: { after: null } }]), 'move first');
        assertEqual(doc.children('g0'), ['g0e2', 'g0e0', 'n', 'g0e1'], 'positions');
        const record = doc.node('g0e1');
        assertEqual([record?.kind, record?.parent, record?.props['spatial.x']], ['shape', 'g0', 1], 'node record');
        assertValidTree(doc, 'seeded');
      } finally {
        doc.dispose();
      }
    },
  },
  {
    name: 'moves are cycle-safe: local cycles are rejected, batches are all-or-nothing',
    async run(engine) {
      const doc = seeded(engine, '1');
      try {
        const before = doc.frontier();
        assertTrue(!doc.transact(human, [{ op: 'move', node: 'root', parent: 'g0e0' }]).ok, 'cycle rejected');
        assertTrue(!doc.transact(human, [{ op: 'set', node: 'g0', path: 'name', value: 'x' }, { op: 'delete', node: 'ghost' }]).ok, 'invalid batch rejected');
        assertEqual(doc.frontier(), before, 'nothing applied');
        assertEqual(doc.prop('g0', 'name'), undefined, 'first op not applied');
      } finally {
        doc.dispose();
      }
    },
  },
  {
    name: 'concurrent cyclic moves converge to a valid tree',
    async run(engine) {
      const a = seeded(engine, '1');
      const b = okValue(engine.load(a.exportSnapshot(), { peer: '2' }), 'load');
      try {
        okValue(a.transact(human, [{ op: 'move', node: 'g0', parent: 'g1' }]), 'a');
        okValue(b.transact(agent, [{ op: 'move', node: 'g1', parent: 'g0' }]), 'b');
        syncAll([a, b]);
        assertValidTree(a, 'a');
        assertEqual(fingerprint(a), fingerprint(b), 'converged');
      } finally {
        a.dispose();
        b.dispose();
      }
    },
  },
  {
    name: 'properties: concurrent sets converge (last writer wins per path), null removes',
    async run(engine) {
      const a = seeded(engine, '1');
      const b = okValue(engine.load(a.exportSnapshot(), { peer: '2' }), 'load');
      try {
        okValue(a.transact(human, [{ op: 'set', node: 'g0e0', path: 'spatial.x', value: 10 }, { op: 'set', node: 'g0e0', path: 'spatial.y', value: 1 }]), 'a');
        okValue(b.transact(agent, [{ op: 'set', node: 'g0e0', path: 'spatial.x', value: 20 }]), 'b');
        syncAll([a, b]);
        assertEqual(a.prop('g0e0', 'spatial.x'), b.prop('g0e0', 'spatial.x'), 'same winner');
        assertEqual(a.prop('g0e0', 'spatial.y'), 1, 'other path kept');
        okValue(a.transact(human, [{ op: 'set', node: 'g0e0', path: 'spatial.y', value: null }]), 'remove');
        assertEqual(a.prop('g0e0', 'spatial.y'), undefined, 'removed');
      } finally {
        a.dispose();
        b.dispose();
      }
    },
  },
  {
    name: 'rich text: concurrent inserts and marks converge; anchors follow edits',
    async run(engine) {
      const a = seeded(engine, '1');
      const b = okValue(engine.load(a.exportSnapshot(), { peer: '2' }), 'load');
      try {
        const anchor = a.anchor('t', TEXT, 6);
        assertTrue(anchor !== undefined, 'anchor taken');
        okValue(a.transact(human, [{ op: 'text.insert', node: 't', path: TEXT, at: 0, text: 'Big ' }]), 'a');
        okValue(b.transact(agent, [{ op: 'text.mark', node: 't', path: TEXT, from: 0, to: 5, key: 'bold', value: true }]), 'b');
        syncAll([a, b]);
        assertEqual(a.text('t', TEXT), b.text('t', TEXT), 'converged');
        assertEqual(a.text('t', TEXT)?.text, 'Big alpha beta', 'text');
        assertEqual(a.resolve(anchor as never), 10, 'anchor moved with the insert');
      } finally {
        a.dispose();
        b.dispose();
      }
    },
  },
  {
    name: 'inverse ops undo exactly one commit and keep other peers’ concurrent edits',
    async run(engine) {
      const a = seeded(engine, '1');
      const b = okValue(engine.load(a.exportSnapshot(), { peer: '2' }), 'load');
      try {
        const original = fingerprint(a);
        const commit = okValue(
          a.transact(agent, [
            { op: 'set', node: 'g1', path: 'spatial.x', value: 5 },
            { op: 'move', node: 'g0e0', parent: 'g2' },
            { op: 'text.insert', node: 't', path: TEXT, at: 6, text: 'AI ' },
            { op: 'delete', node: 'g1' },
          ]),
          'agent commit',
        );
        okValue(b.transact(human, [{ op: 'text.insert', node: 't', path: TEXT, at: 0, text: '> ' }]), 'concurrent human edit');
        syncAll([a, b]);
        okValue(b.transact({ ...agent, label: 'Undo' }, commit.inverse), 'undo on another peer');
        syncAll([a, b]);
        assertEqual(b.text('t', TEXT)?.text, '> alpha beta', 'human text survives, agent text gone');
        okValue(b.transact(human, [{ op: 'text.delete', node: 't', path: TEXT, from: 0, to: 2 }]), 'drop human edit');
        assertEqual(fingerprint(b), original, 'agent commit fully reverted');
      } finally {
        a.dispose();
        b.dispose();
      }
    },
  },
  {
    name: 'changedSince reports nodes, paths and actors from commit meta; trimmed history is unavailable',
    async run(engine) {
      const doc = seeded(engine, '1');
      let shallow: DocumentCRDTv2 | undefined;
      try {
        const base = doc.frontier();
        okValue(doc.transact({ ...agent, changeSet: 'cs1' }, [{ op: 'set', node: 'g0', path: 'name', value: 'Hero' }, { op: 'move', node: 'g1e1', parent: 'g0' }]), 'edit');
        const summary = okValue(doc.changedSince(base), 'changedSince');
        assertEqual(summary.commits.map((c) => c.meta?.changeSet), ['cs1'], 'commit meta');
        assertEqual(summary.nodes.get('g0')?.paths, ['name'], 'paths');
        assertEqual(summary.nodes.get('g1e1')?.moved, true, 'moved');
        assertEqual(summary.nodes.get('g0')?.actors, ['a'], 'actors');
        assertEqual([...okValue(doc.changedSince(base, { nodes: ['g0'] }), 'scoped').nodes.keys()], ['g0'], 'scope');
        shallow = okValue(engine.load(doc.exportShallowSnapshot(), { peer: '3' }), 'shallow');
        assertEqual(shallow.prop('g0', 'name'), 'Hero', 'state kept');
        assertTrue(!shallow.changedSince(base).ok, 'trimmed base unavailable');
      } finally {
        doc.dispose();
        shallow?.dispose();
      }
    },
  },
  {
    name: 'snapshots round-trip; updates are idempotent and commutative',
    async run(engine) {
      const a = seeded(engine, '1');
      const b = okValue(engine.load(a.exportSnapshot(), { peer: '2' }), 'load');
      const c = okValue(engine.load(a.exportSnapshot(), { peer: '3' }), 'load');
      try {
        const u1 = okValue(a.transact(human, [{ op: 'set', node: 'g0', path: 'spatial.x', value: 1 }]), 'u1').update;
        const u2 = okValue(a.transact(human, [{ op: 'create', node: 'n', kind: 'shape', parent: 'g2' }]), 'u2').update;
        okValue(b.import(u1), 'b u1');
        okValue(b.import(u2), 'b u2');
        okValue(b.import(u1), 'b u1 again');
        okValue(c.import(u2), 'c u2 (out of order)');
        okValue(c.import(u1), 'c u1');
        assertEqual(fingerprint(b), fingerprint(a), 'b == a');
        assertEqual(fingerprint(c), fingerprint(a), 'c == a');
        assertTrue(!a.import(new Uint8Array([7, 7, 7])).ok, 'garbage rejected');
      } finally {
        for (const d of [a, b, c]) d.dispose();
      }
    },
  },
  {
    name: 'fork: an independent peer at head or at an earlier frontier',
    async run(engine) {
      const doc = seeded(engine, '1');
      const base = doc.frontier();
      okValue(doc.transact(human, [{ op: 'set', node: 'g0', path: 'spatial.x', value: 9 }]), 'edit');
      const early = okValue(doc.fork('7', base), 'fork at base');
      const head = okValue(doc.fork('8'), 'fork at head');
      try {
        assertEqual([early.peer, early.prop('g0', 'spatial.x'), head.prop('g0', 'spatial.x')], ['7', undefined, 9], 'fork states');
        okValue(head.transact(agent, [{ op: 'delete', node: 'g2' }]), 'fork edit');
        assertTrue(doc.has('g2'), 'source untouched');
      } finally {
        for (const d of [doc, early, head]) d.dispose();
      }
    },
  },
  {
    name: 'disposal releases every engine handle (leak check)',
    async run(engine) {
      const baseline = engine.liveHandles();
      const a = seeded(engine, '1');
      const b = okValue(a.fork('2'), 'fork');
      a.subtree('root');
      a.changedSince(a.frontier());
      a.anchor('t', TEXT, 1);
      syncAll([a, b]);
      a.dispose();
      b.dispose();
      assertTrue(a.disposed && b.disposed, 'disposed');
      assertEqual(engine.liveHandles(), baseline, 'handles back to baseline');
    },
  },
  {
    name: 'N-peer convergence: random move / reorder / text / set under partitions and heals (property)',
    async run(engine, options) {
      const maxPeers = Math.max(2, options.maxPeers ?? 4);
      const numRuns = options.numRuns ?? 30;
      let applied = 0;
      fc.assert(
        fc.property(fc.integer({ min: 2, max: maxPeers }), fc.array(actionArb, { minLength: 1, maxLength: options.maxSteps ?? 40 }), (peerCount, actions) => {
          applied += runScenario(engine, peerCount, actions);
        }),
        { numRuns, ...(options.seed === undefined ? {} : { seed: options.seed }) },
      );
      assertTrue(applied >= numRuns * 2, `the generator applied too few ops (${applied} over ${numRuns} runs)`);
    },
  },
];

export function runDocumentCrdtContract(name: string, engine: CrdtEngine, runner: ContractRunner, options: DocumentCrdtContractOptions = {}): void {
  runner.describe(`DocumentCRDT contract: ${name}`, () => {
    for (const c of documentCrdtContractCases) {
      if (options.skip?.includes(c.name) === true) continue;
      runner.it(c.name, () => c.run(engine, options));
    }
  });
}
