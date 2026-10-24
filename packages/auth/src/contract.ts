/**
 * The identity-provider contract and the one session model every provider produces (R6.1).
 *
 * Security notes (R6.7, R6.16): anything the browser learns about a session is
 * advisory. The backend validates every request; client checks exist for UX only.
 */
import type { Result } from '@staticflux/core';

export type ProviderKind = 'bff-cookie' | 'oidc-pkce' | 'custom' | 'passkey' | 'embed-host' | 'guest';

/** The authenticated user as the client knows it (advisory — never trust it for authorization). */
export interface Principal {
  readonly id: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly roles?: readonly string[];
  /** Extra advisory claims (plan, tenant, …). */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * What a provider hands the session store after authenticating. Contains no tokens:
 * providers keep token material in their own closure (memory only).
 */
export interface Credentials {
  readonly principal: Principal;
  /** Epoch ms when the session/access stops being valid; undefined = unknown (server decides). */
  readonly expiresAt: number | undefined;
  /** True for the host-bridged flavour (embed-host). */
  readonly embedded: boolean;
}

/** How an outgoing request is authorized. Produced by a provider, handed out by the token broker. */
export interface ProviderGrant {
  readonly scheme: 'cookie' | 'bearer' | 'host' | 'none';
  /** Headers to attach (e.g. CSRF header, or `Authorization` for bearer). */
  readonly headers: Readonly<Record<string, string>>;
  /** Raw token, for bearer. Stripped by the broker unless `exposeRawToken` is set. */
  readonly rawToken?: string;
}

export interface LoginRequest {
  /** Deep-link intent to come back to after login (e.g. `/studio/doc/42?tab=comments`). */
  readonly returnTo?: string;
  readonly loginHint?: string;
  /** Passkey conditional UI (autofill) vs modal. */
  readonly mediation?: 'conditional' | 'optional';
}

export type LoginOutcome =
  | { readonly kind: 'authenticated'; readonly credentials: Credentials }
  /** The provider needs a full-page redirect; the session store navigates. */
  | { readonly kind: 'redirect'; readonly url: string };

export interface CallbackOutcome {
  readonly credentials: Credentials;
  readonly returnTo: string | undefined;
}

export type ProviderEvent =
  /** Identity may have changed outside our control (host context, cookie set by another app). */
  | { readonly type: 'changed' }
  | { readonly type: 'revoked'; readonly reason: string }
  | { readonly type: 'signed-out' };

export interface ProviderCapabilities {
  readonly refresh: boolean;
  /** Login needs a user gesture / UI. */
  readonly interactive: boolean;
  /** Produces the embedded (host-bridged) flavour. */
  readonly embedded: boolean;
  /** Login navigates away (redirect flow). */
  readonly redirect: boolean;
}

/** An identity provider. All async methods take an AbortSignal and return Results. */
export interface IdentityProvider {
  readonly kind: ProviderKind;
  /** Namespaced id, e.g. `auth/bff-cookie`. */
  readonly id: `${string}/${string}`;
  readonly capabilities: ProviderCapabilities;
  /** Silent probe for an existing session (no UI, no redirect). `undefined` = none. */
  restore(signal: AbortSignal): Promise<Result<Credentials | undefined>>;
  login(request: LoginRequest, signal: AbortSignal): Promise<Result<LoginOutcome>>;
  /** Complete a redirect login. `undefined` = `url` is not this provider's callback. */
  handleCallback?(url: string, signal: AbortSignal): Promise<Result<CallbackOutcome | undefined>>;
  refresh?(current: Credentials, signal: AbortSignal): Promise<Result<Credentials>>;
  logout(current: Credentials | undefined, signal: AbortSignal): Promise<Result<void>>;
  /** Forget in-memory material without a network call (another tab logged out). */
  clear?(): void;
  /** Authorization for one outgoing request. */
  grant(current: Credentials, signal: AbortSignal): Promise<Result<ProviderGrant>>;
  /** External identity changes (host bridge, provider push). Returns unsubscribe. */
  watch?(listener: (event: ProviderEvent) => void): () => void;
  dispose?(): void;
}

// ---------------------------------------------------------------- session model

export type SessionStateName = 'guest' | 'authenticating' | 'authenticated' | 'refreshing' | 'expired' | 'revoked';

interface SessionBase {
  /** Stable anonymous id; kept across login so guest state can be handed off (R6.4). */
  readonly guestId: string;
  readonly provider: ProviderKind;
}

export type SessionSnapshot =
  | (SessionBase & { readonly state: 'guest'; readonly principal: undefined })
  | (SessionBase & {
      readonly state: 'authenticating';
      /** Present when re-authenticating after expiry/revocation. */
      readonly principal: Principal | undefined;
      readonly silent: boolean;
    })
  | (SessionBase & {
      readonly state: 'authenticated' | 'refreshing';
      readonly principal: Principal;
      readonly expiresAt: number | undefined;
      readonly embedded: boolean;
    })
  | (SessionBase & { readonly state: 'expired'; readonly principal: Principal })
  | (SessionBase & { readonly state: 'revoked'; readonly principal: Principal; readonly reason: string });

export type SessionChangeReason = 'restore' | 'login' | 'callback' | 'refresh' | 'logout' | 'expire' | 'revoke' | 'sync' | 'host';

/** Typed event emitted on every session transition. */
export interface SessionChange {
  readonly type: 'session-changed';
  readonly reason: SessionChangeReason;
  readonly from: SessionSnapshot;
  readonly to: SessionSnapshot;
  /** The principal key (guest id or user id) changed. */
  readonly principalChanged: boolean;
  /**
   * The app should bump its epoch (`injector.refresh('epoch')`, R4.3/R6.5): identity
   * or authorization changed, so cached data is stale.
   */
  readonly requiresEpochRefresh: boolean;
}

/** Port for things that react to session changes — the runtime binds one that calls `refresh('epoch')`. */
export interface SessionListener {
  readonly id: `${string}/${string}`;
  onSessionChange(change: SessionChange): void;
}

/**
 * Guest → authenticated upgrade hook (R6.4). `beforeUpgrade` runs before login starts
 * (before any redirect, so persist via @staticflux/handoff); `afterUpgrade` runs once
 * the new principal is authenticated (also after a redirect callback, with the same guestId).
 */
export interface GuestUpgradeHook {
  readonly id: `${string}/${string}`;
  beforeUpgrade?(guest: { readonly guestId: string }, signal: AbortSignal): Promise<Result<void>> | Result<void>;
  afterUpgrade?(
    upgrade: { readonly guestId: string; readonly principal: Principal },
    signal: AbortSignal,
  ): Promise<Result<void>> | Result<void>;
}

/** What the token broker hands to a task. Raw tokens are absent unless explicitly exposed. */
export interface AccessGrant {
  readonly scheme: ProviderGrant['scheme'];
  readonly headers: Readonly<Record<string, string>>;
  readonly rawToken?: string;
}
