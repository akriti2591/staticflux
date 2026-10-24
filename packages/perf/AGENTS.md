# @staticflux/perf — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`).
**Budget:** journey tracker + feature marks + conformance ≈ 8 KB gzip measured on unminified tsc output; detectors
≈ 4.3 KB more (dev-only parts like forced-layout instrumentation tree-shake out). Not on the boot critical path:
register after core-ready (telemetry buffers records until the tracker attaches). No size-limit entry yet.

## Purpose
StaticFlux's own performance model (R17.16): journey traces assembled from telemetry spans, framework-measured
feature marks labelled with their method, runtime detectors (long frames, forced layout, layout shift per feature,
render counts, input latency, memory), runtime budgets, and the conformance stream of typed violations.
Implements R17.5–R17.12, R17.19–R17.20, R17.22, R12.6, R12.15, R12.19–R12.20; verbosity via core levels (R17.13–R17.14).

## Public API (by file)
- `journey.ts` — `createJourneyTracker({ telemetry, phaseRule, completion, bootSpan, navigationSpan })` (a `TelemetrySink`):
  `begin({ start, route, at })`, `end(outcome)`, `current`, `history`, `onJourney`; `JourneySummary` (phases with total +
  `criticalPath`, marks, classification `{ start, activation, code, data }`), `criticalPath`, `defaultPhaseRule`,
  `journeyMachine` (`open → complete|superseded|abandoned|ended`), `JOURNEY_PHASES`.
- `marks.ts` — `createFeatureMarks({ env, telemetry, layoutStableMs })`: `declare(feature, readiness)`, `start`,
  `placeholderCommitted`, `renderCommitted(feature, element?)`, `renderDepsResolved`, `track(feature, promise)`,
  `layoutShift`, `signal(feature, mark)`, `marks`. Mark keys are camelCase (`placeholderShown | firstRender |
  largestRender | interactive | complete`, readiness `{ firstRender, interactive, complete }` = runtime manifests);
  kebab-case names (`'first-render'`) are deprecated aliases for one release (`normalizeFeatureMark`). Methods: `commit+frame | element-timing | largest-heuristic |
  framework-default | readiness-signal`.
- `detectors.ts` — `createLongFrameDetector` (LoAF → longtask → none; `attribute(url)` → chunk → feature),
  `createForcedLayoutDetector` (`write`, `read` measured-read API, `instrument(proto, scope)` dev patching),
  `createLayoutShiftTracker` (per `[data-sf-feature]` subtree, `checkPlaceholder` size-stable check, `report` fallback),
  `createRenderCounter` (`count(component, feature)`, render-storm detection), `createInputLatencyTracker` (Event Timing
  or rAF fallback), `createMemorySampler`, `featureOfNode`, `FEATURE_ATTRIBUTE`.
- `conformance.ts` — `reportViolation(telemetry, v)`, `violationOf(errorDef, init)`, `createConformance({ telemetry,
  sampleRate })`, `createViolationCollector()` (sink: `violations`, `baseline()`, `compare`, `check` → `SF-PERF-006`),
  `parseBaseline`, `violationKey`, `VIOLATION_EVENT`.
- `budgets.ts` — `defineMarkBudget({ feature | '*', mark, maxMs, tiers, starts, reason })`, `DEFAULT_MARK_BUDGETS` (R12.7),
  `applicableBudget`, `createBudgetEvaluator({ budgets, tier, conformance })` (`evaluate(summary)`, `attach(tracker)`).
- `env.ts` — `PerfEnv` port (`now`, `raf`, `timer`, `observer`, `supportedEntryTypes`), `browserPerfEnv`, `supports`.
- `tokens.ts` / `units.ts` — `perfUnits` (one-line opt-in), `markBudgetUnit`; ports `PerfEnvToken`,
  `ScriptAttributionToken`, `PerfDeviceTierToken`, `MarkBudgetsToken` (multi); services `JourneyTrackerToken`,
  `FeatureMarksToken`, `ConformanceToken`, `ViolationCollectorToken`, `LongFrameDetectorToken`, `ForcedLayoutDetectorToken`,
  `LayoutShiftTrackerToken`, `RenderCounterToken`, `InputLatencyTrackerToken`, `MemorySamplerToken`, `BudgetEvaluatorToken`.
- `telemetry.ts` — `PERF_SUBSYSTEMS` (`perf/journey|marks|frames|layout|render|input|memory|conformance|budgets`),
  `FEATURE_MARKS`, `normalizeFeatureMark`, `featureMarkMetrics` (keyed by camelCase mark; metric ids stay
  `feature/<kebab-mark>`, events `feature.<kebab-mark>`), `perfMetrics`. `errors.ts` — `SF-PERF-001…008`.

## Span/attribute conventions the tracker consumes
`app.boot` starts a cold journey (`attrs.warm: true` → warm); `nav.pipeline` (`attrs.route`, optional `attrs.inputAt`)
starts a soft journey or joins the boot journey; `boot.*`, `nav.*`/`stage.*`, `feature.*`, `view.*` map to phases, other
spans inherit their parent's phase. Classification reads `feature.activate.attrs.activation`, `chunk.load.attrs.codeSource`
(loader) and `attrs.dataSource` on data spans. Mark metrics carry `{ feature, method, at }`; the journey stores them as
ms since journey start. Other packages report violations by emitting a `violation` event with
`{ code, fix, feature?, unit?, message?, severity?, details? }` — no perf dependency needed.

## Rules
- Only `@staticflux/core` imports. All browser APIs through `PerfEnv`; feature-detect entry types (Safari has no LoAF,
  layout-shift, element or event timing — detectors degrade to `none`/fallbacks).
- No new verbosity system: detectors check `telemetry.enabled(subsystem, level)`; per-render metrics only at `verbose`.
- Marks are framework-measured and never conflated with browser LCP/Web Vitals (R17.10, R17.16).
- Every violation code via `defineError('SF-PERF-NNN', …)` with a concrete `fix`.

## Test
`npx vitest run packages/perf` · `npx tsc -p packages/perf --noEmit`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/perf (full; not on boot path) | 9.5 KB | packages/perf/dist/index.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
