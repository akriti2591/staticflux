/**
 * Built-in async facts (SF-Δ26, R18.14) for the async fact lane. Each probe reads only
 * through `PlatformEnv`, catches API errors itself and returns a value describing absence;
 * it throws only for truly unexpected failures (the lane then marks the fact `failed`).
 *
 * - `webGpuAdapterFact` — `navigator.gpu.requestAdapter()`: status, adapter info, features, limits.
 * - `defineCodecSupportFact(queries)` / `codecSupportFact` — WebCodecs `isConfigSupported` matrix.
 * - `opfsSyncAccessFact` — `createSyncAccessHandle` in a dedicated worker (asked from the main thread).
 */
import { type AsyncFactDefinition, type AsyncFactId, defineAsyncFact } from './async-facts.js';
import { type PlatformEnv, readGlobal } from './env.js';

// ---------------------------------------------------------------- WebGPU adapter

export type GpuAdapterStatus =
  /** An adapter was granted. */
  | 'available'
  /** No `navigator.gpu` (or no `requestAdapter`). */
  | 'no-api'
  /** `requestAdapter()` resolved `null` (blocklisted GPU, VM, disabled hardware acceleration) or rejected. */
  | 'no-adapter';

export interface GpuAdapterInfoFacts {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

export interface GpuAdapterFacts {
  readonly status: GpuAdapterStatus;
  readonly info: GpuAdapterInfoFacts;
  /** Software adapter (e.g. SwiftShader): works, but far slower than a GPU. */
  readonly isFallbackAdapter: boolean;
  /** `adapter.features`, sorted. */
  readonly features: readonly string[];
  /** Numeric `adapter.limits` (e.g. `maxTextureDimension2D`). */
  readonly limits: Readonly<Record<string, number>>;
}

interface GpuAdapterInfoLike {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
  readonly isFallbackAdapter?: boolean;
}

interface GpuAdapterLike {
  readonly info?: GpuAdapterInfoLike;
  /** Chrome < 127. */
  requestAdapterInfo?(): Promise<GpuAdapterInfoLike>;
  readonly isFallbackAdapter?: boolean;
  readonly features?: Iterable<string>;
  readonly limits?: object;
}

interface GpuLike {
  requestAdapter?(options?: { readonly powerPreference?: 'high-performance' | 'low-power' }): Promise<GpuAdapterLike | null>;
}

const NO_INFO: GpuAdapterInfoFacts = Object.freeze({ vendor: '', architecture: '', device: '', description: '' });

/** Facts for "no adapter" outcomes. */
export function absentGpuAdapter(status: Exclude<GpuAdapterStatus, 'available'>): GpuAdapterFacts {
  return { status, info: NO_INFO, isFallbackAdapter: false, features: [], limits: {} };
}

/** Plain-data copy of an adapter (limits are prototype getters on real adapters). */
export async function describeGpuAdapter(adapter: GpuAdapterLike): Promise<GpuAdapterFacts> {
  let info: GpuAdapterInfoLike = adapter.info ?? {};
  if (adapter.info === undefined && typeof adapter.requestAdapterInfo === 'function') {
    try {
      info = await adapter.requestAdapterInfo();
    } catch {
      info = {};
    }
  }
  const limits: Record<string, number> = {};
  const rawLimits = (adapter.limits ?? {}) as Record<string, unknown>;
  // Limits are accessors on the prototype chain (enumerable for WebIDL, not for JS classes): walk it.
  for (let proto: object | null = rawLimits; proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || key in limits) continue;
      const value = rawLimits[key];
      if (typeof value === 'number') limits[key] = value;
    }
  }
  return {
    status: 'available',
    info: {
      vendor: info.vendor ?? '',
      architecture: info.architecture ?? '',
      device: info.device ?? '',
      description: info.description ?? '',
    },
    isFallbackAdapter: info.isFallbackAdapter === true || adapter.isFallbackAdapter === true,
    features: [...(adapter.features ?? [])].sort(),
    limits,
  };
}

export const webGpuAdapterFact = /* @__PURE__ */ defineAsyncFact({
  id: 'platform/webgpu-adapter',
  timeoutMs: 5000,
  description: 'WebGPU adapter (status, info, features, limits) from navigator.gpu.requestAdapter().',
  probe: async (env: PlatformEnv): Promise<GpuAdapterFacts> => {
    const gpu = env.navigator?.gpu as GpuLike | undefined | null;
    if (gpu === undefined || gpu === null || typeof gpu.requestAdapter !== 'function') return absentGpuAdapter('no-api');
    let adapter: GpuAdapterLike | null;
    try {
      adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    } catch {
      return absentGpuAdapter('no-adapter');
    }
    return adapter === null || adapter === undefined ? absentGpuAdapter('no-adapter') : describeGpuAdapter(adapter);
  },
});

// ---------------------------------------------------------------- WebCodecs codec matrix

export type CodecRole = 'video-decoder' | 'video-encoder' | 'audio-decoder' | 'audio-encoder';

export interface CodecQuery<Id extends string = string> {
  readonly id: Id;
  readonly role: CodecRole;
  /** Passed to `<Role>.isConfigSupported(config)` as is. */
  readonly config: Readonly<Record<string, unknown>>;
}

export type CodecSupport<Q extends readonly CodecQuery[]> = { readonly [K in Q[number]['id']]: boolean };

export const CODEC_ROLE_GLOBALS: { readonly [K in CodecRole]: string } = {
  'video-decoder': 'VideoDecoder',
  'video-encoder': 'VideoEncoder',
  'audio-decoder': 'AudioDecoder',
  'audio-encoder': 'AudioEncoder',
};

/** A small default matrix: H.264, VP9, AV1 video; AAC and Opus audio (1080p30, 48 kHz stereo). */
export const DEFAULT_CODEC_QUERIES = [
  { id: 'h264-decode', role: 'video-decoder', config: { codec: 'avc1.640028' } },
  { id: 'h264-encode', role: 'video-encoder', config: { codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 } },
  { id: 'vp9-decode', role: 'video-decoder', config: { codec: 'vp09.00.40.08' } },
  { id: 'vp9-encode', role: 'video-encoder', config: { codec: 'vp09.00.40.08', width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 } },
  { id: 'av1-decode', role: 'video-decoder', config: { codec: 'av01.0.08M.08' } },
  { id: 'aac-decode', role: 'audio-decoder', config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 } },
  { id: 'aac-encode', role: 'audio-encoder', config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 } },
  { id: 'opus-decode', role: 'audio-decoder', config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 } },
  { id: 'opus-encode', role: 'audio-encoder', config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 } },
] as const satisfies readonly CodecQuery[];

type ConfigSupportApi = { isConfigSupported?: (config: unknown) => Promise<{ readonly supported?: boolean }> };

/** One `isConfigSupported` call; `false` when the class is missing or the call rejects. */
export async function probeCodec(env: PlatformEnv, query: CodecQuery): Promise<boolean> {
  const api = readGlobal(env, CODEC_ROLE_GLOBALS[query.role]) as ConfigSupportApi | undefined;
  if (typeof api?.isConfigSupported !== 'function') return false;
  try {
    const support = await api.isConfigSupported(query.config);
    return support?.supported === true;
  } catch {
    return false;
  }
}

/** A codec matrix fact over your own queries (ids become the typed keys of the value). */
export function defineCodecSupportFact<const Q extends readonly CodecQuery[]>(
  queries: Q,
  id: AsyncFactId = 'platform/codec-support',
): AsyncFactDefinition<CodecSupport<Q>> {
  return defineAsyncFact<CodecSupport<Q>>({
    id,
    timeoutMs: 5000,
    description: `WebCodecs isConfigSupported matrix (${queries.length} configs).`,
    probe: async (env) => {
      const results = await Promise.all(queries.map(async (query) => [query.id, await probeCodec(env, query)] as const));
      return Object.fromEntries(results) as CodecSupport<Q>;
    },
  });
}

export const codecSupportFact = /* @__PURE__ */ defineCodecSupportFact(DEFAULT_CODEC_QUERIES);

// ---------------------------------------------------------------- OPFS sync access handles

/** Runs in a throwaway dedicated worker: posts whether sync access handles exist there. */
export const OPFS_SYNC_PROBE_SOURCE =
  "postMessage(typeof FileSystemFileHandle==='function'&&typeof FileSystemFileHandle.prototype.createSyncAccessHandle==='function')";

interface WorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/**
 * Worker probe: in a worker scope, read the prototype directly; on the main thread, ask a blob
 * worker (sync handles are exposed in dedicated workers only). `false` when OPFS, workers or
 * blob URLs are missing, the worker errors, or the signal aborts.
 */
export async function probeOpfsSyncAccess(env: PlatformEnv, signal: AbortSignal): Promise<boolean> {
  const fileHandle = readGlobal(env, 'FileSystemFileHandle') as { prototype?: { createSyncAccessHandle?: unknown } } | undefined;
  if (typeof fileHandle?.prototype?.createSyncAccessHandle === 'function') return true;
  const storage = env.navigator?.storage as { getDirectory?: unknown } | undefined;
  if (typeof storage?.getDirectory !== 'function') return false;
  const WorkerCtor = readGlobal(env, 'Worker') as (new (url: string) => WorkerLike) | undefined;
  const BlobCtor = readGlobal(env, 'Blob') as (new (parts: readonly string[], options: { type: string }) => unknown) | undefined;
  const url = readGlobal(env, 'URL') as { createObjectURL?: (blob: unknown) => string; revokeObjectURL?: (url: string) => void } | undefined;
  if (typeof WorkerCtor !== 'function' || typeof BlobCtor !== 'function' || typeof url?.createObjectURL !== 'function') return false;
  if (signal.aborted) return false;
  const href = url.createObjectURL(new BlobCtor([OPFS_SYNC_PROBE_SOURCE], { type: 'text/javascript' }));
  let worker: WorkerLike | undefined;
  const stop = new AbortController();
  try {
    worker = new WorkerCtor(href);
    const spawned = worker;
    return await new Promise<boolean>((resolve) => {
      spawned.onmessage = (event) => resolve(event.data === true);
      spawned.onerror = () => resolve(false);
      signal.addEventListener('abort', () => resolve(false), { once: true, signal: stop.signal });
    });
  } catch {
    return false;
  } finally {
    stop.abort();
    worker?.terminate();
    url.revokeObjectURL?.(href);
  }
}

export const opfsSyncAccessFact = /* @__PURE__ */ defineAsyncFact({
  id: 'platform/opfs-sync-access',
  timeoutMs: 3000,
  description: 'OPFS createSyncAccessHandle available in dedicated workers.',
  probe: (env: PlatformEnv, signal: AbortSignal): Promise<boolean> => probeOpfsSyncAccess(env, signal),
});
