import { ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createFlagResolver,
  defineFlag,
  type EvaluationContext,
  flagType,
  fromOpenFeatureProvider,
  type JsonObject,
  type OpenFeatureEvent,
  type OpenFeatureEventDetails,
  OpenFeatureEvents,
  type OpenFeatureProviderLike,
  type OpenFeatureResolutionDetails,
  staticContext,
} from './index.js';

const Bool = defineFlag({ key: 'of/bool', type: flagType.boolean(), default: false, owner: 't', preAuthSafe: true, description: '' });
const Str = defineFlag({ key: 'of/str', type: flagType.enum(['A', 'B']), default: 'A', owner: 't', preAuthSafe: true, description: '' });
const Num = defineFlag({ key: 'of/num', type: flagType.number(), default: 1, owner: 't', preAuthSafe: true, description: '' });
const isObj = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null;
const Obj = defineFlag({ key: 'of/obj', type: flagType.object(isObj), default: {}, owner: 't', preAuthSafe: true, description: '' });

/** In-memory OpenFeature-style provider (structurally an OpenFeature web provider). */
function inMemoryProvider(flags: Record<string, OpenFeatureResolutionDetails<unknown> | (() => never)>) {
  const handlers = new Map<OpenFeatureEvent, Set<(d?: OpenFeatureEventDetails) => void>>();
  const resolveAny = <T>(key: string, defaultValue: T): OpenFeatureResolutionDetails<T> => {
    const entry = flags[key];
    if (entry === undefined) return { value: defaultValue, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' };
    if (typeof entry === 'function') return entry();
    return entry as OpenFeatureResolutionDetails<T>;
  };
  const provider = {
    metadata: { name: 'in-memory' },
    runsOn: 'client' as const,
    initialize: vi.fn(async (_context?: EvaluationContext) => undefined),
    onContextChange: vi.fn(async (_old: EvaluationContext, _next: EvaluationContext) => undefined),
    onClose: vi.fn(async () => undefined),
    events: {
      addHandler(event: OpenFeatureEvent, handler: (d?: OpenFeatureEventDetails) => void) {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
      },
      removeHandler(event: OpenFeatureEvent, handler: (d?: OpenFeatureEventDetails) => void) {
        handlers.get(event)?.delete(handler);
      },
    },
    emit(event: OpenFeatureEvent, details?: OpenFeatureEventDetails) {
      for (const h of handlers.get(event) ?? []) h(details);
    },
    handlerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    resolveBooleanEvaluation: (key: string, d: boolean) => resolveAny(key, d),
    resolveStringEvaluation: (key: string, d: string) => resolveAny(key, d),
    resolveNumberEvaluation: (key: string, d: number) => resolveAny(key, d),
    resolveObjectEvaluation: <T,>(key: string, d: T) => resolveAny(key, d),
  };
  return provider satisfies OpenFeatureProviderLike;
}

describe('fromOpenFeatureProvider', () => {
  it('maps typed resolve* calls, reasons and variants', async () => {
    const provider = inMemoryProvider({
      'of/bool': { value: true, reason: 'TARGETING_MATCH', variant: 'on' },
      'of/str': { value: 'B', reason: 'SPLIT', variant: 'B', flagMetadata: { exp: 'x' } },
      'of/num': { value: 7, reason: 'whatever' },
      'of/obj': { value: { a: 1 }, reason: 'STATIC' },
    });
    const layer = fromOpenFeatureProvider(provider, { layer: 'experiment' });
    expect(layer.id).toBe('openfeature/in-memory');
    expect(layer.layer).toBe('experiment');
    const resolver = createFlagResolver({ providers: [layer], context: staticContext({ targetingKey: 'u' }, true) });
    await resolver.initialize();
    expect(provider.initialize).toHaveBeenCalledWith({ targetingKey: 'u' });
    expect(resolver.details(Bool)).toMatchObject({ value: true, reason: 'TARGETING_MATCH', variant: 'on', layer: 'experiment' });
    expect(resolver.details(Str)).toMatchObject({ value: 'B', reason: 'SPLIT', flagMetadata: { exp: 'x' } });
    expect(resolver.details(Num)).toMatchObject({ value: 7, reason: 'UNKNOWN' });
    expect(resolver.value(Obj)).toEqual({ a: 1 });
  });

  it('FLAG_NOT_FOUND / DEFAULT / DISABLED fall through; other error codes are SF-CFG-006', () => {
    const layer = fromOpenFeatureProvider(
      inMemoryProvider({
        'of/str': { value: 'A', reason: 'DEFAULT' },
        'of/num': { value: 1, reason: 'DISABLED' },
        'of/obj': { value: {}, reason: 'ERROR', errorCode: 'PARSE_ERROR', errorMessage: 'bad json' },
        'of/bool': () => {
          throw new Error('provider crashed');
        },
      }),
      { id: 'vendor/flags', keyOf: (flag) => flag.key },
    );
    expect(layer.lookup(Str, {})).toEqual(ok(undefined));
    expect(layer.lookup(Num, {})).toEqual(ok(undefined));
    const parse = layer.lookup(Obj, {});
    expect(!parse.ok && parse.error.code).toBe('SF-CFG-006');
    expect(!parse.ok && parse.error.message).toBe('bad json');
    const crash = layer.lookup(Bool, {});
    expect(!crash.ok && crash.error.code).toBe('SF-CFG-006');
    const missing = fromOpenFeatureProvider(inMemoryProvider({}));
    expect(missing.lookup(Bool, {})).toEqual(ok(undefined));
    const noMessage = fromOpenFeatureProvider(inMemoryProvider({ 'of/bool': { value: false, errorCode: 'GENERAL' } }));
    const general = noMessage.lookup(Bool, {});
    expect(!general.ok && general.error.message).toContain('GENERAL');
  });

  it('maps provider events and unsubscribes', async () => {
    const provider = inMemoryProvider({ 'of/bool': { value: true, reason: 'STATIC' } });
    const resolver = createFlagResolver({ providers: [fromOpenFeatureProvider(provider, { identityBound: false })] });
    await resolver.initialize();
    provider.emit(OpenFeatureEvents.Stale);
    expect(resolver.providers()[0]?.status).toBe('stale');
    provider.emit(OpenFeatureEvents.Ready);
    expect(resolver.providers()[0]?.status).toBe('ready');
    provider.emit(OpenFeatureEvents.ConfigurationChanged, { flagsChanged: ['of/bool'] });
    provider.emit(OpenFeatureEvents.ConfigurationChanged);
    provider.emit(OpenFeatureEvents.Error, { message: 'oops' });
    expect(resolver.providers()[0]?.status).toBe('error');
    provider.emit(OpenFeatureEvents.Error, { errorCode: 'PROVIDER_FATAL' });
    expect(resolver.providers()[0]?.status).toBe('fatal');
    expect(provider.handlerCount()).toBe(4);
    await resolver.dispose();
    expect(provider.handlerCount()).toBe(0);
    expect(provider.onClose).toHaveBeenCalled();
  });

  it('wraps initialize / onContextChange failures and honours abort', async () => {
    const provider = inMemoryProvider({});
    provider.initialize.mockRejectedValueOnce(new Error('init down'));
    provider.onContextChange.mockRejectedValueOnce(new Error('ctx down'));
    const layer = fromOpenFeatureProvider(provider);
    const signal = new AbortController().signal;
    const init = await layer.initialize?.({}, signal);
    expect(init !== undefined && !init.ok && init.error.code).toBe('SF-CFG-003');
    const change = await layer.onContextChange?.({}, { a: 1 }, signal);
    expect(change !== undefined && !change.ok && change.error.code).toBe('SF-CFG-004');
    expect(await layer.onContextChange?.({}, { a: 2 }, signal)).toEqual(ok());

    const aborted = new AbortController();
    aborted.abort();
    const pre = await layer.initialize?.({}, aborted.signal);
    expect(pre !== undefined && !pre.ok && pre.error.kind).toBe('aborted');
    const hanging = inMemoryProvider({});
    hanging.initialize.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = fromOpenFeatureProvider(hanging).initialize?.({}, controller.signal);
    controller.abort();
    const late = await pending;
    expect(late !== undefined && !late.ok && late.error.kind).toBe('aborted');
  });

  it('providers without optional members work', async () => {
    const minimal: OpenFeatureProviderLike = {
      metadata: { name: 'min' },
      resolveBooleanEvaluation: (_k, d) => ({ value: !d, reason: 'STATIC' }),
      resolveStringEvaluation: (_k, d) => ({ value: d, reason: 'DEFAULT' }),
      resolveNumberEvaluation: (_k, d) => ({ value: d, reason: 'DEFAULT' }),
      resolveObjectEvaluation: (_k, d) => ({ value: d, reason: 'DEFAULT' }),
    };
    const layer = fromOpenFeatureProvider(minimal, { logger: console });
    expect(await layer.initialize?.({}, new AbortController().signal)).toEqual(ok());
    expect(await layer.onContextChange?.({}, {}, new AbortController().signal)).toEqual(ok());
    expect(layer.subscribe?.(() => undefined)()).toBeUndefined();
    await layer.dispose?.();
    expect(layer.lookup(Bool, {})).toEqual(ok({ value: true, reason: 'STATIC' }));
    expect(layer.hooks).toBeUndefined();
    const hooked = fromOpenFeatureProvider({ ...minimal, hooks: [{}] });
    expect(hooked.hooks).toHaveLength(1);
  });
});
