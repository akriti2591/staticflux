// Home smoke scenario (C0 IF-28.29), in Chromium with WebGPU on SwiftShader (no GPU needed). Plain Node ESM;
// Playwright comes from NODE_PATH (preinstalled):
//
//   pnpm build && NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke:home
//
// One fresh browser profile: open Home (no worker, no Wasm, no GPU adapter requested; the accessibility audit passes;
// recents are empty), start "New design" from the keyboard, land in Studio on an empty document, draw one shape, go
// back Home with the logo, see the design in "Jump back in", reopen it and find the shape. Starts the dev server
// (dev/studio/vite.config.ts) on a free port and drives the pages by role and name. Options: `--headed`,
// `--screenshot=<prefix>` (Home before and after), `SF_GPU=real`. Studio boots in its default topology (the
// Studio smoke covers both). Exit code 1 on failure.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [...(process.env.NODE_PATH ?? '').split(':').filter(Boolean), process.cwd()] }));

// Same flags as @staticflux/testkit's GPU runner (SWIFTSHADER_FLAGS).
const SWIFTSHADER = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const headed = process.argv.includes('--headed');
const screenshot = process.argv.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length);
/** The testkit's dependency-free accessibility audit, loaded into the page from source by the dev server. */
const AUDIT = `/@fs${fileURLToPath(new URL('../../../../packages/testkit/src/a11y.ts', import.meta.url))}`;

const log = (m) => console.log(`[home smoke] ${m}`);
const fail = (m) => {
  throw new Error(m);
};

const server = await createServer({ configFile: fileURLToPath(new URL('../../dev/studio/vite.config.ts', import.meta.url)), server: { port: 0 }, logLevel: 'warn' });
await server.listen();
const address = server.httpServer?.address();
const origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 5174}`;
const browser = await chromium.launch({ headless: !headed, args: process.env.SF_GPU === 'real' ? ['--enable-unsafe-webgpu'] : SWIFTSHADER });

/** Count GPU adapter requests in every page and worker of the context (Home must make none). */
const COUNT_GPU = () => {
  const gpu = globalThis.navigator?.gpu;
  globalThis.__gpuRequests = 0;
  if (gpu === undefined) return;
  const request = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = (...args) => {
    globalThis.__gpuRequests += 1;
    return request(...args);
  };
};

async function homeReady(page) {
  await page.waitForFunction(() => window.__home?.model.state === 'ready' || document.querySelector('#boot[role="alert"]') !== null, null, { timeout: 30_000 });
  if ((await page.locator('#boot[role="alert"]').count()) > 0) fail(await page.locator('#boot').textContent());
}

async function studioReady(page) {
  await page.waitForFunction(() => window.__studio?.tab !== undefined || document.querySelector('#boot[role="alert"]') !== null, null, { timeout: 120_000 });
  if ((await page.locator('#boot[role="alert"]').count()) > 0) fail(await page.locator('#boot').textContent());
}

const inspect = (page, nodes) =>
  page.evaluate(async (n) => {
    const r = await window.__studio.inspect(n);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, nodes);

async function audit(page) {
  return page.evaluate(async (path) => {
    const { auditA11y } = await import(path);
    return auditA11y(document.body).map((i) => `${i.rule}: ${i.message}`);
  }, AUDIT);
}

/** Tab from the top of the page until the focused element (through shadow roots) matches `test`. */
async function tabTo(page, test, what, limit = 40) {
  await page.keyboard.press('Tab');
  for (let i = 0; i < limit; i++) {
    const hit = await page.evaluate((source) => {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      // eslint-disable-next-line no-new-func
      return new Function('el', `return (${source})(el)`)(el);
    }, test.toString());
    if (hit) return;
    await page.keyboard.press('Tab');
  }
  fail(`could not reach ${what} with Tab`);
}

async function scenario(page) {
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : undefined));
  page.on('worker', (w) => {
    requests.push(`worker ${w.url()}`);
    w.on('console', (m) => (m.type() === 'error' ? errors.push(`worker: ${m.text()}`) : undefined));
  });
  page.on('request', (r) => requests.push(r.url()));

  // ---------------------------------------------------------------- Home: light boot, empty workspace
  log(`open ${origin}/`);
  await page.goto(`${origin}/`);
  await homeReady(page);
  await page.getByRole('heading', { level: 1, name: /Make something\s+bold\s+today/ }).waitFor({ timeout: 10_000 });
  await page.getByText('No designs yet').waitFor({ timeout: 10_000 });
  const engine = requests.filter((u) => /\.wasm|studio\.worker|loro|engine\/dist|^worker /.test(u));
  if (engine.length > 0) fail(`Home loaded engine code: ${engine.join(', ')}`);
  const gpu = await page.evaluate(() => globalThis.__gpuRequests);
  if (gpu !== 0) fail(`Home requested a GPU adapter ${gpu} time(s)`);
  log(`Home is up (${requests.length} requests, no worker, no Wasm, no GPU adapter); recents empty`);
  const issues = await audit(page);
  if (issues.length > 0) fail(`accessibility audit:\n${issues.join('\n')}`);
  log('accessibility audit passes (empty workspace)');
  if (screenshot !== undefined) await page.screenshot({ path: `${screenshot}-home-empty.png`, fullPage: true });

  // ---------------------------------------------------------------- New design, from the keyboard
  // B11b (HOME-FILES §1.3): the New design dialog — Custom, W × H typed, a name, Enter creates.
  await tabTo(page, (el) => el?.localName === 'sf-button' && /New design/.test(el.textContent ?? ''), 'New design');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New design' });
  await dialog.waitFor({ timeout: 10_000 }).catch(() => fail('New design opened no dialog'));
  const dialogIssues = await audit(page);
  if (dialogIssues.length > 0) fail(`accessibility audit (New design dialog):\n${dialogIssues.join('\n')}`);
  await dialog.getByRole('radio', { name: /^Custom/ }).click();
  const width = dialog.getByRole('spinbutton', { name: 'Width' });
  await width.fill('1500');
  await width.press('Tab');
  const height = dialog.getByRole('spinbutton', { name: 'Height' });
  await height.fill('500');
  await height.press('Tab');
  const name = dialog.getByRole('textbox', { name: 'Name' });
  await name.fill('Smoke banner');
  await name.press('Enter');
  await page.waitForURL(/\/s\/as_[a-z0-9]+(\?|$)/, { timeout: 60_000 });
  await studioReady(page);
  const asset = new URL(page.url()).pathname.split('/').pop();
  const plan = await page.evaluate(() => window.__studio.workers.plan.topology);
  const empty = await inspect(page);
  if (empty.elements.length !== 0) fail(`a new design should be empty: ${JSON.stringify(empty.elements)}`);
  const made = await page.evaluate(() => ({ page: window.__studio.scene.page, title: window.__studio.scene.title }));
  if (made.page?.width !== 1500 || made.page?.height !== 500 || made.title !== 'Smoke banner') fail(`New design made ${JSON.stringify(made)} (want Smoke banner, 1500 × 500)`);
  const studioGpu = await page.evaluate(() => globalThis.__gpuRequests);
  log(`New design dialog (Custom 1500 × 500, "Smoke banner", Enter) → Studio on ${asset} (${plan}), empty document of that size`);

  // ---------------------------------------------------------------- draw one shape
  const surface = page.getByRole('application', { name: 'Canvas surface' });
  const box = await surface.boundingBox();
  if (box === null) fail('no canvas surface');
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.47, box.y + box.height * 0.42, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__studio.tab?.view.selection.length === 1, null, { timeout: 10_000 });
  const shape = await page.evaluate(() => window.__studio.tab.view.selection[0]);
  const drawn = (await inspect(page, [shape])).elements[0];
  if (drawn?.kind !== 'shape' || !(drawn.w > 10)) fail(`no shape drawn: ${JSON.stringify(drawn)}`);
  log(`drew shape ${shape} (${Math.round(drawn.w)}×${Math.round(drawn.h)})`);

  // ---------------------------------------------------------------- back Home: the design is in recents
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/`, { timeout: 30_000 });
  await homeReady(page);
  const recents = page.getByRole('region', { name: 'Jump back in' });
  const tile = recents.getByRole('link', { name: /Smoke banner/ });
  await tile.waitFor({ timeout: 10_000 });
  const listed = await page.evaluate(() => window.__home.model.recents().map((e) => e.asset));
  if (listed[0] !== asset) fail(`recents should start with ${asset}: ${JSON.stringify(listed)}`);
  const issuesAfter = await audit(page);
  if (issuesAfter.length > 0) fail(`accessibility audit with recents:\n${issuesAfter.join('\n')}`);
  log(`back Home (logo link): "${(await recents.locator('sf-card').first().textContent())?.replace(/\s+/g, ' ').trim()}" in Jump back in; audit passes`);
  if (screenshot !== undefined) await page.screenshot({ path: `${screenshot}-home-recents.png`, fullPage: true });

  // ---------------------------------------------------------------- reopen it
  await tile.click();
  await page.waitForURL(new RegExp(`/s/${asset}(\\?|$)`), { timeout: 60_000 });
  await studioReady(page);
  const reopened = await inspect(page);
  const again = reopened.elements.find((e) => e.id === shape);
  if (reopened.elements.length !== 1 || again === undefined || Math.abs(again.x - drawn.x) > 0.01 || Math.abs(again.w - drawn.w) > 0.01) {
    fail(`the reopened design lost its shape: ${JSON.stringify({ drawn, reopened: reopened.elements })}`);
  }
  log(`reopened ${asset} from recents: shape ${shape} is there (${Math.round(again.w)}×${Math.round(again.h)})`);
  if (!(studioGpu > 0)) log('note: Studio made no GPU adapter request through navigator.gpu on main (the render worker owns the device)');

  const relevant = errors.filter((e) => !/favicon/.test(e));
  if (relevant.length > 0) fail(`page errors:\n${relevant.join('\n')}`);
  log('PASS');
}

let code = 0;
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(COUNT_GPU);
const page = await context.newPage();
try {
  await scenario(page);
} catch (error) {
  code = 1;
  console.error(`[home smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  if (screenshot !== undefined) await page.screenshot({ path: `${screenshot}-fail.png`, fullPage: true }).catch(() => undefined);
} finally {
  await context.close();
}
await browser.close();
await server.close();
process.exit(code);
