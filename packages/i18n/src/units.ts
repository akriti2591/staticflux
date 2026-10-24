/**
 * DI units. Apps register `i18nUnit` plus a config unit; packages contribute
 * their lazy catalog loaders to `CatalogLoadersToken`.
 *
 *   createInjector({ units: [
 *     i18nConfigUnit({ defaultLocale: 'en', available: ['en', 'fr', 'ar'], requested: navigator.languages }),
 *     catalogLoaderUnit(catalogLoader(studioMessages, { fr: () => import('./i18n/fr.js') })),
 *     i18nUnit,
 *   ]});
 */
import { effect, ok, type Scope, token, unit, type UnitDefinition } from '@staticflux/core';
import type { AnyMessages, CatalogLoader } from './messages.js';
import { createI18n, type I18n, type I18nConfig } from './service.js';

export const I18nConfigToken = /* @__PURE__ */ token('i18n/config').type<I18nConfig>();
export const CatalogLoadersToken = /* @__PURE__ */ token('i18n/catalog-loaders').multi<CatalogLoader>();
export const I18nToken = /* @__PURE__ */ token('i18n/service').type<I18n>();

type NoDeps = Record<never, never>;

const preloads = new WeakMap<I18n, readonly AnyMessages[]>();

/* @__NO_SIDE_EFFECTS__ */
export function i18nConfigUnit(config: I18nConfig): UnitDefinition<I18nConfig, NoDeps, 'i18n/config'> {
  return unit({ id: 'i18n/config-unit', provides: I18nConfigToken, scope: 'app', create: () => config });
}

/** Contribute a catalog loader (one per package/feature namespace). */
/* @__NO_SIDE_EFFECTS__ */
export function catalogLoaderUnit(
  loader: CatalogLoader,
  order?: number,
): UnitDefinition<readonly CatalogLoader[], NoDeps, 'i18n/catalog-loaders'> {
  return unit({
    id: `i18n/catalog-loader:${loader.namespace}`,
    provides: CatalogLoadersToken,
    scope: 'app',
    ...(order === undefined ? {} : { order }),
    // Multi-token contributions provide one item each; the injector collects them.
    create: () => loader as never,
  });
}

export const i18nUnit = unit({
  id: 'i18n/service-unit',
  provides: I18nToken,
  scope: 'app',
  deps: { required: { config: I18nConfigToken, loaders: CatalogLoadersToken } },
  create: ({ config, loaders }, ctx) => {
    const i18n = createI18n({ ...config, loaders, telemetry: ctx.telemetry, signal: ctx.signal });
    preloads.set(i18n, config.preload ?? []);
    return i18n;
  },
  /**
   * Loads the active locale's catalogs for `config.preload` (R14.2: only the active
   * locale blocks). A failed catalog degrades to source text; it never fails the unit.
   */
  async init(i18n, ctx) {
    const preload = preloads.get(i18n) ?? [];
    if (preload.length > 0) await i18n.load(preload, ctx.signal);
    return ok();
  },
  description: 'Locale service: reactive locale, lazy catalogs, ICU formatting, Intl helpers.',
});

/**
 * Keep `lang` and `dir` of an element (default: `<html>`) in sync with the
 * current locale (R14.4). Disposed with `scope`.
 */
export function bindDocumentLocale(i18n: I18n, element: Element | undefined, scope?: Scope): () => void {
  const target = element ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  if (target === undefined) return () => undefined;
  return effect(() => {
    target.setAttribute('lang', i18n.locale);
    target.setAttribute('dir', i18n.dir);
  }, scope);
}
