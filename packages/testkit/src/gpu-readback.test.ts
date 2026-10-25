import { describe, expect, it } from 'vitest';
import { createFakeGpu, type FakeGpuDevice, type FakeGpuTexture } from './gpu-fake.js';
import { alignedBytesPerRow, COPY_BYTES_PER_ROW_ALIGNMENT, decodePageImage, encodePageImage, GPU_CONSTANTS, GPU_RESULT_GLOBAL, publishGpuResult, readbackTexture } from './gpu-readback.js';
import { syntheticImage } from './image.js';

const { TextureUsage } = GPU_CONSTANTS;

async function setup(queue: 'auto' | 'manual' = 'auto'): Promise<{ fake: ReturnType<typeof createFakeGpu>; device: FakeGpuDevice }> {
  const fake = createFakeGpu({ queue });
  const adapter = await fake.gpu.requestAdapter();
  return { fake, device: await adapter!.requestDevice() };
}

function cleared(device: FakeGpuDevice, format: string, width: number, height: number, clearValue: { r: number; g: number; b: number; a: number }): FakeGpuTexture {
  const texture = device.createTexture({ size: [width, height], format, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC });
  const encoder = device.createCommandEncoder();
  encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue }] }).end();
  device.queue.submit([encoder.finish()]);
  return texture;
}

describe('alignedBytesPerRow', () => {
  it('rounds up to 256 bytes', () => {
    expect(COPY_BYTES_PER_ROW_ALIGNMENT).toBe(256);
    expect([alignedBytesPerRow(1), alignedBytesPerRow(64), alignedBytesPerRow(65), alignedBytesPerRow(100, 8)]).toEqual([256, 256, 512, 1024]);
  });
});

describe('readbackTexture', () => {
  it('reads an odd-width RGBA texture, stripping row padding, with no validation errors', async () => {
    const { fake, device } = await setup();
    const texture = cleared(device, 'rgba8unorm', 3, 2, { r: 1, g: 0, b: 0.5, a: 1 });
    const r = await readbackTexture(device, texture);
    if (!r.ok) throw r.error;
    expect([r.value.width, r.value.height, r.value.data.length]).toEqual([3, 2, 24]);
    expect([...r.value.data.subarray(0, 4)]).toEqual([255, 0, 128, 255]);
    expect([...r.value.data.subarray(20, 24)]).toEqual([255, 0, 128, 255]);
    expect(fake.uncapturedErrors).toEqual([]);
    const copy = fake.callsTo('copyTextureToBuffer')[0];
    expect(copy?.args[1]).toMatchObject({ bytesPerRow: 256, rowsPerImage: 2 });
    expect(fake.callsTo('destroy', 'buffer')).toHaveLength(1);
  });

  it('swizzles BGRA (canvas formats) to RGBA', async () => {
    const { device } = await setup();
    const texture = cleared(device, 'bgra8unorm', 2, 2, { r: 1, g: 0.5, b: 0, a: 1 });
    expect([...texture.contents!.subarray(0, 4)]).toEqual([0, 128, 255, 255]);
    const r = await readbackTexture(device, texture);
    expect(r.ok && [...r.value.data.subarray(0, 4)]).toEqual([255, 128, 0, 255]);
  });

  it('reads canvas textures configured with COPY_SRC', async () => {
    const { fake, device } = await setup();
    const handle = fake.createCanvas({ width: 4, height: 4 });
    handle.context.configure({ device, format: 'bgra8unorm', usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC });
    const texture = handle.context.getCurrentTexture();
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 1, 1] }] }).end();
    device.queue.submit([encoder.finish()]);
    const r = await readbackTexture(device, texture);
    expect(r.ok && [...r.value.data.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
  });

  it('errors (SF-TEST-014) on unsupported formats, failed maps, device loss and abort', async () => {
    const { fake, device } = await setup('manual');
    const float = device.createTexture({ size: [2, 2], format: 'rgba16float', usage: TextureUsage.COPY_SRC });
    expect(await readbackTexture(device, float)).toMatchObject({ ok: false, error: { code: 'SF-TEST-014', details: { format: 'rgba16float' } } });

    const texture = cleared(device, 'rgba8unorm', 2, 2, { r: 0, g: 0, b: 0, a: 1 });
    const controller = new AbortController();
    const aborted = readbackTexture(device, texture, { signal: controller.signal });
    controller.abort();
    expect(await aborted).toMatchObject({ ok: false, error: { code: 'SF-TEST-014', details: { aborted: true } } });
    expect(await readbackTexture(device, texture, { signal: controller.signal })).toMatchObject({ ok: false, error: { details: { aborted: true } } });

    const lost = readbackTexture(device, texture);
    fake.loseDevice(device);
    const r = await lost;
    expect(!r.ok && r.error.code).toBe('SF-TEST-014');
    expect(!r.ok && r.error.message).toMatch(/mapping the readback buffer failed \(Device (is|was) lost/);
  });

  it('surfaces a missing COPY_SRC usage as a validation error and a failed readback', async () => {
    const { fake, device } = await setup();
    const texture = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: TextureUsage.RENDER_ATTACHMENT });
    const r = await readbackTexture(device, texture);
    // Without the error scope this would "succeed" with zeros, as on real GPUs.
    expect(!r.ok && r.error.code).toBe('SF-TEST-014');
    expect(!r.ok && r.error.details['validation']).toContain('lacks COPY_SRC usage');
    expect(fake.uncapturedErrors).toEqual([]);
    expect(fake.callsTo('destroy', 'buffer')).toHaveLength(1);
  });
});

describe('page images and publishGpuResult', () => {
  it('round-trips images through base64', () => {
    const image = syntheticImage('noise', 70, 300, { seed: 2 }); // > one 32 KiB chunk
    const encoded = encodePageImage(image);
    expect([encoded.width, encoded.height]).toEqual([70, 300]);
    const decoded = decodePageImage(encoded);
    expect(decoded.ok && decoded.value.data).toEqual(image.data);
  });

  it('validates decoded images', () => {
    expect(decodePageImage({ width: 2, height: 2, rgba: btoa('abc') }, 'thumb')).toMatchObject({ ok: false, error: { code: 'SF-TEST-006', details: { role: 'thumb' } } });
    expect(decodePageImage({ width: 1, height: 1, rgba: '%%%' })).toMatchObject({ ok: false, error: { code: 'SF-TEST-014' } });
    expect(() => encodePageImage({ width: 1, height: 1, data: new Uint8Array(1) })).toThrow(expect.objectContaining({ code: 'SF-TEST-006' }));
  });

  it('publishes on the given target (default globalThis)', () => {
    const target: Record<string, unknown> = {};
    publishGpuResult({ ok: true, data: { frames: 3 } }, target);
    expect(target[GPU_RESULT_GLOBAL]).toEqual({ ok: true, data: { frames: 3 } });
    expect(GPU_RESULT_GLOBAL).toBe('__sfGpuResult');
    publishGpuResult({ ok: false, error: { message: 'no adapter' } });
    expect((globalThis as Record<string, unknown>)[GPU_RESULT_GLOBAL]).toEqual({ ok: false, error: { message: 'no adapter' } });
    delete (globalThis as Record<string, unknown>)[GPU_RESULT_GLOBAL];
  });
});
