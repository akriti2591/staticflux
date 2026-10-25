/**
 * Web platform API facts (SF-Δ26, R18.13): synchronous presence probes for the APIs a
 * heavy client app (an editor on WebGPU, WebCodecs and OPFS) needs at boot.
 *
 * Every probe reads through `PlatformEnv` and never throws: a missing global, a getter
 * that throws, or a constructor that rejects an argument all mean "absent". Nothing
 * runs at import time. Probes that need a round trip (a GPU adapter, codec configs,
 * OPFS sync handles from the main thread) live in the async fact lane (`async-probes.ts`).
 *
 * This file must stay free of runtime imports except `env.ts`: the baseline check
 * (`@staticflux/platform/baseline`) runs it inline, before boot.
 */
import { type PlatformEnv, readGlobal } from './env.js';

export interface WebApiFacts {
  /** `navigator.gpu` exists (an adapter is the async `webGpuAdapterFact`). */
  readonly webGpu: boolean;
  /** `HTMLCanvasElement.prototype.transferControlToOffscreen` (canvas → worker). */
  readonly offscreenCanvasTransfer: boolean;
  /** `VideoDecoder`, `VideoEncoder`, `AudioDecoder` and `AudioEncoder` (codec support is the async `codecSupportFact`). */
  readonly webCodecs: boolean;
  /** Origin private file system: `navigator.storage.getDirectory()`. */
  readonly opfs: boolean;
  /**
   * `createSyncAccessHandle` on `FileSystemFileHandle`. Exposed in dedicated workers only, so this
   * is `false` on the main thread even where workers have it; use the async `opfsSyncAccessFact` there.
   */
  readonly opfsSyncAccessHandle: boolean;
  /** File System Access folders: `showDirectoryPicker()`. */
  readonly directoryPicker: boolean;
  /** `FileSystemFileHandle.prototype.move` (rename / move in place; on the file handle, not `FileSystemHandle`). */
  readonly fileHandleMove: boolean;
  /** `EditContext` (text input without a contenteditable). */
  readonly editContext: boolean;
  /** Local Font Access: `queryLocalFonts()`. */
  readonly localFontAccess: boolean;
  /** `CompressionStream` and `DecompressionStream` (gzip, deflate). */
  readonly compressionStreams: boolean;
  /** `new CompressionStream('deflate-raw')` is accepted (zip entries). */
  readonly compressionDeflateRaw: boolean;
  /** `crossOriginIsolated === true`. */
  readonly crossOriginIsolated: boolean;
  /** `SharedArrayBuffer` and `Atomics` exposed. */
  readonly sharedArrayBuffer: boolean;
  /** Wasm fixed-width SIMD (`WebAssembly.validate` of a v128 module). */
  readonly wasmSimd: boolean;
  /** `AudioWorkletNode`. */
  readonly audioWorklet: boolean;
  /** Web Locks: `navigator.locks.request`. */
  readonly webLocks: boolean;
  /** `BroadcastChannel`. */
  readonly broadcastChannel: boolean;
}

export type WebApiName = keyof WebApiFacts;

type Probe = (env: PlatformEnv) => boolean;

const isFunction = (value: unknown): boolean => typeof value === 'function';
const globalFunction = (name: string): Probe => (env) => isFunction(readGlobal(env, name));

function prototypeHas(env: PlatformEnv, constructorName: string, member: string): boolean {
  const ctor = readGlobal(env, constructorName) as { prototype?: Record<string, unknown> } | undefined;
  const proto = ctor?.prototype;
  return typeof proto === 'object' && proto !== null && isFunction(proto[member]);
}

/** Smallest module using a v128 instruction (same bytes as wasm-feature-detect `simd`). */
const SIMD_MODULE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];

/** One probe per fact; each may throw (the reader guards it). */
export const WEB_API_PROBES: { readonly [K in WebApiName]: Probe } = {
  webGpu: (env) => {
    const gpu = env.navigator?.gpu;
    return gpu !== undefined && gpu !== null;
  },
  offscreenCanvasTransfer: (env) => prototypeHas(env, 'HTMLCanvasElement', 'transferControlToOffscreen'),
  webCodecs: (env) => ['VideoDecoder', 'VideoEncoder', 'AudioDecoder', 'AudioEncoder'].every((name) => isFunction(readGlobal(env, name))),
  opfs: (env) => isFunction((env.navigator?.storage as { getDirectory?: unknown } | undefined)?.getDirectory),
  opfsSyncAccessHandle: (env) => prototypeHas(env, 'FileSystemFileHandle', 'createSyncAccessHandle'),
  directoryPicker: globalFunction('showDirectoryPicker'),
  fileHandleMove: (env) => prototypeHas(env, 'FileSystemFileHandle', 'move'),
  editContext: globalFunction('EditContext'),
  localFontAccess: globalFunction('queryLocalFonts'),
  compressionStreams: (env) => isFunction(readGlobal(env, 'CompressionStream')) && isFunction(readGlobal(env, 'DecompressionStream')),
  compressionDeflateRaw: (env) => {
    const Ctor = readGlobal(env, 'CompressionStream') as (new (format: string) => unknown) | undefined;
    if (!isFunction(Ctor) || Ctor === undefined) return false;
    // Unsupported formats throw a TypeError from the constructor.
    new Ctor('deflate-raw');
    return true;
  },
  crossOriginIsolated: (env) => readGlobal(env, 'crossOriginIsolated') === true,
  sharedArrayBuffer: (env) => {
    const atomics = readGlobal(env, 'Atomics');
    return isFunction(readGlobal(env, 'SharedArrayBuffer')) && typeof atomics === 'object' && atomics !== null;
  },
  wasmSimd: (env) => {
    const wasm = readGlobal(env, 'WebAssembly') as { validate?: (bytes: Uint8Array) => boolean } | undefined;
    return typeof wasm?.validate === 'function' && wasm.validate(new Uint8Array(SIMD_MODULE)) === true;
  },
  audioWorklet: globalFunction('AudioWorkletNode'),
  webLocks: (env) => isFunction((env.navigator?.locks as { request?: unknown } | undefined)?.request),
  broadcastChannel: globalFunction('BroadcastChannel'),
};

export const WEB_API_NAMES = Object.keys(WEB_API_PROBES) as readonly WebApiName[];

/** Read every web API fact once. A probe that throws reports `false`. */
export function readWebApis(env: PlatformEnv): WebApiFacts {
  const out = {} as Record<WebApiName, boolean>;
  for (const name of WEB_API_NAMES) {
    try {
      out[name] = WEB_API_PROBES[name](env) === true;
    } catch {
      out[name] = false;
    }
  }
  return out;
}
