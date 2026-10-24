/**
 * Evaluation context port (static-context paradigm, as in the OpenFeature web
 * SDK). The context is built by the *app* from session and platform facts
 * and supplied through `EvaluationContextToken`; this package never imports
 * auth or platform.
 *
 *   unit({
 *     id: 'app/flag-context-unit', provides: EvaluationContextToken, scope: 'app',
 *     deps: { required: { session: SessionToken, profile: AppProfileToken } },
 *     create: ({ session, profile }) => derivedContext(() => ({
 *       context: { targetingKey: session.userId ?? session.deviceId, formFactor: profile.current.formFactor },
 *       authenticated: session.state === 'authenticated',
 *     })),
 *   });
 */
import { derived } from '@staticflux/core';

export type EvaluationContextValue =
  | string
  | number
  | boolean
  | null
  | Date
  | readonly EvaluationContextValue[]
  | { readonly [key: string]: EvaluationContextValue };

/** OpenFeature-shaped evaluation context. */
export interface EvaluationContext {
  readonly targetingKey?: string;
  readonly [attribute: string]: EvaluationContextValue | undefined;
}

export interface EvaluationContextSnapshot {
  readonly context: EvaluationContext;
  /** Identity is authenticated (non-pre-auth-safe flags may use identity-bound layers). */
  readonly authenticated: boolean;
}

export interface EvaluationContextSource {
  /** Reactive. */
  readonly context: EvaluationContext;
  /** Reactive. */
  readonly authenticated: boolean;
}

/** A fixed context (tests, pre-auth shells, workers replaying a snapshot). */
export function staticContext(context: EvaluationContext = {}, authenticated = false): EvaluationContextSource {
  return { context, authenticated };
}

/** A context derived from reactive facts; recomputed when what `build` reads changes. */
export function derivedContext(build: () => EvaluationContextSnapshot): EvaluationContextSource {
  const snapshot = derived(build);
  return {
    get context() {
      return snapshot.get().context;
    },
    get authenticated() {
      return snapshot.get().authenticated;
    },
  };
}

/** Stable comparison key for contexts (sorted keys, Dates as ISO strings). */
export function contextKey(context: EvaluationContext): string {
  const normalize = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(context));
}
