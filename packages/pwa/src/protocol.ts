/**
 * Message protocol between the page and the service worker runtime. Every
 * message is a plain structured-clone object with a typed `type`; requests that
 * expect an answer carry an `id` that the reply echoes. Unknown messages are
 * ignored on both sides (other libraries may share the channel).
 */

export const PWA_MESSAGE = {
  // page → SW
  getVersion: 'sf-pwa/get-version',
  skipWaiting: 'sf-pwa/skip-waiting',
  warm: 'sf-pwa/warm',
  warmQuery: 'sf-pwa/warm-query',
  queueMutation: 'sf-pwa/queue-mutation',
  replay: 'sf-pwa/replay',
  // SW → page
  version: 'sf-pwa/version',
  activated: 'sf-pwa/activated',
  warmed: 'sf-pwa/warmed',
  warmState: 'sf-pwa/warm-state',
  queued: 'sf-pwa/queued',
  replayed: 'sf-pwa/replayed',
  notificationClick: 'sf-pwa/notification-click',
} as const;

export type PwaMessageType = (typeof PWA_MESSAGE)[keyof typeof PWA_MESSAGE];

export interface VersionInfo {
  /** Build id of the SW (sf-manifest `buildId`). */
  readonly version: string;
  /** Framework major the SW's build was made with; a change forces a reload instead of reinitialize. */
  readonly frameworkMajor: number;
}

export type WarmSkipReason = 'save-data' | 'offline' | 'over-budget' | 'cross-origin' | 'disabled';

/** A queued mutation (background sync plugin). Only idempotent requests are accepted. */
export interface QueuedMutation {
  readonly id: string;
  readonly url: string;
  readonly method: 'PUT' | 'DELETE' | 'POST' | 'PATCH';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Must be true; the SW refuses anything else (R4.6). */
  readonly idempotent: boolean;
  /** Sent as `Idempotency-Key` on replay when present. */
  readonly idempotencyKey?: string;
  readonly queuedAt: number;
  readonly attempts?: number;
}

export type PageToSwMessage =
  | { readonly type: typeof PWA_MESSAGE.getVersion; readonly id: string }
  | { readonly type: typeof PWA_MESSAGE.skipWaiting }
  | {
      readonly type: typeof PWA_MESSAGE.warm;
      readonly id: string;
      readonly urls: readonly string[];
      readonly saveData?: boolean;
      readonly offline?: boolean;
    }
  | { readonly type: typeof PWA_MESSAGE.warmQuery; readonly id: string; readonly urls?: readonly string[] }
  | { readonly type: typeof PWA_MESSAGE.queueMutation; readonly id: string; readonly mutation: QueuedMutation }
  | { readonly type: typeof PWA_MESSAGE.replay; readonly id: string };

export type SwToPageMessage =
  | ({ readonly type: typeof PWA_MESSAGE.version; readonly id: string } & VersionInfo)
  | ({ readonly type: typeof PWA_MESSAGE.activated } & VersionInfo)
  | {
      readonly type: typeof PWA_MESSAGE.warmed;
      readonly id: string;
      readonly warmed: readonly string[];
      readonly cached: readonly string[];
      readonly skipped: readonly { readonly url: string; readonly reason: WarmSkipReason }[];
      readonly failed: readonly string[];
    }
  | { readonly type: typeof PWA_MESSAGE.warmState; readonly id: string; readonly warm: readonly string[] }
  | { readonly type: typeof PWA_MESSAGE.queued; readonly id: string; readonly queued: boolean; readonly reason?: string }
  | {
      readonly type: typeof PWA_MESSAGE.replayed;
      readonly id?: string;
      readonly replayed: number;
      readonly dropped: number;
      readonly remaining: number;
    }
  | { readonly type: typeof PWA_MESSAGE.notificationClick; readonly url: string };

export type PwaMessage = PageToSwMessage | SwToPageMessage;

const KNOWN = new Set<string>(Object.values(PWA_MESSAGE));

/** Structural guard: a known `sf-pwa/*` message type. Field validation happens at the handler. */
export function isPwaMessage(value: unknown): value is PwaMessage {
  return typeof value === 'object' && value !== null && KNOWN.has(String((value as { type?: unknown }).type));
}

/** Narrow a message to one type. */
export function isMessageOf<T extends PwaMessageType>(value: unknown, type: T): value is Extract<PwaMessage, { type: T }> {
  return isPwaMessage(value) && value.type === type;
}

let counter = 0;
/** Correlation id for request/response messages (unique per page). */
export function nextMessageId(prefix = 'm'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
