/**
 * Studio's dev entry (B8; B9: the editor and render modules in workers; C0: the persistent workspace and Home). Main
 * opens the store side over the local workspace — documents in IndexedDB, blobs in OPFS — and boots the workers in
 * the D15 topology: one worker by default, two with `?topology=split` (the `instaflow/sequencing-topology` boot
 * setting; `?render-tick=main-raf` picks the main-rAF tick experiment). The editor worker opens the document, loads the
 * authoring Wasm and the bundled OFL fonts; the render worker loads the render Wasm and draws with Vello on the
 * transferred canvas.
 *
 * Which document: the URL (`src/home/routes.ts`) — `/s/:asset` opens a design, `/new?format=…` or `/new?template=…`
 * makes one (the URL then becomes `/s/:asset`), and `/dev/studio/` opens the demo document (created on first use).
 * The logo goes back to Home (`/`) after saving; exports run in an export worker spawned per export (C1). `window.__studio` exposes the app (and `window.__session` the
 * session) for the smoke checks and devtools.
 *
 * B11c: a design that is not on this device, or is in the trash, shows `<if-missing-design>` at the same URL
 * (NAVIGATION §4); its Restore writes a Home journal op and reloads (the session drains the journal before it plans).
 *
 * #62: the Studio frame renders as soon as this script runs (`bootStudioPage`: inert, placeholders for the canvas,
 * the panels and the save state) while the session (`session.ts`, a separate chunk) loads and opens; `index.html`
 * preloads the Wasm (and, built, the worker chunk) the workers fetch at boot (`preload-plugin.ts`). `#boot` is the
 * loading line, then the failure (`role="alert"`).
 */
import { compileTheme } from '@staticflux/ui/theme';
import type { StudioApp } from '../../src/app/studio-app.js';
import { homeHref } from '../../src/home/routes.js';
import { cleanPopTheme } from '../../src/theme/clean-pop.js';
import { bootStudioPage } from '../../src/workspace/studio-page.js';
import type { StudioSession } from '../../src/workspace/studio-session.js';

// Theme first: the frame renders under Clean Pop before anything else loads.
const style = document.createElement('style');
style.textContent = compileTheme(cleanPopTheme);
document.head.append(style);

/**
 * After the frame's first paint (a task after the next animation frame; at most 200 ms, a hidden tab paints none):
 * the session module's evaluation blocks main while loro-crdt fetches its Wasm synchronously.
 */
const afterPaint = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 200);
  });
const session = (): Promise<typeof import('./session.js')> => afterPaint().then(() => import('./session.js'));
const home = homeHref();
void bootStudioPage({
  container: document.getElementById('studio') as HTMLElement,
  status: document.getElementById('boot') as HTMLElement,
  open: async () => (await session()).openSession(),
  missing: (details) => void session().then((s) => s.showMissing(details)),
  frame: { homeHref: home.ok ? home.value : '/' },
}).then((opened) => {
  if (opened === undefined) return;
  (window as unknown as { __studio: StudioApp; __session: StudioSession }).__studio = opened.app;
  (window as unknown as { __session: StudioSession }).__session = opened;
});
