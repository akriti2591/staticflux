/**
 * Worked example: the Instaflow baseline (docs/instaflow/REQUIREMENTS.md IF-2.2–2.4, IF-2.8).
 *
 * Instaflow does not exist yet (`apps/instaflow/src`); this file is the type-checked version of
 * what `apps/instaflow/src/app/baseline.ts` and `main.ts` will contain. When the app lands, move
 * `instaflowBaseline` there; the `IF-PLAT-*` codes belong to the app's catalog, not to StaticFlux.
 *
 * Boot flow (`main.ts`):
 *
 * ```ts
 * const env = browserEnv();
 * // IF-2.8: isolation `required` with COEP `credentialless`; on static hosts the pwa COOP/COEP SW reloads once.
 * const reload = await coordinateIsolationReload({ env: pwaEnv, register, store });
 * if (reload.ok && reload.value === 'reloading') return;
 * const lane = createAsyncFactLane({ env, scope: appScope, facts: [webGpuAdapterFact, opfsSyncAccessFact, codecSupportFact] });
 * const verdict = await checkBaseline(instaflowBaseline, { env, lane }); // sync misses probe nothing
 * const initial = detectMode(env, { detectors: [unsupportedHostMode(verdict), ...BUILT_IN_DETECTORS] });
 * await bootApp({
 *   units: [
 *     ...platformUnits({ initial }), ...unsupportedUnits(verdict), asyncFactLaneUnit({ lane }),
 *     ...isolationUnits({ mode: 'required', coep: 'credentialless' }),
 *     bootPlanUnit(defineBootPlan(unsupportedBootPlan({ chunk: 'feature:unsupported' }))), ...appBootPlans,
 *   ],
 * });
 * // feature:unsupported → mountUnsupportedScreen(document.body, unsupportedScreenModel(verdict, copy), document)
 * ```
 *
 * The codec matrix is not required: it stays in the lane, probed on idle after boot.
 */
import { createScope } from '@staticflux/core';
import { defineBootPlan, selectBootPlan } from '@staticflux/loader';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_DETECTORS,
  checkBaseline,
  createAsyncFactLane,
  createFakePlatformEnv,
  defineBaseline,
  detectMode,
  type FakePlatformEnvOptions,
  type GpuAdapterFacts,
  mountUnsupportedScreen,
  opfsSyncAccessFact,
  requireApi,
  requireFact,
  SAMPLE_USER_AGENTS,
  unsupportedBootPlan,
  unsupportedHostMode,
  unsupportedScreenModel,
  webGpuAdapterFact,
} from './index.js';

const USE_CHROME = 'Open Instaflow in Chrome on desktop (current version or one of the two before it).';

/** IF-2.2 required baseline; codes per IF-2.4. */
const instaflowBaseline = defineBaseline({
  id: 'instaflow',
  code: 'IF-PLAT-001',
  fix: USE_CHROME,
  requirements: [
    requireApi('webGpu', { label: 'WebGPU' }),
    requireFact(webGpuAdapterFact, (gpu: GpuAdapterFacts) => gpu.status === 'available', {
      label: 'A WebGPU graphics adapter',
      code: 'IF-PLAT-002',
      fix: 'Chrome found no usable GPU (blocklisted GPU, virtual machine or hardware acceleration off). Turn on "Use graphics acceleration" in chrome://settings/system, update the GPU driver, or use another computer.',
    }),
    requireApi('offscreenCanvasTransfer', { label: 'OffscreenCanvas transfer to workers' }),
    requireApi('webCodecs', { label: 'WebCodecs (video and audio encoders and decoders)' }),
    requireApi('opfs', { label: 'Origin private file system' }),
    requireFact(opfsSyncAccessFact, (available: boolean) => available, { label: 'OPFS sync access handles in workers' }),
    requireApi('wasmSimd', { label: 'WebAssembly SIMD' }),
    requireApi('crossOriginIsolated', {
      label: 'Cross-origin isolation',
      code: 'IF-PLAT-003',
      fix: 'Reload the page once. If this stays, the host must send COOP "same-origin" and COEP "credentialless" (or keep the StaticFlux COOP/COEP service worker enabled).',
    }),
    requireApi('sharedArrayBuffer', { label: 'SharedArrayBuffer' }),
    requireApi('audioWorklet', { label: 'AudioWorklet' }),
    requireApi('compressionStreams', { label: 'Compression Streams' }),
    requireApi('compressionDeflateRaw', { label: 'Compression Streams "deflate-raw"' }),
    requireApi('webLocks', { label: 'Web Locks' }),
    requireApi('broadcastChannel', { label: 'BroadcastChannel' }),
  ],
});

const fn = (): void => {};
class Compression {
  constructor(readonly format: string) {}
}
/** Desktop Chrome with every IF-2.2 API; `gpu` decides the adapter. */
function chrome(gpu: unknown, overrides: Record<string, unknown> = {}): FakePlatformEnvOptions {
  return {
    width: 1440,
    navigator: { userAgent: SAMPLE_USER_AGENTS.linuxChrome, gpu, storage: { getDirectory: fn }, locks: { request: fn } },
    globals: {
      HTMLCanvasElement: { prototype: { transferControlToOffscreen: fn } },
      VideoDecoder: fn,
      VideoEncoder: fn,
      AudioDecoder: fn,
      AudioEncoder: fn,
      // Worker scope shape keeps the example free of a worker fake (see async-probes.test.ts for the blob worker).
      FileSystemFileHandle: { prototype: { createSyncAccessHandle: fn, move: fn } },
      WebAssembly: { validate: () => true },
      crossOriginIsolated: true,
      SharedArrayBuffer: fn,
      Atomics: {},
      AudioWorkletNode: fn,
      CompressionStream: Compression,
      DecompressionStream: Compression,
      BroadcastChannel: fn,
      ...overrides,
    },
  };
}
const gpuWith = (adapter: unknown): unknown => ({ requestAdapter: async () => adapter });
const realAdapter = { info: { vendor: 'apple', architecture: 'metal-3' }, features: new Set(['shader-f16']), limits: { maxTextureDimension2D: 16384 } };

async function bootFor(options: FakePlatformEnvOptions): Promise<{ plan: string; codes: readonly string[]; screen: string | undefined }> {
  const env = createFakePlatformEnv(options);
  const lane = createAsyncFactLane({ env, scope: createScope('instaflow-example') });
  const verdict = await checkBaseline(instaflowBaseline, { env, lane });
  const detected = detectMode(env, { detectors: [unsupportedHostMode(verdict), ...BUILT_IN_DETECTORS] });
  const plans = [
    defineBootPlan({ id: 'editor', match: { hostModes: ['web', 'pwa'] }, critical: ['feature:editor-frame'] }),
    defineBootPlan(unsupportedBootPlan({ chunk: 'feature:unsupported' })),
  ];
  const plan = selectBootPlan(plans, { key: `${detected.hostMode}:${detected.formFactor}`, ...detected });
  if (!plan.ok) throw plan.error;
  let screen: string | undefined;
  if (plan.value.id === 'unsupported') {
    const mounted = mountUnsupportedScreen(document.body, unsupportedScreenModel(verdict, { title: 'Instaflow needs Chrome on desktop' }), document);
    screen = mounted.root.textContent ?? '';
    mounted.dispose();
  }
  return { plan: plan.value.id, codes: verdict.codes, screen };
}

describe('Instaflow baseline example (IF-2.2–2.4)', () => {
  it('desktop Chrome with a GPU boots the editor', async () => {
    expect(await bootFor(chrome(gpuWith(realAdapter)))).toEqual({ plan: 'editor', codes: [], screen: undefined });
  });

  it('Safari / Firefox without WebGPU and friends → IF-PLAT-001 "use Chrome", nothing else probed', async () => {
    const result = await bootFor({ width: 1440, navigator: { userAgent: SAMPLE_USER_AGENTS.macSafari } });
    expect(result.plan).toBe('unsupported');
    expect(result.codes).toEqual(['IF-PLAT-001', 'IF-PLAT-003']);
    expect(result.screen).toContain('Instaflow needs Chrome on desktop');
    expect(result.screen).toContain('IF-PLAT-001');
    expect(result.screen).toContain('Open Instaflow in Chrome on desktop');
  });

  it('Chrome on a blocklisted GPU or VM → IF-PLAT-002', async () => {
    const result = await bootFor(chrome(gpuWith(null)));
    expect(result).toMatchObject({ plan: 'unsupported', codes: ['IF-PLAT-002'] });
    expect(result.screen).toContain('A WebGPU graphics adapter');
  });

  it('Chrome without COOP/COEP → IF-PLAT-003', async () => {
    const result = await bootFor(chrome(gpuWith(realAdapter), { crossOriginIsolated: false }));
    expect(result).toMatchObject({ plan: 'unsupported', codes: ['IF-PLAT-003'] });
    expect(result.screen).toContain('Cross-origin isolation');
  });

  it('a missing enhancement (EditContext, Local Font Access, folders) is not a baseline failure (IF-2.3)', async () => {
    const result = await bootFor(chrome(gpuWith(realAdapter), { EditContext: undefined, queryLocalFonts: undefined, showDirectoryPicker: undefined }));
    expect(result.plan).toBe('editor');
  });
});
