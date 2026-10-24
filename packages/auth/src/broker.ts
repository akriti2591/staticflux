/**
 * Authorized transport built on the token broker: other packages (data, workers)
 * make authorized calls without ever seeing a token. A 401 triggers one
 * single-flight refresh and one retry; a second 401 expires the session.
 */
import { AbortedError, type Result, err, ok } from '@staticflux/core';
import { UnauthorizedResponseError } from './errors.js';
import type { SessionStore } from './session.js';
import type { AuthRequest, AuthResponse, AuthTransport } from './transport.js';

export type AuthorizedTransport = (request: AuthRequest) => Promise<Result<AuthResponse>>;

export function createAuthorizedTransport(
  session: Pick<SessionStore, 'withAccessToken' | 'reportUnauthorized'>,
  transport: AuthTransport,
): AuthorizedTransport {
  return (request) =>
    session.withAccessToken(async (grant, signal): Promise<Result<AuthResponse>> => {
      let response: AuthResponse;
      try {
        response = await transport({
          ...request,
          headers: { ...request.headers, ...grant.headers },
          ...(grant.scheme === 'cookie' ? { credentials: 'include' as const } : {}),
          signal,
        });
      } catch (cause) {
        if (signal.aborted) return err(AbortedError({ cause }));
        throw cause;
      }
      if (response.status === 401) return err(UnauthorizedResponseError({ details: { url: request.url, status: 401 } }));
      return ok(response);
    }, request.signal);
}
