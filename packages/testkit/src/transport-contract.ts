/**
 * Transport contract suite (R9.1, R16.4). Every `@staticflux/data` `Transport`
 * (fetch, SSE, WebSocket, host bridge, worker port, mock) must pass it.
 *
 * The suite owns a tiny backend (`TransportFixture.reply`) addressed by path; the
 * factory adapts it to the transport's wire (a fake `fetch`, a fake socket, mock
 * routes, …). `mockTransportFromFixture` is the adapter for `createMockTransport`.
 *
 * @example
 * import { describe, it } from 'vitest';
 * runTransportContract('mock', (fixture) => mockTransportFromFixture(fixture), { describe, it });
 */
import { formatTraceparent, type Result } from '@staticflux/core';
import {
  buildRequest,
  createMockTransport,
  defineEndpoint,
  defineStreamEndpoint,
  type Endpoint,
  type StreamEndpoint,
  mockStatus,
  type MockContext,
  type MockTransport,
  type Transport,
  type TransportRequest,
} from '@staticflux/data';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue, within } from './contract-runner.js';

// ---------------------------------------------------------------- fixture

export const ContractEndpoints = {
  echo: defineEndpoint<{ readonly message: string; readonly n: number }, unknown>({
    id: 'contract/echo',
    method: 'POST',
    path: () => '/echo',
    body: (input) => input,
  }),
  status: defineEndpoint<{ readonly status: number }, unknown>({
    id: 'contract/status',
    path: (input) => `/status/${input.status}`,
  }),
  query: defineEndpoint<{ readonly q: string; readonly page: number }, unknown>({
    id: 'contract/query',
    path: () => '/query',
    query: (input) => ({ q: input.q, page: input.page }),
  }),
  hang: defineEndpoint<void, unknown>({ id: 'contract/hang', path: () => '/hang' }),
  stream: defineStreamEndpoint<void, unknown>({ id: 'contract/stream', path: () => '/stream' }),
  streamHang: defineStreamEndpoint<void, unknown>({ id: 'contract/stream-hang', path: () => '/stream-hang' }),
  streamFail: defineStreamEndpoint<void, unknown>({ id: 'contract/stream-fail', path: () => '/stream-fail' }),
} as const;

export const CONTRACT_CHUNKS: readonly unknown[] = [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }, { seq: 3, text: 'c' }];

/** What the backend saw (adapters report it in wire-neutral form). */
export interface FixtureCall {
  readonly method: string;
  /** Path without query string. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly traceparent: string | undefined;
}

export type FixtureReply =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  /** Never answers; the adapter must stop when the request's signal aborts. */
  | { readonly kind: 'hang' }
  /** Streamed chunks; `then` says what happens after the last chunk. */
  | { readonly kind: 'chunks'; readonly chunks: readonly unknown[]; readonly then: 'end' | 'hang' | 'fail' };

export interface TransportFixture {
  readonly endpoints: typeof ContractEndpoints;
  reply(call: FixtureCall): FixtureReply;
  readonly calls: readonly FixtureCall[];
}

export function createTransportFixture(): TransportFixture {
  const calls: FixtureCall[] = [];
  return {
    endpoints: ContractEndpoints,
    get calls() {
      return calls;
    },
    reply(call) {
      calls.push(call);
      if (call.path === '/echo') return { kind: 'json', status: 200, body: { echo: call.body } };
      if (call.path === '/query') return { kind: 'json', status: 200, body: { query: call.query } };
      if (call.path.startsWith('/status/')) {
        const status = Number(call.path.slice('/status/'.length));
        return { kind: 'json', status, body: { status } };
      }
      if (call.path === '/hang') return { kind: 'hang' };
      if (call.path === '/stream') return { kind: 'chunks', chunks: CONTRACT_CHUNKS, then: 'end' };
      if (call.path === '/stream-hang') return { kind: 'chunks', chunks: CONTRACT_CHUNKS.slice(0, 1), then: 'hang' };
      if (call.path === '/stream-fail') return { kind: 'chunks', chunks: CONTRACT_CHUNKS.slice(0, 1), then: 'fail' };
      return { kind: 'json', status: 404, body: { error: 'not found' } };
    },
  };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

function callOf(request: TransportRequest): FixtureCall {
  return { method: request.method, path: request.path, query: request.query, body: request.body, traceparent: request.traceparent };
}

/** Adapter: a `createMockTransport` whose routes answer from the fixture. */
export function mockTransportFromFixture(fixture: TransportFixture): MockTransport {
  const mock = createMockTransport();
  const answer = async (context: MockContext): Promise<unknown> => {
    const reply = fixture.reply(callOf(context.request));
    if (reply.kind === 'hang') return waitForAbort(context.signal);
    if (reply.kind === 'json') return reply.status >= 200 && reply.status < 300 ? reply.body : mockStatus(reply.status, reply.body);
    throw new Error('chunks reply for a request endpoint');
  };
  async function* chunks(context: MockContext): AsyncIterable<unknown> {
    const reply = fixture.reply(callOf(context.request));
    if (reply.kind !== 'chunks') throw new Error('non-stream reply for a stream endpoint');
    for (const chunk of reply.chunks) yield chunk;
    if (reply.then === 'hang') await waitForAbort(context.signal);
    if (reply.then === 'fail') throw new Error('stream failed');
  }
  mock.route(ContractEndpoints.echo, (_input, context) => answer(context));
  mock.route(ContractEndpoints.status, (_input, context) => answer(context));
  mock.route(ContractEndpoints.query, (_input, context) => answer(context));
  mock.route(ContractEndpoints.hang, (_input, context) => answer(context));
  for (const endpoint of [ContractEndpoints.stream, ContractEndpoints.streamHang, ContractEndpoints.streamFail]) {
    mock.routeStream(endpoint, (_input, context) => chunks(context));
  }
  return mock;
}

// ---------------------------------------------------------------- suite

export interface TransportContractOptions {
  /** Run the streaming cases (default: when the transport has `stream`). */
  readonly stream?: boolean;
  /** Per-case settle timeout (real timers; default 2000 ms). */
  readonly timeoutMs?: number;
  readonly skip?: readonly string[];
}

export type TransportFactory = (fixture: TransportFixture) => Transport | Promise<Transport>;

interface Subject {
  readonly transport: Transport;
  readonly fixture: TransportFixture;
  readonly timeoutMs: number;
}

export interface TransportContractCase {
  readonly name: string;
  readonly stream: boolean;
  run(subject: Subject): Promise<void>;
}

const TRACEPARENT = formatTraceparent({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', sampled: true });

function requestFor<I>(endpoint: Endpoint<I, unknown> | StreamEndpoint<I, unknown>, input: I): TransportRequest {
  return buildRequest(endpoint, input, { traceparent: TRACEPARENT, epoch: 3 });
}

function send(subject: Subject, request: TransportRequest, signal = new AbortController().signal): Promise<Result<{ status: number; data: unknown }>> {
  const fn = subject.transport.request;
  if (fn === undefined) throw new Error(`transport "${subject.transport.id}" has no request()`);
  return within(fn.call(subject.transport, request, signal), subject.timeoutMs, `request ${request.path}`);
}

function openStream(subject: Subject, request: TransportRequest, onChunk: (chunk: unknown) => void, signal: AbortSignal): Promise<Result<void>> {
  const fn = subject.transport.stream;
  if (fn === undefined) throw new Error(`transport "${subject.transport.id}" has no stream()`);
  return within(fn.call(subject.transport, request, onChunk, signal), subject.timeoutMs, `stream ${request.path}`);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const transportContractCases: readonly TransportContractCase[] = [
  {
    name: 'has a non-empty id',
    stream: false,
    async run({ transport }) {
      assertTrue(typeof transport.id === 'string' && transport.id.length > 0, 'transport.id must be a non-empty string');
    },
  },
  {
    name: 'request: 2xx resolves ok with the decoded body',
    stream: false,
    async run(subject) {
      const response = okValue(await send(subject, requestFor(ContractEndpoints.echo, { message: 'hi', n: 2 })), 'echo');
      assertTrue(response.status >= 200 && response.status < 300, `status ${response.status} is 2xx`);
      assertEqual(response.data, { echo: { message: 'hi', n: 2 } }, 'echoed body');
    },
  },
  {
    name: 'request: sends method, path, query and body',
    stream: false,
    async run(subject) {
      okValue(await send(subject, requestFor(ContractEndpoints.query, { q: 'a b', page: 2 })), 'query');
      const call = subject.fixture.calls.at(-1);
      assertEqual(call?.method, 'GET', 'method');
      assertEqual(call?.path, '/query', 'path');
      assertEqual(call?.query, { q: 'a b', page: '2' }, 'query string values');
      okValue(await send(subject, requestFor(ContractEndpoints.echo, { message: 'x', n: 1 })), 'echo');
      assertEqual(subject.fixture.calls.at(-1)?.method, 'POST', 'POST method');
      assertEqual(subject.fixture.calls.at(-1)?.body, { message: 'x', n: 1 }, 'body');
    },
  },
  {
    name: 'request: forwards traceparent',
    stream: false,
    async run(subject) {
      okValue(await send(subject, requestFor(ContractEndpoints.echo, { message: 't', n: 0 })), 'echo');
      assertEqual(subject.fixture.calls.at(-1)?.traceparent, TRACEPARENT, 'traceparent reached the backend');
    },
  },
  {
    name: 'request: non-2xx is a typed error (status → kind), never a throw',
    stream: false,
    async run(subject) {
      const expected: readonly [number, string][] = [
        [401, 'auth'],
        [403, 'forbidden'],
        [404, 'not-found'],
        [409, 'conflict'],
        [429, 'rate'],
        [503, 'unavailable'],
      ];
      for (const [status, kind] of expected) {
        const error = errOf(await send(subject, requestFor(ContractEndpoints.status, { status })), `status ${status}`);
        assertEqual(error.kind, kind, `kind for ${status}`);
        assertTrue(/^SF-[A-Z]+-\d{3}$/.test(error.code), `stable code for ${status} (got ${error.code})`);
        assertTrue(typeof error.fix === 'string' && error.fix.length > 0, `fix for ${status}`);
        assertEqual(error.details['status'], status, `details.status for ${status}`);
      }
    },
  },
  {
    name: 'request: never retries (one backend call per request, even on 503)',
    stream: false,
    async run(subject) {
      const before = subject.fixture.calls.length;
      errOf(await send(subject, requestFor(ContractEndpoints.status, { status: 503 })), '503');
      await tick();
      assertEqual(subject.fixture.calls.length - before, 1, 'backend calls');
    },
  },
  {
    name: 'request: an already-aborted signal resolves aborted',
    stream: false,
    async run(subject) {
      const controller = new AbortController();
      controller.abort(new Error('before'));
      const error = errOf(await send(subject, requestFor(ContractEndpoints.echo, { message: 'x', n: 0 }), controller.signal), 'pre-aborted');
      assertEqual(error.kind, 'aborted', 'kind');
    },
  },
  {
    name: 'request: aborting an in-flight request resolves aborted promptly',
    stream: false,
    async run(subject) {
      const controller = new AbortController();
      const pending = send(subject, requestFor(ContractEndpoints.hang, undefined), controller.signal);
      await tick();
      controller.abort(new Error('user cancelled'));
      const error = errOf(await pending, 'aborted in flight');
      assertEqual(error.kind, 'aborted', 'kind');
    },
  },
  {
    name: 'stream: delivers chunks in order and resolves ok on completion',
    stream: true,
    async run(subject) {
      const received: unknown[] = [];
      okValue(await openStream(subject, requestFor(ContractEndpoints.stream, undefined), (c) => received.push(c), new AbortController().signal), 'stream');
      assertEqual(received, CONTRACT_CHUNKS, 'chunks');
      assertEqual(subject.fixture.calls.at(-1)?.traceparent, TRACEPARENT, 'traceparent reached the backend');
    },
  },
  {
    name: 'stream: abort ends an open stream with an aborted error',
    stream: true,
    async run(subject) {
      const controller = new AbortController();
      const received: unknown[] = [];
      const pending = openStream(subject, requestFor(ContractEndpoints.streamHang, undefined), (c) => received.push(c), controller.signal);
      for (let i = 0; i < 20 && received.length === 0; i += 1) await tick();
      assertEqual(received, CONTRACT_CHUNKS.slice(0, 1), 'first chunk before abort');
      controller.abort(new Error('closed by consumer'));
      const error = errOf(await pending, 'aborted stream');
      assertEqual(error.kind, 'aborted', 'kind');
    },
  },
  {
    name: 'stream: a backend failure resolves an error after the delivered chunks',
    stream: true,
    async run(subject) {
      const received: unknown[] = [];
      const error = errOf(
        await openStream(subject, requestFor(ContractEndpoints.streamFail, undefined), (c) => received.push(c), new AbortController().signal),
        'failing stream',
      );
      assertEqual(received, CONTRACT_CHUNKS.slice(0, 1), 'chunks before the failure');
      assertTrue(error.kind !== 'aborted', `a failure is not an abort (got ${error.kind})`);
    },
  },
  {
    name: 'close() is idempotent (when present)',
    stream: false,
    async run({ transport }) {
      transport.close?.();
      transport.close?.();
    },
  },
];

export function runTransportContract(name: string, factory: TransportFactory, runner: ContractRunner, options: TransportContractOptions = {}): void {
  const skip = new Set(options.skip ?? []);
  const timeoutMs = options.timeoutMs ?? 2_000;
  runner.describe(`transport contract: ${name}`, () => {
    for (const contractCase of transportContractCases) {
      if (skip.has(contractCase.name)) continue;
      runner.it(contractCase.name, async () => {
        const fixture = createTransportFixture();
        const transport = await factory(fixture);
        const streams = options.stream ?? transport.stream !== undefined;
        try {
          if (contractCase.stream && !streams) return;
          await contractCase.run({ transport, fixture, timeoutMs });
        } finally {
          transport.close?.();
        }
      });
    }
  });
}
