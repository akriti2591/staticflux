/**
 * OpenFeature-compatible provider port (R8.3). These interfaces mirror the
 * OpenFeature web SDK provider contract (static-context paradigm) without
 * depending on `@openfeature/web-sdk`: any OpenFeature web provider object
 * satisfies `OpenFeatureProviderLike` structurally and can be adapted into a
 * StaticFlux layer with `fromOpenFeatureProvider`.
 */
import { attemptAsync, err, ok, type Result, toSfError } from '@staticflux/core';
import type { EvaluationContext } from './context.js';
import { ProviderContextChangeFailedError, ProviderEvaluationError, ProviderInitFailedError } from './errors.js';
import type { AnyFlag, FlagKey, JsonValue } from './flag.js';
import type { FlagHook } from './hooks.js';
import type { EvaluationReason, FlagLayerProvider, LayerLookup, ProviderLayer } from './layer.js';

/** OpenFeature `ProviderEvents` string values. */
export const OpenFeatureEvents = {
  Ready: 'PROVIDER_READY',
  Error: 'PROVIDER_ERROR',
  ConfigurationChanged: 'PROVIDER_CONFIGURATION_CHANGED',
  Stale: 'PROVIDER_STALE',
  Reconciling: 'PROVIDER_RECONCILING',
  ContextChanged: 'PROVIDER_CONTEXT_CHANGED',
} as const;
export type OpenFeatureEvent = (typeof OpenFeatureEvents)[keyof typeof OpenFeatureEvents];

/** OpenFeature `ErrorCode` values. */
export type OpenFeatureErrorCode =
  | 'PROVIDER_NOT_READY'
  | 'PROVIDER_FATAL'
  | 'FLAG_NOT_FOUND'
  | 'PARSE_ERROR'
  | 'TYPE_MISMATCH'
  | 'TARGETING_KEY_MISSING'
  | 'INVALID_CONTEXT'
  | 'GENERAL';

export interface OpenFeatureResolutionDetails<T> {
  readonly value: T;
  readonly variant?: string;
  readonly reason?: string;
  readonly errorCode?: OpenFeatureErrorCode | string;
  readonly errorMessage?: string;
  readonly flagMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface OpenFeatureLogger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface OpenFeatureEventDetails {
  readonly message?: string;
  readonly flagsChanged?: readonly string[];
  readonly errorCode?: string;
}

export interface OpenFeatureEventEmitterLike {
  addHandler(event: OpenFeatureEvent, handler: (details?: OpenFeatureEventDetails) => void): void;
  removeHandler(event: OpenFeatureEvent, handler: (details?: OpenFeatureEventDetails) => void): void;
}

/** Structural mirror of the OpenFeature web `Provider` interface. */
export interface OpenFeatureProviderLike {
  readonly metadata: { readonly name: string };
  readonly runsOn?: 'client' | 'server';
  readonly hooks?: readonly FlagHook[];
  readonly events?: OpenFeatureEventEmitterLike;
  initialize?(context?: EvaluationContext): Promise<void>;
  onContextChange?(oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void>;
  onClose?(): Promise<void>;
  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: OpenFeatureLogger,
  ): OpenFeatureResolutionDetails<boolean>;
  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: OpenFeatureLogger,
  ): OpenFeatureResolutionDetails<string>;
  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: OpenFeatureLogger,
  ): OpenFeatureResolutionDetails<number>;
  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: OpenFeatureLogger,
  ): OpenFeatureResolutionDetails<T>;
}

export interface OpenFeatureAdapterOptions {
  readonly id?: string;
  readonly layer?: ProviderLayer;
  readonly identityBound?: boolean;
  readonly logger?: OpenFeatureLogger;
  /** Map StaticFlux flag keys to provider keys (default: identity). */
  readonly keyOf?: (flag: AnyFlag) => string;
}

const REASONS: readonly EvaluationReason[] = ['STATIC', 'DEFAULT', 'TARGETING_MATCH', 'SPLIT', 'CACHED', 'DISABLED', 'UNKNOWN', 'STALE', 'ERROR'];

const SILENT_LOGGER: OpenFeatureLogger = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

/** Run a promise-returning call but stop waiting when `signal` aborts (OpenFeature calls take no signal). */
async function untilAborted(fn: () => Promise<void>, signal: AbortSignal): Promise<Result<void>> {
  if (signal.aborted) return err(toSfError(signal.reason ?? new DOMException('aborted', 'AbortError')));
  return new Promise<Result<void>>((resolve) => {
    const onAbort = (): void => resolve(err(toSfError(signal.reason ?? new DOMException('aborted', 'AbortError'))));
    const detach = new AbortController();
    signal.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
    void attemptAsync(fn).then((result) => {
      detach.abort();
      resolve(result);
    });
  });
}

/** Adapt an OpenFeature web provider into a StaticFlux flag layer. */
export function fromOpenFeatureProvider(provider: OpenFeatureProviderLike, options: OpenFeatureAdapterOptions = {}): FlagLayerProvider {
  const logger = options.logger ?? SILENT_LOGGER;
  const keyOf = options.keyOf ?? ((flag: AnyFlag) => flag.key);
  const id = options.id ?? `openfeature/${provider.metadata.name}`;

  const resolve = (flag: AnyFlag, context: EvaluationContext): OpenFeatureResolutionDetails<unknown> => {
    const key = keyOf(flag);
    switch (flag.schema.type) {
      case 'boolean':
        return provider.resolveBooleanEvaluation(key, flag.defaultValue as boolean, context, logger);
      case 'string':
        return provider.resolveStringEvaluation(key, flag.defaultValue as string, context, logger);
      case 'number':
        return provider.resolveNumberEvaluation(key, flag.defaultValue as number, context, logger);
      default:
        return provider.resolveObjectEvaluation(key, flag.defaultValue as JsonValue, context, logger);
    }
  };

  return {
    id,
    layer: options.layer ?? 'remote',
    ...(options.identityBound === undefined ? {} : { identityBound: options.identityBound }),
    ...(provider.hooks === undefined ? {} : { hooks: provider.hooks }),
    async initialize(context, signal) {
      if (provider.initialize === undefined) return ok();
      const init = provider.initialize.bind(provider);
      const result = await untilAborted(() => init(context), signal);
      return result.ok || result.error.kind === 'aborted'
        ? result
        : err(ProviderInitFailedError({ cause: result.error, details: { provider: id } }));
    },
    async onContextChange(previous, next, signal) {
      if (provider.onContextChange === undefined) return ok();
      const change = provider.onContextChange.bind(provider);
      const result = await untilAborted(() => change(previous, next), signal);
      return result.ok || result.error.kind === 'aborted'
        ? result
        : err(ProviderContextChangeFailedError({ cause: result.error, details: { provider: id } }));
    },
    lookup(flag, context) {
      let details: OpenFeatureResolutionDetails<unknown>;
      try {
        details = resolve(flag, context);
      } catch (error) {
        return err(ProviderEvaluationError({ cause: error, details: { provider: id, flag: flag.key, errorCode: 'GENERAL' } }));
      }
      if (details.errorCode === 'FLAG_NOT_FOUND') return ok(undefined);
      if (details.errorCode !== undefined) {
        return err(
          ProviderEvaluationError({
            message: details.errorMessage ?? `Provider "${id}" returned ${details.errorCode} for "${flag.key}".`,
            details: { provider: id, flag: flag.key, errorCode: details.errorCode },
          }),
        );
      }
      // The provider served the caller's default: it has no opinion.
      if (details.reason === 'DEFAULT' || details.reason === 'DISABLED') return ok(undefined);
      const reason = REASONS.find((r) => r === details.reason) ?? 'UNKNOWN';
      const lookup: LayerLookup = {
        value: details.value,
        reason,
        ...(details.variant === undefined ? {} : { variant: details.variant }),
        ...(details.flagMetadata === undefined ? {} : { flagMetadata: details.flagMetadata }),
      };
      return ok(lookup);
    },
    subscribe(listener) {
      const events = provider.events;
      if (events === undefined) return () => undefined;
      const handlers: [OpenFeatureEvent, (details?: OpenFeatureEventDetails) => void][] = [
        [OpenFeatureEvents.Ready, () => listener({ type: 'ready' })],
        [
          OpenFeatureEvents.ConfigurationChanged,
          (details) =>
            listener(
              details?.flagsChanged === undefined
                ? { type: 'configuration-changed' }
                : { type: 'configuration-changed', keys: details.flagsChanged as readonly FlagKey[] },
            ),
        ],
        [OpenFeatureEvents.Stale, () => listener({ type: 'stale' })],
        [
          OpenFeatureEvents.Error,
          (details) =>
            listener({
              type: 'error',
              error: ProviderEvaluationError({ message: details?.message ?? `Provider "${id}" reported an error.`, details: { provider: id } }),
              fatal: details?.errorCode === 'PROVIDER_FATAL',
            }),
        ],
      ];
      for (const [event, handler] of handlers) events.addHandler(event, handler);
      return () => {
        for (const [event, handler] of handlers) events.removeHandler(event, handler);
      };
    },
    async dispose() {
      await provider.onClose?.();
    },
  };
}
