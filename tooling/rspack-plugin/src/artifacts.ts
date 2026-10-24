/**
 * Pure build step shared by every hook: bundler output → sf-manifest, per-profile preloads,
 * SW precache list, boot costs and budget violations. No bundler types, no filesystem. (Mirrors @staticflux/vite-plugin `artifacts.ts`; tooling packages do not depend on each other.)
 */
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@staticflux/core';
import {
  type BootPlan,
  type BuildReport,
  type BundlerChunk,
  type BundlerOutput,
  type ChunkDeclaration,
  type ChunkIdShape,
  createManifest,
  eagerReport,
  emitProfilePreloads,
  fileUrl,
  type ManifestRemote,
  type PrecacheEntry,
  precacheList,
  type ProfileLike,
  type ProfilePreloads,
  selectBootPlan,
  type SfManifest,
  urlsFor,
  type WarmupTier,
} from '@staticflux/loader';
import { RspackBootPlanError, RspackManifestBuildError } from './errors.js';

/** Boot-cost subject when no profiles are configured (one boot set for every profile). */
export const ALL_PROFILES = '*' as const;

export interface BudgetOptions {
  /** `warn` (default) logs violations; `error` fails the build. */
  readonly onViolation?: 'warn' | 'error';
  /** Max gzip KB of JS fetched at boot per profile (plan closure; R12.7 total boot JS ≤ 150 KB). */
  readonly bootKb?: number;
  /** Max eager boot cost per profile (R12.12). */
  readonly eagerKb?: number;
}

export interface PrecacheOptions {
  /** Tiers precached in addition to `critical`. */
  readonly tiers?: readonly WarmupTier[];
}

export interface ArtifactOptions {
  readonly base: string;
  readonly declarations: readonly ChunkDeclaration[];
  /** Default: a content hash of the emitted file names. */
  readonly buildId?: string;
  readonly bootPlans?: readonly BootPlan[];
  readonly profiles?: readonly ProfileLike[];
  readonly remotes?: Readonly<Record<string, ManifestRemote>>;
  readonly budgets?: BudgetOptions;
  /** `false` disables the global precache list. */
  readonly precache?: PrecacheOptions | false;
  /**
   * Output file names of the app's entry chunks (e.g. the `index.html` script). Their
   * static import closure is always part of the boot set (it is fetched before anything
   * else), and is the default boot set when no plans / critical / eager chunks exist.
   */
  readonly entries?: readonly string[];
  /**
   * Source modules that load at boot without being static imports of the entry — e.g.
   * `src/boot-browser.ts`, `import()`ed right after the inline mode detector (R12.9).
   * Their chunk's static closure joins every profile's boot set.
   */
  readonly bootEntries?: readonly string[];
}

export type ViolationKind = 'chunk' | 'eager' | 'boot';

export interface BudgetViolation {
  readonly kind: ViolationKind;
  /** Chunk id (`chunk`) or profile key (`eager`, `boot`). */
  readonly subject: string;
  readonly actualKb: number;
  readonly budgetKb: number;
  readonly message: string;
}

export interface ProfileBootCost {
  readonly profile: string;
  readonly plan: string | undefined;
  /** Gzip KB of every JS file in the boot set (deduplicated). */
  readonly bootKb: number;
  readonly eagerKb: number;
}

/** Size of a budgeted chunk against the boot set it loads after (R12.7). */
export interface ChunkCost {
  readonly chunk: string;
  /** Gzip KB of the chunk and its whole static import closure. */
  readonly sizeKb: number;
  /**
   * Gzip KB actually added on top of the boot set (worst case over the profiles the chunk
   * serves): closure files already in the boot set are not counted. Equals `sizeKb` for
   * chunks that are themselves part of the boot set. Budgets apply to this value.
   */
  readonly incrementalKb: number;
  readonly budgetKb: number | undefined;
}

export interface BuildArtifacts {
  readonly manifest: SfManifest;
  /** `overBudget` is measured on `incrementalKb` (see `chunkCosts`). */
  readonly report: BuildReport;
  readonly chunkCosts: readonly ChunkCost[];
  /** Per-profile preloads (only with `bootPlans` + `profiles`). */
  readonly preloads: Readonly<Record<string, ProfilePreloads>> | undefined;
  readonly precache: readonly PrecacheEntry[] | undefined;
  readonly boot: readonly ProfileBootCost[];
  readonly violations: readonly BudgetViolation[];
  /** Default boot set (critical + eager closure) used when no profile is selected. */
  readonly defaultBoot: { readonly modulepreload: readonly string[]; readonly stylesheets: readonly string[] };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Deterministic build id from the output file names (hashed names change with content). */
export function defaultBuildId(output: BundlerOutput): string {
  const names = output.chunks.map((c) => c.fileName).sort();
  return createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 12);
}

function defaultBootIds(manifest: SfManifest): ChunkIdShape[] {
  return Object.values(manifest.chunks)
    .filter((c) => c.tier === 'critical' || c.load === 'eager')
    .map((c) => c.id);
}

/** Module path match, same rules as the loader's manifest builder (suffix of the facade module id). */
function matchesModule(entry: string, c: BundlerChunk): boolean {
  if (c.name === entry) return true;
  if (c.moduleId === undefined) return false;
  const normalized = c.moduleId.replace(/\\/g, '/');
  const wanted = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === wanted || normalized.endsWith(`/${wanted}`);
}

/** Static import closure (output file names) of `roots`. */
function staticClosure(output: BundlerOutput, roots: readonly string[]): string[] {
  const byFile = new Map(output.chunks.map((c) => [c.fileName, c]));
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    const found = byFile.get(next);
    if (found === undefined) continue;
    seen.add(next);
    queue.push(...found.imports);
  }
  return [...seen];
}

/** Gzip KB of the JS URLs in `urls` (files without a measured size count 0). */
function sizeOfUrls(urls: readonly string[], sizes: ReadonlyMap<string, number>): number {
  return round(urls.reduce((sum, url) => sum + (sizes.get(url) ?? 0), 0));
}

export function computeArtifacts(output: BundlerOutput, options: ArtifactOptions): Result<BuildArtifacts> {
  const built = createManifest({
    buildId: options.buildId ?? defaultBuildId(output),
    base: options.base,
    declarations: options.declarations,
    output,
    ...(options.remotes === undefined ? {} : { remotes: options.remotes }),
  });
  if (!built.ok) {
    return err(RspackManifestBuildError({ message: `${built.error.code}: ${built.error.message}`, cause: built.error, details: built.error.details }));
  }
  const { manifest, report } = built.value;
  const sizes = new Map<string, number>();
  for (const c of output.chunks) if (c.sizeKb !== undefined) sizes.set(fileUrl(manifest, c.fileName), c.sizeKb);

  const defaultUrls = urlsFor(manifest, defaultBootIds(manifest));
  if (!defaultUrls.ok) return err(RspackManifestBuildError({ message: defaultUrls.error.message, cause: defaultUrls.error }));
  const defaultBoot = { modulepreload: defaultUrls.value.modules, stylesheets: defaultUrls.value.stylesheets };

  // Always fetched at boot: the entry chunks' static closure + declared boot modules' closure.
  const bootRoots = [
    ...(options.entries ?? []),
    ...(options.bootEntries ?? []).flatMap((entry) => output.chunks.filter((c) => matchesModule(entry, c)).map((c) => c.fileName)),
  ];
  const alwaysBoot = staticClosure(output, bootRoots).map((file) => fileUrl(manifest, file));
  const bootSetOf = (modulepreload: readonly string[]): string[] => [...new Set([...alwaysBoot, ...modulepreload])];
  /** Boot set (JS URLs) per profile key, for chunk costs. */
  const bootSets = new Map<string, ReadonlySet<string>>();

  let preloads: Readonly<Record<string, ProfilePreloads>> | undefined;
  const boot: ProfileBootCost[] = [];
  const plans = options.bootPlans ?? [];
  const profiles = options.profiles ?? [];
  if (plans.length > 0 && profiles.length > 0) {
    const emitted = emitProfilePreloads(manifest, plans, profiles);
    if (!emitted.ok) return err(RspackBootPlanError({ message: `${emitted.error.code}: ${emitted.error.message}`, cause: emitted.error, details: emitted.error.details }));
    preloads = emitted.value;
    for (const profile of profiles) {
      const plan = selectBootPlan(plans, profile);
      const entry = emitted.value[profile.key];
      if (!plan.ok || entry === undefined) continue;
      const set = bootSetOf(entry.modulepreload);
      bootSets.set(profile.key, new Set(set));
      boot.push({
        profile: profile.key,
        plan: plan.value.id,
        bootKb: sizeOfUrls(set, sizes),
        eagerKb: eagerReport(manifest, plan.value, profile.key).totalKb,
      });
    }
  } else {
    const set = bootSetOf(defaultBoot.modulepreload);
    bootSets.set(ALL_PROFILES, new Set(set));
    boot.push({ profile: ALL_PROFILES, plan: undefined, bootKb: sizeOfUrls(set, sizes), eagerKb: report.eagerTotalKb });
  }

  // Chunk budgets count only what a chunk adds on top of the boot set of the profiles it serves.
  const chunkCosts: ChunkCost[] = [];
  for (const c of Object.values(manifest.chunks)) {
    if (c.remote !== undefined || c.sizeKb === undefined) continue;
    const urls = c.files.map((file) => fileUrl(manifest, file));
    const own = urls[0];
    const applicable = [...bootSets].filter(([key]) => key === ALL_PROFILES || c.profiles === undefined || c.profiles.includes(key)).map(([, set]) => set);
    const sets = applicable.length > 0 ? applicable : [...bootSets.values()];
    let incrementalKb = sets.length === 0 ? c.sizeKb : 0;
    for (const set of sets) {
      // A chunk that is itself part of the boot set is boot code: its whole closure counts.
      const added = own !== undefined && set.has(own) ? c.sizeKb : sizeOfUrls(urls.filter((url) => !set.has(url)), sizes);
      incrementalKb = Math.max(incrementalKb, added);
    }
    chunkCosts.push({ chunk: c.id, sizeKb: c.sizeKb, incrementalKb: round(incrementalKb), budgetKb: c.budgetKb });
  }
  const overBudget = chunkCosts.flatMap((c) =>
    c.budgetKb !== undefined && c.incrementalKb > c.budgetKb ? [{ chunk: c.chunk as ChunkIdShape, sizeKb: c.incrementalKb, budgetKb: c.budgetKb }] : [],
  );

  const violations: BudgetViolation[] = overBudget.map((o) => ({
    kind: 'chunk' as const,
    subject: o.chunk,
    actualKb: o.sizeKb,
    budgetKb: o.budgetKb,
    message: `Chunk "${o.chunk}" is ${o.sizeKb} KB gzip, budget ${o.budgetKb} KB.`,
  }));
  const budgets = options.budgets ?? {};
  for (const b of boot) {
    if (budgets.bootKb !== undefined && b.bootKb > budgets.bootKb) {
      violations.push({ kind: 'boot', subject: b.profile, actualKb: b.bootKb, budgetKb: budgets.bootKb, message: `Boot JS for profile "${b.profile}" is ${b.bootKb} KB gzip, budget ${budgets.bootKb} KB.` });
    }
    if (budgets.eagerKb !== undefined && b.eagerKb > budgets.eagerKb) {
      violations.push({ kind: 'eager', subject: b.profile, actualKb: b.eagerKb, budgetKb: budgets.eagerKb, message: `Eager boot cost for profile "${b.profile}" is ${b.eagerKb} KB gzip, budget ${budgets.eagerKb} KB.` });
    }
  }

  const precache = options.precache === false ? undefined : precacheList(manifest, { ...(options.precache?.tiers === undefined ? {} : { tiers: options.precache.tiers }) });
  return ok({ manifest, report: { ...report, overBudget }, chunkCosts, preloads, precache, boot, violations, defaultBoot });
}

/** Machine-readable build report (`sf-build-report.json`), consumed by CI and `sf manifest`. */
export function buildReportJson(artifacts: BuildArtifacts): unknown {
  return {
    format: 'sf-build-report/1',
    buildId: artifacts.manifest.buildId,
    overBudget: artifacts.report.overBudget,
    chunks: artifacts.chunkCosts,
    eager: artifacts.report.eager,
    eagerTotalKb: artifacts.report.eagerTotalKb,
    boot: artifacts.boot,
    violations: artifacts.violations,
  };
}

/** Boot preload set for the HTML: the profile's plan, or the default boot set. */
export function htmlPreloadsFor(
  artifacts: BuildArtifacts,
  profile: string | undefined,
): { readonly modulepreload: readonly string[]; readonly stylesheets: readonly string[] } {
  if (profile !== undefined && artifacts.preloads !== undefined) {
    const entry = artifacts.preloads[profile];
    if (entry !== undefined) return entry;
  }
  return artifacts.defaultBoot;
}
