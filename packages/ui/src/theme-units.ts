/**
 * Themes through DI (R2.11 contributions): packages and apps contribute themes to
 * `ThemesToken`; the appearance unit activates the last contributed one (contribution
 * `order` ascending), so an app theme overrides a package default without forking it.
 *
 * ```ts
 * units: [defaultThemeContribution, themeContribution(brandTheme, { order: 10 }), appearanceUnit]
 * ```
 */
import { contribution, ok, token, unit } from '@staticflux/core';
import { type Appearance, type AppearanceOptions, type AppearanceStore, createAppearance } from './theme-appearance.js';
import type { AnyThemeDef } from './theme-define.js';

/** Multi: contributed themes. */
export const ThemesToken = /* @__PURE__ */ token('ui/themes').multi<AnyThemeDef>();
export const AppearanceToken = /* @__PURE__ */ token('ui/appearance').type<Appearance>();
/** Optional: persisted appearance preference (bind a device-scoped AsyncStore). */
export const AppearanceStoreToken = /* @__PURE__ */ token('ui/appearance-store').type<AppearanceStore>();

/** Contribute a theme. Higher `order` = later in the list = wins the default selection. */
/* @__NO_SIDE_EFFECTS__ */
export function themeContribution(theme: AnyThemeDef, options: { readonly order?: number } = {}) {
  return contribution({
    id: `ui/theme:${theme.id}`,
    provides: ThemesToken,
    scope: 'app',
    order: options.order ?? 0,
    create: () => theme,
    description: `Theme "${theme.label}".`,
  });
}

export interface AppearanceUnitOptions extends Pick<AppearanceOptions, 'theme' | 'initial' | 'media'> {
  /**
   * `init` (default): readiness waits for the persisted preference. `manual`: ready at once
   * (first paint never waits on storage); the app calls `appearance.restore()` later.
   */
  readonly restore?: 'init' | 'manual';
}

/** Appearance controller over the contributed themes; restores the persisted preference in `init` (or manually). */
/* @__NO_SIDE_EFFECTS__ */
export function appearanceUnitWith(options: AppearanceUnitOptions = {}) {
  const { restore, ...appearanceOptions } = options;
  return unit({
    id: 'ui/appearance-unit',
    provides: AppearanceToken,
    scope: 'app',
    deps: { required: { themes: ThemesToken }, lazy: { store: AppearanceStoreToken } },
    create: ({ themes, store }, ctx) => {
      // The store is optional: bound → persisted per device, unbound → session only.
      const port = async (): Promise<AppearanceStore | undefined> => {
        const resolved = await store.whenReady(ctx.signal);
        return resolved.ok ? resolved.value : undefined;
      };
      return createAppearance({
        ...appearanceOptions,
        themes,
        telemetry: ctx.telemetry,
        store: {
          get: async (key, o) => (await port())?.get(key, o) ?? ok(undefined),
          set: async (key, value, o) => (await port())?.set(key, value, o) ?? ok(),
        },
      });
    },
    init: async (appearance, ctx) => {
      if (restore !== 'manual') await appearance.restore(ctx.signal);
      return { ok: true, value: undefined };
    },
    description: 'Active theme + color scheme, contrast, density and motion (system or explicit, persisted).',
  });
}

export const appearanceUnit = /* @__PURE__ */ appearanceUnitWith();
