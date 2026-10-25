import { createScope } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  browserEnv,
  createFakePlatformEnv,
  createPlatformFacts,
  type FakePlatformEnvOptions,
  type PlatformEnv,
  readPlatformFacts,
  readWebApis,
  WEB_API_NAMES,
  WEB_API_PROBES,
  type WebApiName,
} from './index.js';

const fn = (): void => {};
/** A constructor-like stub with the given prototype methods. */
function ctor(...methods: readonly string[]): { prototype: Record<string, unknown> } {
  const C = function Stub(): void {} as unknown as { prototype: Record<string, unknown> };
  for (const method of methods) C.prototype[method] = fn;
  return C;
}
class AnyCompression {
  constructor(readonly format: string) {}
}
class NoRawCompression {
  constructor(format: string) {
    if (format === 'deflate-raw') throw new TypeError(`Unsupported compression format: '${format}'`);
  }
}
const throwing = (): never => {
  throw new Error('boom');
};

/** Per fact: the stub that makes it present. */
const PRESENT: { readonly [K in WebApiName]: FakePlatformEnvOptions } = {
  webGpu: { navigator: { gpu: {} } },
  offscreenCanvasTransfer: { globals: { HTMLCanvasElement: ctor('transferControlToOffscreen') } },
  webCodecs: { globals: { VideoDecoder: fn, VideoEncoder: fn, AudioDecoder: fn, AudioEncoder: fn } },
  opfs: { navigator: { storage: { getDirectory: fn } } },
  opfsSyncAccessHandle: { globals: { FileSystemFileHandle: ctor('createSyncAccessHandle') } },
  directoryPicker: { globals: { showDirectoryPicker: fn } },
  fileHandleMove: { globals: { FileSystemFileHandle: ctor('move') } },
  editContext: { globals: { EditContext: fn } },
  localFontAccess: { globals: { queryLocalFonts: fn } },
  compressionStreams: { globals: { CompressionStream: AnyCompression, DecompressionStream: AnyCompression } },
  compressionDeflateRaw: { globals: { CompressionStream: AnyCompression } },
  crossOriginIsolated: { globals: { crossOriginIsolated: true } },
  sharedArrayBuffer: { globals: { SharedArrayBuffer: fn, Atomics: {} } },
  wasmSimd: { globals: { WebAssembly: { validate: () => true } } },
  audioWorklet: { globals: { AudioWorkletNode: fn } },
  webLocks: { navigator: { locks: { request: fn } } },
  broadcastChannel: { globals: { BroadcastChannel: fn } },
};

/** Per fact: a stub where the API (or its getter) throws. */
const THROWING: { readonly [K in WebApiName]: PlatformEnv } = {
  webGpu: envWithNavigatorGetter('gpu'),
  offscreenCanvasTransfer: envWithThrowingGlobal('HTMLCanvasElement'),
  webCodecs: envWithThrowingGlobal('VideoDecoder'),
  opfs: envWithNavigatorGetter('storage'),
  opfsSyncAccessHandle: createFakePlatformEnv({ globals: { FileSystemFileHandle: { get prototype(): never { return throwing(); } } } }),
  directoryPicker: envWithThrowingGlobal('showDirectoryPicker'),
  fileHandleMove: envWithThrowingGlobal('FileSystemFileHandle'),
  editContext: envWithThrowingGlobal('EditContext'),
  localFontAccess: envWithThrowingGlobal('queryLocalFonts'),
  compressionStreams: envWithThrowingGlobal('CompressionStream'),
  compressionDeflateRaw: createFakePlatformEnv({ globals: { CompressionStream: NoRawCompression } }),
  crossOriginIsolated: envWithThrowingGlobal('crossOriginIsolated'),
  sharedArrayBuffer: envWithThrowingGlobal('SharedArrayBuffer'),
  wasmSimd: createFakePlatformEnv({ globals: { WebAssembly: { validate: throwing } } }),
  audioWorklet: envWithThrowingGlobal('AudioWorkletNode'),
  webLocks: envWithNavigatorGetter('locks'),
  broadcastChannel: envWithThrowingGlobal('BroadcastChannel'),
};

function envWithThrowingGlobal(name: string): PlatformEnv {
  const globals = {};
  Object.defineProperty(globals, name, { get: throwing, enumerable: true });
  return { window: undefined, navigator: undefined, matchMedia: undefined, globals };
}

function envWithNavigatorGetter(name: string): PlatformEnv {
  const navigator = {};
  Object.defineProperty(navigator, name, { get: throwing, enumerable: true });
  return { window: undefined, navigator, matchMedia: undefined, globals: {} };
}

describe('web API facts (SF-Δ26)', () => {
  it('has one probe per fact', () => {
    expect([...WEB_API_NAMES].sort()).toEqual(Object.keys(PRESENT).sort());
    for (const name of WEB_API_NAMES) expect(typeof WEB_API_PROBES[name]).toBe('function');
  });

  it.each(WEB_API_NAMES)('%s: present', (name) => {
    expect(readWebApis(createFakePlatformEnv(PRESENT[name]))[name]).toBe(true);
  });

  it.each(WEB_API_NAMES)('%s: absent', (name) => {
    expect(readWebApis(createFakePlatformEnv())[name]).toBe(false);
  });

  it.each(WEB_API_NAMES)('%s: throwing API or getter reads as absent, never throws', (name) => {
    expect(() => readWebApis(THROWING[name])).not.toThrow();
    expect(readWebApis(THROWING[name])[name]).toBe(false);
  });

  it('partial or wrong-shaped APIs are absent', () => {
    const apis = readWebApis(
      createFakePlatformEnv({
        // Only three of four WebCodecs classes; Compression without Decompression.
        globals: {
          VideoDecoder: fn,
          VideoEncoder: fn,
          AudioDecoder: fn,
          CompressionStream: AnyCompression,
          // S6: `move()` lives on FileSystemFileHandle, not FileSystemHandle.
          FileSystemHandle: ctor('move'),
          FileSystemFileHandle: ctor(),
          crossOriginIsolated: 'yes',
          SharedArrayBuffer: fn,
          WebAssembly: { validate: () => false },
          showDirectoryPicker: {},
        },
        navigator: { storage: {}, locks: {}, gpu: null },
      }),
    );
    expect(apis).toMatchObject({
      webCodecs: false,
      compressionStreams: false,
      compressionDeflateRaw: true,
      fileHandleMove: false,
      crossOriginIsolated: false,
      sharedArrayBuffer: false,
      wasmSimd: false,
      directoryPicker: false,
      opfs: false,
      webLocks: false,
      webGpu: false,
    });
  });

  it('reads the real happy-dom globals without throwing', () => {
    const apis = readWebApis(browserEnv());
    for (const name of WEB_API_NAMES) expect(typeof apis[name]).toBe('boolean');
    // happy-dom has no WebGPU, EditContext or Local Font Access.
    expect(apis).toMatchObject({ webGpu: false, editContext: false, localFontAccess: false, directoryPicker: false });
  });

  it('is part of readPlatformFacts', () => {
    expect(readPlatformFacts(createFakePlatformEnv(PRESENT.editContext)).apis.editContext).toBe(true);
  });

  it('is a reactive group of the facts source, re-read on refresh()', () => {
    const env = createFakePlatformEnv();
    const facts = createPlatformFacts({ env, scope: createScope('test') });
    const changes: string[] = [];
    facts.onChange((group) => changes.push(group));
    expect(facts.apis.editContext).toBe(false);
    env.setGlobal('EditContext', fn);
    facts.refresh();
    expect(facts.apis.editContext).toBe(true);
    expect(facts.snapshot().apis.editContext).toBe(true);
    expect(facts.current.apis).toBe(facts.apis);
    expect(changes).toEqual(['apis']);
  });
});
