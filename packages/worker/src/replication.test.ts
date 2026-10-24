import { effect, ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPatches,
  createJsonSource,
  createLink,
  createPortPair,
  createPublisher,
  createReplica,
  defineReplica,
  isPatch,
  type Patch,
} from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('patches', () => {
  it('applies add/replace/remove immutably with structural sharing', () => {
    const state = { a: { b: 1 }, list: [1, 2, 3], keep: { x: 1 } };
    const result = applyPatches(state, [
      { op: 'replace', path: ['a', 'b'], value: 2 },
      { op: 'add', path: ['list', 1], value: 9 },
      { op: 'remove', path: ['list', 0] },
      { op: 'add', path: ['list', '-'], value: 4 },
      { op: 'add', path: ['a', 'c'], value: true },
      { op: 'remove', path: ['a', 'b'] },
    ]);
    expect(result.ok && result.value).toEqual({ a: { c: true }, list: [9, 2, 3, 4], keep: { x: 1 } });
    expect(result.ok && result.value.keep).toBe(state.keep);
    expect(state).toEqual({ a: { b: 1 }, list: [1, 2, 3], keep: { x: 1 } });
  });

  it('replaces the root and reports bad paths (SF-WK-016)', () => {
    expect(applyPatches(1, [{ op: 'replace', path: [], value: 2 }])).toEqual(ok(2));
    expect(applyPatches({}, [{ op: 'remove', path: [] }])).toEqual(ok(undefined));
    const missing = applyPatches({ a: 1 }, [{ op: 'replace', path: ['x', 'y'], value: 1 }]);
    expect(!missing.ok && missing.error.code).toBe('SF-WK-016');
    expect(applyPatches({ l: [1] }, [{ op: 'replace', path: ['l', 5], value: 1 }]).ok).toBe(false);
    expect(applyPatches({ l: [1] }, [{ op: 'remove', path: ['l', 5] }]).ok).toBe(false);
    expect(applyPatches({ l: [1] }, [{ op: 'add', path: ['l', 5], value: 1 }]).ok).toBe(false);
    expect(applyPatches({ l: [1] }, [{ op: 'add', path: ['l', -1], value: 1 }]).ok).toBe(false);
    expect(applyPatches(3, [{ op: 'add', path: ['a'], value: 1 }]).ok).toBe(false);
    expect(isPatch({ op: 'add', path: [] })).toBe(true);
    expect(isPatch({ op: 'move', path: [] })).toBe(false);
  });
});

interface Todos {
  readonly items: readonly { readonly id: string; readonly done: boolean }[];
  readonly count: number;
}
type TodoIntents = {
  readonly add: { readonly args: { readonly id: string }; readonly result: number };
  readonly fail: { readonly args: null; readonly result: never };
};
const TodoReplica = defineReplica('test/todos').type<Todos, TodoIntents>();

function makeOwner(options: { ringSize?: number; maxBatchPatches?: number; epoch?: string } = {}) {
  const source = createJsonSource<Todos>(
    { items: [], count: 0 },
    {
      add: (args, api) => {
        const { id } = args as { id: string };
        const applied = api.apply([
          { op: 'add', path: ['items', api.state.items.length], value: { id, done: false } },
          { op: 'replace', path: ['count'], value: api.state.count + 1 },
        ]);
        return applied.ok ? ok(api.state.count) : applied;
      },
    },
  );
  const publisher = createPublisher({ definition: TodoReplica, source, ...options });
  return { source, publisher };
}

function connect() {
  const pair = createPortPair();
  return { pair, owner: createLink({ port: pair.a, name: 'owner' }), replicaLink: createLink({ port: pair.b, name: 'replica' }) };
}

const addTodo = (source: ReturnType<typeof makeOwner>['source'], id: string): void => {
  source.apply([
    { op: 'add', path: ['items', source.state.items.length], value: { id, done: false } },
    { op: 'replace', path: ['count'], value: source.state.count + 1 },
  ]);
};

describe('replication', () => {
  it('snapshot handshake, then versioned patches batched per flush', async () => {
    const { source, publisher } = makeOwner();
    addTodo(source, 'a');
    const { owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(TodoReplica);
    expect(replica.status).toBe('detached');
    const events: string[] = [];
    replica.subscribe((e) => events.push(e.type));
    expect((await replica.attach(replicaLink)).ok).toBe(true);
    expect(replica.status).toBe('live');
    expect(replica.state.count).toBe(1);
    expect(replica.epoch).toBe(publisher.epoch);
    const versionBefore = replica.version;
    addTodo(source, 'b');
    addTodo(source, 'c');
    await tick();
    expect(replica.state.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    // Two store changes in one task → one flush → one version.
    expect(replica.version).toBe(versionBefore + 1);
    expect(events).toEqual(['snapshot', 'patches']);
    expect(publisher.peers).toBe(1);
  });

  it('state is reactive', async () => {
    const { source, publisher } = makeOwner();
    const { owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(TodoReplica, { initial: { items: [], count: -1 } });
    const seen: number[] = [];
    effect(() => {
      seen.push(replica.state.count);
    });
    await replica.attach(replicaLink);
    addTodo(source, 'x');
    await tick();
    expect(seen).toEqual([-1, 0, 1]);
  });

  it('replicas are read-only: mutation throws SF-WK-002 (I-9)', async () => {
    const { publisher } = makeOwner();
    const { owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(TodoReplica);
    await replica.attach(replicaLink);
    expect(() => {
      (replica.state as { count: number }).count = 5;
    }).toThrowError(expect.objectContaining({ code: 'SF-WK-002' }));
    expect(() => {
      (replica.state.items as { id: string }[]).push({ id: 'x' });
    }).toThrowError(expect.objectContaining({ code: 'SF-WK-002' }));
    expect(() => {
      delete (replica.state as { count?: number }).count;
    }).toThrow();
    const unguarded = createReplica(TodoReplica, { devGuards: false });
    expect(unguarded.state).toBeUndefined();
  });

  it('writes are intents: the owner applies them and the replica sees the patches on resolve', async () => {
    const { publisher } = makeOwner();
    const { owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(TodoReplica);
    await replica.attach(replicaLink);
    const result = await replica.intent('add', { id: 'z' });
    expect(result).toEqual(ok(1));
    expect(replica.state.items[0]?.id).toBe('z');
    const unknown = await replica.intent('fail', null);
    expect(!unknown.ok && unknown.error.code).toBe('SF-WK-014');
    const detached = createReplica(TodoReplica);
    const notAttached = await detached.intent('add', { id: 'q' });
    expect(!notAttached.ok && notAttached.error.code).toBe('SF-WK-009');
  });

  it('re-handshake gets patchesSince from the ring buffer', async () => {
    const { source, publisher } = makeOwner();
    const first = connect();
    publisher.attach(first.owner);
    const replica = createReplica(TodoReplica);
    await replica.attach(first.replicaLink);
    first.owner.close();
    expect(replica.status).toBe('detached');
    addTodo(source, 'missed-1');
    await tick();
    addTodo(source, 'missed-2');
    await tick();
    const second = connect();
    publisher.attach(second.owner);
    const events: string[] = [];
    replica.subscribe((e) => events.push(e.type));
    await replica.attach(second.replicaLink);
    expect(events).toEqual(['patches']);
    expect(replica.state.items.map((i) => i.id)).toEqual(['missed-1', 'missed-2']);
    expect(replica.version).toBe(publisher.version);
  });

  it('ring overflow → snapshot; up-to-date hello → empty patches', async () => {
    const { source, publisher } = makeOwner({ ringSize: 1 });
    const first = connect();
    publisher.attach(first.owner);
    const replica = createReplica(TodoReplica);
    await replica.attach(first.replicaLink);
    replica.detach();
    for (const id of ['1', '2', '3']) {
      addTodo(source, id);
      await tick();
    }
    const events: string[] = [];
    replica.subscribe((e) => events.push(e.type));
    await replica.attach(first.replicaLink);
    expect(events).toEqual(['snapshot']);
    expect(replica.state.count).toBe(3);
    await replica.resync();
    expect(events).toEqual(['snapshot']);
    expect(replica.status).toBe('live');
  });

  it('epoch mismatch (respawned owner) → resnapshot', async () => {
    const one = makeOwner({ epoch: 'owner-1' });
    addTodo(one.source, 'old');
    const first = connect();
    one.publisher.attach(first.owner);
    const replica = createReplica(TodoReplica);
    await replica.attach(first.replicaLink);
    expect(replica.state.count).toBe(1);
    // A new owner instance (e.g. after a worker respawn) with different state.
    const two = makeOwner({ epoch: 'owner-2' });
    addTodo(two.source, 'n1');
    addTodo(two.source, 'n2');
    await tick();
    const second = connect();
    two.publisher.attach(second.owner);
    await replica.attach(second.replicaLink);
    expect(replica.epoch).toBe('owner-2');
    expect(replica.state.items.map((i) => i.id)).toEqual(['n1', 'n2']);
  });

  it('gap in the live stream → resync', async () => {
    const { source, publisher } = makeOwner();
    const { pair, owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(TodoReplica);
    await replica.attach(replicaLink);
    // Drop one batch on the floor by sending a forged out-of-order message first.
    owner.send(TodoReplica.channel, { type: 'patches', epoch: publisher.epoch, fromVersion: 99, toVersion: 100, patches: [] });
    addTodo(source, 'after-gap');
    await tick();
    await tick();
    await tick();
    expect(replica.status).toBe('live');
    expect(replica.state.items.map((i) => i.id)).toEqual(['after-gap']);
    expect(pair.a.closed).toBe(false);
  });

  it('tolerates a frozen replica side: queued batches apply in order on thaw', async () => {
    const { source, publisher } = makeOwner();
    const { pair, owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(TodoReplica);
    await replica.attach(replicaLink);
    pair.b.freeze();
    for (let i = 0; i < 20; i += 1) {
      addTodo(source, `t${i}`);
      await tick();
    }
    expect(replica.state.count).toBe(0);
    pair.b.thaw();
    expect(replica.state.count).toBe(20);
    expect(replica.version).toBe(publisher.version);
  });

  it('oversized batches are sent as snapshots', async () => {
    const { source, publisher } = makeOwner({ maxBatchPatches: 1 });
    const { owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(TodoReplica);
    await replica.attach(replicaLink);
    const events: string[] = [];
    replica.subscribe((e) => events.push(e.type));
    addTodo(source, 'big');
    await tick();
    expect(events).toEqual(['snapshot']);
    expect(replica.state.count).toBe(1);
  });

  it('whenLive resolves on sync, aborts with the signal; scopes detach', async () => {
    const { publisher } = makeOwner();
    const { owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(TodoReplica);
    const controller = new AbortController();
    const aborted = replica.whenLive(controller.signal);
    controller.abort();
    expect((await aborted).ok).toBe(false);
    const live = replica.whenLive();
    await replica.attach(replicaLink);
    expect((await live).ok).toBe(true);
    expect((await replica.whenLive()).ok).toBe(true);
    publisher.dispose();
    expect(publisher.peers).toBe(0);
  });

  it('handshake fails without an owner (SF-WK-008) and with a closed link (SF-WK-009)', async () => {
    const { replicaLink, owner } = connect();
    const replica = createReplica(TodoReplica);
    const noOwner = await replica.attach(replicaLink);
    expect(!noOwner.ok && noOwner.error.code).toBe('SF-WK-008');
    owner.close();
    const closed = await replica.resync();
    expect(!closed.ok && closed.error.code).toBe('SF-WK-009');
  });

  it('owner rejects unknown replication requests', async () => {
    const { publisher } = makeOwner();
    const { owner, replicaLink } = connect();
    publisher.attach(owner);
    const result = await replicaLink.request(TodoReplica.channel, { type: 'bogus' });
    expect(!result.ok && result.error.code).toBe('SF-WK-001');
    const listener = vi.fn();
    const off = createJsonSource({}).onPatches(listener);
    off();
  });
});

describe('patch shape compatibility', () => {
  it('a custom ReplicableSource can plug in', async () => {
    const listeners = new Set<(p: readonly Patch[]) => void>();
    let value = 0;
    const definition = defineReplica('test/counter').type<{ value: number }, { inc: { args: number; result: number } }>();
    const publisher = createPublisher({
      definition,
      source: {
        getSnapshot: () => ({ value }),
        onPatches: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        applyIntent: (_action, args) => {
          value += args as number;
          for (const l of listeners) l([{ op: 'replace', path: ['value'], value }]);
          return ok(value);
        },
      },
    });
    const { owner, replicaLink } = connect();
    publisher.attach(owner);
    const replica = createReplica(definition);
    await replica.attach(replicaLink);
    expect(await replica.intent('inc', 5)).toEqual(ok(5));
    expect(replica.state.value).toBe(5);
  });
});
