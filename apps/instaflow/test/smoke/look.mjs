// Dev helper (B11b): open Studio, draw a rectangle, and save screenshots for a visual check. Not part of CI.
//   NODE_PATH=/opt/node-tools/node_modules node apps/instaflow/test/smoke/look.mjs <out-prefix> [steps]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [...(process.env.NODE_PATH ?? '').split(':').filter(Boolean), process.cwd()] }));
const SWIFTSHADER = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const out = process.argv[2] ?? 'look';
const server = await createServer({ configFile: fileURLToPath(new URL('../../dev/studio/vite.config.ts', import.meta.url)), server: { port: 0 }, logLevel: 'warn' });
await server.listen();
const address = server.httpServer?.address();
const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 5174}/dev/studio/`;
const browser = await chromium.launch({ headless: true, args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : undefined));
try {
  await page.goto(base);
  await page.waitForFunction(() => window.__studio?.tab !== undefined || document.querySelector('[role="alert"]') !== null, null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}-1-open.png` });
  const surface = page.getByRole('application', { name: 'Canvas surface' });
  const box = await surface.boundingBox();
  await page.getByRole('button', { name: 'Rectangle' }).click();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}-2-selected.png` });
  console.log(JSON.stringify(await page.evaluate(() => ({ toasted: window.__studio.toasted, spoken: window.__studio.spoken.slice(-5) }))));
} catch (e) {
  console.error(e);
  await page.screenshot({ path: `${out}-fail.png` }).catch(() => undefined);
}
console.log(errors.join('\n'));
await browser.close();
await server.close();
