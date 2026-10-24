/**
 * Session-scope injector helper (R2.7): keeps one `session`-level child injector per
 * principal. Logging out, revocation, or an account switch disposes the child — and
 * with it every session-scoped unit (stores, subscriptions, caches).
 *
 * The key is `user:<id>` while a user is known (authenticated, refreshing, expired —
 * expiry keeps state so re-login as the same user resumes), and `guest:<guestId>`
 * for guests (unless `includeGuest: false`). `authenticating` keeps the current key,
 * so guest state survives until the upgrade completes (R6.4).
 */
import { type Box, type Injector, type Registration, box, watch } from '@staticflux/core';
import type { SessionSnapshot } from './contract.js';
import type { SessionStore } from './session.js';

export interface SessionScopeOptions {
  /** The app-level (or any longer-lived) injector to create children of. */
  readonly injector: Injector;
  readonly session: Pick<SessionStore, 'snapshot'>;
  /** Session-scoped units registered in each child. */
  readonly units: readonly Registration[];
  /** Also create a session scope for guests. Default true. */
  readonly includeGuest?: boolean;
  /** Called after a child is created (e.g. to resolve critical session units). */
  readonly onCreated?: (child: Injector, key: string) => void;
}

export interface SessionScopeHost {
  /** The current session injector (reactive). Undefined while no scope applies. */
  readonly injector: Injector | undefined;
  readonly key: string | undefined;
  /** Resolves when pending disposals/creations have settled. */
  settled(): Promise<void>;
  dispose(): Promise<void>;
}

export function sessionScopeKey(snapshot: SessionSnapshot, previous: string | undefined, includeGuest: boolean): string | undefined {
  switch (snapshot.state) {
    case 'authenticated':
    case 'refreshing':
    case 'expired':
      return `user:${snapshot.principal.id}`;
    case 'authenticating':
      return previous;
    case 'revoked':
      return undefined;
    case 'guest':
      return includeGuest ? `guest:${snapshot.guestId}` : undefined;
  }
}

export function createSessionScope(options: SessionScopeOptions): SessionScopeHost {
  const includeGuest = options.includeGuest ?? true;
  const current: Box<{ key: string | undefined; injector: Injector | undefined }> = box({ key: undefined, injector: undefined });
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;

  const apply = (key: string | undefined): void => {
    queue = queue.then(async () => {
      const active = current.get();
      if (active.key === key) return;
      if (active.injector !== undefined) {
        current.set({ key: undefined, injector: undefined });
        await active.injector.dispose();
      }
      if (key === undefined || disposed) return;
      const child = options.injector.child('session', `session:${key}`, options.units);
      current.set({ key, injector: child });
      options.onCreated?.(child, key);
    });
  };

  let lastKey: string | undefined;
  const stop = watch(
    () => sessionScopeKey(options.session.snapshot, lastKey, includeGuest),
    (key) => {
      lastKey = key;
      apply(key);
    },
    { fireImmediately: true },
  );

  return {
    get injector() {
      return current.get().injector;
    },
    get key() {
      return current.get().key;
    },
    settled: () => queue,
    async dispose() {
      if (disposed) return queue;
      disposed = true;
      stop();
      apply(undefined);
      return queue;
    },
  };
}
