/**
 * Real Chromium (Playwright): handle channel and shared-memory pipes with real
 * platform objects — `VideoFrame`, `AudioData`, `ImageBitmap`, `OffscreenCanvas`
 * (transferred) and an OPFS `FileSystemDirectoryHandle` (cloned) — between a page
 * and a module worker, plus a SharedArrayBuffer delta stream across them. Node has
 * none of these objects; the contract suites use duck-typed fakes.
 *
 * Skipped when Playwright is not installed (it resolves `playwright` from NODE_PATH
 * or /opt/node-tools/node_modules). A tiny cross-origin-isolated server transpiles the
 * workspace TypeScript on the fly; module workers get no import maps, so bare
 * specifiers are rewritten to served paths.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixtures = join(root, 'packages', 'worker', 'test', 'browser');

interface Playwright {
  chromium: {
    launch(options: { args?: string[] }): Promise<{
      newPage(): Promise<{
        goto(url: string): Promise<unknown>;
        waitForFunction(fn: string, arg: unknown, options: { timeout: number }): Promise<unknown>;
        evaluate<T>(fn: string): Promise<T>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

function loadPlaywright(): Playwright | undefined {
  const bases = [...(process.env['NODE_PATH']?.split(':') ?? []), '/opt/node-tools/node_modules'].filter((b) => b.length > 0);
  for (const base of bases) {
    try {
      return createRequire(join(base, 'noop.js'))('playwright') as Playwright;
    } catch {
      // try the next location
    }
  }
  return undefined;
}

const playwright = loadPlaywright();

function rewrite(source: string): string {
  return source.replace(/(from\s*|import\s*\(\s*)(['"])(@staticflux\/[^'"]+|mobx)\2/g, (_match, lead: string, quote: string, specifier: string) => {
    if (specifier === 'mobx') return `${lead}${quote}/mod/mobx.js${quote}`;
    const [, pkg, sub] = /^@staticflux\/([^/]+)(?:\/(.+))?$/.exec(specifier) ?? [];
    return `${lead}${quote}/pkg/${pkg}/src/${sub ?? 'index'}.js${quote}`;
  });
}

function mobxSource(): string {
  const require = createRequire(join(root, 'packages', 'core', 'package.json'));
  const pkgPath = require.resolve('mobx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { module?: string };
  const file = join(dirname(pkgPath), pkg.module ?? 'dist/mobx.esm.js');
  return `const process = { env: { NODE_ENV: 'development' } };\n${readFileSync(file, 'utf8')}`;
}

function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, {
        'content-type': type,
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store',
      });
      res.end(body);
    };
    try {
      if (path === '/') return send(200, 'text/html', '<!doctype html><script type="module" src="/fixture/handles-page.js"></script>');
      if (path === '/mod/mobx.js') return send(200, 'text/javascript', mobxSource());
      if (path.startsWith('/fixture/')) {
        const file = normalize(join(fixtures, path.slice('/fixture/'.length)));
        if (!file.startsWith(fixtures)) return send(403, 'text/plain', 'forbidden');
        return send(200, 'text/javascript', readFileSync(file, 'utf8'));
      }
      const pkg = /^\/pkg\/([^/]+)\/src\/(.+)\.js$/.exec(path);
      if (pkg !== null) {
        const file = normalize(join(root, 'packages', pkg[1] as string, 'src', `${pkg[2] as string}.ts`));
        if (!file.startsWith(join(root, 'packages'))) return send(403, 'text/plain', 'forbidden');
        const output = ts.transpileModule(readFileSync(file, 'utf8'), {
          fileName: file,
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true, useDefineForClassFields: true },
        });
        return send(200, 'text/javascript', rewrite(output.outputText));
      }
      return send(404, 'text/plain', 'not found');
    } catch (error) {
      return send(500, 'text/plain', String(error));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

describe.skipIf(playwright === undefined)('pipeline in real Chromium (page ↔ module worker)', () => {
  let server: Server | undefined;
  let url = '';
  beforeAll(async () => {
    ({ server, url } = await serve());
  });
  afterAll(() => {
    server?.close();
  });

  it('moves real handles with ownership accounting and runs a shared delta stream', async () => {
    const browser = await (playwright as Playwright).chromium.launch({ args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction('window.__result !== undefined', undefined, { timeout: 30_000 });
      const result = await page.evaluate<Record<string, unknown>>('window.__result');
      expect(result['error']).toBeUndefined();
      expect(result['isolated']).toBe(true);
      expect(result['classified']).toEqual({
        frame: 'video-frame',
        audio: 'audio-data',
        bitmap: 'image-bitmap',
        canvas: 'offscreen-canvas',
        directory: 'file-system-handle',
      });
      expect(result['sent']).toBe(true);
      expect(result['released']).toEqual([true, true, true, true, true]);
      expect(result['useAfterSend']).toBe('SF-WK-037');
      // Transferred objects are detached on the sender; the directory handle was cloned and stays usable.
      expect(result['after']).toEqual({ bitmapWidth: 0, frameFormat: null, audioFormat: null, directoryName: '' });
      expect(result['senderTotals']).toMatchObject({ owned: 5, sent: 5, leaked: 0 });
      const received = result['received'] as { arrived: { kind: string; classified: string; width: number | null }[]; live: Record<string, number>; totals: Record<string, number> };
      expect(received.arrived.map((a) => [a.kind, a.classified, a.width])).toEqual([
        ['video-frame', 'video-frame', 16],
        ['audio-data', 'audio-data', 128],
        ['image-bitmap', 'image-bitmap', 4],
        ['offscreen-canvas', 'offscreen-canvas', 8],
        ['file-system-handle', 'file-system-handle', null],
      ]);
      expect(received.live).toEqual({ 'video-frame': 1, 'audio-data': 1, 'image-bitmap': 1, 'offscreen-canvas': 1, 'file-system-handle': 1 });
      expect(received.totals).toMatchObject({ received: 5, closed: 5, leaked: 0 });
      expect(result['stream']).toEqual({ version: 200, state: 'live', sum: 20_100, medium: 'shared' });
    } finally {
      await browser.close();
    }
  }, 60_000);
});
