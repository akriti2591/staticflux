import { createGpuDevice } from '@staticflux/surface/raster';
import { createFakeGpu, type FakeGpu } from '@staticflux/testkit';
import { describe, expect, it } from 'vitest';
import { loadRenderModule, RENDER_ABI_VERSION, type RenderEngineWasm, type RenderGpuWasm, type RenderWasm } from './render-module.js';
import { createVelloRasterBackend } from './vello-backend.js';

const signal = (): AbortSignal => new AbortController().signal;

interface FakeWasm extends RenderWasm {
  readonly calls: string[];
  readonly engines: FakeEngine[];
  fake: FakeGpu;
  failCreate: boolean;
  /** Next readback: 'ok' | 'reject' | a promise to control timing. */
  readback: 'ok' | 'reject' | Promise<unknown>;
  throwOn: string | undefined;
}

interface FakeEngine extends RenderEngineWasm {
  freed: boolean;
  gpu: RenderGpuWasm | undefined;
  lastComposite: { clear: number[]; quads: number[]; sources: number[]; present: boolean } | undefined;
}

/** A stand-in for the wasm-bindgen module: records calls, owns devices from the testkit GPU fake. */
function fakeWasm(): FakeWasm {
  const calls: string[] = [];
  const engines: FakeEngine[] = [];
  const wasm: FakeWasm = {
    calls,
    engines,
    fake: createFakeGpu({ adapter: { info: { architecture: 'swiftshader', isFallbackAdapter: true }, features: ['float32-filterable'], limits: { maxTextureDimension2D: 8192 } } }),
    failCreate: false,
    readback: 'ok',
    throwOn: undefined,
    abi_version: () => RENDER_ABI_VERSION,
    ir_version: () => 1,
    take_errors: () => ['validation error (fake)'],
    async create_gpu(canvas, width, height) {
      calls.push(`create_gpu ${canvas === null ? 'headless' : 'canvas'} ${width}x${height}`);
      if (wasm.failCreate) throw new Error('request_adapter: no adapter');
      const adapter = await wasm.fake.gpu.requestAdapter();
      const device = await adapter!.requestDevice({ requiredFeatures: ['float32-filterable'], requiredLimits: { maxTextureDimension2D: 8192 } });
      return { device, free: () => calls.push('gpu.free') } as RenderGpuWasm;
    },
    Engine: class {
      freed = false;
      gpu: (RenderGpuWasm & { device?: { destroy(): void } }) | undefined;
      lastComposite: FakeEngine['lastComposite'];
      private pending = false;
      constructor() {
        engines.push(this as unknown as FakeEngine);
      }
      private guard(method: string): void {
        calls.push(method);
        if (wasm.throwOn === method) throw `${method}: engine error (fake)`;
      }
      tile_size = () => 512;
      apply = (batch: Uint8Array) => {
        this.guard('apply');
        return Float64Array.from([0, 0, batch.length, 10]);
      };
      bounds = () => Float64Array.from([0, 0, 100, 50]);
      set_layer = (layer: number, nodes: Uint32Array) => {
        this.guard(`set_layer ${layer} [${[...nodes].join(',')}]`);
        return Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
      };
      release_layer = (layer: number) => void calls.push(`release_layer ${layer}`);
      has_layer = () => true;
      install_gpu = (gpu: RenderGpuWasm) => {
        this.guard('install_gpu');
        this.gpu = gpu;
      };
      drop_gpu = () => {
        calls.push('drop_gpu');
        this.gpu?.device?.destroy();
        this.gpu = undefined;
      };
      has_gpu = () => this.gpu !== undefined;
      raw_device = () => this.gpu?.device;
      max_target = () => 4096;
      resize = (w: number, h: number) => this.guard(`resize ${w}x${h}`);
      render_tile = (slot: number, level: number, tx: number, ty: number, bg: Float32Array) => {
        this.guard(`render_tile ${slot} ${level}:${tx}:${ty} bg=${[...bg].join(',')}`);
        return 512 * 512 * 4;
      };
      release_tile = (slot: number) => void calls.push(`release_tile ${slot}`);
      render_layer = (layer: number, zoom: number) => {
        this.guard(`render_layer ${layer} ${zoom}`);
        return Float64Array.from([9, 19, 30, 40, 4800]);
      };
      upload_snapshot = (w: number, h: number) => this.guard(`upload_snapshot ${w}x${h}`);
      composite = (clear: Float32Array, quads: Float32Array, sources: Uint32Array, present: boolean) => {
        this.guard('composite');
        this.lastComposite = { clear: [...clear], quads: [...quads], sources: [...sources], present };
      };
      warm_up = () => {
        this.guard('warm_up');
        return Promise.resolve();
      };
      private begin(method: string): Promise<unknown> {
        this.guard(method);
        if (this.pending) throw 'a readback is already pending';
        this.pending = true;
        const r = wasm.readback;
        wasm.readback = 'ok';
        return r === 'ok' ? Promise.resolve() : r === 'reject' ? Promise.reject(new Error('map_async failed')) : r;
      }
      begin_read_frame = () => this.begin('begin_read_frame');
      begin_region = (x0: number, y0: number, x1: number, y1: number, w: number, h: number) => this.begin(`begin_region ${x0},${y0},${x1},${y1} ${w}x${h}`);
      finish_readback = () => {
        calls.push('finish_readback');
        this.pending = false;
        return new Uint8Array(4 * 4 * 4).fill(9);
      };
      cancel_readback = () => {
        calls.push('cancel_readback');
        this.pending = false;
      };
      stats = () => Float64Array.from([2, 2 * 512 * 512 * 4, 4800, 100]);
      free = () => {
        calls.push('free');
        this.freed = true;
      };
    } as unknown as new () => RenderEngineWasm,
  };
  return wasm;
}

describe('createVelloRasterBackend', () => {
  it('attaches a device and reports GPU facts from the raw device', async () => {
    const wasm = fakeWasm();
    const backend = createVelloRasterBackend({ wasm, width: 4, height: 4 });
    expect(backend.tileSize).toBe(512);
    expect(backend.maxRegionSize).toBe(4096);
    const handle = await backend.attach({ signal: signal() });
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;
    expect(wasm.calls).toContain('create_gpu headless 4x4');
    expect(handle.value.facts.features).toEqual(['float32-filterable']);
    expect(handle.value.facts.limits['maxTextureDimension2D']).toBe(8192);
    const lost = handle.value.lost;
    handle.value.destroy();
    expect((await lost).reason).toBe('destroyed');
  });

  it('maps a failed device creation to SF-SURF-010 and an aborted attach frees the device', async () => {
    const wasm = fakeWasm();
    wasm.failCreate = true;
    const backend = createVelloRasterBackend({ wasm });
    const failed = await backend.attach({ signal: signal() });
    expect(!failed.ok && failed.error.code).toBe('SF-SURF-010');
    wasm.failCreate = false;
    const controller = new AbortController();
    const pending = backend.attach({ signal: controller.signal });
    controller.abort();
    expect((await pending).ok).toBe(false);
    expect(wasm.calls).toContain('gpu.free');
  });

  it('re-attaches through the device lifecycle after a loss, dropping the old device first', async () => {
    const wasm = fakeWasm();
    const backend = createVelloRasterBackend({ wasm });
    const device = createGpuDevice({ id: 'vello', provider: { acquire: (o) => backend.attach(o) }, sleep: async () => undefined });
    expect((await device.attach()).ok).toBe(true);
    const recovered = new Promise((resolve) => device.onRecovered(resolve));
    wasm.fake.loseDevice();
    expect(await recovered).toMatchObject({ ok: true, attempts: 1 });
    expect(wasm.calls.filter((c) => c.startsWith('create_gpu'))).toHaveLength(2);
    expect(wasm.calls.indexOf('drop_gpu')).toBeLessThan(wasm.calls.lastIndexOf('install_gpu'));
    expect(wasm.fake.adapters).toHaveLength(2);
    device.dispose();
  });

  it('passes scene, tile, layer and snapshot calls through and maps engine errors to SF-SURF-014', async () => {
    const wasm = fakeWasm();
    const backend = createVelloRasterBackend({ wasm });
    await backend.attach({ signal: signal() });
    expect(backend.apply(new Uint8Array(12))).toEqual({ ok: true, value: [{ x0: 0, y0: 0, x1: 12, y1: 10 }] });
    expect(backend.bounds()).toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 });
    expect(backend.renderTile(3, { level: -2, tx: 1, ty: 0 }, [1, 1, 1, 1])).toEqual({ ok: true, value: { bytes: 512 * 512 * 4 } });
    expect(wasm.calls).toContain('render_tile 3 -2:1:0 bg=1,1,1,1');
    expect(backend.setLayer(4, [7, 8])).toEqual({ ok: true, value: [{ x0: 1, y0: 2, x1: 3, y1: 4 }, { x0: 5, y0: 6, x1: 7, y1: 8 }] });
    expect(backend.renderLayer(4, 2)).toEqual({ ok: true, value: { layer: 4, zoom: 2, x: 9, y: 19, width: 30, height: 40, bytes: 4800 } });
    backend.releaseLayer(4);
    backend.releaseTile(3);
    expect(backend.uploadSnapshot({ width: 2, height: 1, data: new Uint8Array(8) }).ok).toBe(true);
    expect(backend.resize(10.4, 0).ok).toBe(true);
    expect(wasm.calls).toContain('resize 10x1');
    expect(backend.stats()).toEqual({ tiles: 2, tileBytes: 2 * 512 * 512 * 4, layerBytes: 4800, otherBytes: 100 });
    expect((await backend.warmUp({ signal: signal() })).ok).toBe(true);
    wasm.throwOn = 'apply';
    const failed = backend.apply(new Uint8Array(1));
    expect(!failed.ok && failed.error.code).toBe('SF-SURF-014');
    expect(!failed.ok && failed.error.message).toContain('engine error (fake)');
  });

  it('packs composite quads and sources (kind << 24 | id)', async () => {
    const wasm = fakeWasm();
    const backend = createVelloRasterBackend({ wasm });
    await backend.attach({ signal: signal() });
    backend.composite({
      clear: [1, 1, 1, 1],
      quads: [
        { source: { kind: 'tile', slot: 5 }, dst: [0, 0, 512, 512] },
        { source: { kind: 'layer', layer: 2 }, dst: [10, 20, 30, 40], uv: [0, 0, 0.5, 0.5], opacity: 0.25 },
        { source: { kind: 'snapshot' }, dst: [0, 0, 1, 1] },
      ],
      present: false,
    });
    const last = wasm.engines[0]!.lastComposite!;
    expect(last.sources).toEqual([5, (1 << 24) | 2, 2 << 24]);
    expect(last.quads.slice(9, 18)).toEqual([10, 20, 30, 40, 0, 0, 0.5, 0.5, 0.25]);
    expect(last.present).toBe(false);
  });

  it('serializes readbacks, honours abort and maps map failures to SF-SURF-015', async () => {
    const wasm = fakeWasm();
    const backend = createVelloRasterBackend({ wasm, width: 4, height: 4 });
    await backend.attach({ signal: signal() });
    let release!: () => void;
    wasm.readback = new Promise<void>((resolve) => (release = resolve));
    const first = backend.readFrame({ signal: signal() });
    const second = backend.renderRegion({ world: { x0: 0, y0: 0, x1: 4, y1: 4 }, width: 4, height: 4 }, { signal: signal() });
    await Promise.resolve();
    expect(wasm.calls.filter((c) => c.startsWith('begin_'))).toEqual(['begin_read_frame']); // second waits
    release();
    expect((await first).ok).toBe(true);
    const region = await second;
    expect(region.ok && region.value).toMatchObject({ width: 4, height: 4 });
    expect(wasm.calls).toContain('begin_region 0,0,4,4 4x4');

    const controller = new AbortController();
    let late!: () => void;
    wasm.readback = new Promise<void>((resolve) => (late = resolve));
    const aborted = backend.readFrame({ signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    late();
    expect((await aborted).ok).toBe(false);
    expect(wasm.calls.at(-1)).toBe('cancel_readback');

    wasm.readback = 'reject';
    const rejected = await backend.readFrame({ signal: signal() });
    expect(!rejected.ok && rejected.error.code).toBe('SF-SURF-015');
  });

  it('dispose frees the engine; later calls fail', async () => {
    const wasm = fakeWasm();
    const backend = createVelloRasterBackend({ wasm });
    await backend.attach({ signal: signal() });
    backend.dispose();
    backend.dispose();
    expect(wasm.engines[0]!.freed).toBe(true);
    expect(backend.apply(new Uint8Array()).ok).toBe(false);
    expect((await backend.attach({ signal: signal() })).ok).toBe(false);
    expect((await backend.readFrame({ signal: signal() })).ok).toBe(false);
    expect(backend.bounds()).toBeUndefined();
    expect(backend.stats().tiles).toBe(0);
    backend.releaseTile(1);
    backend.releaseLayer(1);
  });
});

describe('loadRenderModule', () => {
  const manifest = { format: 'sf-wasm-manifest/1', artifacts: [{ crate: 'render', wasm: 'render.abc.wasm', js: 'render.def.js' }] };
  const fetchJson = (body: unknown, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });

  it('imports the glue named in the manifest, instantiates it and checks the ABI', async () => {
    const imported: string[] = [];
    const wasm = fakeWasm();
    const result = await loadRenderModule({
      manifestUrl: 'http://x/engine/dist/sf-wasm-manifest.json',
      fetch: fetchJson(manifest),
      importModule: async (url) => {
        imported.push(url);
        return { ...wasm, default: async (input: { module_or_path: string }) => imported.push(input.module_or_path) };
      },
    });
    expect(result.ok).toBe(true);
    expect(imported).toEqual(['http://x/engine/dist/render.def.js', 'http://x/engine/dist/render.abc.wasm']);
  });

  it('fails with SF-SURF-014 on HTTP errors, a missing artifact, an ABI mismatch or a throwing import', async () => {
    const url = 'http://x/sf-wasm-manifest.json';
    const http = await loadRenderModule({ manifestUrl: url, fetch: fetchJson({}, 404) });
    expect(!http.ok && http.error.code).toBe('SF-SURF-014');
    const missing = await loadRenderModule({ manifestUrl: url, fetch: fetchJson({ format: 'sf-wasm-manifest/1', artifacts: [] }) });
    expect(!missing.ok && missing.error.message).toContain('no render artifact');
    const abi = await loadRenderModule({ manifestUrl: url, fetch: fetchJson(manifest), importModule: async () => ({ default: async () => undefined, abi_version: () => 1 }) });
    expect(!abi.ok && abi.error.details).toMatchObject({ expected: RENDER_ABI_VERSION, got: 1 });
    const throwing = await loadRenderModule({ manifestUrl: url, fetch: fetchJson(manifest), importModule: async () => Promise.reject(new Error('404')) });
    expect(!throwing.ok && throwing.error.code).toBe('SF-SURF-014');
    const aborted = await loadRenderModule({ manifestUrl: url, fetch: async () => Promise.reject(new DOMException('aborted', 'AbortError')) });
    expect(!aborted.ok && aborted.error.kind).toBe('aborted');
  });
});
