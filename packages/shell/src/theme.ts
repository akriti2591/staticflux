/**
 * Theming via design tokens → CSS custom properties (R13.1, R15.3).
 *
 * - `DesignTokens` is the typed token set; `tokenVar('colorBg')` → `--sf-color-bg`.
 * - Built-in themes: light, dark, high-contrast. Apps add themes with `defineTheme`.
 * - `createThemeController` resolves the preference (`system | light | dark | high-contrast`)
 *   against platform preferences (color scheme, `prefers-contrast: more`, `forced-colors`),
 *   applies the variables + `color-scheme` to an element, switches at runtime, and
 *   persists the preference through an async KV port (AsyncStore-compatible).
 */
import { box, createNoopTelemetry, ok, type Result, type Scope, type Telemetry, token, watch } from '@staticflux/core';
import type { KeyValuePort } from '@staticflux/messaging';
import { SHELL_SUBSYSTEM } from './telemetry.js';

export interface DesignTokens {
  readonly colorBg: string;
  readonly colorFg: string;
  readonly colorSurface: string;
  readonly colorMuted: string;
  readonly colorBorder: string;
  readonly colorAccent: string;
  readonly colorAccentFg: string;
  readonly colorFocus: string;
  readonly colorDanger: string;
  readonly colorBackdrop: string;
  readonly colorSkeleton: string;
  readonly fontBody: string;
  readonly fontMono: string;
  readonly radius: string;
  readonly radiusSmall: string;
  readonly space1: string;
  readonly space2: string;
  readonly space3: string;
  readonly space4: string;
  readonly shadowOverlay: string;
  readonly motionDuration: string;
}

export type DesignToken = keyof DesignTokens;

/** CSS custom property of a token: `colorBg` → `--sf-color-bg`, `space1` → `--sf-space-1`. */
export function tokenVar(name: DesignToken): `--sf-${string}` {
  return `--sf-${name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()}`;
}

/** `var(--sf-…)` reference for component styles. */
export function cssVar(name: DesignToken): string {
  return `var(${tokenVar(name)})`;
}

export type ThemeId = `${string}/${string}`;

export interface ThemeDef {
  readonly kind: 'theme';
  readonly id: ThemeId;
  readonly scheme: 'light' | 'dark';
  readonly contrast: 'normal' | 'more';
  readonly tokens: DesignTokens;
}

export function defineTheme(init: {
  readonly id: ThemeId;
  readonly scheme: 'light' | 'dark';
  readonly contrast?: 'normal' | 'more';
  readonly tokens: DesignTokens;
}): ThemeDef {
  return Object.freeze({ kind: 'theme', id: init.id, scheme: init.scheme, contrast: init.contrast ?? 'normal', tokens: Object.freeze({ ...init.tokens }) });
}

const base = {
  fontBody: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontMono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  radius: '8px',
  radiusSmall: '4px',
  space1: '4px',
  space2: '8px',
  space3: '16px',
  space4: '24px',
  motionDuration: '150ms',
} as const;

export const lightTheme = defineTheme({
  id: 'shell/light',
  scheme: 'light',
  tokens: {
    ...base,
    colorBg: '#f7f7f8',
    colorFg: '#16161a',
    colorSurface: '#ffffff',
    colorMuted: '#5b5b66',
    colorBorder: '#d9d9e0',
    colorAccent: '#4f46e5',
    colorAccentFg: '#ffffff',
    colorFocus: '#2563eb',
    colorDanger: '#b42318',
    colorBackdrop: 'rgba(0, 0, 0, 0.4)',
    colorSkeleton: 'rgba(22, 22, 26, 0.08)',
    shadowOverlay: '0 8px 32px rgba(0, 0, 0, 0.18)',
  },
});

export const darkTheme = defineTheme({
  id: 'shell/dark',
  scheme: 'dark',
  tokens: {
    ...base,
    colorBg: '#111114',
    colorFg: '#ececf1',
    colorSurface: '#1c1c21',
    colorMuted: '#a1a1ad',
    colorBorder: '#2f2f37',
    colorAccent: '#818cf8',
    colorAccentFg: '#0b0b0f',
    colorFocus: '#60a5fa',
    colorDanger: '#f97066',
    colorBackdrop: 'rgba(0, 0, 0, 0.6)',
    colorSkeleton: 'rgba(236, 236, 241, 0.08)',
    shadowOverlay: '0 8px 32px rgba(0, 0, 0, 0.5)',
  },
});

export const highContrastTheme = defineTheme({
  id: 'shell/high-contrast',
  scheme: 'dark',
  contrast: 'more',
  tokens: {
    ...base,
    colorBg: '#000000',
    colorFg: '#ffffff',
    colorSurface: '#000000',
    colorMuted: '#ffffff',
    colorBorder: '#ffffff',
    colorAccent: '#ffff00',
    colorAccentFg: '#000000',
    colorFocus: '#00ffff',
    colorDanger: '#ff6b6b',
    colorBackdrop: 'rgba(0, 0, 0, 0.85)',
    colorSkeleton: 'rgba(255, 255, 255, 0.25)',
    shadowOverlay: '0 0 0 2px #ffffff',
    motionDuration: '0ms',
  },
});

export const builtInThemes = [lightTheme, darkTheme, highContrastTheme] as const;

/** CSS text for a theme (e.g. for a constructable stylesheet or SSR-less critical CSS). */
export function themeToCss(theme: ThemeDef, selector = ':root'): string {
  const lines = (Object.keys(theme.tokens) as DesignToken[]).map((name) => `  ${tokenVar(name)}: ${theme.tokens[name]};`);
  return `${selector} {\n  color-scheme: ${theme.scheme};\n${lines.join('\n')}\n}`;
}

// ---------------------------------------------------------------- controller

export type ThemePreference = 'system' | 'light' | 'dark' | 'high-contrast';

/** Media queries as a port (feature-detected matchMedia by default). */
export interface MediaPort {
  matches(query: string): boolean;
  /** Returns unsubscribe. */
  subscribe(query: string, listener: () => void): () => void;
}

export function browserMedia(): MediaPort {
  const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
  if (typeof mm !== 'function') return { matches: () => false, subscribe: () => () => undefined };
  return {
    matches: (query) => mm.call(globalThis, query).matches,
    subscribe(query, listener) {
      const list = mm.call(globalThis, query);
      if (typeof list.addEventListener !== 'function') return () => undefined;
      const subscription = new AbortController();
      list.addEventListener('change', listener, { signal: subscription.signal });
      return () => subscription.abort();
    },
  };
}

export const MEDIA_QUERIES = {
  dark: '(prefers-color-scheme: dark)',
  moreContrast: '(prefers-contrast: more)',
  forcedColors: '(forced-colors: active)',
} as const;

export const THEME_PREFERENCE_KEY = 'shell/theme';

export interface ThemeController {
  /** Reactive. */
  readonly preference: ThemePreference;
  /** Reactive: the theme in effect. */
  readonly theme: ThemeDef;
  /** Reactive: forced colors active (components should defer to system colors). */
  readonly forcedColors: boolean;
  set(preference: ThemePreference, signal?: AbortSignal): Promise<Result<void>>;
  restore(signal?: AbortSignal): Promise<Result<void>>;
  /** Apply variables to `element` (default `document.documentElement`) and keep them in sync. */
  apply(element: HTMLElement, scope: Scope): void;
}

export interface ThemeControllerOptions {
  readonly light?: ThemeDef;
  readonly dark?: ThemeDef;
  readonly highContrast?: ThemeDef;
  readonly media?: MediaPort;
  readonly store?: KeyValuePort<string>;
  readonly initial?: ThemePreference;
  readonly telemetry?: Telemetry;
}

const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark', 'high-contrast'];

export function createThemeController(options: ThemeControllerOptions = {}): ThemeController {
  const media = options.media ?? browserMedia();
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const themes = {
    light: options.light ?? lightTheme,
    dark: options.dark ?? darkTheme,
    highContrast: options.highContrast ?? highContrastTheme,
  };
  const preference = box<ThemePreference>(options.initial ?? 'system');
  const facts = box({
    dark: media.matches(MEDIA_QUERIES.dark),
    moreContrast: media.matches(MEDIA_QUERIES.moreContrast),
    forcedColors: media.matches(MEDIA_QUERIES.forcedColors),
  });
  const refreshFacts = (): void =>
    facts.set({
      dark: media.matches(MEDIA_QUERIES.dark),
      moreContrast: media.matches(MEDIA_QUERIES.moreContrast),
      forcedColors: media.matches(MEDIA_QUERIES.forcedColors),
    });

  const resolve = (): ThemeDef => {
    const pref = preference.get();
    const f = facts.get();
    if (pref === 'high-contrast') return themes.highContrast;
    if (pref === 'light') return themes.light;
    if (pref === 'dark') return themes.dark;
    if (f.moreContrast || f.forcedColors) return themes.highContrast;
    return f.dark ? themes.dark : themes.light;
  };

  const write = (element: HTMLElement, theme: ThemeDef): void => {
    for (const name of Object.keys(theme.tokens) as DesignToken[]) element.style.setProperty(tokenVar(name), theme.tokens[name]);
    element.style.colorScheme = theme.scheme;
    element.dataset['theme'] = theme.id;
    element.dataset['contrast'] = theme.contrast;
  };

  return {
    get preference() {
      return preference.get();
    },
    get theme() {
      return resolve();
    },
    get forcedColors() {
      return facts.get().forcedColors;
    },
    async set(next, signal) {
      if (!PREFERENCES.includes(next)) return ok();
      preference.set(next);
      telemetry.event('shell.theme.changed', { subsystem: SHELL_SUBSYSTEM, level: 'verbose', attrs: { preference: next, theme: resolve().id } });
      if (options.store === undefined) return ok();
      return options.store.set(THEME_PREFERENCE_KEY, next, signal === undefined ? {} : { signal });
    },
    async restore(signal) {
      if (options.store === undefined) return ok();
      const stored = await options.store.get(THEME_PREFERENCE_KEY, signal === undefined ? {} : { signal });
      if (!stored.ok) return stored;
      if (stored.value !== undefined && PREFERENCES.includes(stored.value as ThemePreference)) {
        preference.set(stored.value as ThemePreference);
      }
      return ok();
    },
    apply(element, scope) {
      for (const query of Object.values(MEDIA_QUERIES)) scope.defer(media.subscribe(query, refreshFacts));
      let last: ThemeDef | undefined;
      const sync = (): void => {
        const theme = resolve();
        if (theme === last) return;
        last = theme;
        write(element, theme);
      };
      sync();
      // Re-apply whenever preference or platform facts change (reactive reads above).
      watch(resolve, sync, { scope });
    },
  };
}

export const ThemeControllerToken = token('shell/theme-controller').type<ThemeController>();
export const ThemePreferenceStoreToken = token('shell/theme-preference-store').type<KeyValuePort<string>>();
