import { createMemorySink, createTelemetry } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createHeadlessSurface, DEFAULT_HEADLESS_MAX_PIXELS } from './headless.js';
import { createMemoryRasterBackend } from './memory-raster-backend.js';
import type { RasterBackend } from './raster-backend.js';

/** Counts and equality only, never wall-clock: the timeout just keeps a loaded CI runner from failing it. */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

async function scene(maxRegionSize: number) {
  const backend = createMemoryRasterBackend({ maxRegionSize });
  await backend.attach({ signal: new AbortController().signal });
  backend.apply({
    set: [
      { id: 1, rect: { x0: 3, y0: 3, x1: 97, y1: 41 }, color: [255, 0, 0, 255] },
      { id: 2, rect: { x0: 40, y0: 20, x1: 140, y1: 90 }, color: [0, 0, 255, 128] },
      { id: 3, rect: { x0: 63, y0: 0, x1: 65, y1: 100 }, color: [0, 128, 0, 255] },
    ],
  });
  return backend;
}

describe('createHeadlessSurface (SF-Δ24 headless)', () => {
  // Heavy by design (renders past the texture limit; ~1.4 s alone): its own timeout so a busy machine can't fail it.
  it('stitches chunks beyond the texture limit into exactly the one-shot image', { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const big = await scene(4096);
    const small = await scene(64);
    const request = { world: { x0: 0, y0: 0, x1: 150, y1: 100 }, width: 300, height: 200, background: [1, 1, 1, 1] as const };
    const progress: number[] = [];
    const reference = await createHeadlessSurface({ backend: big }).render(request);
    const tiled = await createHeadlessSurface({ backend: small }).render({ ...request, onProgress: (done) => progress.push(done) });
    expect(reference.ok && tiled.ok).toBe(true);
    if (!reference.ok || !tiled.ok) return;
    expect([tiled.value.width, tiled.value.height]).toEqual([300, 200]);
    expect(tiled.value.data).toEqual(reference.value.data);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]); // 5 × 4 chunks of 64
    expect(small.log.filter((l) => l === 'renderRegion')).toHaveLength(20);
  });

  it('chunkSize can only shrink the backend limit', async () => {
    const backend = await scene(64);
    const surface = createHeadlessSurface({ backend, chunkSize: 1000 });
    expect((await surface.render({ world: { x0: 0, y0: 0, x1: 10, y1: 10 }, width: 100, height: 10 })).ok).toBe(true);
    expect(backend.log.filter((l) => l === 'renderRegion')).toHaveLength(2);
  });

  it('cancels between chunks', async () => {
    const backend = await scene(32);
    const controller = new AbortController();
    const surface = createHeadlessSurface({ backend });
    const result = await surface.render({ world: { x0: 0, y0: 0, x1: 100, y1: 100 }, width: 128, height: 128, signal: controller.signal, onProgress: (done) => done === 3 && controller.abort() });
    expect(!result.ok && result.error.code).toBe('SF-CORE-002');
    expect(!result.ok && result.error.details).toMatchObject({ done: 3, total: 16 });
    const pre = await surface.render({ world: { x0: 0, y0: 0, x1: 1, y1: 1 }, width: 1, height: 1, signal: controller.signal });
    expect(pre.ok).toBe(false);
  });

  it('rejects invalid sizes and outputs over maxPixels (SF-SURF-013)', async () => {
    const backend = await scene(64);
    const surface = createHeadlessSurface({ backend, maxPixels: 1000 });
    const world = { x0: 0, y0: 0, x1: 1, y1: 1 };
    for (const [width, height] of [
      [0, 10],
      [10.5, 10],
      [-1, 2],
      [100, 100],
    ] as const) {
      const r = await surface.render({ world, width, height });
      expect(!r.ok && r.error.code).toBe('SF-SURF-013');
    }
    const flat = await surface.render({ world: { x0: 0, y0: 0, x1: 0, y1: 1 }, width: 10, height: 10 });
    expect(!flat.ok && flat.error.code).toBe('SF-SURF-013');
    expect(DEFAULT_HEADLESS_MAX_PIXELS).toBe(256 * 1024 * 1024);
  });

  it('passes backend errors through and checks chunk sizes', async () => {
    const backend = await scene(64);
    backend.dispose();
    const failed = await createHeadlessSurface({ backend }).render({ world: { x0: 0, y0: 0, x1: 1, y1: 1 }, width: 4, height: 4 });
    expect(!failed.ok && failed.error.code).toBe('SF-SURF-014');
    const liar: Pick<RasterBackend, 'renderRegion' | 'maxRegionSize' | 'id'> = {
      id: 'liar',
      maxRegionSize: 64,
      renderRegion: async () => ({ ok: true, value: { width: 1, height: 1, data: new Uint8Array(4) } }),
    };
    const wrong = await createHeadlessSurface({ backend: liar }).render({ world: { x0: 0, y0: 0, x1: 1, y1: 1 }, width: 4, height: 4 });
    expect(!wrong.ok && wrong.error.code).toBe('SF-SURF-013');
  });

  it('records render and chunk metrics', async () => {
    const backend = await scene(64);
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    await createHeadlessSurface({ backend, telemetry, now: () => 0 }).render({ world: { x0: 0, y0: 0, x1: 1, y1: 1 }, width: 70, height: 10 });
    const metrics = sink.records.filter((r) => r.type === 'metric').map((r) => (r as { metric: string }).metric);
    expect(metrics).toEqual(['surface/headless-chunks', 'surface/headless-chunks', 'surface/headless-render']);
  });
});
