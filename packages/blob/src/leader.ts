/**
 * The store leader (S6): exactly one context per workspace holds the Web Lock
 * `<name>:leader` and owns the writers (journal sync handles, head swaps).
 * Every context commits through `leader.commit(c)`:
 *
 * - the leader batches commits into `session.apply()` (durable, deduped by id)
 *   and broadcasts the durable ids as acks;
 * - followers send commits over BroadcastChannel and **resend until acked**;
 *   when a new leader announces itself they resend everything pending at once.
 *
 * A leader killed mid-write loses nothing that was acknowledged: an ack is
 * only sent after `apply()` resolved, i.e. after the journal flushed. The next
 * leader recovers from the journal before it accepts commits (lifecycle
 * `blob/store-leader`, docs/LIFECYCLES.md).
 */
import { createDeferred, createMachine, createScope, defineMachine, err, ok, type Result } from '@staticflux/core';
import type { BroadcastChannelFactory, BroadcastChannelLike } from '@staticflux/storage';
import { BlobAbortedError, BlobDisposedError, BlobUnavailableError } from './errors.js';
import type { LockManagerLike } from './locks.js';

export const StoreLeaderMachine = /* @__PURE__ */ defineMachine({
  id: 'blob/store-leader',
  initial: 'waiting',
  states: ['waiting', 'recovering', 'leading', 'disposed'],
  transitions: {
    waiting: { acquire: 'recovering', dispose: 'disposed' },
    recovering: { ready: 'leading', fail: 'waiting', dispose: 'disposed' },
    leading: { dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type StoreLeaderState = (typeof StoreLeaderMachine.states)[number];

/** What the leader does with commits once it holds the lock. */
export interface LeaderSession<C> {
  /** Durably apply a batch; resolve with the ids now durable (new and known). */
  apply(batch: readonly C[]): Promise<Result<readonly string[]>>;
  close(): Promise<void>;
}

export interface TimerPort {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: TimerPort = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface StoreLeaderOptions<C> {
  /** Workspace-scoped name, e.g. `iflow:ws_01J…`; lock `<name>:leader`, channel `<name>:commits`. */
  readonly name: string;
  /** This context's peer id (diagnostics). */
  readonly peer: string;
  readonly locks: LockManagerLike;
  readonly channels: BroadcastChannelFactory;
  readonly idOf: (commit: C) => string;
  /** Called on taking the lock: recover and return the session (e.g. open + recover a `LatestStore`). */
  readonly lead: (signal: AbortSignal) => Promise<Result<LeaderSession<C>>>;
  /** Followers resend commits not acked within this time (default 300 ms). */
  readonly resendMs?: number;
  /** Retry delay after a failed `lead()` or `apply()` (default 100 ms). */
  readonly retryMs?: number;
  readonly timers?: TimerPort;
  readonly onError?: (error: unknown, where: 'lead' | 'apply') => void;
}

export interface StoreLeader<C> {
  readonly state: StoreLeaderState;
  readonly isLeader: boolean;
  /** Resolves once the commit is durable (acknowledged by whichever context leads). */
  commit(commit: C, options?: { readonly signal?: AbortSignal }): Promise<Result<void>>;
  /** Commits sent and not yet acknowledged. */
  readonly pending: number;
  onStateChange(listener: (state: StoreLeaderState) => void): () => void;
  /** Release the lock (if held), close the session, fail pending commits with `SF-BLOB-013`. */
  dispose(): Promise<void>;
}

type Message<C> =
  | { readonly t: 'commit'; readonly from: string; readonly c: C }
  | { readonly t: 'ack'; readonly ids: readonly string[] }
  | { readonly t: 'leader'; readonly peer: string };

interface Pending<C> {
  readonly commit: C;
  resolve: (result: Result<void>) => void;
}

export function createStoreLeader<C>(options: StoreLeaderOptions<C>): Result<StoreLeader<C>> {
  const channel: BroadcastChannelLike | undefined = options.channels(`${options.name}:commits`);
  if (channel === undefined) return err(BlobUnavailableError({ message: 'BroadcastChannel is not available; the store leader needs it.' }));
  const timers = options.timers ?? globalTimers;
  const resendMs = options.resendMs ?? 300;
  const retryMs = options.retryMs ?? 100;
  const machine = createMachine(StoreLeaderMachine);
  const pending = new Map<string, Pending<C>>();
  const queue: C[] = [];
  const listeners = new Set<(state: StoreLeaderState) => void>();
  /** Owns the channel listener and timers; its signal stops the campaign. */
  const scope = createScope(`blob/store-leader:${options.peer}`);
  const release = createDeferred<void>();
  let session: LeaderSession<C> | undefined;
  let flushing = false;
  let resendTimer: unknown;

  machine.onTransition(({ to }) => {
    for (const listener of [...listeners]) listener(to);
  });

  const post = (message: Message<C>): void => {
    try {
      channel.postMessage(message);
    } catch {
      // a closed channel during teardown
    }
  };

  const ackLocal = (ids: readonly string[]): void => {
    for (const id of ids) {
      const entry = pending.get(id);
      if (entry === undefined) continue;
      pending.delete(id);
      entry.resolve(ok());
    }
  };

  const flush = async (): Promise<void> => {
    if (flushing || session === undefined) return;
    flushing = true;
    try {
      while (queue.length > 0 && session !== undefined && !scope.signal.aborted) {
        const batch = queue.splice(0, queue.length);
        const applied = await session.apply(batch);
        if (!applied.ok) {
          options.onError?.(applied.error, 'apply');
          queue.unshift(...batch);
          timers.setTimeout(() => void flush(), retryMs);
          return;
        }
        post({ t: 'ack', ids: applied.value });
        ackLocal(applied.value);
      }
    } finally {
      flushing = false;
    }
  };

  const enqueue = (commit: C): void => {
    queue.push(commit);
    void Promise.resolve().then(flush);
  };

  const onMessage = (event: { readonly data: unknown }): void => {
    const message = event.data as Message<C>;
    if (message.t === 'commit') {
      if (machine.state === 'leading') enqueue(message.c);
    } else if (message.t === 'ack') {
      ackLocal(message.ids);
    } else if (message.t === 'leader') {
      if (machine.state === 'leading') return;
      for (const entry of pending.values()) post({ t: 'commit', from: options.peer, c: entry.commit });
    }
  };
  channel.addEventListener('message', onMessage);
  scope.defer(() => {
    channel.removeEventListener('message', onMessage);
    channel.close();
  });

  const scheduleResend = (): void => {
    resendTimer = timers.setTimeout(() => {
      if (scope.signal.aborted) return;
      if (machine.state !== 'leading') {
        for (const entry of pending.values()) post({ t: 'commit', from: options.peer, c: entry.commit });
      }
      scheduleResend();
    }, resendMs);
  };
  scheduleResend();
  scope.defer(() => timers.clearTimeout(resendTimer));

  const campaign = (): void => {
    void options.locks
      .request(`${options.name}:leader`, { mode: 'exclusive', signal: scope.signal }, async () => {
        if (scope.signal.aborted) return;
        machine.send('acquire');
        let opened: Result<LeaderSession<C>>;
        try {
          opened = await options.lead(scope.signal);
        } catch (cause) {
          opened = err(BlobAbortedError({ cause, message: 'lead() threw' }));
        }
        if (!opened.ok) {
          options.onError?.(opened.error, 'lead');
          machine.send('fail');
          if (!scope.signal.aborted) timers.setTimeout(campaign, retryMs);
          return;
        }
        if (scope.signal.aborted) {
          await opened.value.close();
          return;
        }
        session = opened.value;
        machine.send('ready');
        post({ t: 'leader', peer: options.peer });
        for (const entry of pending.values()) queue.push(entry.commit);
        void flush();
        await release.promise;
      })
      .catch(() => undefined);
  };
  campaign();

  return ok({
    get state() {
      return machine.state;
    },
    get isLeader() {
      return machine.state === 'leading';
    },
    get pending() {
      return pending.size;
    },
    commit(commit, commitOptions = {}) {
      if (machine.state === 'disposed') return Promise.resolve(err(BlobDisposedError({ message: 'The store leader was disposed.' })));
      const signal = commitOptions.signal;
      if (signal?.aborted === true) return Promise.resolve(err(BlobAbortedError({ cause: signal.reason })));
      const id = options.idOf(commit);
      const existing = pending.get(id);
      if (existing !== undefined) {
        return new Promise((resolve) => {
          const previous = existing.resolve;
          existing.resolve = (r) => {
            previous(r);
            resolve(r);
          };
        });
      }
      return new Promise<Result<void>>((resolve) => {
        // Aborted to detach the abort listener once the commit settles.
        const detach = new AbortController();
        pending.set(id, {
          commit,
          resolve: (result) => {
            detach.abort();
            resolve(result);
          },
        });
        signal?.addEventListener(
          'abort',
          () => {
            if (pending.get(id)?.commit !== commit) return;
            pending.delete(id);
            detach.abort();
            resolve(err(BlobAbortedError({ cause: signal.reason, message: 'Commit aborted before it was acknowledged; it may still become durable.' })));
          },
          { once: true, signal: detach.signal },
        );
        if (machine.state === 'leading') enqueue(commit);
        else post({ t: 'commit', from: options.peer, c: commit });
      });
    },
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (machine.state === 'disposed') return;
      machine.send('dispose');
      await scope.dispose();
      const open = session;
      session = undefined;
      if (open !== undefined) await open.close();
      release.resolve();
      for (const entry of pending.values()) entry.resolve(err(BlobDisposedError({ message: 'The store leader was disposed before the commit was acknowledged.' })));
      pending.clear();
    },
  });
}
