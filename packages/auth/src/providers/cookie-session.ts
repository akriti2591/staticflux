/**
 * Shared "session endpoint" logic for cookie-based providers (bff-cookie, passkey):
 * the client never sees tokens — only the state reported by a session endpoint.
 */
import { type Result, err, ok } from '@staticflux/core';
import type { Credentials, Principal } from '../contract.js';
import { InvalidAuthResponseError, UnauthorizedResponseError } from '../errors.js';
import { type AuthTransport, isRecord, requestJson } from '../transport.js';

export interface SessionInfo {
  readonly principal: Principal;
  readonly expiresAt: number | undefined;
  /** CSRF token issued by the BFF (double-submit / synchronizer pattern). */
  readonly csrfToken: string | undefined;
}

/** Parse a session JSON body. `undefined` = anonymous; err = malformed. */
export type SessionParser = (body: unknown) => Result<SessionInfo | undefined>;

/**
 * Default session endpoint shape:
 * `{ authenticated: boolean, user?: { id, name?, email?, roles? , claims? }, expiresAt?: number, csrfToken?: string }`
 */
export const defaultSessionParser: SessionParser = (body) => {
  if (!isRecord(body)) return err(InvalidAuthResponseError({ message: 'Session endpoint must return a JSON object.' }));
  if (body['authenticated'] !== true) return ok(undefined);
  const user = body['user'];
  if (!isRecord(user) || typeof user['id'] !== 'string') {
    return err(InvalidAuthResponseError({ message: 'Authenticated session JSON must include `user.id` (string).' }));
  }
  const principal: Principal = {
    id: user['id'],
    ...(typeof user['name'] === 'string' ? { displayName: user['name'] } : {}),
    ...(typeof user['email'] === 'string' ? { email: user['email'] } : {}),
    ...(Array.isArray(user['roles']) ? { roles: user['roles'].filter((r): r is string => typeof r === 'string') } : {}),
    ...(isRecord(user['claims']) ? { claims: user['claims'] } : {}),
  };
  const expiresAt = typeof body['expiresAt'] === 'number' ? body['expiresAt'] : undefined;
  const csrfToken = typeof body['csrfToken'] === 'string' ? body['csrfToken'] : undefined;
  return ok({ principal, expiresAt, csrfToken });
};

export async function fetchSession(
  transport: AuthTransport,
  url: string,
  parse: SessionParser,
  signal: AbortSignal,
): Promise<Result<SessionInfo | undefined>> {
  const body = await requestJson(transport, { url, method: 'GET', credentials: 'include', signal });
  if (!body.ok) return body.error.code === UnauthorizedResponseError.code ? ok(undefined) : body;
  return parse(body.value);
}

export function toCredentials(info: SessionInfo): Credentials {
  return { principal: info.principal, expiresAt: info.expiresAt, embedded: false };
}

export interface CsrfOptions {
  /** Header name, e.g. `X-CSRF-Token`. */
  readonly header: string;
  /** Read the token from elsewhere (e.g. a non-HttpOnly cookie). Defaults to the session JSON `csrfToken`. */
  readonly read?: () => string | undefined;
}

export function csrfHeaders(csrf: CsrfOptions | undefined, fromSession: string | undefined): Record<string, string> {
  if (csrf === undefined) return {};
  const value = csrf.read?.() ?? fromSession;
  return value === undefined ? {} : { [csrf.header]: value };
}

export function withQuery(url: string, params: Readonly<Record<string, string | undefined>>): string {
  const base = url.includes('://') ? undefined : 'https://relative.invalid';
  const parsed = new URL(url, base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) parsed.searchParams.set(key, value);
  return base === undefined ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
