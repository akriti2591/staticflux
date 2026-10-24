/**
 * Fetch adapter. JSON request/response; streams are newline-delimited JSON
 * (NDJSON) read from the response body. `fetch` is injectable for tests and
 * host-bridged environments.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import { DecodeError, errorForStatus, NetworkError, UnsupportedOperationError } from './errors.js';
import { parseRetryAfter, type Transport, type TransportRequest, type TransportResponse } from './transport.js';

export interface FetchTransportOptions {
  /** e.g. `https://api.example.com` or `/api`. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Extra headers per request (e.g. CSRF token from the BFF). */
  readonly headers?: () => Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

export function buildUrl(baseUrl: string, request: TransportRequest): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const path = request.path.startsWith('/') ? request.path : `/${request.path}`;
  const params = new URLSearchParams(request.query).toString();
  return `${base}${path}${params === '' ? '' : `?${params}`}`;
}

function headersOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) return text;
  return JSON.parse(text) as unknown;
}

export function createFetchTransport(options: FetchTransportOptions): Transport {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  const send = async (request: TransportRequest, signal: AbortSignal): Promise<Result<Response>> => {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers?.(), ...request.headers };
    const init: RequestInit = { method: request.method, headers, signal };
    if (options.credentials !== undefined) init.credentials = options.credentials;
    if (request.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    try {
      const response = await doFetch(buildUrl(options.baseUrl, request), init);
      if (!response.ok) {
        let body: unknown;
        try {
          body = await readBody(response);
        } catch {
          body = undefined;
        }
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        return err(
          errorForStatus({
            status: response.status,
            endpoint: request.endpoint,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            ...(body === undefined ? {} : { body }),
          }),
        );
      }
      return ok(response);
    } catch (error) {
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      return err(NetworkError({ cause: error, details: { endpoint: request.endpoint } }));
    }
  };

  return {
    id: 'fetch',
    async request(request, signal): Promise<Result<TransportResponse>> {
      const sent = await send(request, signal);
      if (!sent.ok) return sent;
      const response = sent.value;
      try {
        return ok({ status: response.status, data: await readBody(response), headers: headersOf(response) });
      } catch (error) {
        if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
        return err(DecodeError({ cause: error, details: { endpoint: request.endpoint } }));
      }
    },
    async stream(request, onChunk, signal): Promise<Result<void>> {
      const sent = await send(request, signal);
      if (!sent.ok) return sent;
      const body = sent.value.body;
      if (body === null || typeof body.getReader !== 'function') {
        return err(UnsupportedOperationError({ message: 'Response body is not readable as a stream.', details: { endpoint: request.endpoint } }));
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const emitLines = (final: boolean): Result<void> => {
        const lines = buffer.split('\n');
        buffer = final ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          try {
            onChunk(JSON.parse(trimmed) as unknown);
          } catch (error) {
            return err(DecodeError({ cause: error, details: { endpoint: request.endpoint, line: trimmed } }));
          }
        }
        return ok();
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const emitted = emitLines(false);
          if (!emitted.ok) {
            await reader.cancel();
            return emitted;
          }
        }
        return emitLines(true);
      } catch (error) {
        if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
        return err(NetworkError({ cause: error, details: { endpoint: request.endpoint } }));
      }
    },
  };
}
