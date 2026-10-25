// @vitest-environment node
/**
 * Render module on real WebGPU (IF-7.4, IF-7.5, IF-7.11): Chromium on SwiftShader + ANGLE by default,
 * or a real GPU (`SF_GPU=real`). Off unless SF_GPU is set — run `pnpm build && pnpm test:gpu`.
 * Update the GPU goldens after an intended change with `SF_GPU=1 pnpm goldens:update render.gpu`.
 *
 * The page (`gpu-page/`) runs the `RasterBackend` contract on Vello, renders the engine fixtures, and
 * drives the tiled renderer on a canvas; this file checks the pixels:
 * - GPU vs the committed `vello_cpu` references (RENDER_THRESHOLDS.gpuVsCpu; S1 measured SSIM ≥ 0.9995);
 * - tiles vs a direct region render and a lifted layer over tiles (sameBackend: no seams, S1);
 * - the tiled renderer's sharp frame, a 20 px drag through the lifted layer, and the frame after a
 *   device loss, against direct renders.
 * Timings (warm-up, first sharp frame, recovery) are printed, never asserted (SwiftShader is a CPU).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareImages, type ImageThresholds, RENDER_THRESHOLDS, type RgbaImage } from '@staticflux/testkit';
import { createGoldenStore, decodePng, gpuModeFromEnv, runGpuPage } from '@staticflux/testkit/node';
import { describe, expect, it } from 'vitest';

const mode = gpuModeFromEnv();
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const fixtures = new URL('../../engine/crates/render/fixtures/', import.meta.url);
const built = existsSync(new URL('../../engine/dist/sf-wasm-manifest.json', import.meta.url)) && existsSync(new URL('../../dist/render/vello-backend.js', import.meta.url));

function cpu(name: string): RgbaImage {
  const decoded = decodePng(readFileSync(new URL(`${name}.cpu.png`, fixtures)));
  if (!decoded.ok) throw decoded.error;
  return decoded.value;
}

function expectClose(actual: RgbaImage | undefined, expected: RgbaImage | undefined, thresholds: ImageThresholds, what: string): void {
  expect(actual, `${what}: image missing`).toBeDefined();
  expect(expected, `${what}: reference missing`).toBeDefined();
  const result = compareImages(actual!, expected!, thresholds);
  if (!result.ok) throw result.error;
  expect(result.value.failures, `${what}: ssim ${result.value.ssim.toFixed(5)}, max delta ${result.value.diff.maxChannelDelta}`).toEqual([]);
}

describe.skipIf(mode === undefined)(`render module on WebGPU (${mode ?? 'off'})`, () => {
  it('passes the contract, matches vello_cpu, has no seams and survives a device loss', { timeout: 600_000 }, async () => {
    expect(built, 'run `pnpm build` first (render Wasm + apps/instaflow dist)').toBe(true);
    const run = await runGpuPage({ target: { root, page: 'apps/instaflow/src/render/gpu-page/index.html' }, mode: mode!, timeoutMs: 540_000 });
    if (!run.ok) throw run.error;
    const report = run.value;
    const data = report.data as {
      abi: number;
      contract: { name: string; ok: boolean; error?: string }[];
      timings: Record<string, number>;
      errors: string[];
      sharp: boolean;
      sharpAfterLoss: boolean;
      dragTileBytesUnchanged: boolean;
      recovery: { ok: boolean; attempts: number; ms: number };
      text: { runs: number; words: number; lines: number; fontFilesSent: number };
    };
    // eslint-disable-next-line no-console
    console.log(`render GPU (${mode}, ${report.adapter?.architecture ?? '?'}): timings ${JSON.stringify(data.timings)}, recovery ${JSON.stringify(data.recovery)}`);
    expect(report.pageErrors).toEqual([]);
    expect(data.abi).toBe(2);
    expect(data.contract.filter((c) => !c.ok)).toEqual([]);
    expect(data.contract).toHaveLength(10);

    // GPU vs CPU parity on every fixture (IF-7.4: vello_cpu is the CI reference).
    for (const name of ['shapes', 'paints', 'layers', 'tiles']) {
      expectClose(report.images[`gpu-${name}`], cpu(name), RENDER_THRESHOLDS.gpuVsCpu, `gpu vs cpu: ${name}`);
    }
    // Text (B2): glyph runs drawn by Vello GPU match the vello_cpu golden (Latin, Arabic, Devanagari), and the
    // TypeScript pipeline in the browser (authoring Wasm layout → scene IR) draws the same pixels.
    expectClose(report.images['gpu-text'], cpu('text'), RENDER_THRESHOLDS.gpuVsCpu, 'gpu vs cpu: text');
    expectClose(report.images['ts-text'], cpu('text'), RENDER_THRESHOLDS.gpuVsCpu, 'ts pipeline vs cpu: text');
    expect(data.text.runs).toBeGreaterThanOrEqual(4);
    expect(data.text.fontFilesSent).toBe(4);
    // Tiles are seamless and a lifted layer over tiles equals the direct render.
    expectClose(report.images['tiled-z1'], report.images['gpu-tiles'], RENDER_THRESHOLDS.sameBackend, 'tiled vs region, zoom 1');
    expectClose(report.images['tiled-z2'], report.images['region-z2'], RENDER_THRESHOLDS.sameBackend, 'tiled vs region, zoom 2');
    expectClose(report.images['lifted-z1'], report.images['gpu-tiles'], RENDER_THRESHOLDS.sameBackend, 'lifted layer over tiles');

    // Tiled renderer on a canvas: sharp frame, drag through the lifted layer, recovery after a loss.
    expect(data.sharp).toBe(true);
    expectClose(report.images['renderer-sharp'], report.images['gpu-tiles'], RENDER_THRESHOLDS.sameBackend, 'renderer sharp frame');
    expect(data.dragTileBytesUnchanged).toBe(true);
    expectClose(report.images['renderer-drag'], report.images['expected-drag'], RENDER_THRESHOLDS.sameBackend, 'drag through the lifted layer');
    expect(data.recovery.ok).toBe(true);
    expect(data.sharpAfterLoss).toBe(true);
    expectClose(report.images['renderer-recovered'], report.images['gpu-tiles'], RENDER_THRESHOLDS.sameBackend, 'frame after device loss');
    expect(data.errors).toEqual([]);

    // Small goldens of the GPU output itself (catches backend drift that stays within gpuVsCpu).
    const goldens = createGoldenStore({ dir: new URL('./__goldens__', import.meta.url) });
    const thresholds = mode === 'real-gpu' ? RENDER_THRESHOLDS.gpuVsCpu : RENDER_THRESHOLDS.sameBackend;
    goldens.assert('render-gpu-shapes', report.images['gpu-shapes']!, thresholds);
    goldens.assert('render-gpu-layers', report.images['gpu-layers']!, thresholds);
    goldens.assert('render-gpu-text', report.images['gpu-text']!, thresholds);
  });
});
