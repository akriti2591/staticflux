/**
 * Deterministic fakes for SW-side and page-side PWA code (test utilities — never
 * import from app code). `linkWorker` connects a page-side fake worker to a fake SW
 * global so the real runtime and the real updater talk over the message protocol.
 */
import type {
  LaunchParamsLike,
  LaunchQueueLike,
  MessageListenable,
  PwaPageEnv,
  ServiceWorkerContainerLike,
  ServiceWorkerLike,
  ServiceWorkerRegistrationLike,
  SyncManagerLike,
} from './page-env.js';
import type {
  CacheLike,
  CacheStorageLike,
  ClientLike,
  ClientsLike,
  ExtendableEventLike,
  FetchEventLike,
  FetchInitLike,
  FetchLike,
  FormDataLike,
  HeadersLike,
  RequestLike,
  ResponseInitLike,
  ResponseLike,
  SwEnv,
  SwEventMap,
  SwEventType,
  SwGlobalLike,
} from './sw-env.js';
import { urlOf } from './sw-env.js';

// ---------------------------------------------------------------- HTTP shapes

export class FakeHeaders implements HeadersLike {
  private readonly map = new Map<string, string>();
  constructor(init: Readonly<Record<string, string>> = {}) {
    for (const [k, v] of Object.entries(init)) this.map.set(k.toLowerCase(), v);
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }
  forEach(callback: (value: string, key: string) => void): void {
    for (const [k, v] of this.map) callback(v, k);
  }
}

export interface FakeResponseInit extends ResponseInitLike {
  readonly type?: string;
}

export class FakeResponse implements ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly type: string;
  readonly headers: FakeHeaders;
  constructor(
    readonly body: unknown = '',
    init: FakeResponseInit = {},
  ) {
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.statusText = init.statusText ?? '';
    this.type = init.type ?? 'basic';
    this.headers = new FakeHeaders(init.headers ?? {});
  }
  clone(): FakeResponse {
    const headers: Record<string, string> = {};
    this.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return new FakeResponse(this.body, { status: this.status, statusText: this.statusText, type: this.type, headers });
  }
  async text(): Promise<string> {
    return typeof this.body === 'string' ? this.body : JSON.stringify(this.body);
  }
  async json(): Promise<unknown> {
    return typeof this.body === 'string' ? JSON.parse(this.body) : this.body;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new TextEncoder().encode(await this.text()).buffer as ArrayBuffer;
  }
}

export const fakeResponseFactory = (body: unknown, init: ResponseInitLike): ResponseLike => new FakeResponse(body, init);

export interface FakeRequestInit {
  readonly method?: string;
  readonly mode?: string;
  readonly destination?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly form?: Readonly<Record<string, unknown | readonly unknown[]>>;
}

export function fakeRequest(url: string, init: FakeRequestInit = {}): RequestLike {
  const form = init.form;
  return {
    url,
    method: init.method ?? 'GET',
    ...(init.mode === undefined ? {} : { mode: init.mode }),
    ...(init.destination === undefined ? {} : { destination: init.destination }),
    headers: new FakeHeaders(init.headers ?? {}),
    ...(form === undefined
      ? {}
      : {
          formData: async (): Promise<FormDataLike> => ({
            get: (name) => {
              const v = form[name];
              return Array.isArray(v) ? v[0] : (v ?? null);
            },
            getAll: (name) => {
              const v = form[name];
              return v === undefined ? [] : Array.isArray(v) ? v : [v];
            },
          }),
        }),
  };
}

// ---------------------------------------------------------------- caches

export class FakeCache implements CacheLike {
  readonly entries = new Map<string, ResponseLike>();
  async match(request: RequestLike | string): Promise<ResponseLike | undefined> {
    return this.entries.get(urlOf(request))?.clone();
  }
  async put(request: RequestLike | string, response: ResponseLike): Promise<void> {
    this.entries.set(urlOf(request), response);
  }
  async delete(request: RequestLike | string): Promise<boolean> {
    return this.entries.delete(urlOf(request));
  }
  async keys(): Promise<readonly { readonly url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}

export class FakeCacheStorage implements CacheStorageLike {
  readonly caches = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (cache === undefined) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  async keys(): Promise<readonly string[]> {
    return [...this.caches.keys()];
  }
}

// ---------------------------------------------------------------- network

export type FakeRoute = string | FakeResponse | ((url: string, init?: FetchInitLike) => ResponseLike | Promise<ResponseLike>);

export interface FakeNetwork {
  readonly fetch: FetchLike;
  readonly calls: { readonly url: string; readonly init: FetchInitLike | undefined }[];
  set(url: string, route: FakeRoute): void;
  offline: boolean;
}

export function createFakeNetwork(routes: Readonly<Record<string, FakeRoute>> = {}): FakeNetwork {
  const table = new Map<string, FakeRoute>(Object.entries(routes));
  const calls: { url: string; init: FetchInitLike | undefined }[] = [];
  const network: FakeNetwork = {
    calls,
    offline: false,
    set(url, route) {
      table.set(url, route);
    },
    fetch: async (input, init) => {
      const url = urlOf(input);
      calls.push({ url, init });
      if (network.offline) throw new TypeError('Failed to fetch (offline)');
      const route = table.get(url);
      if (route === undefined) return new FakeResponse('not found', { status: 404 });
      if (typeof route === 'string') return new FakeResponse(route, { headers: { 'content-length': String(route.length) } });
      if (route instanceof FakeResponse) return route.clone();
      return route(url, init);
    },
  };
  return network;
}

// ---------------------------------------------------------------- SW global

export class FakeClient implements ClientLike {
  readonly messages: unknown[] = [];
  focused = 0;
  onMessage: ((message: unknown) => void) | undefined;
  constructor(
    readonly id: string,
    readonly url: string,
    readonly type = 'window',
  ) {}
  postMessage(message: unknown): void {
    this.messages.push(message);
    this.onMessage?.(message);
  }
  async focus(): Promise<this> {
    this.focused += 1;
    return this;
  }
}

export interface FakeSwGlobal extends SwGlobalLike {
  readonly clientList: FakeClient[];
  readonly opened: string[];
  readonly notifications: { readonly title: string; readonly options: Readonly<Record<string, unknown>> | undefined }[];
  readonly skipWaitingCalls: number;
  readonly claimCalls: number;
  readonly preloadEnabled: boolean;
  listenerCount(): number;
  /** Dispatch an extendable event; resolves with the settled waitUntil promises. */
  dispatch<K extends SwEventType>(type: K, event: Omit<SwEventMap[K], 'waitUntil'>): Promise<PromiseSettledResult<unknown>[]>;
  install(): Promise<PromiseSettledResult<unknown>[]>;
  activate(): Promise<PromiseSettledResult<unknown>[]>;
  /** Dispatch a fetch; resolves with the response (undefined = not handled). */
  fetch(request: RequestLike, extra?: Partial<Pick<FetchEventLike, 'preloadResponse'>>): Promise<ResponseLike | undefined>;
  message(data: unknown, source?: ClientLike | null): Promise<PromiseSettledResult<unknown>[]>;
}

export function createFakeSwGlobal(options: { readonly origin?: string; readonly navigationPreload?: boolean; readonly notifications?: boolean } = {}): FakeSwGlobal {
  const origin = options.origin ?? 'https://app.test';
  const listeners = new Map<string, Set<(event: never) => void>>();
  const clientList: FakeClient[] = [];
  const opened: string[] = [];
  const notifications: { title: string; options: Readonly<Record<string, unknown>> | undefined }[] = [];
  let skipWaitingCalls = 0;
  let claimCalls = 0;
  let preloadEnabled = false;
  const clients: ClientsLike = {
    async claim() {
      claimCalls += 1;
    },
    async matchAll() {
      return clientList;
    },
    async openWindow(url) {
      opened.push(url);
      return undefined;
    },
  };
  const dispatch = async <K extends SwEventType>(type: K, base: Omit<SwEventMap[K], 'waitUntil'>): Promise<PromiseSettledResult<unknown>[]> => {
    const pending: Promise<unknown>[] = [];
    const event = { ...base, waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as SwEventMap[K];
    for (const listener of [...(listeners.get(type) ?? [])]) (listener as (e: SwEventMap[K]) => void)(event);
    // waitUntil may be called asynchronously inside other waitUntil work.
    const settled: PromiseSettledResult<unknown>[] = [];
    while (settled.length < pending.length) {
      const batch = pending.slice(settled.length);
      settled.push(...(await Promise.allSettled(batch)));
    }
    return settled;
  };
  const self: FakeSwGlobal = {
    clientList,
    opened,
    notifications,
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    get claimCalls() {
      return claimCalls;
    },
    get preloadEnabled() {
      return preloadEnabled;
    },
    clients,
    location: { origin, href: `${origin}/sw.js` },
    registration: {
      scope: `${origin}/`,
      ...(options.navigationPreload === false
        ? {}
        : {
            navigationPreload: {
              async enable() {
                preloadEnabled = true;
              },
            },
          }),
      ...(options.notifications === false
        ? {}
        : {
            async showNotification(title: string, opts?: Readonly<Record<string, unknown>>) {
              notifications.push({ title, options: opts });
            },
          }),
    },
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (set === undefined) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener as (event: never) => void);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener as (event: never) => void);
    },
    async skipWaiting() {
      skipWaitingCalls += 1;
    },
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
    dispatch,
    install: () => dispatch('install', {}),
    activate: () => dispatch('activate', {}),
    async fetch(request, extra = {}) {
      let responded: Promise<ResponseLike> | undefined;
      await dispatch('fetch', {
        request,
        respondWith: (r: Promise<ResponseLike>) => {
          responded = r;
        },
        ...extra,
      } as Omit<FetchEventLike, 'waitUntil'>);
      return responded;
    },
    message: (data, source = null) => dispatch('message', { data, source }),
  };
  return self;
}

export interface FakeSwEnv extends SwEnv {
  readonly self: FakeSwGlobal;
  readonly caches: FakeCacheStorage;
  readonly network: FakeNetwork;
  advance(ms: number): void;
}

export function createFakeSwEnv(options: { readonly origin?: string; readonly routes?: Readonly<Record<string, FakeRoute>>; readonly navigationPreload?: boolean } = {}): FakeSwEnv {
  const self = createFakeSwGlobal({
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.navigationPreload === undefined ? {} : { navigationPreload: options.navigationPreload }),
  });
  const network = createFakeNetwork(options.routes ?? {});
  let time = 1_000;
  return {
    self,
    caches: new FakeCacheStorage(),
    network,
    fetch: network.fetch,
    createResponse: fakeResponseFactory,
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

// ---------------------------------------------------------------- page side

class FakeTarget implements MessageListenable {
  readonly listeners = new Map<string, Set<(event: { readonly data?: unknown }) => void>>();
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, data?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(data === undefined ? {} : { data });
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

export class FakeServiceWorker extends FakeTarget implements ServiceWorkerLike {
  readonly posted: unknown[] = [];
  onMessage: ((message: unknown) => void) | undefined;
  constructor(
    public state: string = 'installing',
    readonly scriptURL = 'https://app.test/sw.js',
  ) {
    super();
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
    this.onMessage?.(message);
  }
  setState(state: string): void {
    this.state = state;
    this.emit('statechange');
  }
}

export class FakeRegistration extends FakeTarget implements ServiceWorkerRegistrationLike {
  installing: FakeServiceWorker | null = null;
  waiting: FakeServiceWorker | null = null;
  active: FakeServiceWorker | null = null;
  readonly scope = 'https://app.test/';
  updates = 0;
  sync: SyncManagerLike | undefined;
  readonly syncTags: string[] = [];
  /** Called by update(); default: nothing new. */
  onUpdate: (() => void | Promise<void>) | undefined;
  constructor(options: { readonly sync?: boolean } = {}) {
    super();
    if (options.sync === true) {
      this.sync = {
        register: async (tag) => {
          this.syncTags.push(tag);
        },
      };
    }
  }
  async update(): Promise<void> {
    this.updates += 1;
    await this.onUpdate?.();
  }
  /** Simulate the browser finding a new SW: installing → (installed) waiting. */
  startInstall(worker: FakeServiceWorker): void {
    this.installing = worker;
    this.emit('updatefound');
  }
  finishInstall(): void {
    const worker = this.installing;
    if (worker === null) return;
    this.installing = null;
    this.waiting = worker;
    worker.setState('installed');
  }
}

export class FakeContainer extends FakeTarget implements ServiceWorkerContainerLike {
  controller: FakeServiceWorker | null = null;
  registration: FakeRegistration;
  registerCalls: { url: string; options: unknown }[] = [];
  failRegister: Error | undefined;
  constructor(registration = new FakeRegistration()) {
    super();
    this.registration = registration;
  }
  async register(url: string, options?: unknown): Promise<FakeRegistration> {
    this.registerCalls.push({ url, options });
    if (this.failRegister !== undefined) throw this.failRegister;
    return this.registration;
  }
  /** Make `worker` the controller and fire `controllerchange`. */
  setController(worker: FakeServiceWorker | null): void {
    this.controller = worker;
    this.emit('controllerchange');
  }
  receive(data: unknown): void {
    this.emit('message', data);
  }
}

/** Connect a page-side worker to a SW global: page posts → SW `message`; SW replies → container `message`. */
export function linkWorker(worker: FakeServiceWorker, sw: FakeSwGlobal, container: FakeContainer, clientUrl = 'https://app.test/'): FakeClient {
  const client = new FakeClient(`client-${sw.clientList.length + 1}`, clientUrl);
  client.onMessage = (message) => container.receive(message);
  sw.clientList.push(client);
  worker.onMessage = (message) => {
    void sw.message(message, client);
  };
  return client;
}

export class FakeLaunchQueue implements LaunchQueueLike {
  consumer: ((params: LaunchParamsLike) => void) | undefined;
  setConsumer(consumer: (params: LaunchParamsLike) => void): void {
    this.consumer = consumer;
  }
  launch(params: LaunchParamsLike): void {
    this.consumer?.(params);
  }
}

export interface FakePageEnv extends PwaPageEnv {
  readonly serviceWorker: FakeContainer | undefined;
  readonly windowTarget: FakeTarget & MessageListenable;
  reloads: number;
  online: boolean;
  saveDataOn: boolean;
  isolated: boolean;
  goOnline(): void;
}

export function createFakePageEnv(
  options: { readonly serviceWorker?: boolean; readonly embedded?: boolean; readonly launchQueue?: FakeLaunchQueue; readonly href?: string; readonly sync?: boolean } = {},
): FakePageEnv {
  const windowTarget = new FakeTarget();
  const href = options.href ?? 'https://app.test/';
  const env: FakePageEnv = {
    serviceWorker: options.serviceWorker === false ? undefined : new FakeContainer(new FakeRegistration({ sync: options.sync === true })),
    embedded: options.embedded === true,
    launchQueue: options.launchQueue,
    location: { href, origin: new URL(href).origin },
    reloads: 0,
    online: true,
    saveDataOn: false,
    isolated: false,
    reload() {
      env.reloads += 1;
    },
    window: windowTarget,
    windowTarget,
    onLine: () => env.online,
    saveData: () => env.saveDataOn,
    crossOriginIsolated: () => env.isolated,
    goOnline() {
      env.online = true;
      windowTarget.emit('online');
    },
  };
  return env;
}

/** Fire an extendable event outside a fake SW global (unit tests of plugins). */
export function extendable<T extends object>(base: T): T & ExtendableEventLike & { readonly pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return { ...base, pending, waitUntil: (p: Promise<unknown>) => pending.push(p) };
}
