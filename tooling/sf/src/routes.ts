/**
 * `sf routes <entry>` — build-time completeness of capability-bound routes (R18.7, R18.5).
 *
 * The entry module exports (structural shapes of `@staticflux/router` / `@staticflux/runtime`
 * values; sf does not depend on those packages):
 * - `routes` — `defineRoute(...)` results (array or record). A route with `feature:
 *   bindCapability(capability, candidates)` needs, for every profile, a candidate whose modes
 *   (candidate `modes` ?? feature manifest `modes`; none = all modes) share a mode with the profile.
 * - `features` — `defineFeature(...)` manifests (array or record), for `modes` and existence.
 * - `profiles` — `'web:expanded'` strings, `{ key, hostMode, formFactor }` (platform `AppProfile`)
 *   or `{ key, modes }`; or `hostModes` × `formFactors` arrays (cartesian product).
 * A profile's active modes are `[hostMode, formFactor]` — the router's `modesPredicate` contract.
 */
import { err, ok, type Result } from '@staticflux/core';
import { InvalidRoutesModule } from './errors.js';
import { importModule, type ModuleImporter } from './files.js';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface RouteIssue {
  readonly severity: IssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly route?: string;
  readonly profile?: string;
  readonly feature?: string;
}

export interface CandidateLike {
  readonly feature: { readonly id: string };
  readonly modes?: readonly string[];
}

export interface RouteLike {
  readonly id: string;
  readonly path: string;
  readonly feature?: { readonly capability: string; readonly candidates: readonly CandidateLike[] } | undefined;
}

export interface FeatureLike {
  readonly id: string;
  readonly modes?: readonly string[] | undefined;
  readonly headless?: boolean | undefined;
}

export interface RouteProfile {
  readonly key: string;
  readonly modes: readonly string[];
}

export interface RoutesInput {
  readonly routes: readonly RouteLike[];
  readonly features: readonly FeatureLike[];
  readonly profiles: readonly RouteProfile[];
}

export interface RouteRow {
  readonly route: string;
  readonly path: string;
  readonly capability: string;
  /** Profile key → selected feature id, or `null` when no candidate serves the profile. */
  readonly selected: Readonly<Record<string, string | null>>;
}

export interface RoutesCheckResult {
  readonly rows: readonly RouteRow[];
  readonly profiles: readonly string[];
  readonly issues: readonly RouteIssue[];
  readonly errorCount: number;
  /** Routes without a capability binding (not checked). */
  readonly unbound: readonly string[];
}

export const ROUTE_ISSUES = {
  noFeature: 'SF-ROUTES-NO-FEATURE',
  unknownFeature: 'SF-ROUTES-UNKNOWN-FEATURE',
  noCandidates: 'SF-ROUTES-NO-CANDIDATES',
  shadowed: 'SF-ROUTES-SHADOWED-CANDIDATE',
  unrouted: 'SF-ROUTES-UNROUTED-FEATURE',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

function listOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  return undefined;
}

function readProfile(value: unknown, index: number, label: string): Result<RouteProfile> {
  if (typeof value === 'string') {
    const [hostMode, formFactor] = value.split(':');
    if (hostMode === undefined || hostMode === '' || formFactor === undefined || formFactor === '') {
      return err(InvalidRoutesModule({ message: `${label}: profiles[${index}] "${value}" is not "<hostMode>:<formFactor>".` }));
    }
    return ok({ key: value, modes: [hostMode, formFactor] });
  }
  if (isRecord(value)) {
    if (isStringArray(value['modes'])) {
      const key = typeof value['key'] === 'string' ? value['key'] : value['modes'].join(':');
      return ok({ key, modes: value['modes'] });
    }
    if (typeof value['hostMode'] === 'string' && typeof value['formFactor'] === 'string') {
      const key = typeof value['key'] === 'string' ? value['key'] : `${value['hostMode']}:${value['formFactor']}`;
      return ok({ key, modes: [value['hostMode'], value['formFactor']] });
    }
  }
  return err(InvalidRoutesModule({ message: `${label}: profiles[${index}] must be "host:form", { key, hostMode, formFactor } or { key, modes }.` }));
}

/** Validate a loaded module's exports into routes, features and profiles. */
export function readRoutesExports(exports: Record<string, unknown>, label: string): Result<RoutesInput> {
  const found = Object.keys(exports).join(', ') || 'none';
  const rawRoutes = listOf(exports['routes']);
  if (rawRoutes === undefined) return err(InvalidRoutesModule({ message: `${label} exports no \`routes\` (found exports: ${found}).` }));
  const routes: RouteLike[] = [];
  for (const [index, r] of rawRoutes.entries()) {
    if (!isRecord(r) || typeof r['id'] !== 'string' || typeof r['path'] !== 'string') {
      return err(InvalidRoutesModule({ message: `${label}: routes[${index}] is not a route (needs id and path; use defineRoute).` }));
    }
    const selector = r['feature'];
    if (selector !== undefined) {
      if (!isRecord(selector) || typeof selector['capability'] !== 'string' || !Array.isArray(selector['candidates'])) {
        return err(InvalidRoutesModule({ message: `${label}: route "${r['id']}" has a \`feature\` that is not a capability binding (use bindCapability).` }));
      }
      for (const [ci, c] of (selector['candidates'] as unknown[]).entries()) {
        const valid = isRecord(c) && isRecord(c['feature']) && typeof c['feature']['id'] === 'string' && (c['modes'] === undefined || isStringArray(c['modes']));
        if (!valid) return err(InvalidRoutesModule({ message: `${label}: route "${r['id']}" candidates[${ci}] needs { feature: featureRef(id), modes? }.` }));
      }
    }
    routes.push(r as unknown as RouteLike);
  }

  const rawFeatures = listOf(exports['features']);
  if (rawFeatures === undefined) return err(InvalidRoutesModule({ message: `${label} exports no \`features\` (found exports: ${found}).` }));
  const features: FeatureLike[] = [];
  for (const [index, f] of rawFeatures.entries()) {
    if (!isRecord(f) || typeof f['id'] !== 'string' || (f['modes'] !== undefined && !isStringArray(f['modes']))) {
      return err(InvalidRoutesModule({ message: `${label}: features[${index}] is not a feature manifest (needs id and optional string[] modes; use defineFeature).` }));
    }
    features.push(f as unknown as FeatureLike);
  }

  const profiles: RouteProfile[] = [];
  const rawProfiles = exports['profiles'];
  if (rawProfiles !== undefined) {
    if (!Array.isArray(rawProfiles)) return err(InvalidRoutesModule({ message: `${label}: \`profiles\` must be an array.` }));
    for (const [index, p] of rawProfiles.entries()) {
      const profile = readProfile(p, index, label);
      if (!profile.ok) return err(profile.error);
      profiles.push(profile.value);
    }
  } else if (isStringArray(exports['hostModes']) && isStringArray(exports['formFactors'])) {
    for (const host of exports['hostModes']) for (const form of exports['formFactors']) profiles.push({ key: `${host}:${form}`, modes: [host, form] });
  }
  if (profiles.length === 0) {
    return err(InvalidRoutesModule({ message: `${label} declares no profiles: export \`profiles\` or \`hostModes\` + \`formFactors\`.` }));
  }
  return ok({ routes, features, profiles });
}

export async function loadRoutesModule(path: string, cwd: string, importer?: ModuleImporter): Promise<Result<RoutesInput>> {
  const loaded = await importModule(path, cwd, importer);
  if (!loaded.ok) return loaded;
  return readRoutesExports(loaded.value, path);
}

const severityRank: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Run the completeness check. Pure. */
export function checkRoutes(input: RoutesInput): RoutesCheckResult {
  const features = new Map(input.features.map((f) => [f.id, f]));
  const issues: RouteIssue[] = [];
  const rows: RouteRow[] = [];
  const unbound: string[] = [];
  const routed = new Set<string>();
  const profileKeys = input.profiles.map((p) => p.key);

  for (const route of input.routes) {
    const selector = route.feature;
    if (selector === undefined) {
      unbound.push(route.id);
      continue;
    }
    if (selector.candidates.length === 0) {
      issues.push({ severity: 'error', code: ROUTE_ISSUES.noCandidates, route: route.id, message: `Route "${route.id}" binds capability "${selector.capability}" with no candidate features.` });
    }
    for (const c of selector.candidates) {
      routed.add(c.feature.id);
      if (!features.has(c.feature.id)) {
        issues.push({
          severity: 'error',
          code: ROUTE_ISSUES.unknownFeature,
          route: route.id,
          feature: c.feature.id,
          message: `Route "${route.id}" (capability "${selector.capability}") lists feature "${c.feature.id}", which no feature manifest declares.`,
        });
      }
    }
    const used = new Set<string>();
    const selected: Record<string, string | null> = {};
    for (const profile of input.profiles) {
      const winner = selector.candidates.find((c) => {
        const modes = c.modes ?? features.get(c.feature.id)?.modes;
        return modes === undefined || modes.length === 0 || modes.some((m) => profile.modes.includes(m));
      });
      selected[profile.key] = winner?.feature.id ?? null;
      if (winner !== undefined) used.add(winner.feature.id);
      else if (selector.candidates.length > 0) {
        issues.push({
          severity: 'error',
          code: ROUTE_ISSUES.noFeature,
          route: route.id,
          profile: profile.key,
          message: `Route "${route.id}" (${route.path}, capability "${selector.capability}") has no feature for profile "${profile.key}" (modes ${profile.modes.join(', ')}); candidates: ${selector.candidates.map((c) => `${c.feature.id} [${(c.modes ?? features.get(c.feature.id)?.modes ?? ['all']).join(', ')}]`).join(', ')}.`,
        });
      }
    }
    for (const c of selector.candidates) {
      if (!used.has(c.feature.id) && features.has(c.feature.id)) {
        issues.push({
          severity: 'warning',
          code: ROUTE_ISSUES.shadowed,
          route: route.id,
          feature: c.feature.id,
          message: `Candidate "${c.feature.id}" of route "${route.id}" is never selected for any profile (an earlier candidate always wins, or its modes match no profile).`,
        });
      }
    }
    rows.push({ route: route.id, path: route.path, capability: selector.capability, selected });
  }

  for (const f of input.features) {
    if (routed.has(f.id) || f.headless === true) continue;
    issues.push({ severity: 'info', code: ROUTE_ISSUES.unrouted, feature: f.id, message: `Feature "${f.id}" is not a candidate of any route (fine for features mounted by slots/surfaces).` });
  }

  issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return { rows, profiles: profileKeys, issues, errorCount: issues.filter((i) => i.severity === 'error').length, unbound };
}

const pad = (text: string, width: number): string => text.padEnd(width);

export function formatRoutesText(result: RoutesCheckResult): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of result.issues) counts[issue.severity] += 1;
  const lines = [
    `Routes: ${result.rows.length} bound, ${result.unbound.length} without capability · profiles: ${result.profiles.length} · errors: ${counts.error} · warnings: ${counts.warning} · info: ${counts.info}`,
  ];
  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = result.issues.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    lines.push('', `${severity === 'error' ? 'ERRORS' : severity === 'warning' ? 'WARNINGS' : 'INFO'} (${group.length})`);
    for (const issue of group) lines.push(`  ${issue.code}  ${issue.message}`);
  }
  if (result.rows.length > 0) {
    const routeWidth = Math.max(5, ...result.rows.map((r) => r.route.length));
    const widths = result.profiles.map((p) => Math.max(p.length, ...result.rows.map((r) => (r.selected[p] ?? 'MISSING').length)));
    lines.push('', 'Route × profile → feature');
    lines.push(`  ${pad('route', routeWidth)}  ${result.profiles.map((p, i) => pad(p, widths[i] ?? p.length)).join('  ')}`.trimEnd());
    for (const row of result.rows) {
      lines.push(`  ${pad(row.route, routeWidth)}  ${result.profiles.map((p, i) => pad(row.selected[p] ?? 'MISSING', widths[i] ?? 0)).join('  ')}`.trimEnd());
    }
  }
  return lines.join('\n');
}

export function formatRoutesJson(result: RoutesCheckResult): string {
  return JSON.stringify(result, null, 2);
}
