# @staticflux/runtime — AGENTS.md

**Layer:** runtime (depends on `@staticflux/core`; `@staticflux/storage` only for the archive adapter/unit, R9.0d).
**Budget:** boot surface (`createSupervisor`, `bootApp`, `createFrameScheduler`, tokens) ≈ 12 KB gzip measured
(tsc output, unminified); feature host + resource manager ≈ 8.5 KB gzip more, loadable after core-ready.
Counts toward the 45 KB "framework runtime at boot" budget (R12.7). No size-limit entry yet.

## Purpose
App supervisor and app lifecycle, supervised subsystems with restart policies, feature host
and feature lifecycle, resource manager (demotion/retention/budgets), frame scheduler.
Implements REQUIREMENTS §4, §5, R12.1, R12.13–R12.18; LIFECYCLES §1, §2, §6; invariants I-1, I-5, I-6.

## Public API (by file)
- `machines.ts` — `appMachine`, `subsystemMachine`, `featureMachine` (tables mirror docs/LIFECYCLES.md),
  `ALLOWED_COMMANDS`, `AppState`, `AppCommand`, `SubsystemState`, `FeatureState`, `LOGIC_ALIVE_STATES`, `UI_MOUNTED_STATES`.
- `subsystem.ts` — `Subsystem` contract (`id`, `dependsOn`, `critical`, `restart`, `start/pause/resume/refresh/abort/stop`,
  `onDependencyState`), `RestartPolicy` (backoff + `maxRestarts` per `windowMs`), `defineSubsystem`.
- `supervisor.ts` — `createSupervisor({ telemetry, injector, subsystems, core, commandPolicy, pausedRequestPolicy, … })`:
  `start`, `settled`, `register`, `inspect`, `impaired`, commands `pause/resume/abort/refresh/reinitialize/shutdown`,
  `command`, `can`, `request` (feature-requested commands, R4.5), `assertRunnable` (I-1), `whenRunnable` (paused-request
  policy for transports, R4.6), `signal` (root abort signal), `epoch`, `usePolicies`.
- `policy.ts` — `CommandPolicy`, `defaultCommandPolicy`, `PausedRequestPolicy`, `defaultPausedRequestPolicy`.
- `boot.ts` — `bootApp({ units, telemetry, subsystems })` → `Result<App>`: injector → supervisor → `resolveCritical`
  → core-ready → running; spans `app.boot` / `boot.core` / `boot.critical` (subsystem `runtime/app`).
- `feature.ts` — `defineFeature({ id, weight, retention, modes, units, requires: { features }, budget, readiness, headless, load })`,
  `defineFeatureModule({ units, activate, deactivate, mount, visible, hide, unmount, snapshot, restore })`, `featureRef`.
- `feature-host.ts` — `createFeatureHost({ injector, archive, gate, load })`: `register`, `load`, `activate`, `mount`,
  `hide`, `show`, `unmount`, `deactivate`, `archive`, `evict`, `handle` (reactive), `info`, `list`, `refCount`,
  `touch`, `mark` (readiness marks), `onTransition`, `onSettled`, `dispose`.
- `archive.ts` — `ArchiveStore` port, `SnapshotEnvelope` (`sf-snapshot/1`, shared with handoff), `createMemoryArchiveStore`,
  `archiveStoreFromStore(asyncStore)` (R9.0d: any `@staticflux/storage` `AsyncStore`, e.g. IndexedDB/OPFS; snapshots keyed by feature id;
  backend errors and non-`sf-snapshot/1` entries → `SF-FT-009` with `details.code`, bad entries deleted).
- `resource-manager.ts` — `createResourceManager({ host, budgets, pressureBudgets, pressure, rank })`, `MemoryPressure`,
  `ResourceBudgets`, `DEFAULT_BUDGETS`, `DEFAULT_PRESSURE_BUDGETS`.
- `scheduler.ts` — `createFrameScheduler(env)`: `schedule` (coalesced update jobs), `measure`, `mutate`, `postTask`
  (priorities `interaction | critical | visible | idle`), `yieldToMain`, `idleUntilUrgent`, `flush`, `pause/resume`;
  free `yieldToMain()`, `defaultMacrotask`, `defaultIdle`.
- `tokens.ts` — `SupervisorToken`, `AppInjectorToken` (both provided by `bootApp`), `FrameSchedulerToken`,
  `FeatureHostToken`, `ResourceManagerToken`, `ArchiveStoreToken`, `MemoryPressureToken`, `CommandPolicyToken`,
  `PausedRequestPolicyToken`, `FeatureManifestsToken` (multi), `SubsystemsToken` (multi), `BOOT_PROVIDED_TOKENS`.
- `units.ts` — `runtimeUnits` (all defaults), `frameSchedulerUnit`, `frameSchedulerSubsystemUnit`, `memoryArchiveStoreUnit`, `registryArchiveStoreUnit` (storage registry, device scope, namespace `runtime/archive`),
  `nominalMemoryPressureUnit`, `featureHostUnit`, `resourceManagerUnit`, `resourceManagerUnitWith(budgets)`, `frameSchedulerSubsystem`.
- `errors.ts` — `SF-APP-001…007`, `SF-FT-001…009`, `SF-SCHED-001`.
- `telemetry.ts` — `RUNTIME_SUBSYSTEMS` (`runtime/app|feature|resources|scheduler`), `runtimeMetrics`, `traceMachine`.

## Semantics to know
- App state is derived: any subsystem `given-up` → `degraded`; recovers after `reinitialize`.
- `abort` aborts the current root signal and installs a fresh one (the app keeps running); during `starting` it cancels boot.
- `refresh` = `injector.refresh('epoch')` + `subsystem.refresh(epoch)` in dependency order; a failed refresh restarts that subsystem.
- Pause broadcasts in reverse dependency order, resume forward; restarts wait for resume (I-1).
- Critical subsystems start before `core-ready` and may only depend on critical subsystems; a critical give-up fails boot.
- Feature logic scope ⊃ UI scope ⊃ visible scope. `visible(ctx, scope)` re-runs on every show; hidden features keep DOM, drop effects.
- Ref-count (I-6): dependents that are mounted block deactivation (SF-FT-002); dependents only activated are deactivated first.
- Resource manager never demotes features in use (mounted, referenced, busy, explicit headless); budgets beat priorities.

## Rules
- Only `@staticflux/core` imports (plus `@staticflux/storage` in `archive.ts`/`units.ts` for R9.0d). No platform APIs except feature-detected scheduler primitives (all injectable).
- Every lifecycle change goes through its machine (`machines.ts`); keep tables in sync with docs/LIFECYCLES.md.
- Every new error via `defineError('SF-APP|FT|SCHED-NNN', …)` with a concrete `fix`.
- Hooks (`start`, `activate`, `mount`, …) may return nothing, a `Result`, or a promise of either; throws are captured.

## Test
`npx vitest run packages/runtime` · `npx tsc -p packages/runtime --noEmit`
