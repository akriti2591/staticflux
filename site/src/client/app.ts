/**
 * The site's composition: every unit the page needs, declared — not wired.
 *
 *   runtime   frame scheduler (one render pass per frame for every component)
 *   ui        render scheduler, visibility, isolation, decide port, UI environment
 *   shell     ThemeController over the site's themes, persisted in an AsyncStore
 *   storage   localStorage → memory fallback behind the async interface
 *   a11y      announcer (live region) for "Copied" / theme changes
 *   urlstate  URL ⇄ store sync for `?layer=` on the packages page
 *   hydrate   islands hydrator: loads island chunks through `virtual:sf-chunks`
 *
 * Only the theme controller is `critical` (boot waits for it so the theme is applied
 * before islands hydrate); everything else resolves lazily the first time something asks.
 */
import {
  attemptAsync,
  box,
  type Box,
  createMemorySink,
  createTelemetry,
  err,
  type Registration,
  type TelemetryRecord,
  type TelemetrySink,
  token,
  unit,
} from '@staticflux/core';
import { browserA11yEnvironmentUnit, announcerUnit } from '@staticflux/a11y';
import { createIslandHydrator, type IslandChunkLoader, type IslandHydrator } from '@staticflux/hydrate';
import { frameSchedulerUnit, bootApp, type App } from '@staticflux/runtime';
import { createThemeController, defineTheme, ThemeControllerToken, ThemePreferenceStoreToken } from '@staticflux/shell';
import { createLocalStorageStore, createMemoryStore, createStore } from '@staticflux/storage';
import { uiUnits } from '@staticflux/ui';
import {
  browserHistoryUnit,
  boxAdapter,
  rafSchedulerUnit,
  urlDeclarationRegistryUnit,
  urlDeclarationUnit,
  urlSyncUnit,
  UrlSyncToken,
} from '@staticflux/urlstate';
import { importChunk } from 'virtual:sf-chunks';
import { darkSiteTheme, highContrastSiteTheme, lightSiteTheme, type SiteTheme } from '../shared/theme-tokens.js';
import { UnknownIslandError } from './errors.js';
import { BootTraceToken, LayerBinding, type LayerId, PackageFilterToken } from './contracts.js';

const toShellTheme = (theme: SiteTheme) =>
  defineTheme({ id: theme.id, scheme: theme.scheme, contrast: theme.contrast, tokens: theme.tokens });


// ------------------------------------------------------------------ theme (shell + storage)

const themeStoreUnit = unit({
  id: 'site/theme-store-unit',
  provides: ThemePreferenceStoreToken,
  scope: 'app',
  create: (_deps, ctx) => {
    // One async interface over any backend: localStorage when usable, memory otherwise
    // (private mode, sandboxed iframes). Never a synchronous storage API in app code.
    const created = createStore<string>({ backend: [createLocalStorageStore<string>({ prefix: 'sf-site:' }), () => createMemoryStore<string>()] });
    const store = created.ok ? created.value : createMemoryStore<string>();
    ctx.scope.defer(() => store.dispose());
    return store;
  },
  description: 'Theme preference persistence (AsyncStore, localStorage → memory).',
});

const siteThemeUnit = unit({
  id: 'site/theme-controller-unit',
  provides: ThemeControllerToken,
  scope: 'app',
  critical: true,
  deps: { required: { store: ThemePreferenceStoreToken } },
  create: ({ store }, ctx) =>
    createThemeController({
      light: toShellTheme(lightSiteTheme),
      dark: toShellTheme(darkSiteTheme),
      highContrast: toShellTheme(highContrastSiteTheme),
      store,
      telemetry: ctx.telemetry,
    }),
  init: async (controller, ctx) => {
    await controller.restore(ctx.signal); // a missing/unreadable preference keeps `system`
    controller.apply(document.documentElement, ctx.scope);
    return { ok: true, value: undefined };
  },
  description: 'Light / dark / high-contrast, following the system unless the reader chose one.',
});

// ------------------------------------------------------------------ packages page filter (urlstate)

const packageFilterUnit = unit({
  id: 'site/package-filter-unit',
  provides: PackageFilterToken,
  scope: 'app',
  deps: { required: { urlSync: UrlSyncToken } },
  create: ({ urlSync }, ctx) => {
    const filter = { layer: box<LayerId | undefined>(undefined), query: box('') };
    // URL ⇄ store, batched per frame. The store never reads the URL itself.
    urlSync.bind(LayerBinding, boxAdapter(filter.layer), ctx.scope);
    return filter;
  },
  description: 'Layer (URL-bound) + text filter of the packages reference.',
});

// ------------------------------------------------------------------ boot trace (telemetry fabric)

function bootTraceUnit(sink: { readonly records: readonly TelemetryRecord[] }, version: Box<number>) {
  return unit({
    id: 'site/boot-trace-unit',
    provides: BootTraceToken,
    scope: 'app',
    create: () => ({ version, records: () => sink.records }),
    description: 'Spans recorded by this page since boot (memory sink).',
  });
}

// ------------------------------------------------------------------ islands (hydrate + loader manifest)

export const IslandHydratorToken = token('site/island-hydrator').type<IslandHydrator>();

/** Island chunks resolve through the Vite plugin's `virtual:sf-chunks` (stable logical ids → hashed files). */
const islandLoader: IslandChunkLoader = {
  load: (async (id: string) => {
    const loaded = await attemptAsync(() => importChunk(id));
    return loaded.ok ? loaded : err(UnknownIslandError({ details: { chunk: id }, cause: loaded.error }));
  }) as IslandChunkLoader['load'],
};

const islandHydratorUnit = unit({
  id: 'site/island-hydrator-unit',
  provides: IslandHydratorToken,
  scope: 'app',
  create: (_deps, ctx) =>
    createIslandHydrator({
      loader: islandLoader,
      telemetry: ctx.telemetry,
      scope: ctx.scope,
      onIssue: (issue) => console.warn(`[site] ${issue.code}: ${issue.message}`, issue.fix ?? ''),
    }),
  description: 'Partial hydration of the prerendered pages (visible / idle / interaction).',
});

export function siteUnits(sink: { readonly records: readonly TelemetryRecord[] }, version: Box<number>): readonly Registration[] {
  return [
    frameSchedulerUnit,
    ...uiUnits,
    themeStoreUnit,
    siteThemeUnit,
    browserA11yEnvironmentUnit,
    announcerUnit(),
    browserHistoryUnit,
    rafSchedulerUnit,
    urlDeclarationUnit(LayerBinding),
    urlDeclarationRegistryUnit,
    urlSyncUnit,
    packageFilterUnit,
    bootTraceUnit(sink, version),
    islandHydratorUnit,
  ];
}

/** Boot: injector → supervisor → critical units (theme) → running; then hydrate islands. */
export async function bootSite(): Promise<App | undefined> {
  const telemetry = createTelemetry({ defaultLevel: 'verbose' });
  const memory = createMemorySink();
  const version = box(0);
  let bumpQueued = false;
  const counting: TelemetrySink = {
    receive(record) {
      memory.receive(record);
      if (record.type !== 'span' || bumpQueued) return;
      // Coalesce: one reactive bump per microtask, never inside a reaction or derivation.
      bumpQueued = true;
      queueMicrotask(() => {
        bumpQueued = false;
        version.set(version.get() + 1);
      });
    },
  };
  telemetry.addSink(counting);

  const booted = await bootApp({ units: siteUnits(memory, version), telemetry });
  if (!booted.ok) {
    // Static HTML stays fully usable; only the islands are skipped.
    console.warn(`[site] boot failed: ${booted.error.code} — ${booted.error.fix ?? booted.error.message}`);
    return undefined;
  }
  const app = booted.value;
  const hydrator = await app.injector.get(IslandHydratorToken);
  if (hydrator.ok) hydrator.value.start(document.body, { injector: app.injector });
  return app;
}
