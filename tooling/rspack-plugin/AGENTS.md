# @staticflux/rspack-plugin — AGENTS.md

**Layer:** tooling (Node only, build time; never imported by app or framework runtime code).
**Budget:** none (not shipped to browsers).

## Purpose
StaticFlux integration for **Rspack** (and webpack 5), the supported bundler for **Module Federation 2.0** setups
(Vite 8 is the default: `@staticflux/vite-plugin`). Emits the same `sf-manifest.json`, per-profile preloads, SW
precache list, build report and budget violations as the Vite plugin, from the compilation's chunk groups; maps MF
remotes' exposed modules to logical chunk ids (manifest `remote` entries consumed by the loader's
`federationStrategy`) and validates the host's shared singletons/versions at build time (R12.5, P9). Written against a
minimal structural compiler interface — no Rspack dependency. Implements the build side of R12.2, R12.3, R12.5, R12.7,
R12.10, R12.12, R11.16b.

## Usage (Rspack + Module Federation 2.0)
```ts
// rspack.config.ts
import { rspack } from '@rspack/core';
import { ModuleFederationPlugin } from '@module-federation/enhanced/rspack'; // or rspack.container.ModuleFederationPlugin
import { staticfluxRspack } from '@staticflux/rspack-plugin';
import studioMf from './mf/studio-mf-manifest.json' with { type: 'json' }; // the remote's mf-manifest.json (CI artifact)

const remotes = { studio: 'studio@https://cdn.example/studio/mf-manifest.json' };
const shared = { lit: { singleton: true, requiredVersion: '^3.2.0' }, mobx: { singleton: true, requiredVersion: '^6.13.0' } };

const sf = staticfluxRspack({
  chunks,                         // chunk('feature:studio-desktop', …), chunk('feature:remote-panel', …)
  bootPlans, profiles,
  budgets: { onViolation: 'error', bootKb: 150 },
  isolation: 'preferred',
  html: { plugin: rspack.HtmlRspackPlugin, profile: 'web:expanded' },
  federation: {
    remotes, shared,              // the SAME objects passed to ModuleFederationPlugin
    exposes: { 'feature:remote-panel': 'studio/Panel' },   // logical id → "<remote>/<exposed>"
    manifests: { studio: studioMf },                        // validates exposes + remote shared needs, resolves remoteEntry
  },
});

export default {
  entry: { main: './src/main.ts', 'lib.shell': './src/shell/index.ts' },   // entry name = chunkNameFor('lib:shell')
  output: { publicPath: '/assets/', module: true },  // ESM output for the loader's dynamic-import strategy
  experiments: { outputModule: true },
  devServer: { headers: sf.headers },                 // COOP/COEP/CORP when isolation ≠ off
  plugins: [
    new rspack.HtmlRspackPlugin({ template: './index.html' }),
    new ModuleFederationPlugin({ name: 'host', remotes, shared, library: { type: 'module' } }),
    sf,
  ],
};
```
Lazy chunks: `import(/* webpackChunkName: "feature.studio-desktop" */ './features/studio')` (name =
`chunkNameFor(id)`), or give the declaration an `entry` whose path ends with the `import()` request
(`entry: 'src/features/studio.ts'` matches `import('./features/studio')`). At runtime bind the loader's
`federationStrategy({ shared })` as `RemoteStrategyToken` with the same singleton versions the build validated.

## Chunk-group mapping
Every chunk group (entrypoint or `import()` group) is a candidate logical chunk. Its main chunk (named like the group,
else the last JS chunk — split chunks are inserted before it) provides the entry file; the group's other JS chunks are
static imports (listed after it in `files`); CSS from `files`/`auxiliaryFiles` of all group chunks. A chunk that is main
in several groups gets the union of their imports.

## Module Federation checks (`planFederation`, fail with `SF-RSPACK-005/006/007`)
- Host: every `singleton` needs a resolvable version (`shared[x].version` or `<context>/node_modules/x/package.json`),
  and the host version must satisfy its own `requiredVersion`.
- Per remote: each singleton the remote declares (mf-manifest `shared[].singleton`) must be shared by the host **as a
  singleton**; the host version must satisfy the remote's `requiredVersion` for singletons (either side) and for every
  explicit `remoteShared[remote]` range. Non-singleton mismatches are allowed (MF falls back to the remote's copy).
- Exposes: the remote must be a key of `remotes`, the module must be in the remote's mf-manifest `exposes` (when given),
  the logical id must be declared in `chunks`. `remotes` pointing at `mf-manifest.json` need `manifests[name]` to
  resolve `metaData.publicPath` (`auto` = the manifest URL's directory) + `remoteEntry.path/name`.
- Manifest `remote.shared` keeps the singleton ranges, so the loader re-checks them before `init` (SF-LOAD-004).

## Public API (by file)
- `plugin.ts` — `staticfluxRspack(options)` → `{ name, headers, apply(compiler) }` (throws the `SF-RSPACK-004`
  SfError on invalid options); `StaticfluxRspackOptions` (as the Vite plugin, plus `base` (default `output.publicPath`
  unless `auto`), `federation`, `html: { plugin, profile }`, `bootEntries` (module paths matched to `import()`/entry
  requests)); `chunkNameFor`, `validateOptions`, `toBuildError`,
  `gzipKb`, `sha384`, file-name constants.
- `compilation.ts` — structural `CompilerLike`/`CompilationLike`/`ChunkGroupLike`/`ChunkLike`/`SourceLike`,
  `fromCompilation`, `resolveDeclarations`, `groupForModule`, `entrypointFiles` (from `compilation.entrypoints`),
  `normalizeRequest`, `assetText`, `STAGE_REPORT`.
- `federation.ts` — `planFederation(options, declared, context)` → `{ remotes, shared }`, `FederationOptions`,
  `MfManifestLike`, `MfRemoteConfig`, `MfSharedConfig`, `remoteUrlOf`, `remoteEntryUrl`, `parseExpose`,
  `normalizeShared`, `packageVersionResolver`.
- `html.ts` — `HtmlPluginLike` (HtmlRspackPlugin / html-webpack-plugin `getCompilationHooks().alterAssetTags`),
  `preloadTags`, `referencedUrls`.
- `artifacts.ts` — mirror of the Vite plugin's pure step (`computeArtifacts` (`entries`, `bootEntries`), `ChunkCost`
  (`sizeKb` closure, `incrementalKb`), `buildReportJson`, budgets).
- `isolation.ts` — `isolationHeaders`, `crossOriginFor`.
- `errors.ts` — `SF-RSPACK-001` manifest build · `002` budget · `003` boot plan · `004` options · `005` shared
  singleton/version mismatch · `006` unknown remote/exposed module · `007` remote entry unresolvable.

## Semantics to know
- Hooks: `thisCompilation` → federation plan (errors → `compilation.errors`, nothing emitted) → `processAssets` at
  `PROCESS_ASSETS_STAGE_REPORT` (after minification and real content hash) → emits the four JSON files with the
  bundler's own `RawSource` (fallback: a minimal source object). Violations go to `compilation.warnings`, or
  `compilation.errors` with `budgets.onViolation: 'error'`. Every error message is `CODE: message\n  fix: …`.
- Boot set (same as the Vite plugin): app entrypoints' static closure (`compilation.entrypoints` that are not logical
  chunks) + `bootEntries` closures + the boot plan's `modulepreload` list per profile; without plans one set (`*`) also
  holding critical-tier + eager chunks — never 0 KB just because no plans exist. Chunk budgets apply to
  `incrementalKb` (closure bytes not in the boot set of the profiles the chunk serves; a chunk in the boot set counts its
  whole closure); `sizeKb` in the manifest stays the full closure; the build report lists both.
- HTML tags are computed in `alterAssetTags` (before minification; sizes are not needed there) and pushed into
  `assetTags.styles` (head), skipping URLs already referenced.

## Rules
- No Rspack/webpack imports: extend the structural types in `compilation.ts` when a new field is needed.
- Only `@staticflux/core`, `@staticflux/loader` and Node built-ins. Keep `artifacts.ts`/`isolation.ts` in sync with the Vite plugin.
- Every new error via `defineError('SF-RSPACK-NNN', …)` with a concrete fix.

## Test
`npx vitest run tooling/rspack-plugin` (fake compiler/compilation) · typecheck `npx tsc -p tooling/rspack-plugin --noEmit`
