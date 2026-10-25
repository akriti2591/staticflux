/**
 * `UndoService` contract suite (SF-Δ9, IF-4.13, D9, D14). Runs against an undo-service factory over documents of a
 * `DocumentRepo`, so the same cases cover the reference service with any engine and store.
 *
 * Covers: one step per commit / gesture / invocation, readable labels, per-actor stacks, redo and redo clearing,
 * the 200-step default limit, conflict flagging over another actor's later overwrite (and the `overwrite` /
 * `keep-theirs` resolutions), persistence across reload and compaction, two peers converging, and two property
 * tests: random interleavings of two humans and an agent (one peer each) checked against an exact model under
 * immediate delivery, and own-edits-only plus convergence under random partitions.
 *
 * @example
 * runUndoServiceContract('reference · Loro', {
 *   store: () => createMemoryDocumentStore(),
 *   repo: (store) => createDocumentRepo({ store, engine: createLoroEngine() }),
 *   service: (doc) => createUndoService({ doc }),
 * }, { describe, it });
 */
import type { DocumentRepo, DocumentStore, OpenDocument, PartOp } from '@staticflux/document/v2';
import { type Actor, transactionMeta, type UndoConflict, type UndoOutcome, type UndoService } from '@staticflux/stage';
import fc from 'fast-check';
import { assertEqual, assertTrue, type ContractRunner, okValue } from './contract-runner.js';

export interface UndoServiceContractSubject {
  readonly store: () => DocumentStore | Promise<DocumentStore>;
  readonly repo: (store: DocumentStore) => DocumentRepo;
  readonly service: (doc: OpenDocument) => UndoService;
}

export interface UndoServiceContractOptions {
  readonly skip?: readonly string[];
  /** Property-test runs (default 20). */
  readonly numRuns?: number;
  /** Actions per run (default 30). */
  readonly maxSteps?: number;
  readonly seed?: number;
}

export interface UndoServiceContractCase {
  readonly name: string;
  run(subject: UndoServiceContractSubject, options: UndoServiceContractOptions): Promise<void>;
}

const signal = (): AbortSignal => new AbortController().signal;
const ASSET = 'as_undo';
const PART = 'page:p1';
const NODES = ['n0', 'n1', 'n2'] as const;
const PATHS = ['spatial.x', 'spatial.y'] as const;

export const contractHumanA: Actor = { kind: 'human', id: 'h-a', displayName: 'Ann', via: 'direct' };
export const contractHumanB: Actor = { kind: 'human', id: 'h-b', displayName: 'Ben', via: 'shortcut' };
export const contractAgent: Actor = { kind: 'agent', id: 'ag', displayName: 'Agent', model: 'test-model', via: 'chat', onBehalfOf: 'h-a' };
const ACTORS = [contractHumanA, contractHumanB, contractAgent] as const;

async function seed(subject: UndoServiceContractSubject): Promise<{ store: DocumentStore; doc: OpenDocument }> {
  const store = await subject.store();
  const doc = okValue(await subject.repo(store).create(ASSET, { treeSchema: 1, parts: ['root', PART] }, signal()), 'create');
  for (const id of doc.partIds()) okValue(await doc.part(id, signal()), `load ${id}`);
  const ops: PartOp[] = [{ op: 'create', node: 'p1', kind: 'page', parent: null }];
  for (const node of NODES) ops.push({ op: 'create', node, kind: 'shape', parent: 'p1', props: { 'spatial.x': 0, 'spatial.y': 0 } });
  okValue(await doc.transact({ actor: { kind: 'system', id: 'seed' }, label: 'Seed' }, { [PART]: ops }, signal()), 'seed');
  okValue(await doc.flush(signal()), 'flush');
  return { store, doc };
}

async function open(subject: UndoServiceContractSubject, store: DocumentStore): Promise<OpenDocument> {
  const doc = okValue(await subject.repo(store).open(ASSET, signal()), 'open');
  for (const id of doc.partIds()) okValue(await doc.part(id, signal()), `load ${id}`);
  return doc;
}

const set = (node: string, value: number, path: string = PATHS[0]): Record<string, readonly PartOp[]> => ({ [PART]: [{ op: 'set', node, path, value }] });
const read = (doc: OpenDocument, node: string, path: string = PATHS[0]): unknown => doc.loadedPart(PART)?.prop(node, path);
const all = (doc: OpenDocument): unknown[] => NODES.flatMap((n) => PATHS.map((p) => read(doc, n, p)));

function expectKind<K extends UndoOutcome['kind']>(outcome: UndoOutcome, kind: K, message: string): Extract<UndoOutcome, { kind: K }> {
  assertEqual(outcome.kind, kind, message);
  return outcome as Extract<UndoOutcome, { kind: K }>;
}

/** Peers (one per actor) relaying every commit to the others at once, or queued per link when `queued`. */
async function peers(subject: UndoServiceContractSubject, queued: boolean) {
  const { store, doc: first } = await seed(subject);
  const docs: OpenDocument[] = [first, await open(subject, store), await open(subject, store)];
  const services = docs.map((d) => subject.service(d));
  const queues = new Map<string, Parameters<UndoService['applyRemote']>[0][]>();
  docs.forEach((doc, from) => {
    doc.onCommit((record) => {
      services.forEach((service, to) => {
        if (to === from) return;
        if (!queued) okValue(service.applyRemote(record), 'relay');
        else {
          const key = `${from}>${to}`;
          queues.set(key, [...(queues.get(key) ?? []), record]);
        }
      });
    });
  });
  const deliver = (from: number, to: number): void => {
    const key = `${from}>${to}`;
    for (const record of queues.get(key) ?? []) okValue((services[to] as UndoService).applyRemote(record), 'deliver');
    queues.set(key, []);
  };
  const deliverAll = (): void => {
    for (let from = 0; from < 3; from += 1) for (let to = 0; to < 3; to += 1) if (from !== to) deliver(from, to);
  };
  return { docs, services, deliver, deliverAll };
}

// ---------------------------------------------------------------- model for the property tests

type Key = `${string}|${string}`;
interface ModelStep {
  writes: Map<Key, { restore: number; written: number }>;
  group: string | undefined;
}
interface ModelStacks {
  undo: ModelStep[];
  redo: ModelStep[];
}

type Action =
  | { readonly t: 'edit'; readonly actor: number; readonly targets: readonly number[]; readonly group: number }
  | { readonly t: 'undo' | 'redo'; readonly actor: number; readonly policy: 'flag' | 'overwrite' | 'keep-theirs' }
  | { readonly t: 'deliver'; readonly from: number; readonly to: number };

const actionArb = (withDeliver: boolean): fc.Arbitrary<Action> =>
  fc.oneof(
    { arbitrary: fc.record({ t: fc.constant('edit' as const), actor: fc.nat(2), targets: fc.uniqueArray(fc.nat(5), { minLength: 1, maxLength: 2 }), group: fc.nat(3) }), weight: 5 },
    { arbitrary: fc.record({ t: fc.constant('undo' as const), actor: fc.nat(2), policy: fc.constantFrom('flag' as const, 'flag' as const, 'overwrite' as const, 'keep-theirs' as const) }), weight: 3 },
    { arbitrary: fc.record({ t: fc.constant('redo' as const), actor: fc.nat(2), policy: fc.constantFrom('flag' as const, 'overwrite' as const, 'keep-theirs' as const) }), weight: 2 },
    ...(withDeliver ? [{ arbitrary: fc.record({ t: fc.constant('deliver' as const), from: fc.nat(2), to: fc.nat(2) }), weight: 2 }] : []),
  );

const targetOf = (i: number): { node: string; path: string; key: Key } => {
  const node = NODES[Math.floor(i / PATHS.length)] as string;
  const path = PATHS[i % PATHS.length] as string;
  return { node, path, key: `${node}|${path}` };
};
const keyOfConflict = (c: UndoConflict): Key => `${c.node}|${c.path ?? ''}`;

/** Only the agent groups by invocation (group 0 = no invocation). */
const actorFor = (index: number, group: number): Actor => {
  const actor = ACTORS[index] as Actor;
  return actor.kind === 'agent' && group > 0 ? { ...actor, invocationId: `inv-${group}` } : actor;
};

async function runModel(subject: UndoServiceContractSubject, actions: readonly Action[]): Promise<number> {
  const { docs, services } = await peers(subject, false);
  const state = new Map<Key, number>();
  for (let i = 0; i < NODES.length * PATHS.length; i += 1) state.set(targetOf(i).key, 0);
  const stacks: ModelStacks[] = ACTORS.map(() => ({ undo: [], redo: [] }));
  let counter = 0;
  let conflicts = 0;
  for (const action of actions) {
    if (action.t === 'deliver') continue;
    const me = action.actor;
    const service = services[me] as UndoService;
    const model = stacks[me] as ModelStacks;
    if (action.t === 'edit') {
      const actor = actorFor(me, action.group);
      const ops: PartOp[] = [];
      const top = model.undo[model.undo.length - 1];
      const group = actor.invocationId;
      const step: ModelStep = group !== undefined && top !== undefined && top.group === group ? top : { writes: new Map(), group };
      for (const i of action.targets) {
        const { node, path, key } = targetOf(i);
        counter += 1;
        ops.push({ op: 'set', node, path, value: counter });
        const existing = step.writes.get(key);
        step.writes.set(key, { restore: existing?.restore ?? (state.get(key) as number), written: counter });
        state.set(key, counter);
      }
      okValue(service.commit(actor, `Edit ${counter}`, { [PART]: ops }), 'edit');
      if (step !== top) model.undo.push(step);
      model.redo = [];
      continue;
    }
    const from = action.t === 'undo' ? model.undo : model.redo;
    const step = from[from.length - 1];
    const outcome = okValue(await (action.t === 'undo' ? service.undo(ACTORS[me] as Actor, signal()) : service.redo(ACTORS[me] as Actor, signal())), action.t);
    if (step === undefined) {
      expectKind(outcome, 'empty', `${action.t} on an empty stack`);
      continue;
    }
    const expectedConflicts = [...step.writes].filter(([key, w]) => state.get(key) !== w.written).map(([key]) => key).sort();
    if (expectedConflicts.length > 0) {
      const flagged = expectKind(outcome, 'conflict', `${action.t} over another actor's overwrite is flagged`);
      assertEqual([...new Set(flagged.conflicts.map(keyOfConflict))].sort(), expectedConflicts, 'exactly the overwritten targets are flagged');
      conflicts += 1;
      if (action.policy === 'flag') continue;
      const resolved = okValue(await (action.t === 'undo' ? service.undo(ACTORS[me] as Actor, signal(), { onConflict: action.policy }) : service.redo(ACTORS[me] as Actor, signal(), { onConflict: action.policy })), `${action.t} resolved`);
      expectKind(resolved, 'applied', `${action.t} with ${action.policy}`);
    } else {
      expectKind(outcome, 'applied', `${action.t} without conflicts applies`);
    }
    from.pop();
    const opposite: ModelStep = { writes: new Map(), group: undefined };
    for (const [key, w] of step.writes) {
      if (action.policy === 'keep-theirs' && expectedConflicts.includes(key)) continue;
      opposite.writes.set(key, { restore: state.get(key) as number, written: w.restore });
      state.set(key, w.restore);
    }
    if (opposite.writes.size > 0) (action.t === 'undo' ? model.redo : model.undo).push(opposite);
    // every peer sees exactly the model state (immediate delivery)
    for (const d of docs) {
      for (const [key, value] of state) {
        const [node, path] = key.split('|') as [string, string];
        assertEqual(read(d, node, path), value, `peer state ${key} after ${action.t}`);
      }
    }
  }
  for (const d of docs) assertEqual(all(d), all(docs[0] as OpenDocument), 'peers converge');
  // every peer holds the same copy of every actor's stacks
  for (const actor of ACTORS) for (const s of services) assertEqual(s.history(actor.id), (services[ACTORS.indexOf(actor)] as UndoService).history(actor.id), `stacks of ${actor.id} agree`);
  ACTORS.forEach((actor, i) => {
    const model = stacks[i] as ModelStacks;
    const history = (services[i] as UndoService).history(actor.id);
    assertEqual([history.undo.length, history.redo.length], [model.undo.length, model.redo.length], `stack sizes of ${actor.id}`);
  });
  return conflicts;
}

async function runPartitioned(subject: UndoServiceContractSubject, actions: readonly Action[]): Promise<void> {
  const { docs, services, deliver, deliverAll } = await peers(subject, true);
  let counter = 0;
  for (const action of actions) {
    if (action.t === 'deliver') {
      if (action.from !== action.to) deliver(action.from, action.to);
      continue;
    }
    const me = action.actor;
    const doc = docs[me] as OpenDocument;
    const service = services[me] as UndoService;
    if (action.t === 'edit') {
      const ops: PartOp[] = action.targets.map((i) => {
        counter += 1;
        const { node, path } = targetOf(i);
        return { op: 'set', node, path, value: counter };
      });
      okValue(service.commit(actorFor(me, action.group), `Edit ${counter}`, { [PART]: ops }), 'edit');
      continue;
    }
    const before = new Map<Key, unknown>();
    for (let i = 0; i < NODES.length * PATHS.length; i += 1) before.set(targetOf(i).key, read(doc, targetOf(i).node, targetOf(i).path));
    const call = (o?: { onConflict: 'overwrite' | 'keep-theirs' }) => (action.t === 'undo' ? service.undo(ACTORS[me] as Actor, signal(), o) : service.redo(ACTORS[me] as Actor, signal(), o));
    let outcome = okValue(await call(), action.t);
    if (outcome.kind === 'conflict') {
      for (const c of outcome.conflicts) assertTrue(c.by.length === 0 || c.by.every((a) => ACTORS.some((x) => x.id === a)), 'conflicts name real actors');
      const unchanged = [...before].every(([key, value]) => read(doc, ...(key.split('|') as [string, string])) === value);
      assertTrue(unchanged, 'a flagged undo writes nothing');
      if (action.policy === 'flag') continue;
      outcome = okValue(await call({ onConflict: action.policy }), `${action.t} resolved`);
    }
    if (outcome.kind !== 'applied') continue;
    // own edits only: every target that changed is one the undo commit wrote
    const written = new Set<Key>(
      Object.values(outcome.record.inverse)
        .flat()
        .flatMap((op) => (op.op === 'set' ? [`${op.node}|${op.path}` as Key] : [])),
    );
    for (const [key, value] of before) if (read(doc, ...(key.split('|') as [string, string])) !== value) assertTrue(written.has(key), `${action.t} by ${ACTORS[me]?.id} changed only its own step's targets (${key})`);
  }
  deliverAll();
  for (const d of docs) assertEqual(all(d), all(docs[0] as OpenDocument), 'peers converge after every record is delivered');
  for (const actor of ACTORS) for (const s of services) assertEqual(s.history(actor.id), (services[ACTORS.indexOf(actor)] as UndoService).history(actor.id), `stacks of ${actor.id} agree after delivery`);
}

export const undoServiceContractCases: readonly UndoServiceContractCase[] = [
  {
    name: 'undo and redo one commit as one step with a readable label',
    async run(subject) {
      const { doc } = await seed(subject);
      const undo = subject.service(doc);
      okValue(undo.commit(contractHumanA, 'Move', set('n0', 5)), 'commit');
      assertEqual(undo.peek(contractHumanA.id, 'undo')?.label, 'Move', 'label');
      const out = expectKind(okValue(await undo.undo(contractHumanA, signal()), 'undo'), 'applied', 'undo');
      assertEqual(out.step.label, 'Move', 'step label');
      assertEqual(read(doc, 'n0'), 0, 'undone');
      expectKind(okValue(await undo.redo(contractHumanA, signal()), 'redo'), 'applied', 'redo');
      assertEqual(read(doc, 'n0'), 5, 'redone');
      expectKind(okValue(await undo.redo(contractHumanA, signal()), 'redo again'), 'empty', 'nothing to redo');
    },
  },
  {
    name: 'one gesture and one capability invocation are one step each',
    async run(subject) {
      const { doc } = await seed(subject);
      const undo = subject.service(doc);
      const g = okValue(undo.gesture(contractHumanA, 'Drag', PART), 'gesture');
      for (let i = 1; i <= 10; i += 1) okValue(g.stage([{ op: 'set', node: 'n0', path: 'spatial.x', value: i }]), 'frame');
      okValue(g.commit(), 'commit gesture');
      const run = { ...contractAgent, invocationId: 'inv-x' };
      okValue(undo.commit(run, 'Arrange', set('n1', 1)), 'a1');
      okValue(undo.commit(run, 'Arrange', set('n2', 2)), 'a2');
      assertEqual(undo.history(contractHumanA.id).undo.length, 1, 'gesture = 1 step');
      assertEqual(undo.history(contractAgent.id).undo.map((s) => s.commits), [2], 'invocation = 1 step');
      expectKind(okValue(await undo.undo(contractAgent, signal()), 'undo agent'), 'applied', 'undo agent');
      assertEqual([read(doc, 'n0'), read(doc, 'n1'), read(doc, 'n2')], [10, 0, 0], 'agent step reverted as a whole, human kept');
    },
  },
  {
    name: 'per actor: undo never reverts another actor’s edit',
    async run(subject) {
      const { doc } = await seed(subject);
      const undo = subject.service(doc);
      okValue(undo.commit(contractHumanA, 'A', set('n0', 1)), 'a');
      okValue(undo.commit(contractAgent, 'Agent', set('n1', 2)), 'agent');
      okValue(undo.commit(contractHumanB, 'B', set('n2', 3)), 'b');
      expectKind(okValue(await undo.undo(contractAgent, signal()), 'undo'), 'applied', 'agent undo');
      assertEqual([read(doc, 'n0'), read(doc, 'n1'), read(doc, 'n2')], [1, 0, 3], 'only the agent edit reverted');
      okValue(undo.commit(contractAgent, 'Agent 2', set('n1', 4)), 'agent 2');
      assertTrue(!undo.canRedo(contractAgent.id), 'a new edit clears the actor’s redo');
    },
  },
  {
    name: 'an undo over another actor’s later overwrite is flagged, then resolved explicitly',
    async run(subject) {
      const { doc } = await seed(subject);
      const undo = subject.service(doc);
      okValue(undo.commit(contractHumanA, 'Set', set('n0', 10)), 'human');
      okValue(undo.commit(contractAgent, 'Overwrite', set('n0', 20)), 'agent');
      const flagged = expectKind(okValue(await undo.undo(contractHumanA, signal()), 'undo'), 'conflict', 'flagged');
      assertEqual(flagged.conflicts.map((c) => [c.kind, c.node, c.path, c.expected, c.current, c.restore, c.by]), [['overwritten', 'n0', 'spatial.x', 10, 20, 0, [contractAgent.id]]], 'conflict details');
      assertEqual(read(doc, 'n0'), 20, 'nothing written while flagged');
      expectKind(okValue(await undo.undo(contractHumanA, signal(), { onConflict: 'keep-theirs' }), 'keep'), 'applied', 'keep theirs');
      assertEqual(read(doc, 'n0'), 20, 'theirs kept');
      okValue(undo.commit(contractHumanA, 'Set again', set('n0', 30)), 'human 2');
      okValue(undo.commit(contractAgent, 'Overwrite again', set('n0', 40)), 'agent 2');
      expectKind(okValue(await undo.undo(contractHumanA, signal(), { onConflict: 'overwrite' }), 'overwrite'), 'applied', 'overwrite');
      assertEqual(read(doc, 'n0'), 20, 'mine restored (the value before my step)');
    },
  },
  {
    name: 'keeps 200 steps per actor by default (D9)',
    async run(subject) {
      const { doc } = await seed(subject);
      const undo = subject.service(doc);
      for (let i = 1; i <= 205; i += 1) okValue(undo.commit(contractHumanA, `Step ${i}`, set('n0', i)), `commit ${i}`);
      const steps = undo.history(contractHumanA.id).undo;
      assertEqual([steps.length, steps[0]?.label, steps[199]?.label], [200, 'Step 205', 'Step 6'], 'newest 200 kept');
    },
  },
  {
    name: 'stacks persist across reload and compaction',
    async run(subject) {
      const { store, doc } = await seed(subject);
      const undo = subject.service(doc);
      okValue(undo.commit(contractHumanA, 'One', set('n0', 1)), 'one');
      okValue(undo.commit(contractHumanA, 'Two', set('n0', 2)), 'two');
      expectKind(okValue(await undo.undo(contractHumanA, signal()), 'undo'), 'applied', 'undo two');
      okValue(await doc.compact(signal()), 'compact');
      okValue(undo.commit(contractAgent, 'Agent', set('n1', 3)), 'agent');
      okValue(await doc.close(signal(), { compact: false }), 'close');
      const reopened = await open(subject, store);
      const again = subject.service(reopened);
      assertEqual(again.history(contractHumanA.id).undo.map((s) => s.label), ['One'], 'undo stack');
      assertEqual(again.history(contractHumanA.id).redo.map((s) => s.label), ['Two'], 'redo stack');
      assertEqual(again.history(contractAgent.id).undo.map((s) => s.label), ['Agent'], 'other actors too');
      expectKind(okValue(await again.redo(contractHumanA, signal()), 'redo after reload'), 'applied', 'redo after reload');
      assertEqual(read(reopened, 'n0'), 2, 'redone after reload');
    },
  },
  {
    name: 'peers: each undoes only its own actor’s edits and all converge',
    async run(subject) {
      const { docs, services } = await peers(subject, false);
      const [a, , c] = services as [UndoService, UndoService, UndoService];
      okValue(a.commit(contractHumanA, 'A', set('n0', 1)), 'a');
      okValue(c.commit(contractAgent, 'Agent', set('n0', 2, PATHS[1])), 'agent');
      expectKind(okValue(await c.undo(contractAgent, signal()), 'undo'), 'applied', 'agent undo');
      for (const d of docs) assertEqual([read(d, 'n0'), read(d, 'n0', PATHS[1])], [1, 0], 'converged');
      assertTrue(a.canRedo(contractAgent.id), 'the undo arrived at the other peers too');
    },
  },
  {
    name: 'commits without a txn are not undoable; ingest is idempotent',
    async run(subject) {
      const { doc } = await seed(subject);
      const undo = subject.service(doc);
      okValue(doc.commit({ actor: { kind: 'human', id: contractHumanA.id }, label: 'raw' }, set('n0', 9)), 'raw');
      assertTrue(!undo.canUndo(contractHumanA.id), 'no txn, no step');
      const committed = okValue(doc.commit(transactionMeta(contractHumanA, 'Tracked'), set('n0', 8)), 'tracked');
      undo.ingest(committed.record);
      assertEqual(undo.history(contractHumanA.id).undo.length, 1, 'ingested once');
    },
  },
  {
    name: 'property: two humans and an agent (one peer each), immediate delivery — exact model: own edits only, conflicts flagged, convergence',
    async run(subject, options) {
      let conflicts = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(actionArb(false), { minLength: 4, maxLength: options.maxSteps ?? 30 }), async (actions) => {
          conflicts += await runModel(subject, actions);
        }),
        { numRuns: options.numRuns ?? 20, ...(options.seed === undefined ? {} : { seed: options.seed }) },
      );
      assertTrue(conflicts > 0, 'the generator produced at least one conflict');
    },
  },
  {
    name: 'property: random partitions — own edits only, flagged undos write nothing, convergence after delivery',
    async run(subject, options) {
      await fc.assert(
        fc.asyncProperty(fc.array(actionArb(true), { minLength: 4, maxLength: options.maxSteps ?? 30 }), async (actions) => {
          await runPartitioned(subject, actions);
        }),
        { numRuns: options.numRuns ?? 20, ...(options.seed === undefined ? {} : { seed: options.seed }) },
      );
    },
  },
];

export function runUndoServiceContract(name: string, subject: UndoServiceContractSubject, runner: ContractRunner, options: UndoServiceContractOptions = {}): void {
  runner.describe(`UndoService contract: ${name}`, () => {
    for (const c of undoServiceContractCases) {
      if (options.skip?.includes(c.name) === true) continue;
      runner.it(c.name, () => c.run(subject, options));
    }
  });
}
