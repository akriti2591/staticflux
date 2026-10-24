/**
 * Build plugin helper (bundler-agnostic, pure). Given the chunk declarations and the
 * bundler's output metadata (entry → files), produce `sf-manifest.json` plus a build
 * report (budget overruns, eager boot cost). See AGENTS.md for Vite/Rollup wiring:
 *
 * @example
 * // vite.config.ts / rollup.config.ts
 * import { gzipSync } from 'node:zlib';
 * import { createManifest, fromRollupBundle, MANIFEST_FILE_NAME } from '@staticflux/loader';
 * const sfManifest = (declarations) => ({
 *   name: 'staticflux-manifest',
 *   generateBundle(_options, bundle) {
 *     const built = createManifest({
 *       buildId: process.env.GIT_SHA ?? 'dev', base: '/assets/', declarations,
 *       output: fromRollupBundle(bundle, { sizeOf: (_file, code) => gzipSync(code).length / 1024 }),
 *     });
 *     if (!built.ok) return this.error(`${built.error.code}: ${built.error.message}`);
 *     for (const o of built.value.report.overBudget) this.warn(`${o.chunk} ${o.sizeKb} KB > ${o.budgetKb} KB`);
 *     this.emitFile({ type: 'asset', fileName: MANIFEST_FILE_NAME, source: JSON.stringify(built.value.manifest) });
 *   },
 * });
 */
import { err, ok, type Result } from '@staticflux/core';
import { budgetKbOf, type ChunkDeclaration, type ChunkIdShape } from './chunk.js';
import { EagerWithoutReasonError, ManifestBuildError } from './errors.js';
import { MANIFEST_FORMAT, type ManifestChunk, type ManifestRemote, type SfManifest } from './manifest.js';

/** One emitted JS chunk as reported by any bundler. */
export interface BundlerChunk {
  /** Output file name relative to the output dir (hashed). */
  readonly fileName: string;
  /** Bundler chunk name (e.g. Rollup `name`). */
  readonly name?: string;
  /** Source module that is this chunk's entry/facade (absolute or project-relative path). */
  readonly moduleId?: string;
  /** Output file names this chunk imports statically. */
  readonly imports: readonly string[];
  /** CSS files this chunk imports. */
  readonly css?: readonly string[];
  /** Compressed size in KB (gzip), when measured. */
  readonly sizeKb?: number;
  readonly integrity?: string;
}

export interface BundlerOutput {
  readonly chunks: readonly BundlerChunk[];
}

export interface CreateManifestOptions {
  readonly buildId: string;
  /** URL prefix of emitted files, e.g. `/assets/`. */
  readonly base: string;
  readonly declarations: readonly ChunkDeclaration[];
  readonly output: BundlerOutput;
  /** Federated chunks served by remote containers (no local files). */
  readonly remotes?: Readonly<Record<string, ManifestRemote>>;
}

export interface BudgetOverrun {
  readonly chunk: ChunkIdShape;
  readonly sizeKb: number;
  readonly budgetKb: number;
}

export interface EagerEntry {
  readonly chunk: ChunkIdShape;
  readonly reason: string;
  readonly sizeKb: number | undefined;
  readonly profiles: readonly string[] | undefined;
}

export interface BuildReport {
  readonly overBudget: readonly BudgetOverrun[];
  /** Eager chunks and their boot cost (R12.12). */
  readonly eager: readonly EagerEntry[];
  readonly eagerTotalKb: number;
}

function matches(entry: string, c: BundlerChunk): boolean {
  if (c.name === entry) return true;
  if (c.moduleId === undefined) return false;
  const normalized = c.moduleId.replace(/\\/g, '/');
  const wanted = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === wanted || normalized.endsWith(`/${wanted}`);
}

/** Produce the manifest from declarations + bundler output. Pure; never touches the filesystem. */
export function createManifest(options: CreateManifestOptions): Result<{ manifest: SfManifest; report: BuildReport }> {
  const byFile = new Map(options.output.chunks.map((c) => [c.fileName, c]));
  const declared = new Set(options.declarations.map((d) => d.id));
  const chunks: Record<string, ManifestChunk> = {};
  const overBudget: BudgetOverrun[] = [];
  const eager: EagerEntry[] = [];

  for (const d of options.declarations) {
    if (d.load === 'eager' && (typeof d.reason !== 'string' || d.reason.trim() === '')) {
      return err(EagerWithoutReasonError({ details: { chunk: d.id } }));
    }
    for (const dep of d.deps ?? []) {
      if (!declared.has(dep)) {
        return err(ManifestBuildError({ message: `Chunk "${d.id}" depends on undeclared chunk "${dep}".`, details: { chunk: d.id, dep } }));
      }
    }
    const remote = options.remotes?.[d.id];
    let files: string[];
    let css: string[];
    let sizeKb: number | undefined;
    const integrity: Record<string, string> = {};
    if (remote !== undefined) {
      files = [remote.entry];
      css = [];
      sizeKb = undefined;
    } else {
      const entry = d.entry ?? d.id;
      const root = options.output.chunks.find((c) => matches(entry, c));
      if (root === undefined) {
        return err(ManifestBuildError({ message: `No bundler chunk matches entry "${entry}" of "${d.id}".`, details: { chunk: d.id, entry } }));
      }
      // Entry first, then its static import closure (breadth-first, deduplicated).
      const ordered: BundlerChunk[] = [];
      const seen = new Set<string>();
      const queue: BundlerChunk[] = [root];
      while (queue.length > 0) {
        const next = queue.shift() as BundlerChunk;
        if (seen.has(next.fileName)) continue;
        seen.add(next.fileName);
        ordered.push(next);
        for (const imported of next.imports) {
          const found = byFile.get(imported);
          if (found !== undefined) queue.push(found);
        }
      }
      files = ordered.map((c) => c.fileName);
      css = [...new Set(ordered.flatMap((c) => c.css ?? []))];
      sizeKb = ordered.every((c) => c.sizeKb !== undefined)
        ? Math.round(ordered.reduce((sum, c) => sum + (c.sizeKb ?? 0), 0) * 100) / 100
        : undefined;
      for (const c of ordered) if (c.integrity !== undefined) integrity[c.fileName] = c.integrity;
    }
    const budgetKb = budgetKbOf(d.budget);
    if (budgetKb !== undefined && sizeKb !== undefined && sizeKb > budgetKb) overBudget.push({ chunk: d.id, sizeKb, budgetKb });
    if (d.load === 'eager') {
      eager.push({ chunk: d.id, reason: d.reason, sizeKb, profiles: d.eagerProfiles ?? d.profiles });
    }
    chunks[d.id] = {
      id: d.id,
      files,
      css,
      deps: d.deps ?? [],
      tier: d.tier,
      load: d.load,
      ...(d.load === 'eager' ? { reason: d.reason } : {}),
      ...(d.load === 'eager' && d.eagerProfiles !== undefined ? { eagerProfiles: d.eagerProfiles } : {}),
      ...(sizeKb === undefined ? {} : { sizeKb }),
      ...(budgetKb === undefined ? {} : { budgetKb }),
      ...(d.profiles === undefined ? {} : { profiles: d.profiles }),
      ...(Object.keys(integrity).length > 0 ? { integrity } : {}),
      ...(remote === undefined ? {} : { remote }),
    };
  }
  const eagerTotalKb = Math.round(eager.reduce((sum, e) => sum + (e.sizeKb ?? 0), 0) * 100) / 100;
  return ok({
    manifest: { format: MANIFEST_FORMAT, buildId: options.buildId, base: options.base, chunks },
    report: { overBudget, eager, eagerTotalKb },
  });
}

/** Minimal shape of a Rollup/Vite `OutputBundle` entry. */
export interface RollupLikeOutput {
  readonly type: 'chunk' | 'asset';
  readonly fileName: string;
  readonly name?: string | undefined;
  readonly facadeModuleId?: string | null;
  readonly imports?: readonly string[];
  readonly code?: string;
  /** Vite adds this to chunks. */
  readonly viteMetadata?: { readonly importedCss?: ReadonlySet<string> | undefined };
}

export interface FromRollupOptions {
  /** Measure compressed size (e.g. `gzipSync(code).length / 1024`). */
  readonly sizeOf?: (fileName: string, code: string) => number;
  readonly integrityOf?: (fileName: string, code: string) => string;
}

/** Adapt a Rollup/Vite `generateBundle` bundle to `BundlerOutput`. */
export function fromRollupBundle(
  bundle: Readonly<Record<string, RollupLikeOutput>>,
  options: FromRollupOptions = {},
): BundlerOutput {
  const chunks: BundlerChunk[] = [];
  for (const out of Object.values(bundle)) {
    if (out.type !== 'chunk') continue;
    const code = out.code ?? '';
    const css = out.viteMetadata?.importedCss;
    chunks.push({
      fileName: out.fileName,
      imports: out.imports ?? [],
      ...(out.name === undefined ? {} : { name: out.name }),
      ...(out.facadeModuleId === undefined || out.facadeModuleId === null ? {} : { moduleId: out.facadeModuleId }),
      ...(css === undefined ? {} : { css: [...css] }),
      ...(options.sizeOf === undefined ? {} : { sizeKb: options.sizeOf(out.fileName, code) }),
      ...(options.integrityOf === undefined ? {} : { integrity: options.integrityOf(out.fileName, code) }),
    });
  }
  return { chunks };
}
