import { createInjector, token } from '@staticflux/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { byteSize, clonePlain, deepFreeze, stableStringify, tryClonePlain } from './clone.js';
import { createDataClient } from './client.js';
import { createEpochSource } from './epoch.js';
import { createMockTransport } from './mock-transport.js';
import { createPauseControl } from './pause.js';
import { defineResource } from './resource-defs.js';
import { type Infer, isRemovable, s, schemaAt } from './schema.js';
import { defineSlice } from './slices.js';
import { defineStore, type OwnerStore } from './store.js';
import { defineEndpoint } from './transport.js';
import type { UserDataOptions } from './user-data.js';
import {
  DataClientToken,
  dataClientUnit,
  dataClientUnitWith,
  EpochSourceToken,
  epochSourceUnit,
  mockTransportUnit,
  PauseControlToken,
  pauseControlUnit,
  ResourcesToken,
  resourcesUnit,
  storeUnit,
  UserDataConfigToken,
  UserDataToken,
  userDataUnit,
} from './units.js';
import { unit } from '@staticflux/core';

describe('schema', () => {
  const Doc = s.object({
    id: s.string(),
    n: s.number(),
    flag: s.boolean(),
    kind: s.enum(['a', 'b']),
    lit: s.literal(3),
    tags: s.array(s.string()),
    meta: s.record(s.union(s.string(), s.null())),
    opt: s.optional(s.string()),
    nul: s.nullable(s.number()),
    any: s.unknown(),
  });
  type Doc = Infer<typeof Doc>;
  const valid: Doc = { id: 'x', n: 1, flag: true, kind: 'a', lit: 3, tags: ['t'], meta: { a: null, b: 's' }, nul: null, any: { deep: 1 } };

  it('infers types (optional keys are optional)', () => {
    expectTypeOf<Doc['opt']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Doc['kind']>().toEqualTypeOf<'a' | 'b'>();
    expectTypeOf<Doc['nul']>().toEqualTypeOf<number | null>();
  });

  it('validates and reports paths', () => {
    expect(Doc.validate(valid)).toEqual({ ok: true, value: valid });
    const bad = Doc.validate({ ...valid, tags: ['ok', 2] });
    expect(bad).toMatchObject({ ok: false, error: { code: 'SF-DATA-030', details: { path: ['tags', 1], expected: 'string' } } });
    expect(Doc.validate({ ...valid, extra: 1 }).ok).toBe(false);
    expect(Doc.validate({ ...valid, n: Number.NaN }).ok).toBe(false);
    expect(Doc.validate({ ...valid, kind: 'c' }).ok).toBe(false);
    expect(Doc.validate({ ...valid, lit: 4 }).ok).toBe(false);
    expect(Doc.validate({ ...valid, meta: { a: 1 } }).ok).toBe(false);
    expect(Doc.validate(new (class X {})()).ok).toBe(false);
    expect(Doc.validate([]).ok).toBe(false);
  });

  it('schemaAt / isRemovable walk the schema', () => {
    expect(schemaAt(Doc, ['tags', 0])?.kind).toBe('string');
    expect(schemaAt(Doc, ['meta', 'k'])?.kind).toBe('union');
    expect(schemaAt(Doc, ['any', 'x', 'y'])?.kind).toBe('unknown');
    expect(schemaAt(Doc, ['nope'])).toBeUndefined();
    expect(schemaAt(Doc, ['id', 'x'])).toBeUndefined();
    expect(isRemovable(Doc, 'opt')).toBe(true);
    expect(isRemovable(Doc, 'id')).toBe(false);
    expect(isRemovable(schemaAt(Doc, ['meta']), 'a')).toBe(true);
    expect(isRemovable(s.string(), 'x')).toBe(false);
  });
});

describe('clone helpers', () => {
  it('clones plain data and rejects everything else', () => {
    const value = { a: [1, { b: 'c' }], d: null, e: undefined };
    const copy = clonePlain(value);
    expect(copy).toEqual(value);
    expect(copy.a).not.toBe(value.a);
    for (const bad of [new Date(), new Map(), () => 1, Symbol('x'), 1n, Number.POSITIVE_INFINITY]) {
      expect(tryClonePlain({ bad }).ok).toBe(false);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(tryClonePlain(cyclic)).toMatchObject({ ok: false, error: { code: 'SF-DATA-031', details: { reason: 'cycle' } } });
    expect(clonePlain(Object.create(null) as object)).toEqual({});
  });

  it('deepFreeze, stableStringify, byteSize', () => {
    const frozen = deepFreeze({ a: { b: [1] } });
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
    expect(stableStringify({ b: 1, a: [true, { d: undefined, c: null }] })).toBe('{"a":[true,{"c":null}],"b":1}');
    expect(stableStringify(undefined)).toBe('null');
    expect(byteSize('é')).toBe(4); // "é" + quotes in UTF-8
  });
});

describe('pause control', () => {
  it('queues waiters and wakes them on resume', async () => {
    const pause = createPauseControl();
    expect((await pause.whenResumed(new AbortController().signal)).ok).toBe(true);
    pause.pause();
    expect(pause.paused).toBe(true);
    const waiting = pause.whenResumed(new AbortController().signal);
    expect(pause.queued).toBe(1);
    pause.resume();
    expect((await waiting).ok).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    pause.pause();
    expect((await pause.whenResumed(aborted.signal)).ok).toBe(false);
  });

  it('paused rejections never trip the circuit breaker', async () => {
    const Save = defineEndpoint<void, unknown>({ id: 'x/save', method: 'POST', path: () => '/', breaker: { failureThreshold: 1, resetAfterMs: 1000 } });
    const pause = createPauseControl();
    const client = createDataClient({ transport: createMockTransport().route(Save, () => 1), pause });
    pause.pause();
    await client.call(Save, undefined);
    await client.call(Save, undefined);
    expect(client.breakerState(Save)).toBe('closed');
    pause.resume();
    expect((await client.call(Save, undefined)).ok).toBe(true);
  });
});

describe('DI units', () => {
  const DocGet = defineEndpoint<{ id: string }, { id: string; title: string }>({ id: 'docs/get', path: (i) => `/docs/${i.id}` });
  const DocResource = defineResource({ id: 'docs/doc', endpoint: DocGet, key: (i) => [i.id] });
  const Counter = defineStore({
    id: 'test/counter',
    version: 1,
    schema: s.object({ n: s.number() }),
    initial: () => ({ n: 0 }),
    actions: {
      inc(state) {
        state.n += 1;
      },
    },
  });
  const CounterToken = token('test/counter-store').type<OwnerStore<{ n: number }, typeof Counter.actions>>();
  const Theme = defineSlice({ key: 'settings/theme', scope: 'device', version: 1, schema: s.string(), default: () => 'system' });

  const userDataConfigUnit = unit({
    id: 'test/user-data-config',
    provides: UserDataConfigToken,
    scope: 'app',
    create: (): Omit<UserDataOptions, 'telemetry'> => ({ identity: { userId: 'u', deviceId: 'd' } }),
  });

  it('wires transport → client → resources, stores and user data through the injector', async () => {
    const injector = createInjector({
      units: [
        mockTransportUnit((mock) => mock.route(DocGet, ({ id }) => ({ id, title: `Doc ${id}` }))),
        epochSourceUnit,
        pauseControlUnit,
        dataClientUnit,
        storeUnit({ id: 'test/counter-unit', store: Counter, provides: CounterToken, scope: 'app' }),
        userDataConfigUnit,
        userDataUnit,
      ],
    });
    const session = injector.child('session', 'session', [resourcesUnit]);
    const resources = await session.get(ResourcesToken);
    if (!resources.ok) throw resources.error;
    expect((await resources.value.fetch(DocResource, { id: '1' })).ok).toBe(true);

    const client = await injector.get(DataClientToken);
    const pause = await injector.get(PauseControlToken);
    expect(client.ok && pause.ok && client.value.pause === pause.value).toBe(true);

    const epoch = await injector.get(EpochSourceToken);
    const store = await injector.get(CounterToken);
    if (!store.ok || !epoch.ok) throw new Error('missing');
    store.value.actions.inc();
    expect(store.value.state.n).toBe(1);
    expect(store.value.epoch).toBe(epoch.value.current);

    const userData = await injector.get(UserDataToken);
    if (!userData.ok) throw userData.error;
    const theme = userData.value.slice(Theme);
    expect(await theme.whenReady()).toEqual({ ok: true, value: 'system' });

    await session.dispose();
    await injector.dispose();
  });

  it('dataClientUnitWith passes defaults and slot bindings', async () => {
    const injector = createInjector({
      units: [mockTransportUnit(() => undefined), epochSourceUnit, pauseControlUnit, dataClientUnitWith({ defaultRetry: false })],
    });
    const client = await injector.get(DataClientToken);
    expect(client.ok).toBe(true);
    expect(createEpochSource(4).current).toBe(4);
    await injector.dispose();
  });
});
