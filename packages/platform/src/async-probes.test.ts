import { createScope } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  absentGpuAdapter,
  codecSupportFact,
  createAsyncFactLane,
  createFakePlatformEnv,
  DEFAULT_CODEC_QUERIES,
  defineCodecSupportFact,
  describeGpuAdapter,
  OPFS_SYNC_PROBE_SOURCE,
  opfsSyncAccessFact,
  probeCodec,
  probeOpfsSyncAccess,
  webGpuAdapterFact,
} from './index.js';

const never = new AbortController().signal;

/** Real adapters expose limits as prototype getters (not own properties). */
class FakeLimits {
  get maxTextureDimension2D(): number {
    return 8192;
  }
  get maxBufferSize(): number {
    return 268_435_456;
  }
  get label(): string {
    return 'not a number';
  }
}

function fakeAdapter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: { vendor: 'google', architecture: 'swiftshader', device: '', description: 'SwiftShader Device', isFallbackAdapter: true },
    features: new Set(['timestamp-query', 'float32-filterable']),
    limits: new FakeLimits(),
    ...overrides,
  };
}

describe('webGpuAdapterFact', () => {
  const probe = (gpu: unknown): ReturnType<typeof webGpuAdapterFact.probe> =>
    webGpuAdapterFact.probe(createFakePlatformEnv({ navigator: { gpu } }), never);

  it('present: adapter info, sorted features and numeric limits', async () => {
    const requestAdapter = vi.fn(async () => fakeAdapter());
    expect(await probe({ requestAdapter })).toEqual({
      status: 'available',
      info: { vendor: 'google', architecture: 'swiftshader', device: '', description: 'SwiftShader Device' },
      isFallbackAdapter: true,
      features: ['float32-filterable', 'timestamp-query'],
      limits: { maxTextureDimension2D: 8192, maxBufferSize: 268_435_456 },
    });
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
  });

  it('absent: no navigator.gpu or no requestAdapter → no-api', async () => {
    expect((await webGpuAdapterFact.probe(createFakePlatformEnv(), never)).status).toBe('no-api');
    expect((await probe({})).status).toBe('no-api');
    expect((await probe(null)).status).toBe('no-api');
  });

  it('null adapter (blocklisted GPU, VM) → no-adapter', async () => {
    expect(await probe({ requestAdapter: async () => null })).toEqual(absentGpuAdapter('no-adapter'));
  });

  it('throwing requestAdapter → no-adapter, never a throw', async () => {
    expect((await probe({ requestAdapter: () => Promise.reject(new Error('GPU process crashed')) })).status).toBe('no-adapter');
  });

  it('older Chrome: requestAdapterInfo(); a throwing one gives empty info', async () => {
    const old = await describeGpuAdapter({ requestAdapterInfo: async () => ({ vendor: 'intel' }), isFallbackAdapter: false });
    expect(old).toMatchObject({ status: 'available', info: { vendor: 'intel', architecture: '' }, isFallbackAdapter: false, features: [], limits: {} });
    const broken = await describeGpuAdapter({ requestAdapterInfo: () => Promise.reject(new Error('nope')), isFallbackAdapter: true });
    expect(broken.info).toEqual({ vendor: '', architecture: '', device: '', description: '' });
    expect(broken.isFallbackAdapter).toBe(true);
  });

  it('settles through the lane', async () => {
    const env = createFakePlatformEnv({ navigator: { gpu: { requestAdapter: async () => fakeAdapter() } } });
    const lane = createAsyncFactLane({ env, scope: createScope('test') });
    const result = await lane.probe(webGpuAdapterFact);
    expect(result.ok && result.value.status).toBe('available');
  });
});

describe('codec support', () => {
  const h264 = DEFAULT_CODEC_QUERIES[0];

  it('present: isConfigSupported answers', async () => {
    const isConfigSupported = vi.fn(async (config: { codec: string }) => ({ supported: config.codec.startsWith('avc1') }));
    const env = createFakePlatformEnv({ globals: { VideoDecoder: { isConfigSupported } } });
    expect(await probeCodec(env, h264)).toBe(true);
    expect(await probeCodec(env, { id: 'vp9', role: 'video-decoder', config: { codec: 'vp09.00.40.08' } })).toBe(false);
    expect(isConfigSupported).toHaveBeenCalledWith(h264.config);
  });

  it('absent: no class or no isConfigSupported → false', async () => {
    expect(await probeCodec(createFakePlatformEnv(), h264)).toBe(false);
    expect(await probeCodec(createFakePlatformEnv({ globals: { VideoDecoder: function VideoDecoder() {} } }), h264)).toBe(false);
  });

  it('throwing isConfigSupported → false', async () => {
    const env = createFakePlatformEnv({ globals: { VideoDecoder: { isConfigSupported: () => Promise.reject(new TypeError('bad config')) } } });
    expect(await probeCodec(env, h264)).toBe(false);
  });

  it('the default matrix has typed keys for every query', async () => {
    const supported = { isConfigSupported: async () => ({ supported: true }) };
    const env = createFakePlatformEnv({ globals: { VideoDecoder: supported, AudioDecoder: supported } });
    const matrix = await codecSupportFact.probe(env, never);
    expect(Object.keys(matrix)).toEqual(DEFAULT_CODEC_QUERIES.map((q) => q.id));
    expect(matrix['h264-decode']).toBe(true);
    expect(matrix['h264-encode']).toBe(false);
    expect(matrix['opus-decode']).toBe(true);
    expect(codecSupportFact.id).toBe('platform/codec-support');
  });

  it('custom matrices get their own id', async () => {
    const fact = defineCodecSupportFact([{ id: 'hevc', role: 'video-decoder', config: { codec: 'hvc1.1.6.L93.B0' } }], 'app/hevc');
    expect(fact.id).toBe('app/hevc');
    expect(await fact.probe(createFakePlatformEnv(), never)).toEqual({ hevc: false });
  });
});

describe('OPFS sync access handles', () => {
  type Listener = ((event: { data: unknown }) => void) | null;
  /** Fake Worker that answers like the probe source would. */
  function workerEnv(answer: 'true' | 'false' | 'error' | 'silent' | 'throw'): {
    env: ReturnType<typeof createFakePlatformEnv>;
    terminated: () => number;
    revoked: string[];
    sources: unknown[];
  } {
    let terminated = 0;
    const revoked: string[] = [];
    const sources: unknown[] = [];
    class FakeWorker {
      onmessage: Listener = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor(readonly url: string) {
        if (answer === 'throw') throw new Error('SecurityError');
        queueMicrotask(() => {
          if (answer === 'true' || answer === 'false') this.onmessage?.({ data: answer === 'true' });
          if (answer === 'error') this.onerror?.({});
        });
      }
      terminate(): void {
        terminated += 1;
      }
    }
    class FakeBlob {
      constructor(parts: unknown[]) {
        sources.push(...parts);
      }
    }
    const env = createFakePlatformEnv({
      navigator: { storage: { getDirectory: () => Promise.resolve({}) } },
      globals: {
        Worker: FakeWorker,
        Blob: FakeBlob,
        URL: { createObjectURL: () => 'blob:probe', revokeObjectURL: (url: string) => revoked.push(url) },
      },
    });
    return { env, terminated: () => terminated, revoked, sources };
  }

  it('worker scope: reads the prototype directly', async () => {
    const env = createFakePlatformEnv({ globals: { FileSystemFileHandle: { prototype: { createSyncAccessHandle() {} } } } });
    expect(await probeOpfsSyncAccess(env, never)).toBe(true);
  });

  it('main thread: asks a blob worker and cleans up', async () => {
    const probe = workerEnv('true');
    expect(await probeOpfsSyncAccess(probe.env, never)).toBe(true);
    expect(probe.sources).toEqual([OPFS_SYNC_PROBE_SOURCE]);
    expect(probe.terminated()).toBe(1);
    expect(probe.revoked).toEqual(['blob:probe']);
    expect(await probeOpfsSyncAccess(workerEnv('false').env, never)).toBe(false);
  });

  it('absent: no OPFS, no Worker or no blob URLs → false without spawning', async () => {
    expect(await probeOpfsSyncAccess(createFakePlatformEnv(), never)).toBe(false);
    expect(await probeOpfsSyncAccess(createFakePlatformEnv({ navigator: { storage: { getDirectory() {} } } }), never)).toBe(false);
  });

  it('throwing: worker error or constructor throw → false', async () => {
    const errored = workerEnv('error');
    expect(await probeOpfsSyncAccess(errored.env, never)).toBe(false);
    expect(errored.terminated()).toBe(1);
    const thrown = workerEnv('throw');
    expect(await probeOpfsSyncAccess(thrown.env, never)).toBe(false);
    expect(thrown.revoked).toEqual(['blob:probe']);
  });

  it('abort → false (and an already aborted signal spawns nothing)', async () => {
    const silent = workerEnv('silent');
    const controller = new AbortController();
    const pending = probeOpfsSyncAccess(silent.env, controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    expect(silent.terminated()).toBe(1);
    const pre = workerEnv('true');
    expect(await probeOpfsSyncAccess(pre.env, AbortSignal.abort())).toBe(false);
    expect(pre.sources).toEqual([]);
  });

  it('a silent worker times out through the lane', async () => {
    const lane = createAsyncFactLane({ env: workerEnv('silent').env, scope: createScope('test') });
    const fast = { ...opfsSyncAccessFact, timeoutMs: 5 };
    const result = await lane.probe(fast);
    expect(result.ok).toBe(false);
    expect(lane.read(fast).state).toBe('failed');
  });
});
