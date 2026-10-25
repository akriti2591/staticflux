// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePageImage, GPU_RESULT_GLOBAL, type GpuPagePayload } from './gpu-readback.js';
import {
  chromiumArgs,
  gpuModeFromEnv,
  ISOLATION_HEADERS,
  loadPlaywrightChromium,
  REAL_GPU_FLAGS,
  runGpuPage,
  serveIsolated,
  SWIFTSHADER_FLAGS,
  toReport,
  type BrowserLauncher,
  type ConsoleMessageLike,
  type GpuAdapterSummary,
} from './gpu-runner.js';
import { createImage } from './image.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sf-gpu-runner-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>gpu</title>');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'index.html'), 'sub');
  writeFileSync(join(root, 'shader.wgsl'), '@compute fn main() {}');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function rawGet(url: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function rawStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

const ADAPTER: GpuAdapterSummary = { vendor: 'google', architecture: 'swiftshader', device: '', description: 'SwiftShader', isFallbackAdapter: true, features: [], limits: {} };

interface FakeBrowserScript {
  readonly payload?: GpuPagePayload | unknown;
  readonly console?: readonly [type: string, text: string][];
  readonly pageErrors?: readonly string[];
  readonly hang?: boolean;
  readonly launchError?: Error;
}

function fakeLauncher(script: FakeBrowserScript): BrowserLauncher & { launches: { headless: boolean; args: string[] }[]; visited: string[]; closed: number } {
  const state = { launches: [] as { headless: boolean; args: string[] }[], visited: [] as string[], closed: 0 };
  return {
    ...state,
    get launches() {
      return state.launches;
    },
    get visited() {
      return state.visited;
    },
    get closed() {
      return state.closed;
    },
    async launch(options) {
      state.launches.push(options);
      if (script.launchError) throw script.launchError;
      const consoleListeners: ((m: ConsoleMessageLike) => void)[] = [];
      const errorListeners: ((e: Error) => void)[] = [];
      let evaluations = 0;
      return {
        async newPage() {
          return {
            on(event: 'console' | 'pageerror', listener: ((m: ConsoleMessageLike) => void) | ((e: Error) => void)) {
              if (event === 'console') consoleListeners.push(listener as (m: ConsoleMessageLike) => void);
              else errorListeners.push(listener as (e: Error) => void);
            },
            async goto(url: string) {
              state.visited.push(url);
              for (const [type, text] of script.console ?? []) for (const l of consoleListeners) l({ type: () => type, text: () => text });
              for (const message of script.pageErrors ?? []) for (const l of errorListeners) l(new Error(message));
            },
            async waitForFunction<A>(_fn: (arg: A) => unknown, arg: A, options: { timeout: number }) {
              expect(arg).toBe(GPU_RESULT_GLOBAL);
              if (script.hang) {
                await new Promise((r) => setTimeout(r, 5));
                throw new Error(`Timeout ${options.timeout}ms exceeded.`);
              }
            },
            async evaluate<R, A>(_fn: (arg: A) => R | Promise<R>): Promise<R> {
              evaluations++;
              return (evaluations === 1 ? script.payload : ADAPTER) as R;
            },
          };
        },
        async close() {
          state.closed++;
        },
      };
    },
  };
}

describe('flags and modes', () => {
  it('uses SwiftShader + ANGLE flags by default and only --enable-unsafe-webgpu on a real GPU', () => {
    expect(SWIFTSHADER_FLAGS).toEqual([
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader',
      '--disable-vulkan-surface',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ]);
    expect(chromiumArgs('swiftshader')).toBe(SWIFTSHADER_FLAGS);
    expect(chromiumArgs('real-gpu')).toEqual(REAL_GPU_FLAGS);
  });

  it('reads SF_GPU', () => {
    expect(gpuModeFromEnv({})).toBeUndefined();
    expect(gpuModeFromEnv({ SF_GPU: '' })).toBeUndefined();
    expect(gpuModeFromEnv({ SF_GPU: '0' })).toBeUndefined();
    expect(gpuModeFromEnv({ SF_GPU: 'false' })).toBeUndefined();
    expect(gpuModeFromEnv({ SF_GPU: '1' })).toBe('swiftshader');
    expect(gpuModeFromEnv({ SF_GPU: 'swiftshader' })).toBe('swiftshader');
    expect(gpuModeFromEnv({ SF_GPU: 'real' })).toBe('real-gpu');
    expect(gpuModeFromEnv({ SF_GPU: ' Real-GPU ' })).toBe('real-gpu');
  });

  it('loadPlaywrightChromium returns a launcher or SF-TEST-011', () => {
    const r = loadPlaywrightChromium();
    if (r.ok) expect(typeof r.value.launch).toBe('function');
    else expect(r.error.code).toBe('SF-TEST-011');
    const missing = loadPlaywrightChromium(join(root, 'nowhere.js'));
    expect(missing.ok || missing.error.code === 'SF-TEST-011').toBe(true);
  });
});

describe('serveIsolated', () => {
  it('serves files with cross-origin isolation headers, directories as index.html, 404 and 403', async () => {
    const server = await serveIsolated(root);
    try {
      expect(server.origin).toMatch(/^http:\/\/localhost:\d+$/);
      expect(server.url('/index.html')).toBe(`${server.origin}/index.html`);
      const page = await rawGet(server.url('index.html?x=1'));
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      for (const [name, value] of Object.entries(ISOLATION_HEADERS)) expect(page.headers[name.toLowerCase()]).toBe(value);
      expect((await rawGet(server.url('sub/'))).body).toBe('sub');
      expect((await rawGet(server.url('shader.wgsl'))).headers['content-type']).toBe('text/plain');
      expect((await rawGet(server.url('missing.js'))).status).toBe(404);
      // A raw path: URL parsing on the client would normalize `..` away before sending.
      const port = Number(new URL(server.origin).port);
      for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) expect(await rawStatus(port, path)).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe('toReport', () => {
  const context = { mode: 'swiftshader' as const, url: 'http://x/', args: [], adapter: null, console: [], pageErrors: ['boom'] };

  it('decodes images and passes data through', () => {
    const image = createImage(2, 1, [1, 2, 3, 4]);
    const r = toReport({ ok: true, data: { frames: 2 }, images: { triangle: encodePageImage(image) } }, context);
    expect(r.ok && r.value.images['triangle']).toEqual({ width: 2, height: 1, data: image.data });
    expect(r.ok && r.value.data).toEqual({ frames: 2 });
    expect(r.ok && r.value.pageErrors).toEqual(['boom']);
  });

  it('turns ok: false, malformed payloads and bad images into SF-TEST-012', () => {
    expect(toReport({ ok: false, error: { message: 'no adapter', code: 'X' } }, context)).toMatchObject({ ok: false, error: { code: 'SF-TEST-012', message: 'GPU page failed: no adapter', details: { code: 'X' } } });
    expect(toReport({ ok: false }, context)).toMatchObject({ ok: false, error: { details: { message: 'page reported ok: false' } } });
    expect(toReport('done', context)).toMatchObject({ ok: false, error: { code: 'SF-TEST-012' } });
    expect(toReport(null, context)).toMatchObject({ ok: false, error: { code: 'SF-TEST-012' } });
    expect(toReport({ ok: true, images: { bad: { width: 2, height: 2, rgba: btoa('x') } } }, context)).toMatchObject({ ok: false, error: { code: 'SF-TEST-012' } });
  });
});

describe('runGpuPage (fake browser)', () => {
  it('serves the root, launches headless with the mode flags and returns a structured report', async () => {
    const launcher = fakeLauncher({
      payload: { ok: true, data: { lost: false }, images: { frame: encodePageImage(createImage(1, 1, [9, 8, 7, 255])) } },
      console: [
        ['log', 'ignored'],
        ['warning', 'slow shader'],
        ['error', 'oops'],
      ],
      pageErrors: ['uncaught'],
    });
    const r = await runGpuPage({ target: { root, page: 'index.html', query: '?frames=3' }, launcher, extraArgs: ['--foo'] });
    if (!r.ok) throw r.error;
    expect(launcher.launches).toEqual([{ headless: true, args: [...SWIFTSHADER_FLAGS, '--foo'] }]);
    expect(launcher.visited[0]).toMatch(/^http:\/\/localhost:\d+\/index\.html\?frames=3$/);
    expect(r.value).toMatchObject({ mode: 'swiftshader', adapter: ADAPTER, data: { lost: false }, pageErrors: ['uncaught'] });
    expect(r.value.console).toEqual([
      { type: 'warning', text: 'slow shader' },
      { type: 'error', text: 'oops' },
    ]);
    expect(r.value.images['frame']?.data).toEqual(Uint8Array.of(9, 8, 7, 255));
    expect(launcher.closed).toBe(1);
  });

  it('runs a URL target headed on a real GPU', async () => {
    const launcher = fakeLauncher({ payload: { ok: true } });
    const r = await runGpuPage({ target: { url: 'http://localhost:5173/gpu.html' }, mode: 'real-gpu', headed: true, launcher });
    expect(r.ok && r.value.mode).toBe('real-gpu');
    expect(launcher.launches[0]).toEqual({ headless: false, args: [...REAL_GPU_FLAGS] });
    expect(launcher.visited).toEqual(['http://localhost:5173/gpu.html']);
  });

  it('reports a page that never publishes as SF-TEST-013 with diagnostics', async () => {
    const launcher = fakeLauncher({ hang: true, pageErrors: ['ReferenceError: device is not defined'] });
    const r = await runGpuPage({ target: { url: 'http://localhost:1/x.html' }, launcher, timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, error: { code: 'SF-TEST-013', details: { timeoutMs: 50, pageErrors: ['ReferenceError: device is not defined'] } } });
    expect(launcher.closed).toBe(1);
  });

  it('reports page failures (SF-TEST-012) and launch failures (SF-TEST-011)', async () => {
    const failed = await runGpuPage({ target: { url: 'http://localhost:1/' }, launcher: fakeLauncher({ payload: { ok: false, error: { message: 'device lost: destroyed' } } }) });
    expect(failed).toMatchObject({ ok: false, error: { code: 'SF-TEST-012', message: 'GPU page failed: device lost: destroyed' } });
    const noBrowser = await runGpuPage({ target: { url: 'http://localhost:1/' }, launcher: fakeLauncher({ launchError: new Error('Executable does not exist') }) });
    expect(noBrowser).toMatchObject({ ok: false, error: { code: 'SF-TEST-011', message: 'Chromium failed to launch: Executable does not exist' } });
  });

  it('honours an already-aborted signal and aborts mid-run (browser closed)', async () => {
    const pre = new AbortController();
    pre.abort();
    expect(await runGpuPage({ target: { url: 'http://localhost:1/' }, signal: pre.signal, launcher: fakeLauncher({}) })).toMatchObject({ ok: false, error: { code: 'SF-CORE-002' } });
    const controller = new AbortController();
    const launcher = fakeLauncher({ hang: true });
    const run = runGpuPage({ target: { root, page: 'index.html' }, signal: controller.signal, launcher });
    setTimeout(() => controller.abort(), 1);
    expect(await run).toMatchObject({ ok: false, error: { code: 'SF-CORE-002' } });
    expect(launcher.closed).toBeGreaterThanOrEqual(1);
  });
});
