/**
 * Token broker (R11.7). Workers never hold raw credentials. They ask the
 * owning side (main thread) to perform authenticated calls through the
 * broker channel; the broker's `execute` attaches credentials (cookie/BFF,
 * bearer from the auth package, host bridge) and returns only the response.
 *
 * Client gating is UX, not security: the server re-checks every call.
 */
import { err, ok, type Result, type Scope } from '@staticflux/core';
import { Channels } from './envelope.js';
import { BrokerDeniedError } from './errors.js';
import type { Link, LinkRequestOptions } from './link.js';
import { defineProtocol, request } from './protocol.js';
import { createProtocolClient, createProtocolServer } from './rpc.js';

export interface BrokeredRequest {
  /** Namespaced operation id, e.g. `data/docs.list` (allow-listed by the broker). */
  readonly operation: `${string}/${string}`;
  readonly url?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface BrokeredResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export const BrokerProtocol = defineProtocol({
  id: Channels.broker,
  version: 1,
  requests: {
    call: request<BrokeredRequest, BrokeredResponse>({ idempotent: false }),
  },
});

const FORBIDDEN_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

export interface TokenBrokerOptions {
  /** Perform the call with credentials attached. Runs on the owning side only. */
  readonly execute: (call: BrokeredRequest, signal: AbortSignal) => Promise<Result<BrokeredResponse>>;
  /** Allow-list; default: allow every operation. */
  readonly allow?: (call: BrokeredRequest) => boolean;
}

export interface TokenBroker {
  /** Serve broker calls arriving on `link`. */
  attach(link: Link, scope?: Scope): () => void;
}

export function createTokenBroker(options: TokenBrokerOptions): TokenBroker {
  return {
    attach(link, scope) {
      const server = createProtocolServer(link, BrokerProtocol, {
        call: async (call, context) => {
          const headers = Object.keys(call.headers ?? {}).map((h) => h.toLowerCase());
          const smuggled = headers.find((h) => FORBIDDEN_HEADERS.has(h));
          if (smuggled !== undefined) {
            return err(BrokerDeniedError({ message: `Workers may not send the "${smuggled}" header.`, details: { operation: call.operation } }));
          }
          if (options.allow !== undefined && !options.allow(call)) {
            return err(BrokerDeniedError({ details: { operation: call.operation } }));
          }
          return options.execute(call, context.signal);
        },
      });
      const off = link.onClose(() => server.dispose());
      const detach = (): void => {
        off();
        server.dispose();
      };
      scope?.defer(detach);
      return detach;
    },
  };
}

export interface BrokerClient {
  call(request: BrokeredRequest, options?: LinkRequestOptions): Promise<Result<BrokeredResponse>>;
}

/** Worker-side client for the token broker. */
export function createBrokerClient(link: Link): BrokerClient {
  const client = createProtocolClient(link, BrokerProtocol);
  return {
    async call(call, options) {
      const result = await client.request('call', call, options);
      return result.ok ? ok(result.value) : result;
    },
  };
}
