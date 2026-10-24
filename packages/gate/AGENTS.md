# @staticflux/gate — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`). Must not import `@staticflux/auth` — session facts arrive through a `FactSource` (`sessionFactSource(() => …)`).
**Budget (proposed):** ≤ 4.5 KB brotli for the boot surface (`createGate` + compiler + facts + `gateUnits`); meters ≤ 2 KB on top.

> ## ⚠ CLIENT GATING IS UX, NOT SECURITY (R6.16)
> Every decision here is advisory. It decides what to render, which chunks to load
> (I-8: denied chunks are never fetched) and which calls to attempt. **The server
> re-checks every request.** Never treat `allow` as authorization, never skip a
> server check because the client gate allowed it, and never ship secrets or data
> the user may not see on the assumption that the gate hides them.

## Purpose
Facts → declarative policies → compiled decision tables → synchronous, reactive,
explainable decisions (R6.8–R6.18, docs/LIFECYCLES.md §11). Cedar-like semantics:
permit/forbid, forbid overrides, determining policies as the explanation.

## Public API (by file)
- `facts.ts` — `defineFact(id).type<T>()`, `FactSource`/`FactSink` ports, `GateFacts` (subjectKind, authenticated, userId, roles, plan, entitlements, cohorts, platform, formFactor, region, host), `flagFact(id)`, `createManualFactSource`, `reactiveFactSource`, `sessionFactSource`, `createEntitlementSource` (offline grace R6.15, revocation R6.14), `GateClock`.
- `policy.ts` — IR (`PolicyIR`, `Condition`, JSON-serializable), levels `app | workspace | route | feature | capability | ui-slot`, subjects `user | agent | guest`, deny reasons `login | upgrade | forbidden | unavailable | quota | rate`; builders `definePolicy`, `definePolicySet`, `defineAction({ destructive })`, `gateResource`, `fact(def).eq/neq/in/gt/gte/lt/lte/truthy/has`, `all/any/not/always/never`, `covers(meter, n)`, `because(cond, reason, meta)`; `validatePolicies` (untrusted remote JSON).
- `compiler.ts` — `compilePolicies(sets, version)` → `DecisionTable` (entries + fact→entry reverse index), `lookupEntry` (≤ 4 Map lookups), `evaluateFor`, `evaluateAgent`, `Decision` / `AllowDecision` (cost, requiresConfirmation) / `DenyDecision` (reason, meta, alternatives) / `DecisionTrace`.
- `engine.ts` — `createGate({ policySets, sources, meters, unmatched })` → `decide(level, id, action?, { subject })`, `check`, `isAllowed`, `require` (→ typed SF-GATE error), `explain` (fresh trace for devtools), `applyRemote(json)`, `addPolicySet`, `addSource`, `fact`, `version`, `snapshot()` (worker replication), `onDecisionChange`. `denialError`, `decisionKey`, `GateMetrics`.
- `meters.ts` — `defineMeter(id, { unit, mode: balance|rate, window, limit, lowThreshold, reservationTtlMs })`, `createMeterRegistry` (is a FactSource: `meter:<id>` = optimistic available), `Meter.setServerState/reserve/status/onStatusChange`, `Reservation.commit(actual)/release()`, `reservationMachine`, `MeterBackend` port, `localMeterBackend`.
- `units.ts` — tokens `GateToken`, `MeterRegistryToken`, `MeterBackendToken`, `GateClockToken`, multi `PolicySetsToken`, `FactSourcesToken`, `MeterDefinitionsToken`; `gateUnits` (one-line opt-in), `createGateUnit`, `meterRegistryUnit`, `localMeterBackendUnit`, `systemGateClockUnit`, helpers `policySetUnit`, `factSourceUnit`, `meterDefinitionUnit`.
- `errors.ts` — `SF-GATE-001` gated out (I-8) … `SF-GATE-021`.

## Semantics (read before writing policies)
- A resource with no applicable policy is **ungated** (`unmatched: 'allow'`, default) — set `unmatched: 'deny'` to fail closed.
- Permits are OR-ed; any matching forbid wins. Use `forbid` to narrow, not a stricter permit.
- Missing facts fail closed (`neq`, comparisons, `covers` with unknown balance all fail).
- Deny reason: policy `deny` > failing condition's `because` > `forbidden`. Several failing permits: primary by `unavailable > login > upgrade > quota > rate > forbidden`; all in `alternatives` (upsell can offer "upgrade" and "buy credits").
- Agents (R6.17): decision = principal decision ∧ agent policies; agents only get what policies list for `subjects: ['agent']`. Destructive actions (or `requiresConfirmation`) → `requiresConfirmation: true`.
- `cost` makes a permit allow-with-cost and implies `covers(meter, amount)`; free permits win over costed ones. Callers `reserve → commit | release` around the action.
- `decide()`'s trace describes the table entry (wildcard entries show `*`); use `explain()` for a fully attributed answer.
- Remote overrides replace defaults by id, add new ids, or `{ id, disabled: true }`; invalid JSON is rejected as a whole.

## Rules
- `decide()` is the hot path: synchronous, O(1) (≤ 4 Map lookups + one reactive read), no decision allocation, no telemetry per call. Do not add work there.
- Policies are data. No functions in the IR; feature code never branches on facts directly — it asks the gate.
- Fact sources are plugins; gate never imports the owner of a fact (auth, config, platform, billing).
- Every lifecycle (reservation) is a `defineMachine` table mirrored in docs/LIFECYCLES.md §11 (`estimating → released` on cancel is a documented extension).
- The meter server balance is authoritative; the client view is optimistic and is corrected by `setServerState`.

## Test
`npx vitest run packages/gate` · `npx tsc -p packages/gate --noEmit` (includes a 10k-decision performance sanity test)
