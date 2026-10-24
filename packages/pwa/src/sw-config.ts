/**
 * Build-time helper: derive the SW runtime config from the loader's build manifest.
 * The critical tier (plus its dependency closure) is precached — never `likely` /
 * `speculative`, which go through the warm bridge on idle/intent (prior-art: do not
 * precache everything).
 */
import { precacheList, type PrecacheOptions, type SfManifest } from '@staticflux/loader';
import type { ServiceWorkerConfig } from './sw-runtime.js';

export interface SwConfigFromManifestOptions extends Omit<ServiceWorkerConfig, 'version' | 'precache'> {
  /** Restrict the precache to one boot profile (e.g. `pwa:compact`). */
  readonly profile?: string;
  /** Extra precached URLs (app shell `index.html`, offline page, icons) — revisioned by buildId. */
  readonly extraUrls?: readonly string[];
  readonly isHashedFile?: PrecacheOptions['isHashed'];
}

export function serviceWorkerConfigFromManifest(manifest: SfManifest, options: SwConfigFromManifestOptions): ServiceWorkerConfig {
  const { profile, extraUrls, isHashedFile, ...rest } = options;
  const precache = [
    ...precacheList(manifest, {
      ...(profile === undefined ? {} : { profile }),
      ...(isHashedFile === undefined ? {} : { isHashed: isHashedFile }),
    }),
    ...(extraUrls ?? []).map((url) => ({ url, revision: manifest.buildId })),
  ];
  // Navigation fallbacks must be precached or offline navigations cannot be answered.
  const nav = rest.navigation === false ? undefined : rest.navigation;
  const known = new Set(precache.map((e) => e.url));
  for (const url of [nav?.fallbackUrl, nav?.offlineUrl]) {
    if (url !== undefined && !known.has(url)) {
      precache.push({ url, revision: manifest.buildId });
      known.add(url);
    }
  }
  return { ...rest, version: manifest.buildId, precache };
}
