/**
 * @staticflux/testkit/node — Node-only render testing: PNG codec, golden snapshots on disk, and the
 * real-GPU runner (Chromium via Playwright, SwiftShader or a real GPU). Import from Node test files
 * only (`// @vitest-environment node` when the default environment is a DOM).
 */
export * from './png.js';
export * from './golden.js';
export * from './gpu-runner.js';
export { gpuCliMain, parseGpuCliArgs, GPU_CLI_USAGE, type GpuCliOptions, type GpuCliIo } from './gpu-cli.js';
