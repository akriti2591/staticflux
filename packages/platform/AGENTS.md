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
- `errors.ts` — `SF-PLAT-001` unknown mode override, `-002` duplicate host mode, `-003` AI probe failed, `-004` no host bridge, `-005` bridge load failed.

## Rules
- Never touch `window`/`navigator`/`matchMedia` directly — only through `PlatformEnv`.
- Capability first; the UA string only names OS/browser and detects webviews.
- `env.ts`, `form-factor.ts`, `detect-mode.ts` must not import `@staticflux/core` or anything with runtime code (boot path).
- New host modes / form factors are plugins: declaration-merge the registry and contribute via `hostModeUnit`/`formFactorUnit`; never add `if (mode === …)` here or in features (R18.5).
- Every listener is registered on a scope; disposing the scope removes it (`listenerCount()` in tests).
- Host-mode capability profiles can only *remove* capabilities (`false`); detection decides the rest.

## Test
`npx vitest run packages/platform`
