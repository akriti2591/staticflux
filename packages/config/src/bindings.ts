/**
 * Experiments as variant bindings (R8.4, P4). Feature code injects a token;
 * the binding layer — and only it — reads the flag:
 *
 *   export const flagBinder = createFlagBinder();
 *   const app = createInjector({ units: [
 *     ...configUnits({ binder: flagBinder, … }),
 *     onboardingAUnit,                                    // default binding
 *     ...flagBinder.variants({
 *       flag: OnboardingVariant, of: OnboardingFlowToken,
 *       variants: { B: onboardingBUnit },
 *     }),
 *   ]});
 *
 * Variants are chosen when the token is first resolved in a scope and stay
 * fixed for that scope's life; flag changes apply at the next scope/epoch.
 */
import { type AnyUnit, type Binding, type Token, type TokenId, untracked, variant } from '@staticflux/core';
import { FlagBinderNotAttachedError } from './errors.js';
import { type FlagDefinition, type VariantKey, variantValue } from './flag.js';
import type { FlagReader } from './resolver.js';

export interface VariantSpec<T, V, OfId extends TokenId> {
  readonly flag: FlagDefinition<T>;
  readonly of: Token<V, OfId>;
  /** Unit per variant; omitted variants keep the default binding. */
  readonly variants: { readonly [K in VariantKey<T>]?: AnyUnit & { readonly provides: { readonly id: OfId } } };
  /** Devtools label (default `flag:<key>=<variant>`). */
  readonly source?: string;
}

export interface FlagBinder {
  readonly attached: boolean;
  /** Attach the resolver (done by `flagBinderUnit`). Returns detach. */
  attach(reader: FlagReader): () => void;
  /** Predicate for core `variant({ when })`: flag currently equals `expected`. Untracked read. */
  is<T>(flag: FlagDefinition<T>, expected: T): () => boolean;
  /** One experiment-precedence binding per listed variant. */
  variants<T, V, OfId extends TokenId>(spec: VariantSpec<T, V, OfId>): readonly Binding[];
}

export interface FlagBinderOptions {
  /** Reported when a binding is evaluated before attach (flag default is used). */
  readonly onUnattached?: (error: ReturnType<typeof FlagBinderNotAttachedError>) => void;
}

export function createFlagBinder(options: FlagBinderOptions = {}): FlagBinder {
  let reader: FlagReader | undefined;
  const read = <T>(flag: FlagDefinition<T>): T => {
    if (reader === undefined) {
      options.onUnattached?.(FlagBinderNotAttachedError({ details: { flag: flag.key } }));
      return flag.defaultValue;
    }
    const current = reader;
    return untracked(() => current.value(flag));
  };
  const is = <T>(flag: FlagDefinition<T>, expected: T) => (): boolean => Object.is(read(flag), expected);
  return {
    get attached() {
      return reader !== undefined;
    },
    attach(next) {
      reader = next;
      return () => {
        if (reader === next) reader = undefined;
      };
    },
    is,
    variants(spec) {
      const bindings: Binding[] = [];
      for (const [key, variantUnit] of Object.entries(spec.variants) as [string, AnyUnit | undefined][]) {
        if (variantUnit === undefined) continue;
        const expected = variantValue(spec.flag, key as never);
        bindings.push(
          variant({
            of: spec.of,
            unit: variantUnit,
            when: is(spec.flag, expected),
            source: spec.source ?? `flag:${spec.flag.key}=${key}`,
          }),
        );
      }
      return bindings;
    },
  };
}
