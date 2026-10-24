import { describe, expect, it, vi } from 'vitest';
import { box, composeUnits, createInjector, unit } from '@staticflux/core';
import {
  GateFacts,
  GateToken,
  MeterBackendToken,
  MeterRegistryToken,
  WILDCARD,
  all,
  always,
  compilePolicies,
  createEntitlementSource,
  createManualFactSource,
  defineAction,
  defineFact,
  defineMeter,
  definePolicy,
  definePolicySet,
  denialError,
  evaluateCondition,
  fact,
  factEquals,
  factSourceUnit,
  flagFact,
  gateResource,
  gateUnits,
  lookupEntry,
  meterDefinitionUnit,
  never,
  policySetUnit,
  reactiveFactSource,
  tableKey,
  validateCondition,
  validatePolicies,
  type Decision,
  type EvaluateContext,
  type GateClock,
} from './index.js';

const ctx = (facts: Record<string, unknown>): EvaluateContext => ({ read: (id) => facts[id], meterModes: new Map(), tableVersion: 1, unmatched: 'allow' });

describe('policy IR and builders', () => {
  it('definePolicy produces plain, serializable IR', () => {
    const Edit = defineAction('studio/edit');
    const Credits = defineMeter('billing/credits', { unit: 'credits' });
    const ir = definePolicy({
      id: 'studio/edit',
      resource: gateResource('capability', 'studio/doc'),
      actions: [Edit],
      when: fact(GateFacts.roles).has('editor'),
      cost: { meter: Credits, amount: 2 },
    });
    expect(ir).toEqual({
      id: 'studio/edit',
      effect: 'permit',
      resource: { level: 'capability', ids: ['studio/doc'] },
      actions: ['studio/edit'],
      when: { op: 'has', fact: 'session/roles', value: 'editor' },
      cost: { meter: 'billing/credits', amount: 2 },
    });
    expect(validatePolicies(JSON.parse(JSON.stringify([ir]))).ok).toBe(true);
    expect(flagFact('studio/ai').id).toBe('flag:studio/ai');
    expect(defineFact('x/y', 'doc').type<number>().description).toBe('doc');
  });

  it('evaluates every condition operator, failing closed on missing facts', () => {
    const f = { 'a/n': 5, 'a/s': 'x', 'a/l': ['p', 'q'], 'a/b': true };
    const cases: [Parameters<typeof evaluateCondition>[0], boolean][] = [
      [{ op: 'eq', fact: 'a/s', value: 'x' }, true],
      [{ op: 'neq', fact: 'a/s', value: 'y' }, true],
      [{ op: 'neq', fact: 'a/missing', value: 'y' }, false],
      [{ op: 'in', fact: 'a/s', values: ['x', 'z'] }, true],
      [{ op: 'gt', fact: 'a/n', value: 5 }, false],
      [{ op: 'gte', fact: 'a/n', value: 5 }, true],
      [{ op: 'lt', fact: 'a/n', value: 6 }, true],
      [{ op: 'lte', fact: 'a/n', value: 4 }, false],
      [{ op: 'gte', fact: 'a/s', value: 1 }, false],
      [{ op: 'truthy', fact: 'a/b' }, true],
      [{ op: 'truthy', fact: 'a/missing' }, false],
      [{ op: 'has', fact: 'a/l', value: 'q' }, true],
      [{ op: 'has', fact: 'a/s', value: 'x' }, false],
      [always, true],
      [never, false],
      [all(), true],
      [{ op: 'any', of: [] }, false],
      [{ op: 'not', of: never }, true],
    ];
    for (const [condition, expected] of cases) {
      expect(evaluateCondition(condition, ctx(f), () => undefined).pass, JSON.stringify(condition)).toBe(expected);
    }
  });

  it('propagates the first failing reason; node reasons override', () => {
    const c = all({ op: 'truthy', fact: 'a/x', because: { reason: 'unavailable' } }, { op: 'truthy', fact: 'a/y', because: { reason: 'upgrade' } });
    expect(evaluateCondition(c, ctx({}), () => undefined).because).toEqual({ reason: 'unavailable' });
    expect(evaluateCondition({ ...c, because: { reason: 'login' } }, ctx({}), () => undefined).because).toEqual({ reason: 'login' });
    expect(evaluateCondition({ op: 'covers', meter: 'm/r', amount: 2 }, { ...ctx({ 'meter:m/r': 1 }), meterModes: new Map([['m/r', 'rate']]) }, () => undefined).because).toEqual({
      reason: 'rate',
      meta: { meter: 'm/r', required: 2, available: 1 },
    });
  });

  it('validates untrusted remote JSON with paths', () => {
    const bad = [
      [{}],
      [{ id: 'a/b', effect: 'allow', resource: { level: 'route' } }],
      [{ id: 'a/b', effect: 'permit', resource: { level: 'nope' } }],
      [{ id: 'a/b', effect: 'permit', resource: { level: 'route', ids: [1] } }],
      [{ id: 'a/b', effect: 'permit', resource: { level: 'route' }, subjects: ['robot'] }],
      [{ id: 'a/b', effect: 'permit', resource: { level: 'route' }, actions: ['bad'] }],
      [{ id: 'a/b', effect: 'permit', resource: { level: 'route' }, when: { op: 'eq', fact: 'x/y' } }],
      [{ id: 'a/b', effect: 'permit', resource: { level: 'route' }, when: { op: 'all', of: [{ op: 'zzz' }] } }],
      [{ id: 'a/b', effect: 'permit', resource: { level: 'route' }, deny: { reason: 'because' } }],
      [{ id: 'a/b', effect: 'permit', resource: { level: 'route' }, cost: { meter: 'm/c', amount: -1 } }],
    ];
    for (const policies of bad) {
      const r = validatePolicies(policies);
      expect(r.ok, JSON.stringify(policies)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SF-GATE-010');
    }
    const nested = validatePolicies([{ id: 'a/b', effect: 'permit', resource: { level: 'route' }, when: { op: 'not', of: { op: 'gte', fact: 'x/y', value: 'q' } } }]);
    expect(!nested.ok && nested.error.details['path']).toBe('[0].when.of');
    for (const good of [
      { op: 'const', value: true },
      { op: 'in', fact: 'x/y', values: ['a', 1, null] },
      { op: 'truthy', fact: 'flag:x/y' },
      { op: 'covers', meter: 'm/c', amount: 1, because: { reason: 'quota', meta: { k: 'v' } } },
      { op: 'any', of: [{ op: 'lt', fact: 'x/y', value: 1 }] },
    ]) {
      expect(validateCondition(good).ok, JSON.stringify(good)).toBe(true);
    }
    expect(validateCondition({ op: 'const', value: 1 }).ok).toBe(false);
    expect(validateCondition({ op: 'covers', meter: 'x', amount: 1 }).ok).toBe(false);
  });
});

describe('compiler', () => {
  it('expands wildcards into a table with a fact → entry reverse index', () => {
    const Edit = defineAction('s/edit');
    const compiled = compilePolicies(
      [
        definePolicySet('t/defaults', [
          definePolicy({ id: 't/all-features', resource: { level: 'feature' }, when: fact(GateFacts.region).neq('x') }),
          definePolicy({ id: 't/studio-edit', resource: gateResource('feature', 'studio'), actions: [Edit], when: fact(GateFacts.plan).eq('pro') }),
        ]),
      ],
      7,
    );
    if (!compiled.ok) throw compiled.error;
    const table = compiled.value;
    expect(table.version).toBe(7);
    expect([...table.entries.keys()].sort()).toEqual(
      [tableKey('feature', WILDCARD, WILDCARD), tableKey('feature', WILDCARD, 's/edit'), tableKey('feature', 'studio', WILDCARD), tableKey('feature', 'studio', 's/edit')].sort(),
    );
    expect(lookupEntry(table, 'feature', 'studio', 's/edit')?.policies.map((p) => p.id)).toEqual(['t/all-features', 't/studio-edit']);
    expect(lookupEntry(table, 'feature', 'studio', 'other/action')?.key).toBe(tableKey('feature', 'studio', WILDCARD));
    expect(lookupEntry(table, 'feature', 'billing', 's/edit')?.key).toBe(tableKey('feature', WILDCARD, 's/edit'));
    expect(lookupEntry(table, 'feature', 'billing', 'other/action')?.key).toBe(tableKey('feature', WILDCARD, WILDCARD));
    expect(lookupEntry(table, 'route', '/x', 'a/b')).toBeUndefined();
    expect(table.byFact.get('billing/plan')?.map((e) => e.key)).toEqual([tableKey('feature', 'studio', 's/edit')]);
    expect(table.byFact.get('gate/subject-kind')).toHaveLength(4);
  });

  it('layers remote overrides over defaults and rejects duplicates within a layer', () => {
    const p = definePolicy({ id: 't/p', resource: { level: 'app' } });
    const merged = compilePolicies(
      [definePolicySet('t/d', [p]), { id: 't/r', layer: 'remote', policies: [{ ...p, effect: 'forbid' }] }],
      1,
    );
    expect(merged.ok && merged.value.policies.map((x) => [x.id, x.ir.effect, x.layer])).toEqual([['t/p', 'forbid', 'remote']]);
    const dup = compilePolicies([definePolicySet('t/a', [p, p])], 1);
    expect(!dup.ok && dup.error.code).toBe('SF-GATE-011');
  });

  it('denialError maps every reason to a typed code', () => {
    const mk = (reason: string): Decision & { effect: 'deny' } =>
      ({ effect: 'deny', reason, meta: {}, alternatives: [], trace: { key: 'k', determining: [] } }) as never;
    expect(['login', 'quota', 'rate', 'unavailable', 'upgrade', 'forbidden'].map((r) => denialError(mk(r)).code)).toEqual([
      'SF-GATE-002',
      'SF-GATE-003',
      'SF-GATE-004',
      'SF-GATE-005',
      'SF-GATE-001',
      'SF-GATE-001',
    ]);
  });
});

describe('fact sources', () => {
  it('manual sources replay current values on connect', () => {
    const src = createManualFactSource('t/src', [GateFacts.plan]);
    src.set(GateFacts.plan, 'pro');
    const seen: unknown[] = [];
    const disconnect = src.connect({ set: (f, v) => seen.push([f.id, v]), batch: (fn) => fn() });
    src.set(GateFacts.region, 'eu');
    disconnect();
    src.set(GateFacts.region, 'us');
    expect(seen).toEqual([
      ['billing/plan', 'pro'],
      ['platform/region', 'eu'],
    ]);
    expect(src.get(GateFacts.region)).toBe('us');
    expect(src.facts.map((f) => f.id)).toEqual(['billing/plan', 'platform/region']);
  });

  it('reactive sources follow observable state', () => {
    const tier = box('high');
    const src = reactiveFactSource('t/platform', [{ fact: GateFacts.formFactor, read: () => tier.get() }]);
    const seen: unknown[] = [];
    const disconnect = src.connect({ set: (_f, v) => seen.push(v), batch: (fn) => fn() });
    tier.set('compact');
    disconnect();
    tier.set('expanded');
    expect(seen).toEqual(['high', 'compact']);
  });

  it('entitlements: offline grace then fail closed; revocation is immediate (R6.14, R6.15)', () => {
    let time = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const clock: GateClock = { now: () => time, setTimer: (fn, ms) => { const t = { at: time + ms, fn }; timers.push(t); return () => timers.splice(timers.indexOf(t), 1); } };
    const src = createEntitlementSource({ clock, graceMs: 1_000 });
    const seen: unknown[] = [];
    src.connect({ set: (_f, v) => seen.push(v), batch: (fn) => fn() });
    src.setFromServer(['ai', 'export']);
    src.revoke('export');
    expect(src.current).toEqual(['ai']);
    src.setOffline(true);
    src.setOffline(true);
    expect(timers).toHaveLength(1);
    src.setOffline(false);
    expect(timers).toHaveLength(0);
    src.setOffline(true);
    time = 1_000;
    timers.shift()?.fn();
    expect(src.current).toEqual([]);
    src.setOffline(true);
    src.setFromServer(['ai']);
    expect(timers).toHaveLength(0);
    expect(seen).toEqual([['ai', 'export'], ['ai'], [], ['ai']]);
  });

  it('factEquals compares arrays shallowly', () => {
    expect(factEquals(['a'], ['a'])).toBe(true);
    expect(factEquals(['a'], ['b'])).toBe(false);
    expect(factEquals(['a'], 'a')).toBe(false);
    expect(factEquals(Number.NaN, Number.NaN)).toBe(true);
  });
});

describe('gate units', () => {
  it('compose: one-line opt-in plus contributed policies, facts and meters', async () => {
    const Credits = defineMeter('billing/credits', { unit: 'credits' });
    const facts = createManualFactSource('test/facts');
    const units = composeUnits([
      ...gateUnits,
      policySetUnit('test/policies-unit', definePolicySet('test/p', [definePolicy({ id: 'test/studio', resource: gateResource('route', '/studio'), when: fact(GateFacts.authenticated).eq(true) })])),
      factSourceUnit('test/facts-unit', () => facts),
      meterDefinitionUnit('test/credits-unit', Credits),
    ]);
    const injector = createInjector({ units });
    const gate = await injector.get(GateToken);
    if (!gate.ok) throw gate.error;
    expect(gate.value.decide('route', '/studio').effect).toBe('deny');
    facts.set(GateFacts.authenticated, true);
    expect(gate.value.decide('route', '/studio').effect).toBe('allow');
    const meters = await injector.get(MeterRegistryToken);
    expect(meters.ok && meters.value.meters.map((m) => m.def.id)).toEqual(['billing/credits']);
    await injector.dispose();
    facts.set(GateFacts.authenticated, false);
    expect(gate.value.decide('route', '/studio').effect).toBe('allow'); // disposed: disconnected from sources
  });

  it('an app-bound meter backend overrides the local default', async () => {
    const reserve = vi.fn(async () => ({ ok: true as const, value: { reservationId: 'srv' } }));
    const backendUnit = unit({ id: 'test/backend', provides: MeterBackendToken, scope: 'app', create: () => ({ reserve, commit: reserve as never, release: reserve as never }) });
    const Credits = defineMeter('billing/credits', { unit: 'credits' });
    const injector = createInjector({ units: [...gateUnits, backendUnit, meterDefinitionUnit('test/credits-unit', Credits)] });
    const meters = await injector.get(MeterRegistryToken);
    if (!meters.ok) throw meters.error;
    const credits = meters.value.get(Credits);
    if (!credits.ok) throw credits.error;
    const r = await credits.value.reserve(1);
    expect(r.ok && r.value.id).toBe('srv');
    await injector.dispose();
  });
});
