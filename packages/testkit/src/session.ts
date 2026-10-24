/**
 * Fake session (R16.3): a controllable `IdentityProvider` + a deterministic
 * `AuthEnvironment` + the REAL auth session store, so tests exercise the actual
 * session machine, listeners, epoch-refresh flags and upgrade hooks.
 *
 *   const session = createFakeSession({ initial: { user: 'ada', roles: ['editor'], plan: 'pro' } });
 *   const t = createTestInjector({ units, overrides: session.units });
 *   await session.ready();             // silent restore done → authenticated as ada
 *   await session.switchAccount('bob'); // principalChanged, requiresEpochRefresh
 *   await session.expire();             // → expired
 *   await session.logout();             // → guest
 *
 * Client-side session state is UX, not security: the fake grants are meaningless strings.
 */
import { type AnyUnit, err, ok, type Result, type SfError, type Telemetry, unit } from '@staticflux/core';
import {
  AuthEnvironmentToken,
  type Credentials,
  createSessionStore,
  createTestAuthEnvironment,
  GuestUpgradeHooksToken,
  type GuestUpgradeHook,
  type IdentityProvider,
  IdentityProviderToken,
  NotAuthenticatedError,
  type Principal,
  type ProviderEvent,
  type ProviderKind,
  type SessionChannel,
  type SessionListener,
  SessionListenersToken,
  type SessionSnapshot,
  type SessionStore,
  SessionToken,
  SessionExpiredError,
  type TestAuthEnvironment,
} from '@staticflux/auth';
import type { FakeClock } from './time.js';

/** A user: an id, or a full principal. */
export type FakeUser = string | Principal;

export interface FakeUserSpec {
  readonly user: FakeUser;
  readonly roles?: readonly string[];
  /** Stored as `principal.claims.plan` (advisory). */
  readonly plan?: string;
  /** Stored as `principal.claims.entitlements` (advisory). */
  readonly entitlements?: readonly string[];
}

export type FakeProviderOperation = 'restore' | 'login' | 'refresh' | 'logout' | 'grant';

export interface FakeIdentityProvider extends IdentityProvider {
  /** The identity the fake "backend" currently recognises (undefined = signed out). */
  readonly identity: Principal | undefined;
  setIdentity(principal: Principal | undefined): void;
  /** Push an external identity event (host bridge / provider push). */
  emit(event: ProviderEvent): void;
  /** Fail the next call of `operation` with `error`. */
  failNext(operation: FakeProviderOperation, error: SfError): void;
  /** Every call, in order. */
  readonly calls: readonly FakeProviderOperation[];
}

export interface FakeIdentityProviderOptions {
  readonly identity?: Principal;
  /** Session lifetime handed to the store (`expiresAt = now + ms`); default: unknown (no expiry timers). */
  readonly expiresInMs?: number;
  readonly now?: () => number;
  /** Default true. */
  readonly refresh?: boolean;
  readonly kind?: ProviderKind;
}

export function toPrincipal(spec: FakeUser | FakeUserSpec): Principal {
  const s: FakeUserSpec = typeof spec === 'string' || !('user' in spec) ? { user: spec } : spec;
  const base: Principal = typeof s.user === 'string' ? { id: s.user, displayName: s.user } : s.user;
  const claims: Record<string, unknown> = { ...base.claims };
  if (s.plan !== undefined) claims['plan'] = s.plan;
  if (s.entitlements !== undefined) claims['entitlements'] = [...s.entitlements];
  return {
    ...base,
    ...(s.roles === undefined ? {} : { roles: [...s.roles] }),
    ...(Object.keys(claims).length === 0 ? {} : { claims }),
  };
}

export function createFakeIdentityProvider(options: FakeIdentityProviderOptions = {}): FakeIdentityProvider {
  let identity = options.identity;
  const now = options.now ?? Date.now;
  const listeners = new Set<(event: ProviderEvent) => void>();
  const failures = new Map<FakeProviderOperation, SfError>();
  const calls: FakeProviderOperation[] = [];
  const credentialsFor = (principal: Principal): Credentials => ({
    principal,
    expiresAt: options.expiresInMs === undefined ? undefined : now() + options.expiresInMs,
    embedded: false,
  });
  const begin = (operation: FakeProviderOperation): SfError | undefined => {
    calls.push(operation);
    const failure = failures.get(operation);
    failures.delete(operation);
    return failure;
  };
  const refreshEnabled = options.refresh ?? true;
  const provider: FakeIdentityProvider = {
    kind: options.kind ?? 'custom',
    id: 'testkit/fake-identity',
    capabilities: { refresh: refreshEnabled, interactive: true, embedded: false, redirect: false },
    get identity() {
      return identity;
    },
    get calls() {
      return calls;
    },
    setIdentity(principal) {
      identity = principal;
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    failNext(operation, error) {
      failures.set(operation, error);
    },
    async restore() {
      const failure = begin('restore');
      if (failure !== undefined) return err(failure);
      return ok(identity === undefined ? undefined : credentialsFor(identity));
    },
    async login() {
      const failure = begin('login');
      if (failure !== undefined) return err(failure);
      if (identity === undefined) return err(NotAuthenticatedError({ message: 'Fake provider: no identity set; call setIdentity() or session.login(user).' }));
      return ok({ kind: 'authenticated', credentials: credentialsFor(identity) });
    },
    async logout() {
      const failure = begin('logout');
      identity = undefined;
      return failure === undefined ? ok() : err(failure);
    },
    async grant(current) {
      const failure = begin('grant');
      if (failure !== undefined) return err(failure);
      return ok({ scheme: 'bearer', headers: { authorization: `Bearer fake-${current.principal.id}` } });
    },
    watch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ...(refreshEnabled
      ? {
          async refresh(current: Credentials): Promise<Result<Credentials>> {
            const failure = begin('refresh');
            if (failure !== undefined) return err(failure);
            if (identity === undefined || identity.id !== current.principal.id) return err(SessionExpiredError());
            return ok(credentialsFor(identity));
          },
        }
      : {}),
  };
  return provider;
}

// ---------------------------------------------------------------- fake session

export interface FakeSessionOptions {
  /** Default `guest`. A user spec means the silent restore finds that user. */
  readonly initial?: 'guest' | FakeUser | FakeUserSpec;
  /** Drive the auth environment's clock/timers from a fake clock (otherwise it has its own). */
  readonly clock?: FakeClock;
  /** Share a channel hub (`createMemoryChannelHub()`) between sessions to simulate tabs. */
  readonly channels?: { open(name: string): SessionChannel };
  readonly expiresInMs?: number;
  /** Provider refresh capability (default true). */
  readonly refresh?: boolean;
}

export interface FakeSession {
  readonly provider: FakeIdentityProvider;
  readonly env: TestAuthEnvironment;
  /**
   * Overrides for `IdentityProviderToken`, `AuthEnvironmentToken` and `SessionToken`. The session
   * unit collects contributed `SessionListenersToken` / `GuestUpgradeHooksToken` like the real one.
   */
  readonly units: readonly AnyUnit[];
  /** The real session store (created on first access, or by the injector). */
  readonly store: SessionStore;
  readonly snapshot: SessionSnapshot;
  /** Wait until the silent restore (or any refresh) has settled. */
  ready(): Promise<SessionSnapshot>;
  /** Sign `user` in (account switch when someone else is signed in). */
  login(user: FakeUser | FakeUserSpec): Promise<SessionSnapshot>;
  logout(): Promise<SessionSnapshot>;
  /** Expire the current session (the provider rejects the refresh). */
  expire(): Promise<SessionSnapshot>;
  /** Another account signed in elsewhere (host / other app): resync to `user` in place. */
  switchAccount(user: FakeUser | FakeUserSpec): Promise<SessionSnapshot>;
  /** Server-side revocation (`revoked` state). */
  revoke(reason?: string): SessionSnapshot;
}

interface AttachOptions {
  readonly listeners?: readonly SessionListener[];
  readonly upgradeHooks?: readonly GuestUpgradeHook[];
  readonly telemetry?: Telemetry;
}

export function createFakeSession(options: FakeSessionOptions = {}): FakeSession {
  const clock = options.clock;
  const env = createTestAuthEnvironment({
    ...(clock === undefined ? {} : { now: () => clock.now(), setTimer: (fn: () => void, ms: number) => clock.setTimer(fn, ms) }),
    ...(options.channels === undefined ? {} : { channels: options.channels }),
  });
  const initial = options.initial ?? 'guest';
  const provider = createFakeIdentityProvider({
    now: () => env.now(),
    ...(initial === 'guest' ? {} : { identity: toPrincipal(initial) }),
    ...(options.expiresInMs === undefined ? {} : { expiresInMs: options.expiresInMs }),
    ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
  });

  let current: SessionStore | undefined;
  const attach = (attachOptions: AttachOptions): SessionStore => {
    if (current !== undefined) {
      // Created standalone first: forward contributed listeners (upgrade hooks are fixed at creation).
      for (const listener of attachOptions.listeners ?? []) current.onChange((change) => listener.onSessionChange(change));
      return current;
    }
    const store = createSessionStore({
      provider,
      env,
      ...(attachOptions.listeners === undefined ? {} : { listeners: attachOptions.listeners }),
      ...(attachOptions.upgradeHooks === undefined ? {} : { upgradeHooks: attachOptions.upgradeHooks }),
      ...(attachOptions.telemetry === undefined ? {} : { telemetry: attachOptions.telemetry }),
    });
    current = store;
    void store.start();
    return store;
  };
  const store = (): SessionStore => current ?? attach({});

  const awaitPrincipal = async (id: string, act: () => void): Promise<SessionSnapshot> => {
    const s = store();
    const changed = new Promise<void>((resolve) => {
      const stop = s.onChange((change) => {
        if (change.to.principal?.id === id && change.to.state === 'authenticated') {
          stop();
          resolve();
        }
      });
    });
    act();
    await changed;
    return s.whenSettled();
  };

  const session: FakeSession = {
    provider,
    env,
    units: [
      unit({ id: 'testkit/fake-identity-provider-unit', provides: IdentityProviderToken, scope: 'app', create: () => provider }),
      unit({ id: 'testkit/fake-auth-environment-unit', provides: AuthEnvironmentToken, scope: 'app', create: () => env }),
      unit({
        id: 'testkit/fake-session-unit',
        provides: SessionToken,
        scope: 'app',
        deps: { required: { listeners: SessionListenersToken, upgradeHooks: GuestUpgradeHooksToken } },
        create: ({ listeners, upgradeHooks }, ctx) => {
          const created = attach({ listeners, upgradeHooks, telemetry: ctx.telemetry });
          ctx.scope.defer(() => {
            created.dispose();
            if (current === created) current = undefined;
          });
          return created;
        },
        description: 'Real session store over the fake identity provider (testkit).',
      }),
    ],
    get store() {
      return store();
    },
    get snapshot() {
      return store().snapshot;
    },
    ready: () => store().whenSettled(),
    async login(user) {
      const principal = toPrincipal(user);
      const s = store();
      await s.whenSettled();
      if (s.isAuthenticated && s.principal?.id !== principal.id) return session.switchAccount(user);
      provider.setIdentity(principal);
      if (s.isAuthenticated) return s.snapshot;
      const result = await s.login();
      if (!result.ok) throw result.error;
      return s.whenSettled();
    },
    async logout() {
      const s = store();
      await s.whenSettled();
      const result = await s.logout();
      provider.setIdentity(undefined);
      if (!result.ok) throw result.error;
      return s.snapshot;
    },
    async expire() {
      const s = store();
      await s.whenSettled();
      if (!s.isAuthenticated) return s.snapshot;
      // The provider no longer recognises the session → refresh is rejected with an `auth` error → expired.
      // (Without refresh capability the store expires the session on refresh by itself.)
      if (provider.capabilities.refresh) provider.failNext('refresh', SessionExpiredError({ message: 'Fake session expired.' }));
      await s.refresh();
      return s.whenSettled();
    },
    async switchAccount(user) {
      const principal = toPrincipal(user);
      const s = store();
      await s.whenSettled();
      if (!s.isAuthenticated) {
        provider.setIdentity(principal);
        const result = await s.login();
        if (!result.ok) throw result.error;
        return s.whenSettled();
      }
      if (s.principal?.id === principal.id) return s.snapshot;
      return awaitPrincipal(principal.id, () => {
        provider.setIdentity(principal);
        provider.emit({ type: 'changed' });
      });
    },
    revoke(reason = 'testkit') {
      store().revoke(reason);
      return store().snapshot;
    },
  };
  return session;
}
