/**
 * Test fakes for the multi-tab coordinator: an in-memory Web Locks manager and
 * an in-memory BroadcastChannel hub, both with per-tab views so a test can
 * simulate several tabs, a tab crash (locks released, channels closed without
 * a goodbye) and a frozen tab (messages queue until thawed).
 *
 * Test-only: not exported from the package entry.
 */
import type { BroadcastChannelLike, BroadcastFactory, TabLifecyclePort } from './coordinator.js';
import type { LockManagerLike } from './leader.js';

interface LockRequest {
  readonly tab: string;
  readonly name: string;
  readonly callback: (lock: unknown) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  granted: boolean;
  done: boolean;
}

export interface MemoryLocks {
  forTab(tab: string): LockManagerLike;
  /** Current holder of `name`. */
  holder(name: string): string | undefined;
  /** Waiting tabs for `name`, in order. */
  queue(name: string): readonly string[];
  /** The browser closed the tab: its held lock is released and its waiting requests dropped. */
  crashTab(tab: string): void;
}

export function createMemoryLocks(): MemoryLocks {
  const held = new Map<string, LockRequest>();
  const waiting = new Map<string, LockRequest[]>();

  const grantNext = (name: string): void => {
    if (held.has(name)) return;
    const queue = waiting.get(name) ?? [];
    const next = queue.shift();
    if (next === undefined) return;
    next.granted = true;
    held.set(name, next);
    void Promise.resolve()
      .then(() => next.callback({ name }))
      .then(
        (value) => finish(next, () => next.resolve(value)),
        (error: unknown) => finish(next, () => next.reject(error)),
      );
  };

  const finish = (request: LockRequest, settle: () => void): void => {
    if (request.done) return;
    request.done = true;
    if (held.get(request.name) === request) held.delete(request.name);
    settle();
    grantNext(request.name);
  };

  return {
    forTab(tab) {
      return {
        request(name, options, callback) {
          return new Promise((resolve, reject) => {
            const request: LockRequest = { tab, name, callback, resolve, reject, granted: false, done: false };
            const signal = options.signal;
            if (signal?.aborted === true) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener(
              'abort',
              () => {
                if (request.granted || request.done) return;
                request.done = true;
                waiting.set(name, (waiting.get(name) ?? []).filter((r) => r !== request));
                reject(signal.reason);
              },
              { once: true },
            );
            const queue = waiting.get(name) ?? [];
            queue.push(request);
            waiting.set(name, queue);
            queueMicrotask(() => grantNext(name));
          });
        },
      };
    },
    holder: (name) => held.get(name)?.tab,
    queue: (name) => (waiting.get(name) ?? []).map((r) => r.tab),
    crashTab(tab) {
      for (const [name, queue] of waiting) waiting.set(name, queue.filter((r) => r.tab !== tab));
      for (const [name, request] of [...held]) {
        if (request.tab !== tab) continue;
        request.done = true;
        held.delete(name);
        grantNext(name);
      }
    },
  };
}

export interface MemoryBroadcastHub {
  forTab(tab: string): BroadcastFactory;
  /** Queue incoming messages for `tab` until `thaw` (frozen tab). Its own posts are queued too. */
  freeze(tab: string): void;
  thaw(tab: string): void;
  /** Close every channel of `tab` (tab closed without a goodbye). */
  crashTab(tab: string): void;
  /** Inject a raw message on `name` as if sent by `fromTab`. */
  inject(name: string, fromTab: string, message: unknown): void;
  readonly posted: number;
}

interface FakeChannel extends BroadcastChannelLike {
  readonly tab: string;
  readonly name: string;
  readonly closed: boolean;
  receive(data: unknown): void;
}

export function createMemoryBroadcastHub(): MemoryBroadcastHub {
  const channels = new Set<FakeChannel>();
  const frozen = new Map<string, (() => void)[]>();
  let posted = 0;

  const deliver = (name: string, fromTab: string, message: unknown): void => {
    const copy = structuredClone(message);
    for (const channel of [...channels]) {
      if (channel.name !== name || channel.tab === fromTab || channel.closed) continue;
      queueMicrotask(() => channel.receive(copy));
    }
  };

  const factory = (tab: string): BroadcastFactory => (name) => {
    const listeners = new Set<(event: MessageEvent) => void>();
    let closed = false;
    const channel: FakeChannel = {
      tab,
      name,
      get closed() {
        return closed;
      },
      postMessage(message) {
        if (closed) throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
        posted += 1;
        const queue = frozen.get(tab);
        if (queue !== undefined) queue.push(() => deliver(name, tab, message));
        else deliver(name, tab, message);
      },
      receive(data) {
        if (closed) return;
        const queue = frozen.get(tab);
        if (queue !== undefined) {
          queue.push(() => channel.receive(data));
          return;
        }
        const event = { data } as MessageEvent;
        for (const listener of [...listeners]) listener(event);
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
      close() {
        closed = true;
        listeners.clear();
        channels.delete(channel);
      },
    };
    channels.add(channel);
    return channel;
  };

  return {
    forTab: factory,
    freeze(tab) {
      if (!frozen.has(tab)) frozen.set(tab, []);
    },
    thaw(tab) {
      const queue = frozen.get(tab) ?? [];
      frozen.delete(tab);
      for (const run of queue) run();
    },
    crashTab(tab) {
      frozen.delete(tab);
      for (const channel of [...channels]) if (channel.tab === tab) channel.close();
    },
    inject: (name, fromTab, message) => deliver(name, fromTab, message),
    get posted() {
      return posted;
    },
  };
}

export interface FakeTabLifecycle extends TabLifecyclePort {
  suspend(): void;
  resume(): void;
}

export function createFakeTabLifecycle(): FakeTabLifecycle {
  const suspendListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();
  return {
    onSuspend(listener) {
      suspendListeners.add(listener);
      return () => suspendListeners.delete(listener);
    },
    onResume(listener) {
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },
    suspend: () => {
      for (const listener of [...suspendListeners]) listener();
    },
    resume: () => {
      for (const listener of [...resumeListeners]) listener();
    },
  };
}
