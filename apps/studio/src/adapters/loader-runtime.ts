/**
 * Adapter: @staticflux/loader ⇄ @staticflux/runtime.
 *
 * - The dev/test manifest is built from the static chunk map (no bundler output
 *   needed); the load strategy runs the bundler-visible `import()` per chunk id.
 * - `chunkFeatureLoaderUnit` binds runtime's `FeatureLoaderToken` to the chunk loader,
 *   so the stock `featureHostUnit` loads feature modules through it: gating (I-8),
 *   dedup, retries and `chunk.load` spans apply to every activation.
 */
import { err, ok, toSfError, unit } from '@staticflux/core';
import {
  ChunkLoaderToken,
  type ChunkId,
  type LoadStrategy,
  type LoaderEnv,
  LoaderEnvToken,
  LoadStrategyToken,
  MANIFEST_FORMAT,
  type ManifestChunk,
  parseManifest,
  type SfManifest,
  budgetKbOf,
} from '@staticflux/loader';
import { defaultIdleScheduler } from '@staticflux/loader';
import { type FeatureLoader, FeatureLoaderToken, type FeatureModule, manifestFeatureLoader } from '@staticflux/runtime';
import { chunkDeclarations, chunkImports, featureChunks } from '../app/features.js';

/** Manifest from the static chunk map (`files` are logical; the strategy never fetches them). */
export function buildDevManifest(buildId = 'dev'): SfManifest {
  const chunks: Record<string, ManifestChunk> = {};
  for (const declaration of chunkDeclarations) {
    const budgetKb = budgetKbOf(declaration.budget);
    chunks[declaration.id] = {
      id: declaration.id,
      files: [`chunk/${declaration.id.replace(':', '-')}.js`],
      css: [],
      deps: declaration.deps ?? [],
      tier: declaration.tier,
      load: declaration.load,
      ...(budgetKb === undefined ? {} : { budgetKb }),
      ...(declaration.profiles === undefined ? {} : { profiles: declaration.profiles }),
    };
  }
  const parsed = parseManifest({ format: MANIFEST_FORMAT, buildId, base: '/', chunks });
  if (!parsed.ok) throw parsed.error; // a broken static map is a programming error
  return parsed.value;
}

/** Runs the bundler-visible import of a chunk; module-map caching makes retries cheap. */
export function staticImportStrategy(imports: Readonly<Record<string, () => Promise<unknown>>> = chunkImports): LoadStrategy {
  return {
    kind: 'static-import',
    async load(request) {
      if (request.signal.aborted) return err(toSfError(request.signal.reason));
      const load = imports[request.chunk.id];
      if (load === undefined) return err(toSfError(new Error(`No import for chunk ${request.chunk.id}`)));
      try {
        return ok(await load());
      } catch (error) {
        return err(toSfError(error));
      }
    },
  };
}

export const staticImportStrategyUnit = unit({
  id: 'studio/static-import-strategy-unit',
  provides: LoadStrategyToken,
  scope: 'app',
  create: () => staticImportStrategy(),
  description: 'Chunk id → bundler-visible import() (dev manifest without hashed files).',
});

/** Loader env without DOM preload injection (logical file names must not become <link>s). */
export const studioLoaderEnvUnit = unit({
  id: 'studio/loader-env-unit',
  provides: LoaderEnvToken,
  scope: 'app',
  create: (): LoaderEnv => ({
    document: undefined,
    importer: (specifier) => import(/* @vite-ignore */ specifier),
    idle: defaultIdleScheduler,
    timer: (callback, ms) => {
      const id = setTimeout(callback, ms);
      return () => clearTimeout(id);
    },
    resourceTiming: () => undefined,
    intersectionObserver: undefined,
  }),
});

export const chunkFeatureLoaderUnit = unit({
  id: 'studio/chunk-feature-loader-unit',
  provides: FeatureLoaderToken,
  scope: 'app',
  deps: { required: { loader: ChunkLoaderToken } },
  create:
    ({ loader }): FeatureLoader =>
    async (manifest, signal) => {
      const chunkId: ChunkId | undefined = featureChunks[manifest.id];
      if (chunkId === undefined) return manifestFeatureLoader(manifest, signal);
      const loaded = await loader.load<{ readonly default: FeatureModule }>(chunkId, { signal, origin: 'demand' });
      return loaded.ok ? ok(loaded.value.default) : loaded;
    },
  description: 'Feature modules load through the chunk loader (gated, I-8); unmapped features use manifest.load.',
});
