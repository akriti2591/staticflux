import { box, createMemorySink, createScope, createTelemetry, effect, err, ok, type Result, toSfError } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createFlagResolver,
  createStaticLayer,
  defineFlag,
  derivedContext,
  type EvaluationContext,
  type FlagHook,
  type FlagLayerProvider,
  flagType,
  type LayerEvent,
  ProviderEvaluationError,
  staticContext,
} from './index.js';

const Ai = defineFlag({ key: 'res/ai', type: flagType.boolean(), default: false, owner: 'studio', preAuthSafe: false, description: '' });
const Theme = defineFlag({ key: 'res/theme', type: flagType.enum(['light', 'dark']), default: 'light', owner: 'shell', preAuthSafe: true, description: '' });
const Limit = defineFlag({ key: 'res/limit', type: flagType.number({ min: 0 }), default: 10, owner: 'data', preAuthSafe: true, description: '' });

/** A controllable provider for lifecycle tests. */
function controllable(
  id: string,
  layer: FlagLayerProvider['layer'],
  values: Record<string, unknown>,
  extra: Partial<FlagLayerProvider> = {},
): FlagLayerProvider & { emit(event: LayerEvent): void; values: Record<string, unknown> } {
  const listeners = new Set<(event: LayerEvent) => void>();
  const provider = {
    id,
    layer,
    values,
    lookup: (flag: { key: string }) => ok(flag.key in provider.values ? { value: provider.values[flag.key] } : undefined),
    subscribe(listener: (event: LayerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: LayerEvent) {
      for (const l of listeners) l(event);
    },
    ...extra,
  };
  return provider as never;
}

describe('layered resolution (R8.5)', () => {
  it('higher layers win; trace explains every layer', async () => {
    const app = createStaticLayer({ id: 'app/config', layer: 'app', values: { 'res/theme': 'dark', 'res/limit': 5 } });
    const workspace = createStaticLayer({ id: 'ws/expert', layer: 'workspace', values: { 'res/limit': 50 } });
    const local = createStaticLayer({ id: 'dev/local', layer: 'local', values: { 'res/limit': 1 } });
    const resolver = createFlagResolver({ providers: [local, app, workspace] });
    await resolver.initialize();
    expect(resolver.value(Theme)).toBe('dark');
    const limit = resolver.details(Limit);
    expect(limit).toMatchObject({ value: 1, layer: 'local', providerId: 'dev/local', reason: 'STATIC', flagKey: 'res/limit' });
    expect(limit.trace.map((t) => `${t.layer}:${t.outcome}`)).toEqual(['local:value', 'workspace:shadowed', 'app:shadowed', 'default:shadowed']);
    const ai = resolver.details(Ai);
    expect(ai).toMatchObject({ value: false, layer: 'default', reason: 'DEFAULT', variant: 'false' });
    expect(ai.trace.at(-1)).toEqual({ layer: 'default', providerId: undefined, outcome: 'value', value: false });
  });

  it('later providers win within the same layer', async () => {
    const a = createStaticLayer({ id: 'app/a', layer: 'app', values: { 'res/limit': 1 } });
    const b = createStaticLayer({ id: 'app/b', layer: 'app', values: { 'res/limit': 2 } });
    const resolver = createFlagResolver({ providers: [a, b] });
    await resolver.initialize();
    expect(resolver.details(Limit).providerId).toBe('app/b');
  });

  it('invalid values fall through with SF-CFG-001; provider errors with SF-CFG-006', async () => {
    const remote = controllable('remote/x', 'remote', { 'res/limit': -5 }, { identityBound: false });
    const broken = controllable('workspace/x', 'workspace', {}, {
      lookup: () => err(ProviderEvaluationError({ message: 'boom' })),
    });
    const throwing = controllable('app/throw', 'app', {}, {
      lookup: () => {
        throw new Error('kaput');
      },
    });
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const resolver = createFlagResolver({ providers: [throwing, broken, remote], telemetry });
    await resolver.initialize();
    const details = resolver.details(Limit);
    expect(details).toMatchObject({ value: 10, layer: 'default', reason: 'ERROR', errorCode: 'SF-CFG-001' });
    expect(details.trace.map((t) => t.outcome)).toEqual(['invalid', 'error', 'error', 'value']);
    expect(details.trace[1]?.errorCode).toBe('SF-CFG-006');
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'config/evaluation-errors')).toBe(true);
  });

  it('records reasons/variants from providers and STALE status', async () => {
    const remote = controllable('remote/x', 'remote', {}, {
      identityBound: false,
      lookup: () => ok({ value: 'dark', variant: 'dark-v2', reason: 'TARGETING_MATCH', flagMetadata: { rule: 'r1' } }),
    });
    const resolver = createFlagResolver({ providers: [remote] });
    await resolver.initialize();
    expect(resolver.details(Theme)).toMatchObject({ variant: 'dark-v2', reason: 'TARGETING_MATCH', flagMetadata: { rule: 'r1' } });
    remote.emit({ type: 'stale' });
    expect(resolver.details(Theme).reason).toBe('STALE');
  });
});

describe('pre-auth safety (R8.1)', () => {
  it('skips identity-bound layers for non-pre-auth-safe flags until authenticated', async () => {
    const authed = box(false);
    const context = derivedContext(() => ({ context: { targetingKey: 'u1' }, authenticated: authed.get() }));
    const remote = createStaticLayer({ id: 'remote/flags', layer: 'remote', values: { 'res/ai': true, 'res/theme': 'dark' } });
    const resolver = createFlagResolver({ providers: [remote], context });
    await resolver.initialize();
    expect(resolver.details(Ai)).toMatchObject({ value: false, reason: 'PRE_AUTH' });
    expect(resolver.details(Ai).trace[0]?.outcome).toBe('skipped-pre-auth');
    expect(resolver.value(Theme)).toBe('dark'); // preAuthSafe
    authed.set(true);
    expect(resolver.value(Ai)).toBe(true);
  });
});

describe('reactivity (R8.4)', () => {
  it('values are reactive across layer changes; watch is scope-bound', async () => {
    const local = createStaticLayer({ id: 'dev/local', layer: 'local' });
    const resolver = createFlagResolver({ providers: [local] });
    await resolver.initialize();
    const scope = createScope('t');
    const seen: boolean[] = [];
    effect(() => seen.push(resolver.value(Ai)), scope);
    const changes = vi.fn();
    resolver.watch(Ai, changes, { scope });
    local.set(Ai, true);
    local.set(Ai, true);
    local.unset(Ai);
    expect(seen).toEqual([false, true, false]);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenNthCalledWith(1, true, false);
    await scope.dispose();
    local.set(Ai, true);
    expect(changes).toHaveBeenCalledTimes(2);
    const immediate = vi.fn();
    resolver.watch(Ai, immediate, { scope: createScope('x'), fireImmediately: true });
    expect(immediate).toHaveBeenCalledWith(true, undefined);
  });

  it('runtime providers (addProvider) take effect and can be removed', async () => {
    const resolver = createFlagResolver();
    await resolver.initialize();
    const values: number[] = [];
    effect(() => values.push(resolver.value(Limit)), createScope('t'));
    const remove = resolver.addProvider(createStaticLayer({ id: 'devtools/override', layer: 'local', values: { 'res/limit': 99 } }));
    remove();
    expect(values).toEqual([10, 99, 10]);
  });
});

describe('provider lifecycle', () => {
  it('not-ready providers are skipped; initialize is single-flight', async () => {
    let finish!: (r: Result<void>) => void;
    const initialize = vi.fn(() => new Promise<Result<void>>((resolve) => (finish = resolve)));
    const remote = controllable('remote/x', 'remote', { 'res/theme': 'dark' }, { initialize });
    const resolver = createFlagResolver({ providers: [remote] });
    expect(resolver.ready).toBe(false);
    const p1 = resolver.initialize();
    const p2 = resolver.initialize();
    expect(p1).toBe(p2);
    expect(resolver.details(Theme).trace[0]?.outcome).toBe('not-ready');
    expect(resolver.providers()[0]).toMatchObject({ id: 'remote/x', status: 'not-ready', identityBound: true });
    finish(ok());
    expect(await p1).toEqual(ok());
    expect(resolver.ready).toBe(true);
    expect(resolver.value(Theme)).toBe('dark');
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('init failure → error status (SF-CFG-003), resolver keeps working', async () => {
    const failing = controllable('remote/down', 'remote', { 'res/theme': 'dark' }, {
      initialize: async () => {
        throw new Error('503');
      },
    });
    const resolver = createFlagResolver({ providers: [failing] });
    expect(await resolver.initialize()).toEqual(ok());
    expect(resolver.providers()[0]).toMatchObject({ status: 'error' });
    expect(resolver.providers()[0]?.error?.code).toBe('SF-CFG-003');
    // error-state providers may still serve cached values
    expect(resolver.value(Theme)).toBe('dark');
    failing.emit({ type: 'ready' });
    expect(resolver.providers()[0]?.status).toBe('ready');
    expect(resolver.providers()[0]?.error).toBeUndefined();
    failing.emit({ type: 'error', error: ProviderEvaluationError(), fatal: true });
    expect(resolver.providers()[0]?.status).toBe('fatal');
    expect(resolver.details(Theme).trace[0]?.outcome).toBe('not-ready');
  });

  it('init timeout', async () => {
    vi.useFakeTimers();
    try {
      const slow = controllable('remote/slow', 'remote', {}, { initialize: () => new Promise(() => undefined) });
      const resolver = createFlagResolver({ providers: [slow], initTimeoutMs: 100 });
      const pending = resolver.initialize();
      await vi.advanceTimersByTimeAsync(150);
      expect(await pending).toEqual(ok());
      expect(resolver.providers()[0]?.status).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborted initialize can be retried', async () => {
    const initialize = vi.fn(async (_c: EvaluationContext, signal: AbortSignal): Promise<Result<void>> =>
      signal.aborted ? err(toSfError(new DOMException('a', 'AbortError'))) : ok(),
    );
    const remote = controllable('remote/x', 'remote', {}, { initialize });
    const resolver = createFlagResolver({ providers: [remote] });
    const controller = new AbortController();
    controller.abort();
    const first = await resolver.initialize(controller.signal);
    expect(first.ok).toBe(false);
    expect(resolver.providers()[0]?.status).toBe('not-ready');
    expect(await resolver.initialize()).toEqual(ok());
    expect(resolver.providers()[0]?.status).toBe('ready');
  });

  it('configuration-changed re-evaluates; status transitions are telemetry events', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const remote = controllable('remote/x', 'remote', { 'res/theme': 'light' }, { identityBound: false });
    const resolver = createFlagResolver({ providers: [remote], telemetry });
    await resolver.initialize();
    const seen: string[] = [];
    effect(() => seen.push(resolver.value(Theme)), createScope('t'));
    remote.values['res/theme'] = 'dark';
    remote.emit({ type: 'configuration-changed', keys: ['res/theme'] });
    expect(seen).toEqual(['light', 'dark']);
    remote.emit({ type: 'ready' }); // invalid in ready: ignored safely
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'config.provider-status')).toBe(true);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'config.configuration-changed')).toBe(true);
  });

  it('providers added after initialize are initialized immediately', async () => {
    const resolver = createFlagResolver();
    await resolver.initialize();
    const initialize = vi.fn(async () => ok());
    resolver.addProvider(controllable('remote/late', 'remote', {}, { initialize }));
    await vi.waitFor(() => expect(resolver.providers()[0]?.status).toBe('ready'));
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('dispose disposes providers and reports failures', async () => {
    const dispose = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('x');
    });
    const resolver = createFlagResolver({
      providers: [controllable('app/a', 'app', {}, { dispose }), controllable('app/b', 'app', {}, { dispose: bad })],
    });
    await resolver.dispose();
    await resolver.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(resolver.providers().every((p) => p.status === 'disposed')).toBe(true);
    expect(await resolver.initialize()).toEqual(ok());
  });
});

describe('static-context paradigm: reconciliation', () => {
  it('reconciles providers on context change and keeps serving cached values meanwhile', async () => {
    const user = box('u1');
    const context = derivedContext(() => ({ context: { targetingKey: user.get() }, authenticated: true }));
    let finish!: (r: Result<void>) => void;
    const onContextChange = vi.fn(() => new Promise<Result<void>>((resolve) => (finish = resolve)));
    const remote = controllable('remote/x', 'remote', { 'res/ai': true }, { onContextChange });
    const plain = controllable('app/plain', 'app', {});
    const resolver = createFlagResolver({ providers: [remote, plain], context });
    await resolver.initialize();
    user.set('u1'); // same key: no reconcile
    expect(onContextChange).not.toHaveBeenCalled();
    user.set('u2');
    expect(onContextChange).toHaveBeenCalledWith({ targetingKey: 'u1' }, { targetingKey: 'u2' }, expect.any(AbortSignal));
    expect(resolver.providers()[0]?.status).toBe('reconciling');
    expect(resolver.value(Ai)).toBe(true);
    finish(ok());
    await vi.waitFor(() => expect(resolver.providers()[0]?.status).toBe('ready'));
  });

  it('a newer context change supersedes an in-flight reconcile; failures → error (SF-CFG-004 passthrough)', async () => {
    const user = box('u1');
    const context = derivedContext(() => ({ context: { targetingKey: user.get() }, authenticated: true }));
    const signals: AbortSignal[] = [];
    const resolvers: ((r: Result<void>) => void)[] = [];
    const remote = controllable('remote/x', 'remote', {}, {
      onContextChange: (_p: EvaluationContext, _n: EvaluationContext, signal: AbortSignal) =>
        new Promise<Result<void>>((resolve) => {
          signals.push(signal);
          resolvers.push(resolve);
        }),
    });
    const resolver = createFlagResolver({ providers: [remote], context });
    await resolver.initialize();
    user.set('u2');
    user.set('u3');
    expect(signals[0]?.aborted).toBe(true);
    resolvers[0]?.(ok()); // superseded: ignored
    resolvers[1]?.(err(ProviderEvaluationError({ message: 'nope' })));
    await vi.waitFor(() => expect(resolver.providers()[0]?.status).toBe('error'));
    // rejected promise path
    const rejecting = controllable('remote/r', 'remote', {}, { onContextChange: () => Promise.reject(new Error('x')) });
    const r2 = createFlagResolver({ providers: [rejecting], context });
    await r2.initialize();
    user.set('u4');
    await vi.waitFor(() => expect(r2.providers()[0]?.status).toBe('error'));
  });

  it('a provider initializing with a stale context reconciles once ready', async () => {
    const user = box('u1');
    const context = derivedContext(() => ({ context: { targetingKey: user.get() }, authenticated: true }));
    let finish!: (r: Result<void>) => void;
    const onContextChange = vi.fn(async () => ok());
    const remote = controllable('remote/x', 'remote', {}, {
      initialize: () => new Promise<Result<void>>((resolve) => (finish = resolve)),
      onContextChange,
    });
    const resolver = createFlagResolver({ providers: [remote], context });
    const init = resolver.initialize();
    user.set('u2');
    finish(ok());
    await init;
    expect(onContextChange).toHaveBeenCalledWith({ targetingKey: 'u1' }, { targetingKey: 'u2' }, expect.any(AbortSignal));
  });
});

describe('hooks (OpenFeature-shaped)', () => {
  it('runs before/after/error/finally for resolver and provider hooks; hook errors are contained', async () => {
    const calls: string[] = [];
    const hook: FlagHook = {
      before: (ctx) => calls.push(`before:${ctx.flagKey}:${ctx.flagValueType}:${ctx.clientMetadata.domain ?? '-'}`),
      after: (_ctx, d) => calls.push(`after:${String(d.value)}`),
      error: (_ctx, e) => calls.push(`error:${e.code}`),
      finally: () => calls.push('finally'),
    };
    const providerHook: FlagHook = {
      before: () => {
        throw new Error('bad hook');
      },
    };
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const remote = controllable('app/x', 'app', { 'res/limit': 'NaN' }, { hooks: [providerHook] });
    const resolver = createFlagResolver({ providers: [remote], hooks: [hook], telemetry, domain: 'studio' });
    await resolver.initialize();
    expect(resolver.value(Limit)).toBe(10);
    expect(calls).toEqual(['before:res/limit:number:studio', 'error:SF-CFG-001', 'after:10', 'finally']);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'config.hook-failed')).toBe(true);
  });
});

describe('devtools surface', () => {
  it('register / flags / inspect / snapshot; duplicate keys → SF-CFG-002', async () => {
    const twin = defineFlag({ key: 'res/ai', type: flagType.boolean(), default: true, owner: 'other', preAuthSafe: true, description: '' });
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const resolver = createFlagResolver({ flags: [Ai, Theme, twin], telemetry, context: staticContext({}, true) });
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'config.duplicate-flag')).toBe(true);
    const dup = resolver.register(twin);
    expect(!dup.ok && dup.error.code).toBe('SF-CFG-002');
    expect(resolver.register(Ai).ok).toBe(true);
    resolver.value(Limit); // read-but-undeclared flags show up too
    expect(resolver.flags().map((f) => f.key)).toEqual(['res/ai', 'res/theme', 'res/limit']);
    expect(resolver.inspect().map((d) => d.layer)).toEqual(['default', 'default', 'default']);
    expect(resolver.snapshot()).toEqual({ 'res/ai': false, 'res/theme': 'light', 'res/limit': 10 });
    // a second declaration with the same key evaluates on its own and is reported once
    resolver.value(Ai);
    expect(resolver.value(twin)).toBe(true);
    expect(resolver.value(twin)).toBe(true);
  });
});
