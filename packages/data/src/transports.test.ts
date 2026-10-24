import { describe, expect, it, vi } from 'vitest';
import { createDataClient } from './client.js';
import { buildUrl, createFetchTransport } from './fetch-transport.js';
import { createSseTransport, type EventSourceLike } from './sse-transport.js';
import { buildRequest, defineEndpoint, defineStreamEndpoint, type TransportRequest } from './transport.js';
import { createWebSocketTransport, type WebSocketLike } from './ws-transport.js';

const Get = defineEndpoint<{ id: string }, { id: string }>({ id: 'docs/get', path: (i) => `/docs/${i.id}`, query: () => ({ v: 2 }) });
const Save = defineEndpoint<{ id: string }, { ok: boolean }>({ id: 'docs/save', method: 'POST', path: () => '/docs', body: (i) => ({ id: i.id }) });
const Tokens = defineStreamEndpoint<{ prompt: string }, { t: string }>({ id: 'agent/reply', method: 'POST', path: () => '/agent', query: (i) => ({ prompt: i.prompt }) });

const req = (endpoint: typeof Get | typeof Save | typeof Tokens, input: unknown, traceparent?: string): TransportRequest =>
  buildRequest(endpoint as typeof Get, input as { id: string }, { traceparent, epoch: 0 });

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('fetch transport', () => {
  it('builds URLs', () => {
    expect(buildUrl('https://api/', req(Get, { id: '1' }))).toBe('https://api/docs/1?v=2');
    expect(buildUrl('/api', req(Save, { id: '1' }))).toBe('/api/docs');
  });

  it('sends JSON with headers + traceparent and decodes the response', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, { ok: true }, { 'x-req': 'r1' }));
    const transport = createFetchTransport({ baseUrl: 'https://api', fetch: fetchSpy as typeof fetch, headers: () => ({ 'x-csrf': 'c' }), credentials: 'include' });
    const result = await transport.request?.(req(Save, { id: '7' }, '00-abc-def-01'), new AbortController().signal);
    expect(result).toEqual({ ok: true, value: { status: 200, data: { ok: true }, headers: { 'content-type': 'application/json', 'x-req': 'r1' } } });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://api/docs');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"id":"7"}');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({ 'x-csrf': 'c', traceparent: '00-abc-def-01', 'content-type': 'application/json' });
  });

  it('maps HTTP errors (with Retry-After) and network failures', async () => {
    const statuses = [jsonResponse(429, { msg: 'slow' }, { 'retry-after': '2' }), jsonResponse(404, undefined)];
    const transport = createFetchTransport({ baseUrl: '', fetch: (async () => statuses.shift() as Response) as typeof fetch });
    const limited = await transport.request?.(req(Get, { id: '1' }), new AbortController().signal);
    expect(limited).toMatchObject({ ok: false, error: { kind: 'rate', details: { status: 429, retryAfterMs: 2000, body: { msg: 'slow' } } } });
    expect(await transport.request?.(req(Get, { id: '1' }), new AbortController().signal)).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    const offline = createFetchTransport({ baseUrl: '', fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch });
    expect(await offline.request?.(req(Get, { id: '1' }), new AbortController().signal)).toMatchObject({ ok: false, error: { kind: 'network', code: 'SF-DATA-010' } });
  });

  it('maps aborts and decode failures', async () => {
    const controller = new AbortController();
    const aborting = createFetchTransport({
      baseUrl: '',
      fetch: (async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }) as typeof fetch,
    });
    expect(await aborting.request?.(req(Get, { id: '1' }), controller.signal)).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    const garbage = createFetchTransport({ baseUrl: '', fetch: (async () => new Response('{nope', { headers: { 'content-type': 'application/json' } })) as typeof fetch });
    expect(await garbage.request?.(req(Get, { id: '1' }), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'SF-DATA-005' } });
    const text = createFetchTransport({ baseUrl: '', fetch: (async () => new Response('plain', { headers: { 'content-type': 'text/plain' } })) as typeof fetch });
    expect(await text.request?.(req(Get, { id: '1' }), new AbortController().signal)).toMatchObject({ ok: true, value: { data: 'plain' } });
  });

  it('streams NDJSON across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"t":"a"}\n{"t":'));
        controller.enqueue(encoder.encode('"b"}\n\n{"t":"c"}'));
        controller.close();
      },
    });
    const transport = createFetchTransport({ baseUrl: '', fetch: (async () => new Response(body, { status: 200 })) as typeof fetch });
    const chunks: unknown[] = [];
    const result = await transport.stream?.(req(Tokens, { prompt: 'x' }), (c) => chunks.push(c), new AbortController().signal);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(chunks).toEqual([{ t: 'a' }, { t: 'b' }, { t: 'c' }]);
  });

  it('fails a stream on a malformed line', async () => {
    const transport = createFetchTransport({ baseUrl: '', fetch: (async () => new Response('{"t":"a"}\n{bad}\n', { status: 200 })) as typeof fetch });
    const chunks: unknown[] = [];
    expect(await transport.stream?.(req(Tokens, { prompt: '' }), (c) => chunks.push(c), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'SF-DATA-005' } });
    expect(chunks).toEqual([{ t: 'a' }]);
  });
});

class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | undefined;
  readyState = 0;
  closed = false;
  readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

describe('SSE transport', () => {
  const sse = () => createSseTransport({ baseUrl: 'https://api', createEventSource: (url) => new FakeEventSource(url) });

  it('streams message events until done; traceparent goes in the query', async () => {
    const transport = sse();
    const chunks: unknown[] = [];
    const pending = transport.stream?.(req(Tokens, { prompt: 'hi' }, '00-t-s-01'), (c) => chunks.push(c), new AbortController().signal);
    const source = FakeEventSource.last as FakeEventSource;
    expect(source.url).toBe('https://api/agent?prompt=hi&traceparent=00-t-s-01');
    source.emit('message', '{"t":"a"}');
    source.emit('error'); // reconnecting (readyState CONNECTING): stream stays open
    source.emit('message', '{"t":"b"}');
    source.emit('done');
    expect(await pending).toEqual({ ok: true, value: undefined });
    expect(chunks).toEqual([{ t: 'a' }, { t: 'b' }]);
    expect(source.closed).toBe(true);
    expect(transport.request).toBeUndefined();
  });

  it('maps fail events, closed errors, bad JSON and aborts', async () => {
    const transport = sse();
    const failing = transport.stream?.(req(Tokens, { prompt: '' }), () => undefined, new AbortController().signal);
    FakeEventSource.last?.emit('fail', '{"status":403}');
    expect(await failing).toMatchObject({ ok: false, error: { kind: 'forbidden' } });

    const closing = transport.stream?.(req(Tokens, { prompt: '' }), () => undefined, new AbortController().signal);
    const source = FakeEventSource.last as FakeEventSource;
    source.readyState = 2;
    source.emit('error');
    expect(await closing).toMatchObject({ ok: false, error: { kind: 'network' } });

    const bad = transport.stream?.(req(Tokens, { prompt: '' }), () => undefined, new AbortController().signal);
    FakeEventSource.last?.emit('message', '{oops');
    expect(await bad).toMatchObject({ ok: false, error: { code: 'SF-DATA-005' } });

    const controller = new AbortController();
    const aborted = transport.stream?.(req(Tokens, { prompt: '' }), () => undefined, controller.signal);
    controller.abort();
    expect(await aborted).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it('is unavailable without EventSource', async () => {
    const transport = createSseTransport({ baseUrl: '' });
    const hasNative = typeof (globalThis as { EventSource?: unknown }).EventSource !== 'undefined';
    if (!hasNative) {
      expect(await transport.stream?.(req(Tokens, { prompt: '' }), () => undefined, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'SF-DATA-007' } });
    }
  });
});

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | undefined;
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  reply(frame: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(frame));
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

describe('WebSocket transport', () => {
  const ws = () => createWebSocketTransport({ url: 'wss://api/rt', createSocket: (url) => new FakeSocket(url) });

  it('multiplexes requests by id; queues frames until open', async () => {
    const transport = ws();
    const a = transport.request?.(req(Get, { id: 'a' }, '00-t-s-01'), new AbortController().signal);
    const b = transport.request?.(req(Get, { id: 'b' }), new AbortController().signal);
    const socket = FakeSocket.last as FakeSocket;
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent.map((f) => [f.t, f.id, f.path, f.traceparent])).toEqual([
      ['req', 1, '/docs/a', '00-t-s-01'],
      ['req', 2, '/docs/b', undefined],
    ]);
    socket.reply({ t: 'res', id: 2, status: 200, data: { id: 'b' } });
    socket.reply({ t: 'error', id: 1, status: 404 });
    expect(await b).toMatchObject({ ok: true, value: { status: 200, data: { id: 'b' } } });
    expect(await a).toMatchObject({ ok: false, error: { kind: 'not-found' } });
  });

  it('streams chunks; cancel frame on abort; close fails pending with network', async () => {
    const transport = ws();
    const chunks: unknown[] = [];
    const stream = transport.stream?.(req(Tokens, { prompt: 'p' }), (c) => chunks.push(c), new AbortController().signal);
    const socket = FakeSocket.last as FakeSocket;
    socket.open();
    socket.reply({ t: 'chunk', id: 1, data: { t: 'x' } });
    socket.reply({ t: 'chunk', id: 1, data: { t: 'y' } });
    socket.reply({ t: 'end', id: 1 });
    expect(await stream).toEqual({ ok: true, value: undefined });
    expect(chunks).toEqual([{ t: 'x' }, { t: 'y' }]);

    const controller = new AbortController();
    const cancelled = transport.stream?.(req(Tokens, { prompt: 'p' }), () => undefined, controller.signal);
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(socket.sent.at(-1)).toEqual({ t: 'cancel', id: 2 });

    const pending = transport.request?.(req(Get, { id: 'z' }), new AbortController().signal);
    socket.close();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'network' } });
    // Reconnects lazily on the next call.
    void transport.request?.(req(Get, { id: 'again' }), new AbortController().signal);
    expect(FakeSocket.last).not.toBe(socket);
  });

  it('works behind the data client with routing by slot', async () => {
    const transport = ws();
    const client = createDataClient({ transport });
    const p = client.call(Get, { id: 'q' });
    await Promise.resolve();
    const socket = FakeSocket.last as FakeSocket;
    socket.open();
    await new Promise((r) => setTimeout(r, 0));
    const frame = socket.sent[0] as { id: number; traceparent: unknown };
    socket.reply({ t: 'res', id: frame.id, status: 200, data: { id: 'q' } });
    expect(await p).toEqual({ ok: true, value: { id: 'q' } });
    client.dispose();
  });
});
