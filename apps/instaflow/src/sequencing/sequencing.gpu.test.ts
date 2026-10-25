// @vitest-environment node
/**
 * The sequencing bench page in real Chromium (off unless SF_GPU is set: `pnpm test:gpu`, or
 * `SF_GPU=real pnpm test:gpu` on a machine with a GPU). Builds the page, runs both topologies and the
 * main-rAF tick with the WebGPU quads port, and asserts oracle correctness. Latency is reported, never
 * asserted (SwiftShader timings are CPU timings; real-GPU latency is decided on the owner's machine).
 */
import { gpuModeFromEnv, runGpuPage } from '@staticflux/testkit/node';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mode = gpuModeFromEnv();
const here = dirname(fileURLToPath(import.meta.url));
const benchDir = join(here, '..', '..', 'bench', 'sequencing');

describe.skipIf(mode === undefined)(`sequencing bench page (${mode ?? 'off'})`, () => {
  it.each(['topology=colocated', 'topology=split', 'topology=split&tick=main-raf'])('%s: every presented frame equals the oracle', { timeout: 600_000 }, async (config) => {
    const { build } = await import('vite');
    await build({ configFile: join(benchDir, 'vite.config.ts'), logLevel: 'warn' });
    const run = await runGpuPage({ target: { root: join(benchDir, 'dist'), page: 'index.html', query: `gfx=webgpu&gestures=150&elements=2000&${config}` }, mode: mode!, timeoutMs: 540_000 });
    if (!run.ok) throw run.error;
    const data = run.value.data as { correctness: { pass: boolean; firstBad: unknown }; latency: unknown };
    console.info(config, JSON.stringify(data.latency));
    expect(run.value.pageErrors).toEqual([]);
    expect(data.correctness.pass, JSON.stringify(data.correctness.firstBad)).toBe(true);
  });
});
