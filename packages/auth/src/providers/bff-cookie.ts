/**
 * `bff-cookie` — the recommended provider (RFC 10017 / BCP 212: BFF first).
 *
 * A backend-for-frontend performs the OAuth code flow and keeps tokens server-side,
 * issuing an HttpOnly SameSite cookie. The client never sees a token: it only learns
 * session state from a session endpoint and sends a CSRF header on mutating calls.
 */
import { type Result, err, ok } from '@staticflux/core';
import type { Credentials, IdentityProvider, LoginOutcome, ProviderGrant } from '../contract.js';
import { RefreshUnavailableError } from '../errors.js';
import { type AuthTransport, requestJson } from '../transport.js';
import {
  type CsrfOptions,
  type SessionInfo,
  type SessionParser,
  csrfHeaders,
  defaultSessionParser,
  fetchSession,
  toCredentials,
  withQuery,
} from './cookie-session.js';

export interface BffCookieEndpoints {
  /** GET → session JSON (401 or `{authenticated:false}` = anonymous). */
  readonly session: string;
  /** Full-page redirect target that starts the BFF login; receives `returnTo`. */
  readonly login: string;
  /** POST → ends the BFF session. */
  readonly logout: string;
  /** Optional POST → extends/rotates the server session. Without it, refresh re-reads `session`. */
  readonly refresh?: string;
}

export interface BffCookieOptions {
  readonly transport: AuthTransport;
  readonly endpoints: BffCookieEndpoints;
  readonly csrf?: CsrfOptions;
  readonly parseSession?: SessionParser;
  /** Query parameter carrying the deep-link intent. Default `returnTo`. */
  readonly returnToParam?: string;
}

export function bffCookieProvider(options: BffCookieOptions): IdentityProvider {
  const parse = options.parseSession ?? defaultSessionParser;
  const { transport, endpoints } = options;
  let csrfToken: string | undefined;

  const remember = (info: SessionInfo | undefined): Credentials | undefined => {
    csrfToken = info?.csrfToken ?? csrfToken;
    return info === undefined ? undefined : toCredentials(info);
  };

  return {
    kind: 'bff-cookie',
    id: 'auth/bff-cookie',
    capabilities: { refresh: true, interactive: true, embedded: false, redirect: true },
    async restore(signal) {
      const info = await fetchSession(transport, endpoints.session, parse, signal);
      return info.ok ? ok(remember(info.value)) : info;
    },
    login(request): Promise<Result<LoginOutcome>> {
      const url = withQuery(endpoints.login, {
        [options.returnToParam ?? 'returnTo']: request.returnTo,
        login_hint: request.loginHint,
      });
      return Promise.resolve(ok({ kind: 'redirect', url }));
    },
    async refresh(_current, signal) {
      if (endpoints.refresh !== undefined) {
        const rotated = await requestJson(transport, {
          url: endpoints.refresh,
          method: 'POST',
          credentials: 'include',
          headers: csrfHeaders(options.csrf, csrfToken),
          signal,
        });
        if (!rotated.ok) return rotated;
      }
      const info = await fetchSession(transport, endpoints.session, parse, signal);
      if (!info.ok) return info;
      const credentials = remember(info.value);
      return credentials === undefined ? err(RefreshUnavailableError({ message: 'The BFF session ended.' })) : ok(credentials);
    },
    async logout(_current, signal) {
      const result = await requestJson(transport, {
        url: endpoints.logout,
        method: 'POST',
        credentials: 'include',
        headers: csrfHeaders(options.csrf, csrfToken),
        signal,
      });
      csrfToken = undefined;
      return result.ok ? ok() : result;
    },
    clear() {
      csrfToken = undefined;
    },
    grant(): Promise<Result<ProviderGrant>> {
      return Promise.resolve(ok({ scheme: 'cookie', headers: csrfHeaders(options.csrf, csrfToken) }));
    },
  };
}
