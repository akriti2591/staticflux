# @staticflux/devtools — AGENTS.md

**Layer:** shell (depends on `@staticflux/core`, `@staticflux/perf`, `@staticflux/gate`, `@staticflux/runtime`, `lit` 3.3.3;
`@staticflux/ui` is an allowed dep but not used — the panel is a plain LitElement fed by a handle, not DI-injected).
**Budget:** dev-only; never in the boot path. Collector + views + controls ≈ 18 KB gzip of tsc output (unminified); the panel
(`./panel`, its own chunk, loaded on first open) ≈ 8.7 KB gzip + Lit. Production builds exclude the package entirely.

## Purpose
Devtools built on the telemetry fabric (R17.3): a bounded telemetry sink plus inspectors that turn records and live
sources into view models — boot waterfall with critical path and per-unit DI timings (R2.4), navigation journeys
(R17.5), DI graph, lifecycle states, gate decision traces + on-demand `explain()` (R6.11), store inspector,
conformance violations grouped by code with fixes (R17.22), metric values — and controls: runtime verbosity per
subsystem and the session-scoped `?sf-debug=` flag (R17.14), app commands through `supervisor.request()` (R4.5).

## Public API (by file)
- `collector.ts` — `createDevtoolsCollector({ capacity })` (a `TelemetrySink`): `spans`, `openSpans`, `events`,
  `bootTrace` (separate ring rooted at `app.boot`, else a bare `di.critical`), `lifecycles` (from
  `lifecycle.<machine>.<from>→<to>` + `…invalid` events; instance from attrs `subsystem|feature|worker|surface|…`),
  `decisions` (`gate.decision-changed`), `recordDecision`, `preferGateDecisions`, `violations` (grouped by code),
  `violationCount`, `metrics` (latest/count/sum/min/max per series), `subsystems`, `onChange`, `clear`.
  `DEFAULT_CAPACITY`, parsers `parseLifecycleEvent`, `parseInvalidEvent`, `instanceOf`, `splitDecisionKey`.
- `views.ts` — pure builders: `buildBootWaterfall(trace, now)`, `buildJourneysFromTracker(tracker, now)`,
  `buildJourneysFromSpans(spans)` (fallback: `nav.pipeline|view|dialog` with `nav.stage` phases), `buildDiGraph(
  inspect(), units?)` (layered by required depth via `@staticflux/core/graph` `analyzeGraph`; by scope without units),
  `buildLifecycles(entries, { app, subsystems, features })`, `buildDecisions(records, filter)`, `buildViolations(groups)`
  (missing fix → error catalog), `buildMetrics(series, declared)`, `declaredMetricsOf(units)`, `previewJson`.
- `levels.ts` — `parseDebugFlag` (`core/di:verbose,router/*:debug`; bare level = `*`; empty/`1`/`true` = `*:debug`;
  any invalid entry → `SF-DEV-001`), `formatDebugFlag`, `readDebugFlag(url)`, `effectiveLevel` (probes
  `telemetry.enabled`), `createVerbosityControl({ telemetry, session })` (`setLevel`, `apply`, `applyFlag`,
  `overrides`, `levelOf`, `reset`, `persistSession`, `onChange`), `readSessionFlag`, `DEBUG_FLAG_PARAM`, `DEBUG_SESSION_KEY`.
- `devtools.ts` — `createDevtools({ telemetry, injector, supervisor, featureHost, gate, journeys, stores, units, metrics,
  capacity, session, now, schedule })` → `Devtools`: `views.{boot,journeys,graph,lifecycles,decisions,stores,violations,
  metrics,settings}()`, `bind`, `bindFromInjector` (binds only units already `ready`; never instantiates),
  `explain(level, resource, action?, subject?)`, `command('pause'|'resume'|'refresh')`, `canCommand`, `setLevel`,
  `subscribe` (coalesced), `dispose`. `InspectableStore` port (data owner/replica stores fit structurally).
- `install.ts` — `installDevtools({ injector | telemetry, url, persistDebug, shortcut, keyTarget, container, loadPanel,
  open, …sources })` → `Result<DevtoolsInstallation>` (`open(tab?)`, `close`, `toggle`, `isOpen`, `debugEntries`,
  `dispose`); `defaultShortcut` (Ctrl/Cmd+Shift+D, scope-bound keydown listener).
- `panel.ts` (subpath **`@staticflux/devtools/panel`**) — `<sf-devtools>` (`SfDevtoolsElement`: `.devtools`, `open`,
  `tab`, `theme=auto|light|dark`), `definePanel(registry?)`, `PANEL_TAG`, `CLOSE_EVENT`, `formatMs`.
- `tabs.ts` — `DEVTOOLS_TABS`, `TAB_LABELS`, `isDevtoolsTab`. `ring.ts` — `createRingBuffer`, `createBoundedMap`.
- `units.ts` — `devtoolsUnits` (one-line opt-in), `devtoolsUnitWith(options)`, `devtoolsHandleUnit`, `inspectStore(token)`;
  tokens `DevtoolsInstallationToken`, `DevtoolsToken`, `DevtoolsStoresToken` (multi).
- `errors.ts` — `SF-DEV-001` invalid debug flag, `SF-DEV-002` source not bound, `SF-DEV-003` panel load failed,
  `SF-DEV-004` no DOM.

## Opt-in (dev only)
```ts
if (import.meta.env.DEV) {
  const { installDevtools } = await import('@staticflux/devtools');
  installDevtools({ injector: app.injector, units: appUnits });   // or register ...devtoolsUnits
}
```
Install right after boot is fine: telemetry buffers records until the first sink attaches (default 1000).
Boot waterfall needs `runtime/app` ≥ critical and `core/di` ≥ standard (verbose for non-critical units);
lifecycle and decision events are `verbose` — raise levels in the Settings tab or with `?sf-debug=`.

## Rules
- Devtools observe; they never change app behaviour except through explicit controls (levels, supervisor requests).
  Never resolve app tokens that are not already `ready`.
- Memory is bounded: every store is a ring buffer / bounded map (`CollectorCapacity`). No unbounded arrays.
- The panel renders only while open; it reads view models from the handle and never touches telemetry directly.
- No `@staticflux/a11y` dependency: shortcut via `scope.listen`, tabs follow the WAI-ARIA tabs pattern by hand.
- Gate explanations are UX diagnostics, not authorization (R6.16).

## Test
`npx vitest run packages/devtools` · `npx tsc -p packages/devtools --noEmit`
