/**
 * Remote flag values (a JSON map from a flags endpoint). Loads on initialize
 * and on every context change (static-context paradigm); keeps serving the
 * last values while reloading, and reports `stale` when a refresh fails.
 */
import { err, ok, type Result, retry, type RetryPolicy, toSfError } from '@staticflux/core';
import type { EvaluationContext } from './context.js';
import { RemoteConfigLoadError } from './errors.js';
import type { FlagLayerProvider, LayerEvent, ProviderLayer } from './layer.js';

export interface RemoteLayerOptions {
  readonly id: string;
  readonly layer?: ProviderLayer;
  readonly identityBound?: boolean;
  /** Fetch the values for `context`. Use the data package's transport here. */
  load(context: EvaluationContext, signal: AbortSignal): Promise<Result<Readonly<Record<string, unknown>>>>;
  readonly retry?: RetryPolicy;
  /** Reload when the evaluation context changes. Default true. */
  readonly reloadOnContextChange?: boolean;
}

export interface RemoteLayer extends FlagLayerProvider {
  /** Reload now with `context`. */
  refresh(context: EvaluationContext, signal: AbortSignal): Promise<Result<void>>;
  readonly loaded: boolean;
}

export function createRemoteLayer(options: RemoteLayerOptions): RemoteLayer {
  let values = new Map<string, unknown>();
  let loaded = false;
  const listeners = new Set<(event: LayerEvent) => void>();
  const emit = (event: LayerEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const load = async (context: EvaluationContext, signal: AbortSignal): Promise<Result<void>> => {
    const once = async (inner: AbortSignal): Promise<Result<Readonly<Record<string, unknown>>>> => {
      try {
        return await options.load(context, inner);
      } catch (error) {
        return err(toSfError(error));
      }
    };
    const runner = options.retry === undefined ? once : retry(once, options.retry);
    const result = await runner(signal);
    if (!result.ok) {
      const error = result.error.kind === 'aborted' ? result.error : RemoteConfigLoadError({ cause: result.error, details: { provider: options.id } });
      return err(error);
    }
    values = new Map(Object.entries(result.value));
    loaded = true;
    return ok();
  };

  const layer: RemoteLayer = {
    id: options.id,
    layer: options.layer ?? 'remote',
    ...(options.identityBound === undefined ? {} : { identityBound: options.identityBound }),
    get loaded() {
      return loaded;
    },
    initialize: (context, signal) => load(context, signal),
    async onContextChange(_previous, next, signal) {
      if (options.reloadOnContextChange === false) return ok();
      return load(next, signal);
    },
    async refresh(context, signal) {
      const result = await load(context, signal);
      if (result.ok) emit({ type: 'configuration-changed' });
      else if (result.error.kind !== 'aborted') emit({ type: loaded ? 'stale' : 'error', ...(loaded ? {} : { error: result.error }) } as LayerEvent);
      return result;
    },
    lookup(flag) {
      if (!values.has(flag.key)) return ok(undefined);
      return ok({ value: values.get(flag.key), reason: 'CACHED' });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
      values.clear();
    },
  };
  return layer;
}
