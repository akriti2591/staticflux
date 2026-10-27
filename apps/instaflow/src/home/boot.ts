/**
 * Home's boot (C0; D17; IF-28.23–28.25; B11c): the light boot path. It compiles the Clean Pop theme, opens the
 * workspace's document store (IndexedDB) to read the Home index and write Home's journal, and renders `<if-home>` with
 * the Home model in an injector scope, with messaging (toasts) under the strict overlay policy. No document engine, no
 * GPU, no worker: the import graph of this entry is held by `home-imports.test.ts` and its size by `.size-limit.json`
 * ("@instaflow/app/home"). The blob store (import, media previews) loads on first use.
 *
 * The index is read again when the page comes back from the back/forward cache, when the tab becomes visible and when
 * Studio pings `HOME_JOURNAL_CHANNEL` (it rewrote the index), so a design edited in Studio shows up without a reload.
 * Home's pages are one boot: `/files`, `/p/:name`, `/templates` and `/trash` push history; Back and Forward follow.
 */
import { createInjector, err, ok, type Result, type Scope, unit } from '@staticflux/core';
import type { DocumentStore } from '@staticflux/document/v2';
import { defineSurfaces } from '@staticflux/kit/surfaces';
import { SurfaceManagerToken } from '@staticflux/messaging';
import { allowAllDecideUnit, defineUiElements, provideScope, visibilityObserverUnit } from '@staticflux/ui';
import { compileTheme } from '@staticflux/ui/theme';
import { html, render } from 'lit';
import { createToasts, INSTAFLOW_SURFACE_UNITS, type Toasts, ToastsToken } from '../app/feedback.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { openWorkspaceDocuments } from '../workspace/browser.js';
import { HomeIndexReadError } from './errors.js';
import { defineHome, type IfHomeElement } from './home-element.js';
import { HOME_JOURNAL_CHANNEL } from './journal.js';
import { createHomeModel, type HomeHost, type HomeImporter, type HomeModel, storeIndexSource, storeJournalWriter } from './model.js';
import { createPreviewSource } from './previews.js';
import { readHomeView } from './routes.js';
import { HomeModelToken } from './tokens.js';

export interface BootHomeOptions {
  /** Where Home renders. */
  readonly container: HTMLElement;
  /** Everything is disposed with it (rule 5). */
  readonly scope: Scope;
  /** The workspace's document store (default: the local workspace in IndexedDB). */
  readonly store?: Pick<DocumentStore, 'readHead' | 'writeHead'>;
  /** How Home leaves for Studio and moves between its pages (default: `location.assign`, `history.pushState`). */
  readonly host?: HomeHost;
  /** The importer (default: over the workspace blobs in OPFS, loaded on first use). */
  readonly importer?: () => Promise<HomeImporter>;
  /** Add the compiled theme to the document (default true; tests that bring their own theme pass false). */
  readonly theme?: boolean;
}

export interface BootedHome {
  readonly model: HomeModel;
  readonly element: IfHomeElement;
  readonly toasts: Toasts;
}

/** Structurally a `BroadcastChannel`. */
interface Channel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: () => void, options?: { signal?: AbortSignal }): void;
  close(): void;
}

/** Boot Home into `container` (see the module header). */
export async function bootHome(options: BootHomeOptions): Promise<Result<BootedHome>> {
  const { container, scope } = options;
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  if (options.theme !== false) {
    const style = doc.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    doc.head.append(style);
    scope.defer(() => style.remove());
  }
  let store = options.store;
  if (store === undefined) {
    const opened = openWorkspaceDocuments();
    if (!opened.ok) return err(HomeIndexReadError({ cause: opened.error }));
    scope.defer(() => void opened.value.dispose());
    store = opened.value.store;
  }
  const ChannelCtor = (view as unknown as { BroadcastChannel?: new (name: string) => Channel } | null)?.BroadcastChannel;
  const channel = ChannelCtor === undefined ? undefined : new ChannelCtor(HOME_JOURNAL_CHANNEL);
  if (channel !== undefined) scope.defer(() => channel.close());
  const host: HomeHost = options.host ?? {
    navigate: (href) => view?.location.assign(href),
    push: (href) => view?.history.pushState(null, '', href),
  };
  const importer = options.importer ?? (() => import('./importer.js').then((m) => m.openBrowserImporter()));
  const model = createHomeModel({
    source: storeIndexSource(store),
    journal: storeJournalWriter(store, () => channel?.postMessage({ kind: 'journal' })),
    importer,
    host,
    signal: scope.signal,
    view: readHomeView(`${view?.location.pathname ?? '/'}${view?.location.search ?? ''}`),
  });
  scope.defer(() => model.dispose());
  const injector = createInjector({
    units: [
      visibilityObserverUnit,
      allowAllDecideUnit,
      ...INSTAFLOW_SURFACE_UNITS,
      unit({ id: 'instaflow/home-model', provides: HomeModelToken, scope: 'app', create: () => model }),
      // Home's toasts (OVERLAYS-FEEDBACK §3.5: Mod+Z on Home runs the newest toast's Undo).
      unit({ id: 'instaflow/home-toasts', provides: ToastsToken, scope: 'app', deps: { required: { manager: SurfaceManagerToken } }, create: ({ manager }, context) => createToasts(manager, { scope: context.scope, level: 'app' }) }),
    ],
  });
  scope.defer(() => injector.dispose());
  const resolved = await injector.get(ToastsToken);
  if (!resolved.ok) return resolved;
  const toasts = resolved.value;

  defineUiElements();
  defineSurfaces();
  defineHome();
  const provided = provideScope(container, { injector, name: 'instaflow/home' });
  scope.defer(() => provided.dispose());
  const previews = createPreviewSource({ open: () => import('../workspace/blobs.js').then(async (m) => (await m.openWorkspaceBlobs()).blobs), signal: scope.signal });
  render(html`<if-home .previews=${previews}></if-home><sf-surface-layer></sf-surface-layer>`, container);
  scope.defer(() => render(html``, container));
  const element = container.querySelector('if-home') as IfHomeElement;

  // Recents stay fresh when the person comes back from Studio without a reload, or Studio rewrote the index.
  const refresh = (): void => void model.refresh();
  view?.addEventListener('pageshow', (e) => ((e as PageTransitionEvent).persisted ? refresh() : undefined), { signal: scope.signal });
  doc.addEventListener('visibilitychange', () => (doc.visibilityState === 'visible' ? refresh() : undefined), { signal: scope.signal });
  channel?.addEventListener('message', refresh, { signal: scope.signal });
  // Back and Forward between Home's pages.
  view?.addEventListener('popstate', () => model.show(readHomeView(`${view.location.pathname}${view.location.search}`)), { signal: scope.signal });
  return ok({ model, element, toasts });
}
