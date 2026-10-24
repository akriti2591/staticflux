/**
 * Resource kinds (R9.2) as typed declarations. A resource binds an endpoint to
 * cache semantics; the `Resources` manager (resources.ts) runs them.
 *
 * | Kind          | Feature need (FEATURE-NEEDS.md) | Cached | Handle                 |
 * |---------------|---------------------------------|--------|------------------------|
 * | single        | `doc.get`                       | SWR    | `ResourceHandle<T>`    |
 * | paginated     | `docs.list` (cursor / offset)   | SWR    | `PaginatedHandle`      |
 * | batched       | `user.batchProfiles`            | SWR    | `ResourceHandle<V>`    |
 * | stream        | `agent.reply`                   | no     | `StreamHandle<V>`      |
 * | subscription  | presence / live updates         | no     | `SubscriptionHandle<V>`|
 */
import type { RetryPolicy, Result, TokenId } from '@staticflux/core';
import type { BatchWindow } from './batch.js';
import type { Endpoint, StreamEndpoint } from './transport.js';

export type KeyPart = string | number | boolean | null | readonly KeyPart[] | { readonly [key: string]: KeyPart | undefined };

export interface CacheTiming {
  /** Data younger than this is fresh (no refetch on read). Default 0 (always revalidate). */
  readonly staleTimeMs?: number;
  /** Unobserved entries are dropped after this. Default 5 min. */
  readonly gcTimeMs?: number;
}

export interface SingleResource<I, O> extends CacheTiming {
  readonly kind: 'single';
  readonly id: TokenId;
  readonly endpoint: Endpoint<I, O>;
  readonly key: (input: I) => readonly KeyPart[];
}

export interface Pagination<P, Page, Item> {
  readonly initial: P;
  /** Param for the page after `last`, or undefined when there are no more pages. */
  next(last: Page, pages: readonly Page[]): P | undefined;
  items(page: Page): readonly Item[];
}

export interface PaginatedResource<I, EI, P, Page, Item> extends CacheTiming {
  readonly kind: 'paginated';
  readonly id: TokenId;
  readonly endpoint: Endpoint<EI, Page>;
  readonly key: (input: I) => readonly KeyPart[];
  /** Map resource input + page param to the endpoint input. */
  readonly request: (input: I, page: P) => EI;
  readonly pagination: Pagination<P, Page, Item>;
}

export interface BatchedResource<K, R, V> extends CacheTiming {
  readonly kind: 'batched';
  readonly id: TokenId;
  readonly endpoint: Endpoint<readonly K[], R>;
  /** Value for `key` from the batch response; undefined → `SF-DATA-020`. Default `response[index]`. */
  readonly pick: (response: R, key: K, index: number) => V | Result<V> | undefined;
  readonly keyId: ((key: K) => string) | undefined;
  readonly maxBatchSize: number;
  readonly window: BatchWindow;
}

export interface StreamResource<I, C, V> {
  readonly kind: 'stream';
  readonly id: TokenId;
  readonly endpoint: StreamEndpoint<I, C>;
  readonly initial: () => V;
  readonly reduce: (accumulated: V, chunk: C) => V;
}

export interface SubscriptionResource<I, C, V> {
  readonly kind: 'subscription';
  readonly id: TokenId;
  readonly endpoint: StreamEndpoint<I, C>;
  readonly initial: () => V;
  readonly reduce: (accumulated: V, chunk: C) => V;
  /** Reconnect policy (the only retry layer for streams). `false` disables. */
  readonly reconnect: Omit<RetryPolicy, 'random'> | false;
}

const defaultKey = <I>(input: I): readonly KeyPart[] => (input === undefined ? [] : [input as unknown as KeyPart]);

export function defineResource<I, O>(init: {
  readonly id: TokenId;
  readonly endpoint: Endpoint<I, O>;
  readonly key?: (input: I) => readonly KeyPart[];
} & CacheTiming): SingleResource<I, O> {
  return Object.freeze({ ...init, kind: 'single', key: init.key ?? defaultKey });
}

export function definePaginatedResource<I, EI, P, Page, Item>(init: {
  readonly id: TokenId;
  readonly endpoint: Endpoint<EI, Page>;
  readonly key?: (input: I) => readonly KeyPart[];
  readonly request: (input: I, page: P) => EI;
  readonly pagination: Pagination<P, Page, Item>;
} & CacheTiming): PaginatedResource<I, EI, P, Page, Item> {
  return Object.freeze({ ...init, kind: 'paginated', key: init.key ?? defaultKey });
}

export function defineBatchedResource<K, R, V = R extends readonly (infer E)[] ? E : never>(init: {
  readonly id: TokenId;
  readonly endpoint: Endpoint<readonly K[], R>;
  readonly pick?: (response: R, key: K, index: number) => V | Result<V> | undefined;
  readonly keyId?: (key: K) => string;
  readonly maxBatchSize?: number;
  readonly window?: BatchWindow;
} & CacheTiming): BatchedResource<K, R, V> {
  return Object.freeze({
    ...init,
    kind: 'batched',
    pick: init.pick ?? ((response: R, _key: K, index: number) => (response as unknown as readonly V[])[index]),
    keyId: init.keyId,
    maxBatchSize: init.maxBatchSize ?? 100,
    window: init.window ?? 'microtask',
  });
}

export function defineStreamResource<I, C, V>(init: {
  readonly id: TokenId;
  readonly endpoint: StreamEndpoint<I, C>;
  readonly initial: () => V;
  readonly reduce: (accumulated: V, chunk: C) => V;
}): StreamResource<I, C, V> {
  return Object.freeze({ ...init, kind: 'stream' });
}

export function defineSubscription<I, C, V>(init: {
  readonly id: TokenId;
  readonly endpoint: StreamEndpoint<I, C>;
  readonly initial: () => V;
  readonly reduce: (accumulated: V, chunk: C) => V;
  readonly reconnect?: Omit<RetryPolicy, 'random'> | false;
}): SubscriptionResource<I, C, V> {
  return Object.freeze({
    ...init,
    kind: 'subscription',
    reconnect: init.reconnect ?? { attempts: 5, baseDelayMs: 500, maxDelayMs: 15_000, jitter: 'full' },
  });
}

/** Cursor pagination: `request(input, cursor)`; `cursor` is undefined for the first page. */
export function cursorPagination<Page, Item>(options: {
  readonly items: (page: Page) => readonly Item[];
  readonly nextCursor: (page: Page) => string | null | undefined;
}): Pagination<string | undefined, Page, Item> {
  return {
    initial: undefined,
    items: options.items,
    next: (last) => options.nextCursor(last) ?? undefined,
  };
}

export interface OffsetParam {
  readonly offset: number;
  readonly limit: number;
}

/** Offset pagination: stops when `total` is reached or a page comes back short. */
export function offsetPagination<Page, Item>(options: {
  readonly limit: number;
  readonly items: (page: Page) => readonly Item[];
  readonly total?: (page: Page) => number | undefined;
}): Pagination<OffsetParam, Page, Item> {
  return {
    initial: { offset: 0, limit: options.limit },
    items: options.items,
    next: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + options.items(p).length, 0);
      const total = options.total?.(last);
      if (total !== undefined ? loaded >= total : options.items(last).length < options.limit) return undefined;
      return { offset: loaded, limit: options.limit };
    },
  };
}
