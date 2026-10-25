/**
 * Real-browser test runner (Node; run directly with Node's type stripping):
 *
 *   node tooling/browser-test/src/run.ts [--only=<substring>] [--headed] [--timeout=<s>] [files…]
 *
 * 1. Starts a Vite dev server at the repo root (TypeScript served from source,
 *    `@staticflux/*` aliased to `packages/<pkg>/src` like vitest.config.ts,
 *    module workers supported, COOP/COEP headers set).
 * 2. Launches Chromium through Playwright.
 * 3. Each `packages/<pkg>/src/**\/*.browser.ts` loads in a fresh browser
 *    context; its `describe`/`it` tests run in the page (see index.ts).
 * 4. Each `**\/*.scenario.ts` is imported in Node and its `scenario(ctx)` run.
 *
 * Exit code 1 when anything fails.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import type { ScenarioContext, SuiteResult } from './index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packagesDir = join(repoRoot, 'packages');

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const filter = flag('only');
const headed = args.includes('--headed');
const timeoutMs = Number(flag('timeout') ?? 300) * 1000;
const explicit = args.filter((a) => !a.startsWith('--')).map((a) => resolve(a));

function discover(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.browser.ts') || name.endsWith('.scenario.ts')) out.push(path);
    }
  };
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // package without src
    }
  }
  return out.sort();
}

const html = (entry: string, run: boolean): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>sf browser test</title></head><body>
<script type="module">
${
  run
    ? `import { runRegistered } from '/tooling/browser-test/src/index.ts';
try { await import(${JSON.stringify(entry)}); window.__sfResults = await runRegistered(); }
catch (e) { window.__sfResults = { tests: [], error: String((e && e.stack) || e) }; }`
    : `import(${JSON.stringify(entry)}).catch((e) => { window.__sfPageError = String((e && e.stack) || e); console.error(e); });`
}
</script></body></html>`;

function harnessPlugin(): Plugin {
  return {
    name: 'sf-browser-test',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/__sf/suite' && url.pathname !== '/__sf/page') return next();
        const entry = url.searchParams.get(url.pathname === '/__sf/suite' ? 'file' : 'entry') ?? '';
        if (!entry.startsWith('/packages/') || entry.includes('..')) {
          res.statusCode = 400;
          res.end('bad entry');
          return;
        }
        res.setHeader('content-type', 'text/html');
        res.end(html(entry, url.pathname === '/__sf/suite'));
      });
    },
  };
}

async function startServer(): Promise<{ server: ViteDevServer; baseUrl: string }> {
  const server = await createServer({
    root: repoRoot,
    configFile: false,
    logLevel: 'warn',
    clearScreen: false,
    appType: 'custom',
    plugins: [harnessPlugin()],
    resolve: {
      alias: [
        { find: /^@staticflux\/browser-test$/, replacement: join(repoRoot, 'tooling/browser-test/src/index.ts') },
        { find: /^@staticflux\/([^/]+)\/(.+)$/, replacement: `${packagesDir}/$1/src/$2.ts` },
        { find: /^@staticflux\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      watch: null,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') throw new Error('vite did not report a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function repoPath(file: string): string {
  return `/${relative(repoRoot, file).split('\\').join('/')}`;
}

async function main(): Promise<number> {
  const files = (explicit.length > 0 ? explicit : discover()).filter((f) => filter === undefined || f.includes(filter));
  if (files.length === 0) {
    console.log('browser-test: no *.browser.ts or *.scenario.ts files matched.');
    return 0;
  }
  const { server, baseUrl } = await startServer();
  // Several pages share a context in scenarios; without these switches background tabs get 1 Hz timers.
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  let failed = 0;
  let passed = 0;
  try {
    for (const file of files) {
      const rel = repoPath(file);
      const started = Date.now();
      if (file.endsWith('.browser.ts')) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        let result: SuiteResult;
        try {
          await page.goto(`${baseUrl}/__sf/suite?file=${encodeURIComponent(rel)}`);
          await page.waitForFunction(() => (window as unknown as { __sfResults?: unknown }).__sfResults !== undefined, null, { timeout: timeoutMs, polling: 100 });
          result = (await page.evaluate(() => (window as unknown as { __sfResults: SuiteResult }).__sfResults)) as SuiteResult;
        } catch (error) {
          result = { tests: [], error: `${String(error)}\n${errors.join('\n')}` };
        }
        await context.close();
        console.log(`\n${rel}  (${Date.now() - started} ms)`);
        if (result.error !== undefined) {
          failed += 1;
          console.log(`  ✗ suite failed to run\n${indent(result.error)}`);
        }
        for (const test of result.tests) {
          if (test.ok) passed += 1;
          else failed += 1;
          console.log(`  ${test.ok ? '✓' : '✗'} ${test.name}${test.ok ? '' : `\n${indent(test.error ?? '')}`}`);
        }
        if (result.tests.length === 0 && result.error === undefined) {
          failed += 1;
          console.log('  ✗ no tests registered');
        }
      } else {
        const ctx: ScenarioContext = {
          browser,
          newContext: () => browser.newContext(),
          pageUrl: (entry, query = {}) => `${baseUrl}/__sf/page?${new URLSearchParams({ entry, ...query }).toString()}`,
          log: (message) => console.log(`    ${message}`),
          env: process.env,
        };
        console.log(`\n${rel}`);
        try {
          const mod = (await import(pathToFileURL(file).href)) as { scenario?: (c: ScenarioContext) => Promise<void> };
          if (typeof mod.scenario !== 'function') throw new Error('a *.scenario.ts file must export `scenario(ctx)`');
          await mod.scenario(ctx);
          passed += 1;
          console.log(`  ✓ scenario passed (${Date.now() - started} ms)`);
        } catch (error) {
          failed += 1;
          console.log(`  ✗ scenario failed\n${indent(error instanceof Error ? (error.stack ?? error.message) : String(error))}`);
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`\nbrowser-test: ${passed} passed, ${failed} failed (Chromium ${browser.version()})`);
  return failed === 0 ? 0 : 1;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
