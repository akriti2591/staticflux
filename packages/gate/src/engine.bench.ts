/**
 * BENCH (not a unit test): gate compile + hot-path cost on a large policy set.
 * Run on demand — timings are machine- and load-dependent, never asserted in CI:
 *
 *   pnpm vitest bench --run --reporter=verbose packages/gate/src/engine.bench.ts
 *
 * (Vitest 5 benchmarks: each `test` registers benchmarks on its `bench` fixture and runs them.)
 *
 * Workload: 500 policies (half `feature`, half `ui-slot`; every 5th costed), 10k `decide()` calls over 520 ids
 * (20 unmatched). Budgets, previously asserted in engine.test.ts: compile < 500 ms, 10k decisions < 250 ms
 * (locally ~5 ms), one-fact recompute < 250 ms. Correctness of the same workload stays in engine.test.ts.
 */
import { describe, test } from 'vitest';
import {
  GateFacts,
  createGate,
  createManualFactSource,
  createMeterRegistry,
  defineMeter,
  definePolicy,
  definePolicySet,
  fact,
  gateResource,
  type Gate,
  type ManualFactSource,
  type PolicySet,
} from './index.js';

const Credits = defineMeter('billing/credits', { unit: 'credits', lowThreshold: 10 });
const DECISIONS = 10_000;

const policySet: PolicySet = definePolicySet(
  'perf/set',
  Array.from({ length: 500 }, (_, i) =>
    definePolicy({
      id: `perf/p${i}`,
      resource: gateResource(i % 2 === 0 ? 'feature' : 'ui-slot', `r${i}`),
      when: i % 3 === 0 ? fact(GateFacts.plan).eq('pro') : fact(GateFacts.authenticated).eq(true),
      ...(i % 5 === 0 ? { cost: { meter: Credits, amount: 1 } } : {}),
    }),
  ),
);

function build(): { gate: Gate; facts: ManualFactSource } {
  const facts = createManualFactSource('perf/facts');
  const meters = createMeterRegistry({ definitions: [Credits] });
  const gate = createGate({ policySets: [policySet], sources: [facts], meters });
  facts.setMany([
    [GateFacts.subjectKind, 'user'],
    [GateFacts.authenticated, true],
    [GateFacts.plan, 'free'],
  ]);
  return { gate, facts };
}

function decideAll(gate: Gate): number {
  let allowed = 0;
  for (let i = 0; i < DECISIONS; i += 1) {
    const n = i % 520; // includes unmatched ids
    if (gate.decide(n % 2 === 0 ? 'feature' : 'ui-slot', `r${n}`).effect === 'allow') allowed += 1;
  }
  return allowed;
}

const ms = (start: number): string => `${(performance.now() - start).toFixed(1)} ms`;

// One cold pass printed with its budget, like the S4 bench; the `bench` runs below give the distribution.
{
  const compileStart = performance.now();
  const { gate, facts } = build();
  const compile = ms(compileStart);
  const decideStart = performance.now();
  const allowed = decideAll(gate);
  const decide = ms(decideStart);
  const recomputeStart = performance.now();
  facts.set(GateFacts.plan, 'pro');
  const recompute = ms(recomputeStart);
  console.log(`[bench] gate compile, 500 policies: ${compile} (budget 500 ms)`);
  console.log(`[bench] gate ${DECISIONS} decisions (${allowed} allowed): ${decide} (budget 250 ms, locally ~5 ms)`);
  console.log(`[bench] gate one-fact recompute: ${recompute} (budget 250 ms)`);
}

describe('compile (budget < 500 ms for 500 policies)', () => {
  test('compile', async ({ bench }) => {
    await bench('createGate over 500 policies + seed facts', () => {
      build();
    }).run({ iterations: 20, time: 0 });
  });
});

describe('decide hot path (budget < 250 ms for 10k decisions)', () => {
  const { gate } = build();
  test('decide', async ({ bench }) => {
    await bench(`${DECISIONS} decide() calls over 520 ids`, () => {
      decideAll(gate);
    }).run({ iterations: 50, time: 0 });
  });
});

describe('recompute (budget < 250 ms for one fact change)', () => {
  const { gate, facts } = build();
  let pro = false;
  test('recompute', async ({ bench }) => {
    await bench('flip plan fact and read one decision', () => {
      pro = !pro;
      facts.set(GateFacts.plan, pro ? 'pro' : 'free');
      gate.decide('ui-slot', 'r3');
    }).run({ iterations: 50, time: 0 });
  });
});
