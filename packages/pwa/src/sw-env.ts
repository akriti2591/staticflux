/**
 * Ports for code that runs INSIDE the service worker. The runtime is written
 * against these minimal shapes (not the WebWorker lib types) so it unit-tests
 * in happy-dom/node with the fakes in `fakes.ts`, and so a non-standard host
 * (e.g. a test harness or a Workbox shell) can drive it.
 */

export interface HeadersLike {
  get(name: string): string | null;
  has(name: string): boolean;
  forEach(callback: (value: string, key: string) => void): void;
}

export interface FormDataLike {
  get(name: string): unknown;
  getAll(name: string): readonly unknown[];
}

export interface RequestLike {
  readonly url: string;
  readonly method: string;
  /** `navigate` for navigations. */
  readonly mode?: string;
  /** `document`, `script`, `worker`, `image`, … */
  readonly destination?: string;
  readonly headers: HeadersLike;
  formData?(): Promise<FormDataLike>;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  /** `basic`, `cors`, `opaque`, `opaqueredirect`, `error`, `default`. */
  readonly type: string;
  readonly headers: HeadersLike;
  readonly body?: unknown;
  readonly redirected?: boolean;
  clone(): ResponseLike;
  /** Used to size warm-cache entries when `content-length` is missing. */
  arrayBuffer?(): Promise<ArrayBuffer>;
  json?(): Promise<unknown>;
  text?(): Promise<string>;
}

export interface ResponseInitLike {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Build a response (default: `new Response(body, init)`). */
export type ResponseFactory = (body: unknown, init: ResponseInitLike) => ResponseLike;

export interface FetchInitLike {
  readonly cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache';
  readonly credentials?: 'omit' | 'same-origin' | 'include';
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** Fetch Priority (Chromium); ignored elsewhere. */
  readonly priority?: 'high' | 'low' | 'auto';
}

export type FetchLike = (input: RequestLike | string, init?: FetchInitLike) => Promise<ResponseLike>;

export interface CacheLike {
  match(request: RequestLike | string): Promise<ResponseLike | undefined>;
  put(request: RequestLike | string, response: ResponseLike): Promise<void>;
  delete(request: RequestLike | string): Promise<boolean>;
  keys(): Promise<readonly (RequestLike | { readonly url: string })[]>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<boolean>;
  keys(): Promise<readonly string[]>;
}

export interface ClientLike {
  readonly id: string;
  readonly url: string;
  readonly type?: string;
  postMessage(message: unknown): void;
  focus?(): Promise<unknown>;
}

export interface ClientsLike {
  claim(): Promise<void>;
  matchAll(options?: { readonly type?: string; readonly includeUncontrolled?: boolean }): Promise<readonly ClientLike[]>;
  openWindow?(url: string): Promise<unknown>;
}

export interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FetchEventLike extends ExtendableEventLike {
  readonly request: RequestLike;
  respondWith(response: Promise<ResponseLike>): void;
  /** Navigation preload response (undefined/absent when not enabled or unsupported). */
  readonly preloadResponse?: Promise<ResponseLike | undefined>;
  readonly clientId?: string;
}

export interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
  readonly source: ClientLike | null | undefined;
}

export interface SyncEventLike extends ExtendableEventLike {
  readonly tag: string;
}

export interface PushEventLike extends ExtendableEventLike {
  readonly data: { json(): unknown; text(): string } | null;
}

export interface NotificationLike {
  readonly data: unknown;
  readonly tag?: string;
  close(): void;
}

export interface NotificationEventLike extends ExtendableEventLike {
  readonly notification: NotificationLike;
  readonly action?: string;
}

export interface SwEventMap {
  install: ExtendableEventLike;
  activate: ExtendableEventLike;
  fetch: FetchEventLike;
  message: MessageEventLike;
  sync: SyncEventLike;
  push: PushEventLike;
  notificationclick: NotificationEventLike;
}

export type SwEventType = keyof SwEventMap;

export interface NavigationPreloadLike {
  enable(): Promise<void>;
  setHeaderValue?(value: string): Promise<void>;
}

export interface SwRegistrationLike {
  readonly scope: string;
  readonly navigationPreload?: NavigationPreloadLike;
  showNotification?(title: string, options?: Readonly<Record<string, unknown>>): Promise<void>;
}

/** `self` inside the service worker. */
export interface SwGlobalLike {
  addEventListener<K extends SwEventType>(type: K, listener: (event: SwEventMap[K]) => void): void;
  removeEventListener<K extends SwEventType>(type: K, listener: (event: SwEventMap[K]) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: ClientsLike;
  readonly registration: SwRegistrationLike;
  readonly location: { readonly origin: string; readonly href?: string };
}

/** Everything the SW runtime touches. */
export interface SwEnv {
  readonly self: SwGlobalLike;
  readonly caches: CacheStorageLike;
  readonly fetch: FetchLike;
  readonly createResponse: ResponseFactory;
  readonly now: () => number;
}

/** The real service-worker globals. Call only inside a service worker. */
export function browserSwEnv(): SwEnv {
  const g = globalThis as unknown as {
    caches: CacheStorageLike;
    fetch: FetchLike;
    Response: new (body: unknown, init: ResponseInitLike) => ResponseLike;
  };
  return {
    self: globalThis as unknown as SwGlobalLike,
    caches: g.caches,
    fetch: (input, init) => g.fetch(input, init),
    createResponse: (body, init) => new g.Response(body, init),
    now: () => Date.now(),
  };
}

/** URL of a request or key. */
export function urlOf(request: RequestLike | { readonly url: string } | string): string {
  return typeof request === 'string' ? request : request.url;
}

/** Copy headers into a plain record (lower-cased keys). */
export function headersToRecord(headers: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}
