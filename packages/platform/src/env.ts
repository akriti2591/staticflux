/**
 * `PlatformEnv` — the only door to browser globals in this package.
 *
 * Every detector reads `window`/`navigator`/`matchMedia` through this
 * injectable stand-in so tests (and workers, and non-browser hosts) are
 * deterministic. Members are optional because real browsers differ
 * (Safari has no Network Information API, Firefox has no `deviceMemory`, …):
 * a missing member is a fact ("not available"), never an exception.
 *
 * This file must stay free of runtime imports: it is part of the inline
 * mode detector (R12.9, < 1 KB).
 */

/** Minimal `MediaQueryList` (Safari < 14 only has `addListener`). */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
}

/** Minimal event target (window, connection). */
export interface ListenableLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Network Information API (Chromium only). */
export interface NetworkInformationLike extends Partial<ListenableLike> {
  readonly effectiveType?: string | undefined;
  readonly downlink?: number | undefined;
  readonly rtt?: number | undefined;
  readonly saveData?: boolean | undefined;
  readonly type?: string | undefined;
}

/** User-Agent Client Hints, low-entropy part (Chromium only). */
export interface UserAgentDataLike {
  readonly mobile?: boolean;
  readonly platform?: string;
  readonly brands?: readonly { readonly brand: string; readonly version: string }[];
}

export interface NavigatorLike {
  readonly userAgent?: string;
  readonly userAgentData?: UserAgentDataLike;
  readonly maxTouchPoints?: number;
  readonly hardwareConcurrency?: number;
  /** GiB, rounded and capped at 8 (Chromium only). */
  readonly deviceMemory?: number;
  readonly onLine?: boolean;
  readonly connection?: NetworkInformationLike;
  /** iOS Safari "Add to Home Screen". */
  readonly standalone?: boolean;
  readonly serviceWorker?: unknown;
  readonly share?: unknown;
  readonly credentials?: unknown;
  readonly clipboard?: unknown;
  readonly gpu?: unknown;
}

export interface WindowLike extends ListenableLike {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio?: number;
  readonly location?: { readonly search: string };
  /** `self !== top` ⇒ embedded. Reading `top` may throw cross-origin (treated as embedded). */
  readonly self?: unknown;
  readonly top?: unknown;
}

export interface PlatformEnv {
  readonly window: WindowLike | undefined;
  readonly navigator: NavigatorLike | undefined;
  readonly matchMedia: ((query: string) => MediaQueryListLike) | undefined;
  /**
   * Global namespace for presence checks of constructors/APIs
   * (`SharedWorker`, `PublicKeyCredential`, `Notification`, `indexedDB`,
   * `localStorage`, `LanguageModel`, `Summarizer`, `webkit`, `openai`, …).
   * Access may throw (e.g. `localStorage` with blocked storage); detectors guard it.
   */
  readonly globals: Readonly<Record<string, unknown>>;
}

/** The real browser environment (or an empty one outside the browser). */
export function browserEnv(): PlatformEnv {
  const g = globalThis as unknown as Record<string, unknown> & {
    window?: WindowLike;
    navigator?: NavigatorLike;
    matchMedia?: (query: string) => MediaQueryListLike;
  };
  const win = g.window;
  return {
    window: win,
    navigator: g.navigator,
    matchMedia: typeof g.matchMedia === 'function' ? (query) => (g.matchMedia as (q: string) => MediaQueryListLike)(query) : undefined,
    globals: g,
  };
}

/** Safe `matchMedia(query).matches` (false when unsupported). */
export function mediaMatches(env: PlatformEnv, query: string): boolean {
  try {
    return env.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

/** Safe global read (some getters throw, e.g. `localStorage` when storage is blocked). */
export function readGlobal(env: PlatformEnv, name: string): unknown {
  try {
    return env.globals[name];
  } catch {
    return undefined;
  }
}

/** Whether the page runs inside a frame. Cross-origin `top` access that throws means embedded. */
export function isEmbedded(env: PlatformEnv): boolean {
  const win = env.window;
  if (win === undefined) return false;
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}
