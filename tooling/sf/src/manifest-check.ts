/**
 * `sf manifest <file>` — validate an `sf-manifest.json` (format `sf-manifest/1`, written by
 * `@staticflux/loader` `createManifest` via the Vite/Rspack plugins): schema, dangling and
 * cyclic deps, budget overruns, eager boot cost. Unlike the loader's `parseManifest` (which
 * stops at the first problem), every issue is collected so CI shows them all at once.
 * The shape is checked structurally (sf does not depend on the loader).
 */
export type ManifestIssueSeverity = 'error' | 'warning' | 'info';

export interface ManifestIssue {
  readonly severity: ManifestIssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly chunk?: string;
}

export interface ManifestCheckOptions {
  /** Fail when the eager boot cost (sum of eager chunks' `sizeKb`) exceeds this. */
  readonly maxEagerKb?: number;
}

export interface ManifestChunkSummary {
  readonly id: string;
  readonly tier: string;
  readonly load: string;
  readonly files: number;
  readonly sizeKb: number | undefined;
  readonly budgetKb: number | undefined;
  readonly remote: boolean;
}

export interface ManifestCheckResult {
  readonly buildId: string | undefined;
  readonly chunks: readonly ManifestChunkSummary[];
  readonly eagerTotalKb: number;
  readonly issues: readonly ManifestIssue[];
  readonly errorCount: number;
}

export const MANIFEST_FORMAT_ID = 'sf-manifest/1' as const;
const TIERS = ['critical', 'likely', 'speculative', 'on-demand'] as const;

export const MANIFEST_ISSUES = {
  format: 'SF-MANIFEST-FORMAT',
  shape: 'SF-MANIFEST-SHAPE',
  idMismatch: 'SF-MANIFEST-ID-MISMATCH',
  danglingDep: 'SF-MANIFEST-DANGLING-DEP',
  cycle: 'SF-MANIFEST-CYCLE',
  overBudget: 'SF-MANIFEST-OVER-BUDGET',
  eagerReason: 'SF-MANIFEST-EAGER-REASON',
  eagerBudget: 'SF-MANIFEST-EAGER-BUDGET',
  remote: 'SF-MANIFEST-REMOTE',
  unmeasured: 'SF-MANIFEST-UNMEASURED',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isChunkId = (value: string): boolean => /^[a-z0-9-]+:[^\s:][^\s]*$/i.test(value);
const optionalNumber = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

export function checkManifest(json: unknown, options: ManifestCheckOptions = {}): ManifestCheckResult {
  const issues: ManifestIssue[] = [];
  const add = (severity: ManifestIssueSeverity, code: string, message: string, chunk?: string): void => {
    issues.push({ severity, code, message, ...(chunk === undefined ? {} : { chunk }) });
  };
  const done = (buildId: string | undefined, chunks: ManifestChunkSummary[], eagerTotalKb: number): ManifestCheckResult => {
    const rank: Record<ManifestIssueSeverity, number> = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return { buildId, chunks, eagerTotalKb, issues, errorCount: issues.filter((i) => i.severity === 'error').length };
  };

  if (!isRecord(json)) {
    add('error', MANIFEST_ISSUES.format, 'The manifest is not a JSON object.');
    return done(undefined, [], 0);
  }
  if (json['format'] !== MANIFEST_FORMAT_ID) add('error', MANIFEST_ISSUES.format, `Unsupported format ${JSON.stringify(json['format'])}; expected "${MANIFEST_FORMAT_ID}".`);
  const buildId = typeof json['buildId'] === 'string' ? json['buildId'] : undefined;
  if (buildId === undefined) add('error', MANIFEST_ISSUES.shape, '`buildId` must be a string.');
  if (typeof json['base'] !== 'string') add('error', MANIFEST_ISSUES.shape, '`base` must be a string (URL prefix of files).');
  const rawChunks = json['chunks'];
  if (!isRecord(rawChunks)) {
    add('error', MANIFEST_ISSUES.shape, '`chunks` must be an object keyed by logical chunk id.');
    return done(buildId, [], 0);
  }

  const summaries: ManifestChunkSummary[] = [];
  const deps = new Map<string, readonly string[]>();
  let eagerTotalKb = 0;
  for (const [key, value] of Object.entries(rawChunks)) {
    if (!isRecord(value)) {
      add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" is not an object.`, key);
      continue;
    }
    const c = value;
    if (!isChunkId(key)) add('error', MANIFEST_ISSUES.shape, `Chunk key "${key}" is not a \`kind:name\` logical id.`, key);
    if (c['id'] !== key) add('error', MANIFEST_ISSUES.idMismatch, `Chunk key "${key}" has id ${JSON.stringify(c['id'])}.`, key);
    if (!isStringArray(c['files']) || c['files'].length === 0) add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" needs a non-empty \`files\` string array (entry module first).`, key);
    if (!isStringArray(c['css'])) add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" needs a \`css\` string array.`, key);
    if (!isStringArray(c['deps'])) add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" needs a \`deps\` string array.`, key);
    else deps.set(key, c['deps']);
    if (!(TIERS as readonly unknown[]).includes(c['tier'])) add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" has unknown tier ${JSON.stringify(c['tier'])} (expected ${TIERS.join(' | ')}).`, key);
    if (c['load'] !== 'lazy' && c['load'] !== 'eager') add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" has unknown load mode ${JSON.stringify(c['load'])}.`, key);
    if (c['load'] === 'eager') {
      if (typeof c['reason'] !== 'string' || c['reason'].trim() === '') add('error', MANIFEST_ISSUES.eagerReason, `Eager chunk "${key}" has no reason (R12.12).`, key);
      if (typeof c['sizeKb'] === 'number') eagerTotalKb += c['sizeKb'];
    }
    if (!optionalNumber(c['sizeKb']) || !optionalNumber(c['budgetKb'])) add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" has a non-numeric sizeKb/budgetKb.`, key);
    for (const field of ['profiles', 'eagerProfiles'] as const) {
      if (c[field] !== undefined && !isStringArray(c[field])) add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" \`${field}\` must be a string array.`, key);
    }
    if (c['integrity'] !== undefined && (!isRecord(c['integrity']) || !Object.values(c['integrity']).every((v) => typeof v === 'string'))) {
      add('error', MANIFEST_ISSUES.shape, `Chunk "${key}" \`integrity\` must map files to SRI strings.`, key);
    }
    const remote = c['remote'];
    if (remote !== undefined) {
      const sharedOk = isRecord(remote) && (remote['shared'] === undefined || (isRecord(remote['shared']) && Object.values(remote['shared']).every((v) => typeof v === 'string')));
      if (!isRecord(remote) || typeof remote['entry'] !== 'string' || typeof remote['module'] !== 'string' || !sharedOk) {
        add('error', MANIFEST_ISSUES.remote, `Chunk "${key}" has a malformed \`remote\` (needs entry, module and optional shared name → range).`, key);
      }
    }
    const sizeKb = typeof c['sizeKb'] === 'number' ? c['sizeKb'] : undefined;
    const budgetKb = typeof c['budgetKb'] === 'number' ? c['budgetKb'] : undefined;
    if (sizeKb !== undefined && budgetKb !== undefined && sizeKb > budgetKb) {
      add('error', MANIFEST_ISSUES.overBudget, `Chunk "${key}" is ${sizeKb} KB gzip, budget ${budgetKb} KB.`, key);
    }
    if (budgetKb !== undefined && sizeKb === undefined && remote === undefined) {
      add('info', MANIFEST_ISSUES.unmeasured, `Chunk "${key}" has a budget but no measured size; build with size measurement to enforce it.`, key);
    }
    summaries.push({
      id: key,
      tier: typeof c['tier'] === 'string' ? c['tier'] : '?',
      load: typeof c['load'] === 'string' ? c['load'] : '?',
      files: isStringArray(c['files']) ? c['files'].length : 0,
      sizeKb,
      budgetKb,
      remote: remote !== undefined,
    });
  }

  for (const [id, list] of deps) {
    for (const dep of list) {
      if (!(dep in rawChunks)) add('error', MANIFEST_ISSUES.danglingDep, `Chunk "${id}" depends on "${dep}", which is not in the manifest.`, id);
    }
  }

  // Cycles (tolerated by the loader, but usually a declaration mistake).
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue;
      const s = state.get(dep);
      if (s === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        const key = [...cycle].slice(0, -1).sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          add('warning', MANIFEST_ISSUES.cycle, `Dependency cycle: ${cycle.join(' → ')}.`, dep);
        }
      } else if (s === undefined) visit(dep);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of [...deps.keys()].sort()) if (!state.has(id)) visit(id);

  eagerTotalKb = Math.round(eagerTotalKb * 100) / 100;
  if (options.maxEagerKb !== undefined && eagerTotalKb > options.maxEagerKb) {
    add('error', MANIFEST_ISSUES.eagerBudget, `Eager boot cost is ${eagerTotalKb} KB gzip, budget ${options.maxEagerKb} KB (R12.12).`);
  }
  return done(buildId, summaries, eagerTotalKb);
}

export function formatManifestText(result: ManifestCheckResult): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of result.issues) counts[issue.severity] += 1;
  const lines = [
    `Manifest ${result.buildId ?? '(no buildId)'}: ${result.chunks.length} chunks · eager ${result.eagerTotalKb} KB · errors: ${counts.error} · warnings: ${counts.warning} · info: ${counts.info}`,
  ];
  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = result.issues.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    lines.push('', `${severity === 'error' ? 'ERRORS' : severity === 'warning' ? 'WARNINGS' : 'INFO'} (${group.length})`);
    for (const issue of group) lines.push(`  ${issue.code}  ${issue.message}`);
  }
  if (result.chunks.length > 0) {
    const width = Math.max(5, ...result.chunks.map((c) => c.id.length));
    lines.push('', `  ${'chunk'.padEnd(width)}  tier         load   files  size KB  budget KB`);
    for (const c of [...result.chunks].sort((a, b) => a.id.localeCompare(b.id))) {
      const size = c.remote ? 'remote' : c.sizeKb === undefined ? '-' : String(c.sizeKb);
      lines.push(`  ${c.id.padEnd(width)}  ${c.tier.padEnd(11)}  ${c.load.padEnd(5)}  ${String(c.files).padStart(5)}  ${size.padStart(7)}  ${(c.budgetKb === undefined ? '-' : String(c.budgetKb)).padStart(9)}`);
    }
  }
  return lines.join('\n');
}
