/**
 * Deterministic `PlatformEnv` for tests (R16.3 "fake platform"). Media queries,
 * viewport, connectivity and connection info are controllable; listener counts
 * are exposed so tests can assert scope-bound cleanup.
 */
import type { ListenableLike, MediaQueryListLike, NavigatorLike, NetworkInformationLike, PlatformEnv, WindowLike } from './env.js';

export interface FakePlatformEnvOptions {
  readonly width?: number;
  readonly height?: number;
  readonly devicePixelRatio?: number;
  readonly search?: string;
  /** Media queries that match initially, e.g. `['(pointer: fine)', '(hover: hover)']`. */
  readonly media?: readonly string[];
  readonly navigator?: Partial<Omit<NavigatorLike, 'connection'>>;
  /** `undefined` = no Network Information API (Safari/Firefox). */
  readonly connection?: Omit<NetworkInformationLike, 'addEventListener' | 'removeEventListener'>;
  readonly globals?: Readonly<Record<string, unknown>>;
  readonly embedded?: boolean;
  /** Cross-origin frame: reading `top` throws. */
  readonly crossOriginFrame?: boolean;
  /** Omit `matchMedia` entirely. */
  readonly noMatchMedia?: boolean;
  /** Media query lists only support legacy `addListener` (Safari < 14). */
  readonly legacyMediaListeners?: boolean;
}

export interface FakePlatformEnv extends PlatformEnv {
  setMedia(query: string, matches: boolean): void;
  resize(width: number, height?: number): void;
  setOnline(online: boolean): void;
  setConnection(next: Omit<NetworkInformationLike, 'addEventListener' | 'removeEventListener'>): void;
  setGlobal(name: string, value: unknown): void;
  /** Currently attached listeners (window + media + connection). */
  listenerCount(): number;
}

class FakeTarget implements ListenableLike {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

export function createFakePlatformEnv(options: FakePlatformEnvOptions = {}): FakePlatformEnv {
  const matching = new Set(options.media ?? []);
  const lists = new Map<string, FakeTarget>();
  const windowTarget = new FakeTarget();
  const connectionTarget = new FakeTarget();
  let width = options.width ?? 1280;
  let height = options.height ?? 800;
  let online = true;
  let connectionData = options.connection;
  const globals: Record<string, unknown> = { ...options.globals };

  const top = {};
  const self = options.embedded === true || options.crossOriginFrame === true ? {} : top;
  const win: WindowLike = {
    get innerWidth() {
      return width;
    },
    get innerHeight() {
      return height;
    },
    devicePixelRatio: options.devicePixelRatio ?? 1,
    location: { search: options.search ?? '' },
    self,
    get top(): unknown {
      if (options.crossOriginFrame === true) throw new DOMException('Blocked a frame', 'SecurityError');
      return top;
    },
    // sf-lint-disable-next-line no-bare-listener -- fake forwarding shim; the caller owns the lifetime via remove*
    addEventListener: (type, listener) => windowTarget.addEventListener(type, listener),
    removeEventListener: (type, listener) => windowTarget.removeEventListener(type, listener),
  };

  const connection: NetworkInformationLike | undefined =
    connectionData === undefined
      ? undefined
      : {
          get effectiveType() {
            return connectionData?.effectiveType;
          },
          get downlink() {
            return connectionData?.downlink;
          },
          get rtt() {
            return connectionData?.rtt;
          },
          get saveData() {
            return connectionData?.saveData;
          },
          // sf-lint-disable-next-line no-bare-listener -- fake forwarding shim; the caller owns the lifetime via remove*
          addEventListener: (type: string, listener: () => void) => connectionTarget.addEventListener(type, listener),
          removeEventListener: (type: string, listener: () => void) => connectionTarget.removeEventListener(type, listener),
        };

  const nav: NavigatorLike = {
    ...options.navigator,
    get onLine() {
      return online;
    },
    ...(connection === undefined ? {} : { connection }),
  };

  const listFor = (query: string): MediaQueryListLike => {
    let target = lists.get(query);
    if (target === undefined) {
      target = new FakeTarget();
      lists.set(query, target);
    }
    const t = target;
    if (options.legacyMediaListeners === true) {
      return {
        get matches() {
          return matching.has(query);
        },
        // sf-lint-disable-next-line no-bare-listener -- fake forwarding shim; the caller owns the lifetime via remove*
        addListener: (listener) => t.addEventListener('change', listener),
        removeListener: (listener) => t.removeEventListener('change', listener),
      };
    }
    return {
      get matches() {
        return matching.has(query);
      },
      // sf-lint-disable-next-line no-bare-listener -- fake forwarding shim; the caller owns the lifetime via remove*
      addEventListener: (_type, listener) => t.addEventListener('change', listener),
      removeEventListener: (_type, listener) => t.removeEventListener('change', listener),
    };
  };

  return {
    window: win,
    navigator: nav,
    matchMedia: options.noMatchMedia === true ? undefined : listFor,
    globals,
    setMedia(query, matches) {
      if (matching.has(query) === matches) return;
      if (matches) matching.add(query);
      else matching.delete(query);
      lists.get(query)?.dispatch('change');
    },
    resize(nextWidth, nextHeight = height) {
      width = nextWidth;
      height = nextHeight;
      windowTarget.dispatch('resize');
    },
    setOnline(next) {
      online = next;
      windowTarget.dispatch(next ? 'online' : 'offline');
    },
    setConnection(next) {
      connectionData = next;
      connectionTarget.dispatch('change');
    },
    setGlobal(name, value) {
      globals[name] = value;
    },
    listenerCount() {
      let n = windowTarget.count() + connectionTarget.count();
      for (const list of lists.values()) n += list.count();
      return n;
    },
  };
}

/** Representative user agents for tests (UA strings are a fallback only; see facts.ts). */
export const SAMPLE_USER_AGENTS = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iphoneWebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  androidWebview:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0',
} as const;
