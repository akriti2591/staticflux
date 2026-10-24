/**
 * OS integration receivers (R18.11): link capture (`launchQueue`), file handlers,
 * share targets, protocol handlers and notification clicks. Each receiver turns
 * the platform payload into a typed `LaunchIntent` and hands it to the injected
 * `LaunchIntentPort` — typically an adapter to @staticflux/urlstate intents.
 *
 * Prefill-only semantics stay intact: receivers never act on the data themselves;
 * the port decides (urlstate intents deliver as prefill unless declared `safe`, I-13).
 * Intent payloads never go to telemetry (only the kind).
 */
import { err, ok, type Result, type Scope, type Telemetry } from '@staticflux/core';
import type { AsyncStore } from '@staticflux/storage';
import { ShareTargetPayloadError } from './errors.js';
import { listenTo, type LaunchQueueLike, type ServiceWorkerContainerLike } from './page-env.js';
import { isMessageOf, PWA_MESSAGE } from './protocol.js';
import { SHARE_ID_PARAM, type SharePayload, type ShareTargetParams } from './sw-share-target.js';
import { pwaMetrics } from './telemetry.js';

export type LaunchSource = 'launch-queue' | 'protocol' | 'notification' | 'share-target' | 'file-handler';

export type LaunchIntent =
  | { readonly kind: 'link'; readonly url: string; readonly source: LaunchSource }
  | { readonly kind: 'files'; readonly url: string; readonly files: readonly unknown[]; readonly source: LaunchSource }
  | {
      readonly kind: 'share';
      readonly url: string;
      readonly title?: string;
      readonly text?: string;
      /** The shared URL (not the page URL). */
      readonly sharedUrl?: string;
      readonly files: readonly unknown[];
      readonly source: LaunchSource;
    };

/** Where launch data goes (bind to an urlstate-intent adapter in the app). */
export interface LaunchIntentPort {
  deliver(intent: LaunchIntent): void;
}

function record(telemetry: Telemetry | undefined, intent: LaunchIntent): void {
  telemetry?.record(pwaMetrics.launch, 1, { kind: intent.kind, source: intent.source });
}

export interface LaunchQueueOptions {
  readonly launchQueue: LaunchQueueLike | undefined;
  readonly intents: LaunchIntentPort;
  readonly telemetry?: Telemetry;
  readonly scope?: Scope;
}

/**
 * Consume `window.launchQueue` (link capture + file handlers). Feature-detected:
 * returns false when unsupported (Safari/Firefox) — normal navigation still works there.
 */
export function consumeLaunchQueue(options: LaunchQueueOptions): boolean {
  const queue = options.launchQueue;
  if (queue === undefined || typeof queue.setConsumer !== 'function') return false;
  let active = true;
  queue.setConsumer((params) => {
    if (!active) return;
    const url = params.targetURL ?? '';
    const files = params.files ?? [];
    const intent: LaunchIntent =
      files.length > 0 ? { kind: 'files', url, files, source: 'file-handler' } : { kind: 'link', url, source: 'launch-queue' };
    if (intent.kind === 'link' && url === '') return;
    record(options.telemetry, intent);
    options.intents.deliver(intent);
  });
  options.scope?.defer(() => {
    active = false;
    queue.setConsumer(() => undefined);
  });
  return true;
}

export interface ShareTargetReceiveOptions {
  /** Current page URL. */
  readonly href: string;
  /** Manifest `share_target.action`. */
  readonly action: string;
  readonly params: ShareTargetParams;
  readonly intents: LaunchIntentPort;
  /** Payload store written by `shareTargetPlugin` (POST targets). */
  readonly store?: AsyncStore<SharePayload>;
  /** Replace the URL without the share params (history port). */
  readonly strip?: (cleanHref: string) => void;
  readonly telemetry?: Telemetry;
}

/**
 * Receive a share on the share-target page. Returns `ok(false)` when this page is not
 * the share target, `ok(true)` once delivered. POST payloads are consume-once
 * (`SF-PWA-011` when already consumed).
 */
export async function receiveShareTarget(options: ShareTargetReceiveOptions): Promise<Result<boolean>> {
  const url = new URL(options.href);
  const action = new URL(options.action, url.origin);
  if (url.pathname !== action.pathname) return ok(false);
  const p = options.params;
  const clean = new URL(url.href);
  const shareId = url.searchParams.get(SHARE_ID_PARAM);
  let intent: LaunchIntent;
  if (shareId !== null) {
    clean.searchParams.delete(SHARE_ID_PARAM);
    const loaded = options.store === undefined ? undefined : await options.store.get(shareId);
    if (loaded === undefined || !loaded.ok || loaded.value === undefined) {
      options.strip?.(clean.href);
      return err(ShareTargetPayloadError({ details: { id: shareId } }));
    }
    await options.store?.delete(shareId);
    const payload = loaded.value;
    intent = {
      kind: 'share',
      url: clean.href,
      files: payload.files,
      source: 'share-target',
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.text === undefined ? {} : { text: payload.text }),
      ...(payload.url === undefined ? {} : { sharedUrl: payload.url }),
    };
  } else {
    const read = (name: string | undefined): string | undefined => {
      if (name === undefined) return undefined;
      const value = url.searchParams.get(name);
      clean.searchParams.delete(name);
      return value === null || value === '' ? undefined : value;
    };
    const title = read(p.title);
    const text = read(p.text);
    const sharedUrl = read(p.url);
    if (title === undefined && text === undefined && sharedUrl === undefined) return ok(false);
    intent = {
      kind: 'share',
      url: clean.href,
      files: [],
      source: 'share-target',
      ...(title === undefined ? {} : { title }),
      ...(text === undefined ? {} : { text }),
      ...(sharedUrl === undefined ? {} : { sharedUrl }),
    };
  }
  options.strip?.(clean.href);
  record(options.telemetry, intent);
  options.intents.deliver(intent);
  return ok(true);
}

export interface ProtocolLaunchOptions {
  readonly href: string;
  /** Handler path, e.g. `/open` for `protocol_handlers: [{ url: '/open?url=%s' }]`. */
  readonly path: string;
  /** Query param carrying the `%s` value (default `url`). */
  readonly param?: string;
  readonly intents: LaunchIntentPort;
  readonly telemetry?: Telemetry;
}

/** A `web+app:` protocol launch → link intent carrying the protocol URL. */
export function receiveProtocolLaunch(options: ProtocolLaunchOptions): boolean {
  const url = new URL(options.href);
  if (url.pathname !== new URL(options.path, url.origin).pathname) return false;
  const value = url.searchParams.get(options.param ?? 'url');
  if (value === null || value === '') return false;
  const intent: LaunchIntent = { kind: 'link', url: value, source: 'protocol' };
  record(options.telemetry, intent);
  options.intents.deliver(intent);
  return true;
}

/** Notification clicks forwarded by `pushPlugin` → link intents (same-origin URLs only). */
export function receiveNotificationIntents(options: {
  readonly container: ServiceWorkerContainerLike | undefined;
  readonly intents: LaunchIntentPort;
  readonly scope: Scope;
  readonly origin: string;
  readonly telemetry?: Telemetry;
}): boolean {
  if (options.container === undefined) return false;
  options.scope.defer(
    listenTo(options.container, 'message', (event) => {
      if (!isMessageOf(event.data, PWA_MESSAGE.notificationClick)) return;
      let url: URL;
      try {
        url = new URL(event.data.url, options.origin);
      } catch {
        return;
      }
      if (url.origin !== options.origin) return;
      const intent: LaunchIntent = { kind: 'link', url: url.href, source: 'notification' };
      record(options.telemetry, intent);
      options.intents.deliver(intent);
    }),
  );
  return true;
}
