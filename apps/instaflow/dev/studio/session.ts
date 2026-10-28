/**
 * The Studio page's session (#62: loaded by `main.ts` with a dynamic import, so the frame's chunk does not wait for the
 * workspace and document code, nor Loro's Wasm, which loro-crdt fetches synchronously when its module evaluates).
 * Opens the store side over the local workspace (documents in IndexedDB, blobs in OPFS) and boots the workers in the
 * D15 topology (see `main.ts`); `showMissing` is NAVIGATION §4's page for a design that is not here.
 */
import type { FlagDefinition } from '@staticflux/config';
import { createInjector, createScope, ok, type Result } from '@staticflux/core';
import { browserEnv, readWebApis } from '@staticflux/platform';
import { TextInputFactoryToken, textInputBindings } from '@staticflux/surface/text-input';
import { defineUiElements, provideScope } from '@staticflux/ui';
import { fromWorker } from '@staticflux/worker';
import { homeOp, appendHomeOps } from '../../src/home/journal.js';
import { defineMissingDesign, type IfMissingDesignElement } from '../../src/home/missing-design.js';
import { homeHref, newDesignRoute, readStudioIntent } from '../../src/home/routes.js';
import { resolveSequencingSettings } from '../../src/sequencing/sequencing.bindings.js';
import { openWorkspaceBlobs } from '../../src/workspace/blobs.js';
import { openWorkspaceDocuments } from '../../src/workspace/browser.js';
import { openStudioSession, type StudioSession } from '../../src/workspace/studio-session.js';

const MANIFEST = '/engine/dist/sf-wasm-manifest.json';
const FONTS = ['NotoSans-Latin.wght.ttf', 'NotoSansArabic.wght.ttf', 'NotoSansDevanagari.wght.ttf', 'NotoSansThai.wght.ttf'].map((f) => `/test/fonts/${f}`);
const query = new URLSearchParams(location.search);
/** Query keys that say which document to make (`/new`'s search params); every other key (boot settings) survives the URL replace. */
const DOCUMENT_KEYS = Object.keys(newDesignRoute.search ?? {});

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

/** The query without the document keys (`?topology=split` stays when `/new?format=post` becomes `/s/as_…`). */
function keptQuery(): string {
  const kept = new URLSearchParams(query);
  for (const key of DOCUMENT_KEYS) kept.delete(key);
  const text = kept.toString();
  return text.length === 0 ? '' : `?${text}`;
}

/** NAVIGATION §4: the design is not here (or is in the trash): a Home-shell page at the same URL, no toast. */
function showMissingFor(store: Parameters<typeof appendHomeOps>[0], details: Readonly<Record<string, unknown>>): void {
  defineUiElements();
  defineMissingDesign();
  const container = document.getElementById('studio') as HTMLElement;
  provideScope(container, { injector: createInjector({ units: [] }), name: 'instaflow/missing-design' });
  const home = homeHref();
  const page = document.createElement('if-missing-design') as IfMissingDesignElement;
  page.asset = String(details['asset'] ?? '');
  page.trashed = details['trashed'] === true;
  page.designTitle = typeof details['title'] === 'string' ? details['title'] : '';
  page.homeHref = home.ok ? home.value : '/';
  page.addEventListener('if-restore', () => {
    void appendHomeOps(store, [homeOp({ kind: 'restore', assets: [page.asset] })], new AbortController().signal).then((done) => {
      if (done.ok) location.reload();
      else page.restoreFailed();
    });
  });
  container.replaceChildren(page);
  document.title = `${page.trashed ? 'In the trash' : 'Not on this device'} · Instaflow`;
  void page.focusPrimary();
}

/** The session behind the frame: the workspace, the workers (Wasm, fonts) and the document. */
let store: Parameters<typeof appendHomeOps>[0] | undefined;
export async function openSession(): Promise<Result<StudioSession>> {
  const scope = createScope('instaflow/studio-dev');
  const documents = must(openWorkspaceDocuments(), 'workspace store');
  store = documents.store;
  const { blobs } = await openWorkspaceBlobs();
  // TextInput: EditContext where the platform has it, else the hidden textarea (a variant binding, not a branch).
  const input = createInjector({ units: textInputBindings({ editContext: () => readWebApis(browserEnv()).editContext }) });
  const textInput = must(await input.get(TextInputFactoryToken), 'text input');
  const settings = resolveSequencingSettings(readFlag);
  return openStudioSession({
    intent: readStudioIntent(`${location.pathname}${location.search}`),
    documents: documents.store,
    blobs,
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
    // C1: one export worker per export (headless Vello, the export Wasm on demand); files go to the downloads.
    exporter: {
      spawn: () => () => {
        const worker = new Worker(new URL('../../src/export/export.worker.ts', import.meta.url), { type: 'module', name: 'export' });
        return ok({ port: fromWorker(worker), terminate: () => worker.terminate() });
      },
    },
    textInput,
    isMac: /Mac/.test(navigator.platform),
    replaceUrl: (href) => history.replaceState(null, '', `${href}${keptQuery()}`),
    scope,
  });
}

/** The missing-design page in `#studio` (after `openSession` reported `UnknownDesignError`). */
export function showMissing(details: Readonly<Record<string, unknown>>): void {
  if (store !== undefined) showMissingFor(store, details);
}
