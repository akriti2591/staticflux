/**
 * Typed theme tokens (rule 1: no magic strings). A token set is declared once as data;
 * every token is a typed value that knows its CSS custom property:
 *
 * ```ts
 * export const t = defineTokens('sf', {
 *   color: ['text', 'textMuted'],
 *   space: ['sm'],
 * });
 * t.color.textMuted.property;  // '--sf-color-text-muted'
 * t.color.textMuted.ref;       // 'var(--sf-color-text-muted)'
 * css`color: ${t.color.textMuted.css};`  // Lit stylesheet reference
 * ```
 *
 * Token names are data; their meaning is documented next to the declaration (source
 * comments, kept out of the shipped bundle). Values live in themes (`defineTheme`).
 */
import { type CSSResult, unsafeCSS } from 'lit';

/** Token groups: group name → token names. */
export type TokenGroups = Readonly<Record<string, readonly string[]>>;

type KeysIn<G extends TokenGroups, Group extends keyof G> = G[Group][number] & string;

export interface ThemeToken<Name extends string = string> {
  readonly kind: 'theme-token';
  /** `group.name`, e.g. `color.textMuted`. */
  readonly name: Name;
  readonly group: string;
  readonly key: string;
  /** CSS custom property, e.g. `--sf-color-text-muted`. */
  readonly property: `--${string}`;
  /** `var(--sf-…)` reference for inline styles and string templates. */
  readonly ref: string;
  /** The same reference as a Lit `CSSResult` for `css` templates. */
  readonly css: CSSResult;
}

/** The typed tokens of a token set, mirroring its groups. */
export type TokensOf<G extends TokenGroups> = {
  readonly [Group in keyof G & string]: { readonly [Key in KeysIn<G, Group>]: ThemeToken<`${Group}.${Key}`> };
};

/** A complete value map for a token set (every token needs a value). */
export type TokenValues<G extends TokenGroups> = {
  readonly [Group in keyof G & string]: { readonly [Key in KeysIn<G, Group>]: string };
};

/** A partial value map (variants: dark scheme, density, contrast, reduced motion). */
export type PartialTokenValues<G extends TokenGroups> = {
  readonly [Group in keyof G & string]?: { readonly [Key in KeysIn<G, Group>]?: string };
};

export const TOKEN_SET: unique symbol = Symbol('staticflux.ui.token-set');

export interface TokenSetDescriptor<G extends TokenGroups = TokenGroups> {
  readonly prefix: string;
  readonly groups: G;
  /** Every token, in declaration order. */
  readonly list: readonly ThemeToken[];
}

export type TokenSet<G extends TokenGroups = TokenGroups> = TokensOf<G> & { readonly [TOKEN_SET]: TokenSetDescriptor<G> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTokenSet = TokenSet<any>;
export type GroupsOf<S> = S extends TokenSet<infer G> ? G : never;

const IDENTIFIER = /^[a-z][a-zA-Z0-9]*$/;
const PREFIX = /^[a-z][a-z0-9-]*$/;

/** `textMuted` → `text-muted`, `neutral12` → `neutral-12`, `size2xl` → `size-2xl`. */
export function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])([0-9])/g, '$1-$2').toLowerCase();
}

/** CSS custom property of a token: `('sf', 'color', 'textMuted')` → `--sf-color-text-muted`. */
export function tokenProperty(prefix: string, group: string, key: string): `--${string}` {
  return `--${prefix}-${kebabCase(group)}-${kebabCase(key)}`;
}

/**
 * Declare a token set. Group and token names are camelCase identifiers; the prefix is
 * kebab-case (`sf`). Throws a TypeError on malformed names or two names mapping to one
 * custom property (a programming error in a declaration file).
 */
/* @__NO_SIDE_EFFECTS__ */
export function defineTokens<const G extends TokenGroups>(prefix: string, groups: G): TokenSet<G> {
  if (!PREFIX.test(prefix)) throw new TypeError(`defineTokens: invalid prefix "${prefix}"`);
  const list: ThemeToken[] = [];
  const out: Record<string, Record<string, ThemeToken>> = {};
  const seen = new Set<string>();
  for (const [group, entries] of Object.entries(groups)) {
    if (!IDENTIFIER.test(group)) throw new TypeError(`defineTokens: invalid group name "${group}"`);
    const tokens: Record<string, ThemeToken> = {};
    for (const key of entries) {
      if (!IDENTIFIER.test(key)) throw new TypeError(`defineTokens: invalid token name "${group}.${key}"`);
      const property = tokenProperty(prefix, group, key);
      if (seen.has(property)) throw new TypeError(`defineTokens: ${property} already taken`);
      seen.add(property);
      const ref = `var(${property})`;
      const token: ThemeToken = Object.freeze({
        kind: 'theme-token',
        name: `${group}.${key}`,
        group,
        key,
        property,
        ref,
        css: unsafeCSS(ref),
      });
      tokens[key] = token;
      list.push(token);
    }
    out[group] = Object.freeze(tokens);
  }
  const descriptor: TokenSetDescriptor<G> = Object.freeze({ prefix, groups, list: Object.freeze(list) });
  Object.defineProperty(out, TOKEN_SET, { value: descriptor, enumerable: false });
  return Object.freeze(out) as unknown as TokenSet<G>;
}

/** The descriptor (prefix, groups, flat token list) of a token set. */
export function tokenSetOf<G extends TokenGroups>(set: TokenSet<G>): TokenSetDescriptor<G> {
  return set[TOKEN_SET];
}

/** A token's value in a (partial) value map, or undefined. */
export function valueOf(values: PartialTokenValues<TokenGroups>, token: ThemeToken): string | undefined {
  return values[token.group]?.[token.key];
}
