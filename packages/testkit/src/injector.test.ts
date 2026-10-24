import { bind, contribution, token, unit, variant } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { asOverrides, createSeededRandom, createTestInjector, createTestTelemetry, OVERRIDE_SOURCE, provideValue, VIOLATION_EVENT } from './index.js';

interface Greeter {
  greet(name: string): string;
}
const GreeterToken = token('it/greeter').type<Greeter>();
const ConsumerToken = token('it/consumer').type<{ readonly message: string }>();
const PluginsToken = token('it/plugins').multi<string>();

const realGreeter = unit({ id: 'it/real-greeter', provides: GreeterToken, scope: 'app', create: () => ({ greet: (n: string) => `Hello ${n}` }) });
const fakeGreeter = unit({ id: 'it/fake-greeter', provides: GreeterToken, scope: 'app', create: () => ({ greet: (n: string) => `fake ${n}` }) });
const consumer = unit({
  id: 'it/consumer',
  provides: ConsumerToken,
  scope: 'app',
  deps: { required: { greeter: GreeterToken } },
  create: ({ greeter }, ctx) => {
    const span = ctx.telemetry.span('consumer.work', { subsystem: 'it/consumer', parent: ctx.span });
    span.end('ok');
    return { message: greeter.greet('Ada') };
  },
});

describe('createTestInjector', () => {
  it('resolves units and records DI spans at debug level by default', async () => {
    const t = createTestInjector({ units: [realGreeter, consumer] });
    expect((await t.get(ConsumerToken)).message).toBe('Hello Ada');
    expect(t.spans('di.resolve').map((s) => s.attrs['unit'])).toEqual(['it/real-greeter', 'it/consumer']);
    expect(t.spans({ subsystem: 'core/di' }).length).toBe(2);
    expect(t.spans({ name: /^di\./, attrs: { unit: 'it/consumer' } })).toHaveLength(1);
    expect(t.spans({ status: 'error' })).toEqual([]);
    expect(t.injector.level).toBe('app');
    expect(t.injector.name).toBe('test');
    await t.dispose();
  });

  it('overrides beat regular bindings, app-precedence binds and experiment variants registered earlier', async () => {
    const t = createTestInjector({
      units: [bind(realGreeter, { precedence: 'app' }), variant({ of: GreeterToken, unit: realGreeter, when: () => true }), consumer],
      overrides: [fakeGreeter],
    });
    expect((await t.get(ConsumerToken)).message).toBe('fake Ada');
    await t.dispose();
  });

  it('keeps a binding override `when` condition', async () => {
    const t = createTestInjector({ units: [realGreeter, consumer], overrides: [bind(fakeGreeter, { when: () => false })] });
    expect((await t.get(ConsumerToken)).message).toBe('Hello Ada');
    await t.dispose();
  });

  it('asOverrides re-binds at experiment precedence with a source', () => {
    const [plain, bound] = asOverrides([fakeGreeter, bind(fakeGreeter, { source: 'mine' })]);
    expect(plain).toMatchObject({ precedence: 'experiment', source: OVERRIDE_SOURCE });
    expect(bound).toMatchObject({ precedence: 'experiment', source: 'mine' });
  });

  it('provideValue binds a fixed value', async () => {
    const t = createTestInjector({ units: [realGreeter, consumer], overrides: [provideValue(GreeterToken, { greet: () => 'value' })] });
    expect((await t.get(ConsumerToken)).message).toBe('value');
    await t.dispose();
  });

  it('get throws SF-TEST-002 with the injector error as cause', async () => {
    const t = createTestInjector({ units: [consumer] });
    await expect(t.get(ConsumerToken)).rejects.toMatchObject({ code: 'SF-TEST-002' });
    const failure = await t.get(ConsumerToken).catch((e: unknown) => e as { cause: { code: string } });
    expect(failure.cause.code).toBe('SF-DI-001');
    expect(t.spans({ status: 'error' }).length).toBeGreaterThan(0);
    await t.dispose();
  });

  it('respects level and telemetry level options', async () => {
    const t = createTestInjector({ level: 'session', telemetryLevel: 'standard', units: [unit({ id: 'it/s', provides: GreeterToken, scope: 'session', create: () => ({ greet: () => 's' }) })] });
    expect(t.injector.level).toBe('session');
    await t.get(GreeterToken);
    // di.resolve of a non-critical unit is `verbose` → not recorded at `standard`.
    expect(t.spans('di.resolve')).toEqual([]);
    await t.dispose();
  });

  it('multi tokens and contributions work with overrides', async () => {
    const a = contribution({ id: 'it/a', provides: PluginsToken, scope: 'app', create: () => 'a' as never });
    const b = contribution({ id: 'it/b', provides: PluginsToken, scope: 'app', create: () => 'b' as never });
    const t = createTestInjector({ units: [a], overrides: [b] });
    expect(await t.get(PluginsToken)).toEqual(['a', 'b']);
    await t.dispose();
  });

  it('spanTree / expectChildSpan / formatSpanTree describe parent-child structure', async () => {
    const t = createTestInjector({ units: [realGreeter, consumer] });
    await t.get(ConsumerToken);
    t.expectChildSpan('di.resolve', 'consumer.work');
    t.expectChildSpan({ name: 'di.resolve', attrs: { unit: 'it/consumer' } }, { name: 'di.resolve', attrs: { unit: 'it/real-greeter' } });
    expect(() => t.expectChildSpan('consumer.work', 'di.resolve')).toThrow(/SF-TEST-005|is a child/);
    expect(() => t.expectChildSpan('missing', 'di.resolve')).toThrow(/No span matches parent/);
    const tree = t.spanTree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.attrs['unit']).toBe('it/consumer');
    expect(tree[0]?.children.map((c) => c.name).sort()).toEqual(['consumer.work', 'di.resolve']);
    expect(t.spanTree('consumer.work')).toHaveLength(1);
    expect(t.formatSpanTree()).toContain('di.resolve [ok]\n  ');
    await t.dispose();
  });

  it('events(), violations() and expectNoViolations()', async () => {
    const t = createTestInjector();
    t.telemetry.event('thing.happened', { subsystem: 'it/x', attrs: { n: 1 } });
    expect(t.events('thing.happened')).toHaveLength(1);
    expect(t.violations()).toEqual([]);
    t.expectNoViolations();
    t.telemetry.event(VIOLATION_EVENT, {
      subsystem: 'perf/conformance',
      level: 'critical',
      attrs: { code: 'SF-PERF-001', fix: 'Batch reads.', unit: 'it/u', message: 'forced layout' },
    });
    expect(t.violations()).toEqual([
      expect.objectContaining({ code: 'SF-PERF-001', fix: 'Batch reads.', unit: 'it/u', subsystem: 'perf/conformance', message: 'forced layout' }),
    ]);
    expect(() => t.expectNoViolations()).toThrow(/SF-PERF-001.*fix: Batch reads\./s);
    t.clear();
    expect(t.records).toEqual([]);
    await t.dispose();
  });
});

describe('createTestTelemetry', () => {
  it('reports open spans, metrics, and is deterministic', () => {
    const one = createTestTelemetry({ now: () => 5 });
    const two = createTestTelemetry({ now: () => 5 });
    const a = one.telemetry.span('open', { subsystem: 'it/x' });
    two.telemetry.span('open', { subsystem: 'it/x' });
    expect(a.context?.spanId).toBe(two.openSpans()[0]?.context.spanId);
    expect(one.openSpans('open')).toHaveLength(1);
    expect(one.spanTree()[0]?.status).toBe('open');
    a.end('cancelled');
    expect(one.openSpans()).toEqual([]);
    expect(one.spans({ status: 'cancelled' })).toHaveLength(1);
    one.telemetry.record({ kind: 'metric', metricKind: 'counter', id: 'it/count', unit: undefined, description: undefined }, 2);
    expect(one.metrics().map((m) => m.value)).toEqual([2]);
    expect(one.metrics({ kind: 'metric', metricKind: 'counter', id: 'it/other', unit: undefined, description: undefined })).toEqual([]);
    one.dispose();
    one.telemetry.event('after', { subsystem: 'it/x' });
    expect(one.events('after')).toEqual([]);
  });

  it('createSeededRandom is reproducible and in [0, 1)', () => {
    const a = createSeededRandom(7);
    const b = createSeededRandom(7);
    const values = Array.from({ length: 100 }, () => a());
    expect(values).toEqual(Array.from({ length: 100 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(createSeededRandom(8)()).not.toBe(values[0]);
  });

  it('subsystem levels can silence a subsystem', () => {
    const t = createTestTelemetry({ levels: { 'it/quiet': 'off' } });
    t.telemetry.span('x', { subsystem: 'it/quiet' }).end();
    t.telemetry.span('y', { subsystem: 'it/loud' }).end();
    expect(t.spans().map((s) => s.name)).toEqual(['y']);
  });
});
