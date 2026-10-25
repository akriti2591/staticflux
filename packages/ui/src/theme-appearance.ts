/**
 * Appearance: which theme is active and how it renders — color scheme, contrast,
 * density and motion — resolved against platform preferences and an explicit choice.
 *
 * - Preferences: `scheme: system | light | dark`, `contrast: system | normal | more`,
 *   `density: focus | standard | pro`, `motion: system | full | reduce`. `system` follows
 *   `prefers-color-scheme`, `prefers-contrast`, `prefers-reduced-motion` reactively.
 * - `apply(root, scope)` installs the compiled theme stylesheet once per document and keeps
 *   `data-sf-scheme|contrast|density|motion|theme` on the root in sync (the CSS reads them).
 * - The preference persists through an async key-value port (structurally an
 *   `@staticflux/storage` AsyncStore / messaging `KeyValuePort`), never sync storage (R9.0a).
 */
import { box, createNoopTelemetry, err, ok, type Result, type Scope, type Telemetry, watch } from '@staticflux/core';
import { NoThemeError } from './errors.js';
import {
  type AnyThemeDef,
  APPEARANCE_ATTRS,
  compileTheme,
  DENSITIES,
  type Density,
  type ResolvedAppearance,
  type ThemeId,
} from './theme-define.js';

export type SchemePreference = 'system' | 'light' | 'dark';
export type ContrastPreference = 'system' | 'normal' | 'more';
export type MotionPreference = 'system' | 'full' | 'reduce';

export interface AppearancePreference {
  readonly scheme: SchemePreference;
  readonly contrast: ContrastPreference;
  readonly density: Density;
  readonly motion: MotionPreference;
}

export const DEFAULT_APPEARANCE: AppearancePreference = Object.freeze({ scheme: 'system', contrast: 'system', density: 'standard', motion: 'system' });

/** Media queries as a port (structurally the same as shell's `MediaPort`). */
export interface MediaQueryPort {
  matches(query: string): boolean;
  /** Returns unsubscribe. */
  subscribe(query: string, listener: () => void): () => void;
}

export const APPEARANCE_QUERIES = {
  dark: '(prefers-color-scheme: dark)',
  moreContrast: '(prefers-contrast: more)',
  forcedColors: '(forced-colors: active)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const;

/** `matchMedia`-backed port; without `matchMedia` nothing matches (light, normal, full motion). */
export function browserMediaQueries(global: typeof globalThis = globalThis): MediaQueryPort {
  const mm = (global as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
  if (typeof mm !== 'function') return { matches: () => false, subscribe: () => () => undefined };
  return {
    matches: (query) => mm.call(global, query).matches,
    subscribe(query, listener) {
      const list = mm.call(global, query);
      if (typeof list.addEventListener !== 'function') return () => undefined;
      const subscription = new AbortController();
      list.addEventListener('change', listener, { signal: subscription.signal });
      return () => subscription.abort();
    },
  };
}

/** Async key-value port for the persisted preference (subset of AsyncStore). */
export interface AppearanceStore {
  get(key: string, options?: { readonly signal?: AbortSignal }): Promise<Result<string | undefined>>;
  set(key: string, value: string, options?: { readonly signal?: AbortSignal }): Promise<Result<void>>;
}

export const APPEARANCE_PREFERENCE_KEY = 'ui/appearance';

export interface Appearance {
  /** Reactive: contributed themes (contribution order). */
  readonly themes: readonly AnyThemeDef[];
  /** Reactive: the active theme. */
  readonly theme: AnyThemeDef;
  /** Reactive: the stored preference. */
  readonly preference: AppearancePreference;
  /** Reactive: the preference resolved against platform preferences. */
  readonly resolved: ResolvedAppearance;
  /** Reactive: `forced-colors: active` (components defer to system colors). */
  readonly forcedColors: boolean;
  /** Change part of the preference and persist it. */
  set(patch: Partial<AppearancePreference>, signal?: AbortSignal): Promise<Result<void>>;
  /** Switch the active theme by id (SF-UI-009 when not contributed). */
  useTheme(id: ThemeId): Result<void>;
  /** Load the persisted preference (invalid fields fall back to defaults). */
  restore(signal?: AbortSignal): Promise<Result<void>>;
  /**
   * Install the theme stylesheet in `root`'s document and keep the root's appearance
   * attributes in sync until `scope` is disposed. SF-UI-009 without a theme. Themes declared
   * in code are complete by type; check themes loaded as data with `validateTheme` first.
   */
  apply(root: HTMLElement, scope: Scope): Result<void>;
}

export interface AppearanceOptions {
  readonly themes: readonly AnyThemeDef[];
  /** Active theme id (default: the last contributed theme, so app themes override package defaults). */
  readonly theme?: ThemeId;
  readonly initial?: Partial<AppearancePreference>;
  readonly media?: MediaQueryPort;
  readonly store?: AppearanceStore;
  readonly telemetry?: Telemetry;
}

const SCHEMES: readonly SchemePreference[] = ['system', 'light', 'dark'];
const CONTRASTS: readonly ContrastPreference[] = ['system', 'normal', 'more'];
const MOTIONS: readonly MotionPreference[] = ['system', 'full', 'reduce'];

/** Keep only valid fields of an untrusted preference object. */
export function sanitizeAppearance(input: unknown): Partial<AppearancePreference> {
  if (typeof input !== 'object' || input === null) return {};
  const raw = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [field, allowed] of [['scheme', SCHEMES], ['contrast', CONTRASTS], ['density', DENSITIES], ['motion', MOTIONS]] as const) {
    const value = raw[field];
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) out[field] = value;
  }
  return out as Partial<AppearancePreference>;
}

export interface PlatformAppearance {
  readonly dark: boolean;
  readonly moreContrast: boolean;
  readonly forcedColors: boolean;
  readonly reducedMotion: boolean;
}

/** Resolve a preference against platform facts (pure). */
export function resolveAppearance(preference: AppearancePreference, platform: PlatformAppearance): ResolvedAppearance {
  return {
    scheme: preference.scheme === 'system' ? (platform.dark ? 'dark' : 'light') : preference.scheme,
    contrast: preference.contrast === 'system' ? (platform.moreContrast || platform.forcedColors ? 'more' : 'normal') : preference.contrast,
    density: preference.density,
    motion: preference.motion === 'system' ? (platform.reducedMotion ? 'reduce' : 'full') : preference.motion,
  };
}

const STYLE_ATTR = 'data-sf-theme-style';

export function createAppearance(options: AppearanceOptions): Appearance {
  const media = options.media ?? browserMediaQueries();
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const themes = box<readonly AnyThemeDef[]>(options.themes);
  const selectedId = box<ThemeId | undefined>(options.theme);
  const preference = box<AppearancePreference>({ ...DEFAULT_APPEARANCE, ...sanitizeAppearance(options.initial ?? {}) });
  const readPlatform = (): PlatformAppearance => ({
    dark: media.matches(APPEARANCE_QUERIES.dark),
    moreContrast: media.matches(APPEARANCE_QUERIES.moreContrast),
    forcedColors: media.matches(APPEARANCE_QUERIES.forcedColors),
    reducedMotion: media.matches(APPEARANCE_QUERIES.reducedMotion),
  });
  const platform = box(readPlatform(), (a, b) => JSON.stringify(a) === JSON.stringify(b));

  const activeTheme = (): AnyThemeDef | undefined => {
    const list = themes.get();
    const id = selectedId.get();
    return id === undefined ? list[list.length - 1] : list.find((t) => t.id === id);
  };

  const persist = async (signal?: AbortSignal): Promise<Result<void>> => {
    if (options.store === undefined) return ok();
    return options.store.set(APPEARANCE_PREFERENCE_KEY, JSON.stringify(preference.get()), signal === undefined ? {} : { signal });
  };

  return {
    get themes() {
      return themes.get();
    },
    get theme() {
      const theme = activeTheme();
      if (theme === undefined) throw NoThemeError({ details: { requested: selectedId.get() ?? null } });
      return theme;
    },
    get preference() {
      return preference.get();
    },
    get resolved() {
      return resolveAppearance(preference.get(), platform.get());
    },
    get forcedColors() {
      return platform.get().forcedColors;
    },
    async set(patch, signal) {
      preference.set({ ...preference.get(), ...sanitizeAppearance(patch) });
      telemetry.event('ui.appearance.changed', { subsystem: 'ui/theme', level: 'verbose', attrs: { ...preference.get() } });
      return persist(signal);
    },
    useTheme(id) {
      if (!themes.get().some((t) => t.id === id)) return err(NoThemeError({ message: `No contributed theme "${id}".`, details: { requested: id } }));
      selectedId.set(id);
      return ok();
    },
    async restore(signal) {
      if (options.store === undefined) return ok();
      const stored = await options.store.get(APPEARANCE_PREFERENCE_KEY, signal === undefined ? {} : { signal });
      if (!stored.ok) return stored;
      if (stored.value === undefined) return ok();
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored.value);
      } catch {
        return ok(); // corrupt preference: keep defaults
      }
      preference.set({ ...preference.get(), ...sanitizeAppearance(parsed) });
      return ok();
    },
    apply(root, scope) {
      const initial = activeTheme();
      if (initial === undefined) return err(NoThemeError({ details: { requested: selectedId.get() ?? null } }));
      for (const query of Object.values(APPEARANCE_QUERIES)) scope.defer(media.subscribe(query, () => platform.set(readPlatform())));
      const doc = root.ownerDocument;
      const style = doc.createElement('style');
      style.setAttribute(STYLE_ATTR, '');
      (doc.head ?? doc.documentElement).append(style);
      scope.defer(() => style.remove());
      // The document root uses `:root`; a subtree root (embedded widget, preview) is matched by its theme attribute.
      const isDocumentRoot = root === doc.documentElement;
      let compiledFor: AnyThemeDef | undefined;
      const sync = (): void => {
        const theme = activeTheme() ?? initial;
        if (theme !== compiledFor) {
          compiledFor = theme;
          const selector = isDocumentRoot ? ':root' : `[${APPEARANCE_ATTRS.theme}="${theme.id}"]`;
          style.textContent = compileTheme(theme, { selector });
        }
        const resolved = resolveAppearance(preference.get(), platform.get());
        root.setAttribute(APPEARANCE_ATTRS.theme, theme.id);
        root.setAttribute(APPEARANCE_ATTRS.scheme, resolved.scheme);
        root.setAttribute(APPEARANCE_ATTRS.contrast, resolved.contrast);
        root.setAttribute(APPEARANCE_ATTRS.density, resolved.density);
        root.setAttribute(APPEARANCE_ATTRS.motion, resolved.motion);
      };
      sync();
      watch(
        () => [activeTheme(), preference.get(), platform.get()] as const,
        () => sync(),
        { scope },
      );
      scope.defer(() => {
        for (const attr of Object.values(APPEARANCE_ATTRS)) root.removeAttribute(attr);
      });
      return ok();
    },
  };
}
