# @staticflux/config — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`).
**Budget:** counts toward the framework boot runtime (R12.7, ≤ 45 KB together with core/runtime/DI/router/auth/gate/data); ~3 KB brotli own code. Declarations-only consumers import `@staticflux/config/flag`.

## Purpose
Typed flag/config declarations (R8.1, R8.2), layered reactive resolution
(package default < app < workspace < remote < experiment < local dev override, R8.5) with a
per-flag evaluation trace for devtools, an OpenFeature-compatible provider port without the SDK
(R8.3), and experiment → DI variant bindings so feature code never reads flags (R8.4, P4).
The evaluation context comes from a port (`EvaluationContextToken`) the app fills from session +
platform facts; this package imports neither.

## Public API (by file)
- `flag.ts` — `FlagRegistry` (declaration merging; registered keys must match the declared type), `defineFlag({ key, type, default, owner, preAuthSafe, description })`, `flagType.boolean|string|number|enum|object`, `FlagValues`, `flagValue(flag, v)`, `VariantKey<T>`, `variantValue`, `variantKeyOf`. Subpath `@staticflux/config/flag`.
- `context.ts` — `EvaluationContext` (OpenFeature-shaped), `EvaluationContextSource` port, `staticContext`, `derivedContext(build)`, `contextKey`.
- `layer.ts` — `LAYERS`, `layerRank`, `FlagLayerProvider` port (`lookup` sync; `initialize`/`onContextChange` async; `subscribe` events; `identityBound`; `hooks`), `createStaticLayer` (mutable, devtools), `createLocalOverrideLayer` (storage + `?sf-flag=key:value`), `parseFlagParams`, `parseDevValue`.
- `remote-layer.ts` — `createRemoteLayer({ id, load, retry, reloadOnContextChange })`.
- `experiment-layer.ts` — `defineExperiment({ flag, allocation, salt?, include? })`, `createExperimentLayer`, `assignVariant`, `fnv1a` (deterministic bucketing by `targetingKey`).
- `openfeature.ts` — `OpenFeatureProviderLike` (structural mirror of the OpenFeature web `Provider`: `resolveBooleanEvaluation` etc., `initialize`, `onContextChange`, `onClose`, `events`, `hooks`), `OpenFeatureEvents`, `fromOpenFeatureProvider(provider, { layer, id, keyOf, logger })`.
- `hooks.ts` — `FlagHook` (`before/after/error/finally`, OpenFeature field names), `FlagEvaluation<T>` (OpenFeature details + `layer`, `providerId`, `trace`), `LayerTrace`.
- `resolver.ts` — `createFlagResolver({ providers, context, flags, hooks, telemetry, initTimeoutMs, domain })` → `FlagResolver` (`value` reactive on value only, `details`, `watch`, `ready`, `providers`, `flags`, `inspect`, `snapshot`, `register`, `addProvider`, `initialize` (single-flight, never fails for provider errors), `dispose`); machine `config/provider`; metrics `config/evaluation-errors`, `config/provider-init-duration`.
- `bindings.ts` — `createFlagBinder()` → `FlagBinder` (`variants({ flag, of, variants })` → core `variant()` bindings, `is(flag, value)` predicate, `attach`).
- `units.ts` — tokens `FlagResolverToken`, `FlagLayersToken` (multi), `FlagDefinitionsToken` (multi), `FlagHooksToken` (multi), `EvaluationContextToken`, `FlagBinderToken`; units `flagResolverUnit(opts)` (critical; init = initialize providers), `flagBinderUnit(binder)` (critical), `evaluationContextUnit(source?)`, `layerUnit(p)`, `flagDefinitionUnits(flags)`, `hookUnit(id, hook)`, `configUnits(opts)`.
- `errors.ts` — `SF-CFG-001` invalid value, `-002` duplicate key, `-003` provider init failed, `-004` context change failed, `-005` binder not attached, `-006` provider evaluation error, `-007` unknown key, `-008` remote load failed.

## Rules
- Flags are declared once, in the owner's contracts file; everyone else imports the declaration (R8.2).
- Feature code never reads flags (R8.4): use `binder.variants(...)` / `binder.is(...)`. `resolver.value()` is for the binding layer, shells and devtools.
- Untrusted layer values are always validated by the flag schema; invalid values fall through, never throw.
- Non-`preAuthSafe` flags skip identity-bound layers (`remote`, `experiment` by default) until `authenticated`.
- A variant is chosen once per scope (core `choose` caches it); flag changes apply at the next scope/epoch.
- Never depend on `@openfeature/*`; adapt providers through `fromOpenFeatureProvider`.

## Test
`npx vitest run packages/config`
