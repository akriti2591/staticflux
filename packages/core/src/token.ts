/**
 * Tokens are typed identities for things the injector provides.
 * The string id is namespaced (`package/name`), used for devtools and
 * serialization, and carried as a literal type so composition can check
 * completeness at compile time. There are no string lookups at runtime.
 *
 * @example
 * export const SessionToken = token('auth/session').type<Session>();
 * export const MenuItems = token('shell/menu-items').multi<MenuItem>();
 */

export type TokenId = `${string}/${string}`;

declare const tokenValue: unique symbol;

export interface Token<T, Id extends TokenId = TokenId> {
  readonly kind: 'token';
  readonly id: Id;
  /** Multi tokens collect every binding into an ordered array. */
  readonly multi: boolean;
  /** Phantom type carrier; never present at runtime. */
  readonly [tokenValue]?: T;
}

/** A multi token (value = ordered list of contributions). */
export type MultiToken<T, Id extends TokenId = TokenId> = Token<readonly T[], Id> & { readonly multi: true };

/** Any token (for collections and constraints). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToken = Token<any, TokenId>;

/** Extract the value type of a token. */
export type TokenValue<K> = K extends Token<infer T, TokenId> ? T : never;

export interface TokenBuilder<Id extends TokenId> {
  /** A single-value token. */
  type<T>(): Token<T, Id>;
  /** A multi token: every binding contributes one item; the value is the ordered list. */
  multi<T>(): MultiToken<T, Id>;
}

export function token<const Id extends TokenId>(id: Id): TokenBuilder<Id> {
  return {
    type: <T>() => Object.freeze({ kind: 'token', id, multi: false }) as Token<T, Id>,
    multi: <T>() => Object.freeze({ kind: 'token', id, multi: true }) as MultiToken<T, Id>,
  };
}

/**
 * Cross-package registry, extended with declaration merging. Packages add
 * entries so lookups across packages are type-checked without imports:
 *
 * declare module '@staticflux/core' {
 *   interface Registry { flags: { 'editor/ai-panel': boolean } }
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Registry {}
