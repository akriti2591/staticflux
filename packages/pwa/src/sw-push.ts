/**
 * OPTIONAL plugin (off unless listed in `config.plugins`): push → notification, and
 * notificationclick → focus/open a client with a URL intent.
 *
 * - Push payload (JSON): `{ title, body?, url?, tag?, icon?, badge? }`; anything else is
 *   shown with the fallback title (browsers penalize pushes that show nothing).
 * - The click URL must be same-origin (else the scope root is used). An open client is
 *   focused and receives `sf-pwa/notification-click { url }`; the page hands it to the
 *   intent port (`receiveNotificationIntents`) — **prefill-only**: the URL is captured as
 *   an intent, nothing auto-executes (I-13). With no open client, a window is opened at the URL
 *   (the router/urlstate capture it like any deep link).
 */
import { PWA_MESSAGE } from './protocol.js';
import type { NotificationEventLike, PushEventLike } from './sw-env.js';
import type { SwPlugin, SwPluginContext } from './sw-runtime.js';
import { pwaMetrics } from './telemetry.js';

export interface PushPayload {
  readonly title: string;
  readonly body?: string;
  readonly url?: string;
  readonly tag?: string;
  readonly icon?: string;
  readonly badge?: string;
}

export interface PushPluginOptions {
  readonly fallbackTitle: string;
  readonly defaultIcon?: string;
  /** Map/validate payloads (e.g. drop marketing pushes for signed-out users). Return undefined to show the fallback. */
  readonly parse?: (data: unknown) => PushPayload | undefined;
}

export function parsePushPayload(data: unknown): PushPayload | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d['title'] !== 'string' || d['title'] === '') return undefined;
  const pick = (key: string): Record<string, string> => (typeof d[key] === 'string' ? { [key]: d[key] } : {});
  return { title: d['title'], ...pick('body'), ...pick('url'), ...pick('tag'), ...pick('icon'), ...pick('badge') } as PushPayload;
}

/** Same-origin URL or the scope root. */
export function safeClickUrl(url: unknown, origin: string, scope: string): string {
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url, origin);
      if (parsed.origin === origin) return parsed.href;
    } catch {
      // fall through
    }
  }
  return new URL(scope, origin).href;
}

export function pushPlugin(options: PushPluginOptions): SwPlugin {
  const parse = options.parse ?? parsePushPayload;
  return {
    id: 'pwa/push',
    listeners: {
      push: (event: PushEventLike, context: SwPluginContext) => {
        let raw: unknown;
        try {
          raw = event.data?.json();
        } catch {
          raw = undefined;
        }
        const payload = parse(raw) ?? { title: options.fallbackTitle };
        const show = context.env.self.registration.showNotification;
        if (typeof show !== 'function') return;
        context.telemetry.record(pwaMetrics.launch, 1, { kind: 'push' });
        event.waitUntil(
          show.call(context.env.self.registration, payload.title, {
            ...(payload.body === undefined ? {} : { body: payload.body }),
            ...(payload.tag === undefined ? {} : { tag: payload.tag }),
            ...(payload.badge === undefined ? {} : { badge: payload.badge }),
            icon: payload.icon ?? options.defaultIcon,
            data: { url: payload.url },
          }),
        );
      },
      notificationclick: (event: NotificationEventLike, context: SwPluginContext) => {
        event.notification.close();
        const data = event.notification.data as { url?: unknown } | null | undefined;
        const origin = context.env.self.location.origin;
        const url = safeClickUrl(data?.url, origin, context.env.self.registration.scope);
        context.telemetry.record(pwaMetrics.launch, 1, { kind: 'notification' });
        event.waitUntil(
          (async () => {
            const windows = await context.env.self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            const target = windows.find((c) => c.url.startsWith(origin)) ?? windows[0];
            if (target !== undefined) {
              target.postMessage({ type: PWA_MESSAGE.notificationClick, url });
              await target.focus?.();
              return;
            }
            await context.env.self.clients.openWindow?.(url);
          })(),
        );
      },
    },
  };
}
