/**
 * Compile-time completeness: composing units fails to type-check when a
 * required dependency has no provider. The error names the missing token ids:
 *
 *   Property '__missingProviders' is missing … "data/transport"
 *
 * Modules (e.g. a feature package) declare the tokens they expect the host to
 * provide with `external`.
 */
import type { AnyToken, TokenId } from './token.js';
import type { AnyUnit, DepsDeclaration, SpecToken, UnitDefinition } from './unit.js';

type RequiredIdsOf<D> = D extends { readonly required: infer R }
  ? R extends Readonly<Record<string, unknown>>
    ? NonMultiId<SpecToken<R[keyof R]>>
    : never
  : never;

/** Multi tokens may legitimately have zero contributions, so they are not required to have providers. */
type NonMultiId<K> = K extends { readonly multi: true }
  ? never
  : K extends { readonly id: infer Id }
    ? Id extends TokenId
      ? Id
      : never
    : never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RequiredOf<X> = X extends UnitDefinition<any, infer D extends DepsDeclaration, TokenId> ? RequiredIdsOf<D> : never;

export type ProvidedIds<U extends readonly AnyUnit[]> = U[number]['provides']['id'];
export type RequiredIds<U extends readonly AnyUnit[]> = RequiredOf<U[number]>;

export type MissingProviders<U extends readonly AnyUnit[], External extends TokenId = never> = Exclude<
  RequiredIds<U>,
  ProvidedIds<U> | External
>;

export type CompletenessCheck<U extends readonly AnyUnit[], External extends TokenId = never> = [
  MissingProviders<U, External>,
] extends [never]
  ? unknown
  : { readonly __missingProviders: MissingProviders<U, External> };

/** Check (at compile time) that `units` is self-sufficient. Returns the same array. */
export function composeUnits<const U extends readonly AnyUnit[]>(units: U & CompletenessCheck<U>): U {
  return units;
}

export interface ModuleDefinition<U extends readonly AnyUnit[], E extends readonly AnyToken[]> {
  readonly id: TokenId;
  readonly units: U;
  /** Tokens this module expects its host to provide. */
  readonly external: E;
  readonly description?: string;
}

/** A group of units that is complete given its `external` tokens. */
export function defineModule<const U extends readonly AnyUnit[], const E extends readonly AnyToken[] = readonly []>(
  definition: ModuleDefinition<U, E> & { readonly units: CompletenessCheck<U, E[number]['id']> },
): ModuleDefinition<U, E> {
  return definition;
}
