/**
 * The session store: one reactive session model over any identity provider.
 *
 * - Lifecycle: `sessionMachine` (docs/LIFECYCLES.md §9); every transition is
 *   validated, emits telemetry and a typed `SessionChange` event.
 * - Boot never waits on auth (R6.3): `start()` probes silently; route guards that
 *   need a decision await `whenSettled()`.
 * - Single-flight refresh (core `createSingleFlight`, optionally behind a Web Lock).
 * - Multi-tab sync over an injectable channel (no tokens on the wire); degrades to
 *   single-tab when BroadcastChannel is missing.
 * - Token broker: `withAccessToken(task)` hands out an `AccessGrant` (headers);
 *   raw tokens are stripped unless `exposeRawToken` is set (R6.7).
 *
 * Client-side session state is UX, not security (R6.16): the backend validates
 * every request.
 */
import {
  AbortedError,
  type Machine,
  type Result,
  type SfError,
  type Telemetry,
  anySignal,
  box,
  createMachine,
  createNoopTelemetry,
  createSingleFlight,
  err,
  metric,
  ok,
  toSfError,
  watch,
} from '@staticflux/core';
import type {
  AccessGrant,
  Credentials,
  GuestUpgradeHook,
  IdentityProvider,
  LoginRequest,
  Principal,
  ProviderEvent,
  SessionChange,
  SessionChangeReason,
  SessionListener,
  SessionSnapshot,
  SessionStateName,
} from './contract.js';
import type { AuthEnvironment, SessionChannel } from './environment.js';
import { LoginInProgressError, NotAuthenticatedError, SessionExpiredError, SessionRevokedError } from './errors.js';
import { stableGuestId } from './guest.js';
import { type SessionEvent, sessionMachine } from './machine.js';

const SUBSYSTEM = 'auth/session' as const;
const RETRY_FLOOR_MS = 1_000;
const RETRY_CEILING_MS = 30_000;

/** Metrics produced by the session store (declare them in `informs`). */
export const AuthMetrics = {
  refreshes: metric.counter('auth/session.refreshes', { description: 'Provider refresh calls (after single-flight coalescing).' }),
  refreshFailures: metric.counter('auth/session.refresh-failures'),
  loginDuration: metric.histogram('auth/session.login-duration', { unit: 'ms' }),
  transitions: metric.counter('auth/session.transitions'),
} as const;

export const DEFAULT_SESSION_CHANNEL = 'sf-auth/session';

export interface SessionStoreOptions {
  readonly provider: IdentityProvider;
  readonly env: AuthEnvironment;
  readonly telemetry?: Telemetry;
  readonly listeners?: readonly SessionListener[];
  readonly upgradeHooks?: readonly GuestUpgradeHook[];
  /** BroadcastChannel name for multi-tab sync. */
  readonly channelName?: string;
  /** Refresh this long before `expiresAt`. Default 60 s. */
  readonly refreshLeewayMs?: number;
  /** Hand raw tokens to `withAccessToken` tasks. Default false — keep it that way unless a third-party SDK demands a token. */
  readonly exposeRawToken?: boolean;
}

export type LoginResult =
  | { readonly kind: 'authenticated'; readonly principal: Principal }
  | { readonly kind: 'redirecting'; readonly url: string };

export interface StartOutcome {
  /** Deep-link intent restored from a login callback — the router should navigate here (replace). */
  readonly returnTo: string | undefined;
  /** A callback was present but failed (state mismatch, access_denied…). The session is guest. */
  readonly callbackError: SfError | undefined;
}

export interface SessionStore {
  /** Current snapshot (reactive). */
  readonly snapshot: SessionSnapshot;
  readonly state: SessionStateName;
  readonly principal: Principal | undefined;
  /** `authenticated` or `refreshing`. */
  readonly isAuthenticated: boolean;
  readonly embedded: boolean;
  readonly guestId: string;
  readonly provider: IdentityProvider;
  /** The underlying machine (devtools). */
  readonly machine: Machine<SessionStateName, SessionEvent>;
  /** Handle a login callback if present, else probe silently. Never blocks boot unless awaited. */
  start(signal?: AbortSignal): Promise<Result<StartOutcome>>;
  /** Resolve once the session is not authenticating/refreshing (and `start` finished). */
  whenSettled(signal?: AbortSignal): Promise<SessionSnapshot>;
  login(request?: LoginRequest, signal?: AbortSignal): Promise<Result<LoginResult>>;
  /** Complete a redirect login. `handled: false` when `url` is not a callback. */
  completeLogin(url?: string, signal?: AbortSignal): Promise<Result<{ readonly handled: boolean; readonly returnTo: string | undefined }>>;
  /** Single-flight refresh. Auth failures expire the session. */
  refresh(signal?: AbortSignal): Promise<Result<void>>;
  /** Ends the session locally always; returns the provider's (server) logout outcome. */
  logout(signal?: AbortSignal): Promise<Result<void>>;
  /** A backend answered 401: refresh once (single-flight), expire on failure. */
  reportUnauthorized(signal?: AbortSignal): Promise<Result<void>>;
  /** Server push / 403 says the session is revoked (R6.14). */
  revoke(reason: string): void;
  /** Token broker: run `task` with request authorization; on an `auth` error refresh once and retry. */
  withAccessToken<T>(task: (grant: AccessGrant, signal: AbortSignal) => Promise<Result<T>>, signal?: AbortSignal): Promise<Result<T>>;
  onChange(listener: (change: SessionChange) => void): () => void;
  dispose(): void;
}

interface SyncMessage {
  readonly v: 1;
  readonly kind: 'sf-auth/session';
  readonly type: 'login' | 'logout' | 'refresh' | 'revoke';
  readonly tab: string;
  readonly principal: string | undefined;
}

function isSyncMessage(value: unknown): value is SyncMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<SyncMessage>;
  return m.v === 1 && m.kind === 'sf-auth/session' && typeof m.tab === 'string' && ['login', 'logout', 'refresh', 'revoke'].includes(m.type ?? '');
}

const principalKey = (s: SessionSnapshot): string => (s.principal === undefined ? `guest:${s.guestId}` : `user:${s.principal.id}`);

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const { provider, env } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const leeway = options.refreshLeewayMs ?? 60_000;
  const guestId = stableGuestId(env);
  const internal = new AbortController();
  const machine = createMachine(sessionMachine, {
    onInvalid: (state, event) =>
      telemetry.event('lifecycle.session.invalid', { subsystem: SUBSYSTEM, level: 'critical', attrs: { state, event } }),
  });
  const guestSnapshot = (): SessionSnapshot => ({ state: 'guest', guestId, provider: provider.kind, principal: undefined });
  const snapshotBox = box<SessionSnapshot>(guestSnapshot());
  const localListeners = new Set<(change: SessionChange) => void>();
  const flights = createSingleFlight<'refresh' | 'resync', void>();
  const tabId = `tab-${Math.floor(env.now()).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let credentials: Credentials | undefined;
  let timers: (() => void)[] = [];
  let lastRefreshFailed = false;
  let channel: SessionChannel | undefined;
  let unsubscribers: (() => void)[] = [];
  let starting: Promise<Result<StartOutcome>> | undefined;
  let disposed = false;

  const authenticatedSnapshot = (state: 'authenticated' | 'refreshing', creds: Credentials): SessionSnapshot => ({
    state,
    guestId,
    provider: provider.kind,
    principal: creds.principal,
    expiresAt: creds.expiresAt,
    embedded: creds.embedded,
  });

  // ------------------------------------------------------------ transitions

  const broadcast = (type: SyncMessage['type'], to: SessionSnapshot): void => {
    channel?.post({ v: 1, kind: 'sf-auth/session', type, tab: tabId, principal: to.principal?.id } satisfies SyncMessage);
  };

  const transition = (event: SessionEvent, next: SessionSnapshot, reason: SessionChangeReason, sync?: SyncMessage['type']): Result<void> => {
    const from = snapshotBox.get();
    const sent = machine.send(event);
    if (!sent.ok) return sent;
    snapshotBox.set(next);
    const principalChanged = principalKey(from) !== principalKey(next);
    const change: SessionChange = {
      type: 'session-changed',
      reason,
      from,
      to: next,
      principalChanged,
      requiresEpochRefresh:
        principalChanged || next.state === 'revoked' || (from.state === 'authenticating' && next.state === 'authenticated'),
    };
    telemetry.event(`lifecycle.session.${from.state}→${next.state}`, {
      subsystem: SUBSYSTEM,
      level: 'verbose',
      attrs: { reason, event, principalChanged, provider: provider.kind },
    });
    telemetry.record(AuthMetrics.transitions, 1, { to: next.state });
    scheduleExpiry(next);
    for (const listener of [...(options.listeners ?? []), ...localListeners]) {
      try {
        if (typeof listener === 'function') listener(change);
        else listener.onSessionChange(change);
      } catch (error) {
        telemetry.event('session.listener-failed', {
          subsystem: SUBSYSTEM,
          level: 'critical',
          attrs: { listener: typeof listener === 'function' ? 'local' : listener.id, error: toSfError(error).message },
        });
      }
    }
    if (sync !== undefined) broadcast(sync, next);
    return ok();
  };

  const scheduleExpiry = (snapshot: SessionSnapshot): void => {
    for (const cancel of timers) cancel();
    timers = [];
    if (snapshot.state !== 'authenticated' || snapshot.expiresAt === undefined) return;
    const remaining = snapshot.expiresAt - env.now();
    timers.push(env.setTimer(() => expireNow('timer'), Math.max(0, remaining)));
    if (!provider.capabilities.refresh || provider.refresh === undefined || remaining <= 0) return;
    // After a transient refresh failure retry with a bounded delay instead of spinning.
    const delay = lastRefreshFailed ? Math.max(RETRY_FLOOR_MS, Math.min(RETRY_CEILING_MS, remaining / 2)) : remaining - leeway;
    timers.push(env.setTimer(() => void refresh(internal.signal), Math.max(0, delay)));
  };

  const expireNow = (cause: string): void => {
    const current = snapshotBox.get();
    if (current.state !== 'authenticated' && current.state !== 'refreshing') return;
    credentials = undefined;
    transition('expire', { state: 'expired', guestId, provider: provider.kind, principal: current.principal }, 'expire');
    telemetry.event('session.expired', { subsystem: SUBSYSTEM, level: 'standard', attrs: { cause } });
  };

  const toGuestLocally = (event: 'logout' | 'fail', reason: SessionChangeReason, sync?: SyncMessage['type']): void => {
    credentials = undefined;
    provider.clear?.();
    if (snapshotBox.get().state === 'guest') return;
    transition(event, guestSnapshot(), reason, sync);
  };

  const runUpgradeHooks = async (phase: 'before' | 'after', principal: Principal | undefined, signal: AbortSignal): Promise<void> => {
    for (const hook of options.upgradeHooks ?? []) {
      try {
        const result =
          phase === 'before'
            ? await hook.beforeUpgrade?.({ guestId }, signal)
            : principal === undefined
              ? undefined
              : await hook.afterUpgrade?.({ guestId, principal }, signal);
        if (result !== undefined && !result.ok) throw result.error;
      } catch (error) {
        // Non-fatal: a failed handoff must not block login. Reported for devtools.
        telemetry.event('session.upgrade-hook-failed', {
          subsystem: SUBSYSTEM,
          level: 'critical',
          attrs: { hook: hook.id, phase, error: toSfError(error).message },
        });
      }
    }
  };

  /** authenticating → authenticated (+ guest upgrade hooks when coming from a guest). */
  const succeed = async (creds: Credentials, reason: SessionChangeReason, fromGuest: boolean, signal: AbortSignal): Promise<Result<void>> => {
    credentials = creds;
    const done = transition('succeed', authenticatedSnapshot('authenticated', creds), reason, reason === 'restore' ? undefined : 'login');
    if (!done.ok) return done;
    if (fromGuest) await runUpgradeHooks('after', creds.principal, signal);
    return ok();
  };

  // ------------------------------------------------------------ operations

  const restoreSilently = async (signal: AbortSignal, reason: SessionChangeReason): Promise<Result<void>> => {
    const span = telemetry.span('session.restore', { subsystem: SUBSYSTEM, level: 'standard', attrs: { provider: provider.kind, reason } });
    const before = snapshotBox.get();
    const fromGuest = before.state === 'guest';
    const started = transition('restore', { state: 'authenticating', guestId, provider: provider.kind, principal: before.principal, silent: true }, reason);
    if (!started.ok) {
      span.end('error', started.error);
      return started;
    }
    const restored = await provider.restore(signal);
    if (!restored.ok || restored.value === undefined) {
      toGuestLocally('fail', reason);
      if (!restored.ok) {
        span.end(restored.error.kind === 'aborted' ? 'cancelled' : 'error', restored.error);
        return restored;
      }
      span.end('ok');
      return ok();
    }
    const done = await succeed(restored.value, reason, fromGuest, signal);
    span.end(done.ok ? 'ok' : 'error', done.ok ? undefined : done.error);
    return done;
  };

  const completeLogin: SessionStore['completeLogin'] = async (url = env.currentUrl(), signal = internal.signal) => {
    if (provider.handleCallback === undefined) return ok({ handled: false, returnTo: undefined });
    const state = snapshotBox.get().state;
    if (state !== 'guest' && state !== 'expired' && state !== 'revoked') return ok({ handled: false, returnTo: undefined });
    const span = telemetry.span('session.callback', { subsystem: SUBSYSTEM, level: 'standard', attrs: { provider: provider.kind } });
    const outcome = await provider.handleCallback(url, signal);
    if (!outcome.ok) {
      span.end('error', outcome.error);
      return outcome;
    }
    if (outcome.value === undefined) {
      span.end('ok');
      return ok({ handled: false, returnTo: undefined });
    }
    const before = snapshotBox.get();
    const started = transition('login', { state: 'authenticating', guestId, provider: provider.kind, principal: before.principal, silent: false }, 'callback');
    if (!started.ok) {
      span.end('error', started.error);
      return started;
    }
    const done = await succeed(outcome.value.credentials, 'callback', true, signal);
    span.end(done.ok ? 'ok' : 'error', done.ok ? undefined : done.error);
    return done.ok ? ok({ handled: true, returnTo: outcome.value.returnTo }) : done;
  };

  const refresh: SessionStore['refresh'] = (signal = internal.signal) => {
    const current = snapshotBox.get();
    if (current.state !== 'authenticated' && !(current.state === 'refreshing' && flights.inFlight('refresh'))) {
      if (current.state === 'expired') return Promise.resolve(err(SessionExpiredError()));
      if (current.state === 'revoked') return Promise.resolve(err(SessionRevokedError()));
      return Promise.resolve(err(NotAuthenticatedError()));
    }
    return flights.run('refresh', (flightSignal) => runRefresh(flightSignal), anySignal(signal, internal.signal));
  };

  const runRefresh = async (signal: AbortSignal): Promise<Result<void>> => {
    const previous = credentials;
    const current = snapshotBox.get();
    if (previous === undefined || current.state !== 'authenticated') return err(NotAuthenticatedError());
    if (provider.refresh === undefined || !provider.capabilities.refresh) {
      expireNow('no-refresh');
      return err(SessionExpiredError());
    }
    const span = telemetry.span('session.refresh', { subsystem: SUBSYSTEM, level: 'standard', attrs: { provider: provider.kind } });
    transition('refresh', authenticatedSnapshot('refreshing', previous), 'refresh');
    telemetry.record(AuthMetrics.refreshes, 1, { provider: provider.kind });
    const call = (): Promise<Result<Credentials>> => (provider.refresh as NonNullable<IdentityProvider['refresh']>)(previous, signal);
    let result: Result<Credentials>;
    try {
      result = env.lock === undefined ? await call() : await env.lock('sf-auth/refresh', call);
    } catch (error) {
      result = err(toSfError(error));
    }
    lastRefreshFailed = !result.ok && result.error.kind !== 'auth' && result.error.kind !== 'forbidden';
    if (result.ok) {
      credentials = result.value;
      transition('refreshed', authenticatedSnapshot('authenticated', result.value), 'refresh', 'refresh');
      span.end('ok');
      return ok();
    }
    telemetry.record(AuthMetrics.refreshFailures, 1, { kind: result.error.kind });
    span.end(result.error.kind === 'aborted' ? 'cancelled' : 'error', result.error);
    if (result.error.kind === 'forbidden') {
      revoke('refresh-forbidden');
      return err(SessionRevokedError({ cause: result.error }));
    }
    if (result.error.kind === 'auth') {
      expireNow('refresh-rejected');
      return err(SessionExpiredError({ cause: result.error }));
    }
    // Transient (network/5xx/aborted): keep the session; expire only if it is past due.
    transition('refreshed', authenticatedSnapshot('authenticated', previous), 'refresh');
    if (previous.expiresAt !== undefined && env.now() >= previous.expiresAt) {
      expireNow('refresh-unavailable');
      return err(SessionExpiredError({ cause: result.error }));
    }
    return err(result.error);
  };

  const revoke: SessionStore['revoke'] = (reason) => {
    const current = snapshotBox.get();
    if (current.state !== 'authenticated' && current.state !== 'refreshing') return;
    credentials = undefined;
    provider.clear?.();
    transition('revoke', { state: 'revoked', guestId, provider: provider.kind, principal: current.principal, reason }, 'revoke', 'revoke');
  };

  /** Re-read identity after another tab or the host reported a change. */
  const resync = (reason: SessionChangeReason): Promise<Result<void>> =>
    flights.run(
      'resync',
      async (signal) => {
        const current = snapshotBox.get();
        if (current.state === 'guest' || current.state === 'expired') return restoreSilently(signal, reason);
        if (current.state !== 'authenticated' || credentials === undefined) return ok();
        const restored = await provider.restore(signal);
        if (!restored.ok) return restored;
        if (restored.value === undefined) {
          toGuestLocally('logout', reason);
          return ok();
        }
        // Same states, possibly a different principal (account switch elsewhere).
        transition('refresh', authenticatedSnapshot('refreshing', credentials), reason);
        credentials = restored.value;
        transition('refreshed', authenticatedSnapshot('authenticated', restored.value), reason);
        return ok();
      },
      internal.signal,
    );

  const onSync = (message: unknown): void => {
    if (disposed || !isSyncMessage(message) || message.tab === tabId) return;
    const current = snapshotBox.get();
    if (message.type === 'logout' || message.type === 'revoke') {
      if (message.type === 'revoke' && (current.state === 'authenticated' || current.state === 'refreshing')) {
        credentials = undefined;
        provider.clear?.();
        transition('revoke', { state: 'revoked', guestId, provider: provider.kind, principal: current.principal, reason: 'other-tab' }, 'sync');
        return;
      }
      if (current.state !== 'guest' && current.state !== 'authenticating') toGuestLocally('logout', 'sync');
      return;
    }
    if (current.state === 'authenticated' && current.principal.id === message.principal && message.type === 'refresh') return;
    if (current.state === 'authenticated' && current.principal.id === message.principal) return;
    if (current.state === 'authenticating' || current.state === 'refreshing') return;
    void resync('sync');
  };

  const onProviderEvent = (event: ProviderEvent): void => {
    if (disposed) return;
    if (event.type === 'revoked') revoke(event.reason);
    else if (event.type === 'signed-out') toGuestLocally('logout', 'host', 'logout');
    else void resync('host');
  };

  const store: SessionStore = {
    get snapshot() {
      return snapshotBox.get();
    },
    get state() {
      return snapshotBox.get().state;
    },
    get principal() {
      return snapshotBox.get().principal;
    },
    get isAuthenticated() {
      const s = snapshotBox.get().state;
      return s === 'authenticated' || s === 'refreshing';
    },
    get embedded() {
      const s = snapshotBox.get();
      return (s.state === 'authenticated' || s.state === 'refreshing') && s.embedded;
    },
    guestId,
    provider,
    machine,

    start(signal = internal.signal) {
      if (starting !== undefined) return starting;
      channel = env.openChannel(options.channelName ?? DEFAULT_SESSION_CHANNEL);
      if (channel !== undefined) unsubscribers.push(channel.subscribe(onSync));
      if (provider.watch !== undefined) unsubscribers.push(provider.watch(onProviderEvent));
      const combined = anySignal(signal, internal.signal);
      starting = (async (): Promise<Result<StartOutcome>> => {
        let callbackError: SfError | undefined;
        // Without a callback handler the silent probe starts synchronously (state is `authenticating` immediately).
        if (provider.handleCallback !== undefined) {
          const callback = await completeLogin(env.currentUrl(), combined);
          if (callback.ok && callback.value.handled) return ok({ returnTo: callback.value.returnTo, callbackError: undefined });
          if (!callback.ok) callbackError = callback.error;
        }
        const restored = await restoreSilently(combined, 'restore');
        if (!restored.ok) return restored;
        return ok({ returnTo: undefined, callbackError });
      })();
      return starting;
    },

    async whenSettled(signal) {
      if (starting !== undefined) await starting;
      const settled = (): boolean => {
        const s = snapshotBox.get().state;
        return s !== 'authenticating' && s !== 'refreshing';
      };
      if (settled() || signal?.aborted === true) return snapshotBox.get();
      return new Promise<SessionSnapshot>((resolve) => {
        // Aborted to detach the abort listener once the session settles.
        const detach = new AbortController();
        const stop = watch(
          () => settled(),
          (isSettled) => {
            if (!isSettled) return;
            stop();
            detach.abort();
            resolve(snapshotBox.get());
          },
        );
        const onAbort = (): void => {
          stop();
          resolve(snapshotBox.get());
        };
        signal?.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
      });
    },

    async login(request = {}, signal = internal.signal) {
      const current = snapshotBox.get();
      if (current.state === 'authenticating') return err(LoginInProgressError());
      if (current.state === 'authenticated' || current.state === 'refreshing') return ok({ kind: 'authenticated', principal: current.principal });
      const started = telemetry.now();
      const span = telemetry.span('session.login', { subsystem: SUBSYSTEM, level: 'standard', attrs: { provider: provider.kind } });
      const fromGuest = current.state === 'guest';
      if (fromGuest) await runUpgradeHooks('before', undefined, signal);
      const begun = transition('login', { state: 'authenticating', guestId, provider: provider.kind, principal: current.principal, silent: false }, 'login');
      if (!begun.ok) {
        span.end('error', begun.error);
        return begun;
      }
      const outcome = await provider.login(request, signal);
      if (!outcome.ok) {
        toGuestLocally('fail', 'login');
        span.end(outcome.error.kind === 'aborted' ? 'cancelled' : 'error', outcome.error);
        return outcome;
      }
      if (outcome.value.kind === 'redirect') {
        span.set('redirect', true);
        span.end('ok');
        env.navigate(outcome.value.url);
        return ok({ kind: 'redirecting', url: outcome.value.url });
      }
      const done = await succeed(outcome.value.credentials, 'login', fromGuest, signal);
      telemetry.record(AuthMetrics.loginDuration, telemetry.now() - started, { provider: provider.kind });
      span.end(done.ok ? 'ok' : 'error', done.ok ? undefined : done.error);
      return done.ok ? ok({ kind: 'authenticated', principal: outcome.value.credentials.principal }) : done;
    },

    completeLogin,
    refresh,

    async logout(signal = internal.signal) {
      const current = snapshotBox.get();
      if (current.state === 'guest') return ok();
      const span = telemetry.span('session.logout', { subsystem: SUBSYSTEM, level: 'standard', attrs: { provider: provider.kind } });
      const previous = credentials;
      toGuestLocally('logout', 'logout', 'logout');
      const result = await provider.logout(previous, signal);
      span.end(result.ok ? 'ok' : 'error', result.ok ? undefined : result.error);
      return result;
    },

    reportUnauthorized(signal = internal.signal) {
      const state = snapshotBox.get().state;
      if (state !== 'authenticated' && state !== 'refreshing') return Promise.resolve(err(NotAuthenticatedError()));
      return refresh(signal);
    },

    revoke,

    async withAccessToken<T>(
      task: (grant: AccessGrant, signal: AbortSignal) => Promise<Result<T>>,
      signal: AbortSignal = internal.signal,
    ): Promise<Result<T>> {
      const attemptOnce = async (allowRetry: boolean): Promise<Result<T>> => {
        if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
        if (snapshotBox.get().state === 'refreshing') await refresh(signal);
        const current = snapshotBox.get();
        if (current.state === 'expired') return err(SessionExpiredError());
        if (current.state === 'revoked') return err(SessionRevokedError());
        if (current.state !== 'authenticated' || credentials === undefined) return err(NotAuthenticatedError());
        const granted = await provider.grant(credentials, signal);
        if (!granted.ok) return granted;
        const grant: AccessGrant =
          options.exposeRawToken === true && granted.value.rawToken !== undefined
            ? { scheme: granted.value.scheme, headers: granted.value.headers, rawToken: granted.value.rawToken }
            : { scheme: granted.value.scheme, headers: granted.value.headers };
        const result = await task(grant, signal);
        if (!result.ok && result.error.kind === 'auth' && allowRetry) {
          const refreshed = await refresh(signal);
          if (!refreshed.ok) return result;
          return attemptOnce(false);
        }
        return result;
      };
      return attemptOnce(true);
    },

    onChange(listener) {
      localListeners.add(listener);
      return () => localListeners.delete(listener);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      internal.abort(new DOMException('Session store disposed', 'AbortError'));
      for (const cancel of timers) cancel();
      timers = [];
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers = [];
      channel?.close();
      provider.dispose?.();
      localListeners.clear();
    },
  };
  return store;
}
