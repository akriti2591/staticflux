/**
 * The gate engine: facts in, reactive decisions out (R6.8–R6.11, R6.13, R6.17).
 *
 * Hot path: `decide(level, resourceId, action?)` is synchronous and O(1) — at most
 * four Map lookups into the compiled decision table plus one reactive read. When a
 * fact changes, only the entries whose residual reads that fact are re-evaluated
 * (reverse index), inside one reactive batch; unchanged decisions keep their
 * identity so nothing re-renders.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ CLIENT GATING IS UX, NOT SECURITY (R6.16). A decision here only decides   │
 * │ what to show, what to load and what to attempt. The server re-checks      │
 * │ every request; never treat `allow` as authorization.                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
import {
  type Box,
  type Result,
  type SfError,
  type Telemetry,
  batch,
  box,
  createNoopTelemetry,
  err,
  metric,
  ok,
} from '@staticflux/core';
import {
  type AllowDecision,
  type Decision,
  type DecisionTable,
  type EvaluateContext,
  type TableEntry,
  WILDCARD,
  compilePolicies,
  evaluateAgent,
  evaluateFor,
  lookupEntry,
  tableKey,
} from './compiler.js';
import { GateUnavailableError, GatedOutError, LoginRequiredError, QuotaExceededError, RateLimitedError } from './errors.js';
import { type FactDef, type FactId, type FactSink, type FactSource, type FactValue, GateFacts, factEquals } from './facts.js';
import type { MeterRegistry } from './meters.js';
import { AccessAction, type GateAction, type GateLevel, type GateResource, type MeterId, type PolicySet, validatePolicies } from './policy.js';

const SUBSYSTEM = 'gate/decisions' as const;

export const GateMetrics = {
  recomputes: /* @__PURE__ */ metric.counter('gate/recomputes', { description: 'Decision entries re-evaluated after fact changes.' }),
  changes: /* @__PURE__ */ metric.counter('gate/decision-changes'),
  compileDuration: /* @__PURE__ */ metric.histogram('gate/compile-duration', { unit: 'ms' }),
} as const;

export interface DecideOptions {
  /** `principal` = the current user/guest (default). `agent` = an AI agent acting for them (R6.17). */
  readonly subject?: 'principal' | 'agent';
}

export interface DecisionChange {
  readonly key: string;
  readonly subject: 'principal' | 'agent';
  readonly before: Decision | undefined;
  readonly after: Decision;
}

export interface GateSnapshot {
  readonly version: number;
  readonly unmatched: 'allow' | 'deny';
  readonly facts: readonly (readonly [FactId, unknown])[];
  readonly decisions: readonly (readonly [string, Decision])[];
}

export interface Gate {
  /**
   * Synchronous O(1) decision. Reactive: reading it inside an effect/derived tracks changes.
   * UX ONLY — `allow` is not authorization; the server re-checks (R6.16).
   */
  decide(level: GateLevel, resourceId: string, action?: GateAction, options?: DecideOptions): Decision;
  check(resource: GateResource, action?: GateAction, options?: DecideOptions): Decision;
  isAllowed(level: GateLevel, resourceId: string, action?: GateAction, options?: DecideOptions): boolean;
  /** Decision as a Result: deny → typed SF-GATE error (login → auth, quota, rate, unavailable, forbidden/upgrade). */
  require(level: GateLevel, resourceId: string, action?: GateAction, options?: DecideOptions): Result<AllowDecision>;
  /** Fresh, fully-attributed evaluation for devtools ("why?"). Not for the hot path. */
  explain(level: GateLevel, resourceId: string, action?: GateAction, options?: DecideOptions): Decision;
  /** Replace the remote override layer (untrusted JSON; validated all-or-nothing). */
  applyRemote(policies: unknown): Result<void>;
  /** Add a package-default policy set (e.g. when a feature module loads). */
  addPolicySet(set: PolicySet): Result<void>;
  addSource(source: FactSource): () => void;
  /** Current value of a fact (not reactive; decisions are). */
  fact<T extends FactValue>(definition: FactDef<T>): T | undefined;
  /** Bumped on every recompile. Reactive. */
  readonly version: number;
  readonly entryCount: number;
  /** Serializable table for replication to workers / devtools. */
  snapshot(): GateSnapshot;
  onDecisionChange(listener: (change: DecisionChange) => void): () => void;
  dispose(): void;
}

export interface GateOptions {
  readonly policySets?: readonly PolicySet[];
  readonly sources?: readonly FactSource[];
  readonly meters?: MeterRegistry;
  readonly telemetry?: Telemetry;
  /** Decision for principals when no policy targets a resource. Default `allow` (ungated). */
  readonly unmatched?: 'allow' | 'deny';
}

interface LiveEntry {
  readonly entry: TableEntry;
  readonly principal: Box<Decision>;
  agent: Box<Decision> | undefined;
  agentConfirm: Decision | undefined;
}

function sameDecision(a: Decision, b: Decision): boolean {
  if (a.effect !== b.effect) return false;
  if (a.trace.determining.join() !== b.trace.determining.join() || a.trace.tableVersion !== b.trace.tableVersion) return false;
  if (a.effect === 'allow' && b.effect === 'allow') {
    return a.requiresConfirmation === b.requiresConfirmation && a.cost?.meter === b.cost?.meter && a.cost?.amount === b.cost?.amount;
  }
  if (a.effect === 'deny' && b.effect === 'deny') {
    return a.reason === b.reason && JSON.stringify(a.meta) === JSON.stringify(b.meta) && JSON.stringify(a.alternatives) === JSON.stringify(b.alternatives);
  }
  return false;
}

/** Map a deny decision to the typed error the router/loader/messaging act on. */
export function denialError(decision: Decision & { effect: 'deny' }): SfError {
  const details = { reason: decision.reason, meta: decision.meta, key: decision.trace.key, policies: decision.trace.determining };
  switch (decision.reason) {
    case 'login':
      return LoginRequiredError({ details });
    case 'quota':
      return QuotaExceededError({ details });
    case 'rate':
      return RateLimitedError({ details });
    case 'unavailable':
      return GateUnavailableError({ details });
    default:
      return GatedOutError({ details });
  }
}

export function createGate(options: GateOptions = {}): Gate {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const unmatched = options.unmatched ?? 'allow';
  const defaults: PolicySet[] = [...(options.policySets ?? [])];
  let remote: PolicySet = { id: 'gate/remote-overrides', layer: 'remote', policies: [] };
  const facts = new Map<FactId, unknown>([[GateFacts.subjectKind.id, 'guest']]);
  const meterModes: ReadonlyMap<MeterId, 'balance' | 'rate'> = options.meters?.modes ?? new Map();
  const versionBox = box(0);
  const listeners = new Set<(change: DecisionChange) => void>();
  const disconnects: (() => void)[] = [];
  let table: DecisionTable = { version: 0, entries: new Map(), byFact: new Map(), policies: [] };
  let live = new Map<string, LiveEntry>();
  let pending = new Set<FactId>();
  let batching = 0;
  let disposed = false;

  const ctx = (): EvaluateContext => ({ read: (id) => facts.get(id), meterModes, tableVersion: table.version, unmatched });
  const where = (entry: TableEntry): { level: GateLevel; resourceId: string; actionId: string } => ({
    level: entry.level,
    resourceId: entry.resourceId,
    actionId: entry.actionId,
  });

  // Shared decisions for resources no policy targets (no allocation on the hot path).
  const unmatchedCache = new Map<string, Decision>();
  const unmatchedDecision = (level: GateLevel, subject: 'principal' | 'agent'): Decision => {
    const key = `${level}:${subject}:${table.version}`;
    let decision = unmatchedCache.get(key);
    if (decision === undefined) {
      const w = { level, resourceId: WILDCARD, actionId: WILDCARD };
      decision = subject === 'agent' ? evaluateAgent(undefined, w, ctx()) : evaluateFor(undefined, w, 'user', ctx());
      unmatchedCache.set(key, decision);
    }
    return decision;
  };

  const notify = (change: DecisionChange): void => {
    telemetry.record(GateMetrics.changes, 1, { level: change.after.trace.level });
    telemetry.event('gate.decision-changed', {
      subsystem: SUBSYSTEM,
      level: 'verbose',
      attrs: {
        key: change.key.replaceAll('\u0000', ':'),
        subject: change.subject,
        effect: change.after.effect,
        reason: change.after.effect === 'deny' ? change.after.reason : null,
        policies: [...change.after.trace.determining],
      },
    });
    for (const listener of [...listeners]) listener(change);
  };

  const recompute = (item: LiveEntry): void => {
    const principalKind = facts.get(GateFacts.subjectKind.id) === 'user' ? 'user' : 'guest';
    const before = item.principal.get();
    const after = evaluateFor(item.entry, where(item.entry), principalKind, ctx());
    if (!sameDecision(before, after)) {
      item.principal.set(after);
      notify({ key: item.entry.key, subject: 'principal', before, after });
    }
    if (item.agent !== undefined) {
      const agentBefore = item.agent.get();
      const agentAfter = evaluateAgent(item.entry, where(item.entry), ctx());
      if (!sameDecision(agentBefore, agentAfter)) {
        item.agent.set(agentAfter);
        item.agentConfirm = undefined;
        notify({ key: item.entry.key, subject: 'agent', before: agentBefore, after: agentAfter });
      }
    }
  };

  const flush = (): void => {
    if (pending.size === 0) return;
    const changed = pending;
    pending = new Set();
    const affected = new Set<LiveEntry>();
    for (const id of changed) {
      for (const entry of table.byFact.get(id) ?? []) {
        const item = live.get(entry.key);
        if (item !== undefined) affected.add(item);
      }
    }
    if (affected.size === 0) return;
    telemetry.record(GateMetrics.recomputes, affected.size);
    batch(() => {
      for (const item of affected) recompute(item);
    });
  };

  const sink: FactSink = {
    set(definition, value) {
      if (disposed) return;
      if (factEquals(facts.get(definition.id), value)) return;
      if (value === undefined) facts.delete(definition.id);
      else facts.set(definition.id, value);
      if (definition.id === GateFacts.subjectKind.id && value === undefined) facts.set(definition.id, 'guest');
      pending.add(definition.id);
      if (batching === 0) flush();
    },
    batch(fn) {
      batching += 1;
      try {
        fn();
      } finally {
        batching -= 1;
        if (batching === 0) flush();
      }
    },
  };

  const recompile = (): Result<void> => {
    const span = telemetry.span('gate.compile', { subsystem: SUBSYSTEM, level: 'standard' });
    const started = telemetry.now();
    const compiled = compilePolicies([...defaults, remote], table.version + 1);
    if (!compiled.ok) {
      span.end('error', compiled.error);
      return compiled;
    }
    const next = new Map<string, LiveEntry>();
    batch(() => {
      table = compiled.value;
      const principalKind = facts.get(GateFacts.subjectKind.id) === 'user' ? 'user' : 'guest';
      for (const entry of table.entries.values()) {
        const decision = evaluateFor(entry, where(entry), principalKind, ctx());
        const previous = live.get(entry.key);
        if (previous === undefined) {
          next.set(entry.key, { entry, principal: box(decision), agent: undefined, agentConfirm: undefined });
          continue;
        }
        previous.principal.set(decision);
        const item: LiveEntry = { entry, principal: previous.principal, agent: previous.agent, agentConfirm: undefined };
        if (item.agent !== undefined) item.agent.set(evaluateAgent(entry, where(entry), ctx()));
        next.set(entry.key, item);
      }
      live = next;
      unmatchedCache.clear();
      versionBox.set(table.version);
    });
    span.set('entries', table.entries.size);
    span.set('policies', table.policies.length);
    span.end('ok');
    telemetry.record(GateMetrics.compileDuration, telemetry.now() - started);
    return ok();
  };

  const decide = (level: GateLevel, resourceId: string, action: GateAction = AccessAction, decideOptions: DecideOptions = {}): Decision => {
    versionBox.get(); // track table swaps (recompile) reactively
    const subject = decideOptions.subject ?? 'principal';
    const entry = lookupEntry(table, level, resourceId, action.id);
    if (entry === undefined) return unmatchedDecision(level, subject);
    const item = live.get(entry.key) as LiveEntry;
    if (subject === 'principal') return item.principal.get();
    item.agent ??= box(evaluateAgent(entry, where(entry), ctx()));
    const decision = item.agent.get();
    // Destructive agent actions always need user confirmation (R6.17).
    if (decision.effect === 'allow' && action.destructive && !decision.requiresConfirmation) {
      item.agentConfirm ??= { ...decision, requiresConfirmation: true };
      return item.agentConfirm;
    }
    return decision;
  };

  const initial = recompile();
  if (!initial.ok) throw initial.error;

  const gate: Gate = {
    decide,
    check: (resource, action, decideOptions) => decide(resource.level, resource.id, action, decideOptions),
    isAllowed: (level, resourceId, action, decideOptions) => decide(level, resourceId, action, decideOptions).effect === 'allow',
    require(level, resourceId, action, decideOptions) {
      const decision = decide(level, resourceId, action, decideOptions);
      return decision.effect === 'allow' ? ok(decision) : err(denialError(decision));
    },
    explain(level, resourceId, action = AccessAction, decideOptions = {}) {
      const entry = lookupEntry(table, level, resourceId, action.id);
      const w = { level, resourceId, actionId: action.id };
      if (decideOptions.subject === 'agent') {
        const decision = evaluateAgent(entry, w, ctx());
        return decision.effect === 'allow' && action.destructive ? { ...decision, requiresConfirmation: true } : decision;
      }
      const principalKind = facts.get(GateFacts.subjectKind.id) === 'user' ? 'user' : 'guest';
      return evaluateFor(entry, w, principalKind, ctx());
    },
    applyRemote(policies) {
      const validated = validatePolicies(policies);
      if (!validated.ok) return validated;
      const previous = remote;
      remote = { id: 'gate/remote-overrides', layer: 'remote', policies: validated.value };
      const result = recompile();
      if (!result.ok) remote = previous;
      return result;
    },
    addPolicySet(set) {
      defaults.push(set);
      const result = recompile();
      if (!result.ok) defaults.pop();
      return result;
    },
    addSource(source) {
      const disconnect = source.connect(sink);
      disconnects.push(disconnect);
      return disconnect;
    },
    fact(definition) {
      return facts.get(definition.id) as never;
    },
    get version() {
      return versionBox.get();
    },
    get entryCount() {
      return table.entries.size;
    },
    snapshot() {
      return {
        version: table.version,
        unmatched,
        facts: [...facts.entries()],
        decisions: [...live.values()].map((item) => [item.entry.key, item.principal.get()] as const),
      };
    },
    onDecisionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const disconnect of disconnects) disconnect();
      listeners.clear();
    },
  };

  if (options.meters !== undefined) gate.addSource(options.meters);
  for (const source of options.sources ?? []) gate.addSource(source);
  return gate;
}

/** Key helper for devtools/tests: the table key of a resource/action. */
export function decisionKey(level: GateLevel, resourceId: string, action: GateAction = AccessAction): string {
  return tableKey(level, resourceId, action.id);
}
