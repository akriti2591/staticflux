// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { err, ok } from '@staticflux/core';
import { afterEach, describe, expect, it } from 'vitest';
import { GpuPageFailedError } from './errors.js';
import { GPU_CLI_USAGE, gpuCliMain, parseGpuCliArgs } from './gpu-cli.js';
import type { GpuRunReport, RunGpuPageOptions } from './gpu-runner.js';
import { createImage } from './image.js';
import { decodePng } from './png.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseGpuCliArgs', () => {
  it('parses a directory target with defaults', () => {
    expect(parseGpuCliArgs(['fixtures/gpu-smoke'])).toEqual({ ok: true, value: { target: { root: resolve('fixtures/gpu-smoke'), page: 'index.html' }, mode: 'swiftshader', headed: false, timeoutMs: 120_000, out: undefined } });
  });

  it('parses every flag', () => {
    const r = parseGpuCliArgs(['web', 'bench.html', '--query=frames=120&variant=gpu', '--real-gpu', '--headed', '--timeout=30', '--out=results/run1']);
    expect(r).toEqual({ ok: true, value: { target: { root: resolve('web'), page: 'bench.html', query: 'frames=120&variant=gpu' }, mode: 'real-gpu', headed: true, timeoutMs: 30_000, out: 'results/run1' } });
    expect(parseGpuCliArgs(['--url=http://localhost:5173/gpu.html'])).toMatchObject({ ok: true, value: { target: { url: 'http://localhost:5173/gpu.html' } } });
  });

  it('rejects bad usage with SF-TEST-016', () => {
    for (const argv of [[], ['--timeout=0', 'x'], ['--nope', 'x'], ['a', 'b', 'c'], ['--url=http://x', 'dir'], ['--help']]) {
      expect(parseGpuCliArgs(argv)).toMatchObject({ ok: false, error: { code: 'SF-TEST-016' } });
    }
  });
});

describe('gpuCliMain', () => {
  const report: GpuRunReport = {
    mode: 'swiftshader',
    url: 'http://localhost:1/index.html',
    args: [],
    adapter: null,
    data: { presented: 2 },
    images: { 'triangle/main': createImage(2, 2, [255, 0, 0, 255]) },
    console: [],
    pageErrors: [],
  };

  it('prints a JSON report, writes PNGs and report.json with --out, exits 0', async () => {
    const out = mkdtempSync(join(tmpdir(), 'sf-gpu-cli-'));
    dirs.push(out);
    const stdout: string[] = [];
    let seen: RunGpuPageOptions | undefined;
    const code = await gpuCliMain(['web', '--real-gpu', `--out=${out}`], {
      stdout: (t) => stdout.push(t),
      stderr: () => undefined,
      run: async (options) => {
        seen = options;
        return ok(report);
      },
    });
    expect(code).toBe(0);
    expect(seen).toMatchObject({ mode: 'real-gpu', headed: false, timeoutMs: 120_000 });
    const printed = JSON.parse(stdout.join(''));
    expect(printed).toMatchObject({ ok: true, mode: 'swiftshader', data: { presented: 2 }, images: { 'triangle/main': { width: 2, height: 2, file: join(out, 'triangle_main.png') } } });
    const png = decodePng(new Uint8Array(readFileSync(join(out, 'triangle_main.png'))));
    expect(png.ok && png.value.width).toBe(2);
    expect(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))).toEqual(printed);
  });

  it('exits 1 with the error code on stderr when the run fails', async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const code = await gpuCliMain(['web'], { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t), run: async () => err(GpuPageFailedError({ message: 'GPU page failed: no adapter' })) });
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('SF-TEST-012: GPU page failed: no adapter');
    expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: false, error: { code: 'SF-TEST-012' } });
  });

  it('exits 2 with usage on bad arguments, without running', async () => {
    const stderr: string[] = [];
    let ran = false;
    const code = await gpuCliMain([], {
      stdout: () => undefined,
      stderr: (t) => stderr.push(t),
      run: async () => {
        ran = true;
        return ok(report);
      },
    });
    expect(code).toBe(2);
    expect(ran).toBe(false);
    expect(stderr.join('')).toContain(GPU_CLI_USAGE);
    expect(existsSync('report.json')).toBe(false);
  });
});
