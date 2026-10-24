/**
 * `staticflux()` — the Vite 8 (Rolldown) plugin. Hooks:
 * - `resolveId`/`load`: `virtual:sf-chunks` (logical id → `import()` thunk).
 * - `buildStart` (build): emits each module-path declaration as a named chunk (stable names).
 * - `generateBundle`: sf-manifest.json, sf-preloads.json, sf-precache.json, sf-build-report.json;
 *   budget violations warn or fail the build.
 * - `transformIndexHtml` (post): boot-plan `modulepreload` tags with `crossorigin` per isolation.
 * - `configureServer` / `configurePreviewServer`: COOP/COEP/CORP headers when isolation ≠ off,
 *   and a dev `sf-manifest.json` pointing at source modules.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import {
  type BootPlan,
  type ChunkDeclaration,
  createManifest,
  fileUrl,
  fromRollupBundle,
  isChunkId,
  MANIFEST_FILE_NAME,
  type ManifestRemote,
  type ProfileLike,
  type RollupLikeOutput,
  type WarmupTier,
} from '@staticflux/loader';
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin, PreviewServer, ResolvedConfig, ViteDevServer } from 'vite';
import { type BudgetOptions, type BuildArtifacts, buildReportJson, computeArtifacts, htmlPreloadsFor } from './artifacts.js';
import { chunkNameFor, devBundlerOutput, moduleEntries, RESOLVED_VIRTUAL_CHUNKS_ID, renderChunksModule, VIRTUAL_CHUNKS_ID } from './chunks-module.js';
import { ViteBudgetExceededError, ViteOptionsError } from './errors.js';
import { preloadTags } from './html.js';
import { type CoepMode, type CorpMode, crossOriginFor, type IsolationMode, isolationHeaders } from './isolation.js';

export const PLUGIN_NAME = 'staticflux' as const;
export const PRELOADS_FILE_NAME = 'sf-preloads.json' as const;
export const PRECACHE_FILE_NAME = 'sf-precache.json' as const;
export const REPORT_FILE_NAME = 'sf-build-report.json' as const;

export interface StaticfluxViteOptions {
  /** Logical chunk declarations (`chunk(id, { entry, tier, budget, … })`). */
  readonly chunks: readonly ChunkDeclaration[];
  /** Per-profile boot plans (R12.10); need `profiles`. */
  readonly bootPlans?: readonly BootPlan[];
  /** App profiles to emit preloads for (`{ key: 'web:expanded', hostMode, formFactor }`). */
  readonly profiles?: readonly ProfileLike[];
  readonly budgets?: BudgetOptions;
  /** Default `off`. `required`/`preferred` serve COOP/COEP/CORP in dev and preview. */
  readonly isolation?: IsolationMode;
  /** Default `require-corp`. */
  readonly coep?: CoepMode;
  /** Default `same-origin`. */
  readonly corp?: CorpMode;
  /** Override the `crossorigin` value of injected tags. */
  readonly crossorigin?: 'anonymous' | 'use-credentials';
  /** SW precache list (critical tier + `tiers`); `false` disables it. */
  readonly precache?: false | { readonly fileName?: string; readonly tiers?: readonly WarmupTier[] };
  /** Default `sf-manifest.json`. */
  readonly manifestFileName?: string;
  /** Default `sf-preloads.json` (only emitted with boot plans). */
  readonly preloadsFileName?: string;
  /** Default `sf-build-report.json`; `false` disables it. */
  readonly reportFileName?: string | false;
  /** Preload injection into index.html; `profile` picks the boot plan (default: first profile). */
  readonly html?: false | { readonly profile?: string };
  /** Default: hash of the emitted file names. */
  readonly buildId?: string;
  /** Federated chunks served by remote containers (no local files). */
  readonly remotes?: Readonly<Record<string, ManifestRemote>>;
  /** Add `sha384` subresource integrity to the manifest and preload tags. */
  readonly sri?: boolean;
  /** Emit module-path declarations as named chunks (default true). */
  readonly emitEntryChunks?: boolean;
  /** Compressed size in KB (default gzip). */
  readonly sizeOf?: (fileName: string, code: string) => number;
}

/** Validate options (throws in `staticflux()` because Vite config errors are thrown). */
export function validateOptions(options: StaticfluxViteOptions): Result<void> {
  const bad = (message: string, details: Record<string, unknown> = {}): Result<void> => err(ViteOptionsError({ message, details }));
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
  const htmlProfile = options.html === false ? undefined : options.html?.profile;
  if (htmlProfile !== undefined && !profiles.some((p) => p.key === htmlProfile)) {
    return bad(`html.profile "${htmlProfile}" is not one of profiles (${profiles.map((p) => p.key).join(', ') || 'none'}).`, { profile: htmlProfile });
  }
  for (const id of Object.keys(options.remotes ?? {})) {
    if (!seen.has(id)) return bad(`Remote "${id}" has no chunk declaration; declare it with chunk('${id}', …).`, { chunk: id });
  }
  return ok();
}

export const gzipKb = (_fileName: string, code: string): number => Math.round((gzipSync(code).length / 1024) * 100) / 100;
export const sha384 = (_fileName: string, code: string): string => `sha384-${createHash('sha384').update(code).digest('base64')}`;

/**
 * Declarations as the build sees them: without `entry`, a declaration matches the chunk
 * named `chunkNameFor(id)` (e.g. a Rolldown `codeSplitting` group with that name).
 */
export function buildDeclarations(chunks: readonly ChunkDeclaration[]): readonly ChunkDeclaration[] {
  return chunks.map((d) => (d.entry === undefined ? { ...d, entry: chunkNameFor(d.id) } : d));
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

interface EmitContext {
  emitFile(file: { type: 'asset'; fileName: string; source: string }): string;
  warn(message: string): void;
  error(message: string): never;
}

interface MiddlewareRequest {
  readonly url?: string | undefined;
}
interface MiddlewareResponse {
  setHeader(name: string, value: string): unknown;
  statusCode: number;
  end(body?: string): unknown;
}
type Middleware = (req: MiddlewareRequest, res: MiddlewareResponse, next: () => void) => void;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function staticflux(options: StaticfluxViteOptions): Plugin {
  const valid = validateOptions(options);
  if (!valid.ok) throw valid.error;

  const isolation = options.isolation ?? 'off';
  const headers = isolationHeaders({ isolation, coep: options.coep ?? 'require-corp', corp: options.corp ?? 'same-origin' });
  const manifestFileName = options.manifestFileName ?? MANIFEST_FILE_NAME;
  const htmlProfile = options.html === false ? undefined : (options.html?.profile ?? options.profiles?.[0]?.key);
  const declarations = buildDeclarations(options.chunks);
  const sizeOf = options.sizeOf ?? gzipKb;

  let root = process.cwd();
  let base = '/';
  let command: 'build' | 'serve' = 'build';
  let logger: Logger = { info: () => undefined, warn: () => undefined };
  const memo = new WeakMap<object, Result<BuildArtifacts>>();

  const artifactsFor = (bundle: Readonly<Record<string, RollupLikeOutput>>): Result<BuildArtifacts> => {
    const cached = memo.get(bundle);
    if (cached !== undefined) return cached;
    const output = fromRollupBundle(bundle, { sizeOf, ...(options.sri === true ? { integrityOf: sha384 } : {}) });
    const result = computeArtifacts(output, {
      base,
      declarations,
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      ...(options.bootPlans === undefined ? {} : { bootPlans: options.bootPlans }),
      ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
      ...(options.remotes === undefined ? {} : { remotes: options.remotes }),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      precache: options.precache === false ? false : { ...(options.precache?.tiers === undefined ? {} : { tiers: options.precache.tiers }) },
    });
    memo.set(bundle, result);
    return result;
  };

  const headerMiddleware: Middleware = (_req, res, next) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    next();
  };

  const devManifestMiddleware: Middleware = (req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== `${base}${manifestFileName}`) return next();
    const built = createManifest({
      buildId: 'dev',
      base: '',
      declarations: options.chunks,
      output: devBundlerOutput(options.chunks.filter((d) => options.remotes?.[d.id] === undefined), root),
      ...(options.remotes === undefined ? {} : { remotes: options.remotes }),
    });
    res.setHeader('Content-Type', 'application/json');
    if (!built.ok) {
      logger.warn(`[${PLUGIN_NAME}] dev manifest: ${built.error.code}: ${built.error.message}`);
      res.statusCode = 500;
      res.end(json({ code: built.error.code, message: built.error.message, fix: built.error.fix }));
      return;
    }
    res.statusCode = 200;
    res.end(json(built.value.manifest));
  };

  function reportViolations(ctx: EmitContext, artifacts: BuildArtifacts): void {
    if (artifacts.violations.length === 0) return;
    const lines = artifacts.violations.map((v) => `  - ${v.message}`).join('\n');
    if ((options.budgets?.onViolation ?? 'warn') === 'error') {
      const error: SfError = ViteBudgetExceededError({ message: `${ViteBudgetExceededError.code}: budget exceeded:\n${lines}`, details: { violations: artifacts.violations } });
      ctx.error(`${error.message}\n  fix: ${error.fix ?? ''}`);
    }
    for (const v of artifacts.violations) ctx.warn(`${ViteBudgetExceededError.code}: ${v.message}`);
  }

  function generateBundle(this: EmitContext, _output: unknown, bundle: Readonly<Record<string, RollupLikeOutput>>): void {
    const result = artifactsFor(bundle);
    if (!result.ok) {
      this.error(`${result.error.code}: ${result.error.message}\n  fix: ${result.error.fix ?? ''}`);
    }
    const artifacts = result.value;
    this.emitFile({ type: 'asset', fileName: manifestFileName, source: json(artifacts.manifest) });
    if (artifacts.preloads !== undefined) {
      this.emitFile({ type: 'asset', fileName: options.preloadsFileName ?? PRELOADS_FILE_NAME, source: json(artifacts.preloads) });
    }
    if (artifacts.precache !== undefined && options.precache !== false) {
      this.emitFile({ type: 'asset', fileName: options.precache?.fileName ?? PRECACHE_FILE_NAME, source: json(artifacts.precache) });
    }
    if (options.reportFileName !== false) {
      this.emitFile({ type: 'asset', fileName: options.reportFileName ?? REPORT_FILE_NAME, source: json(buildReportJson(artifacts)) });
    }
    const boot = artifacts.boot.map((b) => `${b.profile} ${b.bootKb} KB (eager ${b.eagerKb} KB)`).join(', ');
    logger.info(`[${PLUGIN_NAME}] ${Object.keys(artifacts.manifest.chunks).length} logical chunks → ${manifestFileName}; boot: ${boot}`);
    reportViolations(this, artifacts);
  }

  function transformIndexHtml(html: string, ctx: IndexHtmlTransformContext): HtmlTagDescriptor[] | undefined {
    if (options.html === false || ctx.bundle === undefined) return undefined;
    const result = artifactsFor(ctx.bundle as unknown as Readonly<Record<string, RollupLikeOutput>>);
    // Errors are reported by generateBundle (same memoized result); the HTML stays untouched.
    if (!result.ok) return undefined;
    const { manifest } = result.value;
    const integrity = new Map<string, string>();
    for (const c of Object.values(manifest.chunks)) {
      for (const [file, hash] of Object.entries(c.integrity ?? {})) integrity.set(fileUrl(manifest, file), hash);
    }
    const preloads = htmlPreloadsFor(result.value, htmlProfile);
    return preloadTags({
      modulepreload: preloads.modulepreload,
      stylesheets: preloads.stylesheets,
      crossorigin: crossOriginFor(isolation, options.crossorigin),
      integrity,
      html,
    }).map((t) => ({ tag: t.tag, attrs: { ...t.attrs }, injectTo: t.injectTo }));
  }

  return {
    name: PLUGIN_NAME,
    configResolved(config: ResolvedConfig) {
      root = config.root;
      base = config.base;
      command = config.command;
      logger = config.logger;
    },
    resolveId(id: string) {
      return id === VIRTUAL_CHUNKS_ID ? RESOLVED_VIRTUAL_CHUNKS_ID : undefined;
    },
    load(id: string) {
      return id === RESOLVED_VIRTUAL_CHUNKS_ID ? renderChunksModule(moduleEntries(options.chunks, root)) : undefined;
    },
    buildStart(this: { emitFile(file: { type: 'chunk'; id: string; name: string; preserveSignature: 'allow-extension' }): string }) {
      if (command !== 'build' || options.emitEntryChunks === false) return;
      for (const e of moduleEntries(options.chunks, root)) {
        if (options.remotes?.[e.id] !== undefined) continue;
        this.emitFile({ type: 'chunk', id: e.file, name: e.name, preserveSignature: 'allow-extension' });
      }
    },
    generateBundle,
    transformIndexHtml: { order: 'post', handler: transformIndexHtml },
    configureServer(server: ViteDevServer) {
      if (Object.keys(headers).length > 0) server.middlewares.use(headerMiddleware as never);
      server.middlewares.use(devManifestMiddleware as never);
    },
    configurePreviewServer(server: PreviewServer) {
      if (Object.keys(headers).length > 0) server.middlewares.use(headerMiddleware as never);
    },
  };
}
