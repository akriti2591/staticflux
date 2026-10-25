/**
 * Themes: values for a token set, with variants, compiled to CSS custom properties.
 *
 * ```ts
 * export const brandTheme = extendTheme(defaultTheme, {
 *   id: 'instaflow/brand',
 *   values: { color: { accent: '#5b4ee5' } },
 *   dark: { color: { accent: '#9b8cff' } },
 * });
 * ```
 *
 * Variant model (one base + overrides; every variant may set only declared tokens):
 * - `values`         — light scheme, standard density, normal contrast, full motion (complete);
 * - `dark`           — dark-scheme overrides;
 * - `contrast.light` / `contrast.dark` — `prefers-contrast: more` (or explicit) overrides;
 * - `density.focus` / `density.pro` — control sizes and spacing (standard is the base);
 * - `reducedMotion`  — overrides under `prefers-reduced-motion: reduce` (or explicit).
 *
 * `compileTheme` emits CSS that honors the platform preferences *before* any script
 * runs (media queries on a root without `data-sf-*` attributes) and the explicit,
 * JS-resolved appearance afterwards (`data-sf-scheme|contrast|density|motion` on the root).
 */
import { err, ok, type Result } from '@staticflux/core';
import { ThemeInvalidError } from './errors.js';
import type { ThemeGroups } from './theme-contract.js';
import {
  type PartialTokenValues,
  type ThemeToken,
  type TokenGroups,
  type TokenSet,
  tokenSetOf,
  type TokenValues,
  valueOf,
} from './theme-tokens.js';

export type ColorScheme = 'light' | 'dark';
export type ContrastLevel = 'normal' | 'more';
export type Density = 'focus' | 'standard' | 'pro';
export type MotionLevel = 'full' | 'reduce';

export const DENSITIES: readonly Density[] = ['focus', 'standard', 'pro'];

/** A concrete appearance: what one rendering of a theme looks like. */
export interface ResolvedAppearance {
  readonly scheme: ColorScheme;
  readonly contrast: ContrastLevel;
  readonly density: Density;
  readonly motion: MotionLevel;
}

export type ThemeId = `${string}/${string}`;

export interface ThemeInit<G extends TokenGroups> {
  readonly id: ThemeId;
  readonly label?: string;
  readonly tokens: TokenSet<G>;
  /** Base values: light, standard density, normal contrast, full motion. Complete. */
  readonly values: TokenValues<G>;
  readonly dark: PartialTokenValues<G>;
  readonly contrast?: { readonly light?: PartialTokenValues<G>; readonly dark?: PartialTokenValues<G> };
  readonly density?: { readonly focus?: PartialTokenValues<G>; readonly pro?: PartialTokenValues<G> };
  readonly reducedMotion?: PartialTokenValues<G>;
  /** Extra custom properties emitted as `var()` aliases of tokens (e.g. pre-contract names). */
  readonly aliases?: Readonly<Record<`--${string}`, ThemeToken>>;
}

export interface ThemeDef<G extends TokenGroups = ThemeGroups> {
  readonly kind: 'theme';
  readonly id: ThemeId;
  readonly label: string;
  readonly tokens: TokenSet<G>;
  readonly values: TokenValues<G>;
  readonly dark: PartialTokenValues<G>;
  readonly contrast: { readonly light: PartialTokenValues<G>; readonly dark: PartialTokenValues<G> };
  readonly density: { readonly focus: PartialTokenValues<G>; readonly pro: PartialTokenValues<G> };
  readonly reducedMotion: PartialTokenValues<G>;
  readonly aliases: Readonly<Record<`--${string}`, ThemeToken>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyThemeDef = ThemeDef<any>;

/** Declare a theme (frozen data). Completeness of `values` is a compile-time check; `validateTheme` checks at runtime. */
/* @__NO_SIDE_EFFECTS__ */
export function defineTheme<const G extends TokenGroups>(init: ThemeInit<G>): ThemeDef<G> {
  return Object.freeze({
    kind: 'theme',
    id: init.id,
    label: init.label ?? init.id,
    tokens: init.tokens,
    values: init.values,
    dark: init.dark,
    contrast: { light: init.contrast?.light ?? {}, dark: init.contrast?.dark ?? {} },
    density: { focus: init.density?.focus ?? {}, pro: init.density?.pro ?? {} },
    reducedMotion: init.reducedMotion ?? {},
    aliases: init.aliases ?? {},
  });
}

export type ThemeOverrides<G extends TokenGroups> = {
  readonly id: ThemeId;
  readonly label?: string;
  readonly values?: PartialTokenValues<G>;
  readonly dark?: PartialTokenValues<G>;
  readonly contrast?: { readonly light?: PartialTokenValues<G>; readonly dark?: PartialTokenValues<G> };
  readonly density?: { readonly focus?: PartialTokenValues<G>; readonly pro?: PartialTokenValues<G> };
  readonly reducedMotion?: PartialTokenValues<G>;
};

function merge<V extends PartialTokenValues<TokenGroups>>(base: V, over: PartialTokenValues<TokenGroups> | undefined): V {
  if (over === undefined) return base;
  const out: Record<string, Record<string, string | undefined>> = {};
  for (const [group, entries] of Object.entries(base)) out[group] = { ...entries };
  for (const [group, entries] of Object.entries(over)) out[group] = { ...(out[group] ?? {}), ...entries };
  return out as unknown as V;
}

/** A new theme from a base with overrides (brand themes never fork the default). */
/* @__NO_SIDE_EFFECTS__ */
export function extendTheme<G extends TokenGroups>(base: ThemeDef<G>, overrides: ThemeOverrides<G>): ThemeDef<G> {
  return defineTheme<G>({
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    tokens: base.tokens,
    values: merge(base.values, overrides.values) as TokenValues<G>,
    dark: merge(base.dark, overrides.dark),
    contrast: { light: merge(base.contrast.light, overrides.contrast?.light), dark: merge(base.contrast.dark, overrides.contrast?.dark) },
    density: { focus: merge(base.density.focus, overrides.density?.focus), pro: merge(base.density.pro, overrides.density?.pro) },
    reducedMotion: merge(base.reducedMotion, overrides.reducedMotion),
    aliases: base.aliases,
  });
}

// ---------------------------------------------------------------- validation

const UNSAFE = /[;{}<>]|\/\*/;

/** Runtime check (themes loaded as data, brand themes): complete base, declared tokens only, safe values. */
export function validateTheme(theme: AnyThemeDef): Result<void> {
  const issues: string[] = [];
  const set = tokenSetOf(theme.tokens);
  const declared = new Set(set.list.map((t) => t.name));
  for (const token of set.list) {
    const value = valueOf(theme.values, token);
    if (value === undefined || value.trim() === '') issues.push(`values.${token.name}: missing`);
  }
  const variants: readonly (readonly [string, PartialTokenValues<TokenGroups>])[] = [
    ['values', theme.values],
    ['dark', theme.dark],
    ['contrast.light', theme.contrast.light],
    ['contrast.dark', theme.contrast.dark],
    ['density.focus', theme.density.focus],
    ['density.pro', theme.density.pro],
    ['reducedMotion', theme.reducedMotion],
  ];
  for (const [variant, values] of variants) {
    for (const [group, entries] of Object.entries(values)) {
      for (const [key, value] of Object.entries(entries ?? {})) {
        if (!declared.has(`${group}.${key}`)) issues.push(`${variant}.${group}.${key}: not a token of this set`);
        else if (typeof value !== 'string' || value.trim() === '') issues.push(`${variant}.${group}.${key}: empty`);
        else if (UNSAFE.test(value)) issues.push(`${variant}.${group}.${key}: unsafe characters in "${value}"`);
      }
    }
  }
  if (issues.length === 0) return ok();
  return err(ThemeInvalidError({ message: `Theme "${theme.id}" is invalid: ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '; …' : ''}`, details: { theme: theme.id, issues } }));
}

// ---------------------------------------------------------------- resolution

/** Every token's value for one concrete appearance (contract tests, previews, canvas renderers). */
export function resolveThemeValues<G extends TokenGroups>(theme: ThemeDef<G>, appearance: ResolvedAppearance): TokenValues<G> {
  let values: PartialTokenValues<TokenGroups> = theme.values;
  if (appearance.scheme === 'dark') values = merge(values, theme.dark);
  if (appearance.contrast === 'more') values = merge(values, appearance.scheme === 'dark' ? theme.contrast.dark : theme.contrast.light);
  if (appearance.density !== 'standard') values = merge(values, theme.density[appearance.density]);
  if (appearance.motion === 'reduce') values = merge(values, theme.reducedMotion);
  return values as TokenValues<G>;
}

/** One token's value for one appearance. */
export function themeValue(theme: AnyThemeDef, token: ThemeToken, appearance: ResolvedAppearance): string {
  return valueOf(resolveThemeValues(theme, appearance), token) ?? '';
}

// ---------------------------------------------------------------- CSS

export const APPEARANCE_ATTRS = {
  scheme: 'data-sf-scheme',
  contrast: 'data-sf-contrast',
  density: 'data-sf-density',
  motion: 'data-sf-motion',
  theme: 'data-sf-theme',
} as const;

function declarations(theme: AnyThemeDef, values: PartialTokenValues<TokenGroups>, onlyKeys?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const token of tokenSetOf(theme.tokens).list) {
    if (onlyKeys !== undefined && !onlyKeys.has(token.name)) continue;
    const value = valueOf(values, token);
    if (value !== undefined) out.push(`${token.property}:${value}`);
  }
  return out;
}

function keysOf(...maps: readonly PartialTokenValues<TokenGroups>[]): Set<string> {
  const keys = new Set<string>();
  for (const map of maps) for (const [group, entries] of Object.entries(map)) for (const key of Object.keys(entries ?? {})) keys.add(`${group}.${key}`);
  return keys;
}

function rule(selector: string, decls: readonly string[]): string {
  return decls.length === 0 ? '' : `${selector}{${decls.join(';')}}`;
}

export interface CompileThemeOptions {
  /** Root the variables apply to (default `:root`). */
  readonly selector?: string;
}

/** Compile a theme to CSS text (custom properties + `color-scheme`) for one root selector. */
export function compileTheme(theme: AnyThemeDef, options: CompileThemeOptions = {}): string {
  const s = options.selector ?? ':root';
  const a = APPEARANCE_ATTRS;
  const light: ResolvedAppearance = { scheme: 'light', contrast: 'normal', density: 'standard', motion: 'full' };
  const dark: ResolvedAppearance = { ...light, scheme: 'dark' };
  const moreKeys = keysOf(theme.contrast.light, theme.contrast.dark);
  const darkMore = resolveThemeValues(theme, { ...dark, contrast: 'more' });
  const aliases = Object.entries(theme.aliases).map(([property, token]) => `${property}:${token.ref}`);
  const darkDecls = [...declarations(theme, theme.dark), 'color-scheme:dark'];
  const parts = [
    rule(s, [...declarations(theme, resolveThemeValues(theme, light)), ...aliases, 'color-scheme:light']),
    `@media (prefers-color-scheme:dark){${rule(`${s}:not([${a.scheme}])`, darkDecls)}}`,
    rule(`${s}[${a.scheme}="dark"]`, darkDecls),
    `@media (prefers-contrast:more){${rule(`${s}:not([${a.contrast}])`, declarations(theme, theme.contrast.light))}}`,
    `@media (prefers-contrast:more) and (prefers-color-scheme:dark){${rule(`${s}:not([${a.contrast}]):not([${a.scheme}])`, declarations(theme, darkMore, moreKeys))}}`,
    rule(`${s}[${a.contrast}="more"]`, declarations(theme, theme.contrast.light)),
    rule(`${s}[${a.contrast}="more"][${a.scheme}="dark"]`, declarations(theme, darkMore, moreKeys)),
    rule(`${s}[${a.density}="focus"]`, declarations(theme, theme.density.focus)),
    rule(`${s}[${a.density}="pro"]`, declarations(theme, theme.density.pro)),
    `@media (prefers-reduced-motion:reduce){${rule(`${s}:not([${a.motion}])`, declarations(theme, theme.reducedMotion))}}`,
    rule(`${s}[${a.motion}="reduce"]`, declarations(theme, theme.reducedMotion)),
  ];
  return parts.filter((p) => p !== '' && !p.endsWith('{}')).join('\n');
}
