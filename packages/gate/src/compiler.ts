/**
 * Policy compiler: policy IR → decision table (partial-evaluation style, after Cedar/OPA).
 *
 * Compile time resolves everything that does not depend on facts: layering
 * (defaults + remote overrides), subject/action/resource matching, wildcard
 * expansion, cost → `covers` conditions, and the fact → entry reverse index.
 * What remains per entry is a residual: the applicable policies' conditions over
 * facts. The engine evaluates residuals only when a fact they read changes, and
 * the hot path (`decide`) is a constant number of Map lookups.
 */
import { type Result, err, ok } from '@staticflux/core';
import { DuplicatePolicyError } from './errors.js';
import { type FactId, GateFacts } from './facts.js';
import {
  type ActionId,
  type Because,
  type Condition,
  DENY_PRECEDENCE,
  type DenyMeta,
  type DenyReason,
  type GateLevel,
  type MeterId,
  type PolicyIR,
  type PolicyId,
  type PolicyLayer,
  type PolicySet,
  type SubjectKind,
  meterFactId,
} from './policy.js';

export const WILDCARD = '*';
const SEP = '\u0000';

export function tableKey(level: GateLevel, resourceId: string, actionId: string): string {
  return `${level}${SEP}${resourceId}${SEP}${actionId}`;
}

export interface CompiledPolicy {
  readonly id: PolicyId;
  readonly ir: PolicyIR;
  readonly layer: PolicyLayer;
  readonly subjects: ReadonlySet<SubjectKind>;
  /** `when` ∧ `covers(cost)`. */
  readonly condition: Condition | undefined;
  readonly deps: readonly FactId[];
}

export interface TableEntry {
  readonly key: string;
  readonly level: GateLevel;
  readonly resourceId: string;
  readonly actionId: string;
  readonly policies: readonly CompiledPolicy[];
  readonly deps: ReadonlySet<FactId>;
}

export interface DecisionTable {
  readonly version: number;
  readonly entries: ReadonlyMap<string, TableEntry>;
  /** Reverse index: fact → entries whose residual reads it. */
  readonly byFact: ReadonlyMap<FactId, readonly TableEntry[]>;
  readonly policies: readonly CompiledPolicy[];
}

// ---------------------------------------------------------------- decisions

export interface FactReading {
  readonly fact: FactId;
  readonly value: unknown;
}

export interface DecisionTrace {
  readonly key: string;
  readonly level: GateLevel;
  readonly resourceId: string;
  readonly actionId: string;
  readonly subject: SubjectKind;
  /** Policies that determined the outcome (Cedar's "determining policies"). */
  readonly determining: readonly PolicyId[];
  /** Every applicable policy that was evaluated. */
  readonly evaluated: readonly PolicyId[];
  /** Fact values read while deciding. */
  readonly facts: readonly FactReading[];
  readonly source: 'policy' | 'unmatched';
  readonly tableVersion: number;
}

export interface AllowDecision {
  readonly effect: 'allow';
  /** Allow-with-cost (R6.18): reserve this amount on the meter before acting. */
  readonly cost: { readonly meter: MeterId; readonly amount: number } | undefined;
  /** Ask the user before an agent (or a flagged policy) performs this (R6.17). */
  readonly requiresConfirmation: boolean;
  readonly trace: DecisionTrace;
}

export interface DenyDecision {
  readonly effect: 'deny';
  readonly reason: DenyReason;
  readonly meta: DenyMeta;
  /** Every distinct reason from failing permits (e.g. upgrade *or* buy credits). */
  readonly alternatives: readonly Because[];
  readonly trace: DecisionTrace;
}

export type Decision = AllowDecision | DenyDecision;

// ---------------------------------------------------------------- compile

function conditionDeps(condition: Condition | undefined, into: Set<FactId>): void {
  if (condition === undefined) return;
  switch (condition.op) {
    case 'const':
      return;
    case 'covers':
      into.add(meterFactId(condition.meter));
      return;
    case 'all':
    case 'any':
      for (const child of condition.of) conditionDeps(child, into);
      return;
    case 'not':
      conditionDeps(condition.of, into);
      return;
    default:
      into.add(condition.fact);
  }
}

/** Merge layers: defaults, then remote overrides (same id replaces; `disabled` removes). */
export function mergePolicySets(sets: readonly PolicySet[]): Result<readonly { ir: PolicyIR; layer: PolicyLayer }[]> {
  const merged = new Map<PolicyId, { ir: PolicyIR; layer: PolicyLayer }>();
  for (const layer of ['default', 'remote'] as const) {
    const seen = new Set<PolicyId>();
    for (const set of sets) {
      if (set.layer !== layer) continue;
      for (const ir of set.policies) {
        if (seen.has(ir.id)) {
          return err(DuplicatePolicyError({ details: { policy: ir.id, layer, set: set.id }, message: `Duplicate policy id "${ir.id}" in layer ${layer}.` }));
        }
        seen.add(ir.id);
        if (ir.disabled === true) merged.delete(ir.id);
        else merged.set(ir.id, { ir, layer });
      }
    }
  }
  return ok([...merged.values()]);
}

export function compilePolicies(sets: readonly PolicySet[], version: number): Result<DecisionTable> {
  const merged = mergePolicySets(sets);
  if (!merged.ok) return merged;
  const policies: CompiledPolicy[] = merged.value.map(({ ir, layer }) => {
    const cost: Condition | undefined = ir.cost === undefined ? undefined : { op: 'covers', meter: ir.cost.meter, amount: ir.cost.amount };
    const condition: Condition | undefined =
      ir.when === undefined ? cost : cost === undefined ? ir.when : { op: 'all', of: [ir.when, cost] };
    const deps = new Set<FactId>();
    conditionDeps(condition, deps);
    return {
      id: ir.id,
      ir,
      layer,
      subjects: new Set<SubjectKind>(ir.subjects ?? ['user', 'guest']),
      condition,
      deps: [...deps],
    };
  });

  // Universe per level: concrete resource ids and mentioned actions.
  const levels = new Map<GateLevel, { ids: Set<string>; actions: Set<string> }>();
  for (const p of policies) {
    const bucket = levels.get(p.ir.resource.level) ?? { ids: new Set(), actions: new Set() };
    levels.set(p.ir.resource.level, bucket);
    for (const id of p.ir.resource.ids ?? []) bucket.ids.add(id);
    for (const a of p.ir.actions ?? []) bucket.actions.add(a);
  }

  const entries = new Map<string, TableEntry>();
  const byFact = new Map<FactId, TableEntry[]>();
  const matches = (p: CompiledPolicy, level: GateLevel, resourceId: string, actionId: string): boolean => {
    if (p.ir.resource.level !== level) return false;
    const ids = p.ir.resource.ids;
    if (resourceId === WILDCARD ? ids !== undefined : ids !== undefined && !ids.includes(resourceId)) return false;
    const actions = p.ir.actions;
    if (actionId === WILDCARD) return actions === undefined;
    return actions === undefined || actions.includes(actionId as ActionId);
  };
  const add = (level: GateLevel, resourceId: string, actionId: string): void => {
    const applicable = policies.filter((p) => matches(p, level, resourceId, actionId));
    if (applicable.length === 0) return;
    // The subject kind decides which policies apply, so every entry depends on it.
    const deps = new Set<FactId>([GateFacts.subjectKind.id]);
    for (const p of applicable) for (const d of p.deps) deps.add(d);
    const entry: TableEntry = { key: tableKey(level, resourceId, actionId), level, resourceId, actionId, policies: applicable, deps };
    entries.set(entry.key, entry);
    for (const d of deps) {
      const list = byFact.get(d) ?? [];
      list.push(entry);
      byFact.set(d, list);
    }
  };
  for (const [level, { ids, actions }] of levels) {
    for (const resourceId of [WILDCARD, ...ids]) {
      add(level, resourceId, WILDCARD);
      for (const actionId of actions) add(level, resourceId, actionId);
    }
  }
  return ok({ version, entries, byFact, policies });
}

/** Constant-time lookup with wildcard fallback: (id, action) → (id, any) → (any id, action) → (any, any). */
export function lookupEntry(table: DecisionTable, level: GateLevel, resourceId: string, actionId: string): TableEntry | undefined {
  const e = table.entries;
  return (
    e.get(tableKey(level, resourceId, actionId)) ??
    e.get(tableKey(level, resourceId, WILDCARD)) ??
    e.get(tableKey(level, WILDCARD, actionId)) ??
    e.get(tableKey(level, WILDCARD, WILDCARD))
  );
}

// ---------------------------------------------------------------- evaluate

export type FactReader = (id: FactId) => unknown;

interface ConditionResult {
  readonly pass: boolean;
  readonly because: Because | undefined;
}

const PASS: ConditionResult = { pass: true, because: undefined };

export interface EvaluateContext {
  readonly read: FactReader;
  readonly meterModes: ReadonlyMap<MeterId, 'balance' | 'rate'>;
  readonly tableVersion: number;
  /** Decision when no permit applies to a principal (user/guest). */
  readonly unmatched: 'allow' | 'deny';
}

export function evaluateCondition(condition: Condition, ctx: EvaluateContext, record: (fact: FactId, value: unknown) => void): ConditionResult {
  const read = (id: FactId): unknown => {
    const value = ctx.read(id);
    record(id, value);
    return value;
  };
  const fail = (fallback?: Because): ConditionResult => ({ pass: false, because: condition.because ?? fallback });
  switch (condition.op) {
    case 'const':
      return condition.value ? PASS : fail();
    case 'eq':
      return read(condition.fact) === condition.value ? PASS : fail();
    case 'neq': {
      const value = read(condition.fact);
      return value !== undefined && value !== condition.value ? PASS : fail();
    }
    case 'in':
      return condition.values.includes(read(condition.fact) as never) ? PASS : fail();
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const value = read(condition.fact);
      if (typeof value !== 'number') return fail();
      const passed =
        condition.op === 'gt' ? value > condition.value : condition.op === 'gte' ? value >= condition.value : condition.op === 'lt' ? value < condition.value : value <= condition.value;
      return passed ? PASS : fail();
    }
    case 'truthy':
      return read(condition.fact) ? PASS : fail();
    case 'has': {
      const value = read(condition.fact);
      return Array.isArray(value) && value.includes(condition.value) ? PASS : fail();
    }
    case 'covers': {
      const available = read(meterFactId(condition.meter));
      if (typeof available === 'number' && available >= condition.amount) return PASS;
      const mode = ctx.meterModes.get(condition.meter) ?? 'balance';
      return fail({
        reason: mode === 'rate' ? 'rate' : 'quota',
        meta: { meter: condition.meter, required: condition.amount, available: typeof available === 'number' ? available : null },
      });
    }
    case 'all': {
      for (const child of condition.of) {
        const r = evaluateCondition(child, ctx, record);
        if (!r.pass) return fail(r.because);
      }
      return PASS;
    }
    case 'any': {
      let first: Because | undefined;
      for (const child of condition.of) {
        const r = evaluateCondition(child, ctx, record);
        if (r.pass) return PASS;
        first ??= r.because;
      }
      return fail(first);
    }
    case 'not':
      return evaluateCondition(condition.of, ctx, record).pass ? fail() : PASS;
  }
}

function pickPrimary(failures: readonly Because[]): Because {
  let best: Because = { reason: 'forbidden' };
  let bestRank = Number.POSITIVE_INFINITY;
  for (const f of failures) {
    const rank = DENY_PRECEDENCE.indexOf(f.reason);
    if (rank < bestRank) {
      best = f;
      bestRank = rank;
    }
  }
  return best;
}

function uniqueBecauses(list: readonly Because[]): Because[] {
  const seen = new Set<string>();
  const out: Because[] = [];
  for (const b of list) {
    const k = JSON.stringify(b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

const EMPTY_META: DenyMeta = Object.freeze({});

/** Evaluate one entry for one subject kind. `entry` undefined = no policy targets the resource. */
export function evaluateFor(
  entry: TableEntry | undefined,
  where: { level: GateLevel; resourceId: string; actionId: string },
  subject: SubjectKind,
  ctx: EvaluateContext,
): Decision {
  const facts: FactReading[] = [];
  const seenFacts = new Set<FactId>();
  const record = (fact: FactId, value: unknown): void => {
    if (seenFacts.has(fact)) return;
    seenFacts.add(fact);
    facts.push({ fact, value });
  };
  const applicable = entry === undefined ? [] : entry.policies.filter((p) => p.subjects.has(subject));
  const trace = (determining: readonly PolicyId[], source: DecisionTrace['source']): DecisionTrace => ({
    key: entry?.key ?? tableKey(where.level, where.resourceId, where.actionId),
    level: where.level,
    resourceId: where.resourceId,
    actionId: where.actionId,
    subject,
    determining,
    evaluated: applicable.map((p) => p.id),
    facts,
    source,
    tableVersion: ctx.tableVersion,
  });

  for (const p of applicable) {
    if (p.ir.effect !== 'forbid') continue;
    const r = p.condition === undefined ? PASS : evaluateCondition(p.condition, ctx, record);
    if (r.pass) {
      const b = p.ir.deny ?? { reason: 'forbidden' as const };
      return { effect: 'deny', reason: b.reason, meta: b.meta ?? EMPTY_META, alternatives: [b], trace: trace([p.id], 'policy') };
    }
  }
  const permits = applicable.filter((p) => p.ir.effect === 'permit');
  if (permits.length === 0) {
    // Principals: ungated unless configured otherwise. Agents: only explicit delegation (R6.17).
    if (subject !== 'agent' && ctx.unmatched === 'allow') {
      return { effect: 'allow', cost: undefined, requiresConfirmation: false, trace: trace([], 'unmatched') };
    }
    const b: Because = { reason: subject === 'agent' ? 'forbidden' : 'unavailable', meta: subject === 'agent' ? { subject: 'agent' } : EMPTY_META };
    return { effect: 'deny', reason: b.reason, meta: b.meta ?? EMPTY_META, alternatives: [b], trace: trace([], 'unmatched') };
  }
  let best: CompiledPolicy | undefined;
  const failures: Because[] = [];
  for (const p of permits) {
    const r = p.condition === undefined ? PASS : evaluateCondition(p.condition, ctx, record);
    if (r.pass) {
      // Prefer free permits, then the cheapest cost.
      if (best === undefined || (best.ir.cost?.amount ?? 0) > (p.ir.cost?.amount ?? 0)) best = p;
    } else {
      failures.push(p.ir.deny ?? r.because ?? { reason: 'forbidden' });
    }
  }
  if (best !== undefined) {
    return {
      effect: 'allow',
      cost: best.ir.cost === undefined ? undefined : { meter: best.ir.cost.meter, amount: best.ir.cost.amount },
      requiresConfirmation: best.ir.requiresConfirmation === true,
      trace: trace([best.id], 'policy'),
    };
  }
  const primary = pickPrimary(failures);
  return {
    effect: 'deny',
    reason: primary.reason,
    meta: primary.meta ?? EMPTY_META,
    alternatives: uniqueBecauses(failures),
    trace: trace(
      permits.map((p) => p.id),
      'policy',
    ),
  };
}

/**
 * Agent decisions are the intersection of the delegating principal's decision and
 * the agent's own (explicitly delegated) policies — never wider than the user.
 */
export function evaluateAgent(
  entry: TableEntry | undefined,
  where: { level: GateLevel; resourceId: string; actionId: string },
  ctx: EvaluateContext,
): Decision {
  const principalKind = ctx.read(GateFacts.subjectKind.id) === 'user' ? 'user' : 'guest';
  const principal = evaluateFor(entry, where, principalKind, ctx);
  if (principal.effect === 'deny') return { ...principal, trace: { ...principal.trace, subject: 'agent' } };
  const agent = evaluateFor(entry, where, 'agent', ctx);
  if (agent.effect === 'deny') return agent;
  return {
    effect: 'allow',
    cost: agent.cost ?? principal.cost,
    requiresConfirmation: agent.requiresConfirmation || principal.requiresConfirmation,
    trace: {
      ...agent.trace,
      determining: [...principal.trace.determining, ...agent.trace.determining],
      facts: [...principal.trace.facts, ...agent.trace.facts.filter((f) => !principal.trace.facts.some((p) => p.fact === f.fact))],
    },
  };
}
