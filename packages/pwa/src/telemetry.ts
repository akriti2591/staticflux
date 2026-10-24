/**
 * Telemetry of @staticflux/pwa: subsystems and declared metrics.
 */
import { metric, type Subsystem } from '@staticflux/core';

export const PWA_SUBSYSTEMS = {
  sw: 'pwa/sw',
  precache: 'pwa/precache',
  update: 'pwa/update',
  warm: 'pwa/warm',
  launch: 'pwa/launch',
  isolation: 'pwa/isolation',
  sync: 'pwa/sync',
  push: 'pwa/push',
} as const satisfies Record<string, Subsystem>;

export const pwaMetrics = {
  /** Precache install duration (attrs: version, files, copied). */
  precacheInstall: /* @__PURE__ */ metric.histogram('pwa/precache-install', { unit: 'ms', description: 'Critical-tier precache install duration.' }),
  /** Fetches answered by the SW (attrs: route, strategy, source: cache|network|preload|fallback). */
  swResponse: /* @__PURE__ */ metric.counter('pwa/sw-response', { description: 'Responses served by the service worker runtime.' }),
  /** Warm-cache work (attrs: outcome: warmed|cached|skipped|failed, reason?). */
  warm: /* @__PURE__ */ metric.counter('pwa/warm', { description: 'SW warm-cache fetches for likely/speculative chunks.' }),
  /** Warm-cache evictions (LRU, attrs: reason: entries|bytes). */
  warmEvicted: /* @__PURE__ */ metric.counter('pwa/warm-evicted', { description: 'Entries evicted from the SW warm cache.' }),
  /** Update flow outcomes (attrs: outcome: reinitialized|reloaded|failed|dismissed). */
  update: /* @__PURE__ */ metric.counter('pwa/update', { description: 'Service worker update outcomes.' }),
  /** Launch intents delivered (attrs: kind: link|share|files|notification). */
  launch: /* @__PURE__ */ metric.counter('pwa/launch', { description: 'OS launch / share / file intents handed to the intent port.' }),
  /** Background-sync replays (attrs: outcome: replayed|dropped|retry). */
  replay: /* @__PURE__ */ metric.counter('pwa/replay', { description: 'Queued idempotent mutations replayed by the SW.' }),
} as const;
