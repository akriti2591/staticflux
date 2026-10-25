/**
 * Studio's dev entry (B8): loads the engine Wasm (render, geometry, text) and the bundled OFL fonts, opens a new
 * two-page document in an in-memory workspace, and mounts Studio with the Vello canvas. Nothing is saved across
 * reloads yet (OPFS storage lands with C0). `window.__studio` exposes the app for the smoke check and devtools.
 */
import { createInjector, createScope, type Result } from '@staticflux/core';
import { browserEnv, readWebApis } from '@staticflux/platform';
import { TextInputFactoryToken, textInputBindings } from '@staticflux/surface/text-input';
import { compileTheme } from '@staticflux/ui/theme';
import { createStudioDocument, openStudioWorkspace } from '../../src/app/document.js';
import { createStudioFonts, type FontFile } from '../../src/app/fonts.js';
import { createStudioApp, type StudioApp } from '../../src/app/studio-app.js';
import { createVelloRaster } from '../../src/app/vello-raster.js';
import { createGeometry, loadAuthoringModule as loadGeometryModule } from '../../src/elements/geometry.js';
import { loadRenderModule } from '../../src/render/render-module.js';
import { loadAuthoringModule as loadTextModule } from '../../src/text/authoring-module.js';
import { cleanPopTheme } from '../../src/theme/clean-pop.js';

const MANIFEST = '/engine/dist/sf-wasm-manifest.json';
const FONTS = ['NotoSans-Latin.wght.ttf', 'NotoSansArabic.wght.ttf', 'NotoSansDevanagari.wght.ttf', 'NotoSansThai.wght.ttf'];
const status = document.getElementById('boot') as HTMLElement;

const must = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} ${r.error.message}`);
  return r.value;
};

async function font(file: string): Promise<FontFile> {
  const bytes = new Uint8Array(await (await fetch(`/test/fonts/${file}`)).arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { bytes, hash: `sha256:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}` };
}

async function main(): Promise<StudioApp> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const scope = createScope('instaflow/studio-dev');
  const signal = scope.signal;
  const [render, geometryWasm, textWasm, fonts] = await Promise.all([
    loadRenderModule({ manifestUrl: MANIFEST, signal }),
    loadGeometryModule({ manifestUrl: MANIFEST, signal }),
    loadTextModule({ manifestUrl: MANIFEST, signal }),
    Promise.all(FONTS.map(font)),
  ]);
  const renderWasm = must(render, 'render Wasm (run `pnpm build`)');
  const geometry = createGeometry(must(geometryWasm, 'authoring Wasm'));
  const studioFonts = must(createStudioFonts({ wasm: must(textWasm, 'text Wasm'), fonts, loadComplex: (s) => loadTextModule({ manifestUrl: MANIFEST, build: 'complex', ...(s === undefined ? {} : { signal: s }) }) }), 'fonts');
  const workspace = must(await openStudioWorkspace({ signal }), 'workspace');
  const doc = must(await createStudioDocument(workspace, { asset: 'as_demo', title: 'Night Market Flyer', pages: 2, signal }), 'document');
  // TextInput: EditContext where the platform has it, else the hidden textarea (a variant binding, not a branch).
  const input = createInjector({ units: textInputBindings({ editContext: () => readWebApis(browserEnv()).editContext }) });
  const textInput = must(await input.get(TextInputFactoryToken), 'text input');
  const app = must(
    await createStudioApp({
      workspace,
      doc,
      title: 'Night Market Flyer',
      geometry,
      fonts: studioFonts,
      person: { kind: 'human', id: 'guest-local', displayName: 'You', via: 'direct' },
      textInput,
      isMac: /Mac/.test(navigator.platform),
      raster: (canvas, size, s) => createVelloRaster({ wasm: renderWasm, canvas, width: size.width, height: size.height, devicePixelRatio: window.devicePixelRatio, signal: s }),
      scope,
    }),
    'studio',
  );
  app.mount(document.getElementById('studio') as HTMLElement);
  status.remove();
  return app;
}

main().then(
  (app) => {
    (window as unknown as { __studio: StudioApp }).__studio = app;
  },
  (error: unknown) => {
    status.textContent = `Studio could not start: ${error instanceof Error ? error.message : String(error)}`;
    status.setAttribute('role', 'alert');
    console.error(error);
  },
);
