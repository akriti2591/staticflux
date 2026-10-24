# @staticflux/platform — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`).
**Budget:** inline mode detector (`@staticflux/platform/detect-mode`) < 1 KB brotli (R12.9; measured 1016 B brotli / 1132 B gzip with `browserEnv`). The rest of the package is lazy-loadable after boot.

## Purpose
Capability-based platform detection → reactive `PlatformFacts` (R18.1, R18.2); host modes and form
factors as open sets (R18.3, R18.3a); `AppProfile` = host mode × form factor with hysteresis and
overrides (R18.4, R18.6, R12.9–R12.11); degraded capability profiles per host (R18.10); host bridge
port (R18.8); built-in AI availability as a fact (R19.17). Every browser read goes through the
injectable `PlatformEnv`, so tests are deterministic.

## Public API (by file)
- `env.ts` — `PlatformEnv` (window/navigator/matchMedia/globals stand-ins), `browserEnv()`, `mediaMatches`, `readGlobal`, `isEmbedded`. No runtime imports.
- `form-factor.ts` — `FormFactorRegistry` (declaration merging), `defineFormFactor`, built-ins `compact|medium|expanded` (0/600/840 px), `computeFormFactor(width, defs, previous?, hysteresis = 24)`. No runtime imports.
- `detect-mode.ts` — **inline detector** (subpath `@staticflux/platform/detect-mode`): `HostModeRegistry`, `ModeDetector`, built-in detectors, `detectHostMode`, `parseModeOverride` (`?sf-mode=embed-agent-host:compact`), `rawFormFactor`, `detectMode(env, { detectors, formFactors, override, urlParam })`. Precedence: URL > config > detection.
- `facts.ts` — `PlatformFacts` groups (`input`, `network`, `device`, `preferences`, `display`, `host`, `capabilities`, `ai`) and pure readers (`readPlatformFacts`, `readNetwork`, `tierOf`, `deviceClassOf`, `readOs`/`readBrowser` (UA-CH first, UA fallback), `probeLocalStorage`, …).
- `host-mode.ts` — `defineHostMode({ id, priority, detect, capabilities, historyStrategy, shellPreset?, bridge? })`, `HistoryStrategyRegistry`, `ShellPresetRegistry`, `HostBridge` port, built-ins `web`, `pwa`, `embed-iframe`, `embed-agent-host`, `webview-ios`, `webview-android`.
- `platform-facts.ts` — `createPlatformFacts({ env, scope, telemetry, aiProbeTimeoutMs, probeAiOnStart })` → `PlatformFactsSource` (one observable per group; `snapshot`, `refresh`, `probeAi`, `onChange`); machines `platform/facts-source`, `platform/ai-probe`; metrics `platform/fact-changes`, `platform/ai-probe-duration`.
- `profile.ts` — `createAppProfile(...)` → `Result<AppProfileSource>` (`current`, `hostMode`, effective `capabilities`/`has`, `force`, `loadBridge` (single-flight, cached, scope-disposed), `onChange`); `matchesProfile`, `profileKey`, `effectiveCapabilities`; metric `platform/profile-changes`.
- `fake-env.ts` — `createFakePlatformEnv(...)` (controllable media/viewport/online/connection, `listenerCount()`), `SAMPLE_USER_AGENTS`.
- `units.ts` — tokens `PlatformEnvToken`, `PlatformOptionsToken`, `HostModesToken` (multi), `FormFactorsToken` (multi), `PlatformFactsToken`, `AppProfileToken`; units `browserEnvUnit`, `platformEnvUnit(env)`, `platformOptionsUnit(opts)`, `platformFactsUnit`, `appProfileUnit` (both critical), `hostModeUnit(def)`, `formFactorUnit(def)`, `platformUnits(opts, env?)`.
- `isolation.ts` — R11.16a/b: `IsolationDeclaration { mode: 'required'|'preferred'|'off', coep: 'require-corp'|'credentialless', origin, credentialedOrigins }`,
  `readIsolationFacts(env)` (`crossOriginIsolated`, embedded, SAB+Atomics, `credentialless` iframes), `createIsolationPolicy(decl, facts, env?)` →
  `IsolationPolicy { mode, coep, isolated, sharedMemory, status: isolated|off|fallback|blocked, reason, gateReason, crossOriginAttr(url, kind),
  fetchInit(url), iframeAttrs(url), imageCors(url), check() }`, `offIsolationPolicy`; structural port adapters `toUiIsolationPolicy` (ui
  `IsolationPolicyToken`), `toLoaderIsolationPolicy` (loader `LoaderIsolationPolicyToken`), `toSurfaceImagePolicy` (surface
  `SurfaceImagePolicyToken`), `toWorkerIsolationFacts` (worker `IsolationFactsToken`).
- `isolation-reporting.ts` — dev-mode `startIsolationReporting({ env, telemetry, scope, dev, attribute })` (feature-detected `ReportingObserver`,
  types `coep`/`coop`) → one conformance `violation` event per report (subsystem `platform/isolation`, attrs `code, fix, severity, message,
  details`); `violationFromReport`, `reportIsolationViolation`.
- `isolation-units.ts` — tokens `IsolationDeclarationToken`, `IsolationPolicyToken`, `IsolationReportingToken` and same-id mirrors
  `UiIsolationPolicyPortToken` (`ui/isolation-policy`), `LoaderIsolationPolicyPortToken` (`loader/isolation-policy`),
  `SurfaceImagePolicyPortToken` (`surface/image-policy`), `WorkerIsolationFactsPortToken` (`worker/isolation-facts`); units
  `isolationDeclarationUnit`, `isolationPolicyUnit` (critical; `init` = `check()` → boot-blocking `SF-PLAT-006`), `isolationReportingUnit`,
  `uiIsolationPolicyUnit`, `loaderIsolationPolicyUnit`, `surfaceImageIsolationPolicyUnit`, `workerIsolationFactsUnit`;
  `isolationPortBindings()` (precedence `app`), `isolationUnits(decl, { dev })`.
- `errors.ts` — `SF-PLAT-001` unknown mode override, `-002` duplicate host mode, `-003` AI probe failed, `-004` no host bridge, `-005` bridge load failed,
  `-006` isolation required but not isolated, `-007` COEP/CORP violation, `-008` COOP violation.

## Isolation semantics
- `off` is a no-op binding (attributes, fetch init, iframe attrs all empty; no shared memory). `imageCors` is always CORS cross-origin (canvas taint), any mode.
- `crossorigin` / `mode: 'cors'` are added only while COEP is in force (`crossOriginIsolated`); under `credentialless`, anonymous media needs no attribute.
- Embedded hosts always fall back (`status: fallback`, never `blocked`). `gateReason` explains why isolation-dependent features are gated off.

## Rules
- Never touch `window`/`navigator`/`matchMedia` directly — only through `PlatformEnv`.
- Capability first; the UA string only names OS/browser and detects webviews.
- `env.ts`, `form-factor.ts`, `detect-mode.ts` must not import `@staticflux/core` or anything with runtime code (boot path).
- New host modes / form factors are plugins: declaration-merge the registry and contribute via `hostModeUnit`/`formFactorUnit`; never add `if (mode === …)` here or in features (R18.5).
- Every listener is registered on a scope; disposing the scope removes it (`listenerCount()` in tests).
- Host-mode capability profiles can only *remove* capabilities (`false`); detection decides the rest.

## Test
`npx vitest run packages/platform`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/platform detect-mode (inline boot detector) | 1.1 KB | packages/platform/dist/detect-mode.js |
| @staticflux/platform (full) | 14 KB | packages/platform/dist/index.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
