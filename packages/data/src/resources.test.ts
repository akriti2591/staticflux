import { createMemorySink, createScope, createTelemetry, err, type MetricRecord, ok, watch } from '@staticflux/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatcher } from './batch.js';
import { createDataClient } from './client.js';
import { createEpochSource } from './epoch.js';
import { NotFoundError } from './errors.js';
import { createMockTransport, mockStatus } from './mock-transport.js';
import {
  cursorPagination,
  defineBatchedResource,
  definePaginatedResource,
  defineResource,
  defineStreamResource,
  defineSubscription,
  offsetPagination,
} from './resource-defs.js';
import { createResources, optimistic, type ResourceStatus } from './resources.js';
import { defineEndpoint, defineStreamEndpoint } from './transport.js';

interface Doc {
  readonly id: string;
  readonly title: string;
}
interface DocPage {
  readonly items: readonly Doc[];
  readonly next: string | null;
}

const DocGet = defineEndpoint<{ id: string }, Doc>({ id: 'docs/get', path: (i) => `/docs/${i.id}` });
const DocRename = defineEndpoint<{ id: string; title: string }, Doc>({ id: 'docs/rename', method: 'PATCH', path: (i) => `/docs/${i.id}` });
const DocsList = defineEndpoint<{ cursor: string | undefined }, DocPage>({ id: 'docs/list', path: () => '/docs', query: (i) => ({ cursor: i.cursor }) });
const DocsOffset = defineEndpoint<{ offset: number; limit: number }, { items: readonly Doc[]; total: number }>({ id: 'docs/offset', path: () => '/docs' });
const Profiles = defineEndpoint<readonly string[], readonly ({ id: string; name: string } | null)[]>({ id: 'users/batch-profiles', method: 'POST', path: () => '/profiles', idempotent: true });
const AgentReply = defineStreamEndpoint<{ prompt: string }, { token: string }>({ id: 'agent/reply', method: 'POST', path: () => '/agent' });
const Presence = defineStreamEndpoint<{ doc: string }, { online: number }>({ id: 'studio/presence', path: () => '/presence' });

const DocResource = defineResource({ id: 'docs/doc', endpoint: DocGet, key: (i) => [i.id], staleTimeMs: 1000, gcTimeMs: 5000 });
const DocsResource = definePaginatedResource({
  id: 'docs/docs',
  endpoint: DocsList,
  key: () => [],
  request: (_input: void, cursor: string | undefined) => ({ cursor }),
  pagination: cursorPagination<DocPage, Doc>({ items: (p) => p.items, nextCursor: (p) => p.next }),
});
const OffsetDocs = definePaginatedResource({
  id: 'docs/offset-docs',
  endpoint: DocsOffset,
  request: (_input: void, page: { offset: number; limit: number }) => page,
  pagination: offsetPagination<{ items: readonly Doc[]; total: number }, Doc>({ limit: 2, items: (p) => p.items, total: (p) => p.total }),
});
const ProfileResource = defineBatchedResource({
  id: 'users/profile',
  endpoint: Profiles,
  maxBatchSize: 2,
  pick: (response, _key, index) => response[index] ?? err(NotFoundError()),
});
const Reply = defineStreamResource({ id: 'agent/reply-text', endpoint: AgentReply, initial: () => '', reduce: (text, chunk) => text + chunk.token });
const PresenceSub = defineSubscription({
  id: 'studio/presence-sub',
  endpoint: Presence,
  initial: () => 0,
  reduce: (_n, chunk) => chunk.online,
  reconnect: { attempts: 3, baseDelayMs: 10, jitter: 'none' },
});

const ALL_DOCS: Doc[] = [1, 2, 3, 4, 5].map((n) => ({ id: String(n), title: `Doc ${n}` }));

function setup(options: { latencyMs?: number } = {}) {
  let now = 0;
  const epoch = createEpochSource();
  const sink = createMemorySink();
  const telemetry = createTelemetry({ random: () => 0.5 });
  telemetry.addSink(sink);
  const titles = new Map<string, string>();
  const mock = createMockTransport({ latencyMs: options.latencyMs ?? 10 });
  mock.route(DocGet, ({ id }) => (id === 'missing' ? mockStatus(404) : { id, title: titles.get(id) ?? `Doc ${id}` }));
  mock.route(DocRename, ({ id, title }) => {
    titles.set(id, title);
    return { id, title };
  });
  mock.route(DocsList, ({ cursor }) => {
    const start = cursor === undefined ? 0 : Number(cursor);
    const items = ALL_DOCS.slice(start, start + 2);
    return { items, next: start + 2 < ALL_DOCS.length ? String(start + 2) : null };
  });
  mock.route(DocsOffset, ({ offset, limit }) => ({ items: ALL_DOCS.slice(offset, offset + limit), total: ALL_DOCS.length }));
  mock.route(Profiles, (ids) => ids.map((id) => (id === 'ghost' ? null : { id, name: `User ${id}` })));
  const client = createDataClient({ transport: mock, epoch, telemetry, random: () => 0, defaultRetry: false });
  const resources = createResources({ client, now: () => now });
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const metrics = (id: string): number => sink.records.filter((r): r is MetricRecord => r.type === 'metric' && r.metric === id).length;
  return { mock, client, resources, epoch, advance, metrics, sink, titles };
}

describe('resources: single + SWR', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads into a reactive handle: idle → loading → ready; dedups concurrent readers', async () => {
    const { resources, mock, advance, metrics } = setup();
    const statuses: ResourceStatus[] = [];
    const a = resources.query(DocResource, { id: '1' });
    const stop = watch(
      () => a.status,
      (s) => statuses.push(s),
      { fireImmediately: true },
    );
    const b = resources.query(DocResource, { id: '1' });
    expect(a.key).toBe(b.key);
    await advance(10);
    expect(a.data).toEqual({ id: '1', title: 'Doc 1' });
    expect(b.status).toBe('ready');
    expect(statuses).toEqual(['loading', 'ready']);
    expect(mock.callsTo(DocGet)).toHaveLength(1);
    expect(metrics('data/cache-miss')).toBe(1);
    expect(metrics('data/cache-hit')).toBe(0); // the second reader joined the in-flight request
    stop();
  });

  it('serves fresh data from cache, stale data while revalidating (SWR)', async () => {
    const { resources, mock, advance, metrics, titles } = setup();
    const first = resources.fetch(DocResource, { id: '1' });
    await advance(10);
    expect(await first).toEqual(ok({ id: '1', title: 'Doc 1' }));
    expect(await resources.fetch(DocResource, { id: '1' })).toEqual(ok({ id: '1', title: 'Doc 1' }));
    expect(mock.callsTo(DocGet)).toHaveLength(1);
    await advance(1000);
    titles.set('1', 'Renamed');
    const handle = resources.query(DocResource, { id: '1' });
    expect(handle.status).toBe('refreshing');
    expect(handle.data).toEqual({ id: '1', title: 'Doc 1' }); // stale shown
    expect(handle.isStale).toBe(true);
    expect(await resources.fetch(DocResource, { id: '1' })).toEqual(ok({ id: '1', title: 'Doc 1' })); // SWR: immediate stale
    await advance(10);
    expect(handle.data).toEqual({ id: '1', title: 'Renamed' });
    expect(handle.isStale).toBe(false);
    expect(mock.callsTo(DocGet)).toHaveLength(2);
    expect(metrics('data/cache-stale-hit')).toBeGreaterThanOrEqual(1);
    const forced = resources.fetch(DocResource, { id: '1' }, { force: true });
    await advance(10);
    expect((await forced).ok).toBe(true);
    expect(mock.callsTo(DocGet)).toHaveLength(3);
  });

  it('errors keep last data; refetch recovers; disabled queries do not fetch', async () => {
    const { resources, mock, advance } = setup();
    const missing = resources.query(DocResource, { id: 'missing' });
    await advance(10);
    expect(missing.status).toBe('error');
    expect(missing.error?.kind).toBe('not-found');
    const lazy = resources.query(DocResource, { id: '2' }, { enabled: false });
    await advance(10);
    expect(lazy.status).toBe('idle');
    expect(mock.callsTo(DocGet)).toHaveLength(1);
    const refetched = lazy.refetch();
    await advance(10);
    expect((await refetched).ok).toBe(true);
    expect(lazy.status).toBe('ready');
    mock.failNext(DocGet, { status: 500 });
    const failed = lazy.refetch();
    await advance(10);
    expect((await failed).ok).toBe(false);
    expect(lazy.status).toBe('error');
    expect(lazy.data).toEqual({ id: '2', title: 'Doc 2' });
  });

  it('invalidate refetches observed entries only', async () => {
    const { resources, mock, advance } = setup();
    const handle = resources.query(DocResource, { id: '1' });
    void resources.fetch(DocResource, { id: '2' });
    await advance(10);
    resources.invalidate(DocResource);
    expect(handle.isStale).toBe(true);
    await advance(10);
    expect(mock.callsTo(DocGet).map((c) => (c.input as { id: string }).id)).toEqual(['1', '2', '1']);
    handle.invalidate();
    await advance(10);
    expect(mock.callsTo(DocGet)).toHaveLength(4);
    resources.invalidate();
    await advance(10);
    expect(mock.callsTo(DocGet)).toHaveLength(5);
  });

  it('epoch bump: aborts in-flight, keeps stale data, refetches observed in the new epoch (R4.3/R4.7, I-10)', async () => {
    const { resources, mock, advance, epoch } = setup({ latencyMs: 50 });
    const handle = resources.query(DocResource, { id: '1' });
    await advance(50);
    expect(handle.status).toBe('ready');
    void handle.refetch();
    await advance(20);
    epoch.bump();
    expect(handle.status).toBe('refreshing');
    expect(handle.data).toEqual({ id: '1', title: 'Doc 1' });
    await advance(50);
    expect(handle.status).toBe('ready');
    const epochs = mock.callsTo(DocGet).map((c) => c.epoch);
    expect(epochs).toEqual([0, 0, 1]);
    expect(handle.isStale).toBe(false);
  });

  it('gc drops unobserved entries after gcTimeMs; scope disposal releases handles', async () => {
    const { resources, advance } = setup();
    const scope = createScope('view');
    resources.query(DocResource, { id: '1' }, { scope });
    await advance(10);
    expect(resources.size).toBe(1);
    await advance(10_000);
    expect(resources.size).toBe(1); // still observed
    await scope.dispose();
    await advance(4000);
    expect(resources.size).toBe(1);
    await advance(1000);
    expect(resources.size).toBe(0);
    const h = resources.query(DocResource, { id: '9' });
    h.dispose();
    h.dispose();
    expect(await h.refetch()).toMatchObject({ ok: false, error: { code: 'SF-DATA-021' } });
  });

  it('setData / getData', async () => {
    const { resources, mock } = setup();
    resources.setData(DocResource, { id: '5' }, { id: '5', title: 'Local' });
    expect(resources.getData(DocResource, { id: '5' })).toEqual({ id: '5', title: 'Local' });
    const handle = resources.query(DocResource, { id: '5' });
    expect(handle.status).toBe('ready');
    expect(mock.callsTo(DocGet)).toHaveLength(0); // fresh
    resources.setData(DocResource, { id: '5' }, (old) => ({ ...(old as Doc), title: 'Updated' }));
    expect(handle.data?.title).toBe('Updated');
  });

  it('optimistic update applies immediately and rolls back on failure', async () => {
    const { resources, mock, advance } = setup();
    const handle = resources.query(DocResource, { id: '1' });
    await advance(10);
    mock.failNext(DocRename, { status: 409 });
    const failed = resources.mutate(DocRename, { id: '1', title: 'New' }, {
      optimistic: [optimistic(DocResource, { id: '1' }, (old) => (old === undefined ? old : { ...old, title: 'New' }))],
    });
    expect(handle.data?.title).toBe('New');
    await advance(10);
    expect(await failed).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(handle.data?.title).toBe('Doc 1'); // rolled back
    await advance(10); // rollback invalidates → refetch

    const onSuccess = vi.fn();
    const saved = resources.mutate(DocRename, { id: '1', title: 'Saved' }, {
      optimistic: [optimistic(DocResource, { id: '1' }, (old) => (old === undefined ? old : { ...old, title: 'Saved' }))],
      invalidates: [{ resource: DocsResource }],
      onSuccess,
    });
    expect(handle.data?.title).toBe('Saved');
    await advance(10);
    expect((await saved).ok).toBe(true);
    expect(onSuccess).toHaveBeenCalledWith({ id: '1', title: 'Saved' });
    await advance(10);
    expect(handle.data?.title).toBe('Saved'); // server-confirmed after revalidate
  });

  it('optimistic write aborts an in-flight read so stale responses cannot overwrite it', async () => {
    const { resources, advance } = setup({ latencyMs: 30 });
    const handle = resources.query(DocResource, { id: '1' });
    await advance(30);
    void handle.refetch();
    await advance(5);
    void resources.mutate(DocRename, { id: '1', title: 'Mine' }, {
      optimistic: [optimistic(DocResource, { id: '1' }, (old) => (old === undefined ? old : { ...old, title: 'Mine' }))],
    });
    await advance(30);
    expect(handle.data?.title).toBe('Mine');
  });
});

describe('resources: paginated', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cursor pagination: fetchNext appends pages until exhausted; revalidation refetches loaded pages', async () => {
    const { resources, mock, advance } = setup();
    const list = resources.paginated(DocsResource, undefined);
    expect(list.hasMore).toBe(true);
    await advance(10);
    expect(list.items.map((d) => d.id)).toEqual(['1', '2']);
    const next = list.fetchNext();
    expect(list.loadingMore).toBe(true);
    await advance(10);
    expect((await next).ok).toBe(true);
    expect(list.items.map((d) => d.id)).toEqual(['1', '2', '3', '4']);
    void list.fetchNext();
    await advance(10);
    expect(list.items).toHaveLength(5);
    expect(list.hasMore).toBe(false);
    expect((await list.fetchNext()).ok).toBe(true);
    expect(mock.callsTo(DocsList)).toHaveLength(3);
    list.invalidate();
    await advance(40);
    expect(mock.callsTo(DocsList).map((c) => (c.input as { cursor?: string }).cursor)).toEqual([undefined, '2', '4', undefined, '2', '4']);
    expect(list.items).toHaveLength(5);
    expect(list.data).toHaveLength(3);
  });

  it('offset pagination stops at total', async () => {
    const { resources, advance } = setup();
    const list = resources.paginated(OffsetDocs, undefined, { enabled: false });
    const first = list.fetchNext(); // first call loads page 1
    await advance(10);
    expect((await first).ok).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      void list.fetchNext();
      await advance(10);
    }
    expect(list.items.map((d) => d.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(list.hasMore).toBe(false);
  });

  it('fetchNext reports errors without dropping loaded pages', async () => {
    const { resources, mock, advance } = setup();
    const list = resources.paginated(DocsResource, undefined);
    await advance(10);
    mock.failNext(DocsList, { status: 500 });
    const next = list.fetchNext();
    await advance(10);
    expect((await next).ok).toBe(false);
    expect(list.error?.kind).toBe('unavailable');
    expect(list.items).toHaveLength(2);
  });
});

describe('resources: batched (DataLoader)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces loads within a microtask, splits by maxBatchSize, dedups keys, per-key results', async () => {
    const { resources, mock, advance, metrics } = setup();
    const a = resources.query(ProfileResource, 'a');
    const b = resources.query(ProfileResource, 'b');
    const c = resources.query(ProfileResource, 'c');
    const ghost = resources.fetch(ProfileResource, 'ghost');
    const aAgain = resources.fetch(ProfileResource, 'a');
    await advance(10);
    expect(mock.callsTo(Profiles).map((call) => call.input)).toEqual([
      ['a', 'b'],
      ['c', 'ghost'],
    ]);
    expect(a.data).toEqual({ id: 'a', name: 'User a' });
    expect(b.status).toBe('ready');
    expect(c.data?.name).toBe('User c');
    expect(await ghost).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    expect((await aAgain).ok).toBe(true);
    expect(metrics('data/batch-size')).toBe(2);
  });

  it('createBatcher: whole-batch failure, missing results, ms window, abort', async () => {
    const loadMany = vi.fn(async (keys: readonly number[]) =>
      keys.includes(0) ? err(NotFoundError()) : ok(keys.filter((k) => k !== 7).map((k) => ok(k * 10))),
    );
    const batcher = createBatcher<number, number>({ loadMany, window: { ms: 5 } });
    const p1 = batcher.load(1);
    const p2 = batcher.load(2);
    expect(batcher.pending).toBe(2);
    await vi.advanceTimersByTimeAsync(5);
    expect(await p1).toEqual(ok(10));
    expect(await p2).toEqual(ok(20));
    const missing = batcher.load(7);
    await vi.advanceTimersByTimeAsync(5);
    expect(await missing).toMatchObject({ ok: false, error: { code: 'SF-DATA-020' } });
    const failing = batcher.load(0);
    await vi.advanceTimersByTimeAsync(5);
    expect(await failing).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    const controller = new AbortController();
    const aborted = batcher.load(3, controller.signal);
    controller.abort();
    expect(await aborted).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    await vi.advanceTimersByTimeAsync(5);
    expect(loadMany).toHaveBeenCalledTimes(3); // aborted-only window dispatches nothing
  });
});

describe('resources: streamed + subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams and reduces chunks (agent.reply); cancel and restart', async () => {
    const { resources, mock, advance } = setup();
    mock.routeStream(AgentReply, async function* (input, ctx) {
      for (const token of [input.prompt, ' world', '!']) {
        await ctx.sleep(10);
        yield { token };
      }
    });
    const reply = resources.stream(Reply, { prompt: 'Hello' });
    expect(reply.status).toBe('loading');
    expect(reply.streaming).toBe(true);
    await advance(35);
    expect(reply.data).toBe('Hello world');
    await advance(10);
    expect(reply.status).toBe('ready');
    expect(reply.data).toBe('Hello world!');
    expect(reply.streaming).toBe(false);

    const restarted = reply.start();
    await advance(25);
    reply.cancel();
    await advance(50);
    expect((await restarted).ok).toBe(false);
    expect(reply.status).toBe('ready'); // cancelled after receiving data
    expect(reply.data).toBe('Hello');
    reply.dispose();
    expect(await reply.start()).toMatchObject({ ok: false, error: { code: 'SF-DATA-021' } });
  });

  it('stream errors surface on the handle', async () => {
    const { resources, mock, advance } = setup();
    mock.routeStream(AgentReply, () => []);
    mock.failNext(AgentReply, { status: 429 });
    const reply = resources.stream(Reply, { prompt: '' });
    await advance(20);
    expect(reply.status).toBe('error');
    expect(reply.error?.kind).toBe('rate');
  });

  it('subscription: ready on first message, reconnects with backoff, restarts on epoch bump, disposes', async () => {
    const { resources, mock, advance, epoch } = setup({ latencyMs: 1 });
    let connections = 0;
    mock.routeStream(Presence, async function* (_input, ctx) {
      connections += 1;
      yield { online: connections };
      if (connections === 1) throw new Error('dropped'); // unknown error → not retryable by default
      await ctx.sleep(1_000_000);
    });
    const presence = resources.subscribe(PresenceSub, { doc: '42' });
    expect(presence.status).toBe('loading');
    await advance(5);
    expect(presence.data).toBe(1);
    expect(presence.status).toBe('error');
    presence.restart();
    await advance(5);
    expect(presence.status).toBe('ready');
    expect(presence.connected).toBe(true);
    expect(presence.data).toBe(2);
    epoch.bump();
    await advance(5);
    expect(presence.data).toBe(3);
    expect(mock.callsTo(Presence).map((c) => c.epoch)).toEqual([0, 0, 1]);
    presence.dispose();
    await advance(5);
    expect(connections).toBe(3);
  });

  it('subscription reconnects on network errors', async () => {
    const { resources, mock, advance } = setup({ latencyMs: 1 });
    mock.routeStream(Presence, async function* (_input, ctx) {
      yield { online: 7 };
      await ctx.sleep(1_000_000);
    });
    mock.failNext(Presence, 'network', 2);
    const presence = resources.subscribe(PresenceSub, { doc: '1' });
    await advance(100);
    expect(presence.data).toBe(7);
    expect(mock.callsTo(Presence)).toHaveLength(3);
    resources.dispose();
    expect(resources.size).toBe(0);
  });
});
