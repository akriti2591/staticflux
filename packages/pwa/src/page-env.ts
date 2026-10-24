/**
 * Ports for page-side PWA code (registration, update flow, warm bridge, launch
 * handling). Minimal shapes so the fakes in `fakes.ts` drive every path in tests.
 */

export interface MessageListenable {
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
}

export interface ServiceWorkerLike extends MessageListenable {
  /** `installing` | `installed` | `activating` | `activated` | `redundant`. */
  readonly state: string;
  readonly scriptURL?: string;
  postMessage(message: unknown): void;
}

export interface SyncManagerLike {
  register(tag: string): Promise<void>;
}

export interface ServiceWorkerRegistrationLike extends MessageListenable {
  readonly installing: ServiceWorkerLike | null;
  readonly waiting: ServiceWorkerLike | null;
  readonly active: ServiceWorkerLike | null;
  readonly scope?: string;
  update(): Promise<unknown>;
  /** Background Sync (Chromium). */
  readonly sync?: SyncManagerLike;
}

export interface ServiceWorkerContainerLike extends MessageListenable {
  readonly controller: ServiceWorkerLike | null;
  register(
    url: string,
    options?: { readonly scope?: string; readonly type?: 'classic' | 'module'; readonly updateViaCache?: 'imports' | 'all' | 'none' },
  ): Promise<ServiceWorkerRegistrationLike>;
  readonly ready?: Promise<ServiceWorkerRegistrationLike>;
}

/** `window.launchQueue` (File Handling / Launch Handler, Chromium). */
export interface LaunchParamsLike {
  readonly targetURL?: string;
  readonly files?: readonly unknown[];
}

export interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void): void;
}

export interface PwaPageEnv {
  /** `navigator.serviceWorker` (undefined when unsupported / insecure context). */
  readonly serviceWorker: ServiceWorkerContainerLike | undefined;
  /** Running inside a frame (embedded host modes never get a SW). */
  readonly embedded: boolean;
  readonly launchQueue: LaunchQueueLike | undefined;
  readonly location: { readonly href: string; readonly origin: string };
  /** Full page reload (the escape hatch, R4.8). */
  reload(): void;
  /** `window` for `online` events (mutation replay fallback). */
  readonly window: MessageListenable | undefined;
  readonly onLine: () => boolean;
  /** `navigator.connection.saveData` (false when unknown). */
  readonly saveData: () => boolean;
  /** `globalThis.crossOriginIsolated`. */
  readonly crossOriginIsolated: () => boolean;
}

function detectEmbedded(): boolean {
  const g = globalThis as { self?: unknown; top?: unknown };
  try {
    return g.self !== g.top;
  } catch {
    return true;
  }
}

/** The real page globals (feature-detected; safe outside the browser). */
export function browserPwaPageEnv(): PwaPageEnv {
  const g = globalThis as unknown as {
    navigator?: { serviceWorker?: ServiceWorkerContainerLike; onLine?: boolean; connection?: { saveData?: boolean } };
    launchQueue?: LaunchQueueLike;
    location?: { href: string; origin: string; reload(): void };
    window?: MessageListenable;
    crossOriginIsolated?: boolean;
    isSecureContext?: boolean;
  };
  const secure = g.isSecureContext !== false;
  return {
    serviceWorker: secure ? g.navigator?.serviceWorker : undefined,
    embedded: detectEmbedded(),
    launchQueue: typeof g.launchQueue?.setConsumer === 'function' ? g.launchQueue : undefined,
    location: { href: g.location?.href ?? 'http://localhost/', origin: g.location?.origin ?? 'http://localhost' },
    reload: () => g.location?.reload(),
    window: g.window,
    onLine: () => g.navigator?.onLine !== false,
    saveData: () => g.navigator?.connection?.saveData === true,
    crossOriginIsolated: () => g.crossOriginIsolated === true,
  };
}

/** Add a listener and return its remover (callers register the remover on a scope). */
export function listenTo(
  target: MessageListenable,
  type: string,
  listener: (event: { readonly data?: unknown }) => void,
): () => void {
  // sf-lint-disable-next-line no-bare-listener -- the remover is returned and always registered on a scope by callers
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}
