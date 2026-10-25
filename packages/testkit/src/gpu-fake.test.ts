import { describe, expect, it, vi } from 'vitest';
import { createFakeGpu, FAKE_ADAPTER_INFO, FakeGpuOutOfMemoryError, FakeGpuValidationError, GPU_DEFAULT_LIMITS, type FakeGpu, type FakeGpuDevice } from './gpu-fake.js';
import { GPU_CONSTANTS } from './gpu-readback.js';

const { BufferUsage, TextureUsage, MapMode } = GPU_CONSTANTS;

async function device(fake: FakeGpu = createFakeGpu(), descriptor?: Parameters<NonNullable<Awaited<ReturnType<FakeGpu['gpu']['requestAdapter']>>>['requestDevice']>[0]): Promise<FakeGpuDevice> {
  const adapter = await fake.gpu.requestAdapter();
  if (adapter === null) throw new Error('no adapter');
  return adapter.requestDevice(descriptor);
}

describe('navigator.gpu and adapters', () => {
  it('exposes adapter info, features and spec-default limits; overrides apply', async () => {
    const plain = await createFakeGpu().gpu.requestAdapter();
    expect(plain?.info).toEqual(FAKE_ADAPTER_INFO);
    expect(plain?.limits.maxTextureDimension2D).toBe(8192);
    expect(plain?.limits).toEqual(GPU_DEFAULT_LIMITS);
    expect([...(plain?.features ?? [])]).toEqual([]);
    const fake = createFakeGpu({ adapter: { info: { vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true }, features: ['timestamp-query', 'shader-f16'], limits: { maxTextureDimension2D: 16384 } } });
    const adapter = await fake.gpu.requestAdapter({ powerPreference: 'high-performance' });
    expect(adapter?.info).toMatchObject({ vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true, description: FAKE_ADAPTER_INFO.description });
    expect(adapter?.isFallbackAdapter).toBe(true);
    expect(adapter?.features.has('shader-f16')).toBe(true);
    expect(adapter?.limits.maxTextureDimension2D).toBe(16384);
    expect(fake.callsTo('requestAdapter')).toEqual([{ seq: 1, target: 'gpu', method: 'requestAdapter', args: [{ powerPreference: 'high-performance' }] }]);
  });

  it('returns null when no adapter is configured, and can change later', async () => {
    const fake = createFakeGpu({ adapter: false, preferredCanvasFormat: 'rgba8unorm', wgslLanguageFeatures: ['packed_4x8_integer_dot_product'] });
    expect(await fake.gpu.requestAdapter()).toBeNull();
    fake.setAdapter({});
    expect(await fake.gpu.requestAdapter()).not.toBeNull();
    expect(fake.gpu.getPreferredCanvasFormat()).toBe('rgba8unorm');
    expect(createFakeGpu().gpu.getPreferredCanvasFormat()).toBe('bgra8unorm');
    expect(fake.gpu.wgslLanguageFeatures.has('packed_4x8_integer_dot_product')).toBe(true);
    expect(fake.adapters).toHaveLength(1);
  });

  it('consumes an adapter on its first requestDevice (recovery must request a new adapter)', async () => {
    const fake = createFakeGpu();
    const adapter = (await fake.gpu.requestAdapter())!;
    expect(adapter.state).toBe('valid');
    await adapter.requestDevice();
    expect(adapter.state).toBe('consumed');
    await expect(adapter.requestDevice()).rejects.toMatchObject({ name: 'OperationError' });
  });

  it('gives devices only the requested features, and default limits unless better ones are required', async () => {
    const fake = createFakeGpu({ adapter: { features: ['timestamp-query'], limits: { maxTextureDimension2D: 16384, maxBufferSize: 1 << 30, minUniformBufferOffsetAlignment: 64 } } });
    const plain = await device(fake);
    expect([...plain.features]).toEqual([]);
    expect(plain.limits.maxTextureDimension2D).toBe(8192); // not the adapter's 16384
    const tuned = await device(fake, { requiredFeatures: ['timestamp-query'], requiredLimits: { maxTextureDimension2D: 16384, maxBufferSize: 1024, minUniformBufferOffsetAlignment: 64 } });
    expect(tuned.features.has('timestamp-query')).toBe(true);
    expect(tuned.limits.maxTextureDimension2D).toBe(16384);
    expect(tuned.limits.maxBufferSize).toBe(GPU_DEFAULT_LIMITS.maxBufferSize); // a worse value keeps the default
    expect(tuned.limits.minUniformBufferOffsetAlignment).toBe(64);
    expect(tuned.adapterInfo).toEqual(FAKE_ADAPTER_INFO);
  });

  it('rejects unsupported features (TypeError) and limits beyond the adapter (OperationError)', async () => {
    const fake = createFakeGpu();
    await expect(device(fake, { requiredFeatures: ['shader-f16'] })).rejects.toBeInstanceOf(TypeError);
    await expect(device(fake, { requiredLimits: { maxTextureDimension2D: 9000 } })).rejects.toMatchObject({ name: 'OperationError' });
    await expect(device(fake, { requiredLimits: { minStorageBufferOffsetAlignment: 32 } })).rejects.toMatchObject({ name: 'OperationError' });
    await expect(device(fake, { requiredLimits: { maxWidgets: 1 } })).rejects.toMatchObject({ name: 'OperationError' });
  });

  it('failNextRequestDevice injects one failure', async () => {
    const fake = createFakeGpu();
    fake.failNextRequestDevice();
    await expect(device(fake)).rejects.toMatchObject({ name: 'OperationError' });
    const custom = new Error('driver crash');
    fake.failNextRequestDevice(custom);
    await expect(device(fake)).rejects.toBe(custom);
    await expect(device(fake)).resolves.toBeDefined();
  });
});

describe('call recording', () => {
  it('records every call with a target id and arguments, filterable by method and kind', async () => {
    const fake = createFakeGpu();
    const d = await device(fake, { label: 'main', defaultQueue: { label: 'q' } });
    expect(d.label).toBe('main');
    expect(d.queue.label).toBe('q');
    const module = d.createShaderModule({ code: '@vertex fn vs() {}' });
    expect(await module.getCompilationInfo()).toEqual({ messages: [] });
    const pipeline = d.createRenderPipeline({ label: 'p', layout: 'auto', vertex: { module } });
    pipeline.getBindGroupLayout(0);
    const target = d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: TextureUsage.RENDER_ATTACHMENT });
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    d.queue.submit([encoder.finish()]);
    expect(fake.callsTo('draw')).toEqual([expect.objectContaining({ target: 'render-pass#1', args: [3] })]);
    expect(fake.callsTo('createRenderPipeline', 'device')[0]?.args[0]).toMatchObject({ label: 'p' });
    expect(fake.callsTo('submit', 'queue')).toHaveLength(1);
    const seqs = fake.calls.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(fake.uncapturedErrors).toEqual([]);
    fake.clearCalls();
    expect(fake.calls).toEqual([]);
    expect(fake.devices).toEqual([d]);
  });

  it('creates the remaining object kinds with labels', async () => {
    const d = await device();
    expect(d.createSampler({ label: 's' }).label).toBe('s');
    expect(d.createBindGroupLayout({ label: 'l', entries: [] }).fakeId).toBe('bind-group-layout#1');
    expect(d.createPipelineLayout({ bindGroupLayouts: [] }).fakeId).toBe('pipeline-layout#1');
    expect(d.createBindGroup({ layout: {}, entries: [] }).fakeId).toBe('bind-group#1');
    expect(d.createComputePipeline({ layout: 'auto', compute: {} }).fakeId).toBe('compute-pipeline#1');
    expect((await d.createRenderPipelineAsync({ layout: 'auto', vertex: {} })).fakeId).toBe('render-pipeline#1');
    expect((await d.createComputePipelineAsync({ layout: 'auto', compute: {} })).fakeId).toBe('compute-pipeline#2');
    expect(d.createQuerySet({ type: 'occlusion', count: 2 }).fakeId).toBe('query-set#1');
    const encoder = d.createCommandEncoder({ label: 'e' });
    const compute = encoder.beginComputePass();
    compute.dispatchWorkgroups(8, 8);
    compute.end();
    encoder.pushDebugGroup('g');
    encoder.insertDebugMarker('m');
    encoder.popDebugGroup();
    expect(encoder.finish().valid).toBe(true);
  });
});

describe('copies, clears and mapping', () => {
  it('executes writeBuffer → copyBufferToBuffer → mapAsync and returns the bytes', async () => {
    const d = await device();
    const src = d.createBuffer({ size: 16, usage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST });
    const dst = d.createBuffer({ size: 16, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    d.queue.writeBuffer(src, 0, new Uint32Array([1, 2, 3, 4]), 1, 2); // elements 1..2 (typed-array units)
    const encoder = d.createCommandEncoder();
    encoder.copyBufferToBuffer(src, 0, dst, 8, 8);
    d.queue.submit([encoder.finish()]);
    expect(dst.mapState).toBe('unmapped');
    const mapping = dst.mapAsync(MapMode.READ);
    expect(dst.mapState).toBe('pending');
    await mapping;
    expect(dst.mapState).toBe('mapped');
    expect([...new Uint32Array(dst.getMappedRange())]).toEqual([0, 0, 2, 3]);
    expect([...new Uint32Array(dst.getMappedRange(8, 4))]).toEqual([2]);
    dst.unmap();
    expect(dst.mapState).toBe('unmapped');
    expect(() => dst.getMappedRange()).toThrow(expect.objectContaining({ name: 'OperationError' }));
  });

  it('clears render targets (sRGB-encoding for -srgb, BGRA byte order) and copies texture → buffer with padding', async () => {
    const d = await device();
    const make = (format: string): ReturnType<FakeGpuDevice['createTexture']> => d.createTexture({ size: { width: 2, height: 2 }, format, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC });
    const rgba = make('rgba8unorm');
    const bgra = make('bgra8unorm');
    const srgb = make('rgba8unorm-srgb');
    const encoder = d.createCommandEncoder();
    for (const texture of [rgba, bgra, srgb]) {
      encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 0.5, b: 0, a: 1 } }] }).end();
    }
    const out = d.createBuffer({ size: 512, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    encoder.copyTextureToBuffer({ texture: rgba }, { buffer: out, bytesPerRow: 256 }, [2, 2]);
    d.queue.submit([encoder.finish()]);
    expect([...rgba.contents!.subarray(0, 4)]).toEqual([255, 128, 0, 255]);
    expect([...bgra.contents!.subarray(0, 4)]).toEqual([0, 128, 255, 255]);
    expect([...srgb.contents!.subarray(0, 4)]).toEqual([255, 188, 0, 255]); // linear 0.5 → sRGB 0.735
    await out.mapAsync(MapMode.READ);
    const bytes = new Uint8Array(out.getMappedRange());
    expect([...bytes.subarray(0, 8)]).toEqual([255, 128, 0, 255, 255, 128, 0, 255]);
    expect([...bytes.subarray(8, 12)]).toEqual([0, 0, 0, 0]); // padding
    expect([...bytes.subarray(256, 260)]).toEqual([255, 128, 0, 255]); // row 1
  });

  it('writeTexture, copyBufferToTexture, copyTextureToTexture and clearBuffer', async () => {
    const d = await device();
    const a = d.createTexture({ size: [2, 1], format: 'rgba8unorm', usage: TextureUsage.COPY_DST | TextureUsage.COPY_SRC });
    const b = d.createTexture({ size: [2, 1], format: 'rgba8unorm', usage: TextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: a }, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { bytesPerRow: 8 }, [2, 1]);
    const staging = d.createBuffer({ size: 256, usage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST });
    d.queue.writeBuffer(staging, 0, new Uint8Array([9, 9, 9, 9]));
    const encoder = d.createCommandEncoder();
    encoder.copyTextureToTexture({ texture: a }, { texture: b }, [2, 1]);
    encoder.copyBufferToTexture({ buffer: staging, bytesPerRow: 256 }, { texture: a, origin: [1, 0] }, [1, 1]);
    encoder.clearBuffer(staging);
    d.queue.submit([encoder.finish()]);
    expect([...b.contents!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...a.contents!]).toEqual([1, 2, 3, 4, 9, 9, 9, 9]);
    expect(staging.contents.every((v) => v === 0)).toBe(true);
  });

  it('settles maps only on flushQueue with queue: manual', async () => {
    const fake = createFakeGpu({ queue: 'manual' });
    const md = await device(fake);
    const buffer = md.createBuffer({ size: 4, usage: BufferUsage.MAP_READ });
    let mapped = false;
    const done = vi.fn();
    void buffer.mapAsync(MapMode.READ).then(() => (mapped = true));
    void md.queue.onSubmittedWorkDone().then(done);
    await Promise.resolve();
    expect(mapped).toBe(false);
    fake.flushQueue();
    await Promise.resolve();
    expect(mapped).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(md.isLost).toBe(false);
  });

  it('mappedAtCreation exposes the whole buffer', async () => {
    const d = await device();
    const buffer = d.createBuffer({ size: 8, usage: BufferUsage.COPY_SRC, mappedAtCreation: true });
    expect(buffer.mapState).toBe('mapped');
    expect(buffer.getMappedRange().byteLength).toBe(8);
    buffer.unmap();
    expect(buffer.mapState).toBe('unmapped');
  });
});

describe('validation errors and error scopes', () => {
  it('reports the classic readback mistakes as validation errors', async () => {
    const fake = createFakeGpu();
    const d = await device(fake);
    const noCopySrc = d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: TextureUsage.RENDER_ATTACHMENT });
    const texture = d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: TextureUsage.COPY_SRC });
    const readable = d.createBuffer({ size: 1024, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    const small = d.createBuffer({ size: 64, usage: BufferUsage.COPY_DST });
    const cases: [() => void, string][] = [
      [() => d.createCommandEncoder().copyTextureToBuffer({ texture }, { buffer: readable, bytesPerRow: 16 }, [4, 4]), 'bytesPerRow (16) must be a multiple of 256'],
      [() => d.createCommandEncoder().copyTextureToBuffer({ texture }, { buffer: readable }, [4, 4]), 'bytesPerRow is required'],
      [() => d.createCommandEncoder().copyTextureToBuffer({ texture: noCopySrc }, { buffer: readable, bytesPerRow: 256 }, [4, 4]), 'lacks COPY_SRC usage'],
      [() => d.createCommandEncoder().copyTextureToBuffer({ texture }, { buffer: small, bytesPerRow: 256 }, [4, 4]), 'overruns buffer'],
      [() => void d.createBuffer({ size: 4, usage: BufferUsage.COPY_DST }).mapAsync(MapMode.READ).catch(() => undefined), 'without MAP_READ usage'],
      [() => d.createTexture({ size: [9000, 1], format: 'rgba8unorm', usage: 1 }), 'exceeds maxTextureDimension2D'],
    ];
    for (const [action, message] of cases) {
      d.pushErrorScope('validation');
      action();
      const error = await d.popErrorScope();
      expect(error).toBeInstanceOf(FakeGpuValidationError);
      expect(error?.message).toContain(message);
    }
    expect(fake.uncapturedErrors).toEqual([]);
  });

  it('an invalid encoder makes submit a validation error and skips its commands', async () => {
    const fake = createFakeGpu();
    const d = await device(fake);
    const src = d.createBuffer({ size: 8, usage: BufferUsage.COPY_SRC });
    const dst = d.createBuffer({ size: 8, usage: BufferUsage.COPY_DST });
    d.queue.writeBuffer(d.createBuffer({ size: 4, usage: BufferUsage.COPY_DST }), 0, new Uint8Array(4));
    const encoder = d.createCommandEncoder();
    encoder.copyBufferToBuffer(src, 0, dst, 0, 8);
    encoder.copyBufferToBuffer(dst, 0, src, 0, 8); // dst lacks COPY_SRC → invalid
    const commands = encoder.finish();
    expect(commands.valid).toBe(false);
    d.queue.submit([commands]);
    expect(fake.uncapturedErrors.map((e) => e.message)).toEqual([`${dst.fakeId} lacks COPY_SRC usage.`, 'submit: command-buffer#1 is invalid (an encoder command failed validation).']);
  });

  it('rejects submitting mapped or destroyed resources and double submits', async () => {
    const fake = createFakeGpu();
    const d = await device(fake);
    const src = d.createBuffer({ size: 4, usage: BufferUsage.COPY_SRC | BufferUsage.MAP_WRITE });
    const dst = d.createBuffer({ size: 4, usage: BufferUsage.COPY_DST });
    await src.mapAsync(MapMode.WRITE);
    const e1 = d.createCommandEncoder();
    e1.copyBufferToBuffer(src, 0, dst, 0, 4);
    const cb = e1.finish();
    d.queue.submit([cb]);
    src.unmap();
    d.queue.submit([cb]);
    d.queue.submit([cb]);
    dst.destroy();
    const e2 = d.createCommandEncoder();
    e2.copyBufferToBuffer(src, 0, dst, 0, 4);
    d.queue.submit([e2.finish()]);
    expect(fake.uncapturedErrors.map((e) => e.message)).toEqual([
      `submit: ${src.fakeId} is mapped; unmap it first.`,
      'submit: command-buffer#1 was already submitted.',
      `submit: ${dst.fakeId} is destroyed.`,
    ]);
  });

  it('flags encoder misuse: commands during a pass, finish with an open pass, finish twice', async () => {
    const fake = createFakeGpu();
    const d = await device(fake);
    const buffer = d.createBuffer({ size: 4, usage: BufferUsage.COPY_DST });
    const encoder = d.createCommandEncoder();
    encoder.beginComputePass();
    encoder.clearBuffer(buffer);
    encoder.finish();
    encoder.finish();
    expect(fake.uncapturedErrors.map((e) => e.message)).toEqual([
      'clearBuffer on encoder#1 while a pass is open.',
      'finish() on encoder#1 with a pass still open (call pass.end()).',
      'finish() on encoder#1 with a pass still open (call pass.end()).',
      'finish() called twice on encoder#1.',
    ]);
  });

  it('routes errors to the innermost matching scope; others go to uncapturederror', async () => {
    const fake = createFakeGpu();
    const d = await device(fake);
    const listener = vi.fn();
    const handler = vi.fn();
    d.addEventListener('uncapturederror', listener);
    d.onuncapturederror = handler;
    d.pushErrorScope('out-of-memory');
    d.pushErrorScope('validation');
    d.createBuffer({ size: GPU_DEFAULT_LIMITS.maxBufferSize + 1, usage: 0 });
    fake.injectError(d, new FakeGpuValidationError('first'));
    fake.injectError(d, new FakeGpuValidationError('second (dropped: scope already holds an error)'));
    expect((await d.popErrorScope())?.message).toBe('first');
    expect(await d.popErrorScope()).toBeInstanceOf(FakeGpuOutOfMemoryError);
    await expect(d.popErrorScope()).rejects.toMatchObject({ name: 'OperationError' });
    fake.injectError(d, new FakeGpuValidationError('loose'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].error.message).toBe('loose');
    expect(handler).toHaveBeenCalledTimes(1);
    d.removeEventListener('uncapturederror', listener);
    fake.injectError(d, new FakeGpuValidationError('again'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fake.uncapturedErrors.map((e) => e.message)).toEqual(['loose', 'again']);
  });

  it('turns compiler errors from options.compile into validation errors', async () => {
    const fake = createFakeGpu({ compile: (code) => (code.includes('oops') ? [{ type: 'error', message: 'unexpected token', lineNum: 1, linePos: 3 }] : []) });
    const d = await device(fake);
    const module = d.createShaderModule({ code: 'oops' });
    expect((await module.getCompilationInfo()).messages[0]?.message).toBe('unexpected token');
    expect(fake.uncapturedErrors[0]?.message).toBe('Shader compilation failed: unexpected token');
  });

  it('exposes WebGPU globals for vi.stubGlobal', () => {
    const { globals } = createFakeGpu();
    expect(globals.GPUBufferUsage.MAP_READ).toBe(1);
    expect(globals.GPUTextureUsage.RENDER_ATTACHMENT).toBe(16);
    expect(new globals.GPUValidationError('x')).toBeInstanceOf(FakeGpuValidationError);
  });
});

describe('device loss', () => {
  it('loseDevice resolves lost once, rejects pending maps, no-ops submit and silences errors', async () => {
    const fake = createFakeGpu({ queue: 'manual' });
    const d = await device(fake);
    const buffer = d.createBuffer({ size: 4, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    const pending = buffer.mapAsync(MapMode.READ);
    fake.loseDevice(d, 'unknown', 'GPU process crashed');
    fake.loseDevice(d, 'destroyed', 'second loss is ignored');
    await expect(d.lost).resolves.toEqual({ reason: 'unknown', message: 'GPU process crashed' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(buffer.mapState).toBe('unmapped');
    expect(d.isLost).toBe(true);
    await expect(buffer.mapAsync(MapMode.READ)).rejects.toMatchObject({ name: 'OperationError' });
    d.queue.writeBuffer(buffer, 0, new Uint8Array([1, 2, 3, 4]));
    expect([...buffer.contents]).toEqual([0, 0, 0, 0]);
    d.pushErrorScope('validation');
    fake.injectError(d, new FakeGpuValidationError('ignored'));
    expect(await d.popErrorScope()).toBeNull();
    expect(fake.uncapturedErrors).toEqual([]);
    expect(fake.callsTo('lose').map((c) => c.args[0])).toEqual(['unknown', 'destroyed']); // both recorded, first wins
  });

  it('device.destroy() loses with reason destroyed; loseDevice defaults to the latest device', async () => {
    const fake = createFakeGpu();
    const first = await device(fake);
    first.destroy();
    await expect(first.lost).resolves.toMatchObject({ reason: 'destroyed' });
    const second = await device(fake);
    fake.loseDevice();
    await expect(second.lost).resolves.toEqual({ reason: 'unknown', message: 'Device lost (injected).' });
    expect(() => createFakeGpu().loseDevice()).toThrow(TypeError);
  });

  it('supports the recovery flow: lost → new adapter → new device', async () => {
    const fake = createFakeGpu();
    const recover = async (): Promise<FakeGpuDevice> => {
      const adapter = await fake.gpu.requestAdapter();
      if (adapter === null) throw new Error('no adapter');
      return adapter.requestDevice();
    };
    const d1 = await recover();
    fake.loseDevice(d1);
    await d1.lost;
    const d2 = await recover();
    expect(d2).not.toBe(d1);
    expect(d2.isLost).toBe(false);
    expect(fake.adapters).toHaveLength(2);
  });
});

describe('canvas context', () => {
  it('configures, hands out one texture per frame and expires it on present', async () => {
    const fake = createFakeGpu();
    const d = await device(fake);
    const { canvas, context, present } = fake.createCanvas({ width: 8, height: 4 });
    expect(canvas.getContext('webgpu')).toBe(context);
    expect(canvas.getContext('2d')).toBeNull();
    expect(() => context.getCurrentTexture()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    context.configure({ device: d, format: 'bgra8unorm', usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC });
    expect(context.getConfiguration()?.format).toBe('bgra8unorm');
    const t1 = context.getCurrentTexture();
    expect(context.getCurrentTexture()).toBe(t1);
    expect([t1.width, t1.height, t1.format]).toEqual([8, 4, 'bgra8unorm']);
    const handle = fake.createCanvas();
    expect(handle.presentedFrames).toBe(0);
    expect(handle.present()).toBeUndefined();
    expect(present()).toBe(t1);
    expect(t1.destroyed).toBe(true);
    const t2 = context.getCurrentTexture();
    expect(t2).not.toBe(t1);
    context.unconfigure();
    expect(t2.destroyed).toBe(true);
    expect(context.getConfiguration()).toBeNull();
    expect([handle.canvas.width, handle.canvas.height]).toEqual([300, 150]);
  });

  it('reports rendering into an expired (presented) canvas texture', async () => {
    const fake = createFakeGpu();
    const d = await device(fake);
    const handle = fake.createCanvas({ width: 2, height: 2 });
    handle.context.configure({ device: d, format: 'bgra8unorm' });
    const stale = handle.context.getCurrentTexture();
    handle.present();
    expect(handle.presentedFrames).toBe(1);
    expect(handle.lastPresented).toBe(stale);
    const encoder = d.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: stale.createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
    d.queue.submit([encoder.finish()]);
    expect(fake.uncapturedErrors[0]?.message).toBe('submit: canvas-texture#1 is destroyed (canvas textures expire when the frame is presented).');
  });

  it('rejects devices from another fake', async () => {
    const other = await device(createFakeGpu());
    const handle = createFakeGpu().createCanvas();
    handle.context.configure({ device: other, format: 'bgra8unorm' });
    expect(() => handle.context.getCurrentTexture()).toThrow(TypeError);
  });
});
