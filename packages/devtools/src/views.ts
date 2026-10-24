/**
 * Inspectors: pure functions from collected records (+ optional live sources)
 * to view models the panel renders. No DOM, no Lit — testable and usable from
 * any other UI (e.g. a browser extension or a CI report).
 */
import {
  type AnyUnit,
  type Attrs,
  type InstanceInfo,
  listErrorDefinitions,
  type MetricDefinition,
  type MetricKind,
  SCOPE_LEVELS,
  type SpanEndRecord,
  type SpanStartRecord,
  type SpanStatus,
} from '@staticflux/core';
import { analyzeGraph, type GraphIssue } from '@staticflux/core/graph';
import { criticalPath, type JourneySummary, type JourneyTracker } from '@staticflux/perf';
import type { FeatureInfo, SubsystemInfo } from '@staticflux/runtime';
import type { BootTrace, DecisionRecord, LifecycleEntry, LifecycleTransition, MetricSeries, ViolationGroup, ViolationSample } from './collector.js';

// ================================================================ boot waterfall (R2.4)

export interface WaterfallRow {
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  /** Human label: unit id for `di.resolve`, stage for `nav.stage`, else the span name. */
  readonly label: string;
  readonly subsystem: string;
  readonly depth: number;
  /** ms since the boot root started. */
  readonly offset: number;
  readonly duration: number;
  readonly status: SpanStatus | 'open';
  readonly onCriticalPath: boolean;
  readonly unit: string | undefined;
  readonly attrs: Attrs;
}

export interface UnitTiming {
  readonly unit: string;
  readonly token: string | undefined;
  readonly scope: string | undefined;
  readonly injector: string | undefined;
  readonly offset: number;
  readonly duration: number;
  /** Time spent waiting for required dependencies (child resolutions, which run in parallel). */
  readonly waitMs: number;
  /** duration − waitMs: this unit's own create + init (+ blocking hooks). */
  readonly ownMs: number;
  readonly status: SpanStatus | 'open';
  readonly budgetMs: number | undefined;
  readonly overBudget: boolean;
  readonly onCriticalPath: boolean;
  /** Units resolved as this unit's required dependencies (child `di.resolve` spans). */
  readonly waitedOn: readonly string[];
}

export interface CriticalStepView {
  readonly name: string;
  readonly label: string;
  readonly spanId: string;
  readonly offset: number;
  readonly duration: number;
  readonly depth: number;
}

export interface BootWaterfall {
  readonly status: 'missing' | 'running' | 'complete' | 'failed';
  readonly traceId: string | undefined;
  /** Root span duration (or elapsed time while open). */
  readonly total: number;
  readonly rows: readonly WaterfallRow[];
  readonly criticalPath: readonly CriticalStepView[];
  /** Per-unit DI resolution, slowest first. */
  readonly units: readonly UnitTiming[];
  /** Units whose `budget.initMs` was exceeded (names the offender, R2.4). */
  readonly overBudget: readonly UnitTiming[];
  readonly hint: string | undefined;
}

const DI_RESOLVE = 'di.resolve';

function labelOf(name: string, attrs: Attrs): string {
  if (name === DI_RESOLVE && typeof attrs['unit'] === 'string') return attrs['unit'];
  if (name === 'nav.stage' && typeof attrs['stage'] === 'string') return `stage ${attrs['stage']}`;
  if (name === 'chunk.load' && typeof attrs['chunk'] === 'string') return `chunk ${attrs['chunk']}`;
  return name;
}

interface SpanLike {
  readonly name: string;
  readonly subsystem: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly start: number;
  readonly end: number;
  readonly status: SpanStatus | 'open';
  readonly attrs: Attrs;
}

function spanLikes(spans: readonly SpanEndRecord[], open: readonly SpanStartRecord[], now: number): SpanLike[] {
  const ended = spans.map((s) => ({
    name: s.name,
    subsystem: s.subsystem,
    spanId: s.context.spanId,
    parentSpanId: s.parentSpanId,
    start: s.start,
    end: s.end,
    status: s.status,
    attrs: s.attrs,
  }));
  const endedIds = new Set(ended.map((s) => s.spanId));
  const running = open
    .filter((s) => !endedIds.has(s.context.spanId))
    .map((s) => ({
      name: s.name,
      subsystem: s.subsystem,
      spanId: s.context.spanId,
      parentSpanId: s.parentSpanId,
      start: s.start,
      end: Math.max(s.start, now),
      status: 'open' as const,
      attrs: s.attrs,
    }));
  return [...ended, ...running];
}

/** Depth-first rows (children ordered by start) of a span forest. */
function treeRows(items: readonly SpanLike[], origin: number, critical: ReadonlySet<string>): WaterfallRow[] {
  const ids = new Set(items.map((s) => s.spanId));
  const children = new Map<string | undefined, SpanLike[]>();
  for (const item of items) {
    const parent = item.parentSpanId !== undefined && ids.has(item.parentSpanId) ? item.parentSpanId : undefined;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
  const rows: WaterfallRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number): void => {
    for (const item of children.get(parent) ?? []) {
      if (seen.has(item.spanId)) continue;
      seen.add(item.spanId);
      rows.push({
        spanId: item.spanId,
        parentSpanId: item.parentSpanId,
        name: item.name,
        label: labelOf(item.name, item.attrs),
        subsystem: item.subsystem,
        depth,
        offset: item.start - origin,
        duration: item.end - item.start,
        status: item.status,
        onCriticalPath: critical.has(item.spanId),
        unit: item.name === DI_RESOLVE && typeof item.attrs['unit'] === 'string' ? item.attrs['unit'] : undefined,
        attrs: item.attrs,
      });
      walk(item.spanId, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

function toSpanEnd(item: SpanLike): SpanEndRecord {
  return {
    type: 'span',
    name: item.name,
    subsystem: item.subsystem as SpanEndRecord['subsystem'],
    level: 'standard',
    context: { traceId: '', spanId: item.spanId, sampled: true },
    parentSpanId: item.parentSpanId,
    start: item.start,
    end: item.end,
    duration: item.end - item.start,
    attrs: item.attrs,
    status: item.status === 'open' ? 'ok' : item.status,
    error: undefined,
  };
}

export function buildBootWaterfall(trace: BootTrace | undefined, now: number): BootWaterfall {
  if (trace === undefined) {
    return {
      status: 'missing',
      traceId: undefined,
      total: 0,
      rows: [],
      criticalPath: [],
      units: [],
      overBudget: [],
      hint: 'No boot trace recorded. Install devtools before (or right after) boot — telemetry buffers records until the first sink attaches — and keep `runtime/app` ≥ critical and `core/di` ≥ standard (verbose for non-critical units).',
    };
  }
  const items = spanLikes(trace.spans, trace.open, now);
  const root = items.find((s) => s.spanId === trace.rootSpanId) ?? items.reduce<SpanLike | undefined>((a, s) => (a === undefined || s.start < a.start ? s : a), undefined);
  const origin = root?.start ?? 0;
  const steps = criticalPath(items.map(toSpanEnd));
  const critical = new Set(steps.map((s) => s.spanId));
  const byId = new Map(items.map((s) => [s.spanId, s]));
  const rows = treeRows(items, origin, critical);

  const resolveSpans = items.filter((s) => s.name === DI_RESOLVE);
  const units: UnitTiming[] = resolveSpans.map((s) => {
    const kids = resolveSpans.filter((k) => k.parentSpanId === s.spanId);
    const waitEnd = kids.reduce((max, k) => Math.max(max, k.end), s.start);
    const waitMs = Math.max(0, Math.min(waitEnd, s.end) - s.start);
    const duration = s.end - s.start;
    const budget = typeof s.attrs['budget.initMs'] === 'number' ? s.attrs['budget.initMs'] : undefined;
    const ownMs = Math.max(0, duration - waitMs);
    return {
      unit: typeof s.attrs['unit'] === 'string' ? s.attrs['unit'] : s.spanId,
      token: typeof s.attrs['token'] === 'string' ? s.attrs['token'] : undefined,
      scope: typeof s.attrs['scope'] === 'string' ? s.attrs['scope'] : undefined,
      injector: typeof s.attrs['injector'] === 'string' ? s.attrs['injector'] : undefined,
      offset: s.start - origin,
      duration,
      waitMs,
      ownMs,
      status: s.status,
      budgetMs: budget,
      overBudget: budget !== undefined && ownMs > budget,
      onCriticalPath: critical.has(s.spanId),
      waitedOn: kids.map((k) => (typeof k.attrs['unit'] === 'string' ? k.attrs['unit'] : k.spanId)),
    };
  });
  units.sort((a, b) => b.duration - a.duration || a.unit.localeCompare(b.unit));

  const failed = root !== undefined && root.status === 'error';
  const running = root === undefined || root.status === 'open';
  return {
    status: failed ? 'failed' : running ? 'running' : 'complete',
    traceId: trace.traceId,
    total: root === undefined ? 0 : root.end - root.start,
    rows,
    criticalPath: steps.map((step) => {
      const item = byId.get(step.spanId);
      return {
        name: step.name,
        label: item === undefined ? step.name : labelOf(item.name, item.attrs),
        spanId: step.spanId,
        offset: step.start - origin,
        duration: step.duration,
        depth: step.depth,
      };
    }),
    units,
    overBudget: units.filter((u) => u.overBudget),
    hint: resolveSpans.length === 0 ? 'No `di.resolve` spans: raise `core/di` to standard (critical units) or verbose (all units).' : undefined,
  };
}

// ================================================================ journeys (R17.5)

export interface JourneyPhaseView {
  readonly name: string;
  readonly offset: number;
  readonly total: number;
  readonly spanCount: number;
  readonly criticalPath: readonly CriticalStepView[];
}

export interface JourneyMarkView {
  readonly feature: string;
  readonly mark: string;
  readonly value: number;
  readonly method: string;
}

export interface JourneyView {
  readonly id: string;
  readonly route: string | undefined;
  readonly start: string;
  readonly outcome: string;
  readonly startedAt: number;
  readonly duration: number;
  readonly open: boolean;
  readonly classification: Readonly<Record<string, string | undefined>>;
  readonly phases: readonly JourneyPhaseView[];
  readonly marks: readonly JourneyMarkView[];
  readonly source: 'tracker' | 'spans';
}

function journeyFromSummary(summary: JourneySummary): JourneyView {
  const origin = summary.startedAt;
  const marks: JourneyMarkView[] = [];
  for (const [feature, byMark] of Object.entries(summary.marks)) {
    for (const [mark, record] of Object.entries(byMark)) {
      if (record !== undefined) marks.push({ feature, mark, value: record.value, method: record.method });
    }
  }
  marks.sort((a, b) => a.value - b.value);
  const labels = new Map(summary.spans.map((s) => [s.context.spanId, labelOf(s.name, s.attrs)]));
  return {
    id: summary.id,
    route: summary.route,
    start: summary.classification.start,
    outcome: summary.outcome,
    startedAt: summary.startedAt,
    duration: summary.duration,
    open: false,
    classification: {
      start: summary.classification.start,
      activation: summary.classification.activation,
      code: summary.classification.code,
      data: summary.classification.data,
    },
    phases: summary.phases.map((p) => ({
      name: p.phase,
      offset: p.start - origin,
      total: p.total,
      spanCount: p.spanCount,
      criticalPath: p.criticalPath.map((c) => ({
        name: c.name,
        label: labels.get(c.spanId) ?? c.name,
        spanId: c.spanId,
        offset: c.start - origin,
        duration: c.duration,
        depth: c.depth,
      })),
    })),
    marks,
    source: 'tracker',
  };
}

/** Journeys from perf's tracker (newest first, the open one on top). */
export function buildJourneysFromTracker(tracker: Pick<JourneyTracker, 'history' | 'current'>, now: number): readonly JourneyView[] {
  const out: JourneyView[] = [];
  const current = tracker.current;
  if (current !== undefined) {
    out.push({
      id: current.id,
      route: current.route,
      start: current.start,
      outcome: 'open',
      startedAt: current.startedAt,
      duration: Math.max(0, now - current.startedAt),
      open: true,
      classification: { start: current.start },
      phases: [],
      marks: [],
      source: 'tracker',
    });
  }
  for (const summary of [...tracker.history].reverse()) out.push(journeyFromSummary(summary));
  return out;
}

export const NAVIGATION_SPANS = ['nav.pipeline', 'nav.view', 'nav.dialog'] as const;

/** Fallback without a tracker: one journey per `nav.pipeline|view|dialog` span; stages are its phases. */
export function buildJourneysFromSpans(spans: readonly SpanEndRecord[], limit = 20): readonly JourneyView[] {
  const byTrace = new Map<string, SpanEndRecord[]>();
  for (const span of spans) {
    const list = byTrace.get(span.context.traceId) ?? [];
    list.push(span);
    byTrace.set(span.context.traceId, list);
  }
  const roots = spans.filter((s) => (NAVIGATION_SPANS as readonly string[]).includes(s.name));
  const out: JourneyView[] = [];
  for (const root of [...roots].reverse().slice(0, limit)) {
    const trace = byTrace.get(root.context.traceId) ?? [];
    const children = new Map<string, SpanEndRecord[]>();
    for (const span of trace) {
      if (span.parentSpanId === undefined) continue;
      const list = children.get(span.parentSpanId) ?? [];
      list.push(span);
      children.set(span.parentSpanId, list);
    }
    const subtree = (id: string): SpanEndRecord[] => {
      const acc: SpanEndRecord[] = [];
      const stack = [...(children.get(id) ?? [])];
      while (stack.length > 0) {
        const next = stack.pop() as SpanEndRecord;
        acc.push(next);
        stack.push(...(children.get(next.context.spanId) ?? []));
      }
      return acc;
    };
    const stages = (children.get(root.context.spanId) ?? []).slice().sort((a, b) => a.start - b.start);
    const labels = new Map(trace.map((s) => [s.context.spanId, labelOf(s.name, s.attrs)]));
    const phases: JourneyPhaseView[] = stages.map((stage) => {
      const own = [stage, ...subtree(stage.context.spanId)];
      return {
        name: labelOf(stage.name, stage.attrs),
        offset: stage.start - root.start,
        total: stage.duration,
        spanCount: own.length,
        criticalPath: criticalPath(own).map((c) => ({
          name: c.name,
          label: labels.get(c.spanId) ?? c.name,
          spanId: c.spanId,
          offset: c.start - root.start,
          duration: c.duration,
          depth: c.depth,
        })),
      };
    });
    const outcome = typeof root.attrs['outcome'] === 'string' ? root.attrs['outcome'] : root.status;
    out.push({
      id: root.context.spanId,
      route: typeof root.attrs['route'] === 'string' ? root.attrs['route'] : undefined,
      start: typeof root.attrs['start'] === 'string' ? root.attrs['start'] : root.name === 'nav.pipeline' ? 'soft' : root.name.slice(4),
      outcome,
      startedAt: root.start,
      duration: root.duration,
      open: false,
      classification: { start: typeof root.attrs['start'] === 'string' ? root.attrs['start'] : undefined, kind: typeof root.attrs['kind'] === 'string' ? root.attrs['kind'] : undefined },
      phases,
      marks: [],
      source: 'spans',
    });
  }
  return out;
}

// ================================================================ DI graph

export type NodeState = InstanceInfo['state'] | 'not-created';

export interface GraphNodeView {
  readonly unitId: string;
  readonly tokenId: string;
  readonly scope: string;
  readonly critical: boolean;
  /** Aggregate over instances (failed wins, then in-flight, then ready). */
  readonly state: NodeState;
  readonly instances: readonly { readonly injector: string; readonly state: InstanceInfo['state'] }[];
  readonly layer: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly declared: boolean;
  readonly inCriticalSet: boolean;
  readonly error: string | undefined;
  /** Required dependencies (unit ids). */
  readonly requires: readonly string[];
}

export interface DiGraphView {
  readonly source: 'graph' | 'instances';
  readonly layers: readonly (readonly GraphNodeView[])[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: 'required' | 'lazy' | 'functional' }[];
  readonly issues: readonly GraphIssue[];
  readonly bootOrder: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}

const STATE_PRIORITY: readonly InstanceInfo['state'][] = ['failed', 'resolving', 'initializing', 'refreshing', 'created', 'ready', 'unresolved', 'disposed'];

function aggregateState(states: readonly InstanceInfo['state'][]): NodeState {
  if (states.length === 0) return 'not-created';
  for (const state of STATE_PRIORITY) if (states.includes(state)) return state;
  return states[0] as InstanceInfo['state'];
}

function errorText(error: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (error === undefined) return undefined;
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  const message = typeof error['message'] === 'string' ? error['message'] : '';
  return `${code} ${message}`.trim();
}

/**
 * DI graph: live instances (`injector.inspect()`) layered by the declared graph
 * (`analyzeGraph(units)`) when unit definitions are provided — layer 0 has no
 * required deps; layer n requires something in layer n−1. Without units, nodes
 * are layered by scope level.
 */
export function buildDiGraph(instances: readonly InstanceInfo[], units?: readonly AnyUnit[]): DiGraphView {
  const byUnit = new Map<string, InstanceInfo[]>();
  for (const info of instances) {
    const list = byUnit.get(info.unitId) ?? [];
    list.push(info);
    byUnit.set(info.unitId, list);
  }
  const counts: Record<string, number> = {};
  const node = (
    unitId: string,
    fallback: { tokenId: string; scope: string; critical: boolean },
    layer: number,
    extra: { fanIn: number; fanOut: number; declared: boolean; inCriticalSet: boolean; requires: readonly string[] },
  ): GraphNodeView => {
    const list = byUnit.get(unitId) ?? [];
    const state = aggregateState(list.map((i) => i.state));
    counts[state] = (counts[state] ?? 0) + 1;
    const failed = list.find((i) => i.error !== undefined);
    return {
      unitId,
      tokenId: list[0]?.tokenId ?? fallback.tokenId,
      scope: list[0]?.scope ?? fallback.scope,
      critical: list[0]?.critical ?? fallback.critical,
      state,
      instances: list.map((i) => ({ injector: i.injector, state: i.state })),
      layer,
      error: errorText(failed?.error),
      ...extra,
    };
  };

  if (units === undefined || units.length === 0) {
    const layers: GraphNodeView[][] = SCOPE_LEVELS.map(() => []);
    for (const [unitId, list] of byUnit) {
      const first = list[0] as InstanceInfo;
      const layer = Math.max(0, SCOPE_LEVELS.indexOf(first.scope));
      (layers[layer] as GraphNodeView[]).push(
        node(unitId, first, layer, { fanIn: 0, fanOut: 0, declared: false, inCriticalSet: first.critical, requires: [] }),
      );
    }
    for (const layer of layers) layer.sort((a, b) => a.unitId.localeCompare(b.unitId));
    return { source: 'instances', layers: layers.filter((l) => l.length > 0), edges: [], issues: [], bootOrder: [], counts };
  }

  const report = analyzeGraph(units);
  const requires = new Map<string, string[]>();
  for (const edge of report.edges) {
    if (edge.kind !== 'required') continue;
    const list = requires.get(edge.from) ?? [];
    if (!list.includes(edge.to)) list.push(edge.to);
    requires.set(edge.from, list);
  }
  const layerOf = new Map<string, number>();
  const computing = new Set<string>();
  const layerFor = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    if (computing.has(id)) return 0; // cycle (reported as SF-DI-004)
    computing.add(id);
    let layer = 0;
    for (const dep of requires.get(id) ?? []) layer = Math.max(layer, layerFor(dep) + 1);
    computing.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  const critical = new Set(report.criticalSet);
  const layers: GraphNodeView[][] = [];
  const place = (view: GraphNodeView): void => {
    while (layers.length <= view.layer) layers.push([]);
    (layers[view.layer] as GraphNodeView[]).push(view);
  };
  for (const graphNode of report.nodes) {
    const layer = layerFor(graphNode.unitId);
    place(
      node(graphNode.unitId, { tokenId: graphNode.tokenId, scope: graphNode.scope, critical: graphNode.critical }, layer, {
        fanIn: graphNode.fanIn,
        fanOut: graphNode.fanOut,
        declared: true,
        inCriticalSet: critical.has(graphNode.unitId),
        requires: requires.get(graphNode.unitId) ?? [],
      }),
    );
  }
  const declaredIds = new Set(report.nodes.map((n) => n.unitId));
  for (const [unitId, list] of byUnit) {
    if (declaredIds.has(unitId)) continue;
    const first = list[0] as InstanceInfo;
    place(node(unitId, first, 0, { fanIn: 0, fanOut: 0, declared: false, inCriticalSet: false, requires: [] }));
  }
  for (const layer of layers) layer.sort((a, b) => a.unitId.localeCompare(b.unitId));
  return { source: 'graph', layers, edges: report.edges, issues: report.issues, bootOrder: report.bootOrder, counts };
}

// ================================================================ lifecycles

export interface LifecycleItem {
  readonly machine: string;
  readonly instance: string;
  readonly state: string;
  readonly since: number | undefined;
  readonly transitions: number;
  readonly history: readonly LifecycleTransition[];
  readonly invalid: number;
  readonly lastInvalid: LifecycleEntry['lastInvalid'];
  readonly source: 'live' | 'events' | 'both';
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface LifecycleGroup {
  readonly machine: string;
  readonly label: string;
  readonly items: readonly LifecycleItem[];
}

export interface LifecycleView {
  readonly groups: readonly LifecycleGroup[];
  readonly total: number;
}

export interface LiveLifecycleSources {
  readonly app?: { readonly state: string; readonly epoch: number } | undefined;
  readonly subsystems?: readonly SubsystemInfo[] | undefined;
  readonly features?: readonly FeatureInfo[] | undefined;
}

const GROUP_ORDER = ['app', 'subsystem', 'feature', 'worker', 'messaging/surface'];
const GROUP_LABELS: Readonly<Record<string, string>> = {
  app: 'App',
  subsystem: 'Subsystems',
  feature: 'Features',
  worker: 'Workers',
  'messaging/surface': 'Surfaces',
};

export function buildLifecycles(entries: readonly LifecycleEntry[], live: LiveLifecycleSources = {}): LifecycleView {
  const items = new Map<string, LifecycleItem>();
  const key = (machine: string, instance: string): string => `${machine}\u0000${instance}`;
  for (const e of entries) {
    items.set(key(e.machine, e.instance), {
      machine: e.machine,
      instance: e.instance,
      state: e.state,
      since: e.since,
      transitions: e.transitions,
      history: e.history,
      invalid: e.invalid,
      lastInvalid: e.lastInvalid,
      source: 'events',
      details: {},
    });
  }
  const merge = (machine: string, instance: string, state: string, details: Record<string, string | number | boolean>): void => {
    const k = key(machine, instance);
    const existing = items.get(k);
    items.set(k, {
      machine,
      instance,
      state,
      since: existing?.since,
      transitions: existing?.transitions ?? 0,
      history: existing?.history ?? [],
      invalid: existing?.invalid ?? 0,
      lastInvalid: existing?.lastInvalid,
      source: existing === undefined ? 'live' : 'both',
      details,
    });
  };
  if (live.app !== undefined) merge('app', 'app', live.app.state, { epoch: live.app.epoch });
  for (const s of live.subsystems ?? []) {
    const details: Record<string, string | number | boolean> = { critical: s.critical, restarts: s.restarts };
    if (s.dependsOn.length > 0) details['dependsOn'] = s.dependsOn.join(', ');
    const error = errorText(s.error);
    if (error !== undefined) details['error'] = error;
    merge('subsystem', s.id, s.state, details);
  }
  for (const f of live.features ?? []) {
    const details: Record<string, string | number | boolean> = { weight: f.weight, refCount: f.refCount, busy: f.busy, headless: f.headless };
    if (f.mountedDependents.length > 0) details['mountedDependents'] = f.mountedDependents.join(', ');
    if (f.error !== undefined) details['error'] = `${f.error.code} ${f.error.message}`;
    merge('feature', f.id, f.state, details);
  }
  const groups = new Map<string, LifecycleItem[]>();
  for (const item of items.values()) {
    const list = groups.get(item.machine) ?? [];
    list.push(item);
    groups.set(item.machine, list);
  }
  const rank = (machine: string): number => {
    const index = GROUP_ORDER.indexOf(machine);
    return index < 0 ? GROUP_ORDER.length : index;
  };
  const ordered = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  return {
    total: items.size,
    groups: ordered.map(([machine, list]) => ({
      machine,
      label: GROUP_LABELS[machine] ?? machine,
      items: list.sort((a, b) => a.instance.localeCompare(b.instance)),
    })),
  };
}

// ================================================================ decisions (R6.11)

export interface DecisionsView {
  readonly items: readonly DecisionRecord[];
  readonly allow: number;
  readonly deny: number;
}

export interface DecisionFilter {
  readonly effect?: 'allow' | 'deny';
  /** Substring matched against the key (`level:resource:action`). */
  readonly text?: string;
}

export function buildDecisions(records: readonly DecisionRecord[], filter: DecisionFilter = {}): DecisionsView {
  const text = filter.text?.toLowerCase();
  const items = [...records]
    .reverse()
    .filter((r) => (filter.effect === undefined || r.effect === filter.effect) && (text === undefined || text === '' || r.key.toLowerCase().includes(text)));
  return {
    items,
    allow: items.filter((r) => r.effect === 'allow').length,
    deny: items.filter((r) => r.effect === 'deny').length,
  };
}

// ================================================================ stores

export interface StorePatchView {
  readonly time: number;
  readonly version: number;
  readonly epoch: number;
  readonly action: string;
  readonly ops: number;
  readonly paths: readonly string[];
}

export interface StoreView {
  readonly id: string;
  readonly mode: string;
  readonly version: number;
  readonly epoch: number;
  readonly schemaVersion: number | undefined;
  readonly state: unknown;
  readonly patches: readonly StorePatchView[];
}

/** Compact JSON preview for the panel (bounded length; cycles and functions are safe). */
export function previewJson(value: unknown, maxChars = 4000): string {
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text =
      JSON.stringify(
        value,
        (_key, v: unknown) => {
          if (typeof v === 'function') return '[function]';
          if (typeof v === 'bigint') return `${v.toString()}n`;
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return '[circular]';
            seen.add(v);
          }
          return v;
        },
        2,
      ) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more chars)` : text;
}

// ================================================================ violations (R17.22)

export interface ViolationGroupView extends ViolationGroup {
  /** True when the fix came from the error catalog because the event had none. */
  readonly fixFromCatalog: boolean;
}

export interface ViolationsView {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
  readonly groups: readonly ViolationGroupView[];
}

export function buildViolations(groups: readonly ViolationGroup[], total?: number): ViolationsView {
  let catalog: Map<string, { fix: string; summary: string }> | undefined;
  const lookup = (code: string): { fix: string; summary: string } | undefined => {
    catalog ??= new Map(listErrorDefinitions().map((d) => [d.code, { fix: d.fix, summary: d.summary }]));
    return catalog.get(code);
  };
  const views: ViolationGroupView[] = groups.map((g) => {
    if (g.fix !== '') return { ...g, fixFromCatalog: false };
    const entry = lookup(g.code);
    return { ...g, fix: entry?.fix ?? '', message: g.message ?? entry?.summary, fixFromCatalog: entry !== undefined };
  });
  views.sort((a, b) => (a.severity === b.severity ? b.count - a.count || a.code.localeCompare(b.code) : a.severity === 'error' ? -1 : 1));
  const sum = (severity: 'error' | 'warning'): number => views.filter((v) => v.severity === severity).reduce((n, v) => n + v.count, 0);
  return { total: total ?? views.reduce((n, v) => n + v.count, 0), errors: sum('error'), warnings: sum('warning'), groups: views };
}

export type { ViolationSample };

// ================================================================ metrics (R17.17)

export interface MetricView {
  readonly id: string;
  readonly kind: MetricKind;
  readonly unit: string | undefined;
  readonly description: string | undefined;
  readonly declared: boolean;
  readonly observed: boolean;
  readonly series: readonly Omit<MetricSeries, 'metric' | 'kind' | 'unit'>[];
}

export interface MetricsView {
  readonly metrics: readonly MetricView[];
  /** Declared (read/informed) but never recorded. */
  readonly silent: readonly string[];
}

/** Declared metrics from unit `informs` / `reads` declarations. */
export function declaredMetricsOf(units: readonly AnyUnit[]): MetricDefinition[] {
  const out = new Map<string, MetricDefinition>();
  for (const u of units) for (const m of [...(u.informs ?? []), ...(u.reads ?? [])]) out.set(m.id, m);
  return [...out.values()];
}

export function buildMetrics(series: readonly MetricSeries[], declared: readonly MetricDefinition[] = []): MetricsView {
  const views = new Map<string, { id: string; kind: MetricKind; unit: string | undefined; description: string | undefined; declared: boolean; series: MetricView['series'][number][] }>();
  for (const d of declared) views.set(d.id, { id: d.id, kind: d.metricKind, unit: d.unit, description: d.description, declared: true, series: [] });
  for (const s of series) {
    let view = views.get(s.metric);
    if (view === undefined) {
      view = { id: s.metric, kind: s.kind, unit: s.unit, description: undefined, declared: false, series: [] };
      views.set(s.metric, view);
    }
    view.series.push({ attrs: s.attrs, last: s.last, time: s.time, count: s.count, sum: s.sum, min: s.min, max: s.max });
  }
  const metrics: MetricView[] = [...views.values()]
    .map((v) => ({ ...v, observed: v.series.length > 0, series: v.series.sort((a, b) => b.time - a.time) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { metrics, silent: metrics.filter((m) => m.declared && !m.observed).map((m) => m.id) };
}
