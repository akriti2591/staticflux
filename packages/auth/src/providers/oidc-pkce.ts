/**
 * `oidc-pkce` — browser-only OAuth 2.0 authorization code + PKCE (RFC 7636), for apps
 * with no backend. Documented-risk mode (RFC 10017 §6.3): script running in the
 * origin can obtain tokens. Mitigations here: tokens live only in this closure
 * (memory — never localStorage/sessionStorage), refresh tokens are rotated when the
 * AS rotates them, the broker hides raw tokens from other packages by default.
 *
 * Only the PKCE verifier + `state` + `returnTo` survive the redirect, in transient
 * (session) storage, and they are deleted as soon as the callback is handled.
 * Consequence: a reload loses the refresh token → the user logs in again (by design).
 */
import { type Result, err, ok } from '@staticflux/core';
import type { CallbackOutcome, Credentials, IdentityProvider, LoginOutcome, Principal, ProviderGrant } from '../contract.js';
import type { AuthEnvironment } from '../environment.js';
import {
  CallbackError,
  CallbackStateMismatchError,
  CryptoUnavailableError,
  InvalidAuthResponseError,
  NotAuthenticatedError,
  RefreshUnavailableError,
} from '../errors.js';
import { createPkcePair, decodeJwtPayload, randomUrlSafe } from '../pkce.js';
import { type AuthTransport, formBody, isRecord, requestJson } from '../transport.js';
import { withQuery } from './cookie-session.js';

export interface OidcPkceOptions {
  readonly clientId: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly redirectUri: string;
  readonly scope?: string;
  readonly revocationEndpoint?: string;
  /** If set, principal comes from userinfo (bearer GET) instead of id_token claims. */
  readonly userinfoEndpoint?: string;
  readonly extraAuthParams?: Readonly<Record<string, string>>;
  readonly transport: AuthTransport;
  readonly env: Pick<AuthEnvironment, 'now' | 'randomBytes' | 'subtle' | 'transientStorage'>;
  /** Map (advisory, unverified) claims to a principal. Default: sub/name/email/roles. */
  readonly principalFromClaims?: (claims: Readonly<Record<string, unknown>>) => Principal | undefined;
}

interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly idToken: string | undefined;
  readonly expiresAt: number | undefined;
}

interface PendingLogin {
  readonly verifier: string;
  readonly returnTo: string | undefined;
  readonly createdAt: number;
}

const PENDING_PREFIX = 'sf-auth/pkce:';

export function defaultPrincipalFromClaims(claims: Readonly<Record<string, unknown>>): Principal | undefined {
  const sub = claims['sub'];
  if (typeof sub !== 'string') return undefined;
  const roles = claims['roles'];
  return {
    id: sub,
    ...(typeof claims['name'] === 'string' ? { displayName: claims['name'] } : {}),
    ...(typeof claims['email'] === 'string' ? { email: claims['email'] } : {}),
    ...(Array.isArray(roles) ? { roles: roles.filter((r): r is string => typeof r === 'string') } : {}),
    claims,
  };
}

/** Parse an OAuth callback URL. `undefined` = not a callback for `redirectUri`. */
export function parseCallbackUrl(
  url: string,
  redirectUri: string,
): { readonly code: string; readonly state: string } | { readonly error: string; readonly description: string | undefined; readonly state: string | undefined } | undefined {
  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(url);
    expected = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) return undefined;
  const params = parsed.searchParams;
  const error = params.get('error');
  const state = params.get('state');
  if (error !== null) return { error, description: params.get('error_description') ?? undefined, state: state ?? undefined };
  const code = params.get('code');
  if (code === null || state === null) return undefined;
  return { code, state };
}

export function oidcPkceProvider(options: OidcPkceOptions): IdentityProvider {
  const { env, transport } = options;
  const toPrincipal = options.principalFromClaims ?? defaultPrincipalFromClaims;
  let tokens: TokenSet | undefined;
  let principal: Principal | undefined;

  const parseTokens = (body: unknown, previous: TokenSet | undefined): Result<TokenSet> => {
    if (!isRecord(body) || typeof body['access_token'] !== 'string') {
      return err(InvalidAuthResponseError({ message: 'Token response must include `access_token`.' }));
    }
    const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : undefined;
    return ok({
      accessToken: body['access_token'],
      // Rotation: keep the old refresh token only if the AS did not issue a new one.
      refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : previous?.refreshToken,
      idToken: typeof body['id_token'] === 'string' ? body['id_token'] : previous?.idToken,
      expiresAt: expiresIn === undefined ? undefined : env.now() + expiresIn * 1000,
    });
  };

  const resolvePrincipal = async (set: TokenSet, signal: AbortSignal): Promise<Result<Principal>> => {
    if (options.userinfoEndpoint !== undefined) {
      const info = await requestJson(transport, {
        url: options.userinfoEndpoint,
        method: 'GET',
        headers: { Authorization: `Bearer ${set.accessToken}` },
        credentials: 'omit',
        signal,
      });
      if (!info.ok) return info;
      const fromInfo = isRecord(info.value) ? toPrincipal(info.value) : undefined;
      return fromInfo === undefined ? err(InvalidAuthResponseError({ message: 'userinfo has no `sub`.' })) : ok(fromInfo);
    }
    const claims = set.idToken === undefined ? undefined : decodeJwtPayload(set.idToken);
    const fromClaims = claims === undefined ? undefined : toPrincipal(claims);
    if (fromClaims !== undefined) return ok(fromClaims);
    if (principal !== undefined) return ok(principal);
    return err(InvalidAuthResponseError({ message: 'No id_token claims and no userinfoEndpoint: cannot identify the user.' }));
  };

  const tokenRequest = async (fields: Record<string, string | undefined>, signal: AbortSignal): Promise<Result<Credentials>> => {
    const body = await requestJson(transport, {
      url: options.tokenEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ client_id: options.clientId, ...fields }),
      credentials: 'omit',
      signal,
    });
    if (!body.ok) return body;
    const parsed = parseTokens(body.value, tokens);
    if (!parsed.ok) return parsed;
    const who = await resolvePrincipal(parsed.value, signal);
    if (!who.ok) return who;
    tokens = parsed.value;
    principal = who.value;
    return ok({ principal: who.value, expiresAt: parsed.value.expiresAt, embedded: false });
  };

  return {
    kind: 'oidc-pkce',
    id: 'auth/oidc-pkce',
    capabilities: { refresh: true, interactive: true, embedded: false, redirect: true },
    restore() {
      // Memory only: a fresh document has no tokens.
      if (tokens === undefined || principal === undefined) return Promise.resolve(ok(undefined));
      return Promise.resolve(ok({ principal, expiresAt: tokens.expiresAt, embedded: false }));
    },
    async login(request): Promise<Result<LoginOutcome>> {
      if (env.transientStorage === undefined) {
        return err(CryptoUnavailableError({ message: 'sessionStorage is unavailable; the PKCE verifier cannot survive the redirect.' }));
      }
      const pair = await createPkcePair(env.randomBytes, env.subtle);
      if (!pair.ok) return pair;
      const state = randomUrlSafe(env.randomBytes, 16);
      if (!state.ok) return state;
      const pending: PendingLogin = { verifier: pair.value.verifier, returnTo: request.returnTo, createdAt: env.now() };
      env.transientStorage.set(PENDING_PREFIX + state.value, JSON.stringify(pending));
      const url = withQuery(options.authorizationEndpoint, {
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        scope: options.scope ?? 'openid profile email offline_access',
        state: state.value,
        code_challenge: pair.value.challenge,
        code_challenge_method: pair.value.method,
        login_hint: request.loginHint,
        ...options.extraAuthParams,
      });
      return ok({ kind: 'redirect', url });
    },
    async handleCallback(url, signal): Promise<Result<CallbackOutcome | undefined>> {
      const parsed = parseCallbackUrl(url, options.redirectUri);
      if (parsed === undefined) return ok(undefined);
      if ('error' in parsed) {
        if (parsed.state !== undefined) env.transientStorage?.remove(PENDING_PREFIX + parsed.state);
        return err(
          CallbackError({
            message: `Authorization failed: ${parsed.error}${parsed.description === undefined ? '' : ` (${parsed.description})`}`,
            details: { error: parsed.error },
          }),
        );
      }
      const key = PENDING_PREFIX + parsed.state;
      const raw = env.transientStorage?.get(key);
      env.transientStorage?.remove(key);
      if (raw === undefined) return err(CallbackStateMismatchError());
      let pending: PendingLogin;
      try {
        pending = JSON.parse(raw) as PendingLogin;
      } catch {
        return err(CallbackStateMismatchError({ message: 'Stored PKCE state is corrupt.' }));
      }
      const credentials = await tokenRequest(
        { grant_type: 'authorization_code', code: parsed.code, redirect_uri: options.redirectUri, code_verifier: pending.verifier },
        signal,
      );
      if (!credentials.ok) return credentials;
      return ok({ credentials: credentials.value, returnTo: pending.returnTo });
    },
    async refresh(_current, signal) {
      const refreshToken = tokens?.refreshToken;
      if (refreshToken === undefined) return err(RefreshUnavailableError());
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal);
    },
    async logout(_current, signal) {
      const refreshToken = tokens?.refreshToken;
      tokens = undefined;
      principal = undefined;
      if (options.revocationEndpoint !== undefined && refreshToken !== undefined) {
        // Best effort (RFC 7009): local logout succeeds even if revocation fails.
        await requestJson(transport, {
          url: options.revocationEndpoint,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody({ client_id: options.clientId, token: refreshToken, token_type_hint: 'refresh_token' }),
          credentials: 'omit',
          signal,
        });
      }
      return ok();
    },
    clear() {
      tokens = undefined;
      principal = undefined;
    },
    grant(): Promise<Result<ProviderGrant>> {
      if (tokens === undefined) return Promise.resolve(err(NotAuthenticatedError()));
      return Promise.resolve(
        ok({ scheme: 'bearer', headers: { Authorization: `Bearer ${tokens.accessToken}` }, rawToken: tokens.accessToken }),
      );
    },
  };
}
