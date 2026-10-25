#!/usr/bin/env node
/**
 * `sf-gpu-run` — run a GPU test page in Chromium and print a JSON report (root script `pnpm gpu:run`).
 *
 *   sf-gpu-run <dir> [page.html] [--query=a=1&b=2] [--real-gpu] [--headed] [--timeout=<s>] [--out=<dir>]
 *   sf-gpu-run --url=http://localhost:5173/gpu.html [--real-gpu] …
 *
 * Default mode is SwiftShader + ANGLE (correct pixels, CPU timings). `--real-gpu` drops the SwiftShader
 * flags; use it on a machine with a GPU (usually with `--headed`). `--out` writes each published image as
 * `<out>/<name>.png` and the report as `<out>/report.json`. Exit codes: 0 ok, 1 run failed, 2 usage.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { GpuCliUsageError } from './errors.js';
import { runGpuPage, type GpuPageTarget, type GpuRunMode, type GpuRunReport, type RunGpuPageOptions } from './gpu-runner.js';
import { encodePng } from './png.js';

export interface GpuCliOptions {
  readonly target: GpuPageTarget;
  readonly mode: GpuRunMode;
  readonly headed: boolean;
  readonly timeoutMs: number;
  readonly out: string | undefined;
}

export const GPU_CLI_USAGE =
  'usage: sf-gpu-run <dir> [page.html] [--query=…] [--real-gpu] [--headed] [--timeout=<seconds>] [--out=<dir>]\n' +
  '       sf-gpu-run --url=<http url> [--real-gpu] [--headed] [--timeout=<seconds>] [--out=<dir>]';

function usage(message: string): Result<never, SfError> {
  return err(GpuCliUsageError({ message }));
}

/** Parse CLI arguments (without `node` and the script path). Errors: SF-TEST-016. */
export function parseGpuCliArgs(argv: readonly string[]): Result<GpuCliOptions, SfError> {
  const positional: string[] = [];
  let mode: GpuRunMode = 'swiftshader';
  let headed = false;
  let timeoutMs = 120_000;
  let out: string | undefined;
  let url: string | undefined;
  let query: string | undefined;
  for (const arg of argv) {
    if (arg === '--real-gpu') mode = 'real-gpu';
    else if (arg === '--headed') headed = true;
    else if (arg.startsWith('--timeout=')) {
      const seconds = Number(arg.slice('--timeout='.length));
      if (!(seconds > 0)) return usage(`--timeout must be a positive number of seconds (got "${arg}")`);
      timeoutMs = seconds * 1000;
    } else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg.startsWith('--url=')) url = arg.slice('--url='.length);
    else if (arg.startsWith('--query=')) query = arg.slice('--query='.length);
    else if (arg === '--help' || arg === '-h') return usage('help requested');
    else if (arg.startsWith('--')) return usage(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  let target: GpuPageTarget;
  if (url !== undefined) {
    if (positional.length > 0) return usage('pass either --url or <dir> [page], not both');
    target = { url };
  } else {
    const [root, page = 'index.html', ...rest] = positional;
    if (root === undefined) return usage('missing <dir>');
    if (rest.length > 0) return usage(`unexpected arguments: ${rest.join(' ')}`);
    target = query === undefined ? { root: resolve(root), page } : { root: resolve(root), page, query };
  }
  return ok({ target, mode, headed, timeoutMs, out });
}

export interface GpuCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Runner to use (tests inject one); default `runGpuPage`. */
  readonly run?: (options: RunGpuPageOptions) => Promise<Result<GpuRunReport, SfError>>;
}

/** Run the CLI; resolves to the exit code. */
export async function gpuCliMain(argv: readonly string[], io: GpuCliIo): Promise<number> {
  const parsed = parseGpuCliArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error.message}\n${GPU_CLI_USAGE}\n`);
    return 2;
  }
  const options = parsed.value;
  const result = await (io.run ?? runGpuPage)({ target: options.target, mode: options.mode, headed: options.headed, timeoutMs: options.timeoutMs });
  if (!result.ok) {
    io.stderr(`${result.error.code}: ${result.error.message}\n${result.error.fix ?? ''}\n`);
    io.stdout(`${JSON.stringify({ ok: false, error: result.error.toJSON() }, null, 2)}\n`);
    return 1;
  }
  const report = result.value;
  const images: Record<string, { width: number; height: number; file?: string }> = {};
  if (options.out !== undefined) mkdirSync(options.out, { recursive: true });
  for (const [name, image] of Object.entries(report.images)) {
    const entry: { width: number; height: number; file?: string } = { width: image.width, height: image.height };
    if (options.out !== undefined) {
      entry.file = join(options.out, `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.png`);
      writeFileSync(entry.file, encodePng(image));
    }
    images[name] = entry;
  }
  const summary = { ok: true, mode: report.mode, url: report.url, adapter: report.adapter, data: report.data, images, console: report.console, pageErrors: report.pageErrors };
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (options.out !== undefined) writeFileSync(join(options.out, 'report.json'), json);
  io.stdout(json);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void gpuCliMain(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }).then((code) => {
    process.exitCode = code;
  });
}
