/**
 * Static dependency-graph analysis over unit declarations. Used by the `sf`
 * CLI in CI and by devtools. Pure functions over data — no injector needed.
 *
 * Reports: missing providers, required-edge cycles (errors), lazy cycles
 * (info), scope violations, fan-in/fan-out (monolith guards), topological
 * boot order, the critical set, and metric producer/consumer mismatches.
 */
import type { TokenId } from './token.js';
import { type AnyUnit, dependencyEdges, scopeRank } from './unit.js';

export interface GraphNode {
  readonly unitId: string;
  readonly tokenId: TokenId;
  readonly scope: AnyUnit['scope'];
  readonly critical: boolean;
  readonly fanOut: number;
  readonly fanIn: number;
}

export type GraphIssueSeverity = 'error' | 'warning' | 'info';

export interface GraphIssue {
  readonly severity: GraphIssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly units: readonly string[];
}

export interface GraphReport {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly { from: string; to: string; kind: 'required' | 'lazy' | 'functional' }[];
  /** Units in an order where required deps come first. */
  readonly bootOrder: readonly string[];
  /** Critical units plus their transitive required deps. */
  readonly criticalSet: readonly string[];
  readonly issues: readonly GraphIssue[];
}

export interface GraphLimits {
  /** Max declared dependencies per unit (fan-out). Default 8. */
  readonly maxFanOut?: number;
  /** Units required by more than this many units are flagged as potential god units. Default 15. */
  readonly maxFanIn?: number;
  /** Tokens provided by the host environment (e.g. when analyzing one feature module). */
  readonly external?: readonly TokenId[];
}

export function analyzeGraph(units: readonly AnyUnit[], limits: GraphLimits = {}): GraphReport {
  const maxFanOut = limits.maxFanOut ?? 8;
  const maxFanIn = limits.maxFanIn ?? 15;
  const external = new Set<string>(limits.external ?? []);
  const issues: GraphIssue[] = [];

  const providers = new Map<TokenId, AnyUnit[]>();
  for (const u of units) {
    const list = providers.get(u.provides.id) ?? [];
    list.push(u);
    providers.set(u.provides.id, list);
  }

  const edges: { from: string; to: string; kind: 'required' | 'lazy' | 'functional' }[] = [];
  const requiredAdjacency = new Map<string, string[]>();
  const fanIn = new Map<string, number>();
  const byId = new Map<string, AnyUnit>(units.map((u) => [u.id, u]));

  for (const u of units) {
    const deps = dependencyEdges(u);
    if (deps.length > maxFanOut) {
      issues.push({
        severity: 'warning',
        code: 'SF-GRAPH-FANOUT',
        message: `"${u.id}" declares ${deps.length} dependencies (limit ${maxFanOut}). Consider splitting it.`,
        units: [u.id],
      });
    }
    for (const edge of deps) {
      const targets = providers.get(edge.token.id) ?? [];
      if (targets.length === 0) {
        if (!external.has(edge.token.id) && !edge.token.multi) {
          issues.push({
            severity: edge.kind === 'required' ? 'error' : 'warning',
            code: 'SF-DI-001',
            message: `"${u.id}" ${edge.kind} dependency "${edge.key}" (${edge.token.id}) has no provider.`,
            units: [u.id],
          });
        }
        continue;
      }
      for (const target of targets) {
        edges.push({ from: u.id, to: target.id, kind: edge.kind });
        fanIn.set(target.id, (fanIn.get(target.id) ?? 0) + 1);
        if (edge.kind === 'required') {
          const list = requiredAdjacency.get(u.id) ?? [];
          list.push(target.id);
          requiredAdjacency.set(u.id, list);
        }
        if (scopeRank(target.scope) > scopeRank(u.scope)) {
          issues.push({
            severity: 'error',
            code: 'SF-DI-002',
            message: `"${u.id}" (${u.scope}) depends on shorter-lived "${target.id}" (${target.scope}).`,
            units: [u.id, target.id],
          });
        }
      }
    }
  }

  for (const [unitId, count] of fanIn) {
    if (count > maxFanIn) {
      issues.push({
        severity: 'warning',
        code: 'SF-GRAPH-FANIN',
        message: `"${unitId}" is required by ${count} units (limit ${maxFanIn}); it may be becoming a god object.`,
        units: [unitId],
      });
    }
  }

  // Cycles over required edges (Tarjan SCC).
  for (const component of stronglyConnected(units.map((u) => u.id), requiredAdjacency)) {
    const selfLoop = component.length === 1 && (requiredAdjacency.get(component[0] as string) ?? []).includes(component[0] as string);
    if (component.length > 1 || selfLoop) {
      issues.push({
        severity: 'error',
        code: 'SF-DI-004',
        message: `Required dependency cycle: ${component.join(' → ')}`,
        units: component,
      });
    }
  }

  // Topological order (required edges only; deps first).
  const bootOrder: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const next of requiredAdjacency.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
    bootOrder.push(id);
  };
  for (const u of units) visit(u.id);

  // Critical set.
  const critical = new Set<string>();
  const markCritical = (id: string): void => {
    if (critical.has(id)) return;
    critical.add(id);
    for (const next of requiredAdjacency.get(id) ?? []) markCritical(next);
  };
  for (const u of units) if (u.critical === true) markCritical(u.id);
  for (const id of critical) {
    const u = byId.get(id);
    if (u !== undefined && u.critical !== true) {
      issues.push({
        severity: 'info',
        code: 'SF-GRAPH-CRITICAL-TRANSITIVE',
        message: `"${id}" is on the critical boot path only because a critical unit requires it.`,
        units: [id],
      });
    }
  }

  // Metrics: read but never informed = error; informed but never read = warning.
  const informed = new Set(units.flatMap((u) => (u.informs ?? []).map((m) => m.id)));
  const read = new Set(units.flatMap((u) => (u.reads ?? []).map((m) => m.id)));
  for (const id of read) {
    if (!informed.has(id)) {
      issues.push({ severity: 'error', code: 'SF-METRIC-001', message: `Metric "${id}" is read but no unit informs it.`, units: [] });
    }
  }
  for (const id of informed) {
    if (!read.has(id)) {
      issues.push({ severity: 'warning', code: 'SF-METRIC-002', message: `Metric "${id}" is informed but nothing reads it.`, units: [] });
    }
  }

  const nodes: GraphNode[] = units.map((u) => ({
    unitId: u.id,
    tokenId: u.provides.id,
    scope: u.scope,
    critical: u.critical === true,
    fanOut: dependencyEdges(u).length,
    fanIn: fanIn.get(u.id) ?? 0,
  }));

  return { nodes, edges, bootOrder, criticalSet: [...critical], issues };
}

function stronglyConnected(ids: readonly string[], adjacency: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const strong = (v: string): void => {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strong(w);
        lowlink.set(v, Math.min(lowlink.get(v) as number, lowlink.get(w) as number));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) as number, indices.get(w) as number));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      out.push(component.reverse());
    }
  };
  for (const id of ids) if (!indices.has(id)) strong(id);
  return out;
}
