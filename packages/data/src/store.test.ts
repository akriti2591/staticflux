import { effect, watch } from '@staticflux/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createEpochSource } from './epoch.js';
import { applyPatchOps, type PatchOp, produceWithPatches } from './patches.js';
import { type Infer, s } from './schema.js';
import { defineStore, type PatchMessage, type StoreIntent } from './store.js';

const Message = s.object({ id: s.string(), text: s.string(), pinned: s.optional(s.boolean()) });
type Message = Infer<typeof Message>;
const ChatSchema = s.object({
  messages: s.array(Message),
  draft: s.string(),
  meta: s.record(s.number()),
});

const ChatStore = defineStore({
  id: 'test/chat',
  version: 1,
  schema: ChatSchema,
  initial: () => ({ messages: [], draft: '', meta: {} }),
  actions: {
    append(state, message: Message) {
      state.messages.push(message);
    },
    setDraft(state, text: string) {
      state.draft = text;
    },
    send(state, id: string) {
      state.messages.push({ id, text: state.draft });
      state.draft = '';
      return state.messages.length;
    },
    sendTwice(state, id: string) {
      ChatOwnerRef.current?.actions.send(`${id}-a`);
      state.draft = 'second';
      ChatOwnerRef.current?.actions.send(`${id}-b`);
    },
    pin(state, id: string) {
      const message = state.messages.find((m) => m.id === id);
      if (message === undefined) throw new Error('missing');
      message.pinned = true;
    },
    removeFirst(state) {
      state.messages.splice(0, 1);
    },
    sortDesc(state) {
      state.messages.sort((a, b) => b.id.localeCompare(a.id));
    },
    count(state, key: string) {
      state.meta[key] = (state.meta[key] ?? 0) + 1;
    },
    clearMeta(state, key: string) {
      delete state.meta[key];
    },
    bad(state) {
      (state as unknown as { draft: number }).draft = 5;
    },
    notPlain(state) {
      (state as unknown as { draft: unknown }).draft = new Map();
    },
    asyncAction() {
      return Promise.resolve();
    },
  },
});
const ChatOwnerRef: { current: ReturnType<typeof ChatStore.create> | undefined } = { current: undefined };

describe('patch engine', () => {
  it('records ops with copy-on-write structural sharing and frozen output', () => {
    const base = Object.freeze({ a: Object.freeze({ x: 1 }), b: Object.freeze({ y: Object.freeze([1, 2]) }) });
    const result = produceWithPatches(base, (draft) => {
      draft.b.y.push(3);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ a: { x: 1 }, b: { y: [1, 2, 3] } });
    expect(result.value.state.a).toBe(base.a); // untouched branch shared
    expect(base.b.y).toEqual([1, 2]); // original untouched
    expect(Object.isFrozen(result.value.state.b.y)).toBe(true);
    expect(result.value.patches).toEqual([{ op: 'add', path: ['b', 'y', 2], value: 3 }]);
  });

  it('round-trips: applying recorded patches reproduces the state', () => {
    const base = { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], map: { k: 1 } as Record<string, number> };
    const recorded = produceWithPatches(base, (d) => {
      d.list.splice(1, 1, { id: 'x' }, { id: 'y' });
      d.list.unshift({ id: 'first' });
      d.list.shift();
      d.list.pop();
      d.list.reverse();
      d.map.n = 2;
      delete d.map.k;
      d.list.length = 1;
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const replayed = applyPatchOps(base, recorded.value.patches);
    expect(replayed).toEqual({ ok: true, value: recorded.value.state });
    expect(recorded.value.state).toEqual({ list: [{ id: 'y' }], map: { n: 2 } });
  });

  it('rejects invalid ops and non-plain values; drafts are revoked after the recipe', () => {
    expect(applyPatchOps({ a: [] }, [{ op: 'remove', path: ['a', 0] }]).ok).toBe(false);
    expect(applyPatchOps({ a: 1 }, [{ op: 'add', path: [], value: 1 }]).ok).toBe(false);
    const nonPlain = produceWithPatches({ a: 1 as unknown }, (d) => {
      d.a = () => 1;
    });
    expect(!nonPlain.ok && nonPlain.error.code).toBe('SF-DATA-031');
    let leaked: { a: number } | undefined;
    produceWithPatches({ a: { b: 1 } }, (d) => {
      leaked = d.a as unknown as { a: number };
    });
    expect(() => leaked?.a).toThrow(/after its action/);
  });

  it('validates ops against the schema (paths, values, removability)', () => {
    const schema = s.object({ n: s.number(), o: s.optional(s.string()) });
    expect(applyPatchOps({ n: 1 }, [{ op: 'replace', path: ['n'], value: 'x' }], schema).ok).toBe(false);
    expect(applyPatchOps({ n: 1 }, [{ op: 'add', path: ['zz'], value: 1 }], schema).ok).toBe(false);
    expect(applyPatchOps({ n: 1 }, [{ op: 'remove', path: ['n'] }], schema).ok).toBe(false);
    expect(applyPatchOps({ n: 1, o: 'a' }, [{ op: 'remove', path: ['o'] }], schema)).toEqual({ ok: true, value: { n: 1 } });
  });

  it('supports reads through drafts (spread, keys, JSON, iteration)', () => {
    const r = produceWithPatches({ items: [{ id: 1 }, { id: 2 }] }, (d) => {
      const ids = [...d.items].map((i) => i.id);
      return { ids, keys: Object.keys(d), json: JSON.stringify(d), isArray: Array.isArray(d.items), has: 'items' in d };
    });
    expect(r.ok && r.value.result).toEqual({ ids: [1, 2], keys: ['items'], json: '{"items":[{"id":1},{"id":2}]}', isArray: true, has: true });
    expect(r.ok && r.value.patches).toEqual([]);
  });
});

describe('defineStore: owner', () => {
  it('runs typed actions, flushes one versioned message per outermost action', () => {
    const epoch = createEpochSource(3);
    const store = ChatStore.create({ epoch, traceparent: () => '00-aaaa-bbbb-01' });
    const messages: PatchMessage[] = [];
    store.onPatches((m) => messages.push(m));
    store.actions.setDraft('hello');
    const sent = store.actions.send('m1');
    expectTypeOf(sent).toMatchTypeOf<{ ok: true; value: number } | { ok: false }>();
    expect(sent).toEqual({ ok: true, value: 1 });
    expect(store.state.messages).toEqual([{ id: 'm1', text: 'hello' }]);
    expect(store.version).toBe(2);
    expect(messages.map((m) => [m.version, m.action, m.epoch, m.traceparent])).toEqual([
      [1, 'setDraft', 3, '00-aaaa-bbbb-01'],
      [2, 'send', 3, '00-aaaa-bbbb-01'],
    ]);
    expect(messages[1]?.patches).toEqual([
      { op: 'add', path: ['messages', 0], value: { id: 'm1', text: 'hello' } },
      { op: 'replace', path: ['draft'], value: '' },
    ]);
    expect(Object.isFrozen(store.state)).toBe(true);
  });

  it('nested actions share the outermost transaction (one flush)', () => {
    const store = ChatStore.create();
    ChatOwnerRef.current = store;
    const listener = vi.fn();
    store.onPatches(listener);
    store.actions.setDraft('first');
    listener.mockClear();
    expect(store.actions.sendTwice('n').ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.state.messages.map((m) => m.text)).toEqual(['first', 'second']);
    ChatOwnerRef.current = undefined;
  });

  it('rolls back failed actions (throw, schema violation, non-plain, async) with no message', () => {
    const store = ChatStore.create();
    store.actions.append({ id: 'a', text: 'x' });
    const before = store.state;
    const listener = vi.fn();
    store.onPatches(listener);
    expect(store.actions.pin('missing')).toMatchObject({ ok: false, error: { code: 'SF-DATA-044' } });
    expect(store.actions.bad()).toMatchObject({ ok: false, error: { code: 'SF-DATA-030' } });
    expect(store.actions.notPlain()).toMatchObject({ ok: false, error: { code: 'SF-DATA-031' } });
    expect(store.actions.asyncAction()).toMatchObject({ ok: false, error: { code: 'SF-DATA-044' } });
    expect(store.state).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('records element mutation, splice, sort, record keys', () => {
    const store = ChatStore.create();
    store.actions.append({ id: 'a', text: '1' });
    store.actions.append({ id: 'b', text: '2' });
    store.actions.pin('b');
    expect(store.state.messages[1]).toEqual({ id: 'b', text: '2', pinned: true });
    store.actions.sortDesc();
    expect(store.state.messages.map((m) => m.id)).toEqual(['b', 'a']);
    store.actions.removeFirst();
    store.actions.count('views');
    store.actions.count('views');
    expect(store.state.meta).toEqual({ views: 2 });
    store.actions.clearMeta('views');
    expect(store.state.meta).toEqual({});
  });

  it('state and select() are reactive; unrelated changes do not recompute selections', () => {
    const store = ChatStore.create();
    const count = store.select((st) => st.messages.length);
    const seen: number[] = [];
    const stop = watch(
      () => count.get(),
      (n) => seen.push(n),
    );
    const draftRuns = vi.fn();
    const stopEffect = effect(() => {
      draftRuns(store.select((st) => st.messages).get());
    });
    store.actions.append({ id: 'a', text: '' });
    store.actions.setDraft('typing');
    store.actions.append({ id: 'b', text: '' });
    expect(seen).toEqual([1, 2]);
    stop();
    stopEffect();
  });

  it('dispatch runs intents and rejects unknown actions', () => {
    const store = ChatStore.create();
    const intent: StoreIntent = { format: 1, storeId: 'test/chat', action: 'setDraft', args: ['hi'], baseVersion: 0 };
    expect(store.dispatch(intent).ok).toBe(true);
    expect(store.state.draft).toBe('hi');
    expect(store.dispatch({ ...intent, action: 'toString' })).toMatchObject({ ok: false, error: { code: 'SF-DATA-040' } });
    expect(store.dispatch({ ...intent, storeId: 'test/other' })).toMatchObject({ ok: false, error: { code: 'SF-DATA-043' } });
  });

  it('getSnapshot / applySnapshot / applyPatches / patchesSince', () => {
    const store = ChatStore.create({ historyLimit: 2 });
    store.actions.setDraft('a');
    store.actions.setDraft('b');
    store.actions.setDraft('c');
    expect(store.getSnapshot()).toMatchObject({ format: 1, storeId: 'test/chat', schemaVersion: 1, version: 3, state: { draft: 'c' } });
    expect(store.patchesSince(3)).toEqual({ ok: true, value: [] });
    expect(store.patchesSince(1).ok && store.patchesSince(1)).toMatchObject({ ok: true, value: [{ version: 2 }, { version: 3 }] });
    expect(store.patchesSince(0)).toMatchObject({ ok: false, error: { code: 'SF-DATA-047' } });
    expect(store.patchesSince(9)).toMatchObject({ ok: false, error: { code: 'SF-DATA-041' } });

    expect(store.applySnapshot({ state: { messages: [], draft: 'restored', meta: {} } }).ok).toBe(true);
    expect(store.state.draft).toBe('restored');
    expect(store.applySnapshot({ state: { messages: 'nope' } as never }).ok).toBe(false);
    const ops: PatchOp[] = [{ op: 'replace', path: ['draft'], value: 'patched' }];
    expect(store.applyPatches(ops).ok).toBe(true);
    expect(store.state.draft).toBe('patched');
    expect(store.applyPatches([{ op: 'replace', path: ['draft'], value: 1 }]).ok).toBe(false);
  });

  it('rejects an invalid initial state as a programmer error', () => {
    const Bad = defineStore({ id: 'test/bad', version: 1, schema: s.object({ n: s.number() }), initial: () => ({ n: 'x' as unknown as number }), actions: {} });
    expect(() => Bad.create()).toThrow();
  });
});

describe('defineStore: replica (I-9)', () => {
  it('follows the owner via snapshot + patches; writes become intents', () => {
    const owner = ChatStore.create();
    const intents: StoreIntent[] = [];
    const replica = ChatStore.replica({ sink: (i) => intents.push(i) });
    owner.onPatches((m) => {
      const applied = replica.applyPatches(structuredClone(m));
      expect(applied.ok).toBe(true);
    });
    expect(replica.synced).toBe(false);
    expect(replica.applySnapshot(structuredClone(owner.getSnapshot())).ok).toBe(true);
    expect(replica.synced).toBe(true);
    owner.actions.append({ id: 'a', text: 'hi' });
    expect(replica.state).toEqual(owner.state);
    expect(replica.version).toBe(1);

    expect(replica.actions.setDraft('from replica')).toEqual({ ok: true, value: undefined });
    expect(replica.state.draft).toBe(''); // never mutates locally
    expect(intents).toEqual([{ format: 1, storeId: 'test/chat', action: 'setDraft', args: ['from replica'], baseVersion: 1 }]);
    for (const intent of intents) owner.dispatch(intent);
    expect(replica.state.draft).toBe('from replica');
    expect(Object.isFrozen(replica.state)).toBe(true);
  });

  it('detects gaps, duplicates and epoch mismatch; resnapshot recovers', () => {
    const epoch = createEpochSource(0);
    const owner = ChatStore.create({ epoch });
    const replica = ChatStore.replica();
    const messages: PatchMessage[] = [];
    owner.onPatches((m) => messages.push(m));
    expect(replica.applyPatches({ format: 1, storeId: 'test/chat', schemaVersion: 1, epoch: 0, version: 1, action: 'x', patches: [] })).toMatchObject({ ok: false, error: { code: 'SF-DATA-041' } });
    replica.applySnapshot(owner.getSnapshot());
    owner.actions.setDraft('1');
    owner.actions.setDraft('2');
    expect(replica.applyPatches(messages[1] as PatchMessage)).toMatchObject({ ok: false, error: { code: 'SF-DATA-041' } });
    expect(replica.applyPatches(messages[0] as PatchMessage).ok).toBe(true);
    expect(replica.applyPatches(messages[0] as PatchMessage).ok).toBe(true); // duplicate ignored
    expect(replica.applyPatches(messages[1] as PatchMessage).ok).toBe(true);
    epoch.bump();
    owner.actions.setDraft('3');
    expect(replica.applyPatches(messages[2] as PatchMessage)).toMatchObject({ ok: false, error: { code: 'SF-DATA-042' } });
    expect(replica.applySnapshot(owner.getSnapshot()).ok).toBe(true);
    expect(replica.state.draft).toBe('3');
    expect(replica.epoch).toBe(1);
    expect(replica.applySnapshot({ ...owner.getSnapshot(), schemaVersion: 2 })).toMatchObject({ ok: false, error: { code: 'SF-DATA-043' } });
  });

  it('without a sink, replica writes fail with SF-WK-002', () => {
    const replica = ChatStore.replica();
    expect(replica.actions.setDraft('x')).toMatchObject({ ok: false, error: { code: 'SF-WK-002' } });
    expect(() => {
      (replica.state as { draft: string }).draft = 'mutated';
    }).toThrow();
  });
});
