/**
 * Server-Sent Events adapter (streams and subscriptions only). The EventSource
 * is injectable (`createEventSource`) for tests, polyfills and environments
 * without it. EventSource cannot send headers, so `traceparent` travels as a
 * query parameter.
 *
 * Wire contract: `message` events carry one JSON chunk each; a `done` event
 * completes the stream; a `fail` event with `{ status }` fails it with the
 * mapped error. A transport-level `error` while CLOSED fails with `network`;
 * while CONNECTING the browser is reconnecting and the stream stays open.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import { DecodeError, errorForStatus, NetworkError, TransportUnavailableError } from './errors.js';
import { buildUrl } from './fetch-transport.js';
import type { Transport, TransportRequest } from './transport.js';

export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string, init: { withCredentials: boolean }) => EventSourceLike;

export interface SseTransportOptions {
  readonly baseUrl: string;
  readonly createEventSource?: EventSourceFactory;
  readonly withCredentials?: boolean;
  /** Query parameter used to carry `traceparent`. Default `traceparent`; `false` to omit. */
  readonly traceparentParam?: string | false;
  readonly doneEvent?: string;
  readonly failEvent?: string;
}

const CLOSED = 2;

function defaultFactory(): EventSourceFactory | undefined {
  const Ctor = (globalThis as { EventSource?: new (url: string, init: { withCredentials: boolean }) => EventSourceLike }).EventSource;
  return Ctor === undefined ? undefined : (url, init) => new Ctor(url, init);
}

function parse(data: unknown): Result<unknown> {
  if (typeof data !== 'string') return ok(data);
  try {
    return ok(JSON.parse(data) as unknown);
  } catch (error) {
    return err(DecodeError({ cause: error }));
  }
}

export function createSseTransport(options: SseTransportOptions): Transport {
  const factory = options.createEventSource ?? defaultFactory();
  const param = options.traceparentParam ?? 'traceparent';
  const doneEvent = options.doneEvent ?? 'done';
  const failEvent = options.failEvent ?? 'fail';

  return {
    id: 'sse',
    stream(request: TransportRequest, onChunk, signal): Promise<Result<void>> {
      if (factory === undefined) {
        return Promise.resolve(err(TransportUnavailableError({ message: 'EventSource is not available in this environment.' })));
      }
      if (signal.aborted) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      const query = { ...request.query };
      if (param !== false && request.traceparent !== undefined) query[param] = request.traceparent;
      const source = factory(buildUrl(options.baseUrl, { ...request, query }), { withCredentials: options.withCredentials ?? false });
      return new Promise((resolve) => {
        let settled = false;
        // Aborted to detach the abort listener once the stream settles.
        const detach = new AbortController();
        const finish = (result: Result<void>): void => {
          if (settled) return;
          settled = true;
          detach.abort();
          source.close();
          resolve(result);
        };
        const onAbort = (): void => finish(err(AbortedError({ cause: signal.reason })));
        signal.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
        // sf-lint-disable-next-line no-bare-listener -- source-lifetime listener; finish() closes the source and EventSourceLike takes no options
        source.addEventListener('message', (event) => {
          const parsed = parse(event.data);
          if (!parsed.ok) finish(parsed);
          else if (!settled) onChunk(parsed.value);
        });
        // sf-lint-disable-next-line no-bare-listener -- source-lifetime listener; finish() closes the source and EventSourceLike takes no options
        source.addEventListener(doneEvent, () => finish(ok()));
        // sf-lint-disable-next-line no-bare-listener -- source-lifetime listener; finish() closes the source and EventSourceLike takes no options
        source.addEventListener(failEvent, (event) => {
          const parsed = parse(event.data);
          const status = parsed.ok && typeof parsed.value === 'object' && parsed.value !== null ? Number((parsed.value as { status?: unknown }).status) : 500;
          finish(err(errorForStatus({ status: Number.isFinite(status) ? status : 500, endpoint: request.endpoint })));
        });
        // sf-lint-disable-next-line no-bare-listener -- source-lifetime listener; finish() closes the source and EventSourceLike takes no options
        source.addEventListener('error', () => {
          if (source.readyState === CLOSED) finish(err(NetworkError({ details: { endpoint: request.endpoint } })));
        });
      });
    },
  };
}
