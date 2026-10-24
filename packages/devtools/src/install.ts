/**
 * `installDevtools({ injector, telemetry, … })` — one-line opt-in.
 *
 * Attaches the collector, applies the session debug flag (`?sf-debug=…` or the
 * tab-session copy), binds sources the app already resolved, and registers the
 * Ctrl/Cmd+Shift+D shortcut on a scope-bound listener. The Lit panel is NOT
 * imported here: it is loaded on first open from `@staticflux/devtools/panel`
 * (its own chunk), so the collector runs without UI code.
 *
 * Production builds exclude devtools entirely with a dev-only dynamic import:
 *
 * ```ts
 * if (import.meta.env.DEV) {
 *   const { installDevtools } = await import('@staticflux/devtools');
 *   installDevtools({ injector: app.injector });
 * }
 * ```
 */
import { err, type Injector, ok, type Result, type Telemetry } from '@staticflux/core';
import { createDevtools, type Devtools, type DevtoolsOptions, type DevtoolsSources } from './devtools.js';
import { NoDomError, PanelLoadFailedError, SourceNotBoundError } from './errors.js';
import { readDebugFlag, readSessionFlag, type LevelEntry, type SessionStoragePort } from './levels.js';
import type { DevtoolsTab } from './tabs.js';

/** Minimal surface of the panel element the installer drives (implemented by `<sf-devtools>`). */
export interface DevtoolsPanelElement extends HTMLElement {
  devtools: Devtools | undefined;
  open: boolean;
  tab: DevtoolsTab;
}

/** What `@staticflux/devtools/panel` exports (the installer's lazy-load contract). */
export interface DevtoolsPanelModule {
  definePanel(registry?: CustomElementRegistry): Result<void>;
  readonly PANEL_TAG: string;
}

export type ShortcutMatcher = (event: KeyboardEvent) => boolean;

/** Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS). */
export const defaultShortcut: ShortcutMatcher = (event) =>
  (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.code === 'KeyD' || event.key.toLowerCase() === 'd');

export interface InstallDevtoolsOptions extends Omit<DevtoolsOptions, 'telemetry'> {
  /** Defaults to `injector.telemetry`. One of `telemetry` / `injector` is required. */
  readonly telemetry?: Telemetry;
  readonly injector?: Injector;
  /** URL whose `sf-debug` parameter is applied (default `location.href` when available; `null` to skip). */
  readonly url?: string | URL | null;
  /** Keep the applied flag for the rest of the tab session (default true when a session store exists). */
  readonly persistDebug?: boolean;
  /** `false` disables the keyboard shortcut. */
  readonly shortcut?: ShortcutMatcher | false;
  /** Where the shortcut listener goes (default `window`/`document`). */
  readonly keyTarget?: EventTarget;
  /** Where the panel is appended (default `document.body`). */
  readonly container?: () => HTMLElement | undefined;
  /** Lazy panel loader (default: dynamic import of `./panel.js`). */
  readonly loadPanel?: () => Promise<DevtoolsPanelModule>;
  /** Open the panel immediately. */
  readonly open?: boolean;
}

export interface DevtoolsInstallation {
  readonly devtools: Devtools;
  /** Entries applied from `?sf-debug` / the session copy (empty when none). */
  readonly debugEntries: readonly LevelEntry[];
  readonly isOpen: boolean;
  open(tab?: DevtoolsTab): Promise<Result<void>>;
  close(): void;
  toggle(): Promise<Result<void>>;
  dispose(): Promise<void>;
}

const defaultLoadPanel = (): Promise<DevtoolsPanelModule> => import('./panel.js');

function defaultSession(): SessionStoragePort | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function defaultUrl(): string | undefined {
  return typeof location === 'undefined' ? undefined : location.href;
}

export function installDevtools(options: InstallDevtoolsOptions): Result<DevtoolsInstallation> {
  const telemetry = options.telemetry ?? options.injector?.telemetry;
  if (telemetry === undefined) {
    return err(SourceNotBoundError({ message: 'installDevtools needs `telemetry` or `injector`.', fix: 'Pass `installDevtools({ injector: app.injector })`.' }));
  }
  const session = options.session === undefined ? defaultSession() : options.session;
  const { url: _url, persistDebug: _persist, shortcut: _shortcut, keyTarget: _kt, container: _c, loadPanel: _lp, open: _open, ...rest } = options;
  const devtools = createDevtools({ ...rest, telemetry, session });

  // ---- session debug flag (R17.14)
  let debugEntries: readonly LevelEntry[] = [];
  const url = options.url === null ? undefined : (options.url ?? defaultUrl());
  const fromUrl = url === undefined ? undefined : readDebugFlag(url);
  const flag = fromUrl ?? readSessionFlag(session);
  if (flag !== undefined) {
    const applied = devtools.verbosity.applyFlag(flag);
    if (applied.ok) {
      debugEntries = applied.value;
      if (options.persistDebug ?? true) devtools.verbosity.persistSession(true);
    } else {
      telemetry.event('devtools.invalid-debug-flag', {
        subsystem: 'devtools/panel',
        level: 'critical',
        attrs: { code: applied.error.code, message: applied.error.message },
      });
    }
  }

  if (options.injector !== undefined) void devtools.bindFromInjector(options.injector);

  // ---- overlay
  let panel: DevtoolsPanelElement | undefined;
  let loading: Promise<Result<DevtoolsPanelElement>> | undefined;
  let isOpen = false;
  const loadPanel = options.loadPanel ?? defaultLoadPanel;

  const ensurePanel = (): Promise<Result<DevtoolsPanelElement>> => {
    if (panel !== undefined) return Promise.resolve(ok(panel));
    loading ??= (async (): Promise<Result<DevtoolsPanelElement>> => {
      if (typeof document === 'undefined' || typeof customElements === 'undefined') return err(NoDomError());
      let module: DevtoolsPanelModule;
      try {
        module = await loadPanel();
      } catch (cause) {
        return err(PanelLoadFailedError({ cause }));
      }
      const defined = module.definePanel();
      if (!defined.ok) return err(PanelLoadFailedError({ cause: defined.error }));
      const element = document.createElement(module.PANEL_TAG) as DevtoolsPanelElement;
      element.devtools = devtools;
      const host = options.container?.() ?? document.body;
      host.appendChild(element);
      element.addEventListener('sf-devtools-close', () => {
        isOpen = false;
      });
      devtools.scope.defer(() => element.remove());
      panel = element;
      return ok(element);
    })();
    const current = loading;
    void current.then((r) => {
      if (!r.ok && loading === current) loading = undefined;
    });
    return current;
  };

  const installation: DevtoolsInstallation = {
    devtools,
    debugEntries,
    get isOpen() {
      return isOpen;
    },
    async open(tab) {
      const element = await ensurePanel();
      if (!element.ok) return err(element.error);
      if (options.injector !== undefined) await devtools.bindFromInjector(options.injector);
      if (tab !== undefined) element.value.tab = tab;
      element.value.open = true;
      isOpen = true;
      return ok();
    },
    close() {
      if (panel !== undefined) panel.open = false;
      isOpen = false;
    },
    async toggle() {
      if (isOpen) {
        installation.close();
        return ok();
      }
      return installation.open();
    },
    dispose: () => devtools.dispose(),
  };

  // ---- shortcut (scope-bound; no a11y dependency)
  const matcher = options.shortcut === false ? undefined : (options.shortcut ?? defaultShortcut);
  const keyTarget = options.keyTarget ?? (typeof window === 'undefined' ? undefined : window);
  if (matcher !== undefined && keyTarget !== undefined) {
    devtools.scope.listen(keyTarget, 'keydown', (event) => {
      if (!(event instanceof KeyboardEvent) && !('key' in event)) return;
      if (!matcher(event as KeyboardEvent)) return;
      event.preventDefault();
      void installation.toggle();
    });
  }

  if (options.open === true) void installation.open();
  return ok(installation);
}

export type { DevtoolsSources };
