/**
 * `sf graph <entry>` — static dependency-graph check (R2.6, R17.21).
 *
 * Loads a module exporting `units` (+ optional `external`) or `module`
 * (a `defineModule` result), runs `analyzeGraph` from `@staticflux/core/graph`
 * and adds two checks of its own: duplicate providers of a single (non-multi)
 * token and units nothing depends on.
 */
import { type AnyUnit, err, ok, type Result, type TokenId } from '@staticflux/core';
import { analyzeGraph, type GraphIssue, type GraphLimits, type GraphReport } from '@staticflux/core/graph';
import { InvalidGraphModule } from './errors.js';
import { importModule, type ModuleImporter } from './files.js';

export interface GraphInput {
  readonly units: readonly AnyUnit[];
  readonly external: readonly TokenId[];
}

export interface GraphCheckOptions extends Omit<GraphLimits, 'external'> {
  readonly external?: readonly TokenId[];
}

export interface GraphCheckResult {
  readonly report: GraphReport;
  /** `analyzeGraph` issues plus sf's own checks, sorted error → warning → info. */
  readonly issues: readonly GraphIssue[];
  readonly errorCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnitLike(value: unknown): value is AnyUnit {
  if (!isRecord(value)) return false;
  const provides = value['provides'];
  return typeof value['id'] === 'string' && typeof value['scope'] === 'string' && isRecord(provides) && typeof provides['id'] === 'string';
}

function toTokenId(value: unknown): TokenId | undefined {
  if (typeof value === 'string' && value.includes('/')) return value as TokenId;
  if (isRecord(value) && typeof value['id'] === 'string') return value['id'] as TokenId;
  return undefined;
}

/** Validate a loaded module's exports into units + external token ids. */
export function readGraphExports(exports: Record<string, unknown>, label: string): Result<GraphInput> {
  const moduleExport = exports['module'];
  const source = isRecord(moduleExport) && Array.isArray(moduleExport['units']) ? moduleExport : exports;
  const units = source['units'];
  if (!Array.isArray(units)) {
    return err(InvalidGraphModule({ message: `${label} exports no \`units\` array (found exports: ${Object.keys(exports).join(', ') || 'none'}).` }));
  }
  const bad = units.findIndex((u) => !isUnitLike(u));
  if (bad !== -1) {
    return err(InvalidGraphModule({ message: `${label}: units[${bad}] is not a unit declaration (needs id, scope and provides.id).` }));
  }
  const rawExternal = source['external'] ?? exports['external'] ?? [];
  if (!Array.isArray(rawExternal)) {
    return err(InvalidGraphModule({ message: `${label}: \`external\` must be an array of tokens or token ids.` }));
  }
  const external: TokenId[] = [];
  for (const [index, entry] of rawExternal.entries()) {
    const id = toTokenId(entry);
    if (id === undefined) return err(InvalidGraphModule({ message: `${label}: external[${index}] is not a token or token id.` }));
    external.push(id);
  }
  return ok({ units: units as AnyUnit[], external });
}

export async function loadGraphModule(path: string, cwd: string, importer?: ModuleImporter): Promise<Result<GraphInput>> {
  const loaded = await importModule(path, cwd, importer);
  if (!loaded.ok) return loaded;
  return readGraphExports(loaded.value, path);
}

const severityHeading: Record<GraphIssue['severity'], string> = { error: 'ERRORS', warning: 'WARNINGS', info: 'INFO' };

const severityRank: Record<GraphIssue['severity'], number> = { error: 0, warning: 1, info: 2 };

export function checkGraph(input: GraphInput, options: GraphCheckOptions = {}): GraphCheckResult {
  const limits: GraphLimits = { ...options, external: [...input.external, ...(options.external ?? [])] };
  const report = analyzeGraph(input.units, limits);
  const extra: GraphIssue[] = [];

  const providersByToken = new Map<string, AnyUnit[]>();
  for (const u of input.units) {
    const list = providersByToken.get(u.provides.id) ?? [];
    list.push(u);
    providersByToken.set(u.provides.id, list);
  }
  for (const [tokenId, providers] of providersByToken) {
    if (providers.length > 1 && providers[0]?.provides.multi !== true) {
      extra.push({
        severity: 'warning',
        code: 'SF-GRAPH-DUP-PROVIDER',
        message: `Token "${tokenId}" has ${providers.length} providers (${providers.map((p) => p.id).join(', ')}); use \`variant\`/\`bind\` overrides or a multi token.`,
        units: providers.map((p) => p.id),
      });
    }
  }

  const depended = new Set(report.edges.map((e) => e.to));
  for (const node of report.nodes) {
    if (!depended.has(node.unitId) && !node.critical) {
      extra.push({
        severity: 'info',
        code: 'SF-GRAPH-UNUSED',
        message: `"${node.unitId}" is not depended on by any unit and is not critical; it is only reachable by direct lookup.`,
        units: [node.unitId],
      });
    }
  }

  const issues = [...report.issues, ...extra].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.code.localeCompare(b.code));
  return { report, issues, errorCount: issues.filter((i) => i.severity === 'error').length };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Human-readable report. */
export function formatGraphText(result: GraphCheckResult): string {
  const { report, issues } = result;
  const lines: string[] = [];
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  lines.push(`Units: ${report.nodes.length} · edges: ${report.edges.length} · errors: ${counts.error} · warnings: ${counts.warning} · info: ${counts.info}`);

  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = issues.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    lines.push('', `${severityHeading[severity]} (${group.length})`);
    for (const issue of group) lines.push(`  ${issue.code}  ${issue.message}`);
  }

  lines.push('', 'Boot order (required deps first)');
  report.bootOrder.forEach((id, index) => lines.push(`  ${String(index + 1).padStart(3)}. ${id}`));

  lines.push('', `Critical set (${report.criticalSet.length})`);
  if (report.criticalSet.length === 0) lines.push('  (none)');
  for (const id of report.criticalSet) lines.push(`  - ${id}`);

  const width = Math.max(4, ...report.nodes.map((n) => n.unitId.length));
  const scopeWidth = Math.max(5, ...report.nodes.map((n) => n.scope.length));
  lines.push('', 'Fan-in / fan-out');
  lines.push(`  ${pad('unit', width)}  ${pad('scope', scopeWidth)}  fan-in  fan-out  critical`);
  const sorted = [...report.nodes].sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || a.unitId.localeCompare(b.unitId));
  for (const n of sorted) {
    lines.push(`  ${pad(n.unitId, width)}  ${pad(n.scope, scopeWidth)}  ${String(n.fanIn).padStart(6)}  ${String(n.fanOut).padStart(7)}  ${n.critical ? 'yes' : ''}`.trimEnd());
  }
  return lines.join('\n');
}

export function formatGraphJson(result: GraphCheckResult): string {
  return JSON.stringify({ ...result.report, issues: result.issues, errorCount: result.errorCount }, null, 2);
}

function dotEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function dotId(id: string): string {
  return `"${dotEscape(id)}"`;
}

/** Graphviz output: critical units filled, required edges solid, lazy dashed, functional dotted; error edges/nodes red. */
export function formatGraphDot(result: GraphCheckResult): string {
  const { report, issues } = result;
  const errored = new Set(issues.filter((i) => i.severity === 'error').flatMap((i) => i.units));
  const lines = ['digraph staticflux {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
  for (const n of report.nodes) {
    const attrs = [`label="${dotEscape(n.unitId)}\\n${dotEscape(n.scope)}"`];
    if (n.critical) attrs.push('style=filled', 'fillcolor="#fde68a"');
    else if (report.criticalSet.includes(n.unitId)) attrs.push('style=filled', 'fillcolor="#fef3c7"');
    if (errored.has(n.unitId)) attrs.push('color="#dc2626"', 'penwidth=2');
    lines.push(`  ${dotId(n.unitId)} [${attrs.join(', ')}];`);
  }
  for (const e of report.edges) {
    const style = e.kind === 'required' ? 'solid' : e.kind === 'lazy' ? 'dashed' : 'dotted';
    lines.push(`  ${dotId(e.from)} -> ${dotId(e.to)} [style=${style}];`);
  }
  lines.push('}');
  return lines.join('\n');
}
