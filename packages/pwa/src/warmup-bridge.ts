/**
 * Warm-cache bridge (page side). The loader's `likely` / `speculative` warmups can hand
 * URLs to the SW instead of fetching on the main thread: the SW fetches them at low
 * priority into its LRU warm cache, so the later demand load is served by the SW (the
 * loader's resource-timing classifier reports code source `sw`). The critical tier is
 * never warmed here — it is already in the precache.
 *
 * Without a controlling SW every call fails with `SF-PWA-001`; callers fall back to
 * `loader.preload()` (modulepreload).
 */
import { err, ok, type Result } from '@staticflux/core';
import { type ChunkIdShape, type SfManifest, urlsFor } from '@staticflux/loader';
import { ServiceWorkerUnsupportedError } from './errors.js';
import type { ServiceWorkerContainerLike } from './page-env.js';
import { nextMessageId, PWA_MESSAGE } from './protocol.js';
import { askServiceWorker } from './sw-client.js';
import type { WarmReport } from './sw-runtime.js';

export interface WarmNetworkFacts {
  readonly saveData: boolean;
  readonly offline: boolean;
}

export interface SwWarmupOptions {
  readonly container: ServiceWorkerContainerLike | undefined;
  /** Resolve relative URLs (default `location.origin`). */
  readonly origin: string;
  /** Build manifest, for `warmChunks`. */
  readonly manifest?: SfManifest;
  /** Network facts passed with every request (SW skips on saveData/offline). */
  readonly facts?: () => WarmNetworkFacts;
  readonly timeoutMs?: number;
}

export interface WarmCallOptions {
  readonly signal?: AbortSignal;
}

/** The port the loader's warmup (or an app adapter) calls. */
export interface SwWarmup {
  /** A SW controls the page (warming is possible). */
  readonly available: boolean;
  warm(urls: readonly string[], options?: WarmCallOptions): Promise<Result<WarmReport>>;
  /** Warm the JS/CSS closure of logical chunks (needs `manifest`). */
  warmChunks(ids: readonly ChunkIdShape[], options?: WarmCallOptions): Promise<Result<WarmReport>>;
  /** Known to be in the SW precache / warm cache (from earlier replies or `refresh()`). */
  isWarm(url: string): boolean;
  /** Re-read the SW's warm set. */
  refresh(options?: WarmCallOptions): Promise<Result<readonly string[]>>;
}

export function createSwWarmup(options: SwWarmupOptions): SwWarmup {
  const warmSet = new Set<string>();
  const resolve = (url: string): string => new URL(url, options.origin).href;
  const controller = (): Result<NonNullable<ServiceWorkerContainerLike['controller']>> => {
    const current = options.container?.controller ?? null;
    if (options.container === undefined || current === null) {
      return err(ServiceWorkerUnsupportedError({ message: 'No service worker controls this page; warm via the loader instead.' }));
    }
    return ok(current);
  };

  const warm: SwWarmup['warm'] = async (urls, call = {}) => {
    const worker = controller();
    if (!worker.ok || options.container === undefined) return err(worker.ok ? ServiceWorkerUnsupportedError() : worker.error);
    const wanted = [...new Set(urls.map(resolve))].filter((u) => !warmSet.has(u));
    if (wanted.length === 0) return ok({ warmed: [], cached: urls.map(resolve), skipped: [], failed: [] });
    const facts = options.facts?.() ?? { saveData: false, offline: false };
    const answer = await askServiceWorker({
      container: options.container,
      worker: worker.value,
      message: { type: PWA_MESSAGE.warm, id: nextMessageId('warm'), urls: wanted, saveData: facts.saveData, offline: facts.offline },
      reply: PWA_MESSAGE.warmed,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
    if (!answer.ok) return err(answer.error);
    for (const url of [...answer.value.warmed, ...answer.value.cached]) warmSet.add(url);
    const { warmed, cached, skipped, failed } = answer.value;
    return ok({ warmed, cached, skipped, failed });
  };

  return {
    get available() {
      return controller().ok;
    },
    warm,
    async warmChunks(ids, call = {}) {
      if (options.manifest === undefined) return ok({ warmed: [], cached: [], skipped: [], failed: [] });
      const urls = urlsFor(options.manifest, ids);
      if (!urls.ok) return err(urls.error);
      return warm([...urls.value.modules, ...urls.value.stylesheets], call);
    },
    isWarm(url) {
      return warmSet.has(resolve(url));
    },
    async refresh(call = {}) {
      const worker = controller();
      if (!worker.ok || options.container === undefined) return err(worker.ok ? ServiceWorkerUnsupportedError() : worker.error);
      const answer = await askServiceWorker({
        container: options.container,
        worker: worker.value,
        message: { type: PWA_MESSAGE.warmQuery, id: nextMessageId('warmq') },
        reply: PWA_MESSAGE.warmState,
        timeoutMs: options.timeoutMs ?? 5000,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      if (!answer.ok) return err(answer.error);
      warmSet.clear();
      for (const url of answer.value.warm) warmSet.add(url);
      return ok(answer.value.warm);
    },
  };
}
