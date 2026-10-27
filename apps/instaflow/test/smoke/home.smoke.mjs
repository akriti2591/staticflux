// Home smoke scenario (C0 IF-28.29), in Chromium with WebGPU on SwiftShader (no GPU needed). Plain Node ESM;
// Playwright comes from NODE_PATH (preinstalled):
//
//   pnpm build && NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke:home
//
// One fresh browser profile: open Home (no worker, no Wasm, no GPU adapter requested; the accessibility audit passes;
// the first-run welcome card and formats hint show; "Keep my designs on this device" answers), start "New design" from
// the keyboard with a custom size (20 000 refused inline, then 1500 × 500 and a name), land in Studio on an empty
// document of that size, draw one shape, go back Home, see the design in "Jump back in". Then the file operations
// (B11c): rename from ⋯, duplicate with Mod+D, a new project and ⋯ › Move to, the project page, Delete → trash,
// Restore from the trash, Files in list view, Import an image (shown with its preview). Reopen the design: Studio
// drained Home's journal (the title, the copy in its project, the image are in the library). Starts the dev server
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
/** A 1 × 1 PNG (import). */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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
  // Toasts queue past three (OVERLAYS-FEEDBACK §3.5: a queued one shows when a slot frees, ≤ 8 s): wait up to 20 s.
  const toast = (text) => page.locator('sf-toast').filter({ hasText: text }).first();
  const toasted = (text, what) => toast(text).waitFor({ timeout: 20_000 }).catch(() => fail(`${what} toasted nothing`));
  const card = (name) => page.locator('sf-card.tile').filter({ hasText: name }).first();
  const auditOrFail = async (what) => {
    const issues = await audit(page);
    if (issues.length > 0) fail(`accessibility audit (${what}):\n${issues.join('\n')}`);
  };

  // ---------------------------------------------------------------- Home: light boot, first run (HOME-FILES §1.4)
  log(`open ${origin}/`);
  await page.goto(`${origin}/`);
  await homeReady(page);
  await page.getByRole('heading', { level: 1, name: /Make something\s+bold\s+today/ }).waitFor({ timeout: 10_000 });
  const welcome = page.getByRole('region', { name: 'Your designs live on this device' });
  await welcome.waitFor({ timeout: 10_000 }).catch(() => fail('the first run shows no welcome card'));
  await page.getByText('Pick a size to start. You can change it later.').waitFor({ timeout: 5_000 });
  const engine = requests.filter((u) => /\.wasm|studio\.worker|loro|engine\/dist|^worker /.test(u));
  if (engine.length > 0) fail(`Home loaded engine code: ${engine.join(', ')}`);
  const gpu = await page.evaluate(() => globalThis.__gpuRequests);
  if (gpu !== 0) fail(`Home requested a GPU adapter ${gpu} time(s)`);
  log(`Home is up (${requests.length} requests, no worker, no Wasm, no GPU adapter); first run: welcome card + formats hint`);
  await auditOrFail('first run');
  if (screenshot !== undefined) await page.screenshot({ path: `${screenshot}-home-first-run.png`, fullPage: true });
  await welcome.getByRole('button', { name: 'Keep my designs on this device' }).click();
  const kept = page.getByText(/Saved on this device|Chrome may clear this workspace/);
  await kept.waitFor({ timeout: 10_000 }).catch(() => fail('Keep my designs gave no answer'));
  log(`first run: "Keep my designs on this device" → "${(await kept.textContent())?.trim()}"`);

  // ---------------------------------------------------------------- New design with a custom size, from the keyboard
  // B11b / B11c (HOME-FILES §1.3, F-54): the New design dialog — Custom, W × H typed, a name, Enter creates.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await tabTo(page, (el) => el?.localName === 'sf-button' && /New design/.test(el.textContent ?? ''), 'New design');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New design' });
  await dialog.waitFor({ timeout: 10_000 }).catch(() => fail('New design opened no dialog'));
  await auditOrFail('New design dialog');
  await dialog.getByRole('radio', { name: /^Custom/ }).click();
  const width = dialog.getByRole('spinbutton', { name: 'Width' });
  await width.fill('20000');
  await width.press('Tab');
  await dialog.getByText('Too large for this device (max 16 384 px)').waitFor({ timeout: 5_000 }).catch(() => fail('a too-large width shows no inline error'));
  await width.fill('1500');
  await width.press('Tab');
  const height = dialog.getByRole('spinbutton', { name: 'Height' });
  await height.fill('500');
  await height.press('Tab');
  const name = dialog.getByRole('textbox', { name: 'Name' });
  await name.fill('Smoke banner');
  await name.press('Enter');
  await page.waitForURL(/\/s\/as_[a-z0-9]+(\?|$)/, { timeout: 60_000 });
  if (/[?&](w|h|name)=/.test(page.url())) fail(`the new design's URL kept the New design keys: ${page.url()}`);
  await studioReady(page);
  const asset = new URL(page.url()).pathname.split('/').pop();
  const plan = await page.evaluate(() => window.__studio.workers.plan.topology);
  const empty = await inspect(page);
  if (empty.elements.length !== 0) fail(`a new design should be empty: ${JSON.stringify(empty.elements)}`);
  const made = await page.evaluate(() => ({ page: window.__studio.scene.page, title: window.__studio.scene.title }));
  if (made.page?.width !== 1500 || made.page?.height !== 500 || made.title !== 'Smoke banner') fail(`New design made ${JSON.stringify(made)} (want Smoke banner, 1500 × 500)`);
  const studioGpu = await page.evaluate(() => globalThis.__gpuRequests);
  log(`New design dialog (20 000 refused inline; Custom 1500 × 500, "Smoke banner", Enter) → Studio on ${asset} (${plan}), empty, that size`);

  // ---------------------------------------------------------------- draw one shape
  const surface = page.getByRole('application', { name: 'Canvas surface' });
  const box = await surface.boundingBox();
  if (box === null) fail('no canvas surface');
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  // B11c: the first use of a tool shows its one-sentence hint (OVERLAYS §5); using the tool retires it.
  const hint = page.getByText('Drag to draw. Shift keeps it square, Alt draws from the centre.');
  await hint.waitFor({ timeout: 10_000 }).catch(() => fail('the Shape tool showed no first-use hint'));
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.47, box.y + box.height * 0.42, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__studio.tab?.view.selection.length === 1, null, { timeout: 10_000 });
  const shape = await page.evaluate(() => window.__studio.tab.view.selection[0]);
  const drawn = (await inspect(page, [shape])).elements[0];
  if (drawn?.kind !== 'shape' || !(drawn.w > 10)) fail(`no shape drawn: ${JSON.stringify(drawn)}`);
  await hint.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => fail('the Shape hint stayed after the tool was used'));
  log(`drew shape ${shape} (${Math.round(drawn.w)}×${Math.round(drawn.h)}); its first-use hint showed, then left once used`);

  // ---------------------------------------------------------------- back Home: the design is in recents
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/`, { timeout: 30_000 });
  await homeReady(page);
  const recents = page.getByRole('region', { name: 'Jump back in' });
  await recents.getByRole('link', { name: /Smoke banner/ }).waitFor({ timeout: 10_000 });
  const listed = await page.evaluate(() => window.__home.model.recents().map((e) => e.asset));
  if (listed[0] !== asset) fail(`recents should start with ${asset}: ${JSON.stringify(listed)}`);
  if ((await page.locator('.welcome').count()) > 0) fail('the welcome card came back after it was answered');
  await auditOrFail('Home with recents');
  log(`back Home: "${(await recents.locator('sf-card').first().textContent())?.replace(/\s+/g, ' ').trim()}" in Jump back in; audit passes`);
  if (screenshot !== undefined) await page.screenshot({ path: `${screenshot}-home-recents.png`, fullPage: true });

  // ---------------------------------------------------------------- file operations on Home (HOME-FILES §3)
  // Rename from the card's ⋯ menu.
  await card('Smoke banner').hover();
  await card('Smoke banner').getByRole('button', { name: 'More for Smoke banner' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = card('Smoke banner').getByRole('textbox');
  await field.waitFor({ timeout: 5_000 }).catch(() => fail('Rename opened no field'));
  await field.fill('Smoke poster');
  await field.press('Enter');
  await recents.getByRole('link', { name: /Smoke poster/ }).waitFor({ timeout: 10_000 });
  await toasted('Renamed to “Smoke poster”', 'Rename');
  log('⋯ › Rename → "Smoke poster" (toast with Undo)');
  // Duplicate with Mod+D on the focused card: the copy comes first and takes the focus.
  await recents.getByRole('link', { name: /Smoke poster/ }).first().focus();
  await page.keyboard.press('ControlOrMeta+d');
  const copy = recents.getByRole('link', { name: /Smoke poster copy/ });
  await copy.waitFor({ timeout: 10_000 }).catch(() => fail('Mod+D made no copy'));
  const focused = await page.evaluate(() => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return (el?.getRootNode()?.host ?? el)?.textContent ?? ''; // the card's link lives in its shadow root
  });
  if (!/Smoke poster copy/.test(focused)) fail(`the copy should take the focus: "${focused.replace(/\s+/g, ' ').trim()}"`);
  log('Mod+D → "Smoke poster copy" first, focused');
  // A new project, then move the copy there from ⋯ › Move to.
  const projects = page.getByRole('region', { name: 'Projects' });
  await projects.getByRole('button', { name: /New project/ }).first().click();
  const projectName = projects.getByRole('textbox', { name: 'Project name' });
  await projectName.fill('Smoke project');
  await projectName.press('Enter');
  await projects.getByRole('link', { name: /Smoke project/ }).waitFor({ timeout: 5_000 }).catch(() => fail('New project made no card'));
  await card('Smoke poster copy').hover();
  await card('Smoke poster copy').getByRole('button', { name: 'More for Smoke poster copy' }).click();
  await page.getByRole('menuitem', { name: 'Move to', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Smoke project' }).click();
  await toasted('Moved to Smoke project', 'Move');
  await projects.getByRole('link', { name: /Smoke project.*1 design/ }).waitFor({ timeout: 5_000 }).catch(() => fail('the project card does not count the moved design'));
  log('＋ New project "Smoke project"; ⋯ › Move to › Smoke project (toast; the card counts 1 design)');
  // The project page lists it; Delete on the focused card trashes it (toast with Undo).
  await projects.getByRole('link', { name: /Smoke project/ }).click();
  await page.waitForURL(`${origin}/p/Smoke%20project`, { timeout: 10_000 });
  await page.getByRole('heading', { level: 1, name: /Smoke project/ }).waitFor({ timeout: 5_000 });
  await auditOrFail('project page');
  await page.getByRole('link', { name: /Smoke poster copy/ }).focus();
  await page.keyboard.press('Delete');
  await toasted('Moved “Smoke poster copy” to trash', 'Delete');
  log('project page /p/Smoke%20project; Delete on the copy → trash (toast with Undo)');
  // The trash: Restore brings it back.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trash' }).click();
  await page.waitForURL(`${origin}/trash`, { timeout: 10_000 });
  await page.getByText('Items are kept for 30 days.').waitFor({ timeout: 5_000 });
  await auditOrFail('trash');
  await page.getByRole('button', { name: 'Restore Smoke poster copy' }).click();
  await toasted('Restored “Smoke poster copy”', 'Restore');
  await page.getByText('The trash is empty.').waitFor({ timeout: 5_000 });
  log('Trash → Restore "Smoke poster copy" (toast with Open); the trash is empty');
  // Files: list view, then import an image through the toolbar's Import (Mod+I opens the same picker).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Files' }).click();
  await page.waitForURL(`${origin}/files`, { timeout: 10_000 });
  await page.getByRole('radio', { name: 'List' }).click();
  await page.waitForURL(`${origin}/files?view=list`, { timeout: 5_000 }).catch(() => fail('the list layout did not reach the URL (view param, replaced)'));
  const rows = await page.locator('ul.list li.row[data-asset]').count();
  if (rows !== 2) fail(`Files (list) should show the 2 designs: ${rows}`);
  await auditOrFail('Files (list)');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import' }).click();
  await (await chooser).setFiles({ name: 'smoke-dot.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1X1, 'base64') });
  await toasted('Imported “smoke-dot”', 'Import');
  await page.locator('li.row', { hasText: 'smoke-dot' }).locator('img.preview').waitFor({ timeout: 10_000 }).catch(() => fail('the imported image shows no preview'));
  log('Files: List (URL ?view=list), 2 rows; Import → "smoke-dot" listed with its preview');
  if (screenshot !== undefined) await page.screenshot({ path: `${screenshot}-files.png`, fullPage: true });

  // ---------------------------------------------------------------- reopen it: Studio applied what Home changed
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click();
  await recents.getByRole('link', { name: /^Smoke poster(?! copy)/ }).click();
  await page.waitForURL(new RegExp(`/s/${asset}(\\?|$)`), { timeout: 60_000 });
  await studioReady(page);
  const reopened = await inspect(page);
  const again = reopened.elements.find((e) => e.id === shape);
  if (reopened.elements.length !== 1 || again === undefined || Math.abs(again.x - drawn.x) > 0.01 || Math.abs(again.w - drawn.w) > 0.01) {
    fail(`the reopened design lost its shape: ${JSON.stringify({ drawn, reopened: reopened.elements })}`);
  }
  const title = await page.evaluate(() => window.__studio.scene.title);
  if (title !== 'Smoke poster') fail(`Studio should open the renamed design as "Smoke poster": "${title}"`);
  const library = await page.evaluate(() =>
    window.__studio.library
      .entries()
      .map((e) => `${e.title}|${e.folder}|${e.trashedAt === undefined ? 'live' : 'trash'}`)
      .sort(),
  );
  const want = ['Smoke poster copy|Smoke project|live', 'Smoke poster||live', 'smoke-dot||live'].sort();
  if (JSON.stringify(library) !== JSON.stringify(want)) fail(`the library should hold what Home did: ${JSON.stringify(library)}`);
  const journal = await page.evaluate(async () => {
    const head = await window.__session.workspace.store.readHead('home-journal', new AbortController().signal);
    return head.ok ? (head.value?.app?.journal?.ops ?? []).length : -1;
  });
  if (journal !== 0) fail(`Studio should drain Home's journal: ${journal} ops left`);
  log(`reopened ${asset}: title "${title}", shape ${shape} there; the library has the copy (in its project) and the image; journal drained`);
  if (!(studioGpu > 0)) log('note: Studio made no GPU adapter request through navigator.gpu on main (the render worker owns the device)');

  // ---------------------------------------------------------------- B11c: Settings, density, deep links, fallbacks
  // Settings from ⋯ is a routable dialog: pushed in-app, Back closes it; `Mod+.` cycles the density on this device.
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings…' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await settingsDialog.waitFor({ timeout: 10_000 }).catch(() => fail('⋯ › Settings… opened no dialog'));
  await page.waitForURL(new RegExp(`/s/${asset}/d/settings(\\?|$)`), { timeout: 5_000 }).catch(() => fail('Settings did not push /d/settings'));
  await settingsDialog.getByRole('link', { name: 'Keyboard shortcuts' }).click();
  await page.waitForURL(new RegExp(`/s/${asset}/d/settings\\?section=shortcuts`), { timeout: 5_000 }).catch(() => fail('the Shortcuts section did not reach the URL'));
  await auditOrFail('Settings dialog');
  await page.goBack();
  await settingsDialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => fail('Back did not close the Settings dialog'));
  await page.locator('if-studio').locator('.surface').focus();
  await page.keyboard.press('Control+.');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-sf-density') === 'pro', null, { timeout: 10_000 }).catch(() => fail('Mod+. did not switch to Pro'));
  await toasted('Pro · Everything, with numbers.', 'Mod+.');
  await page.locator('if-studio').locator('.undo-label, .zoom-text').first().waitFor({ timeout: 5_000 }).catch(() => fail('Pro shows no undo label or zoom text'));
  log('Settings: ⋯ › Settings… pushed /d/settings, the section is in the URL, Back closed it; Mod+. → Pro (root density, toast, zoom text)');
  // A cold boot of a link: the element is selected, the inspector's Fill is revealed, the dialog opens last; Escape on
  // the deep-linked dialog replaces the path (never leaves the design); the intents are stripped.
  await page.goto(`${origin}/s/${asset}/d/export?el=${shape},e_gone&inspect=fill`);
  await studioReady(page);
  const exportDialog = page.getByRole('dialog', { name: 'Export' });
  await exportDialog.waitFor({ timeout: 30_000 }).catch(() => fail('the deep-linked Export dialog did not open'));
  const linked = await page.evaluate(() => [...(window.__studio.tab?.view.selection ?? [])]);
  if (JSON.stringify(linked) !== JSON.stringify([shape])) fail(`el= should select the shape: ${JSON.stringify(linked)}`);
  await toasted('1 of 2 linked elements are no longer in this design', 'the half-missing el=');
  await page.keyboard.press('Escape');
  await exportDialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => fail('Escape did not close the deep-linked dialog'));
  await page.waitForURL(`${origin}/s/${asset}`, { timeout: 5_000 }).catch(async () => fail(`Escape should replace the path with the design's: ${page.url()}`));
  const density = await page.evaluate(() => window.__studio.studio.density);
  if (density !== 'pro') fail(`the density is remembered per device: ${density}`);
  log('link /d/export?el=…&inspect=fill: shape selected, the missing id named once, Export opened last; Escape → /s/:asset; Pro remembered');
  // Missing targets (NAVIGATION §4): a design that is not here gets the Home-shell page, no toast.
  await page.goto(`${origin}/s/as_not_here`);
  await page.getByRole('heading', { level: 1, name: 'This design isn’t on this device' }).waitFor({ timeout: 30_000 }).catch(async () => fail(`/s/as_not_here showed no fallback page: ${JSON.stringify(await page.locator('body').innerHTML())} ${JSON.stringify(errors)}`));
  await auditOrFail('missing design');
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await homeReady(page);
  log('missing design: /s/as_not_here → "This design isn’t on this device" → Go to Home');

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
