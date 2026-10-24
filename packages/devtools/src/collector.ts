/**
 * The devtools collector: one `TelemetrySink` that keeps a bounded, structured
 * picture of what the fabric emitted — spans, the boot trace, lifecycle
 * transitions, gate decision events, conformance violations and metric values.
 *
 * Memory is bounded by ring buffers / bounded maps (see `CollectorCapacity`).
 * Nothing here runs unless the collector is attached (`telemetry.addSink`), so a
 * build that never imports devtools pays nothing (R17.3, R17.22).
 */
import type {
  AttrValue,
  Attrs,
  EventRecord,
  MetricKind,
  MetricRecord,
  SpanEndRecord,
  SpanStartRecord,
  TelemetryRecord,
  TelemetrySink,
} from '@staticflux/core';
import { createBoundedMap, createRingBuffer, type BoundedMap, type RingBuffer } from './ring.js';

export interface CollectorCapacity {
  /** Ended spans kept for journeys and ad-hoc inspection. */
  readonly spans: number;
  /** Non-lifecycle, non-violation events. */
  readonly events: number;
  /** Spans of the boot trace (kept separately so later traffic cannot evict the waterfall). */
  readonly bootSpans: number;
  /** Spans started but not yet ended. */
  readonly openSpans: number;
  readonly decisions: number;
  readonly violationGroups: number;
  readonly violationSamples: number;
  readonly lifecycleInstances: number;
  readonly lifecycleHistory: number;
  readonly metricSeries: number;
  readonly subsystems: number;
}

export const DEFAULT_CAPACITY: CollectorCapacity = {
  spans: 2000,
  events: 500,
  bootSpans: 1000,
  openSpans: 500,
  decisions: 200,
  violationGroups: 200,
  violationSamples: 5,
  lifecycleInstances: 500,
  lifecycleHistory: 20,
  metricSeries: 500,
  subsystems: 200,
};

/** Event name prefix of machine transitions (`lifecycle.<machine>.<from>→<to>`, LIFECYCLES §0). */
export const LIFECYCLE_PREFIX = 'lifecycle.' as const;
/** Gate decision-change event (gate/decisions). */
export const DECISION_EVENT = 'gate.decision-changed' as const;
/** Conformance stream event (perf `VIOLATION_EVENT`; any package may emit it). */
export const VIOLATION_EVENT_NAME = 'violation' as const;
/** Span names that root a boot trace, in preference order. */
export const BOOT_ROOT_SPANS = ['app.boot', 'di.critical'] as const;

/** Attribute keys that identify a lifecycle instance, in priority order. */
export const INSTANCE_ATTRS = ['subsystem', 'feature', 'worker', 'surface', 'store', 'unit', 'intent', 'key', 'trap', 'id'] as const;

// ---------------------------------------------------------------- record types

export interface LifecycleTransition {
  readonly from: string;
  readonly to: string;
  readonly event: string | undefined;
  readonly time: number;
}

export interface LifecycleEntry {
  readonly machine: string;
  readonly instance: string;
  readonly state: string;
  readonly since: number;
  readonly transitions: number;
  readonly history: readonly LifecycleTransition[];
  readonly invalid: number;
  readonly lastInvalid: { readonly state: string; readonly event: string; readonly time: number } | undefined;
  readonly attrs: Attrs;
}

export interface DecisionRecord {
  readonly time: number;
  readonly key: string;
  readonly level: string;
  readonly resourceId: string;
  readonly actionId: string;
  readonly subject: string;
  readonly effect: 'allow' | 'deny';
  readonly reason: string | undefined;
  readonly determining: readonly string[];
  /** Fact readings (only when the gate itself is bound). */
  readonly facts: readonly { readonly fact: string; readonly value: unknown }[] | undefined;
  readonly alternatives: readonly string[] | undefined;
  readonly source: 'event' | 'gate';
}

export interface ViolationSample {
  readonly time: number;
  readonly subsystem: string;
  readonly feature: string | undefined;
  readonly unit: string | undefined;
  readonly message: string | undefined;
  readonly details: string | undefined;
}

export interface ViolationGroup {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly count: number;
  readonly fix: string;
  readonly message: string | undefined;
  readonly features: readonly string[];
  readonly units: readonly string[];
  readonly subsystems: readonly string[];
  readonly firstAt: number;
  readonly lastAt: number;
  readonly samples: readonly ViolationSample[];
}

export interface MetricSeries {
  readonly metric: string;
  readonly kind: MetricKind;
  readonly unit: string | undefined;
  readonly attrs: Attrs;
  readonly last: number;
  readonly time: number;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
}

export interface BootTrace {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly spans: readonly SpanEndRecord[];
  readonly open: readonly SpanStartRecord[];
}

export interface DevtoolsCollector extends TelemetrySink {
  /** Bumped on every accepted record. */
  readonly revision: number;
  spans(): readonly SpanEndRecord[];
  openSpans(): readonly SpanStartRecord[];
  events(): readonly EventRecord[];
  bootTrace(): BootTrace | undefined;
  lifecycles(): readonly LifecycleEntry[];
  decisions(): readonly DecisionRecord[];
  /** Add a decision observed outside telemetry (e.g. `gate.onDecisionChange`). */
  recordDecision(record: DecisionRecord): void;
  /** When true, `gate.decision-changed` events are ignored (a bound gate reports richer records). */
  preferGateDecisions(enabled: boolean): void;
  violations(): readonly ViolationGroup[];
  violationCount(): number;
  metrics(): readonly MetricSeries[];
  /** Subsystems seen in records (for the verbosity settings). */
  subsystems(): readonly string[];
  onChange(listener: () => void): () => void;
  clear(): void;
}

// ---------------------------------------------------------------- parsing helpers

export interface ParsedTransition {
  readonly machine: string;
  readonly from: string;
  readonly to: string;
}

/** Parse `lifecycle.<machine>.<from>→<to>`; `undefined` for other names (incl. `lifecycle.<machine>.invalid`). */
export function parseLifecycleEvent(name: string): ParsedTransition | undefined {
  if (!name.startsWith(LIFECYCLE_PREFIX)) return undefined;
  const arrow = name.indexOf('→');
  if (arrow < 0) return undefined;
  const left = name.slice(LIFECYCLE_PREFIX.length, arrow);
  const to = name.slice(arrow + 1);
  const dot = left.lastIndexOf('.');
  if (dot <= 0 || to === '') return undefined;
  return { machine: left.slice(0, dot), from: left.slice(dot + 1), to };
}

/** Machine of a `lifecycle.<machine>.invalid` event (or `attrs.machine` for `lifecycle.invalid`). */
export function parseInvalidEvent(name: string, attrs: Attrs): string | undefined {
  if (name === 'lifecycle.invalid') return typeof attrs['machine'] === 'string' ? attrs['machine'] : 'unknown';
  if (!name.startsWith(LIFECYCLE_PREFIX) || !name.endsWith('.invalid')) return undefined;
  const machine = name.slice(LIFECYCLE_PREFIX.length, -'.invalid'.length);
  return machine === '' ? undefined : machine;
}

export function instanceOf(machine: string, attrs: Attrs): string {
  for (const key of INSTANCE_ATTRS) {
    const value = attrs[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return machine;
}

function str(value: AttrValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Split a decision key `level:resource:action` (resource ids may contain `:`). */
export function splitDecisionKey(key: string): { level: string; resourceId: string; actionId: string } {
  const parts = key.split(/[:\u0000]/);
  if (parts.length < 3) return { level: parts[0] ?? '', resourceId: parts[1] ?? '', actionId: '' };
  return { level: parts[0] as string, resourceId: parts.slice(1, -1).join(':'), actionId: parts[parts.length - 1] as string };
}

function seriesKey(metric: string, attrs: Attrs): string {
  const keys = Object.keys(attrs).sort();
  return `${metric}|${keys.map((k) => `${k}=${JSON.stringify(attrs[k])}`).join('&')}`;
}

// ---------------------------------------------------------------- collector

interface MutableLifecycle {
  machine: string;
  instance: string;
  state: string;
  since: number;
  transitions: number;
  history: RingBuffer<LifecycleTransition>;
  invalid: number;
  lastInvalid: { state: string; event: string; time: number } | undefined;
  attrs: Attrs;
}

interface MutableViolation {
  code: string;
  severity: 'error' | 'warning';
  count: number;
  fix: string;
  message: string | undefined;
  features: Set<string>;
  units: Set<string>;
  subsystems: Set<string>;
  firstAt: number;
  lastAt: number;
  samples: RingBuffer<ViolationSample>;
}

interface MutableSeries {
  metric: string;
  kind: MetricKind;
  unit: string | undefined;
  attrs: Attrs;
  last: number;
  time: number;
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface CollectorOptions {
  readonly capacity?: Partial<CollectorCapacity>;
}

export function createDevtoolsCollector(options: CollectorOptions = {}): DevtoolsCollector {
  const cap: CollectorCapacity = { ...DEFAULT_CAPACITY, ...options.capacity };
  const spans = createRingBuffer<SpanEndRecord>(cap.spans);
  const events = createRingBuffer<EventRecord>(cap.events);
  const open = createBoundedMap<string, SpanStartRecord>(cap.openSpans);
  const decisions = createRingBuffer<DecisionRecord>(cap.decisions);
  const lifecycles = createBoundedMap<string, MutableLifecycle>(cap.lifecycleInstances);
  const violations = createBoundedMap<string, MutableViolation>(cap.violationGroups);
  const series = createBoundedMap<string, MutableSeries>(cap.metricSeries);
  const subsystems = createBoundedMap<string, true>(cap.subsystems);
  const listeners = new Set<() => void>();
  let boot: { traceId: string; rootSpanId: string; spans: RingBuffer<SpanEndRecord> } | undefined;
  let violationTotal = 0;
  let revision = 0;
  let gateDecisions = false;

  const lifecycleFor = (machine: string, instance: string, time: number): MutableLifecycle => {
    const key = `${machine}\u0000${instance}`;
    let entry = lifecycles.get(key);
    if (entry === undefined) {
      entry = {
        machine,
        instance,
        state: '',
        since: time,
        transitions: 0,
        history: createRingBuffer(cap.lifecycleHistory),
        invalid: 0,
        lastInvalid: undefined,
        attrs: {},
      };
    }
    lifecycles.set(key, entry); // touch (LRU)
    return entry;
  };

  const onSpanStart = (record: SpanStartRecord): void => {
    open.set(record.context.spanId, record);
    const isBootRoot =
      record.parentSpanId === undefined &&
      (record.name === BOOT_ROOT_SPANS[0] || (record.name === BOOT_ROOT_SPANS[1] && boot === undefined));
    // `app.boot` always starts a new boot trace; a bare `di.critical` root (no bootApp) only when none exists.
    if (isBootRoot) boot = { traceId: record.context.traceId, rootSpanId: record.context.spanId, spans: createRingBuffer(cap.bootSpans) };
  };

  const onSpanEnd = (record: SpanEndRecord): void => {
    open.delete(record.context.spanId);
    spans.push(record);
    if (boot !== undefined && record.context.traceId === boot.traceId) boot.spans.push(record);
    else if (boot === undefined && record.parentSpanId === undefined && (BOOT_ROOT_SPANS as readonly string[]).includes(record.name)) {
      // Span-start was lost (e.g. buffer overflow before attach): adopt the ended root.
      boot = { traceId: record.context.traceId, rootSpanId: record.context.spanId, spans: createRingBuffer(cap.bootSpans) };
      boot.spans.push(record);
    }
  };

  const onViolation = (record: EventRecord): void => {
    const a = record.attrs;
    const code = str(a['code']);
    if (code === undefined) return;
    violationTotal += 1;
    let group = violations.get(code);
    if (group === undefined) {
      group = {
        code,
        severity: 'warning',
        count: 0,
        fix: '',
        message: undefined,
        features: new Set(),
        units: new Set(),
        subsystems: new Set(),
        firstAt: record.time,
        lastAt: record.time,
        samples: createRingBuffer(cap.violationSamples),
      };
    }
    violations.set(code, group);
    group.count += 1;
    if (a['severity'] !== 'warning') group.severity = 'error';
    const fix = str(a['fix']);
    if (fix !== undefined && fix !== '') group.fix = fix;
    const message = str(a['message']);
    if (message !== undefined) group.message = message;
    const feature = str(a['feature']);
    const unitId = str(a['unit']);
    if (feature !== undefined && group.features.size < 50) group.features.add(feature);
    if (unitId !== undefined && group.units.size < 50) group.units.add(unitId);
    if (group.subsystems.size < 50) group.subsystems.add(record.subsystem);
    group.lastAt = record.time;
    group.samples.push({ time: record.time, subsystem: record.subsystem, feature, unit: unitId, message, details: str(a['details']) });
  };

  const onEvent = (record: EventRecord): boolean => {
    if (record.name === VIOLATION_EVENT_NAME) {
      onViolation(record);
      return true;
    }
    const transition = parseLifecycleEvent(record.name);
    if (transition !== undefined) {
      const instance = instanceOf(transition.machine, record.attrs);
      const entry = lifecycleFor(transition.machine, instance, record.time);
      entry.state = transition.to;
      entry.since = record.time;
      entry.transitions += 1;
      entry.attrs = record.attrs;
      entry.history.push({ from: transition.from, to: transition.to, event: str(record.attrs['event']), time: record.time });
      return true;
    }
    const invalidMachine = parseInvalidEvent(record.name, record.attrs);
    if (invalidMachine !== undefined) {
      const entry = lifecycleFor(invalidMachine, instanceOf(invalidMachine, record.attrs), record.time);
      entry.invalid += 1;
      entry.lastInvalid = { state: str(record.attrs['state']) ?? '?', event: str(record.attrs['event']) ?? '?', time: record.time };
      if (entry.state === '' && entry.lastInvalid.state !== '?') entry.state = entry.lastInvalid.state;
      return true;
    }
    if (record.name === DECISION_EVENT) {
      if (gateDecisions) return false;
      const key = str(record.attrs['key']) ?? '';
      const parts = splitDecisionKey(key);
      const policies = record.attrs['policies'];
      decisions.push({
        time: record.time,
        key,
        ...parts,
        subject: str(record.attrs['subject']) ?? 'principal',
        effect: record.attrs['effect'] === 'deny' ? 'deny' : 'allow',
        reason: str(record.attrs['reason']),
        determining: Array.isArray(policies) ? policies.map(String) : [],
        facts: undefined,
        alternatives: undefined,
        source: 'event',
      });
      return true;
    }
    events.push(record);
    return true;
  };

  const onMetric = (record: MetricRecord): void => {
    const key = seriesKey(record.metric, record.attrs);
    const existing = series.get(key);
    if (existing === undefined) {
      series.set(key, {
        metric: record.metric,
        kind: record.kind,
        unit: record.unit,
        attrs: record.attrs,
        last: record.value,
        time: record.time,
        count: 1,
        sum: record.value,
        min: record.value,
        max: record.value,
      });
      return;
    }
    existing.last = record.value;
    existing.time = record.time;
    existing.count += 1;
    existing.sum += record.value;
    existing.min = Math.min(existing.min, record.value);
    existing.max = Math.max(existing.max, record.value);
    series.set(key, existing);
  };

  const changed = (): void => {
    revision += 1;
    for (const listener of [...listeners]) listener();
  };

  const collector: DevtoolsCollector = {
    get revision() {
      return revision;
    },
    receive(record: TelemetryRecord) {
      if (record.type !== 'metric') subsystems.set(record.subsystem, true);
      switch (record.type) {
        case 'span-start':
          onSpanStart(record);
          break;
        case 'span':
          onSpanEnd(record);
          break;
        case 'event':
          if (!onEvent(record)) return;
          break;
        case 'metric':
          onMetric(record);
          break;
      }
      changed();
    },
    spans: () => spans.toArray(),
    openSpans: () => open.values(),
    events: () => events.toArray(),
    bootTrace() {
      if (boot === undefined) return undefined;
      const traceId = boot.traceId;
      return {
        traceId,
        rootSpanId: boot.rootSpanId,
        spans: boot.spans.toArray(),
        open: open.values().filter((s) => s.context.traceId === traceId),
      };
    },
    lifecycles: () =>
      lifecycles.values().map((e) => ({
        machine: e.machine,
        instance: e.instance,
        state: e.state,
        since: e.since,
        transitions: e.transitions,
        history: e.history.toArray(),
        invalid: e.invalid,
        lastInvalid: e.lastInvalid,
        attrs: e.attrs,
      })),
    decisions: () => decisions.toArray(),
    recordDecision(record) {
      decisions.push(record);
      changed();
    },
    preferGateDecisions(enabled) {
      gateDecisions = enabled;
    },
    violations: () =>
      violations.values().map((g) => ({
        code: g.code,
        severity: g.severity,
        count: g.count,
        fix: g.fix,
        message: g.message,
        features: [...g.features],
        units: [...g.units],
        subsystems: [...g.subsystems],
        firstAt: g.firstAt,
        lastAt: g.lastAt,
        samples: g.samples.toArray(),
      })),
    violationCount: () => violationTotal,
    metrics: () => series.values().map((s) => ({ ...s })),
    subsystems: () => subsystems.entries().map(([k]) => k).sort(),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      spans.clear();
      events.clear();
      open.clear();
      decisions.clear();
      lifecycles.clear();
      violations.clear();
      series.clear();
      violationTotal = 0;
      boot = undefined;
      changed();
    },
  };
  return collector;
}
