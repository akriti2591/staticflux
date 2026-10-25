import { describe, expect, it, vi } from 'vitest';
import { createMemorySink, createTelemetry, derived, effect } from '@staticflux/core';
import {
  AccessAction,
  GateFacts,
  because,
  createGate,
  createManualFactSource,
  createMeterRegistry,
  decisionKey,
  defineAction,
  defineMeter,
  definePolicy,
  definePolicySet,
  fact,
  flagFact,
  gateResource,
  covers,
  all,
  any,
  not,
  sessionFactSource,
  type Decision,
} from './index.js';
import { box } from '@staticflux/core';

const Credits = defineMeter('billing/credits', { unit: 'credits', lowThreshold: 10 });
const AiSuggestions = flagFact('studio/ai-suggestions');
const InsertImage = defineAction('agent/insert-image');
const DeleteDoc = defineAction('studio/delete-doc', { destructive: true });
const EditDoc = defineAction('studio/edit-doc');

const studioPolicies = definePolicySet('studio/policies', [
  definePolicy({
    id: 'studio/route-requires-login',
    resource: gateResource('route', '/studio'),
    when: because(fact(GateFacts.authenticated).eq(true), 'login'),
  }),
  definePolicy({
    id: 'studio/insert-image-pro',
    resource: gateResource('capability', 'agent/insert-image'),
    when: because(fact(GateFacts.plan).eq('pro'), 'upgrade', { plan: 'pro' }),
  }),
  definePolicy({
    id: 'studio/insert-image-credits',
    resource: gateResource('capability', 'agent/insert-image'),
    when: fact(GateFacts.authenticated).eq(true),
    cost: { meter: Credits, amount: 5 },
  }),
  definePolicy({
    id: 'studio/ai-panel',
    resource: gateResource('ui-slot', 'studio/ai-panel'),
    when: all(because(fact(AiSuggestions).truthy(), 'unavailable'), because(fact(GateFacts.entitlements).has('ai'), 'upgrade', { plan: 'pro' })),
  }),
]);

function setup(options: { unmatched?: 'allow' | 'deny' } = {}) {
  const facts = createManualFactSource('test/facts');
  const meters = createMeterRegistry({ definitions: [Credits] });
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'verbose' });
  telemetry.addSink(sink);
  const gate = createGate({ policySets: [studioPolicies], sources: [facts], meters, telemetry, ...options });
  const login = (plan = 'free'): void =>
    facts.setMany([
      [GateFacts.subjectKind, 'user'],
      [GateFacts.authenticated, true],
      [GateFacts.plan, plan],
    ]);
  return { gate, facts, meters, sink, login };
}

const reasonOf = (d: Decision): string => (d.effect === 'deny' ? d.reason : 'allow');

describe('gate: Studio policies (FEATURE-NEEDS)', () => {
  it('route:/studio requires login; guests may open other routes', () => {
    const { gate, login } = setup();
    const studio = gate.decide('route', '/studio');
    expect(studio).toMatchObject({ effect: 'deny', reason: 'login' });
    expect(gate.decide('route', '/onboarding').effect).toBe('allow');
    expect(gate.decide('route', '/').trace.source).toBe('unmatched');
    login();
    expect(gate.decide('route', '/studio').effect).toBe('allow');
  });

  it('capability:agent/insert-image — plan pro, or credits ≥ cost (allow-with-cost)', () => {
    const { gate, login, meters } = setup();
    const credits = meters.get(Credits);
    if (!credits.ok) throw credits.error;
    login('free');
    let d = gate.decide('capability', 'agent/insert-image');
    expect(d).toMatchObject({ effect: 'deny', reason: 'upgrade', meta: { plan: 'pro' } });
    expect(d.effect === 'deny' && d.alternatives).toEqual([
      { reason: 'upgrade', meta: { plan: 'pro' } },
      { reason: 'quota', meta: { meter: 'billing/credits', required: 5, available: null } },
    ]);
    credits.value.setServerState({ balance: 20 });
    d = gate.decide('capability', 'agent/insert-image');
    expect(d).toMatchObject({ effect: 'allow', cost: { meter: 'billing/credits', amount: 5 } });
    expect(d.trace.determining).toEqual(['studio/insert-image-credits']);
    login('pro');
    d = gate.decide('capability', 'agent/insert-image');
    expect(d).toMatchObject({ effect: 'allow', cost: undefined });
    expect(d.trace.determining).toEqual(['studio/insert-image-pro']);
  });

  it('ui-slot:studio/ai-panel needs the flag (unavailable) and the entitlement (upgrade)', () => {
    const { gate, facts, login } = setup();
    login();
    expect(reasonOf(gate.decide('ui-slot', 'studio/ai-panel'))).toBe('unavailable');
    facts.set(AiSuggestions, true);
    expect(gate.decide('ui-slot', 'studio/ai-panel')).toMatchObject({ effect: 'deny', reason: 'upgrade', meta: { plan: 'pro' } });
    facts.set(GateFacts.entitlements, ['ai']);
    expect(gate.decide('ui-slot', 'studio/ai-panel').effect).toBe('allow');
  });

  it('require() maps denials to typed SF-GATE errors', () => {
    const { gate, login } = setup();
    const r = gate.require('route', '/studio');
    expect(!r.ok && r.error.code).toBe('SF-GATE-002');
    expect(!r.ok && r.error.kind).toBe('auth');
    login();
    expect(gate.require('route', '/studio').ok).toBe(true);
    const upgrade = gate.require('capability', 'agent/insert-image');
    expect(!upgrade.ok && upgrade.error.code).toBe('SF-GATE-001');
    expect(gate.isAllowed('route', '/studio')).toBe(true);
    expect(gate.check(gateResource('route', '/studio')).effect).toBe('allow');
  });
});

describe('gate: reactivity and incremental recompute (R6.9)', () => {
  it('decisions are reactive and only affected entries are recomputed', () => {
    const { gate, facts, login, sink } = setup();
    login();
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(reasonOf(gate.decide('ui-slot', 'studio/ai-panel')));
    });
    const routeDecision = gate.decide('route', '/studio');
    sink.clear();
    facts.set(AiSuggestions, true);
    expect(seen).toEqual(['unavailable', 'upgrade']);
    // The flag only feeds the ai-panel entry; the route decision object is untouched.
    expect(gate.decide('route', '/studio')).toBe(routeDecision);
    const recomputes = sink.records.filter((r) => r.type === 'metric' && r.metric === 'gate/recomputes');
    expect(recomputes.map((r) => r.type === 'metric' && r.value)).toEqual([1]);
    facts.set(AiSuggestions, true); // no change → no recompute
    expect(sink.records.filter((r) => r.type === 'metric' && r.metric === 'gate/recomputes')).toHaveLength(1);
    stop();
  });

  it('batches multi-fact updates into one notification', () => {
    const { gate, facts } = setup();
    const studio = derived(() => gate.decide('route', '/studio').effect);
    const runs = vi.fn();
    const stop = effect(() => runs(studio.get()));
    facts.setMany([
      [GateFacts.subjectKind, 'user'],
      [GateFacts.authenticated, true],
    ]);
    expect(runs.mock.calls.map((c) => c[0])).toEqual(['deny', 'allow']);
    stop();
  });

  it('emits decision-change events and telemetry', () => {
    const { gate, login, sink } = setup();
    const changes = vi.fn();
    gate.onDecisionChange(changes);
    login();
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ subject: 'principal', after: expect.objectContaining({ effect: 'allow' }) }));
    expect(decisionKey('route', '/studio')).toBe('route\u0000/studio\u0000gate/access');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'gate.decision-changed')).toBe(true);
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'gate.compile')).toBe(true);
  });

  it('session facts arrive through the fact-source port (no auth import)', () => {
    const session = box({ authenticated: false, userId: undefined as string | undefined });
    const gate = createGate({ policySets: [studioPolicies], sources: [sessionFactSource(() => session.get())] });
    expect(gate.fact(GateFacts.subjectKind)).toBe('guest');
    expect(gate.decide('route', '/studio').effect).toBe('deny');
    session.set({ authenticated: true, userId: 'u1' });
    expect(gate.decide('route', '/studio').effect).toBe('allow');
    expect(gate.fact(GateFacts.userId)).toBe('u1');
    expect(gate.fact(GateFacts.roles)).toEqual([]);
    gate.dispose();
    session.set({ authenticated: false, userId: undefined });
    expect(gate.decide('route', '/studio').effect).toBe('allow');
  });

  it('meter balance changes re-evaluate cost-gated capabilities', () => {
    const { gate, login, meters } = setup();
    login();
    const credits = meters.get(Credits);
    if (!credits.ok) throw credits.error;
    credits.value.setServerState({ balance: 6 });
    expect(gate.decide('capability', 'agent/insert-image').effect).toBe('allow');
    credits.value.setServerState({ balance: 4 });
    expect(gate.decide('capability', 'agent/insert-image')).toMatchObject({ reason: 'upgrade' });
  });
});

describe('gate: explainable decisions (R6.11)', () => {
  it('explain() names determining policies and the facts used', () => {
    const { gate, login, meters } = setup();
    login('free');
    const credits = meters.get(Credits);
    if (credits.ok) credits.value.setServerState({ balance: 50 });
    const why = gate.explain('capability', 'agent/insert-image');
    expect(why.effect).toBe('allow');
    expect(why.trace).toMatchObject({
      level: 'capability',
      resourceId: 'agent/insert-image',
      actionId: AccessAction.id,
      subject: 'user',
      determining: ['studio/insert-image-credits'],
      evaluated: ['studio/insert-image-pro', 'studio/insert-image-credits'],
      source: 'policy',
    });
    expect(why.trace.facts).toEqual(
      expect.arrayContaining([
        { fact: 'billing/plan', value: 'free' },
        { fact: 'session/authenticated', value: true },
        { fact: 'meter:billing/credits', value: 50 },
      ]),
    );
    const unmatched = gate.explain('feature', 'billing');
    expect(unmatched.trace).toMatchObject({ source: 'unmatched', resourceId: 'billing', determining: [] });
  });
});

describe('gate: semantics', () => {
  it('forbid overrides permit, with its own reason', () => {
    const gate = createGate({
      policySets: [
        definePolicySet('test/p', [
          definePolicy({ id: 'test/permit', resource: gateResource('feature', 'billing') }),
          definePolicy({
            id: 'test/no-billing-in-embed',
            effect: 'forbid',
            resource: { level: 'feature' },
            when: fact(GateFacts.host).eq('embed-agent-host'),
            deny: { reason: 'unavailable', meta: { host: 'embed-agent-host' } },
          }),
        ]),
      ],
      sources: [createManualFactSource('test/host')],
    });
    expect(gate.decide('feature', 'billing').effect).toBe('allow');
    const source = createManualFactSource('test/host2');
    gate.addSource(source);
    source.set(GateFacts.host, 'embed-agent-host');
    expect(gate.decide('feature', 'billing')).toMatchObject({ effect: 'deny', reason: 'unavailable', meta: { host: 'embed-agent-host' } });
    // level-wide forbid also applies to resources without their own policies
    expect(gate.decide('feature', 'anything')).toMatchObject({ effect: 'deny', reason: 'unavailable' });
    expect(gate.decide('route', '/x').effect).toBe('allow');
  });

  it('wildcard + specific policies combine (permits OR, forbids override); actions narrow', () => {
    const facts = createManualFactSource('test/f');
    const gate = createGate({
      sources: [facts],
      policySets: [
        definePolicySet('test/p', [
          definePolicy({ id: 'test/any-route-region', resource: { level: 'route' }, when: because(fact(GateFacts.region).neq('blocked'), 'unavailable') }),
          definePolicy({
            id: 'test/edit-needs-role',
            effect: 'forbid',
            resource: gateResource('route', '/studio'),
            actions: [EditDoc],
            when: not(fact(GateFacts.roles).has('editor')),
          }),
        ]),
      ],
    });
    facts.set(GateFacts.region, 'eu');
    expect(gate.decide('route', '/studio').effect).toBe('allow');
    expect(gate.decide('route', '/studio', EditDoc)).toMatchObject({ effect: 'deny', reason: 'forbidden' });
    expect(gate.decide('route', '/studio', EditDoc).trace.determining).toEqual(['test/edit-needs-role']);
    facts.set(GateFacts.roles, ['editor']);
    expect(gate.decide('route', '/studio', EditDoc).effect).toBe('allow');
    expect(gate.decide('route', '/other', EditDoc).effect).toBe('allow');
    facts.set(GateFacts.region, 'blocked');
    expect(gate.decide('route', '/other')).toMatchObject({ reason: 'unavailable' });
    expect(gate.decide('route', '/studio', EditDoc)).toMatchObject({ reason: 'unavailable' });
  });

  it('subjects: guest-only and user-only policies', () => {
    const facts = createManualFactSource('test/f');
    const gate = createGate({
      sources: [facts],
      policySets: [definePolicySet('test/p', [definePolicy({ id: 'test/onboarding-guests', subjects: ['guest'], resource: gateResource('route', '/welcome') })]),],
    });
    expect(gate.decide('route', '/welcome').effect).toBe('allow');
    facts.set(GateFacts.subjectKind, 'user');
    // no permit applies to users → unmatched (allow) by default
    expect(gate.decide('route', '/welcome').trace.source).toBe('unmatched');
  });

  it('unmatched: deny fails closed (R6.15 style)', () => {
    const gate = createGate({ unmatched: 'deny', policySets: [studioPolicies] });
    expect(gate.decide('feature', 'unknown')).toMatchObject({ effect: 'deny', reason: 'unavailable' });
  });

  it('missing facts fail closed for comparisons', () => {
    const facts = createManualFactSource('test/f');
    const gate = createGate({
      sources: [facts],
      policySets: [
        definePolicySet('test/p', [
          definePolicy({ id: 'test/a', resource: gateResource('feature', 'a'), when: fact(GateFacts.plan).neq('free') }),
          definePolicy({ id: 'test/b', resource: gateResource('feature', 'b'), when: not(fact(GateFacts.region).in(['cn'])) }),
          definePolicy({ id: 'test/c', resource: gateResource('feature', 'c'), when: any(fact(defineFactNum).gte(3), fact(defineFactNum).lt(-1)) }),
        ]),
      ],
    });
    expect(gate.decide('feature', 'a').effect).toBe('deny');
    expect(gate.decide('feature', 'b').effect).toBe('allow');
    expect(gate.decide('feature', 'c').effect).toBe('deny');
    facts.set(defineFactNum, 3);
    expect(gate.decide('feature', 'c').effect).toBe('allow');
    facts.set(defineFactNum, undefined);
    expect(gate.decide('feature', 'c').effect).toBe('deny');
  });
});

const defineFactNum = GateFacts.formFactor as unknown as import('./facts.js').FactDef<number>;

describe('gate: agents as subjects (R6.17)', () => {
  const policies = definePolicySet('test/agents', [
    definePolicy({ id: 'test/user-edit', resource: gateResource('capability', 'studio/doc'), actions: [EditDoc, DeleteDoc], when: fact(GateFacts.authenticated).eq(true) }),
    definePolicy({ id: 'test/agent-edit', subjects: ['agent'], resource: gateResource('capability', 'studio/doc'), actions: [EditDoc] }),
    definePolicy({ id: 'test/agent-delete', subjects: ['agent'], resource: gateResource('capability', 'studio/doc'), actions: [DeleteDoc] }),
    definePolicy({ id: 'test/user-only', resource: gateResource('capability', 'billing/purchase') }),
  ]);

  it('agents get only explicitly delegated permissions, never more than the user', () => {
    const facts = createManualFactSource('test/f');
    const gate = createGate({ sources: [facts], policySets: [policies] });
    const agent = { subject: 'agent' } as const;
    expect(gate.decide('capability', 'studio/doc', EditDoc, agent)).toMatchObject({ effect: 'deny', reason: 'forbidden' }); // user not logged in
    facts.setMany([
      [GateFacts.subjectKind, 'user'],
      [GateFacts.authenticated, true],
    ]);
    expect(gate.decide('capability', 'studio/doc', EditDoc, agent)).toMatchObject({ effect: 'allow', requiresConfirmation: false });
    expect(gate.decide('capability', 'billing/purchase').effect).toBe('allow');
    expect(gate.decide('capability', 'billing/purchase', AccessAction, agent)).toMatchObject({ effect: 'deny', reason: 'forbidden', meta: { subject: 'agent' } });
    expect(gate.decide('route', '/anything', AccessAction, agent).effect).toBe('deny');
  });

  it('destructive agent actions require confirmation', () => {
    const facts = createManualFactSource('test/f');
    facts.setMany([
      [GateFacts.subjectKind, 'user'],
      [GateFacts.authenticated, true],
    ]);
    const gate = createGate({ sources: [facts], policySets: [policies] });
    const d = gate.decide('capability', 'studio/doc', DeleteDoc, { subject: 'agent' });
    expect(d).toMatchObject({ effect: 'allow', requiresConfirmation: true });
    expect(gate.decide('capability', 'studio/doc', DeleteDoc, { subject: 'agent' })).toBe(d);
    expect(gate.decide('capability', 'studio/doc', DeleteDoc)).toMatchObject({ effect: 'allow', requiresConfirmation: false });
    expect(gate.explain('capability', 'studio/doc', DeleteDoc, { subject: 'agent' })).toMatchObject({ requiresConfirmation: true });
    const built = definePolicy({ id: 'test/x', subjects: ['agent'], resource: gateResource('capability', 'y'), actions: [DeleteDoc] });
    expect(built.requiresConfirmation).toBe(true);
  });

  it('agent decisions are reactive too', () => {
    const facts = createManualFactSource('test/f');
    const gate = createGate({ sources: [facts], policySets: [policies] });
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(gate.decide('capability', 'studio/doc', EditDoc, { subject: 'agent' }).effect);
    });
    facts.setMany([
      [GateFacts.subjectKind, 'user'],
      [GateFacts.authenticated, true],
    ]);
    expect(seen).toEqual(['deny', 'allow']);
    stop();
  });
});

describe('gate: layering (R6.13)', () => {
  it('remote overrides replace, add and disable default policies without a deploy', () => {
    const { gate, login } = setup();
    login();
    const v = gate.version;
    const applied = gate.applyRemote([
      { id: 'studio/route-requires-login', disabled: true },
      { id: 'ops/beta-cohort', effect: 'permit', resource: { level: 'feature', ids: ['studio-desktop'] }, when: { op: 'has', fact: 'gate/cohorts', value: 'beta', because: { reason: 'unavailable' } } },
    ]);
    expect(applied.ok).toBe(true);
    expect(gate.version).toBe(v + 1);
    expect(gate.decide('route', '/studio').trace.source).toBe('unmatched');
    expect(gate.decide('feature', 'studio-desktop')).toMatchObject({ effect: 'deny', reason: 'unavailable' });
    expect(gate.applyRemote([]).ok).toBe(true);
    expect(gate.decide('route', '/studio').trace.determining).toEqual(['studio/route-requires-login']);
  });

  it('rejects malformed remote JSON as a whole and keeps the previous table', () => {
    const { gate } = setup();
    const v = gate.version;
    const bad = gate.applyRemote([{ id: 'ops/ok', effect: 'permit', resource: { level: 'route' } }, { id: 'nope', effect: 'permit' }]);
    expect(!bad.ok && bad.error.code).toBe('SF-GATE-010');
    expect(gate.version).toBe(v);
    expect(gate.applyRemote('nope').ok).toBe(false);
  });

  it('remote overrides are reactive for observers of affected keys', () => {
    const { gate } = setup();
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(gate.decide('feature', 'studio-desktop').effect);
    });
    gate.applyRemote([{ id: 'ops/kill-studio', effect: 'forbid', resource: { level: 'feature', ids: ['studio-desktop'] } }]);
    expect(seen).toEqual(['allow', 'deny']);
    stop();
  });

  it('feature modules can add default policy sets later; duplicate ids are rejected', () => {
    const { gate } = setup();
    expect(gate.addPolicySet(definePolicySet('billing/policies', [definePolicy({ id: 'billing/upsell', resource: gateResource('feature', 'billing'), when: fact(GateFacts.plan).eq('pro') })])).ok).toBe(true);
    expect(gate.decide('feature', 'billing').effect).toBe('deny');
    const dup = gate.addPolicySet(definePolicySet('x/y', [definePolicy({ id: 'billing/upsell', resource: { level: 'app' } })]));
    expect(!dup.ok && dup.error.code).toBe('SF-GATE-011');
    expect(gate.decide('feature', 'billing').effect).toBe('deny');
  });

  it('snapshot() is serializable for worker replication', () => {
    const { gate, login } = setup();
    login();
    const snap = gate.snapshot();
    expect(JSON.parse(JSON.stringify(snap)).decisions.length).toBe(gate.entryCount);
    expect(snap.facts).toEqual(expect.arrayContaining([['gate/subject-kind', 'user']]));
  });
});

describe('gate: large policy set', () => {
  // Correctness only. Timings for this workload live in engine.bench.ts (never asserted in unit tests).
  it('decides 10k lookups over 500 policies and recomputes after a fact change', () => {
    const policies = Array.from({ length: 500 }, (_, i) =>
      definePolicy({
        id: `perf/p${i}`,
        resource: gateResource(i % 2 === 0 ? 'feature' : 'ui-slot', `r${i}`),
        when: i % 3 === 0 ? fact(GateFacts.plan).eq('pro') : fact(GateFacts.authenticated).eq(true),
        ...(i % 5 === 0 ? { cost: { meter: Credits, amount: 1 } } : {}),
      }),
    );
    const facts = createManualFactSource('perf/facts');
    const meters = createMeterRegistry({ definitions: [Credits] });
    const gate = createGate({ policySets: [definePolicySet('perf/set', policies)], sources: [facts], meters });
    facts.setMany([
      [GateFacts.subjectKind, 'user'],
      [GateFacts.authenticated, true],
      [GateFacts.plan, 'free'],
    ]);
    let allowed = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const n = i % 520; // includes unmatched ids
      if (gate.decide(n % 2 === 0 ? 'feature' : 'ui-slot', `r${n}`).effect === 'allow') allowed += 1;
    }
    expect(allowed).toBeGreaterThan(0);
    facts.set(GateFacts.plan, 'pro');
    expect(gate.decide('ui-slot', 'r3')).toMatchObject({ effect: 'allow' });
    expect(gate.decide('feature', 'r0')).toMatchObject({ effect: 'deny', reason: 'quota' }); // costed, balance unknown → fail closed
  });
});

describe('gate: misc', () => {
  it('covers() and condition helpers build IR', () => {
    expect(covers(Credits, 3)).toEqual({ op: 'covers', meter: 'billing/credits', amount: 3 });
    expect(because(fact(GateFacts.plan).eq('pro'), 'upgrade', { plan: 'pro' })).toEqual({ op: 'eq', fact: 'billing/plan', value: 'pro', because: { reason: 'upgrade', meta: { plan: 'pro' } } });
  });
});
