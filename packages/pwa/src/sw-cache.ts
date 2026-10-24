/**
 * Service-worker caches (R12.3 critical tier, R18.11):
 *
 * - **precache** `<prefix>-precache-<version>`: the critical tier from the loader's
 *   `precacheList(manifest)`. Installed atomically — every file or nothing (a failed
 *   install deletes the partial cache, so the previous version stays authoritative).
 *   Hashed files (`revision: null`) are copied from older precaches instead of refetched.
 * - **warm** `<prefix>-warm`: content-addressed (hashed URLs) likely/speculative chunks and
 *   Wasm modules, filled by the warm bridge and by cache-first misses; LRU-capped by
 *   entries and bytes. Not versioned: a hash change is a new URL.
 * - **runtime** `<prefix>-rt-<rule>`: declared resources (locale catalogs, lazy assets).
 *
 * Activation deletes every cache this runtime owns (prefix) that is not current.
 */
import { createLimiter, err, ok, type Result, type Telemetry, toSfError } from '@staticflux/core';
import type { PrecacheEntry } from '@staticflux/loader';
import { PrecacheInstallError } from './errors.js';
import { pwaMetrics, PWA_SUBSYSTEMS } from './telemetry.js';
import { type CacheLike, type CacheStorageLike, type FetchLike, type ResponseLike, urlOf } from './sw-env.js';

export interface CacheNames {
  readonly prefix: string;
  readonly precache: string;
  readonly warm: string;
  runtime(ruleId: string): string;
  /** True for caches created by this runtime (any version). */
  owns(name: string): boolean;
  /** True for precaches of any version. */
  isPrecache(name: string): boolean;
}

export function cacheNames(version: string, prefix = 'sf'): CacheNames {
  const precachePrefix = `${prefix}-precache-`;
  return {
    prefix,
    precache: `${precachePrefix}${version}`,
    warm: `${prefix}-warm`,
    runtime: (ruleId) => `${prefix}-rt-${ruleId}`,
    owns: (name) => name.startsWith(`${prefix}-`),
    isPrecache: (name) => name.startsWith(precachePrefix),
  };
}

/** A response is cacheable when it is a complete 200 that is not opaque. */
export function isCacheable(response: ResponseLike): boolean {
  return response.ok && response.status === 200 && response.type !== 'opaque' && response.type !== 'error';
}

export interface PrecacheInstallOptions {
  readonly caches: CacheStorageLike;
  readonly fetch: FetchLike;
  readonly names: CacheNames;
  readonly entries: readonly PrecacheEntry[];
  /** Resolve manifest URLs against the SW origin. */
  readonly resolve?: (url: string) => string;
  readonly concurrency?: number;
  readonly telemetry?: Telemetry;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface PrecacheInstallReport {
  readonly cacheName: string;
  readonly fetched: number;
  /** Hashed files copied from an older precache (no network). */
  readonly copied: number;
}

async function findInOlderPrecache(
  caches: CacheStorageLike,
  names: CacheNames,
  url: string,
): Promise<ResponseLike | undefined> {
  for (const name of await caches.keys()) {
    if (!names.isPrecache(name) || name === names.precache) continue;
    const hit = await (await caches.open(name)).match(url);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Install the critical tier into the versioned precache: all or nothing. */
export async function installPrecache(options: PrecacheInstallOptions): Promise<Result<PrecacheInstallReport>> {
  const { caches, names } = options;
  const resolve = options.resolve ?? ((url: string) => url);
  const now = options.now ?? Date.now;
  const started = now();
  const span = options.telemetry?.span('pwa.precache.install', {
    subsystem: PWA_SUBSYSTEMS.precache,
    attrs: { cache: names.precache, files: options.entries.length },
  });
  const signal = options.signal ?? new AbortController().signal;
  const limiter = createLimiter(options.concurrency ?? 6);
  let fetched = 0;
  let copied = 0;
  let cache: CacheLike;
  try {
    cache = await caches.open(names.precache);
  } catch (cause) {
    const error = PrecacheInstallError({ message: 'Could not open the precache.', cause: toSfError(cause) });
    span?.end('error', error);
    return err(error);
  }
  const results = await Promise.all(
    options.entries.map((entry) =>
      limiter.run<void>(async () => {
        const url = resolve(entry.url);
        try {
          if (await cache.match(url)) return ok();
          if (entry.revision === null) {
            const older = await findInOlderPrecache(caches, names, url);
            if (older !== undefined) {
              await cache.put(url, older);
              copied += 1;
              return ok();
            }
          }
          const response = await options.fetch(url, { cache: 'reload', credentials: 'same-origin', signal });
          if (!isCacheable(response)) {
            return err(PrecacheInstallError({ message: `Precache fetch failed for ${url} (status ${response.status}).`, details: { url, status: response.status } }));
          }
          await cache.put(url, response);
          fetched += 1;
          return ok();
        } catch (cause) {
          return err(PrecacheInstallError({ message: `Precache fetch failed for ${url}.`, details: { url }, cause: toSfError(cause) }));
        }
      }, signal),
    ),
  );
  const failed = results.find((r) => !r.ok);
  if (failed !== undefined && !failed.ok) {
    // Atomic: never leave a half-filled precache for this version.
    await caches.delete(names.precache).catch(() => false);
    span?.end('error', failed.error);
    return err(failed.error);
  }
  options.telemetry?.record(pwaMetrics.precacheInstall, now() - started, { files: options.entries.length, copied });
  span?.set('fetched', fetched);
  span?.set('copied', copied);
  span?.end('ok');
  return ok({ cacheName: names.precache, fetched, copied });
}

/** Delete every owned cache that is not in `keep`. Returns the deleted names. */
export async function cleanupCaches(caches: CacheStorageLike, names: CacheNames, keep: readonly string[]): Promise<readonly string[]> {
  const keepSet = new Set(keep);
  const deleted: string[] = [];
  for (const name of await caches.keys()) {
    if (!names.owns(name) || keepSet.has(name)) continue;
    if (await caches.delete(name)) deleted.push(name);
  }
  return deleted;
}

/** Drop precache entries not in the current list (same-version reinstall with a changed list). */
export async function prunePrecache(cache: CacheLike, urls: ReadonlySet<string>): Promise<number> {
  let removed = 0;
  for (const key of await cache.keys()) {
    if (urls.has(urlOf(key))) continue;
    if (await cache.delete(urlOf(key))) removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------- warm cache (LRU)

export interface WarmCacheOptions {
  readonly caches: CacheStorageLike;
  readonly name: string;
  readonly maxEntries?: number;
  /** Byte cap across entries (default 50 MB). */
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly telemetry?: Telemetry;
}

export interface WarmCache {
  readonly name: string;
  match(url: string): Promise<ResponseLike | undefined>;
  /** Store a response; evicts least-recently-used entries over the caps. Returns false if not stored. */
  put(url: string, response: ResponseLike): Promise<boolean>;
  has(url: string): Promise<boolean>;
  /** URLs currently held (for `isWarm`). */
  urls(): Promise<readonly string[]>;
  readonly usage: { readonly entries: number; readonly bytes: number };
}

interface WarmMeta {
  bytes: number;
  used: number;
}

async function sizeOf(response: ResponseLike): Promise<number> {
  const header = response.headers.get('content-length');
  if (header !== null && /^\d+$/.test(header)) return Number(header);
  if (typeof response.arrayBuffer === 'function') {
    try {
      return (await response.clone().arrayBuffer?.())?.byteLength ?? 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

export function createWarmCache(options: WarmCacheOptions): WarmCache {
  const maxEntries = options.maxEntries ?? 200;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const now = options.now ?? Date.now;
  const meta = new Map<string, WarmMeta>();
  let tick = 0;
  let loaded: Promise<CacheLike> | undefined;
  const stamp = (): number => {
    tick += 1;
    return now() * 1000 + tick;
  };
  const open = (): Promise<CacheLike> => {
    // Rebuild the LRU index from the cache once per SW start (entries survive restarts).
    loaded ??= options.caches.open(options.name).then(async (cache) => {
      for (const key of await cache.keys()) {
        const url = urlOf(key);
        if (!meta.has(url)) meta.set(url, { bytes: 0, used: stamp() });
      }
      return cache;
    });
    return loaded;
  };
  const totalBytes = (): number => {
    let total = 0;
    for (const m of meta.values()) total += m.bytes;
    return total;
  };
  const evict = async (cache: CacheLike, protect: string): Promise<void> => {
    const ordered = [...meta.entries()].filter(([url]) => url !== protect).sort((a, b) => a[1].used - b[1].used);
    for (const [url] of ordered) {
      const overEntries = meta.size > maxEntries;
      const overBytes = totalBytes() > maxBytes;
      if (!overEntries && !overBytes) break;
      meta.delete(url);
      await cache.delete(url);
      options.telemetry?.record(pwaMetrics.warmEvicted, 1, { reason: overEntries ? 'entries' : 'bytes' });
    }
  };
  return {
    name: options.name,
    async match(url) {
      const cache = await open();
      const hit = await cache.match(url);
      const m = meta.get(url);
      if (hit !== undefined) {
        if (m === undefined) meta.set(url, { bytes: 0, used: stamp() });
        else m.used = stamp();
      } else if (m !== undefined) {
        meta.delete(url);
      }
      return hit;
    },
    async put(url, response) {
      if (!isCacheable(response)) return false;
      const bytes = await sizeOf(response);
      if (bytes > maxBytes) return false;
      const cache = await open();
      await cache.put(url, response);
      meta.set(url, { bytes, used: stamp() });
      await evict(cache, url);
      return true;
    },
    async has(url) {
      await open();
      return meta.has(url);
    },
    async urls() {
      await open();
      return [...meta.keys()];
    },
    get usage() {
      return { entries: meta.size, bytes: totalBytes() };
    },
  };
}
