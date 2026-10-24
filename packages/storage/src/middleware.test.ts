import { createMemorySink, createTelemetry, ok, unwrap } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  binaryCodec,
  bytesToBase64,
  createMemoryStore,
  createMockRemoteTransport,
  createRemoteStore,
  encrypted,
  envelopeCodec,
  generateStoreKey,
  isEncryptedRecord,
  jsonCodec,
  namespaced,
  StorageMetrics,
  tiered,
  withBudget,
  withCodec,
  withTelemetry,
  withTtl,
  type EncryptedRecord,
  type StoredEnvelope,
  type IntervalTimers,
  type KeyProvider,
  type StoreChange,
  type TtlRecord,
} from './index.js';

const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('namespaced', () => {
  it('prefixes keys and isolates seek/clear/watch', async () => {
    const base = createMemoryStore();
    const a = namespaced<unknown>('a:')(base);
    const b = namespaced<unknown>('b:')(base);
    await a.set('k', 1);
    await b.set('k', 2);
    expect(unwrap(await base.seek().keys())).toEqual(['a:k', 'b:k']);
    expect(unwrap(await a.seek().toArray())).toEqual([['k', 1]]);
    const seen: StoreChange<unknown>[] = [];
    a.watch((c) => seen.push(c));
    await b.set('x', 3);
    await a.set('y', 4);
    await a.clear();
    expect(unwrap(await base.seek().keys())).toEqual(['b:k', 'b:x']);
    expect(seen.map((c) => (c.type === 'clear' ? 'clear' : `${c.type}:${c.key}`))).toEqual(['set:y', 'delete:k', 'delete:y']);
    expect(a.id).toBe('ns[a:](memory)');
  });
  it('translates ranges inside the namespace', async () => {
    const a = namespaced<unknown>('n:')(createMemoryStore());
    for (const k of ['1', '2', '3']) await a.set(k, k);
    expect(unwrap(await a.seek({ gte: '2' }).keys())).toEqual(['2', '3']);
    expect(unwrap(await a.seek({ lt: '2' }).keys())).toEqual(['1']);
  });
});

describe('withTtl', () => {
  it('expires lazily, purges in bulk and applies defaultTtlMs', async () => {
    let now = 0;
    const inner = createMemoryStore<TtlRecord<unknown>>();
    const store = withTtl<unknown>({ now: () => now, defaultTtlMs: 100 })(inner);
    await store.set('short', 1);
    await store.set('long', 2, { ttlMs: 1000 });
    expect(unwrap(await inner.get('short'))).toEqual({ v: 1, e: 100 });
    now = 150;
    expect(unwrap(await store.has('short'))).toBe(false);
    expect(unwrap(await inner.get('short'))).toBeUndefined(); // lazily deleted
    await store.set('also-short', 3);
    now = 400;
    expect(unwrap(await store.purgeExpired())).toBe(1);
    expect(unwrap(await inner.seek().keys())).toEqual(['long']);
    expect(store.capabilities.ttl).toBe(true);
  });
  it('treats non-TTL records as corrupt', async () => {
    const inner = createMemoryStore<TtlRecord<unknown>>({ initial: { raw: 'plain' } });
    const store = withTtl<unknown>()(inner);
    const result = await store.get('raw');
    expect(!result.ok && result.error.code).toBe('SF-STORE-003');
  });
  it('unwraps values in change events', async () => {
    const store = withTtl<unknown>()(createMemoryStore<TtlRecord<unknown>>());
    const seen: StoreChange<unknown>[] = [];
    store.watch((c) => seen.push(c));
    await store.set('k', 'v');
    expect(seen).toEqual([{ type: 'set', key: 'k', value: 'v', origin: 'local' }]);
  });
});

describe('codecs', () => {
  it('json codec reports corrupt text and unserializable values', async () => {
    const strings = createMemoryStore<string>({ initial: { bad: '{nope' } });
    const store = withCodec(jsonCodec<unknown>())(strings);
    const bad = await store.get('bad');
    expect(!bad.ok && bad.error.code).toBe('SF-STORE-003');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const cyc = await store.set('c', cyclic);
    expect(!cyc.ok && cyc.error.code).toBe('SF-STORE-006');
    await store.set('ok', { a: 1 });
    expect(unwrap(await strings.get('ok'))).toBe('{"a":1}');
    expect(store.id).toBe('json(memory)');
  });

  it('envelope codec writes the handoff SnapshotEnvelope format', async () => {
    const raw = createMemoryStore<StoredEnvelope>();
    const store = withCodec(envelopeCodec<{ n: number }>({ version: 2, now: () => 5000, ttlMs: 100, keyOf: (k) => `studio/${k}` }))(raw);
    await store.set('draft', { n: 1 });
    expect(unwrap(await raw.get('draft'))).toEqual({ v: 1, key: 'studio/draft', version: 2, createdAt: 5000, expiresAt: 5100, data: { n: 1 } });
  });

  it('envelope codec migrates, validates and rejects mismatches', () => {
    const codec = envelopeCodec<{ count: number }>({
      version: 3,
      migrations: { 1: (d) => ({ total: (d as { n: number }).n }), 2: (d) => ({ count: (d as { total: number }).total }) },
      validate: (d): d is { count: number } => typeof (d as { count?: unknown }).count === 'number',
      now: () => 1000,
    });
    const env = (over: Record<string, unknown>) => ({ v: 1, key: 'k', version: 1, createdAt: 0, data: { n: 7 }, ...over });
    expect(codec.decode(env({}) as never, 'k')).toEqual(ok({ count: 7 }));
    const codes = [
      codec.decode({ nope: true } as never, 'k'),
      codec.decode(env({ key: 'other' }) as never, 'k'),
      codec.decode(env({ version: 4 }) as never, 'k'),
      codec.decode(env({ expiresAt: 999 }) as never, 'k'),
      codec.decode(env({ version: 3, data: { count: 'x' } }) as never, 'k'),
      envelopeCodec({ version: 2 }).decode(env({}) as never, 'k'),
      envelopeCodec({ version: 2, migrations: { 1: () => { throw new Error('x'); } } }).decode(env({}) as never, 'k'),
    ].map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes).toEqual(Array(7).fill('SF-STORE-003'));
  });

  it('binary codec round-trips bytes through string backends', async () => {
    const store = withCodec(binaryCodec())(createMemoryStore<string>());
    const bytes = new Uint8Array([0, 1, 254, 255, 128]);
    await store.set('blob', bytes);
    expect(unwrap(await store.get('blob'))).toEqual(bytes);
    await store.set('buf', bytes.buffer);
    expect(unwrap(await store.get('buf'))).toEqual(bytes);
    expect((await store.set('bad', 'text' as never)).ok).toBe(false);
    expect(base64ToBytes(bytesToBase64(new Uint8Array(70_000).fill(7))).length).toBe(70_000);
  });
});

describe('encrypted', () => {
  const keyPair = async () => unwrap(await generateStoreKey());

  it('stores ciphertext only and decrypts on read', async () => {
    const inner = createMemoryStore<EncryptedRecord>();
    const store = encrypted<{ secret: string }>({ current: async () => ok({ id: 'k1', key: await keyPair() }) })(inner);
    const provider = { id: 'k1', key: await keyPair() };
    const fixed = encrypted<{ secret: string }>({ current: async () => ok(provider) })(inner);
    await fixed.set('note', { secret: 'hunter2' });
    const record = unwrap(await inner.get('note'));
    expect(isEncryptedRecord(record)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('hunter2');
    expect(unwrap(await fixed.get('note'))).toEqual({ secret: 'hunter2' });
    expect(unwrap(await fixed.seek().toArray())).toEqual([['note', { secret: 'hunter2' }]]);
    // a store with a different key cannot read it
    const wrong = await store.get('note');
    expect(!wrong.ok && wrong.error.code).toBe('SF-STORE-003');
  });

  it('binds ciphertext to its key (swapping records fails)', async () => {
    const inner = createMemoryStore<EncryptedRecord>();
    const key = await keyPair();
    const store = encrypted<string>({ current: async () => ok({ id: 'k', key }) })(inner);
    await store.set('a', 'alpha');
    await inner.set('b', unwrap(await inner.get('a')) as EncryptedRecord);
    const swapped = await store.get('b');
    expect(!swapped.ok && swapped.error.code).toBe('SF-STORE-003');
  });

  it('reads records written with a rotated key via get(kid)', async () => {
    const inner = createMemoryStore<EncryptedRecord>();
    const old = { id: 'old', key: await keyPair() };
    const next = { id: 'new', key: await keyPair() };
    await encrypted<string>({ current: async () => ok(old) })(inner).set('k', 'v1');
    const rotated: KeyProvider = { current: async () => ok(next), get: async (id) => ok(id === 'old' ? old : undefined) };
    const store = encrypted<string>(rotated)(inner);
    expect(unwrap(await store.get('k'))).toBe('v1');
    await store.set('k', 'v2');
    expect((unwrap(await inner.get('k')) as EncryptedRecord).kid).toBe('new');
    const noRotation = encrypted<string>({ current: async () => ok(old) })(inner);
    const missing = await noRotation.get('k');
    expect(!missing.ok && missing.error.code).toBe('SF-STORE-003');
  });

  it('is unavailable without WebCrypto and never leaks plaintext in events', async () => {
    const inner = createMemoryStore<EncryptedRecord>();
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    try {
      const noCrypto = encrypted<string>({ current: async () => ok({ id: 'k', key: {} as CryptoKey }) })(createMemoryStore<EncryptedRecord>());
      const result = await noCrypto.set('k', 'v');
      expect(!result.ok && result.error.code).toBe('SF-STORE-002');
    } finally {
      vi.stubGlobal('crypto', original);
    }
    const key = await keyPair();
    const store = encrypted<string>({ current: async () => ok({ id: 'k', key }) })(inner);
    const seen: StoreChange<string>[] = [];
    store.watch((c) => seen.push(c));
    await store.set('k', 'plain');
    await tick();
    expect(seen).toEqual([{ type: 'set', key: 'k', origin: 'local' }]);
    const failing = encrypted<string>({ current: async () => ok({ id: 'k', key }) }, {
      subtle: { encrypt: () => Promise.reject(new Error('nope')), decrypt: () => Promise.reject(new Error('nope')) },
    })(createMemoryStore<EncryptedRecord>());
    const result = await failing.set('k', 'v');
    expect(!result.ok && result.error.code).toBe('SF-STORE-008');
  });

  it('generateStoreKey reports missing WebCrypto', async () => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    try {
      const result = await generateStoreKey();
      expect(!result.ok && result.error.code).toBe('SF-STORE-002');
    } finally {
      vi.stubGlobal('crypto', original);
    }
  });
});

describe('withBudget', () => {
  it('rejects writes over maxBytes / maxEntries and tracks usage', async () => {
    const store = withBudget<string>({ maxBytes: 50, maxEntries: 2 })(createMemoryStore<string>());
    expect((await store.set('a', 'x'.repeat(10))).ok).toBe(true);
    const tooBig = await store.set('b', 'x'.repeat(60));
    expect(!tooBig.ok && tooBig.error.code).toBe('SF-STORE-001');
    expect((await store.set('b', 'y')).ok).toBe(true);
    const tooMany = await store.set('c', 'z');
    expect(!tooMany.ok && tooMany.error.code).toBe('SF-STORE-001');
    expect(unwrap(await store.usage())).toEqual({ bytes: 1 + 10 + 1 + 1, entries: 2 });
    await store.delete('a');
    expect(unwrap(await store.usage()).entries).toBe(1);
    expect((await store.set('c', 'z')).ok).toBe(true);
  });
  it('projects batches and allows shrinking writes', async () => {
    const store = withBudget<string>({ maxBytes: 30 })(createMemoryStore<string>());
    await store.set('a', 'x'.repeat(20));
    const batch = await store.batch([{ type: 'delete', key: 'a' }, { type: 'set', key: 'b', value: 'y'.repeat(20) }]);
    expect(batch.ok).toBe(true);
    const over = await store.batch([{ type: 'set', key: 'c', value: 'z'.repeat(20) }]);
    expect(!over.ok && over.error.code).toBe('SF-STORE-001');
  });
  it('rescans after external changes', async () => {
    const transport = createMockRemoteTransport<string>();
    const store = withBudget<string>({ maxEntries: 1 })(createRemoteStore(transport));
    await store.set('a', '1');
    transport.serverDelete('a');
    expect((await store.set('b', '2')).ok).toBe(true);
  });
});

describe('withTelemetry', () => {
  it('records spans and metrics per operation', async () => {
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    const sink = createMemorySink();
    telemetry.addSink(sink);
    const store = withTelemetry<unknown>(telemetry, 'test/storage')(createMemoryStore());
    await store.set('k', 1);
    await store.get('k');
    await store.get('');
    await store.seek().toArray();
    const spans = sink.records.filter((r) => r.type === 'span');
    expect(spans.map((s) => (s.type === 'span' ? `${s.name}:${s.status}` : ''))).toEqual(['storage.set:ok', 'storage.get:ok', 'storage.get:error', 'storage.seek:ok']);
    const metrics = sink.records.filter((r) => r.type === 'metric');
    expect(metrics.some((m) => m.type === 'metric' && m.metric === StorageMetrics.failures.id && m.attrs['code'] === 'SF-STORE-006')).toBe(true);
    expect(metrics.some((m) => m.type === 'metric' && m.metric === StorageMetrics.seekEntries.id && m.value === 1)).toBe(true);
  });
});

describe('tiered', () => {
  const manualTimers = (): IntervalTimers & { fire(): void; active: boolean } => {
    let fn: (() => void) | undefined;
    return {
      get active() {
        return fn !== undefined;
      },
      setInterval: (f) => {
        fn = f;
        return 1;
      },
      clearInterval: () => {
        fn = undefined;
      },
      fire: () => fn?.(),
    };
  };

  it('write-through: remote failure leaves local untouched', async () => {
    const local = createMemoryStore();
    const transport = createMockRemoteTransport();
    const store = tiered({ local, remote: createRemoteStore(transport), mode: 'write-through' });
    await store.set('a', 1);
    expect(transport.records.get('a')).toBe(1);
    expect(unwrap(await local.get('a'))).toBe(1);
    transport.failNext();
    expect((await store.set('a', 2)).ok).toBe(false);
    expect(unwrap(await local.get('a'))).toBe(1);
  });

  it('reads through to remote and caches locally', async () => {
    const local = createMemoryStore();
    const transport = createMockRemoteTransport();
    transport.serverSet('r', 'remote-value');
    const store = tiered({ local, remote: createRemoteStore(transport), mode: 'write-through' });
    expect(unwrap(await store.get('r'))).toBe('remote-value');
    expect(unwrap(await local.get('r'))).toBe('remote-value');
    const gets = transport.calls.filter((c) => c.op === 'get').length;
    await store.get('r');
    expect(transport.calls.filter((c) => c.op === 'get').length).toBe(gets);
  });

  it('write-back: buffers, flushes on the interval, keeps keys dirty on failure', async () => {
    const timers = manualTimers();
    const transport = createMockRemoteTransport();
    const errors: string[] = [];
    const store = tiered({ local: createMemoryStore(), remote: createRemoteStore(transport), mode: 'write-back', flushIntervalMs: 1000, timers, onFlushError: (e) => errors.push(e.code) });
    await store.set('a', 1);
    await store.set('b', 2);
    await store.delete('b');
    expect(store.pending).toBe(2);
    expect(transport.records.size).toBe(0);
    transport.failNext();
    timers.fire();
    await tick();
    expect(errors).toEqual(['SF-STORE-008']);
    expect(store.flushState).toBe('failed');
    expect(store.pending).toBe(2);
    timers.fire();
    await tick();
    expect(store.flushState).toBe('idle');
    expect(store.pending).toBe(0);
    expect([...transport.records]).toEqual([['a', 1]]);
    await store.dispose();
    expect(timers.active).toBe(false);
  });

  it('write-back: seek overlays pending writes; offline seek uses the local view', async () => {
    const transport = createMockRemoteTransport();
    transport.serverSet('r1', 'r');
    transport.serverSet('gone', 'x');
    const store = tiered({ local: createMemoryStore(), remote: createRemoteStore(transport), mode: 'write-back', flushIntervalMs: 0 });
    await store.set('l1', 'l');
    await store.delete('gone');
    expect(unwrap(await store.seek().keys())).toEqual(['l1', 'r1']);
    transport.setOffline(true);
    expect(unwrap(await store.seek().keys())).toEqual(['l1']);
    transport.setOffline(false);
    expect(unwrap(await store.flush())).toBe(2);
    expect([...transport.records.keys()].sort()).toEqual(['l1', 'r1']);
  });

  it('write-back: dispose flushes pending writes', async () => {
    const transport = createMockRemoteTransport();
    const store = tiered({ local: createMemoryStore(), remote: createRemoteStore(transport), mode: 'write-back', flushIntervalMs: 0 });
    await store.set('k', 'v');
    expect((await store.dispose()).ok).toBe(true);
    expect(transport.records.get('k')).toBe('v');
    expect(store.flushState).toBe('disposed');
  });

  it('remote pushes refresh the cache unless a local write is pending', async () => {
    const local = createMemoryStore();
    const transport = createMockRemoteTransport();
    const store = tiered({ local, remote: createRemoteStore(transport), mode: 'write-back', flushIntervalMs: 0 });
    const seen: string[] = [];
    store.watch((c) => seen.push(c.type === 'clear' ? 'clear' : `${c.type}:${c.key}:${c.origin}`));
    await store.set('mine', 'local');
    transport.serverSet('mine', 'server');
    transport.serverSet('theirs', 'server');
    await tick();
    expect(unwrap(await local.get('mine'))).toBe('local');
    expect(unwrap(await local.get('theirs'))).toBe('server');
    expect(seen).toEqual(['set:mine:local', 'set:mine:external', 'set:theirs:external']);
  });
});
