/**
 * Journey tracing (R17.5–R17.9, R12.6). One journey per navigation, from first input
 * to feature complete, assembled from core telemetry spans (the tracker is a
 * `TelemetrySink`): phases `app.boot` → `nav.pipeline` → `feature` → `view`, each
 * with total time and critical path; feature marks; classification
 * (start cold|warm|soft, activation fresh|warm|archived, code network|http-cache|sw,
 * data network|cache|snapshot).
 *
 * Span conventions consumed (emitted by runtime/router/loader/data):
 * - `app.boot` (runtime) starts a cold journey (`attrs.warm: true` → warm start).
 * - `nav.pipeline` (router) starts a soft journey, or joins the boot journey if it is
 *   the first navigation; `attrs.route` names it. Stage spans are its children.
 * - `feature.*` (runtime feature host; `feature.activate` carries `activation`).
 * - `view.*` (sub-route transitions); `chunk.load` (`codeSource`); `data/request` (`dataSource`).
 * Spans without a name rule inherit their parent's phase.
 *
 * Journey lifecycle (machine `perf/journey`): open → complete | superseded | abandoned | ended.
 */
import {
  type AttrValue,
  createMachine,
  defineMachine,
  type Machine,
  type MetricRecord,
  type SpanEndRecord,
  type Telemetry,
  type TelemetryRecord,
  type TelemetrySink,
} from '@staticflux/core';
import { FEATURE_MARKS, type FeatureMark, featureMarkMetrics, PERF_SUBSYSTEMS, perfMetrics } from './telemetry.js';

export const JOURNEY_PHASES = ['app.boot', 'nav.pipeline', 'feature', 'view'] as const;
export type JourneyPhase = (typeof JOURNEY_PHASES)[number];

export type JourneyStart = 'cold' | 'warm' | 'soft';
export type ActivationClass = 'fresh' | 'warm' | 'archived';
export type CodeSourceClass = 'network' | 'http-cache' | 'sw';
export type DataSourceClass = 'network' | 'cache' | 'snapshot';

export const journeyMachine = defineMachine({
  id: 'perf/journey',
  initial: 'open',
  states: ['open', 'complete', 'superseded', 'abandoned', 'ended'],
  transitions: {
    open: { complete: 'complete', supersede: 'superseded', abandon: 'abandoned', end: 'ended' },
  },
  terminal: ['complete', 'superseded', 'abandoned', 'ended'],
});

export type JourneyOutcome = Exclude<(typeof journeyMachine.states)[number], 'open'>;

export interface CriticalStep {
  readonly name: string;
  readonly spanId: string;
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  /** Nesting depth below the phase root (0 = top-level span of the phase). */
  readonly depth: number;
}

export interface PhaseSummary {
  readonly phase: JourneyPhase;
  readonly start: number;
  readonly end: number;
  /** Wall time from the first span start to the last span end in this phase. */
  readonly total: number;
  /** Chain of spans that determined the phase end (parallel siblings off-path are excluded). */
  readonly criticalPath: readonly CriticalStep[];
  readonly spanCount: number;
}

export interface MarkRecord {
  /** ms since journey start. */
  readonly value: number;
  readonly method: string;
}

export interface JourneyClassification {
  readonly start: JourneyStart;
  readonly activation: ActivationClass | undefined;
  readonly code: CodeSourceClass | undefined;
  readonly data: DataSourceClass | undefined;
}

export interface JourneySummary {
  readonly id: string;
  readonly route: string | undefined;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly duration: number;
  readonly outcome: JourneyOutcome;
  readonly classification: JourneyClassification;
  readonly phases: readonly PhaseSummary[];
  /** feature → mark → record. */
  readonly marks: Readonly<Record<string, Partial<Record<FeatureMark, MarkRecord>>>>;
  readonly spans: readonly SpanEndRecord[];
}

export interface BeginOptions {
  readonly start: JourneyStart;
  readonly route?: string;
  /** Start time (default now): e.g. the input event timestamp. */
  readonly at?: number;
}

/** Rule mapping a span to a phase by name; `undefined` = inherit from parent. */
export type PhaseRule = (span: Pick<SpanEndRecord, 'name' | 'subsystem' | 'attrs'>) => JourneyPhase | undefined;

export const defaultPhaseRule: PhaseRule = ({ name }) => {
  if (name === 'app.boot' || name.startsWith('boot.')) return 'app.boot';
  if (name === 'nav.pipeline' || name.startsWith('nav.') || name.startsWith('stage.')) return 'nav.pipeline';
  if (name.startsWith('feature.')) return 'feature';
  if (name.startsWith('view.')) return 'view';
  return undefined;
};

export type CompletionPolicy = 'all-features' | 'manual';

export interface JourneyTrackerOptions {
  readonly telemetry: Telemetry;
  readonly phaseRule?: PhaseRule;
  /** `all-features` (default): the journey completes when every feature that marked has marked `complete`. */
  readonly completion?: CompletionPolicy;
  /** Span names that start journeys automatically. */
  readonly bootSpan?: string;
  readonly navigationSpan?: string;
  /** Summaries kept in `history` (default 20). */
  readonly historyLimit?: number;
  /** Max spans buffered per journey (default 2000). */
  readonly spanLimit?: number;
}

export interface JourneyTracker extends TelemetrySink {
  begin(options: BeginOptions): string;
  /** End the open journey (default outcome `ended`). */
  end(outcome?: Exclude<JourneyOutcome, 'superseded'>): JourneySummary | undefined;
  readonly current: { readonly id: string; readonly start: JourneyStart; readonly startedAt: number; readonly route: string | undefined } | undefined;
  readonly history: readonly JourneySummary[];
  onJourney(listener: (summary: JourneySummary) => void): () => void;
}

interface OpenJourney {
  readonly id: string;
  readonly machine: Machine<'open' | JourneyOutcome, 'complete' | 'supersede' | 'abandon' | 'end'>;
  start: JourneyStart;
  route: string | undefined;
  readonly startedAt: number;
  readonly spans: SpanEndRecord[];
  readonly marks: Record<string, Partial<Record<FeatureMark, MarkRecord>>>;
  navigated: boolean;
}

const markByMetric = new Map<string, FeatureMark>(FEATURE_MARKS.map((m) => [featureMarkMetrics[m].id, m]));

/** Critical path through a set of spans (with parent links), recursively expanded. */
export function criticalPath(spans: readonly SpanEndRecord[]): readonly CriticalStep[] {
  const ids = new Set(spans.map((s) => s.context.spanId));
  const childrenOf = new Map<string | undefined, SpanEndRecord[]>();
  for (const span of spans) {
    const parent = span.parentSpanId !== undefined && ids.has(span.parentSpanId) ? span.parentSpanId : undefined;
    const list = childrenOf.get(parent) ?? [];
    list.push(span);
    childrenOf.set(parent, list);
  }
  const out: CriticalStep[] = [];
  const walk = (siblings: readonly SpanEndRecord[], depth: number, limit: number): void => {
    const chain: SpanEndRecord[] = [];
    let candidates = siblings.filter((s) => s.end <= limit);
    let current = candidates.reduce<SpanEndRecord | undefined>((best, s) => (best === undefined || s.end > best.end ? s : best), undefined);
    while (current !== undefined) {
      chain.unshift(current);
      const startOfCurrent = current.start;
      candidates = candidates.filter((s) => s !== current && s.end <= startOfCurrent);
      current = candidates.reduce<SpanEndRecord | undefined>((best, s) => (best === undefined || s.end > best.end ? s : best), undefined);
    }
    for (const span of chain) {
      out.push({ name: span.name, spanId: span.context.spanId, start: span.start, end: span.end, duration: span.duration, depth });
      const children = childrenOf.get(span.context.spanId);
      if (children !== undefined) walk(children, depth + 1, span.end);
    }
  };
  walk(childrenOf.get(undefined) ?? [], 0, Number.POSITIVE_INFINITY);
  return out;
}

function worst<T extends string>(values: readonly (AttrValue | undefined)[], order: readonly T[]): T | undefined {
  let best: number | undefined;
  for (const value of values) {
    const index = order.indexOf(value as T);
    if (index >= 0 && (best === undefined || index < best)) best = index;
  }
  return best === undefined ? undefined : order[best];
}

export function createJourneyTracker(options: JourneyTrackerOptions): JourneyTracker {
  const { telemetry } = options;
  const phaseRule = options.phaseRule ?? defaultPhaseRule;
  const completion = options.completion ?? 'all-features';
  const bootSpan = options.bootSpan ?? 'app.boot';
  const navigationSpan = options.navigationSpan ?? 'nav.pipeline';
  const historyLimit = options.historyLimit ?? 20;
  const spanLimit = options.spanLimit ?? 2_000;
  const history: JourneySummary[] = [];
  const listeners = new Set<(summary: JourneySummary) => void>();
  let open: OpenJourney | undefined;
  let counter = 0;

  const summarize = (journey: OpenJourney, outcome: JourneyOutcome, endedAt: number): JourneySummary => {
    const byId = new Map(journey.spans.map((s) => [s.context.spanId, s]));
    const phaseCache = new Map<string, JourneyPhase | undefined>();
    const phaseOf = (span: SpanEndRecord, depth = 0): JourneyPhase | undefined => {
      const cached = phaseCache.get(span.context.spanId);
      if (cached !== undefined || phaseCache.has(span.context.spanId)) return cached;
      let phase = phaseRule(span);
      if (phase === undefined && span.parentSpanId !== undefined && depth < 64) {
        const parent = byId.get(span.parentSpanId);
        if (parent !== undefined) phase = phaseOf(parent, depth + 1);
      }
      phaseCache.set(span.context.spanId, phase);
      return phase;
    };
    const grouped = new Map<JourneyPhase, SpanEndRecord[]>();
    for (const span of journey.spans) {
      const phase = phaseOf(span);
      if (phase === undefined) continue;
      const list = grouped.get(phase) ?? [];
      list.push(span);
      grouped.set(phase, list);
    }
    const phases: PhaseSummary[] = [];
    for (const phase of JOURNEY_PHASES) {
      const spans = grouped.get(phase);
      if (spans === undefined || spans.length === 0) continue;
      const start = Math.min(...spans.map((s) => s.start));
      const end = Math.max(...spans.map((s) => s.end));
      phases.push({ phase, start, end, total: end - start, criticalPath: criticalPath(spans), spanCount: spans.length });
    }
    const activationSpan = journey.spans.find((s) => s.name === 'feature.activate');
    const activation = worst<ActivationClass>([activationSpan?.attrs['activation']], ['archived', 'warm', 'fresh']);
    const code = worst<CodeSourceClass>(
      journey.spans.filter((s) => s.name === 'chunk.load').map((s) => s.attrs['codeSource']),
      ['network', 'sw', 'http-cache'],
    );
    const dataValues = journey.spans.map((s) => s.attrs['dataSource']);
    if (activation === 'archived') dataValues.push('snapshot');
    const data = worst<DataSourceClass>(dataValues, ['network', 'cache', 'snapshot']);
    return {
      id: journey.id,
      route: journey.route,
      startedAt: journey.startedAt,
      endedAt,
      duration: endedAt - journey.startedAt,
      outcome,
      classification: { start: journey.start, activation, code, data },
      phases,
      marks: journey.marks,
      spans: journey.spans,
    };
  };

  const close = (outcome: JourneyOutcome, at: number): JourneySummary | undefined => {
    const journey = open;
    if (journey === undefined) return undefined;
    const event = ({ complete: 'complete', superseded: 'supersede', abandoned: 'abandon', ended: 'end' } as const)[outcome];
    if (!journey.machine.send(event).ok) return undefined;
    open = undefined;
    const summary = summarize(journey, outcome, at);
    history.push(summary);
    if (history.length > historyLimit) history.shift();
    const attrs: Record<string, AttrValue> = {
      journey: summary.id,
      start: summary.classification.start,
      outcome,
      duration: summary.duration,
      route: summary.route ?? '',
      activation: summary.classification.activation ?? '',
      code: summary.classification.code ?? '',
      data: summary.classification.data ?? '',
    };
    for (const phase of summary.phases) {
      attrs[`phase.${phase.phase}`] = phase.total;
      telemetry.record(perfMetrics.phaseDuration, phase.total, { phase: phase.phase, start: summary.classification.start });
    }
    telemetry.event('journey.summary', { subsystem: PERF_SUBSYSTEMS.journey, level: 'critical', attrs });
    telemetry.record(perfMetrics.journeyDuration, summary.duration, { start: summary.classification.start, outcome });
    for (const listener of [...listeners]) listener(summary);
    return summary;
  };

  const begin = (beginOptions: BeginOptions): string => {
    const at = beginOptions.at ?? telemetry.now();
    close('superseded', at);
    counter += 1;
    const id = `journey-${counter}`;
    open = {
      id,
      machine: createMachine(journeyMachine),
      start: beginOptions.start,
      route: beginOptions.route,
      startedAt: at,
      spans: [],
      marks: {},
      navigated: false,
    };
    telemetry.event('journey.begin', { subsystem: PERF_SUBSYSTEMS.journey, level: 'standard', attrs: { journey: id, start: beginOptions.start, route: beginOptions.route ?? '' } });
    return id;
  };

  const onMark = (record: MetricRecord, mark: FeatureMark): void => {
    const journey = open;
    if (journey === undefined) return;
    const feature = record.attrs['feature'];
    if (typeof feature !== 'string') return;
    const at = typeof record.attrs['at'] === 'number' ? record.attrs['at'] : record.time;
    const method = typeof record.attrs['method'] === 'string' ? record.attrs['method'] : 'unknown';
    const marks = (journey.marks[feature] ??= {});
    if (marks[mark] === undefined || mark === 'largestRender') marks[mark] = { value: Math.max(0, at - journey.startedAt), method };
    if (completion === 'all-features' && mark === 'complete') {
      const all = Object.values(journey.marks).every((m) => m.complete !== undefined);
      if (all) close('complete', at);
    }
  };

  return {
    begin,
    end(outcome = 'ended') {
      return close(outcome, telemetry.now());
    },
    get current() {
      return open === undefined ? undefined : { id: open.id, start: open.start, startedAt: open.startedAt, route: open.route };
    },
    history,
    onJourney(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive(record: TelemetryRecord) {
      if (record.type === 'span-start') {
        if (record.name === bootSpan) {
          if (open === undefined) begin({ start: record.attrs['warm'] === true ? 'warm' : 'cold', at: record.start });
        } else if (record.name === navigationSpan) {
          const route = typeof record.attrs['route'] === 'string' ? record.attrs['route'] : undefined;
          if (open !== undefined && !open.navigated && open.start !== 'soft') {
            open.navigated = true;
            open.route ??= route;
          } else {
            // A journey starts at the first input when the router passes it (`attrs.inputAt`).
            const inputAt = record.attrs['inputAt'];
            begin({ start: 'soft', at: typeof inputAt === 'number' ? inputAt : record.start, ...(route === undefined ? {} : { route }) });
            if (open !== undefined) (open as OpenJourney).navigated = true;
          }
        }
        return;
      }
      if (record.type === 'span') {
        if (open !== undefined && open.spans.length < spanLimit && record.end >= open.startedAt) open.spans.push(record);
        return;
      }
      if (record.type === 'metric') {
        const mark = markByMetric.get(record.metric);
        if (mark !== undefined) onMark(record, mark);
      }
    },
  };
}
