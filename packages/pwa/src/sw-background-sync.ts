/**
 * OPTIONAL plugin (off unless listed in `config.plugins`): background sync for
 * queued **idempotent** data mutations (mirrors data's pause policy, R4.6).
 *
 * - The page queues a mutation with `sf-pwa/queue-mutation` (see `mutation-queue.ts`).
 *   Anything not declared `idempotent: true` is refused — never auto-replayed.
 * - Replay runs on the Background Sync `sync` event (Chromium) or on an explicit
 *   `sf-pwa/replay` message (the page sends it on `online` where Background Sync is missing).
 * - Order is preserved: replay stops at the first retryable failure (network / 5xx / 408 / 429).
 *   Other 4xx are dropped (the server rejected it; replaying would not help). Entries over
 *   `maxAttempts` or older than `maxAgeMs` are dropped.
 */
import { createNoopTelemetry, createSingleFlight, ok, type Telemetry } from '@staticflux/core';
import type { AsyncStore } from '@staticflux/storage';
import { isMessageOf, PWA_MESSAGE, type QueuedMutation } from './protocol.js';
import type { SyncEventLike } from './sw-env.js';
import type { SwPlugin, SwPluginContext } from './sw-runtime.js';
import { pwaMetrics } from './telemetry.js';

export const DEFAULT_SYNC_TAG = 'sf-pwa/replay';

export interface BackgroundSyncOptions {
  /** Durable queue (IndexedDB store from @staticflux/storage inside the SW). */
  readonly store: AsyncStore<QueuedMutation>;
  readonly tag?: string;
  readonly maxAttempts?: number;
  readonly maxAgeMs?: number;
  readonly telemetry?: Telemetry;
}

export interface ReplayReport {
  readonly replayed: number;
  readonly dropped: number;
  readonly remaining: number;
}

export interface BackgroundSyncPlugin extends SwPlugin {
  replay(context: SwPluginContext): Promise<ReplayReport>;
}

export function queueKey(mutation: QueuedMutation): string {
  return `${String(mutation.queuedAt).padStart(15, '0')}:${mutation.id}`;
}

function isValidMutation(value: unknown): value is QueuedMutation {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m['id'] === 'string' && typeof m['url'] === 'string' && typeof m['method'] === 'string' && typeof m['queuedAt'] === 'number';
}

const RETRYABLE = new Set([408, 425, 429]);

export function backgroundSyncPlugin(options: BackgroundSyncOptions): BackgroundSyncPlugin {
  const tag = options.tag ?? DEFAULT_SYNC_TAG;
  const maxAttempts = options.maxAttempts ?? 5;
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const flight = createSingleFlight<'replay', ReplayReport>();
  const telemetryOf = (context: SwPluginContext): Telemetry => options.telemetry ?? context.telemetry ?? createNoopTelemetry();

  const runReplay = async (context: SwPluginContext): Promise<ReplayReport> => {
    const telemetry = telemetryOf(context);
    const entries = await options.store.seek().toArray();
    if (!entries.ok) return { replayed: 0, dropped: 0, remaining: 0 };
    let replayed = 0;
    let dropped = 0;
    let stopped = false;
    let index = 0;
    for (const [key, mutation] of entries.value) {
      index += 1;
      if (context.env.now() - mutation.queuedAt > maxAgeMs || mutation.idempotent !== true) {
        await options.store.delete(key);
        dropped += 1;
        telemetry.record(pwaMetrics.replay, 1, { outcome: 'dropped' });
        continue;
      }
      let status: number | undefined;
      try {
        const response = await context.env.fetch(mutation.url, {
          method: mutation.method,
          credentials: 'same-origin',
          headers: { ...mutation.headers, ...(mutation.idempotencyKey === undefined ? {} : { 'Idempotency-Key': mutation.idempotencyKey }) },
          ...(mutation.body === undefined ? {} : { body: mutation.body }),
        });
        status = response.status;
      } catch {
        status = undefined;
      }
      if (status !== undefined && status < 400) {
        await options.store.delete(key);
        replayed += 1;
        telemetry.record(pwaMetrics.replay, 1, { outcome: 'replayed' });
        continue;
      }
      if (status !== undefined && status < 500 && !RETRYABLE.has(status)) {
        await options.store.delete(key);
        dropped += 1;
        telemetry.record(pwaMetrics.replay, 1, { outcome: 'dropped', status });
        continue;
      }
      const attempts = (mutation.attempts ?? 0) + 1;
      if (attempts >= maxAttempts) {
        await options.store.delete(key);
        dropped += 1;
        telemetry.record(pwaMetrics.replay, 1, { outcome: 'dropped', reason: 'attempts' });
        continue;
      }
      await options.store.set(key, { ...mutation, attempts });
      telemetry.record(pwaMetrics.replay, 1, { outcome: 'retry' });
      stopped = true;
      break;
    }
    const remaining = stopped ? entries.value.length - index + 1 : 0;
    return { replayed, dropped, remaining };
  };

  const replay = async (context: SwPluginContext): Promise<ReplayReport> => {
    const result = await flight.run('replay', async () => ok(await runReplay(context)), new AbortController().signal);
    const report = result.ok ? result.value : { replayed: 0, dropped: 0, remaining: 0 };
    await context.broadcast({ type: PWA_MESSAGE.replayed, ...report });
    return report;
  };

  return {
    id: 'pwa/background-sync',
    replay,
    message(data, event, context) {
      if (isMessageOf(data, PWA_MESSAGE.queueMutation)) {
        const mutation: unknown = data.mutation;
        if (!isValidMutation(mutation) || mutation.idempotent !== true) {
          event.source?.postMessage({ type: PWA_MESSAGE.queued, id: data.id, queued: false, reason: 'not-idempotent' });
          return true;
        }
        event.waitUntil(
          options.store.set(queueKey(mutation), { ...mutation, attempts: 0 }).then((r) =>
            event.source?.postMessage({ type: PWA_MESSAGE.queued, id: data.id, queued: r.ok, ...(r.ok ? {} : { reason: r.error.code }) }),
          ),
        );
        return true;
      }
      if (isMessageOf(data, PWA_MESSAGE.replay)) {
        event.waitUntil(
          replay(context).then((report) => event.source?.postMessage({ type: PWA_MESSAGE.replayed, id: data.id, ...report })),
        );
        return true;
      }
      return false;
    },
    listeners: {
      sync: (event: SyncEventLike, context: SwPluginContext) => {
        if (event.tag !== tag) return;
        event.waitUntil(
          replay(context).then((report) => {
            // Rejecting asks the browser to retry the sync later.
            if (report.remaining > 0) throw new Error('sf-pwa: replay incomplete');
          }),
        );
      },
    },
  };
}
