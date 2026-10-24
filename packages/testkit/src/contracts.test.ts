import { ok } from '@staticflux/core';
import { createFetchTransport, type Transport } from '@staticflux/data';
import { describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  createRouterMemoryHistory,
  createTransportFixture,
  createUrlMemoryHistory,
  historyAdapterContractCases,
  historyContractCases,
  mockTransportFromFixture,
  runHistoryContract,
  runStoreContract,
  runTransportContract,
  type TransportFixture,
  transportContractCases,
} from './index.js';

const runner = { describe, it, expect };

// ---------------------------------------------------------------- transports

runTransportContract('mock transport', (fixture) => mockTransportFromFixture(fixture), runner);

/** A fake `fetch` speaking JSON + NDJSON, answering from the fixture. */
function fixtureFetch(fixture: TransportFixture): typeof fetch {
  const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');
  const untilAbort = (signal: AbortSignal | null | undefined): Promise<never> =>
    new Promise((_, reject) => {
      if (signal?.aborted === true) reject(abortError());
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const signal = init.signal;
    if (signal?.aborted === true) throw abortError();
    const url = new URL(String(input), 'https://api.test');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const reply = fixture.reply({
      method: init.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      query: Object.fromEntries(url.searchParams),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      traceparent: headers['traceparent'],
    });
    if (reply.kind === 'hang') return untilAbort(signal);
    const responseHeaders = new Headers({ 'content-type': 'application/json' });
    if (reply.kind === 'json') {
      const text = JSON.stringify(reply.body);
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, headers: responseHeaders, text: async () => text, body: null } as unknown as Response;
    }
    const encoder = new TextEncoder();
    const lines = reply.chunks.map((chunk) => encoder.encode(`${JSON.stringify(chunk)}\n`));
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        const next = lines.shift();
        if (next !== undefined) return { done: false, value: next };
        if (reply.then === 'end') return { done: true };
        if (reply.then === 'fail') throw new TypeError('connection reset');
        return untilAbort(signal);
      },
      async cancel(): Promise<void> {},
    };
    return { ok: true, status: 200, headers: responseHeaders, text: async () => '', body: { getReader: () => reader } } as unknown as Response;
  }) as typeof fetch;
}

runTransportContract('fetch transport (fake fetch)', (fixture) => createFetchTransport({ baseUrl: '/api', fetch: fixtureFetch(fixture) }), runner);

function requestOf(transport: Transport): NonNullable<Transport['request']> {
  const request = transport.request?.bind(transport);
  if (request === undefined) throw new Error('no request()');
  return request;
}

describe('transport contract catches broken transports', () => {
  const caseNamed = (name: string) => {
    const found = transportContractCases.find((c) => c.name.startsWith(name));
    if (found === undefined) throw new Error(`no case ${name}`);
    return found;
  };

  it('a transport that throws on non-2xx fails the status case', async () => {
    const fixture = createTransportFixture();
    const inner = requestOf(mockTransportFromFixture(fixture));
    const broken: Transport = {
      id: 'broken',
      request: async (request, signal) => {
        const r = await inner(request, signal);
        if (!r.ok) throw r.error;
        return r;
      },
    };
    await expect(caseNamed('request: non-2xx').run({ transport: broken, fixture, timeoutMs: 500 })).rejects.toBeDefined();
  });

  it('a transport that retries fails the no-retry case', async () => {
    const fixture = createTransportFixture();
    const inner = requestOf(mockTransportFromFixture(fixture));
    const retrying: Transport = {
      id: 'retrying',
      request: async (request, signal) => {
        const first = await inner(request, signal);
        return first.ok ? first : inner(request, signal);
      },
    };
    await expect(caseNamed('request: never retries').run({ transport: retrying, fixture, timeoutMs: 500 })).rejects.toThrow(/backend calls/);
  });

  it('a transport that ignores abort fails the in-flight abort case', async () => {
    const fixture = createTransportFixture();
    const stubborn: Transport = { id: 'stubborn', request: () => new Promise(() => undefined) };
    await expect(caseNamed('request: aborting').run({ transport: stubborn, fixture, timeoutMs: 50 })).rejects.toThrow(/did not settle/);
  });

  it('a transport that drops traceparent fails the trace case', async () => {
    const fixture = createTransportFixture();
    const inner = requestOf(mockTransportFromFixture(fixture));
    const untraced: Transport = {
      id: 'untraced',
      request: (request, signal) => inner({ ...request, traceparent: undefined }, signal),
    };
    await expect(caseNamed('request: forwards traceparent').run({ transport: untraced, fixture, timeoutMs: 500 })).rejects.toThrow(/traceparent/);
  });

  it('skip and stream options are honoured', () => {
    const names: string[] = [];
    runTransportContract('requests only', () => ({ id: 'x', request: async () => ok({ status: 200, data: null, headers: {} }) }), {
      describe: (_name, fn) => fn(),
      it: (name) => void names.push(name),
    }, { skip: ['has a non-empty id'] });
    expect(names).not.toContain('has a non-empty id');
    expect(names).toContain('stream: delivers chunks in order and resolves ok on completion');
  });
});

// ---------------------------------------------------------------- histories

runHistoryContract('router memory history (committed)', (url) => createRouterMemoryHistory({ initial: url }), runner, { level: 'adapter' });
runHistoryContract('router memory history (deferred)', (url) => createRouterMemoryHistory({ initial: url, traversal: 'deferred' }), runner, { level: 'adapter' });
runHistoryContract('urlstate memory history', (url) => createUrlMemoryHistory(url), runner);

describe('history contract catches broken histories', () => {
  it('a history that forgets the source fails the push case', async () => {
    const history = createUrlMemoryHistory('/start?tab=a#top');
    const broken = { ...history, push: (url: string) => history.push(url), subscribe: history.subscribe, back: history.back };
    Object.defineProperty(broken, 'url', { get: () => history.url });
    const pushCase = historyContractCases.find((c) => c.name.startsWith('push changes'));
    await expect(pushCase?.run({ history: broken, initial: '/start?tab=a#top', timeoutMs: 100 })).rejects.toThrow(/change/);
  });

  it('a history whose back never reports fails within the timeout', async () => {
    const history = createUrlMemoryHistory('/start');
    const silent = { ...history, back: () => undefined };
    Object.defineProperty(silent, 'url', { get: () => history.url });
    Object.defineProperty(silent, 'canGoBack', { get: () => history.canGoBack });
    const backCase = historyContractCases.find((c) => c.name.startsWith('back returns'));
    await expect(backCase?.run({ history: silent, initial: '/start', timeoutMs: 20 })).rejects.toThrow(/did not settle/);
  });

  it('adapter cases are only added at level adapter', () => {
    const names: string[] = [];
    runHistoryContract('names', (url) => createUrlMemoryHistory(url), { describe: (_n, fn) => fn(), it: (n) => void names.push(n) });
    expect(names).toHaveLength(historyContractCases.length);
    expect(historyAdapterContractCases.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- stores (re-exported suite)

runStoreContract('memory store (via testkit)', () => createMemoryStore(), runner);
