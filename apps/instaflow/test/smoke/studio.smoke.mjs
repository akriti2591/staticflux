// Studio smoke scenarios (B8 IF-27.25; B9 IF-33.20–33.26), in Chromium with WebGPU on SwiftShader (no GPU needed), in
// **both topologies** (one worker, two workers). Plain Node ESM; Playwright comes from NODE_PATH (preinstalled):
//
//   pnpm build && NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke
//
// Per topology: B8's scenario (draw a rectangle, type text, create a milestone) and B9's must-pass steps — select,
// move, resize and rotate by pointer; the overlay matches the content during a paused drag (pixels and the editor's
// state); the tab hidden then visible keeps its state and draws again; lens switch and page switch; IME composition
// through Chrome's IME path (CDP) on Studio's text host with character bounds inside the text box.
// B10a (IF-34.21): flip (Shift+H twice is the identity), skew (Mod+Shift-drag the top handle of the rotated element:
// 15° steps), a numeric-bar edit (W typed + Enter) and transform mode (Mod+T: Escape cancels the session, Enter
// applies a nudge and a flip as one undo step).
// C1 (IF-29.26): the Export panel exports PNG (2×, the page), PDF (all pages) and SVG (the page) to the downloads, in
// the export worker; the files are checked (PNG: signature, size, decoded pixels with the shape's colour; PDF: header,
// page count, the typed text extractable with `pdftotext` when poppler is installed; SVG: root, page box, text
// labelled), the export Wasm is fetched only once a PDF is asked for (lazy), and the document gained nothing (D10).
//
// Starts the Studio dev server (dev/studio/vite.config.ts) on a free port, drives the page by role and name (the same
// paths a person and a screen reader use), and reads the editor through `window.__studio.inspect()`. Options:
// `--headed`, `--screenshot=<prefix>` (one PNG per topology), `--topology=colocated|split` (default both),
// `SF_GPU=real` (the real GPU instead of SwiftShader). Exit code 1 on failure.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
/** B11c: a 16 × 16 mint PNG the image steps place and fill with. */
const MINT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNg2FxHGhrVMKph+GoAAKheMRByqYQhAAAAAElFTkSuQmCC';

let topology = '';
const log = (m) => console.log(`[studio smoke:${topology}] ${m}`);
const fail = (m) => {
  throw new Error(m);
};
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
/**
 * `page.waitForFunction` for **async** predicates (they read `window.__studio.inspect()`): Playwright does not await a
 * Promise the predicate returns, it is truthy, so such a wait ended at once (FIX-TEXT-FIRST-KEY: the typing check passed
 * on "ello StudioH" and the failure surfaced only in the PDF). Polls `fn(arg)` in the page until it resolves truthy.
 */
async function waitAsync(page, fn, arg, { timeout = 10_000, polling = 100 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > until) fail(`timed out after ${timeout} ms waiting for: ${String(fn).replace(/\s+/g, ' ').slice(0, 200)}`);
    await page.waitForTimeout(polling);
  }
}

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
  page.on('pageerror', (e) => errors.push(`${e.message} ${(e.stack ?? '').split('\n').slice(1, 4).join(' ')}`));
  page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : undefined));
  page.on('worker', (w) => w.on('console', (m) => (m.type() === 'error' ? errors.push(`worker: ${m.text()}`) : undefined)));
  // C1: requests for the export Wasm (the page's and its workers'), to show it loads only for an SVG or PDF export.
  const exportWasm = [];
  page.on('request', (r) => (/\/export\.[^/]*\.wasm(\?|$)/.test(r.url()) ? exportWasm.push(r.url()) : undefined));
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
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
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
  const hud = page.getByRole('toolbar', { name: 'Selection actions' });
  await hud.getByRole('button', { name: 'Fill', exact: true }).waitFor({ timeout: 20_000 });
  log('selection pill shows the shape controls (Fill, Stroke, Radius, Duplicate, Delete, More)');
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

  // ---------------------------------------------------------------- B10a: flip, skew, numeric bar, transform mode
  /** Page point → screen point (the surface moves when the selection HUD mounts). */
  const toScreen = async ([px, py]) => {
    const b = await surface.boundingBox();
    const c = (await inspect()).view.camera;
    return [b.x + px * c.zoom + c.tx, b.y + py * c.zoom + c.ty];
  };
  // Undo depth counts durable commits: flush Latest first (the workspace store is IndexedDB since C0, so durability
  // trails the edit by a few milliseconds).
  const undoDepth = async () => {
    await page.evaluate(async () => {
      const r = await window.__studio.flush();
      if (!r.ok) throw new Error(r.error.message);
    });
    return (await inspect()).undo;
  };
  const el = async () => (await inspect([rect])).elements[0];
  // Flip (Shift+H on the focused canvas): along the element's own axes, so the rotation stays; twice restores it.
  await surface.focus();
  const u0 = await undoDepth();
  await page.keyboard.press('Shift+H');
  await waitAsync(page, async (n) => (await window.__studio.inspect([n])).value?.elements[0]?.flipX === true, rect, { timeout: 10_000, polling: 100 });
  const flipped = await el();
  if (!near(flipped.rotation, rotated.rotation, 0.01) || !near(flipped.x, rotated.e.x, 0.01) || (await undoDepth()) !== u0 + 1) fail(`flip: ${JSON.stringify({ before: rotated.e, after: flipped, undo: [u0, await undoDepth()] })}`);
  await page.keyboard.press('Shift+H');
  await waitAsync(page, async (n) => (await window.__studio.inspect([n])).value?.elements[0]?.flipX === false, rect, { timeout: 10_000, polling: 100 });
  const unflipped = await el();
  if (!near(unflipped.x, rotated.e.x, 0.01) || !near(unflipped.y, rotated.e.y, 0.01) || !near(unflipped.w, rotated.e.w, 0.01)) fail(`flip twice is not the identity: ${JSON.stringify({ before: rotated.e, after: unflipped })}`);
  log(`flip horizontal and back (Shift+H twice: flipX on, then off; rotation ${Math.round(flipped.rotation)}° kept; one undo step each)`);

  // Skew: Mod-drag the top side handle of the rotated element along its top edge; Shift snaps to 15° steps.
  const corners = (await inspect([rect])).frame;
  const topMid = await toScreen([(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2]);
  const tl = await toScreen(corners[0]);
  const tr = await toScreen(corners[1]);
  const len = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const along = [(tr[0] - tl[0]) / len, (tr[1] - tl[1]) / len];
  const u1 = await undoDepth();
  await page.mouse.move(topMid[0], topMid[1]);
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(topMid[0] + along[0] * 8 * i, topMid[1] + along[1] * 8 * i);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await waitSettled();
  const skewed = await el();
  if (!(Math.abs(skewed.skewX) > 5) || !near(skewed.skewX / 15, Math.round(skewed.skewX / 15), 1e-6) || (await undoDepth()) !== u1 + 1) fail(`skew: ${JSON.stringify({ skewed, undo: [u1, await undoDepth()] })}`);
  log(`skew by Mod-dragging the top handle of a rotated element (${Math.round(skewed.skewX)}°, snapped to 15° with Shift; one undo step)`);

  // Numeric transform (B11b: the inspector's Transform section): type a width, Enter applies it as one undo step.
  const bar = page.locator('if-inspector');
  const width = bar.getByRole('spinbutton', { name: 'W', exact: true });
  await width.waitFor({ timeout: 20_000 });
  const u2 = await undoDepth();
  await width.fill('150');
  await width.press('Enter');
  await waitAsync(page, async (n) => Math.abs(((await window.__studio.inspect([n])).value?.elements[0]?.w ?? 0) - 150) < 0.01, rect, { timeout: 10_000, polling: 100 });
  if ((await undoDepth()) !== u2 + 1) fail(`numeric bar: ${u2} → ${await undoDepth()} undo steps`);
  log('inspector Transform: W = 150 typed and applied (one undo step)');

  // Transform mode: Mod+T, steps are previews; Escape cancels the whole session, Enter applies it as one undo step.
  await surface.focus();
  const session0 = await el();
  const u3 = await undoDepth();
  await page.keyboard.press('Control+T');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.transform?.mode === 'active', null, { timeout: 10_000, polling: 100 });
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(key);
  await waitAsync(page, async ([n, y]) => Math.abs(((await window.__studio.inspect([n])).value?.elements[0]?.y ?? 0) - y - 1) < 0.01, [rect, session0.y], { timeout: 10_000, polling: 100 });
  await page.keyboard.press('Escape');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.transform?.mode === 'idle', null, { timeout: 10_000, polling: 100 });
  const cancelled = await el();
  if (!near(cancelled.x, session0.x, 0.01) || !near(cancelled.y, session0.y, 0.01) || (await undoDepth()) !== u3 || (await page.evaluate(() => window.__studio.tab.view.selection.length)) !== 1) fail(`transform mode Escape: ${JSON.stringify({ session0, cancelled, undo: [u3, await undoDepth()] })}`);
  await page.keyboard.press('Control+T');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.transform?.mode === 'active', null, { timeout: 10_000, polling: 100 });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+H');
  await page.keyboard.press('Enter');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.transform?.mode === 'idle', null, { timeout: 10_000, polling: 100 });
  const applied = await el();
  if (!(applied.flipX === !session0.flipX) || (await undoDepth()) !== u3 + 1) fail(`transform mode Enter: ${JSON.stringify({ session0, applied, undo: [u3, await undoDepth()] })}`);
  log('transform mode (Mod+T): Escape cancelled the session, Enter applied a nudge and a flip as one undo step');

  // ---------------------------------------------------------------- B8: type text
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7);
  await page.getByRole('textbox', { name: 'Text', exact: true }).waitFor({ timeout: 20_000 });
  await page.keyboard.type('Hello Studio');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.editing?.text === 'Hello Studio', null, { timeout: 20_000, polling: 100 }).catch(async (e) => fail(`${e.message} (the text reads ${JSON.stringify((await inspect()).editing?.text)})`));
  // FIX-TEXT-FIRST-KEY item 2: Mod+A selects all the text (not the elements); a click in the text places the caret; a
  // drag across it selects (TEXT-FONTS §3.2, §3.3). Presses on the text host reach the editor through the input ring.
  const selectionIs = (want, what) =>
    waitAsync(page, async (w) => JSON.stringify((await window.__studio.inspect()).value?.editing?.selection) === w, JSON.stringify(want), { timeout: 10_000 }).catch(async (e) =>
      fail(`${what}: ${e.message} (editing ${JSON.stringify((await inspect()).editing)})`),
    );
  await page.keyboard.press('Control+A');
  await selectionIs([0, 12], 'Mod+A while editing');
  const hostBox = await page.locator('[data-if-text-host]').boundingBox();
  if (hostBox === null) fail('no text host');
  await page.mouse.click(hostBox.x + 1, hostBox.y + hostBox.height / 2);
  await selectionIs([0, 0], 'click at the start of the text');
  await page.waitForTimeout(700); // not a double click
  await page.mouse.move(hostBox.x + 1, hostBox.y + hostBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hostBox.x + hostBox.width / 2, hostBox.y + hostBox.height / 2, { steps: 3 });
  await page.mouse.move(hostBox.x + hostBox.width + 20, hostBox.y + hostBox.height / 2, { steps: 3 });
  await page.mouse.up();
  await selectionIs([0, 12], 'drag across the text');
  if ((await inspect()).editing === undefined) fail('a press in the text ended editing');
  log('editing: Mod+A selects the text, a click places the caret, a drag selects');
  // B11c audit: the formatting keys the inspector shows work while editing (one undo step each; ⌘B again undoes the look).
  const boldNow = () => page.evaluate(() => window.__studio.scene.typography?.bold);
  await page.keyboard.press('Control+B');
  await page.waitForFunction(() => window.__studio.scene.typography?.bold === true, null, { timeout: 10_000 }).catch(async () => fail(`Mod+B while editing did not bold the selection: ${await boldNow()}`));
  await page.keyboard.press('Control+B');
  await page.waitForFunction(() => window.__studio.scene.typography?.bold === false, null, { timeout: 10_000 }).catch(async () => fail(`Mod+B again did not unbold: ${await boldNow()}`));
  if ((await inspect()).editing === undefined) fail('Mod+B ended editing');
  log('editing: Mod+B bolds the selected text, Mod+B again unbolds it (still editing)');
  await page.keyboard.press('Escape');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.textNodes.length === 1 && window.__studio.tab.editing === undefined, null, { timeout: 20_000, polling: 100 });
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
  // The double click put the caret at the click; End moves it in the editor, and main's EditContext learns the caret
  // only from the editor's next state. The composition starts at once, without waiting for that: the editor rebases it
  // onto its own caret (B12b P1), so it must land at the end.
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.press('End');
  await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(400);
  const during = await page.evaluate(() => {
    const h = window.__studio.canvas.text?.host;
    const ec = h?.editContext;
    const bounds = ec?.characterBounds?.() ?? [];
    return { kind: ec === undefined || ec === null ? 'hidden-textarea' : 'edit-context', bounds: [...bounds].map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })), editing: window.__studio.tab?.editing?.node };
  });
  await cdp.send('Input.insertText', { text: '日本語' });
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.editing?.text?.includes('日本語') === true, null, { timeout: 20_000, polling: 100 });
  const composed = (await inspect()).editing?.text;
  if (composed !== 'Hello Studio日本語') fail(`IME after End: the text reads ${JSON.stringify(composed)} (the composition did not land at the caret End moved to)`);
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
  await page.getByRole('textbox', { name: 'Milestone name' }).fill('Smoke v1');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(() => window.__studio.toasted.some((m) => m === "Milestone 'Smoke v1' created"), null, { timeout: 20_000 });
  log('milestone created from the popover, toast shown');

  // ---------------------------------------------------------------- B11b: the selection pill (recolour, duplicate, group, delete, undo)
  const sceneOf = () => page.evaluate(() => {
    const s = window.__studio.scene;
    return { kind: s.selection?.kind, fill: s.selection?.fill?.color, nodes: s.selection?.nodes ?? [], layers: s.layers.length };
  });
  const clickElement = async (node) => {
    const b = await screenBox(node);
    await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
    await page.waitForFunction((n) => window.__studio.tab.view.selection.join() === n, node, { timeout: 10_000 });
  };
  await clickElement(rect);
  await waitAsync(page, () => window.__studio.scene.selection?.kind === 'shape', null, { timeout: 10_000 });
  // The inspector (STUDIO §5): exactly the rectangle's sections.
  const inspector = page.locator('if-inspector');
  await inspector.locator('section[data-section="fill"]').waitFor({ timeout: 10_000 }).catch(() => fail('the inspector shows no Fill section for a rectangle'));
  const shown = await inspector.locator('section[data-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));
  if (JSON.stringify(shown) !== JSON.stringify(['transform', 'fill', 'stroke', 'corners', 'effects', 'layer'])) fail(`inspector sections for a rectangle: ${JSON.stringify(shown)}`);
  log(`inspector: a rectangle shows ${shown.join(' · ')}`);
  const u4 = await undoDepth();
  const labels4 = (await inspect()).steps.map((x) => x.label);
  await hud.getByRole('button', { name: 'Fill', exact: true }).click();
  const hex = page.getByRole('textbox', { name: 'Fill colour Hex' });
  await hex.waitFor({ timeout: 10_000 });
  await hex.fill('3D5AFE');
  await hex.press('Enter');
  await waitAsync(page, () => window.__studio.scene.selection?.fill?.color?.toUpperCase().startsWith('#3D5AFE') === true, null, { timeout: 10_000 }).catch(async (e) => fail(`pill recolour: ${e.message} ${JSON.stringify(await sceneOf())}`));
  if ((await undoDepth()) !== u4 + 1) fail(`pill recolour: ${u4} → ${await undoDepth()} undo steps`);
  await page.keyboard.press('Escape'); // closes the colour popover
  log('pill recolour: Fill swatch → colour popover → #3D5AFE (one undo step)');
  await hud.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await waitAsync(page, (n) => window.__studio.tab.view.selection.length === 1 && window.__studio.tab.view.selection[0] !== n, rect, { timeout: 10_000 });
  const copy = await page.evaluate(() => window.__studio.tab.view.selection[0]);
  log(`pill Duplicate: ${copy} selected`);
  await surface.focus();
  await page.keyboard.press('Control+A');
  await waitAsync(page, () => window.__studio.tab.view.selection.length === 3, null, { timeout: 10_000 });
  await waitAsync(page, () => window.__studio.scene.selection?.kind === 'mixed', null, { timeout: 10_000 });
  await hud.getByRole('button', { name: 'Group', exact: true }).click();
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.some((e) => e.kind === 'group') === true && window.__studio.scene.selection?.kind === 'group', null, { timeout: 10_000 }).catch(async (e) => fail(`pill Group: ${e.message} ${JSON.stringify(await sceneOf())}`));
  log('pill Group: the three elements are one group, selected (the pill shows Ungroup)');
  await hud.getByRole('button', { name: 'Ungroup', exact: true }).waitFor({ timeout: 10_000 });
  await hud.getByRole('button', { name: 'Delete', exact: true }).click();
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.length === 0, null, { timeout: 10_000 });
  log('pill Delete: the group is gone');
  await surface.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+Z');
  await waitAsync(page, async () => {
    const s = (await window.__studio.inspect()).value;
    return s !== undefined && s.elements.filter((e) => e.kind === 'shape').length === 1 && s.elements.every((e) => e.kind !== 'group') && s.textNodes.length === 1;
  }, null, { timeout: 15_000 }).catch(async (e) => fail(`undo ×4: ${e.message} ${JSON.stringify((await inspect()).elements.map((x) => [x.id, x.kind]))}`));
  const labels = (await inspect()).steps.map((x) => x.label);
  if (JSON.stringify(labels.slice(0, 3)) !== JSON.stringify(labels4.slice(0, 3))) fail(`undo ×4 left the steps ${JSON.stringify(labels)} (before: ${JSON.stringify(labels4)})`);
  await clickElement(rect);
  await waitAsync(page, () => window.__studio.scene.selection?.fill?.color?.toUpperCase().startsWith('#FF5C39') === true, null, { timeout: 10_000 });
  log('Mod+Z ×4 undid delete, group, duplicate and the recolour');
  // The command bar (Mod+K): type, Enter runs the top row on the selection; then undo it.
  const shapes = async () => (await inspect()).elements.filter((e) => e.kind === 'shape').length;
  await surface.focus();
  await page.keyboard.press('Control+K');
  const commandFilter = page.getByRole('searchbox', { name: 'Type a command' });
  await commandFilter.waitFor({ timeout: 10_000 }).catch(() => fail('Mod+K did not open the command bar'));
  await commandFilter.fill('Duplicate');
  await commandFilter.press('Enter');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.filter((e) => e.kind === 'shape').length === 2, null, { timeout: 10_000 }).catch(async (e) => fail(`command bar Duplicate: ${e.message} (${await shapes()} shapes)`));
  await surface.focus();
  await page.keyboard.press('Control+Z');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.filter((e) => e.kind === 'shape').length === 1, null, { timeout: 10_000 });
  log('command bar: Mod+K → "Duplicate" → Enter duplicated the selection (undone)');

  // Clipboard (STUDIO §8.1, B11b slice 4): Mod+C, Mod+V pastes +24 on the same page and selects the copy; Mod+Shift+V
  // pastes in place; one undo step each.
  await clickElement(rect);
  const r1 = (await screenBox(rect)).e;
  await surface.focus();
  const uClip = await undoDepth();
  await page.keyboard.press('Control+C');
  await page.waitForFunction(() => window.__studio.scene.clipboard.canPaste === true, null, { timeout: 10_000 }).catch(() => fail('Mod+C kept nothing to paste'));
  await page.keyboard.press('Control+V');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.filter((e) => e.kind === 'shape').length === 2, null, { timeout: 10_000 }).catch(async (e) => fail(`Mod+V: ${e.message} (${await shapes()} shapes)`));
  const pasted = await page.evaluate(() => window.__studio.tab.view.selection[0]);
  if (pasted === rect) fail('Mod+V did not select the pasted copy');
  const p1 = (await screenBox(pasted)).e;
  if (!near(p1.x - r1.x, 24, 0.5) || !near(p1.y - r1.y, 24, 0.5)) fail(`Mod+V pasted at ${p1.x - r1.x}, ${p1.y - r1.y} from the source (want +24, +24)`);
  await page.keyboard.press('Control+Shift+V');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.filter((e) => e.kind === 'shape').length === 3, null, { timeout: 10_000 }).catch(async (e) => fail(`Mod+Shift+V: ${e.message} (${await shapes()} shapes)`));
  const inPlace = (await screenBox(await page.evaluate(() => window.__studio.tab.view.selection[0]))).e;
  if (!near(inPlace.x, r1.x, 0.5) || !near(inPlace.y, r1.y, 0.5)) fail(`Mod+Shift+V pasted at ${inPlace.x}, ${inPlace.y} (want ${r1.x}, ${r1.y})`);
  if ((await undoDepth()) !== uClip + 2) fail(`paste: ${uClip} → ${await undoDepth()} undo steps (want one per paste)`);
  await page.keyboard.press('Control+Z');
  await page.keyboard.press('Control+Z');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.filter((e) => e.kind === 'shape').length === 1, null, { timeout: 10_000 }).catch(async (e) => fail(`paste undo: ${e.message} (${await shapes()} shapes)`));
  log('clipboard: Mod+C, Mod+V pasted +24 and selected the copy, Mod+Shift+V pasted in place; Mod+Z ×2 removed both');

  // The context menu (STUDIO §8.2): right-click the rectangle → Duplicate; then undo.
  const rb = await screenBox(rect);
  await page.mouse.click(rb.x + rb.w / 2, rb.y + rb.h / 2, { button: 'right' });
  // The menu's rows are its light-DOM children (slotted into the shadow `role=menu`), so rows are found from the host.
  await page.getByRole('menu', { name: 'Context menu' }).waitFor({ timeout: 10_000 }).catch(() => fail('right-click opened no context menu'));
  const contextMenu = page.locator('sf-menu.context-menu');
  for (const name of ['Cut', 'Copy', 'Paste', 'Duplicate', 'Delete', 'Copy style', 'Rename']) {
    if ((await contextMenu.getByRole("menuitem", { name, exact: true }).count()) !== 1) fail(`the context menu has no "${name}": ${JSON.stringify(await contextMenu.getByRole("menuitem").evaluateAll((els) => els.map((e) => [e.getAttribute("value"), e.textContent, e.getAttribute("aria-label")])))}`);
  }
  await contextMenu.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.filter((e) => e.kind === 'shape').length === 2, null, { timeout: 10_000 }).catch(async (e) => fail(`context menu Duplicate: ${e.message} (${await shapes()} shapes)`));
  await surface.focus();
  await page.keyboard.press('Control+Z');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.filter((e) => e.kind === 'shape').length === 1, null, { timeout: 10_000 });
  log('context menu: right-click → Duplicate (undone)');

  // The cheat sheet (STUDIO §2.3.1): ? opens it from the registry; the search filters; Escape closes.
  await page.keyboard.press('Shift+?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await sheet.waitFor({ timeout: 10_000 }).catch(() => fail('? opened no cheat sheet'));
  const sheetSearch = sheet.getByRole('searchbox', { name: 'Search shortcuts' });
  await sheetSearch.fill('paste');
  const rows = await sheet.locator('sf-shortcut-sheet li').allTextContents();
  if (!rows.some((t) => t.includes('Paste in place')) || rows.some((t) => t.includes('Undo'))) fail(`cheat sheet search "paste": ${JSON.stringify(rows)}`);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => fail('Escape did not close the cheat sheet'));
  log(`cheat sheet: ? opened it, "paste" kept ${rows.length} rows, Escape closed it`);

  // B11c find and replace (STUDIO §9.1): Mod+F, type, Enter selects the match; Replace all is one undo step; Escape.
  await surface.focus();
  await page.keyboard.press('Control+F');
  const findBar = page.getByRole('search', { name: 'Find' });
  await findBar.waitFor({ timeout: 10_000 }).catch(() => fail('Mod+F opened no find bar'));
  await page.keyboard.type('studio');
  await findBar.getByText('0 of 1').waitFor({ timeout: 10_000 }).catch(async () => fail(`find "studio" counted ${await findBar.locator('.count').textContent()}`));
  await page.keyboard.press('Enter');
  await findBar.getByText('1 of 1').waitFor({ timeout: 5_000 }).catch(() => fail('Enter did not step to the match'));
  // The bar counts at once; the match's selection arrives from the editor a moment later (reveal is a request).
  await page.waitForFunction(() => window.__studio.scene.selection?.kind === 'text', null, { timeout: 10_000 }).catch(async () => fail(`Enter should select the text that matches: ${await page.evaluate(() => window.__studio.scene.selection?.kind)}`));
  const uFind = await undoDepth();
  await findBar.getByRole('button', { name: 'Replace', exact: true }).first().click();
  await findBar.getByRole('textbox', { name: 'Replace with' }).fill('Flow');
  await findBar.getByRole('button', { name: 'Replace all' }).click();
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.some((e) => e.text === 'Hello Flow日本語' || e.text?.startsWith('Hello Flow')), null, { timeout: 10_000 }).catch(async () =>
    fail(`Replace all did not rewrite the text: ${JSON.stringify((await inspect()).elements.filter((e) => e.kind === 'text').map((e) => e.text))}`),
  );
  if ((await undoDepth()) !== uFind + 1) fail(`Replace all: ${uFind} → ${await undoDepth()} undo steps (want one)`);
  // OVERLAYS §3.5: Escape reaches the newest toast first (the replace toast with Undo), then the bar.
  const toastUp = await page.locator('sf-toast').filter({ hasText: "Replace 'studio' with 'Flow'" }).count();
  await page.keyboard.press('Escape');
  if (toastUp > 0) await page.keyboard.press('Escape');
  await findBar.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => fail(`Escape did not close the find bar (toast up: ${toastUp})`));
  await surface.focus();
  await page.keyboard.press('Control+Z');
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.some((e) => e.text?.startsWith('Hello Studio')), null, { timeout: 10_000 }).catch(() => fail('Mod+Z did not undo the replace'));
  log('find: Mod+F "studio" → 1 match, Enter selected the text; Replace all "Flow" (one undo step); Escape closed; Mod+Z restored');

  // Layers (STUDIO §3.1): rename a row inline, move it up with Alt+↑ (one step each), then undo both.
  const layersOf = () => page.evaluate(() => window.__studio.scene.layers.map((l) => [l.id, l.name]));
  const layersBefore = await layersOf();
  const layers = page.locator('if-layers-panel');
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  const rectRow = layers.locator(`[role="treeitem"][data-id="${rect}"]`);
  await rectRow.waitFor({ timeout: 10_000 }).catch(async () => fail(`Layers has no row for ${rect}: ${JSON.stringify(layersBefore)}`));
  await rectRow.dblclick();
  const renameField = layers.locator('input.rename');
  await renameField.waitFor({ timeout: 10_000 });
  await renameField.fill('Hero card');
  await renameField.press('Enter');
  await waitAsync(page, (n) => window.__studio.scene.layers.some((l) => l.id === n && l.name === 'Hero card'), rect, { timeout: 10_000 }).catch(async (e) => fail(`Layers rename: ${e.message} ${JSON.stringify(await layersOf())}`));
  const at = (await layersOf()).findIndex(([id]) => id === rect);
  await rectRow.click();
  await page.keyboard.press('Alt+ArrowUp');
  await waitAsync(page, ([n, i]) => window.__studio.scene.layers.findIndex((l) => l.id === n) === i - 1, [rect, at], { timeout: 10_000 }).catch(async (e) => fail(`Layers reorder: ${e.message} ${JSON.stringify(await layersOf())}`));
  await surface.focus();
  await page.keyboard.press('Control+Z');
  await page.keyboard.press('Control+Z');
  await waitAsync(page, (before) => JSON.stringify(window.__studio.scene.layers.map((l) => [l.id, l.name])) === before, JSON.stringify(layersBefore), { timeout: 10_000 }).catch(async (e) => fail(`Layers undo: ${e.message} ${JSON.stringify(await layersOf())}`));
  log(`Layers: renamed "${rect}" to "Hero card" and moved it up (Alt+↑); Mod+Z ×2 restored both`);

  // Pages (STUDIO §3.2): Add page shows a new page sized like the current one; Mod+Z takes it back.
  const storyPages = () => page.evaluate(() => {
    const s = window.__studio.mirrors.view({ id: 'instaflow/mirror/story' }).read('structure');
    return s?.ok === true ? s.value.pages.map((p) => p.id) : [];
  });
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  const pagesPanel = page.locator('if-pages-panel');
  await pagesPanel.getByRole('button', { name: 'Add page' }).click();
  await page.waitForFunction(() => window.__studio.tab?.page?.startsWith('pg_') === true, null, { timeout: 20_000 }).catch(async () => fail(`Add page: ${JSON.stringify(await storyPages())}`));
  const pagesNow = await storyPages();
  if (pagesNow.length !== 3) fail(`Add page: ${JSON.stringify(pagesNow)}`);
  await surface.focus();
  await page.keyboard.press('Control+Z');
  await waitAsync(page, async () => {
    const s = window.__studio.mirrors.view({ id: 'instaflow/mirror/story' }).read('structure');
    return s?.ok === true && s.value.pages.length === 2;
  }, null, { timeout: 10_000 }).catch(async (e) => fail(`Add page undo: ${e.message} ${JSON.stringify(await storyPages())}`));
  await pagesPanel.locator('[role="treeitem"][data-id="p1"]').click();
  await page.waitForFunction(() => window.__studio.tab?.page === 'p1', null, { timeout: 20_000 });
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  log(`Pages: Add page showed ${pagesNow.find((id) => id.startsWith("pg_"))} after p1; Mod+Z removed it; back on p1`);
  await page.mouse.click(box.x + 8, box.y + box.height - 8);

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
  await waitAsync(page, async (n) => ((await window.__studio.metrics()).value?.render?.draws ?? 0) > n, drawsBefore, { timeout: 10_000, polling: 100 });
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

  // ---------------------------------------------------------------- B11c: images from files and image fills (page 2)
  await page.evaluate(() => window.__studio.lens.goTo('p2'));
  await page.waitForFunction(() => window.__studio.tab?.page === 'p2', null, { timeout: 20_000 });
  const pickFile = async (click) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), click()]);
    await chooser.setFiles({ name: 'smoke-mint.png', mimeType: 'image/png', buffer: Buffer.from(MINT_PNG, 'base64') });
  };
  // Place image… from the tool picker: a file picker; the image lands at the viewport centre, selected.
  await pickFile(() => page.locator('.tools sf-icon-button.place-image').click());
  await waitAsync(page, async () => (await window.__studio.inspect()).value?.elements.some((e) => e.kind === 'image'), null, { timeout: 20_000 }).catch(async () => fail(`Place image… placed nothing: ${JSON.stringify(window.__studio?.toasted)}`));
  const placedImage = (await inspect()).elements.find((e) => e.kind === 'image');
  log(`Place image…: the file picker placed ${placedImage.id} (${Math.round(placedImage.w)}×${Math.round(placedImage.h)})`);
  // A rectangle filled with that image from the inspector's Fill › Add image (the workspace's images).
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__studio.tab?.view.selection.length === 1 && window.__studio.scene.selection?.kind === 'shape', null, { timeout: 10_000 });
  const imageRect = await page.evaluate(() => window.__studio.tab.view.selection[0]);
  const fillSection = page.locator('if-inspector section[data-section="fill"]');
  await fillSection.getByRole('button', { name: 'Add image to fill' }).click();
  await fillSection.getByRole('button', { name: 'Use smoke-mint' }).click();
  await page
    .waitForFunction((n) => window.__studio.scene.selection?.nodes[0] === n && window.__studio.scene.undo === 'Image fill', imageRect, { timeout: 20_000 })
    .catch(async () => fail(`Fill › Add image did not fill the rectangle: ${await page.evaluate(() => window.__studio.scene.undo)}`));
  log(`image fill: Fill › Add image › smoke-mint filled ${imageRect} (one undo step "Image fill")`);
  // The page Background: nothing selected, the Background row's Image tab, the same image.
  // Escape closes the chooser popover first, then (on the canvas) clears the selection.
  for (let i = 0; i < 3 && (await page.evaluate(() => window.__studio.tab?.view.selection.length)) !== 0; i++) {
    await surface.focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await page.waitForFunction(() => window.__studio.tab?.view.selection.length === 0, null, { timeout: 10_000 }).catch(() => fail('Escape did not clear the selection'));
  const pageSection = page.locator('if-inspector section[data-section="page"]');
  await pageSection.getByRole('button', { name: 'Background', exact: true }).first().click();
  await page.getByRole('radio', { name: 'Image' }).first().click();
  await page.getByRole('button', { name: 'Use smoke-mint' }).first().click();
  await page.waitForFunction(() => window.__studio.scene.undo === 'Background kind', null, { timeout: 20_000 }).catch(async () => fail(`the Background did not take the image: ${await page.evaluate(() => window.__studio.scene.undo)}`));
  await page.keyboard.press('Escape');
  log('page background: Background › Image tab › smoke-mint (the colour row became the image)');
  await page.evaluate(() => window.__studio.lens.goTo('p1'));
  await page.waitForFunction(() => window.__studio.tab?.page === 'p1', null, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Select', exact: true }).click().catch(() => undefined);
  await page.evaluate((n) => window.__studio.workers.editor.request('select', { nodes: [n] }), rect);
  // Studio's scope still follows the editor's selection after the switches (no stale selection scope).
  await page.waitForFunction(() => {
    const app = window.__studio;
    const scope = app.studio.spec?.scope;
    return JSON.stringify(scope?.kind === 'selection' ? scope.nodes : []) === JSON.stringify(app.view?.selection ?? []);
  }, null, { timeout: 10_000 }).catch(async (e) => {
    log(`scope ${JSON.stringify(await page.evaluate(() => ({ scope: window.__studio.studio.spec?.scope, lens: window.__studio.studio.lens?.id, selection: window.__studio.view?.selection })))}`);
    throw e;
  });

  // ---------------------------------------------------------------- C1: export PNG, PDF and SVG
  const beforeExport = await state();
  const undoBeforeExport = await undoDepth();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportPanel = page.locator('if-export-panel');
  await exportPanel.waitFor({ timeout: 20_000 });
  const download = async (button) => {
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), exportPanel.getByRole('button', { name: button }).click()]);
    const path = await file.path();
    if (path === null) fail(`${button}: no file`);
    return { name: file.suggestedFilename(), bytes: readFileSync(path) };
  };
  await exportPanel.getByRole('radio', { name: 'PNG' }).click();
  await exportPanel.getByRole('radio', { name: '2×' }).click();
  await exportPanel.getByRole('radio', { name: 'Page', exact: true }).click();
  const png = await download('Export PNG');
  if (!png.name.endsWith('.png') || png.bytes.subarray(1, 4).toString('latin1') !== 'PNG') fail(`PNG export: ${png.name} (${png.bytes.length} bytes)`);
  const decoded = await page.evaluate(
    async ({ data, rgb }) => {
      const img = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
      const g = new OffscreenCanvas(img.width, img.height).getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      let shape = 0;
      for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - rgb[0]) + Math.abs(px[i + 1] - rgb[1]) + Math.abs(px[i + 2] - rgb[2]) < 40) shape += 1;
      return { width: img.width, height: img.height, shape };
    },
    { data: [...png.bytes], rgb: TANGERINE },
  );
  if (decoded.width !== 2160 || decoded.height !== 2700 || decoded.shape === 0) fail(`PNG export pixels: ${JSON.stringify(decoded)}`);
  log(`exported ${png.name}: ${decoded.width}×${decoded.height} (2× the page), ${decoded.shape} shape pixels, ${Math.round(png.bytes.length / 1024)} KB`);
  // The export Wasm is lazy (IF-29.20): nothing fetched it while editing, nor for a PNG of the page.
  if (exportWasm.length > 0) fail(`the export Wasm loaded before an SVG or PDF export: ${exportWasm.join(', ')}`);
  log('export Wasm not loaded by editing or a PNG export');
  await exportPanel.getByRole('radio', { name: 'PDF' }).click();
  await exportPanel.getByRole('radio', { name: 'All pages' }).click();
  const pdf = await download('Export PDF');
  const pdfText = pdf.bytes.toString('latin1');
  if (!pdf.name.endsWith('.pdf') || !pdfText.startsWith('%PDF-1.7') || !pdfText.includes('/Count 2')) fail(`PDF export: ${pdf.name} (${pdf.bytes.length} bytes)`);
  // B11c: page 2's placed image, image-filled rectangle and image background are in the PDF.
  if (!/\/Subtype\s*\/Image/.test(pdfText)) fail('the PDF has no image (page 2: the placed image, the image fill, the image background)');
  const extracted = spawnSync('pdftotext', ['-enc', 'UTF-8', '-', '-'], { input: pdf.bytes, encoding: 'utf8' });
  if (extracted.error === undefined) {
    if (!extracted.stdout.includes('Hello Studio')) fail(`PDF export: the text is not extractable: ${JSON.stringify(extracted.stdout)}`);
    log(`exported ${pdf.name}: 2 pages, text extractable (${JSON.stringify(extracted.stdout.trim().split('\n')[0])})`);
  } else log(`exported ${pdf.name}: 2 pages (pdftotext not installed: text not checked)`);
  if (exportWasm.length === 0) fail('the PDF export did not load the export Wasm');
  await exportPanel.getByRole('radio', { name: 'SVG' }).click();
  await exportPanel.getByRole('radio', { name: 'Page', exact: true }).click();
  const svg = await download('Export SVG');
  const svgText = svg.bytes.toString('utf8');
  if (!svg.name.endsWith('.svg') || !svgText.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') || !svgText.includes('viewBox="0 0 1080 1350"')) fail(`SVG export: ${svg.name} (${svg.bytes.length} bytes)`);
  if (!svgText.includes('aria-label="Hello')) fail('SVG export: the text is not labelled with its text');
  log(`exported ${svg.name}: the page, text labelled, ${Math.round(svg.bytes.length / 1024)} KB`);
  if ((await state()) !== beforeExport || (await undoDepth()) !== undoBeforeExport) fail('exporting changed the document');
  log('exports created nothing in the document');

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
