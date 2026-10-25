/**
 * Home's boot (C0; D17; IF-28.23–28.25): the light boot path. It compiles the Clean Pop theme, opens the workspace's
 * document store (IndexedDB) to read the Home index, and renders `<if-home>` with the Home model in an injector scope.
 * No document engine, no GPU, no worker: the import graph of this entry is held by `home-imports.test.ts` and its
 * size by `.size-limit.json` ("@instaflow/app/home").
 *
 * The index is read again when the page comes back from the back/forward cache or the tab becomes visible, so a design
 * edited in Studio shows up in recents without a reload.
 */
import { createInjector, err, ok, type Result, type Scope, unit } from '@staticflux/core';
import type { DocumentStore } from '@staticflux/document/v2';
import { defineUiElements, provideScope } from '@staticflux/ui';
import { compileTheme } from '@staticflux/ui/theme';
import { html, render } from 'lit';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { openWorkspaceDocuments } from '../workspace/browser.js';
import { HomeIndexReadError } from './errors.js';
import { defineHome, type IfHomeElement } from './home-element.js';
import { createHomeModel, type HomeHost, type HomeModel, storeIndexSource } from './model.js';
import { HomeModelToken } from './tokens.js';

export interface BootHomeOptions {
  /** Where Home renders. */
  readonly container: HTMLElement;
  /** Everything is disposed with it (rule 5). */
  readonly scope: Scope;
  /** The workspace's document store (default: the local workspace in IndexedDB). */
  readonly store?: Pick<DocumentStore, 'readHead'>;
  /** How Home leaves for Studio (default: `location.assign`). */
  readonly host?: HomeHost;
  /** Add the compiled theme to the document (default true; tests that bring their own theme pass false). */
  readonly theme?: boolean;
}

export interface BootedHome {
  readonly model: HomeModel;
  readonly element: IfHomeElement;
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
  const host: HomeHost = options.host ?? { navigate: (href) => view?.location.assign(href) };
  const model = createHomeModel({ source: storeIndexSource(store), host, signal: scope.signal });
  scope.defer(() => model.dispose());
  const injector = createInjector({ units: [unit({ id: 'instaflow/home-model', provides: HomeModelToken, scope: 'app', create: () => model })] });
  scope.defer(() => injector.dispose());

  defineUiElements();
  defineHome();
  const provided = provideScope(container, { injector, name: 'instaflow/home' });
  scope.defer(() => provided.dispose());
  render(html`<if-home></if-home>`, container);
  scope.defer(() => render(html``, container));
  const element = container.querySelector('if-home') as IfHomeElement;

  // Recents stay fresh when the person comes back from Studio without a reload.
  const refresh = (): void => void model.refresh();
  view?.addEventListener('pageshow', (e) => ((e as PageTransitionEvent).persisted ? refresh() : undefined), { signal: scope.signal });
  doc.addEventListener('visibilitychange', () => (doc.visibilityState === 'visible' ? refresh() : undefined), { signal: scope.signal });
  return ok({ model, element });
}
