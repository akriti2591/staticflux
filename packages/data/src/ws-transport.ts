/**
 * WebSocket adapter: one multiplexed socket carries requests, streams and
 * subscriptions, correlated by id. The socket is injectable (`createSocket`),
 * opened lazily, and reopened on the next call after it closes. Pending calls
 * fail with `network` when the socket closes (the client decides on retries).
 *
 * Wire frames (JSON):
 *   → { t: 'req' | 'sub', id, endpoint, method, path, query, body, traceparent }
 *   → { t: 'cancel', id }
 *   ← { t: 'res', id, status, data } | { t: 'chunk', id, data } | { t: 'end', id } | { t: 'error', id, status, data? }
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import { DecodeError, errorForStatus, NetworkError, TransportUnavailableError } from './errors.js';
import type { Transport, TransportRequest, TransportResponse } from './transport.js';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebSocketTransportOptions {
  readonly url: string;
  readonly createSocket?: WebSocketFactory;
}

type ServerFrame =
  | { readonly t: 'res'; readonly id: number; readonly status: number; readonly data?: unknown }
  | { readonly t: 'chunk'; readonly id: number; readonly data?: unknown }
  | { readonly t: 'end'; readonly id: number }
  | { readonly t: 'error'; readonly id: number; readonly status: number; readonly data?: unknown };

interface Pending {
  readonly endpoint: string;
  onFrame(frame: ServerFrame): void;
  fail(result: Result<never>): void;
}

const OPEN = 1;

function defaultFactory(): WebSocketFactory | undefined {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  return Ctor === undefined ? undefined : (url) => new Ctor(url);
}

export function createWebSocketTransport(options: WebSocketTransportOptions): Transport {
  const factory = options.createSocket ?? defaultFactory();
  let socket: WebSocketLike | undefined;
  let outbox: string[] = [];
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const connect = (): Result<WebSocketLike> => {
    if (socket !== undefined) return ok(socket);
    if (factory === undefined) return err(TransportUnavailableError({ message: 'WebSocket is not available in this environment.' }));
    const created = factory(options.url);
    socket = created;
    // sf-lint-disable-next-line no-bare-listener -- socket-lifetime listener on the transport-owned socket; WebSocketLike takes no options
    created.addEventListener('open', () => {
      const frames = outbox;
      outbox = [];
      for (const frame of frames) created.send(frame);
    });
    // sf-lint-disable-next-line no-bare-listener -- socket-lifetime listener on the transport-owned socket; WebSocketLike takes no options
    created.addEventListener('message', (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      pending.get(frame.id)?.onFrame(frame);
    });
    // sf-lint-disable-next-line no-bare-listener -- socket-lifetime listener on the transport-owned socket; WebSocketLike takes no options
    created.addEventListener('close', () => {
      if (socket === created) socket = undefined;
      outbox = [];
      const all = [...pending.values()];
      pending.clear();
      for (const p of all) p.fail(err(NetworkError({ message: 'WebSocket closed.', details: { endpoint: p.endpoint } })));
    });
    return ok(created);
  };

  const send = (frame: Record<string, unknown>): void => {
    const data = JSON.stringify(frame);
    if (socket !== undefined && socket.readyState === OPEN) socket.send(data);
    else outbox.push(data);
  };

  const open = <T>(
    kind: 'req' | 'sub',
    request: TransportRequest,
    signal: AbortSignal,
    handle: (frame: ServerFrame, settle: (result: Result<T>) => void) => void,
  ): Promise<Result<T>> => {
    if (signal.aborted) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
    const connected = connect();
    if (!connected.ok) return Promise.resolve(connected);
    const id = nextId;
    nextId += 1;
    return new Promise<Result<T>>((resolve) => {
      // Aborted to detach the abort listener once the request settles or fails.
      const detach = new AbortController();
      const settle = (result: Result<T>): void => {
        if (!pending.delete(id)) return;
        detach.abort();
        resolve(result);
      };
      const onAbort = (): void => {
        if (pending.has(id)) send({ t: 'cancel', id });
        pending.delete(id);
        resolve(err(AbortedError({ cause: signal.reason })));
      };
      signal.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
      pending.set(id, {
        endpoint: request.endpoint,
        onFrame: (frame) => handle(frame, settle),
        fail: (result) => {
          detach.abort();
          resolve(result);
        },
      });
      send({
        t: kind,
        id,
        endpoint: request.endpoint,
        method: request.method,
        path: request.path,
        query: request.query,
        body: request.body,
        traceparent: request.traceparent,
      });
    });
  };

  return {
    id: 'ws',
    request(request, signal) {
      return open<TransportResponse>('req', request, signal, (frame, settle) => {
        if (frame.t === 'res') settle(ok({ status: frame.status, data: frame.data, headers: {} }));
        else if (frame.t === 'error') settle(err(errorForStatus({ status: frame.status, endpoint: request.endpoint, body: frame.data })));
        else settle(err(DecodeError({ message: `Unexpected frame "${frame.t}" for a request.`, details: { endpoint: request.endpoint } })));
      });
    },
    stream(request, onChunk, signal) {
      return open<void>('sub', request, signal, (frame, settle) => {
        if (frame.t === 'chunk') onChunk(frame.data);
        else if (frame.t === 'end') settle(ok());
        else if (frame.t === 'error') settle(err(errorForStatus({ status: frame.status, endpoint: request.endpoint, body: frame.data })));
      });
    },
    close() {
      socket?.close();
    },
  };
}
