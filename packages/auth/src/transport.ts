/**
 * Network port for auth. Every network call in this package goes through an
 * injected `AuthTransport` — a minimal fetch-like function — so tests mock it and
 * embedded hosts can route calls through their bridge.
 */
import { AbortedError, type Result, type SfError, err, ok } from '@staticflux/core';
import {
  AuthNetworkError,
  AuthRateLimitedError,
  AuthServerUnavailableError,
  ForbiddenResponseError,
  InvalidAuthResponseError,
  UnauthorizedResponseError,
} from './errors.js';

export type AuthMethod = 'GET' | 'POST' | 'DELETE';

export interface AuthRequest {
  readonly url: string;
  readonly method: AuthMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Cookie mode. bff-cookie/passkey use `include`; oidc token calls use `omit`. */
  readonly credentials?: 'include' | 'same-origin' | 'omit';
  readonly signal: AbortSignal;
}

export interface AuthResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** A minimal `fetch`-like function. */
export type AuthTransport = (request: AuthRequest) => Promise<AuthResponse>;

type FetchLike = (input: string, init: RequestInit) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Adapt the platform `fetch` (or any fetch-compatible function) to `AuthTransport`. */
export function fetchTransport(fetchFn: FetchLike | undefined = globalThis.fetch?.bind(globalThis)): AuthTransport {
  return async (request) => {
    if (fetchFn === undefined) throw new TypeError('fetch is not available');
    const init: RequestInit = { method: request.method, signal: request.signal };
    if (request.headers !== undefined) init.headers = { ...request.headers };
    if (request.body !== undefined) init.body = request.body;
    if (request.credentials !== undefined) init.credentials = request.credentials;
    return fetchFn(request.url, init);
  };
}

/** Map an HTTP status to a typed error (undefined = success). */
export function statusError(status: number, url: string): SfError | undefined {
  const details = { status, url };
  if (status >= 200 && status < 300) return undefined;
  if (status === 401) return UnauthorizedResponseError({ details });
  if (status === 403) return ForbiddenResponseError({ details });
  if (status === 429) return AuthRateLimitedError({ details });
  if (status >= 500) return AuthServerUnavailableError({ details });
  return InvalidAuthResponseError({ details, message: `Auth endpoint answered unexpected status ${status}.` });
}

/** Perform a request and return the parsed JSON body (or `undefined` for 204) as a Result. */
export async function requestJson(transport: AuthTransport, request: AuthRequest): Promise<Result<unknown>> {
  let response: AuthResponse;
  try {
    response = await transport(request);
  } catch (cause) {
    if (request.signal.aborted) return err(AbortedError({ cause }));
    return err(AuthNetworkError({ cause, details: { url: request.url } }));
  }
  const failure = statusError(response.status, request.url);
  if (failure !== undefined) return err(failure);
  if (response.status === 204) return ok(undefined);
  try {
    return ok(await response.json());
  } catch (cause) {
    return err(InvalidAuthResponseError({ cause, details: { url: request.url } }));
  }
}

/** `application/x-www-form-urlencoded` body. */
export function formBody(fields: Readonly<Record<string, string | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) params.set(key, value);
  return params.toString();
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
