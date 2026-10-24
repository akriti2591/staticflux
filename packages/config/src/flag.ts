/**
 * Flag declarations (R8.1, R8.2). A flag is a typed value declared once, in a
 * contracts-only file of the owning package. Readers import only the
 * declaration — never the owner's runtime.
 *
 *   export const AiSuggestions = defineFlag({
 *     key: 'studio/ai-suggestions',
 *     type: flagType.boolean(),
 *     default: false,
 *     owner: 'team-studio',
 *     preAuthSafe: false,
 *     description: 'Inline AI suggestions in the editor.',
 *   });
 *
 * Optional registry entry (typed keys for layer data, devtools, experiments):
 *
 *   declare module '@staticflux/config' {
 *     interface FlagRegistry { 'studio/ai-suggestions': boolean }
 *   }
 *
 * When a key is registered, `defineFlag` must declare the same value type.
 */
import { err, ok, type Result } from '@staticflux/core';
import { InvalidFlagValueError } from './errors.js';

/** Typed flag keys, extended via declaration merging. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FlagRegistry {}

export type FlagKey = `${string}/${string}`;
export type RegisteredFlagKey = keyof FlagRegistry & FlagKey;

/** OpenFeature value types. */
export type FlagValueType = 'boolean' | 'string' | 'number' | 'object';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface FlagSchema<T> {
  readonly type: FlagValueType;
  /** Closed set of allowed values (enum flags) — these are the experiment variants. */
  readonly values: readonly T[] | undefined;
  /** Validate an untrusted layer value (remote JSON, storage, URL). */
  parse(value: unknown): Result<T>;
}

function invalid(expected: string, value: unknown): Result<never> {
  return err(InvalidFlagValueError({ message: `Expected ${expected}, got ${JSON.stringify(value) ?? String(value)}.`, details: { expected } }));
}

export interface NumberSchemaOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

/** Schema constructors. Enums map to OpenFeature string flags. */
export const flagType = {
  boolean: (): FlagSchema<boolean> => ({
    type: 'boolean',
    values: [true, false],
    parse: (value) => (typeof value === 'boolean' ? ok(value) : invalid('boolean', value)),
  }),
  string: (): FlagSchema<string> => ({
    type: 'string',
    values: undefined,
    parse: (value) => (typeof value === 'string' ? ok(value) : invalid('string', value)),
  }),
  number: (options: NumberSchemaOptions = {}): FlagSchema<number> => ({
    type: 'number',
    values: undefined,
    parse: (value) => {
      if (typeof value !== 'number' || Number.isNaN(value)) return invalid('number', value);
      if (options.integer === true && !Number.isInteger(value)) return invalid('integer', value);
      if (options.min !== undefined && value < options.min) return invalid(`number >= ${options.min}`, value);
      if (options.max !== undefined && value > options.max) return invalid(`number <= ${options.max}`, value);
      return ok(value);
    },
  }),
  enum: <const V extends readonly [string, ...string[]]>(values: V): FlagSchema<V[number]> => ({
    type: 'string',
    values,
    parse: (value) =>
      typeof value === 'string' && (values as readonly string[]).includes(value)
        ? ok(value as V[number])
        : invalid(`one of ${values.join(' | ')}`, value),
  }),
  object: <T extends JsonObject>(guard: (value: unknown) => value is T, label = 'object'): FlagSchema<T> => ({
    type: 'object',
    values: undefined,
    parse: (value) => (typeof value === 'object' && value !== null && guard(value) ? ok(value) : invalid(label, value)),
  }),
} as const;

export interface FlagDefinition<T, K extends FlagKey = FlagKey> {
  readonly kind: 'flag';
  readonly key: K;
  readonly schema: FlagSchema<T>;
  /** Package default — the lowest layer (R8.5). */
  readonly defaultValue: T;
  /** Owning team/package (shown in devtools; used by tooling for flag hygiene). */
  readonly owner: string;
  /** Safe to evaluate before authentication; otherwise identity-bound layers are skipped pre-auth. */
  readonly preAuthSafe: boolean;
  readonly description: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFlag = FlagDefinition<any, FlagKey>;
export type FlagValueOf<F> = F extends FlagDefinition<infer T, FlagKey> ? T : never;

export interface FlagDeclaration<T, K extends FlagKey> {
  readonly key: K;
  readonly type: FlagSchema<T>;
  readonly default: NoInfer<T>;
  readonly owner: string;
  readonly preAuthSafe: boolean;
  readonly description: string;
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compile error when a registered key is declared with a different value type. */
export type RegistryCheck<K extends FlagKey, T> = K extends RegisteredFlagKey
  ? Same<T, FlagRegistry[K]> extends true
    ? unknown
    : { readonly __flagRegistryMismatch: { readonly key: K; readonly registered: FlagRegistry[K]; readonly declared: T } }
  : unknown;

export function defineFlag<T, const K extends FlagKey>(
  declaration: FlagDeclaration<T, K> & RegistryCheck<K, T>,
): FlagDefinition<T, K> {
  return Object.freeze({
    kind: 'flag',
    key: declaration.key,
    schema: declaration.type,
    defaultValue: declaration.default,
    owner: declaration.owner,
    preAuthSafe: declaration.preAuthSafe,
    description: declaration.description,
  });
}

/** Typed values for registered keys (plus any other namespaced key, validated at evaluation). */
export type FlagValues = { readonly [K in RegisteredFlagKey]?: FlagRegistry[K] } & { readonly [key: FlagKey]: unknown };

/** One typed layer entry: `flagValue(AiSuggestions, true)`. */
export interface FlagEntry {
  readonly flag: AnyFlag;
  readonly value: unknown;
}

export function flagValue<T>(flag: FlagDefinition<T>, value: NoInfer<T>): FlagEntry {
  return { flag, value };
}

/** Variant keys of a flag: enum members, or `'true' | 'false'` for booleans. */
export type VariantKey<T> = T extends string ? T : T extends boolean ? 'true' | 'false' : never;

/** Convert a variant key back to a flag value (boolean flags use `'true' | 'false'`). */
export function variantValue<T>(flag: FlagDefinition<T>, key: VariantKey<T>): T {
  if (flag.schema.type === 'boolean') return (key === 'true') as T;
  return key as T;
}

/** Variant label of a value (inverse of `variantValue`). */
export function variantKeyOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}
