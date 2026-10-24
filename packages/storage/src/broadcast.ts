/**
 * Cross-tab change notifications over BroadcastChannel, for backends without
 * native change events (IndexedDB, OPFS). Messages carry the key only; values
 * are re-read by listeners that need them. Missing BroadcastChannel (older
 * Safari webviews) → no cross-tab events, reported via `available`.
 */
import type { BroadcastChannelFactory, BroadcastChannelLike, StoreChange } from './types.js';

interface ChannelMessage {
  readonly type: 'set' | 'delete' | 'clear';
  readonly key?: string;
}

export interface ChangeBroadcast<V> {
  /** A factory was configured (the channel itself opens lazily). */
  readonly available: boolean;
  publish(change: StoreChange<V>): void;
  listen(emit: (change: StoreChange<V>) => void): () => void;
  close(): void;
}

export function createChangeBroadcast<V>(factory: BroadcastChannelFactory | undefined, name: string): ChangeBroadcast<V> {
  let channel: BroadcastChannelLike | undefined;
  let tried = false;
  const get = (): BroadcastChannelLike | undefined => {
    if (!tried) {
      tried = true;
      try {
        channel = factory?.(name);
      } catch {
        channel = undefined;
      }
    }
    return channel;
  };
  return {
    available: factory !== undefined,
    publish(change) {
      const message: ChannelMessage = change.type === 'clear' ? { type: 'clear' } : { type: change.type, key: change.key };
      try {
        get()?.postMessage(message);
      } catch {
        // notification only
      }
    },
    listen(emit) {
      const target = get();
      if (target === undefined) return () => undefined;
      const onMessage = (event: { readonly data: unknown }): void => {
        const data = event.data as Partial<ChannelMessage> | null;
        if (data === null || typeof data !== 'object') return;
        if (data.type === 'clear') emit({ type: 'clear', origin: 'external' });
        else if ((data.type === 'set' || data.type === 'delete') && typeof data.key === 'string') {
          emit({ type: data.type, key: data.key, origin: 'external' });
        }
      };
      target.addEventListener('message', onMessage);
      return () => target.removeEventListener('message', onMessage);
    },
    close() {
      channel?.close();
      channel = undefined;
      tried = true;
    },
  };
}

/** In-memory BroadcastChannel hub for tests: channels with the same name created by one hub talk to each other. */
export function createBroadcastHub(): BroadcastChannelFactory & { readonly open: number } {
  const channels = new Map<string, Set<BroadcastChannelLike & { listeners: Set<(event: { readonly data: unknown }) => void> }>>();
  let open = 0;
  const factory = (name: string): BroadcastChannelLike => {
    const peers = channels.get(name) ?? new Set();
    channels.set(name, peers);
    const listeners = new Set<(event: { readonly data: unknown }) => void>();
    const self = {
      listeners,
      postMessage(message: unknown) {
        const data = structuredClone(message);
        for (const peer of peers) {
          if (peer === self) continue;
          for (const listener of [...peer.listeners]) queueMicrotask(() => listener({ data }));
        }
      },
      addEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void) {
        listeners.delete(listener);
      },
      close() {
        if (peers.delete(self)) open -= 1;
      },
    };
    peers.add(self);
    open += 1;
    return self;
  };
  return Object.defineProperty(factory, 'open', { get: () => open }) as BroadcastChannelFactory & { readonly open: number };
}
