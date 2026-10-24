/**
 * Chunk loader runtime: resolves logical ids through the manifest and loads them via
 * a strategy (dynamic import by default), with gating before any fetch (I-8), profile
 * scoping (R12.10), dependency preloading (`modulepreload`), dedup (single-flight +
 * module cache), retries (full-jitter backoff, cache-busting) and telemetry.
 *
 * Chunk lifecycle (typed machine `loader/chunk`):
 *   idle → preloaded → loading → loaded
 *   idle → loading;  loading → failed → loading (retry on next request)
 */
import {
  AbortedError,
  createMachine,
  createNoopTelemetry,
  createSingleFlight,
  defineMachine,
  err,
  type Machine,
  ok,
  type Result,
  retry,
  type RetryPolicy,
  type Span,
  type SpanContext,
  type Telemetry,
} from '@staticflux/core';
import type { ChunkIdShape, WarmupTier } from './chunk.js';
import { createPreloadInjector, type LoaderDocument, type LoaderIsolationPolicy, noIsolationPolicy, type PreloadInjector } from './dom.js';
import { ChunkDeniedError, ChunkFetchError, ProfileExcludedError } from './errors.js';
import { chunkClosure, fileUrl, getChunk, type ManifestChunk, servesProfile, type SfManifest } from './manifest.js';
import { dynamicImportStrategy, type Importer, type LoadStrategy, nativeImporter } from './strategies.js';
import { LOADER_SUBSYSTEMS, loaderMetrics } from './telemetry.js';

export const chunkMachine = defineMachine({
  id: 'loader/chunk',
  initial: 'idle',
  states: ['idle', 'preloaded', 'loading', 'loaded', 'failed'],
  transitions: {
    idle: { preload: 'preloaded', load: 'loading' },
    preloaded: { load: 'loading' },
    loading: { succeed: 'loaded', fail: 'failed', abort: 'idle' },
    failed: { load: 'loading' },
  },
  terminal: ['loaded'],
});

export type ChunkState = (typeof chunkMachine.states)[number];

/** Decision of the chunk gate port. The gate package plugs in here (R6.12). */
export type ChunkGateDecision = boolean | { readonly allow: true } | { readonly allow: false; readonly reason: string };

/** Gating hook consulted before any fetch. Synchronous O(1) (decision tables, R6.9). */
export type ChunkGate = (id: ChunkIdShape) => ChunkGateDecision;

export const allowAllChunks: ChunkGate = () => true;

/** Where the chunk's code came from (journey classification R17.8). */
export type CodeSource = 'network' | 'http-cache' | 'sw' | 'memory' | 'unknown';

/** The subset of `PerformanceResourceTiming` used to classify code source. */
export interface ResourceTimingLike {
  readonly transferSize?: number;
  readonly decodedBodySize?: number;
  readonly workerStart?: number;
  readonly deliveryType?: string;
}

export function classifyCodeSource(entry: ResourceTimingLike | undefined): CodeSource {
  if (entry === undefined) return 'unknown';
  if ((entry.workerStart ?? 0) > 0) return 'sw';
  if (entry.deliveryType === 'cache') return 'http-cache';
  if (entry.transferSize === 0 && (entry.decodedBodySize ?? 0) > 0) return 'http-cache';
  if (entry.transferSize === undefined) return 'unknown';
  return 'network';
}

function defaultResourceTiming(url: string): ResourceTimingLike | undefined {
  const perf = (globalThis as { performance?: { getEntriesByName?: (n: string, t: string) => unknown[] } }).performance;
  if (typeof perf?.getEntriesByName !== 'function') return undefined;
  return perf.getEntriesByName(url, 'resource')[0] as ResourceTimingLike | undefined;
}

/** Why a load was requested — warmup hits are measured against `demand`. */
export type LoadOrigin = 'demand' | 'boot' | WarmupTier;

export interface LoadOptions {
  readonly signal?: AbortSignal;
  readonly origin?: LoadOrigin;
  /** Parent span (e.g. the navigation `load` stage). */
  readonly parent?: Span | SpanContext;
}

export interface ChunkInfo {
  readonly id: ChunkIdShape;
  readonly state: ChunkState;
  readonly attempts: number;
  readonly durationMs: number | undefined;
  readonly codeSource: CodeSource | undefined;
  /** Warmup tier that touched it first (preload/load), if any. */
  readonly warmedBy: LoadOrigin | undefined;
  readonly demanded: boolean;
}

export interface ChunkLoader {
  readonly manifest: SfManifest;
  /** Gate + profile check for `id` and its dependencies, without fetching. */
  check(id: ChunkIdShape): Result<readonly ManifestChunk[]>;
  /** Load (execute) a chunk and its dependencies. Deduplicated; retried; never fetched when denied. */
  load<T = unknown>(id: ChunkIdShape, options?: LoadOptions): Promise<Result<T>>;
  /** Inject `modulepreload`/stylesheet links for the chunk closure (no execution). */
  preload(id: ChunkIdShape, options?: Omit<LoadOptions, 'signal'>): Result<void>;
  state(id: ChunkIdShape): ChunkState;
  /** Hashed entry URL of a chunk. */
  urlOf(id: ChunkIdShape): Result<string>;
  /** Devtools/journey view of every touched chunk. */
  inspect(): readonly ChunkInfo[];
  /** Chunks warmed but never demanded (wasted bytes, R19.10). */
  wasted(): readonly ChunkIdShape[];
}

export interface ChunkLoaderOptions {
  readonly manifest: SfManifest;
  readonly telemetry?: Telemetry;
  readonly importer?: Importer;
  /** Strategy for local chunks (default: dynamic import via `importer`). */
  readonly strategy?: LoadStrategy;
  /** Strategy for chunks with `remote` (federation). */
  readonly remoteStrategy?: LoadStrategy;
  readonly canLoad?: ChunkGate;
  /** Current app profile key (`web:expanded`); chunks scoped to other profiles are never fetched. */
  readonly profile?: () => string | undefined;
  readonly document?: LoaderDocument | undefined;
  readonly isolation?: LoaderIsolationPolicy;
  /** Retry policy (default: 3 attempts, 200 ms base, full jitter). */
  readonly retry?: Omit<RetryPolicy, 'onRetry'>;
  readonly resourceTiming?: (url: string) => ResourceTimingLike | undefined;
}

interface Entry {
  readonly machine: Machine<ChunkState, 'preload' | 'load' | 'succeed' | 'fail' | 'abort'>;
  module: unknown;
  attempts: number;
  durationMs: number | undefined;
  codeSource: CodeSource | undefined;
  warmedBy: LoadOrigin | undefined;
  demanded: boolean;
}

function denialReason(decision: ChunkGateDecision): string | undefined {
  if (decision === true) return undefined;
  if (decision === false) return 'denied';
  return decision.allow ? undefined : decision.reason;
}

export function createChunkLoader(options: ChunkLoaderOptions): ChunkLoader {
  const { manifest } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const strategy = options.strategy ?? dynamicImportStrategy(options.importer ?? nativeImporter);
  const remoteStrategy = options.remoteStrategy;
  const canLoad = options.canLoad ?? allowAllChunks;
  const injector: PreloadInjector = createPreloadInjector(options.document, options.isolation ?? noIsolationPolicy);
  const retryPolicy: Omit<RetryPolicy, 'onRetry'> = options.retry ?? { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 };
  const resourceTiming = options.resourceTiming ?? defaultResourceTiming;
  const flights = createSingleFlight<string, unknown>();
  const entries = new Map<string, Entry>();

  const entryOf = (id: ChunkIdShape): Entry => {
    let entry = entries.get(id);
    if (entry === undefined) {
      const machine = createMachine(chunkMachine);
      machine.onTransition((record) => {
        telemetry.event(`lifecycle.${record.machine}.${record.from}→${record.to}`, {
          subsystem: LOADER_SUBSYSTEMS.chunk,
          level: record.to === 'failed' ? 'critical' : 'verbose',
          attrs: { chunk: id, from: record.from, to: record.to, event: record.event },
        });
      });
      entry = { machine, module: undefined, attempts: 0, durationMs: undefined, codeSource: undefined, warmedBy: undefined, demanded: false };
      entries.set(id, entry);
    }
    return entry;
  };

  const check = (id: ChunkIdShape): Result<readonly ManifestChunk[]> => {
    const closure = chunkClosure(manifest, [id]);
    if (!closure.ok) return closure;
    const profile = options.profile?.();
    for (const c of closure.value) {
      if (!servesProfile(c, profile)) {
        return err(ProfileExcludedError({ message: `Chunk "${c.id}" does not serve profile "${profile ?? ''}".`, details: { chunk: c.id, requested: id, profile: profile ?? null } }));
      }
      const reason = denialReason(canLoad(c.id));
      if (reason !== undefined) {
        telemetry.record(loaderMetrics.chunkDenied, 1, { chunk: c.id, reason });
        telemetry.event('chunk.denied', { subsystem: LOADER_SUBSYSTEMS.chunk, attrs: { chunk: c.id, requested: id, reason } });
        return err(ChunkDeniedError({ message: `Chunk "${c.id}" is gated out (${reason}); not fetched.`, details: { chunk: c.id, requested: id, reason } }));
      }
    }
    return closure;
  };

  const injectLinks = (closure: readonly ManifestChunk[]): void => {
    for (const c of closure) {
      if (c.remote !== undefined) continue;
      for (const file of c.files) injector.modulepreload(fileUrl(manifest, file), c.integrity?.[file]);
      for (const file of c.css) injector.stylesheet(fileUrl(manifest, file));
    }
  };

  const noteOrigin = (entry: Entry, origin: LoadOrigin): void => {
    if (origin === 'demand') {
      if (!entry.demanded && entry.warmedBy !== undefined && entry.warmedBy !== 'demand') {
        telemetry.record(loaderMetrics.warmupHit, 1, { warmedBy: entry.warmedBy });
      }
      entry.demanded = true;
    } else {
      entry.warmedBy ??= origin;
    }
  };

  const loadOne = async (c: ManifestChunk, origin: LoadOrigin, signal: AbortSignal, parent: Span | SpanContext | undefined): Promise<Result<unknown>> => {
    const entry = entryOf(c.id);
    noteOrigin(entry, origin);
    if (entry.machine.is('loaded')) return ok(entry.module);
    const run = async (shared: AbortSignal): Promise<Result<unknown>> => {
      entry.machine.send('load');
      const isRemote = c.remote !== undefined && remoteStrategy !== undefined;
      const used = isRemote ? (remoteStrategy as LoadStrategy) : strategy;
      const span = telemetry.span('chunk.load', {
        subsystem: LOADER_SUBSYSTEMS.chunk,
        parent,
        attrs: { chunk: c.id, tier: c.tier, strategy: used.kind, origin },
      });
      const started = telemetry.now();
      let attempt = 0;
      const result = await retry<unknown>(
        async (s) => {
          attempt += 1;
          entry.attempts += 1;
          return used.load({ chunk: c, manifest, attempt, signal: s });
        },
        retryPolicy,
      )(shared);
      const durationMs = telemetry.now() - started;
      if (result.ok) {
        const [first] = c.files;
        const codeSource = first === undefined || c.remote !== undefined ? 'unknown' : classifyCodeSource(resourceTiming(fileUrl(manifest, first)));
        entry.module = result.value;
        entry.durationMs = durationMs;
        entry.codeSource = codeSource;
        entry.machine.send('succeed');
        span.set('attempts', attempt);
        span.set('codeSource', codeSource);
        span.end('ok');
        telemetry.record(loaderMetrics.chunkLoad, durationMs, { chunk: c.id, tier: c.tier, strategy: used.kind, codeSource, origin }, span);
        return result;
      }
      if (result.error.kind === 'aborted') {
        entry.machine.send('abort');
        span.end('cancelled');
        return result;
      }
      entry.machine.send('fail');
      const error = result.error.code === ChunkFetchError.code || result.error.kind !== 'unknown' ? result.error : ChunkFetchError({ cause: result.error, details: { chunk: c.id } });
      span.set('attempts', attempt);
      span.end('error', error);
      telemetry.record(loaderMetrics.chunkFailed, 1, { chunk: c.id, code: error.code }, span);
      return err(error);
    };
    return flights.run(c.id, run, signal);
  };

  return {
    manifest,
    check,
    async load<T = unknown>(id: ChunkIdShape, loadOptions: LoadOptions = {}): Promise<Result<T>> {
      const signal = loadOptions.signal ?? new AbortController().signal;
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      const origin = loadOptions.origin ?? 'demand';
      const closure = check(id);
      if (!closure.ok) return err(closure.error);
      injectLinks(closure.value);
      const target = closure.value[closure.value.length - 1] as ManifestChunk;
      const deps = closure.value.slice(0, -1);
      // Dependencies execute first (in parallel); their files are already preloading.
      const depResults = await Promise.all(deps.map((d) => loadOne(d, origin, signal, loadOptions.parent)));
      const failed = depResults.find((r) => !r.ok);
      if (failed !== undefined && !failed.ok) return err(failed.error);
      const result = await loadOne(target, origin, signal, loadOptions.parent);
      return result as Result<T>;
    },
    preload(id, preloadOptions = {}) {
      const closure = check(id);
      if (!closure.ok) return err(closure.error);
      injectLinks(closure.value);
      const origin = preloadOptions.origin ?? 'speculative';
      for (const c of closure.value) {
        const entry = entryOf(c.id);
        noteOrigin(entry, origin);
        if (entry.machine.can('preload')) entry.machine.send('preload');
      }
      return ok();
    },
    state(id) {
      return entries.get(id)?.machine.state ?? 'idle';
    },
    urlOf(id) {
      const found = getChunk(manifest, id);
      if (!found.ok) return err(found.error);
      return ok(fileUrl(manifest, found.value.files[0] ?? ''));
    },
    inspect() {
      return [...entries].map(([id, e]) => ({
        id: id as ChunkIdShape,
        state: e.machine.state,
        attempts: e.attempts,
        durationMs: e.durationMs,
        codeSource: e.codeSource,
        warmedBy: e.warmedBy,
        demanded: e.demanded,
      }));
    },
    wasted() {
      return [...entries].filter(([, e]) => e.warmedBy !== undefined && !e.demanded).map(([id]) => id as ChunkIdShape);
    },
  };
}

/**
 * Adapt a chunk to a `load(signal)` function (e.g. the runtime `FeatureManifest.load`),
 * which rejects with the typed SfError on failure.
 */
export function chunkLoadFunction<T>(loader: ChunkLoader, id: ChunkIdShape): (signal: AbortSignal) => Promise<T> {
  return async (signal) => {
    const result = await loader.load<T>(id, { signal });
    if (!result.ok) throw result.error;
    return result.value;
  };
}
