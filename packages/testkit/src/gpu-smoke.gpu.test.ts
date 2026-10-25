// @vitest-environment node
/**
 * Real-browser GPU smoke test: Chromium + WebGPU (SwiftShader + ANGLE by default, or a real GPU).
 * Off unless SF_GPU is set — run with `pnpm test:gpu` (SwiftShader) or `SF_GPU=real pnpm test:gpu`
 * on a machine with a GPU. Update the golden with `SF_GPU=1 pnpm goldens:update gpu-smoke`.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareImages, RENDER_THRESHOLDS } from './compare.js';
import { createGoldenStore } from './golden.js';
import { gpuModeFromEnv, runGpuPage } from './gpu-runner.js';
import type { RgbaImage } from './image.js';

const mode = gpuModeFromEnv();
const root = fileURLToPath(new URL('../fixtures/gpu-smoke', import.meta.url));

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
}

describe.skipIf(mode === undefined)(`GPU smoke (${mode ?? 'off'})`, () => {
  it('renders, presents without losing the device, and matches the golden', { timeout: 180_000 }, async () => {
    const run = await runGpuPage({ target: { root, page: 'index.html' }, mode: mode!, timeoutMs: 150_000 });
    if (!run.ok) throw run.error;
    const report = run.value;
    expect(report.adapter).not.toBeNull();
    if (mode === 'swiftshader') expect(report.adapter?.architecture.toLowerCase()).toContain('swiftshader');
    expect(report.data).toMatchObject({ presented: 2, lost: { lost: false }, errors: [] });
    expect(report.pageErrors).toEqual([]);

    const triangle = report.images['triangle']!;
    expect([triangle.width, triangle.height]).toEqual([64, 64]);
    expect(pixel(triangle, 32, 40)).toEqual([255, 128, 0, 255]); // inside: fragment color (1, 0.5, 0) in unorm
    expect(pixel(triangle, 1, 1)).toEqual([26, 51, 102, 255]); // outside: clear color (0.1, 0.2, 0.4)

    // The canvas path (BGRA on most platforms, swizzled back) renders the same pixels.
    const canvas = compareImages(report.images['canvas']!, triangle, RENDER_THRESHOLDS.sameBackend);
    expect(canvas.ok && canvas.value.failures).toEqual([]);

    const goldens = createGoldenStore({ dir: new URL('./__goldens__', import.meta.url) });
    goldens.assert('gpu-smoke-triangle', triangle, mode === 'real-gpu' ? RENDER_THRESHOLDS.gpuVsCpu : RENDER_THRESHOLDS.sameBackend);
  });
});
