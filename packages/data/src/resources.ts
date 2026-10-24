/**
 * The resource manager: keyed cache, in-flight dedup, stale-while-revalidate,
 * invalidation, optimistic updates with rollback, epochs (R9.2, R9.3, R4.3, R4.7, I-10).
 *
 * - Entries are keyed by `resource.id` + a stable serialization of `resource.key(input)`.
 * - Concurrent reads of one entry share one request (dedup).
 * - Reads of stale data return it immediately and revalidate in the background (SWR);
 *   the handle state is then `refreshing` (data kept).
 * - An epoch bump marks every entry stale, aborts in-flight requests and refetches
 *   observed entries; late responses of the old epoch are discarded by the client (I-10).
 * - The resource layer never retries requests (the client is the single retry layer);
 *   subscriptions reconnect here because the client never retries streams.
 *
 * Handle state machine (reactive): idle → loading → ready ⇄ refreshing; loading|refreshing → error → refreshing.
 */
import {
  AbortedError,
  batch,
  box,
  defaultRetryIf,
  type Box,
  err,
  ok,
  type Result,
  retry,
  type Scope,
  type SfError,
  type Span,
  type SpanContext,
  type Task,
  untracked,
  watch,
} from '@staticflux/core';
import { createBatcher, type Batcher } from './batch.js';
import type { DataClient } from './client.js';
import { stableStringify } from './clone.js';
import { ResourceDisposedError, StaleEpochError } from './errors.js';
import { DATA_SUBSYSTEMS, DataMetrics } from './metrics.js';
import type {
  BatchedResource,
  PaginatedResource,
  SingleResource,
  StreamResource,
  SubscriptionResource,
} from './resource-defs.js';
import type { Endpoint } from './transport.js';

export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';

export interface ResourceState<T> {
  readonly status: ResourceStatus;
  readonly data: T | undefined;
  readonly error: SfError | undefined;
}

/** Reactive view of one cache entry. */
export interface ResourceHandle<T> extends ResourceState<T> {
  readonly key: string;
  /** True when the data is older than `staleTimeMs`, invalidated, or from an older epoch. */
  readonly isStale: boolean;
  readonly updatedAt: number | undefined;
  /** Revalidate now (joins an in-flight request). */
  refetch(): Promise<Result<T>>;
  invalidate(): void;
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface PaginatedHandle<Page, Item> extends ResourceHandle<readonly Page[]> {
  /** Items of all loaded pages, in order. Reactive. */
  readonly items: readonly Item[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  fetchNext(): Promise<Result<void>>;
}

export interface StreamHandle<V> extends ResourceState<V> {
  readonly streaming: boolean;
  readonly data: V;
  /** (Re)start the stream; resolves with the final value. Cancels a running stream first. */
  start(): Promise<Result<V>>;
  cancel(): void;
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface SubscriptionHandle<V> extends ResourceState<V> {
  readonly data: V;
  /** True between the first message and the end of the connection. */
  readonly connected: boolean;
  restart(): void;
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface QueryOptions {
  /** Dispose the handle with this scope. */
  readonly scope?: Scope;
  /** Fetch automatically. Default true. */
  readonly enabled?: boolean;
  readonly parent?: Span | SpanContext;
}

export interface FetchOptions {
  readonly signal?: AbortSignal;
  /** Await the network even when cached data exists. */
  readonly force?: boolean;
  readonly parent?: Span | SpanContext;
}

export interface OptimisticUpdate {
  readonly kind: 'optimistic';
  readonly key: string;
  readonly resource: CachedResource;
  readonly input: unknown;
  readonly update: (old: unknown) => unknown;
}

export interface InvalidationTarget {
  readonly resource: CachedResource;
  /** Omit to invalidate every entry of the resource. */
  readonly input?: unknown;
}

export interface MutateOptions<O> {
  readonly signal?: AbortSignal;
  readonly parent?: Span | SpanContext;
  /** Applied before the request; rolled back if it fails. */
  readonly optimistic?: readonly OptimisticUpdate[];
  /** Invalidated (and refetched if observed) after success. Optimistic targets are always invalidated. */
  readonly invalidates?: readonly InvalidationTarget[];
  readonly onSuccess?: (output: O) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CachedResource = SingleResource<any, any> | PaginatedResource<any, any, any, any, any> | BatchedResource<any, any, any>;

export interface ResourcesOptions {
  readonly client: DataClient;
  readonly now?: () => number;
}

export interface Resources {
  query<I, O>(resource: SingleResource<I, O>, input: I, options?: QueryOptions): ResourceHandle<O>;
  query<K, R, V>(resource: BatchedResource<K, R, V>, key: K, options?: QueryOptions): ResourceHandle<V>;
  paginated<I, EI, P, Page, Item>(resource: PaginatedResource<I, EI, P, Page, Item>, input: I, options?: QueryOptions): PaginatedHandle<Page, Item>;
  /** Streamed resource; starts immediately unless `enabled: false`. */
  stream<I, C, V>(resource: StreamResource<I, C, V>, input: I, options?: QueryOptions): StreamHandle<V>;
  subscribe<I, C, V>(resource: SubscriptionResource<I, C, V>, input: I, options?: QueryOptions): SubscriptionHandle<V>;
  /** Cached read with SWR semantics (fresh → cache; stale → cached + background revalidate; missing → network). */
  fetch<I, O>(resource: SingleResource<I, O>, input: I, options?: FetchOptions): Promise<Result<O>>;
  fetch<K, R, V>(resource: BatchedResource<K, R, V>, key: K, options?: FetchOptions): Promise<Result<V>>;
  getData<I, O>(resource: SingleResource<I, O>, input: I): O | undefined;
  setData<I, O>(resource: SingleResource<I, O>, input: I, update: O | ((old: O | undefined) => O)): void;
  /** Mark stale and refetch observed entries. No resource → everything. */
  invalidate(resource?: CachedResource, input?: unknown): void;
  /** Run a mutation endpoint with optimistic updates and rollback. */
  mutate<I, O>(endpoint: Endpoint<I, O>, input: I, options?: MutateOptions<O>): Promise<Result<O>>;
  /** Number of cache entries. */
  readonly size: number;
  dispose(): void;
}

/** Build an optimistic update for `mutate`. */
export function optimistic<I, O>(resource: SingleResource<I, O>, input: I, update: (old: O | undefined) => O | undefined): OptimisticUpdate {
  return { kind: 'optimistic', key: entryKey(resource, input), resource, input, update: update as (old: unknown) => unknown };
}

export function entryKey(resource: CachedResource, input: unknown): string {
  const parts = resource.kind === 'batched' ? [input] : resource.key(input);
  return `${resource.id}:${resource.kind === 'batched' && resource.keyId !== undefined ? resource.keyId(input) : stableStringify(parts)}`;
}

const DEFAULT_GC_MS = 5 * 60_000;

interface Entry {
  readonly key: string;
  readonly resource: CachedResource;
  readonly input: unknown;
  readonly status: Box<ResourceStatus>;
  readonly data: Box<unknown>;
  readonly error: Box<SfError | undefined>;
  readonly updatedAt: Box<number | undefined>;
  readonly invalidated: Box<boolean>;
  /** Epoch the data was fetched in. */
  dataEpoch: number;
  observers: number;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
  inflight: { readonly controller: AbortController; readonly promise: Promise<Result<unknown>> } | undefined;
  /** Paginated: page params of loaded pages + next param. */
  readonly pageParams: Box<readonly unknown[]>;
  readonly nextParam: Box<{ readonly value: unknown } | undefined>;
  readonly loadingMore: Box<boolean>;
}

function raceSignal<T>(promise: Promise<Result<T>>, signal: AbortSignal | undefined): Promise<Result<T>> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(err(AbortedError({ cause: signal.reason })));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then((result) => {
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    });
  });
}

function isDiscard(error: SfError): boolean {
  return error.kind === 'aborted' || error.code === StaleEpochError.code;
}

export function createResources(options: ResourcesOptions): Resources {
  const { client } = options;
  const telemetry = client.telemetry;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const batchers = new Map<string, Batcher<unknown, unknown>>();
  const liveStreams = new Set<{ cancel(): void }>();
  let disposed = false;

  const currentEpoch = (): number => untracked(() => client.epoch.current);

  const getEntry = (resource: CachedResource, input: unknown): Entry => {
    const key = entryKey(resource, input);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        key,
        resource,
        input,
        status: box<ResourceStatus>('idle'),
        data: box<unknown>(undefined),
        error: box<SfError | undefined>(undefined),
        updatedAt: box<number | undefined>(undefined),
        invalidated: box(false),
        dataEpoch: currentEpoch(),
        observers: 0,
        gcTimer: undefined,
        inflight: undefined,
        pageParams: box<readonly unknown[]>([]),
        nextParam: box<{ readonly value: unknown } | undefined>(undefined),
        loadingMore: box(false),
      };
      entries.set(key, entry);
    }
    return entry;
  };

  const isStale = (entry: Entry): boolean => {
    const updatedAt = entry.updatedAt.get();
    if (updatedAt === undefined || entry.invalidated.get()) return true;
    if (entry.dataEpoch !== client.epoch.current) return true;
    return now() - updatedAt >= (entry.resource.staleTimeMs ?? 0);
  };

  const scheduleGc = (entry: Entry): void => {
    if (entry.observers > 0 || disposed) return;
    if (entry.gcTimer !== undefined) clearTimeout(entry.gcTimer);
    entry.gcTimer = setTimeout(() => {
      entry.gcTimer = undefined;
      if (entry.observers > 0) return;
      entry.inflight?.controller.abort(new DOMException('Cache entry collected', 'AbortError'));
      entries.delete(entry.key);
    }, entry.resource.gcTimeMs ?? DEFAULT_GC_MS);
  };

  const batcherFor = (resource: BatchedResource<unknown, unknown, unknown>, parent: Span | SpanContext | undefined): Batcher<unknown, unknown> => {
    let batcher = batchers.get(resource.id);
    if (batcher === undefined) {
      batcher = createBatcher<unknown, unknown>({
        maxBatchSize: resource.maxBatchSize,
        window: resource.window,
        ...(resource.keyId === undefined ? {} : { keyId: resource.keyId }),
        onBatch: (size) => telemetry.record(DataMetrics.batchSize, size, { resource: resource.id }),
        loadMany: async (keys, signal) => {
          const response = await client.call(resource.endpoint, keys, { signal, ...(parent === undefined ? {} : { parent }) });
          if (!response.ok) return response;
          return ok(
            keys.map((key, index) => {
              const picked = resource.pick(response.value, key, index);
              if (picked === undefined) return undefined as unknown as Result<unknown>;
              if (typeof picked === 'object' && picked !== null && 'ok' in picked && typeof (picked as { ok: unknown }).ok === 'boolean') {
                return picked as Result<unknown>;
              }
              return ok(picked);
            }),
          );
        },
      });
      batchers.set(resource.id, batcher);
    }
    return batcher;
  };

  /** Fetch the entry's full value (all loaded pages for paginated). */
  const fetchValue = async (entry: Entry, signal: AbortSignal, parent: Span | SpanContext | undefined): Promise<Result<unknown>> => {
    const callOptions = { signal, ...(parent === undefined ? {} : { parent }) };
    const resource = entry.resource;
    if (resource.kind === 'single') return client.call(resource.endpoint, entry.input, callOptions);
    if (resource.kind === 'batched') return batcherFor(resource, parent).load(entry.input, signal);
    // Paginated: refetch as many pages as are loaded (at least one), recomputing params.
    const want = Math.max(1, untracked(() => entry.pageParams.get().length));
    const pages: unknown[] = [];
    const params: unknown[] = [];
    let param: unknown = resource.pagination.initial;
    for (let i = 0; i < want; i += 1) {
      const page = await client.call(resource.endpoint, resource.request(entry.input, param), callOptions);
      if (!page.ok) return page;
      pages.push(page.value);
      params.push(param);
      const next = resource.pagination.next(page.value, pages);
      if (next === undefined) {
        param = undefined;
        break;
      }
      param = next;
    }
    const last = pages[pages.length - 1];
    const next = last === undefined ? undefined : resource.pagination.next(last, pages);
    batch(() => {
      entry.pageParams.set(params);
      entry.nextParam.set(next === undefined ? undefined : { value: next });
    });
    return ok(pages);
  };

  const revalidate = (entry: Entry, parent?: Span | SpanContext): Promise<Result<unknown>> => {
    if (entry.inflight !== undefined) return entry.inflight.promise;
    if (disposed) return Promise.resolve(err(ResourceDisposedError()));
    const controller = new AbortController();
    const epochAtStart = currentEpoch();
    const hadData = untracked(() => entry.updatedAt.get()) !== undefined;
    entry.status.set(hadData ? 'refreshing' : 'loading');
    const promise = fetchValue(entry, controller.signal, parent).then((result) => {
      if (entry.inflight?.controller !== controller) return result; // superseded (epoch bump / optimistic write)
      entry.inflight = undefined;
      if (result.ok) {
        entry.dataEpoch = epochAtStart;
        batch(() => {
          entry.data.set(result.value);
          entry.error.set(undefined);
          entry.updatedAt.set(now());
          entry.invalidated.set(false);
          entry.status.set('ready');
        });
      } else if (isDiscard(result.error)) {
        entry.status.set(hadData ? 'ready' : 'idle');
      } else {
        batch(() => {
          entry.error.set(result.error);
          entry.status.set('error');
        });
      }
      return result;
    });
    entry.inflight = { controller, promise };
    return promise;
  };

  const read = (entry: Entry, mode: 'observe' | 'fetch', parent?: Span | SpanContext): Promise<Result<unknown>> | undefined => {
    const attrs = { resource: entry.resource.id };
    const hasData = untracked(() => entry.updatedAt.get()) !== undefined;
    if (!hasData && entry.inflight !== undefined) return entry.inflight.promise; // dedup join: neither hit nor miss
    if (!hasData) {
      telemetry.record(DataMetrics.cacheMiss, 1, attrs);
      return revalidate(entry, parent);
    }
    if (untracked(() => isStale(entry))) {
      telemetry.record(DataMetrics.cacheStaleHit, 1, attrs);
      const pending = revalidate(entry, parent);
      return mode === 'fetch' ? Promise.resolve(ok(untracked(() => entry.data.get()))) : pending;
    }
    telemetry.record(DataMetrics.cacheHit, 1, attrs);
    return mode === 'fetch' ? Promise.resolve(ok(untracked(() => entry.data.get()))) : undefined;
  };

  const abortInflight = (entry: Entry, reason: string): void => {
    const inflight = entry.inflight;
    if (inflight === undefined) return;
    entry.inflight = undefined;
    inflight.controller.abort(new DOMException(reason, 'AbortError'));
    entry.status.set(untracked(() => entry.updatedAt.get()) === undefined ? 'idle' : 'ready');
  };

  const invalidateEntry = (entry: Entry): void => {
    entry.invalidated.set(true);
    if (entry.observers > 0) void revalidate(entry);
  };

  // Epoch bump (R4.3 refresh): stale everything, drop in-flight, refetch observed — keep showing old data (R4.7).
  const stopEpochWatch = watch(
    () => client.epoch.current,
    () => {
      telemetry.event('cache.epoch', { subsystem: DATA_SUBSYSTEMS.cache, attrs: { epoch: currentEpoch(), entries: entries.size } });
      for (const entry of entries.values()) {
        abortInflight(entry, 'Epoch changed');
        entry.invalidated.set(true);
        if (entry.observers > 0) void revalidate(entry);
      }
    },
  );

  const makeHandle = (entry: Entry, options: QueryOptions): ResourceHandle<unknown> & { readonly entry: Entry } => {
    let handleDisposed = false;
    entry.observers += 1;
    if (entry.gcTimer !== undefined) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = undefined;
    }
    const dispose = (): void => {
      if (handleDisposed) return;
      handleDisposed = true;
      entry.observers -= 1;
      scheduleGc(entry);
    };
    options.scope?.defer(dispose);
    if (options.enabled !== false && !disposed) void read(entry, 'observe', options.parent);
    return {
      entry,
      key: entry.key,
      get status() {
        return entry.status.get();
      },
      get data() {
        return entry.data.get();
      },
      get error() {
        return entry.error.get();
      },
      get updatedAt() {
        return entry.updatedAt.get();
      },
      get isStale() {
        return isStale(entry);
      },
      refetch() {
        if (handleDisposed) return Promise.resolve(err(ResourceDisposedError()));
        return revalidate(entry, options.parent);
      },
      invalidate() {
        invalidateEntry(entry);
      },
      dispose,
      [Symbol.dispose]: dispose,
    };
  };

  const resources: Resources = {
    query(resource: SingleResource<unknown, unknown> | BatchedResource<unknown, unknown, unknown>, input: unknown, options: QueryOptions = {}) {
      return makeHandle(getEntry(resource, input), options) as ResourceHandle<never>;
    },

    paginated<I, EI, P, Page, Item>(resource: PaginatedResource<I, EI, P, Page, Item>, input: I, options: QueryOptions = {}): PaginatedHandle<Page, Item> {
      const entry = getEntry(resource, input);
      const handle = makeHandle(entry, options);
      const pagesOf = (): readonly Page[] => (entry.data.get() as readonly Page[] | undefined) ?? [];
      const extra = {
        get items(): readonly Item[] {
          return pagesOf().flatMap((page) => resource.pagination.items(page));
        },
        get hasMore(): boolean {
          return entry.updatedAt.get() === undefined || entry.nextParam.get() !== undefined;
        },
        get loadingMore(): boolean {
          return entry.loadingMore.get();
        },
        async fetchNext(): Promise<Result<void>> {
          if (entry.inflight !== undefined) {
            const settled = await entry.inflight.promise;
            if (!settled.ok) return settled;
          }
          if (untracked(() => entry.updatedAt.get()) === undefined) {
            const first = await revalidate(entry, options.parent);
            return first.ok ? ok() : first;
          }
          const next = untracked(() => entry.nextParam.get());
          if (next === undefined || untracked(() => entry.loadingMore.get())) return ok();
          entry.loadingMore.set(true);
          const page = await client.call(resource.endpoint, resource.request(input, next.value as P), options.parent === undefined ? {} : { parent: options.parent });
          entry.loadingMore.set(false);
          if (!page.ok) {
            if (!isDiscard(page.error)) entry.error.set(page.error);
            return page;
          }
          const pages = [...untracked(pagesOf), page.value];
          const following = resource.pagination.next(page.value, pages);
          batch(() => {
            entry.data.set(pages);
            entry.pageParams.set([...untracked(() => entry.pageParams.get()), next.value]);
            entry.nextParam.set(following === undefined ? undefined : { value: following });
            entry.error.set(undefined);
          });
          return ok();
        },
      };
      return Object.defineProperties(handle, Object.getOwnPropertyDescriptors(extra)) as unknown as PaginatedHandle<Page, Item>;
    },

    stream<I, C, V>(resource: StreamResource<I, C, V>, input: I, options: QueryOptions = {}): StreamHandle<V> {
      const status = box<ResourceStatus>('idle');
      const data = box<V>(resource.initial());
      const error = box<SfError | undefined>(undefined);
      const streaming = box(false);
      let controller: AbortController | undefined;
      let handleDisposed = false;
      let received = false;
      const cancel = (): void => {
        if (controller === undefined) return;
        controller.abort(new DOMException('Stream cancelled', 'AbortError'));
        controller = undefined;
        batch(() => {
          streaming.set(false);
          status.set(received ? 'ready' : 'idle');
        });
      };
      const handle: StreamHandle<V> = {
        get status() {
          return status.get();
        },
        get data() {
          return data.get();
        },
        get error() {
          return error.get();
        },
        get streaming() {
          return streaming.get();
        },
        async start() {
          if (handleDisposed) return err(ResourceDisposedError());
          cancel();
          const own = new AbortController();
          controller = own;
          batch(() => {
            data.set(resource.initial());
            error.set(undefined);
            status.set('loading');
            streaming.set(true);
          });
          received = false;
          const result = await client.stream(
            resource.endpoint,
            input,
            (chunk) => {
              if (controller !== own) return;
              received = true;
              data.set(resource.reduce(untracked(() => data.get()), chunk));
            },
            { signal: own.signal, ...(options.parent === undefined ? {} : { parent: options.parent }) },
          );
          if (controller !== own) return result.ok ? ok(untracked(() => data.get())) : result;
          controller = undefined;
          batch(() => {
            streaming.set(false);
            if (result.ok) status.set('ready');
            else if (isDiscard(result.error)) status.set(received ? 'ready' : 'idle');
            else {
              error.set(result.error);
              status.set('error');
            }
          });
          return result.ok ? ok(untracked(() => data.get())) : result;
        },
        cancel,
        dispose() {
          if (handleDisposed) return;
          handleDisposed = true;
          cancel();
          liveStreams.delete(handle);
        },
        [Symbol.dispose]() {
          handle.dispose();
        },
      };
      liveStreams.add(handle);
      options.scope?.defer(() => handle.dispose());
      if (options.enabled !== false) void handle.start();
      return handle;
    },

    subscribe<I, C, V>(resource: SubscriptionResource<I, C, V>, input: I, options: QueryOptions = {}): SubscriptionHandle<V> {
      const status = box<ResourceStatus>('idle');
      const data = box<V>(resource.initial());
      const error = box<SfError | undefined>(undefined);
      const connected = box(false);
      let controller: AbortController | undefined;
      let handleDisposed = false;

      const connect = (): void => {
        controller?.abort(new DOMException('Subscription restarted', 'AbortError'));
        if (handleDisposed) return;
        const own = new AbortController();
        controller = own;
        status.set(untracked(() => status.get()) === 'ready' ? 'refreshing' : 'loading');
        const once: Task<void> = (signal) =>
          client.stream(
            resource.endpoint,
            input,
            (chunk) => {
              if (controller !== own) return;
              batch(() => {
                data.set(resource.reduce(untracked(() => data.get()), chunk));
                connected.set(true);
                error.set(undefined);
                status.set('ready');
              });
            },
            { signal, ...(options.parent === undefined ? {} : { parent: options.parent }) },
          ).then((result) => {
            if (controller === own) connected.set(false);
            return result;
          });
        const policy = resource.reconnect;
        const run =
          policy === false
            ? once
            : retry(once, { ...policy, retryIf: (e, n) => !isDiscard(e) && (policy.retryIf ?? defaultRetryIf)(e, n) });
        void run(own.signal).then((result) => {
          if (controller !== own) return;
          controller = undefined;
          batch(() => {
            connected.set(false);
            if (!result.ok && !isDiscard(result.error)) {
              error.set(result.error);
              status.set('error');
            } else if (!result.ok && result.error.code === StaleEpochError.code) {
              // Old-epoch subscription ended: reconnect in the new epoch.
              queueMicrotask(connect);
            }
          });
        });
      };
      const stopWatch = watch(
        () => client.epoch.current,
        () => connect(),
      );
      const handle: SubscriptionHandle<V> = {
        get status() {
          return status.get();
        },
        get data() {
          return data.get();
        },
        get error() {
          return error.get();
        },
        get connected() {
          return connected.get();
        },
        restart: connect,
        dispose() {
          if (handleDisposed) return;
          handleDisposed = true;
          stopWatch();
          controller?.abort(new DOMException('Subscription disposed', 'AbortError'));
          controller = undefined;
          liveStreams.delete(cancelable);
        },
        [Symbol.dispose]() {
          handle.dispose();
        },
      };
      const cancelable = { cancel: () => handle.dispose() };
      liveStreams.add(cancelable);
      options.scope?.defer(() => handle.dispose());
      if (options.enabled !== false) connect();
      return handle;
    },

    fetch(resource: SingleResource<unknown, unknown> | BatchedResource<unknown, unknown, unknown>, input: unknown, options: FetchOptions = {}) {
      const entry = getEntry(resource, input);
      const pending = options.force === true ? revalidate(entry, options.parent) : read(entry, 'fetch', options.parent);
      scheduleGc(entry);
      return raceSignal(pending ?? Promise.resolve(ok(untracked(() => entry.data.get()))), options.signal) as Promise<Result<never>>;
    },

    getData(resource, input) {
      return entries.get(entryKey(resource, input))?.data.get() as never;
    },

    setData<I, O>(resource: SingleResource<I, O>, input: I, update: O | ((old: O | undefined) => O)) {
      const entry = getEntry(resource, input);
      abortInflight(entry, 'Data set locally');
      const next = typeof update === 'function' ? (update as (old: O | undefined) => O)(untracked(() => entry.data.get()) as O | undefined) : update;
      entry.dataEpoch = currentEpoch();
      batch(() => {
        entry.data.set(next);
        entry.updatedAt.set(now());
        entry.error.set(undefined);
        entry.invalidated.set(false);
        entry.status.set('ready');
      });
      scheduleGc(entry);
    },

    invalidate(resource, input) {
      for (const entry of entries.values()) {
        if (resource !== undefined && entry.resource.id !== resource.id) continue;
        if (resource !== undefined && input !== undefined && entry.key !== entryKey(resource, input)) continue;
        invalidateEntry(entry);
      }
    },

    async mutate<I, O>(endpoint: Endpoint<I, O>, input: I, options: MutateOptions<O> = {}): Promise<Result<O>> {
      interface Saved {
        readonly entry: Entry;
        readonly data: unknown;
        readonly updatedAt: number | undefined;
        readonly status: ResourceStatus;
        readonly applied: unknown;
      }
      const saved: Saved[] = [];
      batch(() => {
        for (const update of options.optimistic ?? []) {
          const entry = getEntry(update.resource, update.input);
          abortInflight(entry, 'Optimistic update');
          const previous = untracked(() => entry.data.get());
          const applied = update.update(previous);
          saved.push({ entry, data: previous, updatedAt: untracked(() => entry.updatedAt.get()), status: untracked(() => entry.status.get()), applied });
          entry.data.set(applied);
          entry.updatedAt.set(now());
          entry.status.set('ready');
        }
      });
      const result = await client.call(endpoint, input, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.parent === undefined ? {} : { parent: options.parent }),
      });
      if (!result.ok) {
        batch(() => {
          for (const s of [...saved].reverse()) {
            if (untracked(() => s.entry.data.get()) !== s.applied) continue; // someone wrote after us; keep theirs
            s.entry.data.set(s.data);
            s.entry.updatedAt.set(s.updatedAt);
            s.entry.status.set(s.status === 'loading' || s.status === 'refreshing' ? (s.updatedAt === undefined ? 'idle' : 'ready') : s.status);
          }
        });
        telemetry.event('cache.rollback', { subsystem: DATA_SUBSYSTEMS.cache, attrs: { endpoint: endpoint.id, entries: saved.length, code: result.error.code } });
        for (const s of saved) invalidateEntry(s.entry);
        for (const s of saved) scheduleGc(s.entry);
        return result;
      }
      options.onSuccess?.(result.value);
      for (const s of saved) {
        invalidateEntry(s.entry);
        scheduleGc(s.entry);
      }
      for (const target of options.invalidates ?? []) resources.invalidate(target.resource, target.input);
      return result;
    },

    get size() {
      return entries.size;
    },

    dispose() {
      disposed = true;
      stopEpochWatch();
      for (const stream of [...liveStreams]) stream.cancel();
      for (const entry of entries.values()) {
        if (entry.gcTimer !== undefined) clearTimeout(entry.gcTimer);
        entry.inflight?.controller.abort(new DOMException('Resources disposed', 'AbortError'));
      }
      entries.clear();
    },
  };
  return resources;
}
