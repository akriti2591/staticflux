// Studio smoke scenarios (B8 IF-27.25; B9 IF-33.20–33.26), in Chromium with WebGPU on SwiftShader (no GPU needed), in
// **both topologies** (one worker, two workers). Plain Node ESM; Playwright comes from NODE_PATH (preinstalled):
//
//   pnpm build && NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke
//
// Per topology: B8's scenario (draw a rectangle, type text, create a milestone) and B9's must-pass steps — select,
// move, resize and rotate by pointer; the overlay matches the content during a paused drag (pixels and the editor's
// state); the tab hidden then visible keeps its state and draws again; lens switch and page switch; IME composition
// through Chrome's IME path (CDP) on Studio's text host with character bounds inside the text box.
//
// Starts the Studio dev server (dev/studio/vite.config.ts) on a free port, drives the page by role and name (the same
// paths a person and a screen reader use), and reads the editor through `window.__studio.inspect()`. Options:
// `--headed`, `--screenshot=<prefix>` (one PNG per topology), `--topology=colocated|split` (default both),
// `SF_GPU=real` (the real GPU instead of SwiftShader). Exit code 1 on failure.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [...(process.env.NODE_PATH ?? '').split(':').filter(Boolean), process.cwd()] }));

// Same flags as @staticflux/testkit's GPU runner (SWIFTSHADER_FLAGS).
const SWIFTSHADER = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const headed = process.argv.includes('--headed');
const screenshot = process.argv.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length);
const only = process.argv.find((a) => a.startsWith('--topology='))?.slice('--topology='.length);
const TOPOLOGIES = only === undefined ? ['colocated', 'split'] : [only];
/** Studio's brand primary (`@primary`, the Shape tool's fill) and Clean Pop's accent (the selection overlay). */
const TANGERINE = [0xff, 0x5c, 0x39];

let topology = '';
const log = (m) => console.log(`[studio smoke:${topology}] ${m}`);
const fail = (m) => {
  throw new Error(m);
};
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

const server = await createServer({ configFile: fileURLToPath(new URL('../../dev/studio/vite.config.ts', import.meta.url)), server: { port: 0 }, logLevel: 'warn' });
await server.listen();
const address = server.httpServer?.address();
const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 5174}/dev/studio/`;
const browser = await chromium.launch({ headless: !headed, args: process.env.SF_GPU === 'real' ? ['--enable-unsafe-webgpu'] : SWIFTSHADER });

/** Bounding box (CSS px, page coordinates) of the pixels close to `rgb` in a screenshot of `clip`. */
async function colourBox(page, clip, rgb, tolerance = 40) {
  const shot = await page.screenshot({ clip });
  // Decoded in the page (no PNG decoder in Node without dependencies).
  return page.evaluate(
      async ({ data, clip, rgb, tolerance }) => {
        const img = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, img.width, img.height).data;
        const sx = clip.width / img.width;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let y = 0; y < img.height; y++)
          for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * 4;
            if (Math.abs(px[i] - rgb[0]) + Math.abs(px[i + 1] - rgb[1]) + Math.abs(px[i + 2] - rgb[2]) > tolerance) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        return minX === Infinity ? undefined : { x: clip.x + minX * sx, y: clip.y + minY * sx, w: (maxX - minX + 1) * sx, h: (maxY - minY + 1) * sx };
      },
    { data: [...shot], clip, rgb, tolerance },
  );
}

async function scenario(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : undefined));
  page.on('worker', (w) => w.on('console', (m) => (m.type() === 'error' ? errors.push(`worker: ${m.text()}`) : undefined)));
  const url = `${base}?topology=${topology}`;
  log(`open ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__studio?.tab !== undefined || document.querySelector('[role="alert"]') !== null, null, { timeout: 120_000 });
  const boot = await page.locator('#boot[role="alert"]').count();
  if (boot > 0) fail(await page.locator('#boot').textContent());
  const plan = await page.evaluate(() => window.__studio.workers.plan);
  if (plan.topology !== topology) fail(`booted ${plan.topology}, wanted ${topology}`);
  log(`Studio is up: ${plan.workers.map((w) => `${w.name}[${w.roles.join('+')}]`).join(' ')}, modules on ${plan.media.modules}, input on ${plan.media.input}`);

  const inspect = (nodes) => page.evaluate(async (n) => {
    const r = await window.__studio.inspect(n);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, nodes);
  const surface = page.getByRole('application', { name: 'Canvas surface' });
  const box = await surface.boundingBox();
  if (box === null) fail('no canvas surface');
  const before = await page.screenshot({ clip: box });
  /** Element box in page (screen) coordinates from the editor's state and camera. */
  const screenBox = async (node) => {
    const box = await surface.boundingBox(); // the surface moves when the selection HUD mounts
    const s = await inspect([node]);
    const e = s.elements[0];
    const c = s.view.camera;
    return { x: box.x + e.x * c.zoom + c.tx, y: box.y + e.y * c.zoom + c.ty, w: e.w * c.zoom, h: e.h * c.zoom, rotation: e.rotation, e };
  };
  const waitSettled = async () => {
    await page.waitForFunction(() => window.__studio.view?.gesture === 'idle', null, { timeout: 10_000 });
    await page.waitForTimeout(150);
  };

  // ---------------------------------------------------------------- B8: draw a rectangle
  await page.getByRole('button', { name: 'Shape' }).click();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.38, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__studio.tab?.view.selection.length === 1, null, { timeout: 10_000 });
  const rect = await page.evaluate(() => window.__studio.tab.view.selection[0]);
  const drawn = (await inspect([rect])).elements[0];
  if (drawn?.kind !== 'shape' || !(drawn.w > 10)) fail(`no rectangle drawn: ${JSON.stringify(drawn)}`);
  log(`rectangle ${rect} (${Math.round(drawn.w)} wide)`);
  await page.getByRole('button', { name: 'Radial repeat' }).waitFor({ timeout: 20_000 });
  log('selection HUD mounted (Radial repeat)');
  await waitSettled();

  // ---------------------------------------------------------------- select, move (overlay vs content), resize, rotate
  await page.mouse.click(box.x + 8, box.y + box.height - 8); // empty canvas: clears the selection
  await page.waitForFunction(() => window.__studio.tab.view.selection.length === 0, null, { timeout: 10_000 });
  let r0 = await screenBox(rect);
  await page.mouse.click(r0.x + r0.w / 2, r0.y + r0.h / 2);
  await page.waitForFunction((n) => window.__studio.tab.view.selection.join() === n, rect, { timeout: 10_000 });
  log('select by click');

  const dx = 60;
  const dy = 40;
  await page.mouse.move(r0.x + r0.w / 2, r0.y + r0.h / 2);
  await page.mouse.down();
  await page.keyboard.down('Control'); // no snapping while dragging (no guides in the picture)
  await page.mouse.move(r0.x + r0.w / 2 + dx / 2, r0.y + r0.h / 2 + dy / 2, { steps: 3 });
  await page.mouse.move(r0.x + r0.w / 2 + dx, r0.y + r0.h / 2 + dy, { steps: 3 });
  await page.waitForFunction(() => window.__studio.view?.gesture === 'move', null, { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1500); // SwiftShader: let every tile of the paused drag finish
  const mid = await screenBox(rect);
  const frame = (await inspect([rect])).frame;
  const tangerine = await colourBox(page, await surface.boundingBox(), TANGERINE);
  if (tangerine === undefined) fail('no shape pixels during the drag');
  // Content and overlay: the tangerine box is the shape plus its frame and handles (≈ 6 px beyond the edges); an
  // overlay one frame behind would stretch it by the drag distance.
  const margin = 9;
  if (!(near(tangerine.x, mid.x, margin) && near(tangerine.y, mid.y, margin) && near(tangerine.x + tangerine.w, mid.x + mid.w, margin) && near(tangerine.y + tangerine.h, mid.y + mid.h, margin))) {
    fail(`overlay and content disagree during the drag: pixels ${JSON.stringify(tangerine)} vs element ${JSON.stringify(mid)}`);
  }
  if (frame === undefined || !near(frame[0][0], mid.e.x, 0.5) || !near(frame[0][1], mid.e.y, 0.5)) fail(`the selection frame does not follow the drag: ${JSON.stringify({ frame, element: mid.e })}`);
  log(`overlay matches content during the drag (pixels ${Math.round(tangerine.w)}×${Math.round(tangerine.h)} at ${Math.round(tangerine.x - box.x)},${Math.round(tangerine.y - box.y)})`);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await waitSettled();
  const moved = await screenBox(rect);
  if (!near(moved.x - r0.x, dx, 4) || !near(moved.y - r0.y, dy, 4)) fail(`move: ${JSON.stringify({ from: r0, to: moved })}`);
  log(`move by pointer (${Math.round(moved.x - r0.x)}, ${Math.round(moved.y - r0.y)})`);

  r0 = moved;
  await page.mouse.move(r0.x + r0.w, r0.y + r0.h); // the bottom-right resize handle
  await page.mouse.down();
  await page.mouse.move(r0.x + r0.w + 30, r0.y + r0.h + 20, { steps: 5 });
  await page.mouse.up();
  await waitSettled();
  const resized = await screenBox(rect);
  if (!(resized.w > r0.w + 15) || !(resized.h > r0.h + 10)) fail(`resize: ${JSON.stringify({ from: r0, to: resized })}`);
  log(`resize by handle (${Math.round(r0.w)}×${Math.round(r0.h)} → ${Math.round(resized.w)}×${Math.round(resized.h)})`);

  // Rotate: the zone just outside the top-right corner, dragged around the centre.
  const cx = resized.x + resized.w / 2;
  const cy = resized.y + resized.h / 2;
  const corner = [resized.x + resized.w, resized.y];
  const out = Math.hypot(corner[0] - cx, corner[1] - cy);
  const start = [corner[0] + ((corner[0] - cx) / out) * 10, corner[1] + ((corner[1] - cy) / out) * 10];
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  const a0 = Math.atan2(start[1] - cy, start[0] - cx);
  for (let i = 1; i <= 6; i++) {
    const a = a0 + (i / 6) * (Math.PI / 4);
    await page.mouse.move(cx + Math.cos(a) * (out + 10), cy + Math.sin(a) * (out + 10));
  }
  await page.mouse.up();
  await waitSettled();
  const rotated = await screenBox(rect);
  if (!(Math.abs(rotated.rotation) > 20)) fail(`rotate: rotation ${rotated.rotation}`);
  log(`rotate by the corner zone (${Math.round(rotated.rotation)}°)`);

  // ---------------------------------------------------------------- B8: type text
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7);
  await page.getByRole('textbox', { name: 'Text', exact: true }).waitFor({ timeout: 20_000 });
  await page.keyboard.type('Hello Studio');
  await page.waitForFunction(async () => (await window.__studio.inspect()).value?.editing?.text === 'Hello Studio', null, { timeout: 20_000, polling: 100 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(async () => (await window.__studio.inspect()).value?.textNodes.length === 1 && window.__studio.tab.editing === undefined, null, { timeout: 20_000, polling: 100 });
  const textNode = (await inspect()).textNodes[0];
  const text = (await inspect([textNode])).elements[0];
  if (!(text?.w > 20)) fail(`no text element: ${JSON.stringify(text)}`);
  log('typed "Hello Studio"');

  // ---------------------------------------------------------------- IME on Studio's text host (CDP)
  // Select it first (the selection's HUD row changes the surface's place), then double click on the glyphs.
  const t0 = await screenBox(textNode);
  await page.mouse.click(t0.x + t0.w / 2, t0.y + t0.h / 2);
  await page.waitForFunction((n) => window.__studio.tab.view.selection.join() === n, textNode, { timeout: 10_000 });
  await page.waitForTimeout(800);
  const t = await screenBox(textNode);
  await page.mouse.dblclick(t.x + t.w / 2, t.y + t.h / 2);
  await page.locator('[data-if-text-host][role="textbox"]').waitFor({ timeout: 20_000 }); // named after the element
  await page.keyboard.press('End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(400);
  const during = await page.evaluate(() => {
    const h = window.__studio.canvas.text?.host;
    const ec = h?.editContext;
    const bounds = ec?.characterBounds?.() ?? [];
    return { kind: ec === undefined || ec === null ? 'hidden-textarea' : 'edit-context', bounds: [...bounds].map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })), editing: window.__studio.tab?.editing?.node };
  });
  await cdp.send('Input.insertText', { text: '日本語' });
  await page.waitForFunction(async () => (await window.__studio.inspect()).value?.editing?.text?.includes('日本語') === true, null, { timeout: 20_000, polling: 100 });
  const tb = await screenBox(textNode);
  const inside = (r) => r.x >= tb.x - 4 && r.y >= tb.y - 4 && r.x + r.w <= tb.x + tb.w + 40 && r.y + r.h <= tb.y + tb.h + 8;
  if (during.kind === 'edit-context') {
    if (during.bounds.length === 0) fail('IME: no character bounds reached the EditContext');
    if (!during.bounds.every(inside)) fail(`IME: character bounds outside the text box: ${JSON.stringify({ bounds: during.bounds, box: tb })}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__studio.tab.editing === undefined, null, { timeout: 20_000 });
  log(`IME composition committed through the worker (${during.kind}, ${during.bounds.length} character bounds inside the box)`);

  // ---------------------------------------------------------------- B8: milestone
  await page.getByRole('button', { name: 'Milestone', exact: true }).click();
  await page.waitForFunction(() => window.__studio.spoken.some((m) => m.startsWith('Milestone created')), null, { timeout: 20_000 });
  log('milestone created');

  // ---------------------------------------------------------------- tab hidden, then visible
  const state = async () => {
    const s = await inspect();
    return JSON.stringify({ page: s.view.page, selection: s.view.selection, elements: s.elements.map((e) => [e.id, e.kind, Math.round(e.x), Math.round(e.y), Math.round(e.w), Math.round(e.h), Math.round(e.rotation)]) });
  };
  const kept = await state();
  // Hidden: the page reports `hidden` and is frozen (CDP lifecycle: no tasks run, as in a background tab); then active
  // and visible again.
  const lifecycle = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
  await new Promise((r) => setTimeout(r, 1500));
  await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(800);
  if ((await state()) !== kept) fail(`state changed while hidden: ${kept} → ${await state()}`);
  const drawsBefore = (await page.evaluate(async () => (await window.__studio.metrics()).value?.render?.draws)) ?? 0;
  await surface.focus();
  await page.keyboard.press('Escape'); // a canvas shortcut (through the ring): clears the selection, the overlay redraws
  await page.waitForFunction(() => window.__studio.tab.view.selection.length === 0, null, { timeout: 10_000 });
  await page.waitForFunction(async (n) => ((await window.__studio.metrics()).value?.render?.draws ?? 0) > n, drawsBefore, { timeout: 10_000, polling: 100 });
  log('hidden then visible: state kept, drawing again');

  // ---------------------------------------------------------------- lens switch and page switch
  await page.getByRole('radio', { name: 'Pages' }).click();
  await page.waitForFunction(() => window.__studio.studio.lens?.id === 'instaflow/lens-pages', null, { timeout: 10_000 });
  await page.getByRole('tab', { name: 'Pages' }).click().catch(() => undefined);
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.waitForFunction(() => window.__studio.tab?.page === 'p2', null, { timeout: 20_000 });
  if ((await inspect()).elements.length !== 0) fail('page 2 should be empty');
  await page.getByRole('button', { name: 'Previous page' }).click();
  await page.waitForFunction(() => window.__studio.tab?.page === 'p1', null, { timeout: 20_000 });
  const back = await inspect();
  if (!back.elements.some((e) => e.id === rect) || back.textNodes.length !== 1) fail(`page 1 lost its elements: ${JSON.stringify(back.elements.map((e) => e.id))}`);
  await page.getByRole('radio', { name: 'Canvas' }).click();
  await page.waitForFunction(() => window.__studio.studio.lens?.id === 'instaflow/lens-canvas', null, { timeout: 10_000 });
  log('lens switch (Canvas → Pages → Canvas) and page switch (p1 → p2 → p1)');

  // The canvas drew something (GPU path on SwiftShader): its pixels changed.
  await page.waitForTimeout(1500);
  const after = await page.screenshot({ clip: box });
  if (Buffer.compare(before, after) === 0) fail('the canvas pixels did not change');
  log('canvas pixels changed');
  const metrics = await page.evaluate(async () => (await window.__studio.metrics()).value);
  log(`frame metrics: ${metrics.render?.draws} draws, ${metrics.render?.holds} holds, latency ${JSON.stringify(metrics.render?.latency ?? null)}, ${metrics.editor?.inputs} inputs in ${metrics.editor?.batches} batches`);
  if (screenshot !== undefined) await page.screenshot({ path: `${screenshot}-${topology}.png` });
  const relevant = errors.filter((e) => !/favicon/.test(e));
  if (relevant.length > 0) fail(`page errors:\n${relevant.join('\n')}`);
  log('PASS');
}

let code = 0;
for (topology of TOPOLOGIES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await scenario(page);
  } catch (error) {
    code = 1;
    console.error(`[studio smoke:${topology}] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    // What Studio was doing (tool, selection, editing, the last messages it spoke).
    const s = await page
      .evaluate(() => {
        const app = window.__studio;
        return { view: app?.view, editing: app?.tab?.editing, spoken: app?.spoken.slice(-5) };
      })
      .catch(() => undefined);
    console.error(`[studio smoke:${topology}] state: ${JSON.stringify(s)}`);
    if (screenshot !== undefined) await page.screenshot({ path: `${screenshot}-${topology}-fail.png` }).catch(() => undefined);
  } finally {
    await page.close();
  }
}
await browser.close();
await server.close();
process.exit(code);
