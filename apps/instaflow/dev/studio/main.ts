/**
 * Studio's dev entry (B8; B9: the editor and render modules in workers). Main opens the store side (an in-memory
 * workspace: store, blobs, library document) and boots the workers in the D15 topology — one worker by default,
 * two with `?topology=split` (the `instaflow/sequencing-topology` boot setting; `?render-tick=main-raf` picks the
 * main-rAF tick experiment). The editor worker creates a new two-page document, loads the authoring Wasm and the
 * bundled OFL fonts; the render worker loads the render Wasm and draws with Vello on the transferred canvas. Nothing
 * is saved across reloads yet (OPFS storage lands with C0). `window.__studio` exposes the app for the smoke check and
 * devtools.
 */
import type { FlagDefinition } from '@staticflux/config';
import { createInjector, createScope, ok, type Result } from '@staticflux/core';
import { browserEnv, readWebApis } from '@staticflux/platform';
import { TextInputFactoryToken, textInputBindings } from '@staticflux/surface/text-input';
import { compileTheme } from '@staticflux/ui/theme';
import { fromWorker } from '@staticflux/worker';
import { openStudioWorkspace } from '../../src/app/document.js';
import { createStudioApp, type StudioApp } from '../../src/app/studio-app.js';
import { resolveSequencingSettings } from '../../src/sequencing/sequencing.bindings.js';
import { cleanPopTheme } from '../../src/theme/clean-pop.js';

const MANIFEST = '/engine/dist/sf-wasm-manifest.json';
const FONTS = ['NotoSans-Latin.wght.ttf', 'NotoSansArabic.wght.ttf', 'NotoSansDevanagari.wght.ttf', 'NotoSansThai.wght.ttf'].map((f) => `/test/fonts/${f}`);
const status = document.getElementById('boot') as HTMLElement;
const query = new URLSearchParams(location.search);

const must = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} ${r.error.message}${r.error.cause instanceof Error ? ` (${r.error.cause.message})` : ''}`);
  return r.value;
};

/** Boot settings from the URL (`?instaflow/sequencing-topology=split`, or the short `?topology=split`). */
function readFlag<T>(flag: FlagDefinition<T>): T {
  const short = flag.key.split('/')[1]?.replace('sequencing-', '') ?? flag.key;
  const raw = query.get(flag.key) ?? query.get(short);
  if (raw === null) return flag.defaultValue;
  const parsed = flag.schema.parse(raw);
  return parsed.ok ? parsed.value : flag.defaultValue;
}

async function main(): Promise<StudioApp> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const scope = createScope('instaflow/studio-dev');
  const signal = scope.signal;
  const workspace = must(await openStudioWorkspace({ signal }), 'workspace');
  // TextInput: EditContext where the platform has it, else the hidden textarea (a variant binding, not a branch).
  const input = createInjector({ units: textInputBindings({ editContext: () => readWebApis(browserEnv()).editContext }) });
  const textInput = must(await input.get(TextInputFactoryToken), 'text input');
  const settings = resolveSequencingSettings(readFlag);
  const app = must(
    await createStudioApp({
      workspace,
      document: { asset: 'as_demo', title: 'Night Market Flyer', create: { pages: 2 } },
      person: { kind: 'human', id: 'guest-local', displayName: 'You', via: 'direct' },
      workers: {
        settings,
        spawn: (plan) => () => {
          const worker = new Worker(new URL('../../src/workers/studio.worker.ts', import.meta.url), { type: 'module', name: plan.name });
          return ok({ port: fromWorker(worker), terminate: () => worker.terminate() });
        },
        isolation: { crossOriginIsolated: globalThis.crossOriginIsolated === true },
        assets: { manifest: new URL(MANIFEST, location.href).href, fonts: FONTS.map((f) => new URL(f, location.href).href) },
      },
      textInput,
      isMac: /Mac/.test(navigator.platform),
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
