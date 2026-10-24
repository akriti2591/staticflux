/**
 * Everything auth needs from the browser, behind one injectable port so tests are
 * deterministic and missing APIs (Safari private mode storage, no BroadcastChannel,
 * no WebCrypto outside secure contexts, sandboxed embed iframes) degrade cleanly.
 */

/** Minimal key/value storage (subset of `Storage`). Implementations must not throw. */
export interface KeyValueStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** A BroadcastChannel-like pub/sub port used for multi-tab session sync. */
export interface SessionChannel {
  post(message: unknown): void;
  subscribe(listener: (message: unknown) => void): () => void;
  close(): void;
}

export interface AuthEnvironment {
  now(): number;
  /** Schedule `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Cryptographically strong random bytes. Undefined when WebCrypto is missing. */
  readonly randomBytes: ((length: number) => Uint8Array) | undefined;
  /** WebCrypto digest (SHA-256 for PKCE). Undefined outside secure contexts. */
  readonly subtle: Pick<SubtleCrypto, 'digest'> | undefined;
  /** Survives reloads (guest id). Undefined when storage is blocked. */
  readonly persistentStorage: KeyValueStorage | undefined;
  /** Survives a same-tab redirect (PKCE verifier + state). Undefined when blocked. */
  readonly transientStorage: KeyValueStorage | undefined;
  /** Open a channel for multi-tab sync; undefined when BroadcastChannel is unavailable. */
  openChannel(name: string): SessionChannel | undefined;
  /** Full-page navigation (login redirects). */
  navigate(url: string): void;
  currentUrl(): string;
  /** Cross-tab mutual exclusion (Web Locks). Undefined → in-tab single-flight only. */
  readonly lock: (<T>(name: string, fn: () => Promise<T>) => Promise<T>) | undefined;
}

/** In-memory storage (tests, and fallback when browser storage throws). */
export function memoryStorage(initial: Readonly<Record<string, string>> = {}): KeyValueStorage & {
  readonly entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
    },
    remove: (key) => {
      entries.delete(key);
    },
  };
}

/** Wrap a Web Storage object; returns undefined when it is missing or throws on access (Safari private mode). */
export function webStorage(get: () => Storage | undefined): KeyValueStorage | undefined {
  let storage: Storage | undefined;
  try {
    storage = get();
    if (storage === undefined) return undefined;
    const probe = '__sf_auth_probe__';
    storage.setItem(probe, probe);
    storage.removeItem(probe);
  } catch {
    return undefined;
  }
  const target = storage;
  return {
    get(key) {
      try {
        return target.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        target.setItem(key, value);
      } catch {
        // quota / blocked: degrade silently (state stays in memory)
      }
    },
    remove(key) {
      try {
        target.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

/** Adapt a `BroadcastChannel` constructor to `SessionChannel`. Undefined when unsupported. */
export function broadcastChannelPort(
  name: string,
  scope: { readonly BroadcastChannel?: new (name: string) => BroadcastChannel } = globalThis as never,
): SessionChannel | undefined {
  const Ctor = scope.BroadcastChannel;
  if (typeof Ctor !== 'function') return undefined;
  let channel: BroadcastChannel;
  try {
    channel = new Ctor(name);
  } catch {
    return undefined;
  }
  return {
    post(message) {
      try {
        channel.postMessage(message);
      } catch {
        // structured-clone failure or closed channel: sync is best-effort
      }
    },
    subscribe(listener) {
      const handler = (event: MessageEvent): void => listener(event.data);
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    },
    close() {
      channel.close();
    },
  };
}

/**
 * In-process channel hub: every channel opened with the same name receives the
 * others' messages (not its own) — like BroadcastChannel across tabs. For tests and
 * for hosts without BroadcastChannel that still run several app instances.
 */
export function createMemoryChannelHub(): { open(name: string): SessionChannel } {
  const rooms = new Map<string, Set<(message: unknown, from: object) => void>>();
  return {
    open(name) {
      const self = {};
      const listeners = new Set<(message: unknown) => void>();
      const deliver = (message: unknown, from: object): void => {
        if (from === self) return;
        for (const listener of [...listeners]) listener(structuredClone(message));
      };
      const room = rooms.get(name) ?? new Set();
      rooms.set(name, room);
      room.add(deliver);
      return {
        post(message) {
          for (const peer of [...room]) peer(message, self);
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close() {
          room.delete(deliver);
          listeners.clear();
        },
      };
    },
  };
}

/** Feature-detected browser environment. Every missing capability becomes `undefined`. */
export function browserAuthEnvironment(): AuthEnvironment {
  const g = globalThis as {
    crypto?: Crypto;
    localStorage?: Storage;
    sessionStorage?: Storage;
    location?: Location;
    navigator?: { locks?: { request(name: string, fn: () => Promise<unknown>): Promise<unknown> } };
  };
  const cryptoObject = g.crypto;
  const locks = g.navigator?.locks;
  return {
    now: () => Date.now(),
    setTimer(fn, ms) {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    randomBytes:
      typeof cryptoObject?.getRandomValues === 'function'
        ? (length) => cryptoObject.getRandomValues(new Uint8Array(length))
        : undefined,
    subtle: cryptoObject?.subtle ?? undefined,
    persistentStorage: webStorage(() => g.localStorage),
    transientStorage: webStorage(() => g.sessionStorage),
    openChannel: (name) => broadcastChannelPort(name),
    navigate(url) {
      g.location?.assign(url);
    },
    currentUrl: () => g.location?.href ?? '',
    lock: locks === undefined ? undefined : <T,>(name: string, fn: () => Promise<T>) => locks.request(name, fn) as Promise<T>,
  };
}

/** Deterministic environment for tests: manual clock, seeded random bytes, memory storage. */
export interface TestAuthEnvironment extends AuthEnvironment {
  /** Advance the manual clock, firing due timers in order. */
  advance(ms: number): void;
  readonly navigations: string[];
  url: string;
}

export function createTestAuthEnvironment(
  overrides: Partial<AuthEnvironment> & { readonly start?: number; readonly channels?: { open(name: string): SessionChannel } } = {},
): TestAuthEnvironment {
  let time = overrides.start ?? 1_000_000;
  let seed = 1;
  let timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const navigations: string[] = [];
  const env: TestAuthEnvironment = {
    now: () => time,
    setTimer(fn, ms) {
      timerId += 1;
      const id = timerId;
      timers.set(id, { at: time + Math.max(0, ms), fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
        if (next === undefined) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].fn();
      }
      time = target;
    },
    randomBytes: (length) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        out[i] = seed % 256;
      }
      return out;
    },
    subtle: (globalThis.crypto as Crypto | undefined)?.subtle,
    persistentStorage: memoryStorage(),
    transientStorage: memoryStorage(),
    openChannel: (name) => overrides.channels?.open(name),
    navigate(url) {
      navigations.push(url);
    },
    currentUrl: () => env.url,
    lock: undefined,
    navigations,
    url: 'https://app.test/',
  };
  const { start: _start, channels: _channels, ...rest } = overrides;
  return Object.assign(env, rest);
}
