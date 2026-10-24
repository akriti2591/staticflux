/**
 * Runtime caching strategies and declared resource rules (Workbox-style, minimal):
 *
 * | rule                          | strategy                | cache            |
 * |-------------------------------|-------------------------|------------------|
 * | critical tier (precache list) | cache-first             | precache         |
 * | navigations                   | network-first (+preload) → app shell → offline page | precache |
 * | hashed chunks / Wasm (`.wasm`)| cache-first             | warm (LRU)       |
 * | declared resources            | per rule (default SWR)  | `<prefix>-rt-<id>` |
 *
 * Strategies never throw: a total failure yields `undefined` and the runtime answers
 * with its fallback (or lets the browser handle the request).
 */
import { type FetchLike, type RequestLike, type ResponseLike } from './sw-env.js';
import { isCacheable } from './sw-cache.js';

export type StrategyName = 'cache-first' | 'network-first' | 'stale-while-revalidate' | 'network-only';

export type ResponseSource = 'cache' | 'network' | 'preload' | 'fallback';

export interface StrategyOutcome {
  readonly response: ResponseLike;
  readonly source: ResponseSource;
}

/** Anything responses can be read from / written to (CacheLike, WarmCache). */
export interface ResponseStore {
  match(url: string): Promise<ResponseLike | undefined>;
  put(url: string, response: ResponseLike): Promise<unknown>;
}

export interface StrategyInput {
  readonly url: string;
  readonly request: RequestLike;
  readonly fetch: FetchLike;
  readonly store: ResponseStore;
  /** Keeps the SW alive for background work (revalidation, cache writes). */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** network-first: give up on the network after this long (default none). */
  readonly timeoutMs?: number;
  /** Navigation preload response, if any. */
  readonly preload?: Promise<ResponseLike | undefined> | undefined;
}

async function network(input: StrategyInput): Promise<StrategyOutcome | undefined> {
  try {
    if (input.preload !== undefined) {
      const preloaded = await input.preload.catch(() => undefined);
      if (preloaded !== undefined) return { response: preloaded, source: 'preload' };
    }
    const response = await input.fetch(input.request);
    return { response, source: 'network' };
  } catch {
    return undefined;
  }
}

function store(input: StrategyInput, outcome: StrategyOutcome | undefined): void {
  if (outcome === undefined || !isCacheable(outcome.response)) return;
  input.waitUntil(Promise.resolve(input.store.put(input.url, outcome.response.clone())).catch(() => undefined));
}

async function cached(input: StrategyInput): Promise<StrategyOutcome | undefined> {
  try {
    const hit = await input.store.match(input.url);
    return hit === undefined ? undefined : { response: hit, source: 'cache' };
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T | undefined>, ms: number | undefined): Promise<T | undefined> {
  if (ms === undefined) return promise;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export async function cacheFirst(input: StrategyInput): Promise<StrategyOutcome | undefined> {
  const hit = await cached(input);
  if (hit !== undefined) return hit;
  const fresh = await network(input);
  store(input, fresh);
  return fresh;
}

export async function networkFirst(input: StrategyInput): Promise<StrategyOutcome | undefined> {
  const pending = network(input);
  const fresh = await withTimeout(pending, input.timeoutMs);
  if (fresh !== undefined && (fresh.response.ok || fresh.response.status < 500)) {
    store(input, fresh);
    return fresh;
  }
  if (fresh === undefined) {
    // Timed out: still let the request finish into the cache for next time.
    input.waitUntil(pending.then((late) => store(input, late)));
  }
  return (await cached(input)) ?? fresh;
}

export async function staleWhileRevalidate(input: StrategyInput): Promise<StrategyOutcome | undefined> {
  const hit = await cached(input);
  const revalidate = network(input).then((fresh) => {
    store(input, fresh);
    return fresh;
  });
  if (hit !== undefined) {
    input.waitUntil(revalidate);
    return hit;
  }
  return revalidate;
}

export async function networkOnly(input: StrategyInput): Promise<StrategyOutcome | undefined> {
  return network(input);
}

export const STRATEGIES: Readonly<Record<StrategyName, (input: StrategyInput) => Promise<StrategyOutcome | undefined>>> = {
  'cache-first': cacheFirst,
  'network-first': networkFirst,
  'stale-while-revalidate': staleWhileRevalidate,
  'network-only': networkOnly,
};

// ---------------------------------------------------------------- declared rules

/** `RegExp` tested against the full URL; `string` = same-origin path prefix; function = custom. */
export type UrlMatcher = RegExp | string | ((url: URL, request: RequestLike) => boolean);

export interface ResourceRule {
  /** Stable id; names the runtime cache (`<prefix>-rt-<id>`). */
  readonly id: string;
  readonly match: UrlMatcher;
  /** Default `stale-while-revalidate`. */
  readonly strategy?: StrategyName;
  /** LRU cap for this rule's cache (default 60). */
  readonly maxEntries?: number;
  readonly timeoutMs?: number;
  /** Use the shared warm cache (content-addressed files) instead of a rule cache. */
  readonly warmCache?: boolean;
  /** Allow cross-origin URLs (default false: only same-origin requests are handled). */
  readonly crossOrigin?: boolean;
}

export function matchesUrl(matcher: UrlMatcher, url: URL, request: RequestLike, origin: string): boolean {
  if (typeof matcher === 'string') return url.origin === origin && url.pathname.startsWith(matcher);
  if (matcher instanceof RegExp) return matcher.test(url.href);
  return matcher(url, request);
}

/** Default "is this a content-hashed file" check (same as the loader's precache list). */
export const HASHED_FILE = /[.-][A-Za-z0-9_-]{8,}\.(m?js|css|wasm)$/;

export function isHashedUrl(url: string): boolean {
  return HASHED_FILE.test(new URL(url, 'http://x').pathname);
}

/**
 * Wasm modules (R11.14): content-hashed `.wasm` files are immutable → cache-first in the
 * warm cache; unhashed ones (e.g. `/wasm/codec.wasm`) revalidate in the background.
 */
export function wasmRules(options: { readonly hashedOnly?: boolean } = {}): readonly ResourceRule[] {
  const hashed: ResourceRule = {
    id: 'wasm',
    match: (url) => url.pathname.endsWith('.wasm') && isHashedUrl(url.href),
    strategy: 'cache-first',
    warmCache: true,
  };
  if (options.hashedOnly === true) return [hashed];
  return [hashed, { id: 'wasm-unhashed', match: (url) => url.pathname.endsWith('.wasm'), strategy: 'stale-while-revalidate', maxEntries: 20 }];
}

/** Lazy locale catalogs (i18n): stale-while-revalidate under a path prefix. */
export function localeCatalogRule(prefix = '/locales/', options: { readonly maxEntries?: number } = {}): ResourceRule {
  return { id: 'locales', match: prefix, strategy: 'stale-while-revalidate', maxEntries: options.maxEntries ?? 30 };
}

/** Other declared lazy assets (images, fonts, JSON) under a path prefix or pattern. */
export function lazyAssetRule(id: string, match: UrlMatcher, options: Omit<ResourceRule, 'id' | 'match'> = {}): ResourceRule {
  return { id, match, strategy: 'stale-while-revalidate', ...options };
}
