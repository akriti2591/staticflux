// Studio smoke scenario (B8, IF-27.25): open Studio, draw a rectangle, type text, create a milestone — in Chromium
// with WebGPU on SwiftShader (no GPU needed). Plain Node ESM; Playwright comes from NODE_PATH (preinstalled):
//
//   pnpm build && NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke
//
// Starts the Studio dev server (dev/studio/vite.config.ts) on a free port, drives the page by role and name (the
// same paths a person and a screen reader use), and checks the document through `window.__studio`. `--headed`
// shows the browser, `--screenshot=<file.png>` saves the final page; `SF_GPU=real` uses the real GPU instead of
// SwiftShader. Exit code 1 on failure.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [...(process.env.NODE_PATH ?? '').split(':').filter(Boolean), process.cwd()] }));

// Same flags as @staticflux/testkit's GPU runner (SWIFTSHADER_FLAGS).
const SWIFTSHADER = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const headed = process.argv.includes('--headed');
const screenshot = process.argv.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length);
const log = (m) => console.log(`[studio smoke] ${m}`);
const fail = (m) => {
  throw new Error(m);
};

const server = await createServer({ configFile: fileURLToPath(new URL('../../dev/studio/vite.config.ts', import.meta.url)), server: { port: 0 }, logLevel: 'warn' });
await server.listen();
const address = server.httpServer?.address();
const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 5174}/dev/studio/`;
const browser = await chromium.launch({ headless: !headed, args: process.env.SF_GPU === 'real' ? ['--enable-unsafe-webgpu'] : SWIFTSHADER });
let code = 0;
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : undefined));
  const studio = (fn, arg) => page.evaluate(fn, arg);
  log(`open ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__studio?.tab !== undefined || document.querySelector('[role="alert"]') !== null, null, { timeout: 120_000 });
  const boot = await page.locator('#boot[role="alert"]').count();
  if (boot > 0) fail(await page.locator('#boot').textContent());
  log('Studio is up (canvas tab open)');

  const surface = page.getByRole('application', { name: 'Canvas surface' });
  const box = await surface.boundingBox();
  if (box === null) fail('no canvas surface');
  const before = await page.screenshot({ clip: box });

  // 1. Draw a rectangle: Shape tool, drag on the canvas.
  await page.getByRole('button', { name: 'Shape' }).click();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45, { steps: 4 });
  await page.mouse.up();
  const rect = await studio(() => {
    const app = window.__studio;
    const node = app.tab.view.selection[0];
    return { node, kind: node === undefined ? undefined : app.document.view.read(node)?.kind, w: node === undefined ? 0 : app.document.view.value(node, 'spatial.w') };
  });
  if (rect.kind !== 'shape' || !(rect.w > 10)) fail(`no rectangle drawn: ${JSON.stringify(rect)}`);
  log(`rectangle ${rect.node} (${Math.round(rect.w)} wide)`);
  // The selection's actions mount (the spec's scope follows the selection).
  await page.getByRole('button', { name: 'Radial repeat' }).waitFor({ timeout: 20_000 });
  log('selection HUD mounted (Radial repeat)');

  // 2. Type text: Text tool, click on the page, type.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const now = (await surface.boundingBox()) ?? box;
  await page.mouse.click(now.x + now.width * 0.4, now.y + now.height * 0.65);
  await page.getByRole('textbox', { name: 'Text', exact: true }).waitFor({ timeout: 20_000 });
  await page.keyboard.type('Hello Studio');
  await page.waitForFunction(
    () => {
      const app = window.__studio;
      const editing = app.tab?.editing;
      return editing !== undefined && editing.session.state.model.text === 'Hello Studio';
    },
    null,
    { timeout: 20_000 },
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__studio.tab.text.nodes.length > 0, null, { timeout: 20_000 });
  const text = await studio(() => {
    const app = window.__studio;
    return app.tab.text.nodes.map((n) => app.document.view.value(n, 'spatial.w'));
  });
  if (text.length !== 1 || !(text[0] > 20)) fail(`no text element: ${JSON.stringify(text)}`);
  log('typed "Hello Studio"');

  // 3. Milestone: the top bar's Milestone button.
  await page.getByRole('button', { name: 'Milestone', exact: true }).click();
  await page.waitForFunction(() => window.__studio.spoken.some((m) => m.startsWith('Milestone created')), null, { timeout: 20_000 });
  log('milestone created');

  // The canvas drew something (GPU path on SwiftShader): its pixels changed.
  await page.waitForTimeout(1500);
  const after = await page.screenshot({ clip: box });
  if (Buffer.compare(before, after) === 0) fail('the canvas pixels did not change');
  log('canvas pixels changed');
  if (screenshot !== undefined) await page.screenshot({ path: screenshot });
  const relevant = errors.filter((e) => !/favicon/.test(e));
  if (relevant.length > 0) fail(`page errors:\n${relevant.join('\n')}`);
  log('PASS');
} catch (error) {
  code = 1;
  console.error(`[studio smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  // What Studio was doing (tool, selection, editing, the last messages it spoke).
  const state = await page
    ?.evaluate(() => {
      const app = window.__studio;
      const tab = app?.tab;
      const node = tab?.view.selection[0];
      return { tool: tab?.view.tool, selection: tab?.view.selection, kind: node && app.document.view.read(node)?.kind, editing: tab?.editing?.node, spoken: app?.spoken.slice(-5) };
    })
    .catch(() => undefined);
  console.error(`[studio smoke] state: ${JSON.stringify(state)}`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
