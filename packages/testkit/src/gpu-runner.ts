/**
 * Real-GPU test runner (Node only): serve a directory with cross-origin isolation, open a page in
 * Chromium (Playwright), wait for the page to publish `globalThis.__sfGpuResult`, decode its images
 * and probe the WebGPU adapter. Returns a structured `GpuRunReport`.
 *
 * Modes:
 * - `swiftshader` (default; CI and this container): WebGPU on SwiftShader (CPU Vulkan) **plus ANGLE on
 *   SwiftShader**. Without `--use-angle=swiftshader --enable-unsafe-swiftshader`, the first
 *   `getCurrentTexture()` + submit on a canvas destroys the device ("lost: destroyed"); the S1 spike found
 *   this. Pixels are correct, timings are not GPU timings.
 * - `real-gpu` (`--real-gpu` on the CLI, `SF_GPU=real` for tests): only `--enable-unsafe-webgpu`; use on a
 *   machine with a GPU, usually with `headed: true`.
 *
 * Playwright is not a dependency: it is resolved at run time (`NODE_PATH` works, e.g.
 * `NODE_PATH=/opt/node-tools/node_modules`) or passed in as `launcher`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { AbortedError, err, ok, type Result, type SfError } from '@staticflux/core';
import { GpuPageFailedError, GpuPageTimeoutError, GpuRunnerUnavailableError } from './errors.js';
import { decodePageImage, GPU_RESULT_GLOBAL, type GpuPagePayload } from './gpu-readback.js';
import type { RgbaImage } from './image.js';

export type GpuRunMode = 'swiftshader' | 'real-gpu';

/** Chromium flags for WebGPU on SwiftShader with a working compositor (ANGLE on SwiftShader). */
export const SWIFTSHADER_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--disable-vulkan-surface',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
] as const;

export const REAL_GPU_FLAGS = ['--enable-unsafe-webgpu'] as const;

/** Chromium launch arguments for a mode. */
export function chromiumArgs(mode: GpuRunMode): readonly string[] {
  return mode === 'real-gpu' ? REAL_GPU_FLAGS : SWIFTSHADER_FLAGS;
}

/** Env var that enables GPU tests: unset/`0` → off, `1`/`swiftshader` → SwiftShader, `real`/`real-gpu` → real GPU. */
export const GPU_TESTS_ENV = 'SF_GPU';

/** The GPU test mode requested by `SF_GPU`, or `undefined` when GPU tests are off (use with `describe.skipIf`). */
export function gpuModeFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): GpuRunMode | undefined {
  const value = env[GPU_TESTS_ENV]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === '0' || value === 'false') return undefined;
  return value === 'real' || value === 'real-gpu' ? 'real-gpu' : 'swiftshader';
}

// ── Browser port (the slice of Playwright the runner uses) ───────────────────────────────────────

export interface ConsoleMessageLike {
  type(): string;
  text(): string;
}

export interface PageLike {
  on(event: 'console', listener: (message: ConsoleMessageLike) => void): unknown;
  on(event: 'pageerror', listener: (error: Error) => void): unknown;
  goto(url: string): Promise<unknown>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options: { timeout: number; polling: number }): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(options: { headless: boolean; args: string[] }): Promise<BrowserLike>;
}

/** Resolve Playwright's `chromium` (or `playwright-core`) from this package or `NODE_PATH`. */
export function loadPlaywrightChromium(from: string = import.meta.url): Result<BrowserLauncher, SfError> {
  const require = createRequire(from);
  const causes: unknown[] = [];
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const mod = require(name) as { chromium?: BrowserLauncher };
      if (mod.chromium !== undefined) return ok(mod.chromium);
    } catch (e) {
      causes.push(e);
    }
  }
  return err(GpuRunnerUnavailableError({ message: 'Playwright is not installed (looked for "playwright" and "playwright-core", including NODE_PATH).', cause: causes[0] }));
}

// ── Static server with cross-origin isolation ─────────────────────────────────────────────────────

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wgsl': 'text/plain',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Headers that make the page cross-origin isolated (SharedArrayBuffer, precise timers, OPFS sync handles). */
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

export interface IsolatedServer {
  /** `http://localhost:<port>` (localhost is a secure context, so WebGPU is exposed). */
  readonly origin: string;
  url(page: string): string;
  close(): Promise<void>;
}

/** Serve `root` on a free localhost port; requests outside `root` get 403, missing files 404. */
export function serveIsolated(root: string): Promise<IsolatedServer> {
  const base = resolve(root);
  const server: Server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    let file = resolve(join(base, pathname));
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...ISOLATION_HEADERS });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const origin = `http://localhost:${port}`;
      resolvePromise({
        origin,
        url: (page) => `${origin}/${page.replace(/^\/+/, '')}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// ── Runner ────────────────────────────────────────────────────────────────────────────────────────

export type GpuPageTarget = { readonly root: string; readonly page: string; readonly query?: string } | { readonly url: string };

export interface RunGpuPageOptions {
  readonly target: GpuPageTarget;
  readonly mode?: GpuRunMode;
  readonly headed?: boolean;
  /** Wait for the page's result at most this long. Default 120 s (SwiftShader is slow). */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Browser to use; default `loadPlaywrightChromium()`. */
  readonly launcher?: BrowserLauncher;
  /** Extra Chromium arguments (appended). */
  readonly extraArgs?: readonly string[];
}

export interface GpuAdapterSummary {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export interface ConsoleEntry {
  readonly type: string;
  readonly text: string;
}

export interface GpuRunReport {
  readonly mode: GpuRunMode;
  readonly url: string;
  readonly args: readonly string[];
  /** The adapter the page would get (`null`: no WebGPU or no adapter). */
  readonly adapter: GpuAdapterSummary | null;
  /** `data` from the page's payload. */
  readonly data: unknown;
  readonly images: Readonly<Record<string, RgbaImage>>;
  /** Console errors and warnings, in order. */
  readonly console: readonly ConsoleEntry[];
  /** Uncaught page errors (messages), in order. */
  readonly pageErrors: readonly string[];
}

const PROBED_LIMITS = ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize', 'maxColorAttachments'] as const;

/** Run one page and collect its result. Errors: SF-TEST-011 no browser, 012 page failure, 013 timeout, SF-CORE-002 aborted. */
export async function runGpuPage(options: RunGpuPageOptions): Promise<Result<GpuRunReport, SfError>> {
  const mode = options.mode ?? 'swiftshader';
  const timeoutMs = options.timeoutMs ?? 120_000;
  const signal = options.signal;
  if (isAborted(signal)) return err(AbortedError());
  const loaded = options.launcher === undefined ? loadPlaywrightChromium() : ok(options.launcher);
  if (!loaded.ok) return loaded;
  const launcher = loaded.value;
  const args = [...chromiumArgs(mode), ...(options.extraArgs ?? [])];
  let server: IsolatedServer | undefined;
  let browser: BrowserLike | undefined;
  const consoleEntries: ConsoleEntry[] = [];
  const pageErrors: string[] = [];
  const cleanup = async (): Promise<void> => {
    await browser?.close().catch(() => undefined);
    browser = undefined;
    await server?.close();
    server = undefined;
  };
  // Aborting closes the browser, which rejects whatever the page is waiting on.
  const listening = new AbortController();
  signal?.addEventListener('abort', () => void cleanup(), { once: true, signal: listening.signal });
  try {
    let url: string;
    if ('url' in options.target) url = options.target.url;
    else {
      server = await serveIsolated(options.target.root);
      const query = options.target.query;
      url = server.url(options.target.page) + (query !== undefined && query !== '' ? `?${query.replace(/^\?/, '')}` : '');
    }
    try {
      browser = await launcher.launch({ headless: options.headed !== true, args });
    } catch (e) {
      return err(GpuRunnerUnavailableError({ message: `Chromium failed to launch: ${String((e as Error).message ?? e)}`, cause: e, details: { args } }));
    }
    const page = await browser.newPage();
    page.on('console', (m) => {
      const type = m.type();
      if (type === 'error' || type === 'warning') consoleEntries.push({ type, text: m.text() });
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(url);
    try {
      await page.waitForFunction((key: string) => (globalThis as unknown as Record<string, unknown>)[key] !== undefined, GPU_RESULT_GLOBAL, { timeout: timeoutMs, polling: 100 });
    } catch (e) {
      if (isAborted(signal)) return err(AbortedError({ cause: e }));
      return err(GpuPageTimeoutError({ message: `The page did not publish ${GPU_RESULT_GLOBAL} within ${timeoutMs} ms.`, cause: e, details: { url, timeoutMs, console: consoleEntries, pageErrors } }));
    }
    const payload = await page.evaluate((key: string) => (globalThis as unknown as Record<string, unknown>)[key], GPU_RESULT_GLOBAL);
    const adapter = await page.evaluate(probeAdapter, PROBED_LIMITS as readonly string[]);
    return toReport(payload, { mode, url, args, adapter, console: consoleEntries, pageErrors });
  } catch (e) {
    if (isAborted(signal)) return err(AbortedError({ cause: e }));
    return err(GpuPageFailedError({ message: `GPU runner failed: ${String((e as Error).message ?? e)}`, cause: e, details: { console: consoleEntries, pageErrors } }));
  } finally {
    listening.abort();
    await cleanup();
  }
}

/** Validate a page payload and decode its images into a report. */
export function toReport(
  payload: unknown,
  context: { mode: GpuRunMode; url: string; args: readonly string[]; adapter: GpuAdapterSummary | null; console: readonly ConsoleEntry[]; pageErrors: readonly string[] },
): Result<GpuRunReport, SfError> {
  const details = { url: context.url, console: context.console, pageErrors: context.pageErrors };
  if (typeof payload !== 'object' || payload === null || typeof (payload as { ok?: unknown }).ok !== 'boolean') {
    return err(GpuPageFailedError({ message: `${GPU_RESULT_GLOBAL} must be { ok: boolean, … }.`, details: { ...details, payload } }));
  }
  const typed = payload as GpuPagePayload;
  if (!typed.ok) {
    const message = typeof typed.error?.message === 'string' ? typed.error.message : 'page reported ok: false';
    return err(GpuPageFailedError({ message: `GPU page failed: ${message}`, details: { ...details, message, code: typed.error?.code } }));
  }
  const images: Record<string, RgbaImage> = {};
  for (const [name, image] of Object.entries(typed.images ?? {})) {
    const decoded = decodePageImage(image, name);
    if (!decoded.ok) return err(GpuPageFailedError({ message: `GPU page published a malformed image "${name}": ${decoded.error.message}`, cause: decoded.error, details }));
    images[name] = decoded.value;
  }
  return ok({ mode: context.mode, url: context.url, args: context.args, adapter: context.adapter, data: typed.data, images, console: context.console, pageErrors: context.pageErrors });
}

/** Reads the flag through a call so TypeScript does not narrow it across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Runs in the page: summarize the adapter `navigator.gpu.requestAdapter()` returns. */
async function probeAdapter(limitNames: readonly string[]): Promise<GpuAdapterSummary | null> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu === undefined) return null;
  const adapter = (await gpu.requestAdapter()) as {
    info?: Record<string, unknown>;
    isFallbackAdapter?: boolean;
    features: Iterable<string>;
    limits: Record<string, number>;
  } | null;
  if (adapter === null) return null;
  const info = adapter.info ?? {};
  const limits: Record<string, number> = {};
  for (const name of limitNames) limits[name] = adapter.limits[name] ?? 0;
  return {
    vendor: String(info['vendor'] ?? ''),
    architecture: String(info['architecture'] ?? ''),
    device: String(info['device'] ?? ''),
    description: String(info['description'] ?? ''),
    isFallbackAdapter: Boolean(info['isFallbackAdapter'] ?? adapter.isFallbackAdapter ?? false),
    features: [...adapter.features].sort(),
    limits,
  };
}
