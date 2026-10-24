# @staticflux/vite-plugin — AGENTS.md

**Layer:** tooling (Node only, build time; never imported by app or framework runtime code).
**Budget:** none (not shipped to browsers). The only browser code it produces is `virtual:sf-chunks` (a few lines).

## Purpose
The default StaticFlux bundler integration: **Vite 8 (Rolldown)**. Maps logical chunk ids (`chunk()` declarations
from `@staticflux/loader`) to bundler chunks with stable names, emits `sf-manifest.json` (`sf-manifest/1`) through the
loader's bundler-agnostic builder (`createManifest` + `fromRollupBundle`), per-profile preload lists (R12.10), the SW
precache list (R12.3 critical tier), a build report, injects boot-plan `modulepreload` tags into `index.html`, serves
COOP/COEP/CORP in dev/preview (R11.16a/b) and reports budget violations (R12.7, R12.8, R12.12). Implements the build
side of R12.2, R12.3, R12.5 (remote passthrough), R12.7, R12.10, R12.12, R11.16b, R20.4 (per logical chunk).
Rspack (Module Federation 2.0 setups) is `@staticflux/rspack-plugin`; StaticFlux packages stay bundler-agnostic.

## Usage
```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { staticflux } from '@staticflux/vite-plugin';
import { chunks, bootPlans, profiles } from './src/app/chunks.js'; // chunk(...) / defineBootPlan(...) data

export default defineConfig({
  plugins: [
    staticflux({
      chunks,            // chunk('feature:studio-desktop', { entry: 'src/features/studio/index.ts', budget: { category: 'heavy' }, profiles: ['web:expanded'] })
      bootPlans,         // defineBootPlan({ id: 'desktop', match: { formFactors: ['expanded'] }, critical: ['lib:shell'], preload: ['feature:studio-desktop'] })
      profiles,          // [{ key: 'web:expanded', hostMode: 'web', formFactor: 'expanded' }, …]
      isolation: 'preferred', coep: 'credentialless',
      budgets: { onViolation: process.env.CI ? 'error' : 'warn', bootKb: 150, eagerKb: 30 },
      sri: true,
      html: { profile: 'web:expanded' },
    }),
  ],
});
```
```ts
// src/env.d.ts — types of the virtual module
declare module 'virtual:sf-chunks' {
  export const chunks: Readonly<Record<string, () => Promise<unknown>>>;
  export const chunkIds: readonly string[];
  export function importChunk(id: string): Promise<unknown>;
}
// feature manifest: load the logical chunk (same thunk in dev and build)
import { chunks } from 'virtual:sf-chunks';
defineFeature({ id: 'studio-desktop', weight: 'heavy', modes: ['expanded'], load: () => chunks['feature:studio-desktop']!() as Promise<FeatureModule> });
```
At runtime fetch `/sf-manifest.json` → `parseManifest` → `manifestUnit(manifest)` (loader). `sf manifest dist/sf-manifest.json`
re-validates the output in CI.

## Logical chunk naming (the chosen approach)
1. **Build — emitted named chunks.** In `buildStart` every declaration whose `entry` is a module path
   (`src/x.ts`, contains `/` or a JS/TS extension) is emitted with `this.emitFile({ type: 'chunk', id, name:
   chunkNameFor(id), preserveSignature: 'allow-extension' })`. The chunk boundary exists even before any code
   `import()`s it, and the file name is stable and readable: `assets/feature.studio-desktop-<hash>.js`
   (`:` → `.`, `/` → `_`). `createManifest` maps the chunk back to the logical id through its facade module path.
   No `manualChunks` (deprecated in Rolldown) and no override of `chunkFileNames`.
2. **Declarations without `entry`** match the bundler chunk named `chunkNameFor(id)` — e.g. a Rolldown
   `output.codeSplitting.groups[{ name: 'lib.vendor', test: /node_modules/ }]` for `chunk('lib:vendor')`. A non-path
   `entry` matches that chunk name directly.
3. **App code — `virtual:sf-chunks`** exports `chunks` (`import()` thunks keyed by logical id), `chunkIds` and
   `importChunk(id)` (rejects with `SF-LOAD-001` for undeclared ids).
4. **Dev** — the dev server answers `<base>sf-manifest.json` with a dev manifest (`buildId: 'dev'`) whose files are
   the source modules (`/src/x.ts`, `/@fs/…` outside root); chunk-name-only declarations point at the virtual module.

## Public API (by file)
- `plugin.ts` — `staticflux(options)` → Vite `Plugin` (throws the `SF-VITE-004` SfError on invalid options),
  `StaticfluxViteOptions` (`chunks`, `bootPlans`, `profiles`, `budgets`, `isolation` `required|preferred|off` (default
  off), `coep` `require-corp|credentialless`, `corp`, `crossorigin`, `precache` (`false` | `{ fileName, tiers }`),
  `manifestFileName`, `preloadsFileName`, `reportFileName`, `html` (`false` | `{ profile }`), `buildId`, `remotes`,
  `sri`, `emitEntryChunks`, `sizeOf`), `validateOptions`, `buildDeclarations`, `gzipKb`, `sha384`, file-name constants.
- `artifacts.ts` — pure `computeArtifacts(output, options)` → `{ manifest, report, preloads, precache, boot,
  violations, defaultBoot }`; `BudgetOptions` (`onViolation: 'warn'|'error'`, `bootKb`, `eagerKb`), `BudgetViolation`
  (`chunk|eager|boot`), `buildReportJson` (`sf-build-report/1`), `htmlPreloadsFor`, `defaultBuildId`, `ALL_PROFILES`.
- `chunks-module.ts` — `VIRTUAL_CHUNKS_ID`, `renderChunksModule`, `moduleEntries`, `chunkNameFor`, `isModuleEntry`,
  `devUrlOf`, `devBundlerOutput`, `SfChunksModule`.
- `html.ts` — `preloadTags` (skips URLs the HTML already references), `renderTags` (HTML for edge/per-profile pages).
- `isolation.ts` — `isolationHeaders`, `crossOriginFor`, `IsolationMode`, `CoepMode`, `CorpMode`.
- `errors.ts` — `SF-VITE-001` manifest build (wraps SF-LOAD-*) · `002` budget exceeded · `003` boot plan/preloads · `004` options.

## Emitted files (build output root)
| File | Content |
|---|---|
| `sf-manifest.json` | `sf-manifest/1` (logical id → files, css, deps, tier, load/reason, sizeKb, budgetKb, profiles, integrity, remote) |
| `sf-preloads.json` | per profile key: `{ plan, modulepreload, stylesheets, precache }` (only with `bootPlans` + `profiles`) |
| `sf-precache.json` | Workbox `{ url, revision }[]` — critical tier (+ `precache.tiers`) closure; hashed files get `revision: null` |
| `sf-build-report.json` | `sf-build-report/1`: over-budget chunks, eager entries, per-profile `bootKb`/`eagerKb`, violations |

## Semantics to know
- Sizes are gzip KB of the final chunk code (`sizeOf` overridable). Boot JS per profile = deduplicated files of the
  boot plan closure (`modulepreload` list); without plans: one boot set (`*`) = critical-tier + eager chunks.
- Budgets: chunk budgets come from the declarations (`budget.category`/`maxKb`); `bootKb`/`eagerKb` are per profile.
  `onViolation: 'warn'` (default) → `this.warn`; `'error'` → the build fails with every violation listed.
- `transformIndexHtml` (`order: 'post'`) and `generateBundle` share one memoized computation per bundle. Tags get a
  bare `crossorigin` when isolation is off (matches Vite's `<script type="module" crossorigin>`, so the preload is
  reused) and `anonymous` (or the `crossorigin` option) under isolation; SRI when `sri: true`.
- Dev/preview: isolation `required` and `preferred` both send COOP `same-origin`, COEP (`coep`), CORP (`corp`).
  Production headers are the host's job (or the SW-injected COOP/COEP plugin, R11.16a).

## Rules
- Import only types from `vite`; runtime deps are `@staticflux/core`, `@staticflux/loader` and Node built-ins.
- Manifest logic stays in `@staticflux/loader` `build.ts`; this package only adapts hooks. `artifacts.ts` is mirrored in
  `@staticflux/rspack-plugin` — keep both in sync.
- Every new error via `defineError('SF-VITE-NNN', …)` with a concrete fix; outputs are deterministic (no timestamps).

## Test
`npx vitest run tooling/vite-plugin` (hooks with fake bundles/contexts + one real `vite build` of a temp fixture) ·
typecheck `npx tsc -p tooling/vite-plugin --noEmit`
