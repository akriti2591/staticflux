# @staticflux/loader — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`).
**Budget:** boot path (`createChunkLoader` + manifest helpers + dynamic-import strategy + `dom.ts`) ≈ 12 KB gzip
measured on unminified tsc output; warmup + speculation ≈ 5 KB more (load after core-ready). `build.ts` is
build-time only (tree-shaken from the app). No size-limit entry yet.

## Purpose
Logical chunk ids and the build manifest (`sf-manifest.json`), the runtime that resolves ids to hashed URLs and
loads them (gated, profile-scoped, deduped, retried, deps preloaded), warmup tiers, the speculation engine,
per-profile boot plans, loading strategies (dynamic import, import maps, Module-Federation-style remotes) and a
bundler-agnostic build helper. Implements R12.2–R12.5, R12.9–R12.12, R6.12/I-8 (gating hook), R11.16b (loader
part), R19.7/R19.8 (advisor clamp + time box).

## Public API (by file)
- `chunk.ts` — `chunk(id, { tier, load, reason, budget, deps, profiles, entry })`, `ChunkId` (declaration merging:
  `Registry { chunks: { 'feature:studio-desktop': true } }`), `WARMUP_TIERS`, `DEFAULT_CHUNK_BUDGETS_KB`, `budgetKbOf`.
  `load: 'eager'` without `reason` does not type-check.
- `manifest.ts` — `SfManifest` (`sf-manifest/1`), `parseManifest`, `getChunk`, `chunkClosure`, `urlsFor`, `fileUrl`,
  `precacheList` (critical tier → Workbox `{url, revision}`), `toImportMap`, `chunkSpecifier`, `urlToChunkMap`,
  `chunkAttributor` (LoAF script URL → chunk; bind into perf `ScriptAttributionToken`).
- `build.ts` — `createManifest({ buildId, base, declarations, output, remotes })` → `{ manifest, report }`
  (budget overruns, eager boot cost), `fromRollupBundle(bundle, { sizeOf, integrityOf })`.
- `loader.ts` — `createChunkLoader({ manifest, importer, strategy, remoteStrategy, canLoad, profile, document,
  isolation, retry, resourceTiming })`: `load`, `preload`, `check`, `state`, `urlOf`, `inspect`, `wasted`;
  `chunkMachine`, `ChunkGate`, `allowAllChunks`, `classifyCodeSource`, `chunkLoadFunction` (→ runtime `FeatureManifest.load`).
- `strategies.ts` — `dynamicImportStrategy`, `importMapStrategy`, `installImportMap`, `federationStrategy({ shared,
  loadContainer })`, `RemoteContainer`, `SharedSingleton`, `checkShared`, `satisfiesRange`, `nativeImporter`.
- `dom.ts` — `LoaderDocument` port, `createPreloadInjector`, `LoaderIsolationPolicy`, `noIsolationPolicy`, `crossOriginPolicy`.
- `warmup.ts` — `createWarmup({ loader, idle, facts, advisor })`: `warmLikely(ids?)`; `warmupAllowance`,
  `WarmupFacts`, `NOMINAL_WARMUP_FACTS`, `warmupMachine`, `defaultIdleScheduler`.
- `speculation.ts` — `defineSpeculationRule({ id, chunks, eagerness, action, dwellMs })`, `createSpeculationEngine`:
  `signal(rule, 'hover'|'focus'|'viewport'|'pointerdown'|'prediction'|'leave')`, `activate`, `observe(target, rule, scope)`;
  `reaction`, `lowerEagerness`, `EAGERNESS_LEVELS`.
- `advisor.ts` — `WarmupAdvisor { id, rank(candidates) }`, `rankCandidates` (time-boxed, default 5 ms), `clampOrder`.
- `boot-plan.ts` — `defineBootPlan({ id, match, critical, eager: [{ chunk, reason }], preload, hostBridge,
  historyStrategy, shellPreset })`, `selectBootPlan`, `emitProfilePreloads` (build), `eagerReport`, `runBootPlan`.
- `tokens.ts` / `units.ts` — `loaderUnits` + `manifestUnit(manifest)`, `speculationRuleUnit`, `bootPlanUnit`;
  ports `ChunkGateToken`, `LoaderIsolationPolicyToken`, `WarmupFactsToken`, `LoaderProfileToken`, `LoaderEnvToken`,
  `LoadStrategyToken`, `RemoteStrategyToken` (multi), `WarmupAdvisorsToken` (multi); services `ChunkLoaderToken`,
  `WarmupToken`, `SpeculationEngineToken`, `BootPlannerToken`.
- `errors.ts` — `SF-LOAD-001…011`. `telemetry.ts` — `LOADER_SUBSYSTEMS` (`loader/chunk|warmup|speculation|boot`), `loaderMetrics`.

## Semantics to know
- Load order: gate + profile check on the whole closure → `modulepreload`/stylesheet links (with `crossorigin` from the
  isolation policy and SRI) → deps execute (parallel) → entry. **A denied chunk or a denied dependency is never fetched** (I-8).
- Retries use full-jitter backoff; retry URLs get `?sf-retry=n` (browsers cache failed module imports).
- Warmup hits: a `demand` load of a chunk first touched by `likely`/`speculative`/`boot` records `loader/warmup-hit`;
  `wasted()` lists warmed-but-never-demanded chunks (advisor outcome, R19.10).
- Backoff: offline/saveData/2g → no background warmup; 3g and low-tier devices drop one speculative eagerness step each.
- Advisors only reorder candidates (never add), within a time box; timeout/error → declared order. Never on a critical path.
- Federation: the host owns singletons (`shared`); remote `requiredShared`/manifest `remote.shared` ranges are checked
  before `init`; mismatch → `SF-LOAD-004` (not retried).

## Wiring the build helper (Vite / Rollup)
In `generateBundle(_, bundle)`: `createManifest({ buildId, base, declarations, output: fromRollupBundle(bundle, { sizeOf }) })`,
fail the build on `!ok`, warn on `report.overBudget`, then `this.emitFile({ type: 'asset', fileName: MANIFEST_FILE_NAME,
source: JSON.stringify(manifest) })`. Declarations' `entry` matches a chunk's facade module path (suffix) or chunk name;
mark features as dynamic imports (`import()` in the route/feature manifest) so the bundler emits separate chunks.
Per-profile boot HTML: `emitProfilePreloads(manifest, plans, profiles)`; SW precache: `precacheList(manifest, { profile })`.
Full example in the `build.ts` header.

## Rules
- Only `@staticflux/core` imports. Browser APIs only through injected ports (`LoaderEnv`, `LoaderDocument`, observers).
- Never fetch before `canLoad` — new code paths that touch the network must go through `check()`.
- Client gating is UX, not security (R6.16): the server re-checks every request a chunk makes.
- Every new error via `defineError('SF-LOAD-NNN', …)` with a concrete `fix`; machines (`loader/chunk`, `loader/warmup`)
  must stay in sync with docs/LIFECYCLES.md §14.

## Test
`npx vitest run packages/loader` · `npx tsc -p packages/loader --noEmit`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/loader (boot: chunk loader + boot plan) | 4.5 KB | packages/loader/dist/index.js · import `{ createChunkLoader, selectBootPlan, runBootPlan }` |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
