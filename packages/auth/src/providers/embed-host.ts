/**
 * `embed-host` — embedded mode (ChatGPT Apps SDK / MCP Apps, R6.6).
 *
 * The HOST is the OAuth client; the widget never holds a token. This provider is a
 * transport adapter: identity comes from host-provided context, authorization is the
 * `host` scheme (data calls go through the host bridge's tool calls), and a 401 maps
 * to a host-driven re-auth request. Never extract tokens via tool `_meta`.
 */
import { type Result, err, ok } from '@staticflux/core';
import type { Credentials, IdentityProvider, LoginOutcome, Principal, ProviderEvent, ProviderGrant } from '../contract.js';
import { HostBridgeError, NotAuthenticatedError } from '../errors.js';

/** Identity as reported by the host (no tokens). */
export interface HostIdentity {
  readonly subject: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly expiresAt?: number;
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * Port implemented by the platform host-bridge plugin (R18.8): `window.openai`,
 * the MCP Apps postMessage bridge, a native JS interface… Implementations must
 * validate `event.source` + `event.origin` on every message.
 */
export interface AuthHostBridge {
  readonly hostKind: string;
  identity(signal: AbortSignal): Promise<Result<HostIdentity | undefined>>;
  /** Ask the host to (re)link the account. Resolves when the host reports completion. */
  requestAuthentication(signal: AbortSignal): Promise<Result<void>>;
  signOut?(signal: AbortSignal): Promise<Result<void>>;
  onIdentityChange(listener: () => void): () => void;
}

function toCredentials(identity: HostIdentity): Credentials {
  const principal: Principal = {
    id: identity.subject,
    ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.claims === undefined ? {} : { claims: identity.claims }),
  };
  return { principal, expiresAt: identity.expiresAt, embedded: true };
}

export function embedHostProvider(bridge: AuthHostBridge): IdentityProvider {
  const readIdentity = async (signal: AbortSignal): Promise<Result<Credentials | undefined>> => {
    let result: Result<HostIdentity | undefined>;
    try {
      result = await bridge.identity(signal);
    } catch (cause) {
      return err(HostBridgeError({ cause, details: { host: bridge.hostKind } }));
    }
    if (!result.ok) return result;
    return ok(result.value === undefined ? undefined : toCredentials(result.value));
  };
  return {
    kind: 'embed-host',
    id: 'auth/embed-host',
    capabilities: { refresh: true, interactive: true, embedded: true, redirect: false },
    restore: readIdentity,
    async login(_request, signal): Promise<Result<LoginOutcome>> {
      const requested = await bridge.requestAuthentication(signal);
      if (!requested.ok) return requested;
      const credentials = await readIdentity(signal);
      if (!credentials.ok) return credentials;
      if (credentials.value === undefined) return err(NotAuthenticatedError({ message: 'The host did not link an account.' }));
      return ok({ kind: 'authenticated', credentials: credentials.value });
    },
    async refresh(_current, signal) {
      const credentials = await readIdentity(signal);
      if (!credentials.ok) return credentials;
      return credentials.value === undefined ? err(NotAuthenticatedError({ message: 'The host reports no linked account.' })) : ok(credentials.value);
    },
    async logout(_current, signal) {
      return bridge.signOut === undefined ? ok() : bridge.signOut(signal);
    },
    grant(): Promise<Result<ProviderGrant>> {
      return Promise.resolve(ok({ scheme: 'host', headers: {} }));
    },
    watch(listener: (event: ProviderEvent) => void) {
      return bridge.onIdentityChange(() => listener({ type: 'changed' }));
    },
  };
}
