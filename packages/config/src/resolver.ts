/**
 * The flag resolver: layered, reactive, explainable (R8.2–R8.5).
 *
 * - `value(flag)` / `details(flag)` are synchronous and reactive: they re-run
 *   when a provider changes, its status changes, or the context changes.
 * - Resolution walks providers from the highest layer down (local > experiment >
 *   remote > workspace > app); within a layer the later-registered provider wins;
 *   the package default is the floor. Invalid values fall through (SF-CFG-001).
 * - Each evaluation carries a full trace (which layer won, what was shadowed,
 *   what was skipped and why) for devtools.
 * - Static-context paradigm: on context change, providers reconcile
 *   (`ready → reconciling → ready`) and keep serving cached values meanwhile.
 * - Non-`preAuthSafe` flags skip identity-bound layers until authenticated.
 *
 * Provider lifecycle (`config/provider`, mirrors OpenFeature provider status):
 *   not-ready → ready | error | fatal
 *   ready → stale | reconciling | error | fatal
 *   stale → ready | reconciling | error | fatal
 *   reconciling → ready | reconciling | error | fatal
 *   error → ready | reconciling | fatal
 *   any → disposed
 */
import {
  box,
  type Box,
  createMachine,
  createNoopTelemetry,
  createScope,
  derived,
  type Derived,
  defineMachine,
  err,
  type Machine,
  metric,
  ok,
  type Result,
  type Scope,
  type SfError,
  type Telemetry,
  timeout,
  toSfError,
  untracked,
  watch,
} from '@staticflux/core';
import { contextKey, type EvaluationContext, type EvaluationContextSource, staticContext } from './context.js';
import { DuplicateFlagKeyError, ProviderEvaluationError, ProviderInitFailedError } from './errors.js';
import { type AnyFlag, type FlagDefinition, type FlagKey, variantKeyOf } from './flag.js';
import type { FlagEvaluation, FlagHook, FlagHookContext, LayerTrace } from './hooks.js';
import { type EvaluationReason, type FlagLayerProvider, isIdentityBound, type LayerEvent, layerRank, type LayerLookup } from './layer.js';

export const FLAGS_SUBSYSTEM = 'config/flags' as const;

export const providerMachine = defineMachine({
  id: 'config/provider',
  initial: 'not-ready',
  states: ['not-ready', 'ready', 'stale', 'reconciling', 'error', 'fatal', 'disposed'],
  transitions: {
    'not-ready': { ready: 'ready', error: 'error', fatal: 'fatal', dispose: 'disposed' },
    ready: { stale: 'stale', reconcile: 'reconciling', error: 'error', fatal: 'fatal', dispose: 'disposed' },
    stale: { ready: 'ready', reconcile: 'reconciling', error: 'error', fatal: 'fatal', dispose: 'disposed' },
    reconciling: { ready: 'ready', reconcile: 'reconciling', error: 'error', fatal: 'fatal', dispose: 'disposed' },
    error: { ready: 'ready', reconcile: 'reconciling', fatal: 'fatal', dispose: 'disposed' },
    fatal: { dispose: 'disposed' },
  },
  terminal: ['disposed'],
});
export type ProviderStatus = (typeof providerMachine.states)[number];
type ProviderEventName = 'ready' | 'stale' | 'reconcile' | 'error' | 'fatal' | 'dispose';

export const evaluationErrors = /* @__PURE__ */ metric.counter('config/evaluation-errors', {
  description: 'Flag evaluations where a layer errored or supplied an invalid value.',
});
export const providerInitDuration = /* @__PURE__ */ metric.histogram('config/provider-init-duration', {
  unit: 'ms',
  description: 'Time for a flag provider to initialize.',
});

export interface ProviderInfo {
  readonly id: string;
  readonly layer: FlagLayerProvider['layer'];
  readonly status: ProviderStatus;
  readonly identityBound: boolean;
  readonly error: SfError | undefined;
}

/** The read side used by bindings (no devtools surface). */
export interface FlagReader {
  /** Reactive value. */
  value<T>(flag: FlagDefinition<T>): T;
}

export interface FlagResolver extends FlagReader {
  /** Reactive value + reason + layer trace. */
  details<T>(flag: FlagDefinition<T>): FlagEvaluation<T>;
  /** Call `onChange` when the flag value changes; bound to `scope`. */
  watch<T>(
    flag: FlagDefinition<T>,
    onChange: (value: T, previous: T | undefined) => void,
    options: { readonly scope: Scope; readonly fireImmediately?: boolean },
  ): () => void;
  /** True once no provider is `not-ready`. Reactive. */
  readonly ready: boolean;
  /** Reactive provider list with statuses (devtools). */
  providers(): readonly ProviderInfo[];
  /** Declared flags known to this resolver. */
  flags(): readonly AnyFlag[];
  /** Evaluation of every known flag (devtools). Untracked. */
  inspect(): readonly FlagEvaluation<unknown>[];
  /** Plain values of every known flag (replicate to workers as a static layer). Untracked. */
  snapshot(): Readonly<Record<string, unknown>>;
  /** Declare flags (for inspect/snapshot). Duplicate keys with different declarations → SF-CFG-002. */
  register(...flags: readonly AnyFlag[]): Result<void>;
  /** Add a provider at runtime (e.g. devtools override layer). Returns a remover. */
  addProvider(provider: FlagLayerProvider): () => void;
  /** Initialize every provider (single-flight). Never fails for provider errors; they surface as statuses. */
  initialize(signal?: AbortSignal): Promise<Result<void>>;
  dispose(): Promise<void>;
}

export interface FlagResolverOptions {
  readonly providers?: readonly FlagLayerProvider[];
  readonly context?: EvaluationContextSource;
  readonly flags?: readonly AnyFlag[];
  readonly hooks?: readonly FlagHook[];
  readonly telemetry?: Telemetry;
  /** Per-provider initialize timeout. Default 3000 ms. */
  readonly initTimeoutMs?: number;
  /** OpenFeature client domain reported to hooks. */
  readonly domain?: string;
}

interface Entry {
  readonly provider: FlagLayerProvider;
  readonly order: number;
  readonly machine: Machine<ProviderStatus, ProviderEventName>;
  readonly version: Box<number>;
  readonly error: Box<SfError | undefined>;
  unsubscribe: () => void;
  reconcile: AbortController | undefined;
  initStarted: boolean;
}

const NOT_SERVING: readonly ProviderStatus[] = ['not-ready', 'fatal', 'disposed'];

export function createFlagResolver(options: FlagResolverOptions = {}): FlagResolver {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const context = options.context ?? staticContext();
  const hooks = options.hooks ?? [];
  const initTimeoutMs = options.initTimeoutMs ?? 3000;
  const scope = createScope('config/flag-resolver');
  const entries = box<readonly Entry[]>([]);
  const declared = new Map<FlagKey, AnyFlag>();
  const cache = new Map<FlagKey, { readonly flag: AnyFlag; readonly details: Derived<FlagEvaluation<unknown>>; readonly value: Derived<unknown> }>();
  const duplicateReported = new Set<FlagKey>();
  let order = 0;
  let initPromise: Promise<Result<void>> | undefined;
  let initSignal: AbortSignal = scope.signal;
  let currentContext: EvaluationContext = untracked(() => context.context);
  let currentKey = contextKey(currentContext);
  let disposed = false;

  const bump = (entry: Entry): void => entry.version.set(untracked(() => entry.version.get()) + 1);

  const send = (entry: Entry, event: ProviderEventName): void => {
    if (entry.machine.can(event)) entry.machine.send(event);
  };

  // ---------------------------------------------------------------- evaluation

  const runHooks = (flag: AnyFlag, phase: (hook: FlagHook) => void, providerHooks: readonly FlagHook[]): void => {
    for (const hook of [...hooks, ...providerHooks]) {
      try {
        phase(hook);
      } catch (error) {
        telemetry.event('config.hook-failed', {
          subsystem: FLAGS_SUBSYSTEM,
          level: 'critical',
          attrs: { flag: flag.key, error: toSfError(error).message },
        });
      }
    }
  };

  const evaluate = <T>(flag: FlagDefinition<T>): FlagEvaluation<T> => {
    const ctx = context.context;
    const authenticated = context.authenticated;
    const sorted = [...entries.get()].sort(
      (a, b) => layerRank(b.provider.layer) - layerRank(a.provider.layer) || b.order - a.order,
    );
    const providerHooks = sorted.flatMap((entry) => entry.provider.hooks ?? []);
    const hookContext: FlagHookContext = {
      flagKey: flag.key,
      flagValueType: flag.schema.type,
      defaultValue: flag.defaultValue,
      context: ctx,
      clientMetadata: { domain: options.domain },
    };
    if (hooks.length > 0 || providerHooks.length > 0) runHooks(flag, (hook) => hook.before?.(hookContext), providerHooks);

    const trace: LayerTrace[] = [];
    const errors: SfError[] = [];
    let skippedPreAuth = false;
    let winner: { readonly entry: Entry; readonly lookup: LayerLookup; readonly value: T } | undefined;

    for (const entry of sorted) {
      entry.version.get(); // track provider changes
      const status = entry.machine.state;
      const { provider } = entry;
      if (!flag.preAuthSafe && !authenticated && isIdentityBound(provider)) {
        skippedPreAuth = true;
        trace.push({ layer: provider.layer, providerId: provider.id, outcome: 'skipped-pre-auth' });
        continue;
      }
      if (NOT_SERVING.includes(status)) {
        trace.push({ layer: provider.layer, providerId: provider.id, outcome: 'not-ready' });
        continue;
      }
      let result: Result<LayerLookup | undefined>;
      try {
        result = provider.lookup(flag, ctx);
      } catch (error) {
        result = err(ProviderEvaluationError({ cause: error, details: { provider: provider.id, flag: flag.key } }));
      }
      if (!result.ok) {
        errors.push(result.error);
        trace.push({ layer: provider.layer, providerId: provider.id, outcome: 'error', errorCode: result.error.code });
        continue;
      }
      if (result.value === undefined) {
        trace.push({ layer: provider.layer, providerId: provider.id, outcome: 'no-value' });
        continue;
      }
      const parsed = flag.schema.parse(result.value.value);
      if (!parsed.ok) {
        const error = parsed.error;
        errors.push(error);
        trace.push({ layer: provider.layer, providerId: provider.id, outcome: 'invalid', value: result.value.value, errorCode: error.code });
        continue;
      }
      if (winner === undefined) {
        winner = { entry, lookup: result.value, value: parsed.value };
        trace.push({ layer: provider.layer, providerId: provider.id, outcome: 'value', value: parsed.value });
      } else {
        trace.push({ layer: provider.layer, providerId: provider.id, outcome: 'shadowed', value: parsed.value });
      }
    }
    trace.push({ layer: 'default', providerId: undefined, outcome: winner === undefined ? 'value' : 'shadowed', value: flag.defaultValue });

    const firstError = errors[0];
    let evaluation: FlagEvaluation<T>;
    if (winner !== undefined) {
      const status = winner.entry.machine.state;
      const reason: EvaluationReason = status === 'stale' ? 'STALE' : (winner.lookup.reason ?? 'STATIC');
      evaluation = {
        flagKey: flag.key,
        value: winner.value,
        variant: winner.lookup.variant ?? variantKeyOf(winner.value),
        reason,
        errorCode: undefined,
        errorMessage: undefined,
        flagMetadata: winner.lookup.flagMetadata ?? {},
        layer: winner.entry.provider.layer,
        providerId: winner.entry.provider.id,
        trace,
      };
    } else {
      evaluation = {
        flagKey: flag.key,
        value: flag.defaultValue,
        variant: variantKeyOf(flag.defaultValue),
        reason: firstError !== undefined ? 'ERROR' : skippedPreAuth ? 'PRE_AUTH' : 'DEFAULT',
        errorCode: firstError?.code,
        errorMessage: firstError?.message,
        flagMetadata: {},
        layer: 'default',
        providerId: undefined,
        trace,
      };
    }
    if (errors.length > 0) telemetry.record(evaluationErrors, errors.length, { flag: flag.key });
    if (hooks.length > 0 || providerHooks.length > 0) {
      for (const error of errors) runHooks(flag, (hook) => hook.error?.(hookContext, error), providerHooks);
      runHooks(flag, (hook) => hook.after?.(hookContext, evaluation as FlagEvaluation<unknown>), providerHooks);
      runHooks(flag, (hook) => hook.finally?.(hookContext, evaluation as FlagEvaluation<unknown>), providerHooks);
    }
    return evaluation;
  };

  const details = <T>(flag: FlagDefinition<T>): FlagEvaluation<T> => {
    const cached = cache.get(flag.key);
    if (cached !== undefined) {
      if (cached.flag === flag) return cached.details.get() as FlagEvaluation<T>;
      if (!duplicateReported.has(flag.key)) {
        duplicateReported.add(flag.key);
        telemetry.event('config.duplicate-flag', {
          subsystem: FLAGS_SUBSYSTEM,
          level: 'critical',
          attrs: { flag: flag.key, code: DuplicateFlagKeyError.code },
        });
      }
      return evaluate(flag);
    }
    return cacheFor(flag).details.get() as FlagEvaluation<T>;
  };

  const cacheFor = (flag: AnyFlag): { readonly flag: AnyFlag; readonly details: Derived<FlagEvaluation<unknown>>; readonly value: Derived<unknown> } => {
    let cached = cache.get(flag.key);
    if (cached === undefined) {
      const evaluation = derived(() => evaluate(flag) as FlagEvaluation<unknown>);
      // Value readers re-run only when the value changes, not when only the trace does.
      cached = { flag, details: evaluation, value: derived(() => evaluation.get().value) };
      cache.set(flag.key, cached);
    }
    return cached;
  };

  /** Reactive value; tracks only value changes. */
  const valueOf = <T>(flag: FlagDefinition<T>): T => {
    const cached = cacheFor(flag);
    return (cached.flag === flag ? cached.value.get() : details(flag).value) as T;
  };

  // ---------------------------------------------------------------- providers

  const reconcile = (entry: Entry, previous: EvaluationContext, next: EvaluationContext): void => {
    const change = entry.provider.onContextChange?.bind(entry.provider);
    if (change === undefined) {
      bump(entry);
      return;
    }
    if (!entry.machine.can('reconcile')) return;
    entry.reconcile?.abort();
    const controller = new AbortController();
    entry.reconcile = controller;
    entry.machine.send('reconcile');
    const span = telemetry.span('config.reconcile', { subsystem: FLAGS_SUBSYSTEM, attrs: { provider: entry.provider.id } });
    void change(previous, next, controller.signal).then(
      (result) => {
        if (controller.signal.aborted || entry.reconcile !== controller) {
          span.end('cancelled');
          return;
        }
        entry.reconcile = undefined;
        if (result.ok) {
          entry.error.set(undefined);
          send(entry, 'ready');
          span.end('ok');
        } else {
          entry.error.set(result.error);
          send(entry, 'error');
          span.end('error', result.error);
        }
        bump(entry);
      },
      (error: unknown) => {
        entry.reconcile = undefined;
        const sf = toSfError(error);
        entry.error.set(sf);
        send(entry, 'error');
        span.end('error', sf);
      },
    );
  };

  const initEntry = async (entry: Entry, signal: AbortSignal): Promise<void> => {
    if (entry.initStarted) return;
    entry.initStarted = true;
    const init = entry.provider.initialize?.bind(entry.provider);
    if (init === undefined) {
      send(entry, 'ready');
      return;
    }
    const usedKey = currentKey;
    const usedContext = currentContext;
    const span = telemetry.span('config.provider-init', { subsystem: FLAGS_SUBSYSTEM, attrs: { provider: entry.provider.id, layer: entry.provider.layer } });
    const started = telemetry.now();
    const result = await timeout(async (inner: AbortSignal) => {
      try {
        return await init(usedContext, inner);
      } catch (error) {
        return err(toSfError(error));
      }
    }, initTimeoutMs)(signal);
    telemetry.record(providerInitDuration, telemetry.now() - started, { provider: entry.provider.id });
    if (untracked(() => entry.machine.state) === 'disposed') {
      span.end('cancelled');
      return;
    }
    if (result.ok) {
      send(entry, 'ready');
      span.end('ok');
      if (usedKey !== currentKey) reconcile(entry, usedContext, currentContext);
    } else if (toSfError(result.error).kind === 'aborted') {
      entry.initStarted = false;
      span.end('cancelled', toSfError(result.error));
    } else {
      const cause = toSfError(result.error);
      const error = cause.code.startsWith('SF-CFG-') ? cause : ProviderInitFailedError({ cause, details: { provider: entry.provider.id } });
      entry.error.set(error);
      send(entry, 'error');
      span.end('error', error);
    }
    bump(entry);
  };

  const onProviderEvent = (entry: Entry, event: LayerEvent): void => {
    switch (event.type) {
      case 'ready':
        entry.error.set(undefined);
        send(entry, 'ready');
        break;
      case 'stale':
        send(entry, 'stale');
        break;
      case 'error':
        entry.error.set(event.error);
        send(entry, event.fatal === true ? 'fatal' : 'error');
        break;
      case 'configuration-changed':
        telemetry.event('config.configuration-changed', {
          subsystem: FLAGS_SUBSYSTEM,
          level: 'verbose',
          attrs: { provider: entry.provider.id, keys: [...(event.keys ?? [])] },
        });
        break;
    }
    bump(entry);
  };

  const addProvider = (provider: FlagLayerProvider): (() => void) => {
    const machine = createMachine(providerMachine, {
      onInvalid: (state, event) =>
        telemetry.event('config.invalid-transition', { subsystem: FLAGS_SUBSYSTEM, level: 'verbose', attrs: { provider: provider.id, state, event } }),
    });
    const entry: Entry = {
      provider,
      order: order++,
      machine,
      version: box(0),
      error: box<SfError | undefined>(undefined),
      unsubscribe: () => undefined,
      reconcile: undefined,
      initStarted: false,
    };
    machine.onTransition((record) =>
      telemetry.event('config.provider-status', {
        subsystem: FLAGS_SUBSYSTEM,
        level: record.to === 'error' || record.to === 'fatal' ? 'critical' : 'standard',
        attrs: { provider: provider.id, from: record.from, to: record.to },
      }),
    );
    entry.unsubscribe = provider.subscribe?.((event) => onProviderEvent(entry, event)) ?? (() => undefined);
    entries.set([...untracked(() => entries.get()), entry]);
    // Providers without async initialization (static layers) serve immediately.
    if (provider.initialize === undefined || initPromise !== undefined) void initEntry(entry, initSignal);
    return () => {
      entry.unsubscribe();
      entry.reconcile?.abort();
      send(entry, 'dispose');
      entries.set(untracked(() => entries.get()).filter((e) => e !== entry));
    };
  };

  const register = (...flags: readonly AnyFlag[]): Result<void> => {
    for (const flag of flags) {
      const existing = declared.get(flag.key);
      if (existing !== undefined && existing !== flag) {
        return err(DuplicateFlagKeyError({ details: { flag: flag.key, owners: [existing.owner, flag.owner] } }));
      }
      declared.set(flag.key, flag);
    }
    return ok();
  };

  for (const provider of options.providers ?? []) addProvider(provider);
  const registered = register(...(options.flags ?? []));
  if (!registered.ok) {
    telemetry.event('config.duplicate-flag', { subsystem: FLAGS_SUBSYSTEM, level: 'critical', attrs: { code: registered.error.code, ...(registered.error.details as Record<string, string>) } });
  }

  // Static-context paradigm: reconcile providers when the context changes.
  watch(
    () => context.context,
    (next) => {
      const key = contextKey(next);
      if (key === currentKey) return;
      const previous = currentContext;
      currentContext = next;
      currentKey = key;
      for (const entry of untracked(() => entries.get())) {
        if (entry.machine.state === 'not-ready') continue; // initializes with the latest context
        reconcile(entry, previous, next);
      }
    },
    { scope },
  );

  const knownFlags = (): AnyFlag[] => {
    const all = new Map<FlagKey, AnyFlag>(declared);
    for (const [key, cached] of cache) if (!all.has(key)) all.set(key, cached.flag);
    return [...all.values()];
  };

  const resolver: FlagResolver = {
    value: valueOf,
    details,
    watch(flag, onChange, watchOptions) {
      return watch(() => valueOf(flag), onChange, {
        scope: watchOptions.scope,
        ...(watchOptions.fireImmediately === undefined ? {} : { fireImmediately: watchOptions.fireImmediately }),
      });
    },
    get ready() {
      return entries.get().every((entry) => entry.machine.state !== 'not-ready');
    },
    providers() {
      return entries.get().map((entry) => ({
        id: entry.provider.id,
        layer: entry.provider.layer,
        status: entry.machine.state,
        identityBound: isIdentityBound(entry.provider),
        error: entry.error.get(),
      }));
    },
    flags: () => knownFlags(),
    inspect: () => untracked(() => knownFlags().map((flag) => details(flag))),
    snapshot: () => untracked(() => Object.fromEntries(knownFlags().map((flag) => [flag.key, details(flag).value]))),
    register,
    addProvider,
    initialize(signal = scope.signal) {
      if (disposed) return Promise.resolve(ok());
      if (initPromise === undefined) {
        initSignal = signal;
        const span = telemetry.span('config.initialize', { subsystem: FLAGS_SUBSYSTEM });
        initPromise = Promise.all(untracked(() => entries.get()).map((entry) => initEntry(entry, signal))).then(() => {
          span.end(signal.aborted ? 'cancelled' : 'ok');
          if (signal.aborted) {
            initPromise = undefined;
            return err(toSfError(signal.reason ?? new DOMException('aborted', 'AbortError')));
          }
          return ok();
        });
      }
      return initPromise;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await scope.dispose();
      for (const entry of untracked(() => entries.get())) {
        entry.unsubscribe();
        entry.reconcile?.abort();
        send(entry, 'dispose');
        try {
          await entry.provider.dispose?.();
        } catch (error) {
          telemetry.event('config.provider-dispose-failed', {
            subsystem: FLAGS_SUBSYSTEM,
            level: 'critical',
            attrs: { provider: entry.provider.id, error: toSfError(error).message },
          });
        }
      }
    },
  };
  return resolver;
}
