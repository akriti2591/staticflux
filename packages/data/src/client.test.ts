import { createMemorySink, createTelemetry, parseTraceparent, type SpanEndRecord, type MetricRecord, untracked, watch } from '@staticflux/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataClient } from './client.js';
import { createEpochSource } from './epoch.js';
import { errorForStatus } from './errors.js';
import { createMockTransport, mockStatus } from './mock-transport.js';
import { createPauseControl, effectivePausePolicy } from './pause.js';
import { s } from './schema.js';
import { buildRequest, defineEndpoint, defineStreamEndpoint, parseRetryAfter, transportSlot } from './transport.js';

const DocSchema = s.object({ id: s.string(), title: s.string() });
const DocGet = defineEndpoint({ id: 'docs/get', path: (i: { id: string }) => `/docs/${i.id}`, response: DocSchema });
const DocSave = defineEndpoint<{ id: string; title: string }, { ok: boolean }>({
  id: 'docs/save',
  method: 'PUT',
  path: (i) => `/docs/${i.id}`,
  body: (i) => ({ title: i.title }),
});
const IdempotentSave = defineEndpoint<{ id: string }, { ok: boolean }>({ id: 'docs/idem-save', method: 'PUT', path: (i) => `/x/${i.id}`, idempotent: true });
const AgentReply = defineStreamEndpoint({ id: 'agent/reply', method: 'POST', path: () => '/agent', chunk: s.object({ token: s.string() }) });

const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('transport helpers', () => {
  it('buildRequest resolves path/query/body/headers and traceparent', () => {
    const Search = defineEndpoint<{ q: string; page?: number }, unknown>({
      id: 'docs/search',
      path: () => '/search',
      query: (i) => ({ q: i.q, page: i.page }),
      headers: { 'x-a': '1' },
    });
    const req = buildRequest(Search, { q: 'hi' }, { traceparent: '00-t-s-01', epoch: 2, headers: { 'x-b': '2' } });
    expect(req).toMatchObject({ endpoint: 'docs/search', method: 'GET', path: '/search', query: { q: 'hi' }, idempotent: true, epoch: 2 });
    expect(req.headers).toEqual({ 'x-a': '1', 'x-b': '2', traceparent: '00-t-s-01' });
    expect(DocSave.idempotent).toBe(false);
  });

  it('errorForStatus maps statuses to kinds', () => {
    const kinds = [401, 403, 404, 410, 400, 422, 409, 429, 408, 504, 500, 503, 302].map((status) => errorForStatus({ status, endpoint: 'x/y' }).kind);
    expect(kinds).toEqual(['auth', 'forbidden', 'not-found', 'not-found', 'validation', 'validation', 'conflict', 'rate', 'timeout', 'timeout', 'unavailable', 'unavailable', 'unknown']);
    expect(errorForStatus({ status: 429, endpoint: 'x/y', retryAfterMs: 1000 }).details.retryAfterMs).toBe(1000);
  });

  it('parseRetryAfter handles seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), () => 4_000)).toBe(6_000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('pause policy: mutations never queue unless idempotent', () => {
    expect(effectivePausePolicy(undefined, true)).toBe('queue');
    expect(effectivePausePolicy('reject', true)).toBe('reject');
    expect(effectivePausePolicy('queue', false)).toBe('reject');
  });
});

describe('data client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the transport, validates the response, emits a data/request span and propagates traceparent', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ random: () => 0.5 });
    telemetry.addSink(sink);
    const mock = createMockTransport().route(DocGet, ({ id }) => ({ id, title: `Doc ${id}` }));
    const client = createDataClient({ transport: mock, telemetry });
    const result = await client.call(DocGet, { id: '42' });
    expect(result).toEqual({ ok: true, value: { id: '42', title: 'Doc 42' } });
    const span = sink.records.find((r): r is SpanEndRecord => r.type === 'span' && r.name === 'data/request');
    expect(span?.subsystem).toBe('data/request');
    expect(span?.attrs).toMatchObject({ endpoint: 'docs/get', method: 'GET', attempts: 1, status: 200 });
    const call = mock.callsTo(DocGet)[0];
    expect(parseTraceparent(call?.traceparent ?? '')?.spanId).toBe(span?.context.spanId);
    expect(sink.records.some((r) => r.type === 'metric' && (r as MetricRecord).metric === 'data/request-duration')).toBe(true);
  });

  it('propagates a parent context even when telemetry is off', async () => {
    const mock = createMockTransport().route(DocGet, ({ id }) => ({ id, title: '' }));
    const client = createDataClient({ transport: mock });
    const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
    await client.call(DocGet, { id: '1' }, { parent });
    expect(mock.calls[0]?.traceparent).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });

  it('returns typed errors for decode failures, missing routes and missing transports', async () => {
    const mock = createMockTransport().route(DocGet, () => ({ id: 1 }) as never);
    const client = createDataClient({ transport: mock, defaultRetry: false });
    expect(await client.call(DocGet, { id: '1' })).toMatchObject({ ok: false, error: { code: 'SF-DATA-005', kind: 'validation' } });
    expect(await client.call(DocSave, { id: '1', title: 't' })).toMatchObject({ ok: false, error: { code: 'SF-DATA-004' } });
    const Elsewhere = defineEndpoint<void, unknown>({ id: 'x/elsewhere', path: () => '/', transport: transportSlot('x/ws') });
    expect(await client.call(Elsewhere, undefined)).toMatchObject({ ok: false, error: { code: 'SF-DATA-006' } });
  });

  it('attaches the trace id to errors', async () => {
    const telemetry = createTelemetry({ random: () => 0.5 });
    telemetry.addSink(createMemorySink());
    const mock = createMockTransport().route(DocGet, () => mockStatus(404));
    const client = createDataClient({ transport: mock, telemetry });
    const result = await client.call(DocGet, { id: '1' });
    expect(!result.ok && result.error.kind).toBe('not-found');
    expect(!result.ok && typeof result.error.traceId).toBe('string');
  });

  it('retries idempotent requests with full jitter (exactly one layer), not mutations', async () => {
    const mock = createMockTransport();
    mock.route(DocGet, ({ id }) => ({ id, title: 'ok' }));
    mock.route(DocSave, () => ({ ok: true }));
    mock.failNext(DocGet, { status: 503 }, 2);
    mock.failNext(DocSave, { status: 503 }, 1);
    const client = createDataClient({ transport: mock, random: () => 0.5, defaultRetry: { attempts: 3, baseDelayMs: 100 } });
    const pending = client.call(DocGet, { id: '1' });
    await flush(1000);
    expect((await pending).ok).toBe(true);
    expect(mock.callsTo(DocGet)).toHaveLength(3);
    const save = client.call(DocSave, { id: '1', title: 't' });
    await flush(1000);
    expect(await save).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(mock.callsTo(DocSave)).toHaveLength(1);
  });

  it('honours an explicit retry-if predicate and never retries non-retryable kinds', async () => {
    const OnlyConflict = defineEndpoint<void, string>({
      id: 'x/conflict',
      path: () => '/',
      retry: { attempts: 3, baseDelayMs: 1, retryIf: (e) => e.kind === 'conflict' },
    });
    const mock = createMockTransport().route(OnlyConflict, () => 'done');
    mock.failNext(OnlyConflict, { status: 409 }, 1);
    const client = createDataClient({ transport: mock, random: () => 0 });
    const p = client.call(OnlyConflict, undefined);
    await flush(10);
    expect(await p).toEqual({ ok: true, value: 'done' });
    mock.failNext(DocGet, { status: 404 }, 5);
    mock.route(DocGet, () => ({ id: 'x', title: '' }));
    const q = client.call(DocGet, { id: '1' });
    await flush(1000);
    expect((await q).ok).toBe(false);
    expect(mock.callsTo(DocGet)).toHaveLength(1);
  });

  it('times out each attempt', async () => {
    const mock = createMockTransport().route(DocGet, () => ({ id: '1', title: '' }), { latencyMs: 10_000 });
    const client = createDataClient({ transport: mock, defaultRetry: false, defaultTimeoutMs: 50 });
    const p = client.call(DocGet, { id: '1' });
    await flush(100);
    expect(await p).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('aborts with the caller signal', async () => {
    const mock = createMockTransport({ latencyMs: 1000 }).route(DocGet, () => ({ id: '1', title: '' }));
    const client = createDataClient({ transport: mock });
    const controller = new AbortController();
    const p = client.call(DocGet, { id: '1' }, { signal: controller.signal });
    controller.abort();
    await flush(0);
    expect(await p).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });

  it('discards responses from an older epoch (I-10)', async () => {
    const epoch = createEpochSource();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ random: () => 0.5 });
    telemetry.addSink(sink);
    const mock = createMockTransport({ latencyMs: 100 }).route(DocGet, ({ id }) => ({ id, title: '' }));
    const client = createDataClient({ transport: mock, epoch, telemetry });
    const p = client.call(DocGet, { id: '1' });
    await flush(50);
    epoch.bump();
    await flush(100);
    expect(await p).toMatchObject({ ok: false, error: { code: 'SF-DATA-001', kind: 'aborted' } });
    expect(mock.calls[0]?.epoch).toBe(0);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'data/stale-epoch-discarded')).toBe(true);
    const fresh = client.call(DocGet, { id: '1' });
    await flush(100);
    expect((await fresh).ok).toBe(true);
  });

  it('pause: idempotent requests queue until resume; mutations are rejected', async () => {
    const pause = createPauseControl();
    const mock = createMockTransport();
    mock.route(DocGet, ({ id }) => ({ id, title: '' }));
    mock.route(DocSave, () => ({ ok: true }));
    mock.route(IdempotentSave, () => ({ ok: true }));
    const client = createDataClient({ transport: mock, pause });
    pause.pause();
    const queued = client.call(DocGet, { id: '1' });
    const queuedIdem = client.call(IdempotentSave, { id: '1' });
    expect(await client.call(DocSave, { id: '1', title: '' })).toMatchObject({ ok: false, error: { code: 'SF-DATA-002' } });
    await flush(10);
    expect(pause.queued).toBe(2);
    expect(mock.calls).toHaveLength(0);
    pause.resume();
    await flush(0);
    expect((await queued).ok).toBe(true);
    expect((await queuedIdem).ok).toBe(true);
    expect(pause.queued).toBe(0);

    const RejectWhilePaused = defineEndpoint<void, unknown>({ id: 'x/reject', path: () => '/', pause: 'reject' });
    pause.pause();
    expect(await client.call(RejectWhilePaused, undefined)).toMatchObject({ ok: false, error: { code: 'SF-DATA-002' } });
    const controller = new AbortController();
    const abandoned = client.call(DocGet, { id: '2' }, { signal: controller.signal });
    controller.abort();
    expect(await abandoned).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(pause.queued).toBe(0);
  });

  it('per-endpoint circuit breaker opens, is observable, half-opens after reset and closes on success', async () => {
    let now = 0;
    const Agent = defineEndpoint<void, string>({ id: 'agent/ask', method: 'POST', path: () => '/agent', breaker: { failureThreshold: 2, resetAfterMs: 1000 } });
    const mock = createMockTransport().route(Agent, () => 'answer');
    const client = createDataClient({ transport: mock, now: () => now });
    const states: string[] = [];
    client.onBreakerChange((info) => states.push(`${info.endpoint}:${info.state}`));
    const observed: string[] = [];
    const stop = watch(
      () => client.breakerState(Agent),
      (state) => observed.push(state),
    );
    mock.failNext(Agent, 'network', 2);
    await client.call(Agent, undefined);
    await client.call(Agent, undefined);
    expect(client.breakerState(Agent)).toBe('open');
    expect(await client.call(Agent, undefined)).toMatchObject({ ok: false, error: { code: 'SF-ASYNC-002' } });
    expect(mock.callsTo(Agent)).toHaveLength(2);
    expect(client.breakers()).toEqual([{ endpoint: 'agent/ask', state: 'open' }]);
    now = 1000;
    await flush(1000);
    expect(client.breakerState(Agent)).toBe('half-open');
    expect((await client.call(Agent, undefined)).ok).toBe(true);
    expect(client.breakerState(Agent)).toBe('closed');
    expect(states).toEqual(['agent/ask:open', 'agent/ask:half-open', 'agent/ask:closed']);
    expect(observed).toEqual(['open', 'half-open', 'closed']);
    stop();
    client.dispose();
  });

  it('breaker wraps retries: an open circuit is not retried', async () => {
    const mock = createMockTransport().route(DocGet, () => ({ id: '', title: '' }));
    const client = createDataClient({ transport: mock, defaultBreaker: { failureThreshold: 1, resetAfterMs: 60_000 }, random: () => 0, defaultRetry: { attempts: 3, baseDelayMs: 1 } });
    mock.setOffline(true);
    const p = client.call(DocGet, { id: '1' });
    await flush(100);
    await p;
    expect(mock.callsTo(DocGet)).toHaveLength(3); // one logical call = 3 attempts = 1 breaker failure
    const q = client.call(DocGet, { id: '1' });
    await flush(100);
    expect(await q).toMatchObject({ ok: false, error: { code: 'SF-ASYNC-002' } });
    expect(mock.callsTo(DocGet)).toHaveLength(3);
    client.resetBreaker(DocGet);
    expect(untracked(() => client.breakerState(DocGet))).toBe('closed');
  });

  it('streams chunks with schema validation and epoch discard', async () => {
    const epoch = createEpochSource();
    const mock = createMockTransport({ chunkDelayMs: 10 }).routeStream(AgentReply, function* () {
      yield { token: 'Hel' };
      yield { token: 'lo' };
    });
    const client = createDataClient({ transport: mock, epoch });
    const chunks: string[] = [];
    const p = client.stream(AgentReply, undefined, (c) => chunks.push(c.token));
    await flush(100);
    expect(await p).toEqual({ ok: true, value: undefined });
    expect(chunks).toEqual(['Hel', 'lo']);

    const Bad = defineStreamEndpoint({ id: 'agent/bad', path: () => '/', chunk: s.object({ token: s.string() }) });
    mock.routeStream(Bad, function* () {
      yield { token: 1 } as unknown as { token: string };
    });
    expect(await client.stream(Bad, undefined, () => undefined)).toMatchObject({ ok: false, error: { code: 'SF-DATA-005' } });

    const late: string[] = [];
    const q = client.stream(AgentReply, undefined, (c) => late.push(c.token));
    await flush(5);
    epoch.bump();
    await flush(100);
    expect(await q).toMatchObject({ ok: false, error: { code: 'SF-DATA-001' } });
    expect(late.length).toBeLessThan(2);
  });

  it('rejects stream calls on request-only transports and vice versa', async () => {
    const client = createDataClient({ transport: { id: 'req-only', request: () => Promise.resolve({ ok: true, value: { status: 200, data: 1, headers: {} } }) } });
    expect(await client.stream(AgentReply, undefined, () => undefined)).toMatchObject({ ok: false, error: { code: 'SF-DATA-003' } });
    const streamOnly = createDataClient({ transport: { id: 'stream-only', stream: () => Promise.resolve({ ok: true, value: undefined }) } });
    expect(await streamOnly.call(DocGet, { id: '1' })).toMatchObject({ ok: false, error: { code: 'SF-DATA-003' } });
  });

  it('mock transport: failure rate, offline, handler throws, reset', async () => {
    const mock = createMockTransport({ random: () => 0.1 }).route(DocGet, ({ id }) => {
      if (id === 'boom') throw new Error('handler failed');
      return { id, title: '' };
    });
    const client = createDataClient({ transport: mock, defaultRetry: false, defaultBreaker: false });
    mock.failureRate(DocGet, 0.5);
    expect(await client.call(DocGet, { id: '1' })).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    mock.reset();
    expect((await client.call(DocGet, { id: '1' })).ok).toBe(true);
    expect(await client.call(DocGet, { id: 'boom' })).toMatchObject({ ok: false, error: { code: 'SF-CORE-000' } });
    mock.setOffline(true);
    expect(await client.call(DocGet, { id: '1' })).toMatchObject({ ok: false, error: { kind: 'network' } });
    mock.reset();
    mock.failNext(DocGet, { error: errorForStatus({ status: 403, endpoint: 'docs/get' }) });
    expect(await client.call(DocGet, { id: '1' })).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
    expect(mock.calls).toHaveLength(1);
  });
});
