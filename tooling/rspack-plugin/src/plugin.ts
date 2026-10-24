/**
 * `staticfluxRspack()` — Rspack (and webpack 5) plugin, written against the structural
 * compiler interface in `compilation.ts` (no Rspack dependency):
 * - `thisCompilation` → `processAssets` (stage REPORT): sf-manifest.json, sf-preloads.json,
 *   sf-precache.json, sf-build-report.json from the chunk groups; budget violations as
 *   warnings or errors.
 * - Module Federation 2.0: `federation` maps remotes' exposed modules to logical chunk ids
 *   (manifest `remote` entries) and validates host shared singletons/versions.
 * - `html.plugin` (HtmlRspackPlugin): boot-plan `modulepreload` tags via `alterAssetTags`.
 * Dev isolation headers: `devServer: { headers: isolationHeaders(...) }` (see AGENTS.md).
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import {
  type BootPlan,
  type ChunkDeclaration,
  fileUrl,
  isChunkId,
  MANIFEST_FILE_NAME,
  type ManifestRemote,
  type ProfileLike,
  type WarmupTier,
} from '@staticflux/loader';
import { type BudgetOptions, type BuildArtifacts, buildReportJson, computeArtifacts, htmlPreloadsFor } from './artifacts.js';
import { type CompilationLike, type CompilerLike, fromCompilation, resolveDeclarations, type SourceLike, STAGE_REPORT } from './compilation.js';
import { RspackBudgetExceededError, RspackOptionsError } from './errors.js';
import { type FederationOptions, type FederationPlan, planFederation } from './federation.js';
import { type HtmlPluginLike, preloadTags, referencedUrls } from './html.js';
import { type CoepMode, type CorpMode, crossOriginFor, type IsolationMode } from './isolation.js';

export const PLUGIN_NAME = 'StaticfluxRspackPlugin' as const;
export const PRELOADS_FILE_NAME = 'sf-preloads.json' as const;
export const PRECACHE_FILE_NAME = 'sf-precache.json' as const;
export const REPORT_FILE_NAME = 'sf-build-report.json' as const;

export interface StaticfluxRspackOptions {
  readonly chunks: readonly ChunkDeclaration[];
  readonly bootPlans?: readonly BootPlan[];
  readonly profiles?: readonly ProfileLike[];
  readonly budgets?: BudgetOptions;
  /** Default `off`; decides the `crossorigin` of injected tags (headers: `isolationHeaders`). */
  readonly isolation?: IsolationMode;
  readonly coep?: CoepMode;
  readonly corp?: CorpMode;
  readonly crossorigin?: 'anonymous' | 'use-credentials';
  readonly precache?: false | { readonly fileName?: string; readonly tiers?: readonly WarmupTier[] };
  readonly manifestFileName?: string;
  readonly preloadsFileName?: string;
  readonly reportFileName?: string | false;
  /** Inject boot preloads through HtmlRspackPlugin (`html: { plugin: rspack.HtmlRspackPlugin }`). */
  readonly html?: false | { readonly plugin: HtmlPluginLike; readonly profile?: string };
  readonly buildId?: string;
  /** URL prefix of emitted files. Default: `output.publicPath` when it is a string other than `auto`, else `/`. */
  readonly base?: string;
  /** Module Federation 2.0 remotes → logical chunk ids, shared singleton validation. */
  readonly federation?: FederationOptions;
  readonly sri?: boolean;
  readonly sizeOf?: (fileName: string, code: string) => number;
}

export interface RspackPluginLike {
  readonly name: string;
  apply(compiler: CompilerLike): void;
}

/** File-safe chunk-group name for a logical id: use it as entry name or `webpackChunkName`. */
export function chunkNameFor(id: string): string {
  return id.replace(/:/g, '.').replace(/[\\/]/g, '_');
}

export const gzipKb = (_fileName: string, code: string): number => Math.round((gzipSync(code).length / 1024) * 100) / 100;
export const sha384 = (_fileName: string, code: string): string => `sha384-${createHash('sha384').update(code).digest('base64')}`;

export function validateOptions(options: StaticfluxRspackOptions): Result<void> {
  const bad = (message: string, details: Record<string, unknown> = {}): Result<void> => err(RspackOptionsError({ message, details }));
  const seen = new Set<string>();
  for (const d of options.chunks) {
    if (!isChunkId(d.id)) return bad(`Chunk id "${d.id}" is not a \`kind:name\` id.`, { chunk: d.id });
    if (seen.has(d.id)) return bad(`Chunk "${d.id}" is declared twice.`, { chunk: d.id });
    seen.add(d.id);
  }
  const profiles = options.profiles ?? [];
  if ((options.bootPlans ?? []).length > 0 && profiles.length === 0) {
    return bad('`bootPlans` were given without `profiles`; list the app profiles to emit per-profile preloads for.');
  }
  const htmlProfile = options.html === false || options.html === undefined ? undefined : options.html.profile;
  if (htmlProfile !== undefined && !profiles.some((p) => p.key === htmlProfile)) {
    return bad(`html.profile "${htmlProfile}" is not one of profiles (${profiles.map((p) => p.key).join(', ') || 'none'}).`, { profile: htmlProfile });
  }
  return ok();
}

/** Bundler error object carrying the SfError (code + fix in the printed message). */
export function toBuildError(error: SfError): Error {
  return new Error(`${error.code}: ${error.message}${error.fix === undefined ? '' : `\n  fix: ${error.fix}`}`, { cause: error });
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function rawSource(compiler: CompilerLike, text: string): SourceLike {
  const RawSource = compiler.webpack?.sources?.RawSource;
  if (RawSource !== undefined) return new RawSource(text);
  return { source: () => text, size: () => Buffer.byteLength(text) };
}

function baseOf(compiler: CompilerLike, compilation: CompilationLike, override: string | undefined): string {
  if (override !== undefined) return override;
  const publicPath = compilation.outputOptions?.publicPath ?? compiler.options?.output?.publicPath;
  return typeof publicPath === 'string' && publicPath !== 'auto' ? publicPath : '/';
}

export function staticfluxRspack(options: StaticfluxRspackOptions): RspackPluginLike {
  const valid = validateOptions(options);
  if (!valid.ok) throw valid.error;
  const isolation = options.isolation ?? 'off';
  const manifestFileName = options.manifestFileName ?? MANIFEST_FILE_NAME;
  const html = options.html === false ? undefined : options.html;
  const htmlProfile = html?.profile ?? options.profiles?.[0]?.key;
  const sizeOf = options.sizeOf ?? gzipKb;

  const compute = (
    compiler: CompilerLike,
    compilation: CompilationLike,
    federation: FederationPlan | undefined,
    measure: boolean,
  ): Result<BuildArtifacts> => {
    const output = fromCompilation(compilation, measure ? { sizeOf, ...(options.sri === true ? { integrityOf: sha384 } : {}) } : {});
    const remotes: Readonly<Record<string, ManifestRemote>> | undefined = federation?.remotes;
    return computeArtifacts(output, {
      base: baseOf(compiler, compilation, options.base),
      declarations: resolveDeclarations(options.chunks, output.requests, chunkNameFor),
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      ...(options.bootPlans === undefined ? {} : { bootPlans: options.bootPlans }),
      ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
      ...(remotes === undefined ? {} : { remotes }),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      precache: options.precache === false ? false : { ...(options.precache?.tiers === undefined ? {} : { tiers: options.precache.tiers }) },
    });
  };

  return {
    name: PLUGIN_NAME,
    apply(compiler) {
      compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
        let federation: FederationPlan | undefined;
        if (options.federation !== undefined) {
          const planned = planFederation(options.federation, new Set(options.chunks.map((c) => c.id)), compiler.options?.context ?? compiler.context ?? process.cwd());
          if (!planned.ok) {
            compilation.errors.push(toBuildError(planned.error));
            return;
          }
          federation = planned.value;
        }

        if (html !== undefined) {
          html.plugin.getCompilationHooks(compilation).alterAssetTags.tapPromise(PLUGIN_NAME, async (data) => {
            const result = compute(compiler, compilation, federation, options.sri === true);
            if (!result.ok) return data; // reported by processAssets
            const { manifest } = result.value;
            const integrity = new Map<string, string>();
            for (const c of Object.values(manifest.chunks)) {
              for (const [file, hash] of Object.entries(c.integrity ?? {})) integrity.set(fileUrl(manifest, file), hash);
            }
            const preloads = htmlPreloadsFor(result.value, htmlProfile);
            data.assetTags.styles.push(
              ...preloadTags({
                modulepreload: preloads.modulepreload,
                stylesheets: preloads.stylesheets,
                crossorigin: crossOriginFor(isolation, options.crossorigin),
                integrity,
                existing: referencedUrls(data),
              }),
            );
            return data;
          });
        }

        compilation.hooks.processAssets.tap({ name: PLUGIN_NAME, stage: compiler.webpack?.Compilation?.PROCESS_ASSETS_STAGE_REPORT ?? STAGE_REPORT }, () => {
          const result = compute(compiler, compilation, federation, true);
          if (!result.ok) {
            compilation.errors.push(toBuildError(result.error));
            return;
          }
          const artifacts = result.value;
          const emit = (name: string, value: unknown): void => compilation.emitAsset(name, rawSource(compiler, json(value)));
          emit(manifestFileName, artifacts.manifest);
          if (artifacts.preloads !== undefined) emit(options.preloadsFileName ?? PRELOADS_FILE_NAME, artifacts.preloads);
          if (artifacts.precache !== undefined && options.precache !== false) emit(options.precache?.fileName ?? PRECACHE_FILE_NAME, artifacts.precache);
          if (options.reportFileName !== false) emit(options.reportFileName ?? REPORT_FILE_NAME, buildReportJson(artifacts));
          const fail = (options.budgets?.onViolation ?? 'warn') === 'error';
          for (const v of artifacts.violations) {
            const error = toBuildError(RspackBudgetExceededError({ message: v.message, details: { violation: v } }));
            (fail ? compilation.errors : compilation.warnings).push(error);
          }
        });
      });
    },
  };
}
