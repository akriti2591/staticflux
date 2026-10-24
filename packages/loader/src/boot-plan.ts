/**
 * Per-profile boot plans (R12.9–R12.12). A plan is data: for an app profile
 * (host mode × form factor) it lists critical chunks (block core-ready), eager chunks
 * (each with a mandatory reason, counted as boot cost), chunks to `modulepreload`,
 * plus the host bridge / history strategy / shell preset ids the runtime picks up.
 * The build emits per-profile preload lists; code for other modes is never fetched.
 */
import { err, ok, type Result, type Span, type Telemetry, createNoopTelemetry } from '@staticflux/core';
import type { ChunkIdShape } from './chunk.js';
import { EagerWithoutReasonError, NoBootPlanError } from './errors.js';
import type { ChunkLoader } from './loader.js';
import { type PrecacheEntry, precacheList, type SfManifest, servesProfile, urlsFor } from './manifest.js';
import { LOADER_SUBSYSTEMS, loaderMetrics } from './telemetry.js';

/** Structural app profile (matches `@staticflux/platform` `AppProfile`). */
export interface ProfileLike {
  /** `host:form`, e.g. `web:expanded`. */
  readonly key: string;
  readonly hostMode: string;
  readonly formFactor: string;
}

export interface BootPlanMatch {
  readonly hostModes?: readonly string[];
  readonly formFactors?: readonly string[];
}

export interface EagerLoad {
  readonly chunk: ChunkIdShape;
  /** Mandatory (R12.12). */
  readonly reason: string;
}

export interface BootPlan<Id extends string = string> {
  readonly kind: 'boot-plan';
  readonly id: Id;
  /** Omitted = fallback plan (matches every profile, lowest specificity). */
  readonly match?: BootPlanMatch;
  /** Chunks that must load before core-ready. */
  readonly critical: readonly ChunkIdShape[];
  /** Chunks loaded during boot without blocking core-ready; each costs boot budget. */
  readonly eager: readonly EagerLoad[];
  /** Chunks only `modulepreload`ed (fetched/compiled, not executed). */
  readonly preload: readonly ChunkIdShape[];
  readonly hostBridge?: ChunkIdShape;
  readonly historyStrategy?: string;
  readonly shellPreset?: string;
  readonly description?: string;
}

export function defineBootPlan<const Id extends string>(plan: {
  readonly id: Id;
  readonly match?: BootPlanMatch;
  readonly critical?: readonly ChunkIdShape[];
  readonly eager?: readonly EagerLoad[];
  readonly preload?: readonly ChunkIdShape[];
  readonly hostBridge?: ChunkIdShape;
  readonly historyStrategy?: string;
  readonly shellPreset?: string;
  readonly description?: string;
}): BootPlan<Id> {
  return Object.freeze({ critical: [], eager: [], preload: [], ...plan, kind: 'boot-plan' }) as BootPlan<Id>;
}

/** Runtime check for plans built from untyped config. */
export function validateBootPlan(plan: BootPlan): Result<void> {
  for (const e of plan.eager) {
    if (typeof e.reason !== 'string' || e.reason.trim() === '') {
      return err(EagerWithoutReasonError({ message: `Boot plan "${plan.id}": eager chunk "${e.chunk}" has no reason.`, details: { plan: plan.id, chunk: e.chunk } }));
    }
  }
  return ok();
}

export function planMatches(plan: BootPlan, profile: ProfileLike): boolean {
  const m = plan.match;
  if (m === undefined) return true;
  if (m.hostModes !== undefined && !m.hostModes.includes(profile.hostMode)) return false;
  if (m.formFactors !== undefined && !m.formFactors.includes(profile.formFactor)) return false;
  return true;
}

function specificity(plan: BootPlan): number {
  if (plan.match === undefined) return 0;
  return (plan.match.hostModes === undefined ? 0 : 1) + (plan.match.formFactors === undefined ? 0 : 1);
}

/** Most specific matching plan; ties go to declaration order. */
export function selectBootPlan<P extends BootPlan>(plans: readonly P[], profile: ProfileLike): Result<P> {
  let best: P | undefined;
  for (const plan of plans) {
    if (!planMatches(plan, profile)) continue;
    if (best === undefined || specificity(plan) > specificity(best)) best = plan;
  }
  if (best === undefined) {
    return err(NoBootPlanError({ message: `No boot plan matches profile "${profile.key}".`, details: { profile: profile.key, plans: plans.map((p) => p.id) } }));
  }
  return ok(best);
}

/** Every chunk a plan touches at boot (critical, eager, preload, host bridge). */
export function planChunks(plan: BootPlan): readonly ChunkIdShape[] {
  return [
    ...new Set([...plan.critical, ...plan.eager.map((e) => e.chunk), ...plan.preload, ...(plan.hostBridge === undefined ? [] : [plan.hostBridge])]),
  ];
}

export interface ProfilePreloads {
  readonly plan: string;
  /** `<link rel="modulepreload">` URLs for the boot HTML of this profile. */
  readonly modulepreload: readonly string[];
  readonly stylesheets: readonly string[];
  /** Service-worker precache list (critical tier + plan chunks) for this profile. */
  readonly precache: readonly PrecacheEntry[];
}

/**
 * Build-time: per-profile entry/preload manifests (R12.10). Chunks scoped to other
 * profiles are excluded, so other modes' code is never fetched.
 */
export function emitProfilePreloads(
  manifest: SfManifest,
  plans: readonly BootPlan[],
  profiles: readonly ProfileLike[],
): Result<Readonly<Record<string, ProfilePreloads>>> {
  const out: Record<string, ProfilePreloads> = {};
  for (const profile of profiles) {
    const plan = selectBootPlan(plans, profile);
    if (!plan.ok) return err(plan.error);
    const ids = planChunks(plan.value).filter((id) => {
      const c = manifest.chunks[id];
      return c === undefined || servesProfile(c, profile.key);
    });
    const urls = urlsFor(manifest, ids);
    if (!urls.ok) return err(urls.error);
    const precache = precacheList(manifest, { profile: profile.key });
    const known = new Set(precache.map((p) => p.url));
    const extra = [...urls.value.modules, ...urls.value.stylesheets]
      .filter((url) => !known.has(url))
      .map((url) => ({ url, revision: null }));
    out[profile.key] = {
      plan: plan.value.id,
      modulepreload: urls.value.modules,
      stylesheets: urls.value.stylesheets,
      precache: [...precache, ...extra],
    };
  }
  return ok(out);
}

export interface EagerReportEntry {
  readonly chunk: ChunkIdShape;
  readonly reason: string;
  readonly sizeKb: number | undefined;
  /** Declared on the chunk (`load: 'eager'`) or listed by the boot plan. */
  readonly source: 'declaration' | 'plan';
}

export interface EagerReport {
  readonly profile: string | undefined;
  readonly entries: readonly EagerReportEntry[];
  readonly totalKb: number;
}

/** Eager boot cost for a profile (R12.12): shown in the boot waterfall, checked against the boot budget. */
export function eagerReport(manifest: SfManifest, plan: BootPlan | undefined, profile?: string): EagerReport {
  const entries: EagerReportEntry[] = [];
  const seen = new Set<string>();
  for (const c of Object.values(manifest.chunks)) {
    if (c.load !== 'eager' || !servesProfile(c, profile)) continue;
    if (profile !== undefined && c.eagerProfiles !== undefined && !c.eagerProfiles.includes(profile)) continue;
    seen.add(c.id);
    entries.push({ chunk: c.id, reason: c.reason ?? '', sizeKb: c.sizeKb, source: 'declaration' });
  }
  for (const e of plan?.eager ?? []) {
    if (seen.has(e.chunk)) continue;
    seen.add(e.chunk);
    entries.push({ chunk: e.chunk, reason: e.reason, sizeKb: manifest.chunks[e.chunk]?.sizeKb, source: 'plan' });
  }
  const totalKb = Math.round(entries.reduce((sum, e) => sum + (e.sizeKb ?? 0), 0) * 100) / 100;
  return { profile, entries, totalKb };
}

export interface BootPlanRun {
  readonly plan: string;
  readonly critical: readonly ChunkIdShape[];
  readonly eager: readonly { readonly chunk: ChunkIdShape; readonly ok: boolean }[];
  readonly report: EagerReport;
}

export interface RunBootPlanOptions {
  readonly loader: ChunkLoader;
  readonly profile?: string;
  readonly telemetry?: Telemetry;
  readonly signal?: AbortSignal;
  /** Parent span (runtime `app.boot`). */
  readonly parent?: Span;
}

/**
 * Runtime: preload the plan's chunks, load critical ones (failure fails boot), then
 * eager ones (each a `boot.eager` span with its reason; failures are reported, not fatal).
 */
export async function runBootPlan(plan: BootPlan, options: RunBootPlanOptions): Promise<Result<BootPlanRun>> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const signal = options.signal ?? new AbortController().signal;
  const valid = validateBootPlan(plan);
  if (!valid.ok) return valid;
  const span = telemetry.span('boot.plan', {
    subsystem: LOADER_SUBSYSTEMS.boot,
    level: 'critical',
    parent: options.parent,
    attrs: { plan: plan.id, profile: options.profile ?? '' },
  });
  for (const id of [...plan.preload, ...(plan.hostBridge === undefined ? [] : [plan.hostBridge])]) {
    const pre = options.loader.preload(id, { origin: 'boot' });
    if (!pre.ok) span.event('boot.preload-skipped', { chunk: id, code: pre.error.code });
  }
  const critical = await Promise.all(plan.critical.map((id) => options.loader.load(id, { signal, origin: 'boot', parent: span })));
  const failed = critical.find((r) => !r.ok);
  if (failed !== undefined && !failed.ok) {
    span.end('error', failed.error);
    return err(failed.error);
  }
  const report = eagerReport(options.loader.manifest, plan, options.profile);
  const eager = await Promise.all(
    report.entries.map(async (entry) => {
      const child = telemetry.span('boot.eager', {
        subsystem: LOADER_SUBSYSTEMS.boot,
        level: 'critical',
        parent: span,
        attrs: { chunk: entry.chunk, reason: entry.reason, sizeKb: entry.sizeKb ?? null, source: entry.source },
      });
      telemetry.record(loaderMetrics.eagerBootCost, entry.sizeKb ?? 0, { chunk: entry.chunk, reason: entry.reason, profile: options.profile ?? '' }, child);
      const loaded = await options.loader.load(entry.chunk, { signal, origin: 'boot', parent: child });
      child.end(loaded.ok ? 'ok' : 'error', loaded.ok ? undefined : loaded.error);
      return { chunk: entry.chunk, ok: loaded.ok };
    }),
  );
  span.set('eagerKb', report.totalKb);
  span.end('ok');
  return ok({ plan: plan.id, critical: plan.critical, eager, report });
}
