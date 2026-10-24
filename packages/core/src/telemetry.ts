/**
 * Vendor-neutral telemetry fabric (OpenTelemetry-shaped). Framework primitives
 * emit spans, events and metrics here automatically; sinks (console, devtools,
 * OTel exporter, …) decide where records go. Nothing is wired by hand.
 *
 * Verbosity is per subsystem: off < critical < standard < verbose < debug.
 * Disabled spans are a shared no-op object (no allocation, no work).
 */
import type { SfError } from './errors.js';

export const Level = { off: 0, critical: 1, standard: 2, verbose: 3, debug: 4 } as const;
export type LevelName = keyof typeof Level;

/** Subsystem name, namespaced like tokens (e.g. `core/di`, `router/pipeline`, `feature/studio`). */
export type Subsystem = `${string}/${string}`;

export type AttrValue = string | number | boolean | null | readonly (string | number | boolean)[];
export type Attrs = Readonly<Record<string, AttrValue>>;

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

export type SpanStatus = 'ok' | 'error' | 'cancelled';

export interface SpanStartRecord {
  readonly type: 'span-start';
  readonly name: string;
  readonly subsystem: Subsystem;
  readonly level: LevelName;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  readonly start: number;
  readonly attrs: Attrs;
}

export interface SpanEndRecord {
  readonly type: 'span';
  readonly name: string;
  readonly subsystem: Subsystem;
  readonly level: LevelName;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  readonly attrs: Attrs;
  readonly status: SpanStatus;
  readonly error: Readonly<Record<string, unknown>> | undefined;
}

export interface EventRecord {
  readonly type: 'event';
  readonly name: string;
  readonly subsystem: Subsystem;
  readonly level: LevelName;
  readonly time: number;
  readonly attrs: Attrs;
  readonly traceId: string | undefined;
  readonly spanId: string | undefined;
}

export interface MetricRecord {
  readonly type: 'metric';
  readonly metric: MetricId;
  readonly kind: MetricKind;
  readonly unit: string | undefined;
  readonly value: number;
  readonly time: number;
  readonly attrs: Attrs;
  readonly traceId: string | undefined;
}

export type TelemetryRecord = SpanStartRecord | SpanEndRecord | EventRecord | MetricRecord;

export interface TelemetrySink {
  receive(record: TelemetryRecord): void;
}

// ---------------------------------------------------------------- metrics

export type MetricId = `${string}/${string}`;
export type MetricKind = 'counter' | 'histogram' | 'gauge' | 'mark';

export interface MetricDefinition<K extends MetricKind = MetricKind, Id extends MetricId = MetricId> {
  readonly kind: 'metric';
  readonly metricKind: K;
  readonly id: Id;
  readonly unit: string | undefined;
  readonly description: string | undefined;
}

interface MetricOptions {
  readonly unit?: string;
  readonly description?: string;
}

function defineMetric<K extends MetricKind, const Id extends MetricId>(
  metricKind: K,
  id: Id,
  options: MetricOptions,
): MetricDefinition<K, Id> {
  return Object.freeze({ kind: 'metric', metricKind, id, unit: options.unit, description: options.description });
}

/**
 * Declare metrics as typed values. Producers declare `informs: [metric]`,
 * consumers declare `reads: [metric]`; the graph tool checks both sides.
 */
export const metric = {
  counter: <const Id extends MetricId>(id: Id, options: MetricOptions = {}) => defineMetric('counter', id, options),
  histogram: <const Id extends MetricId>(id: Id, options: MetricOptions = {}) => defineMetric('histogram', id, options),
  gauge: <const Id extends MetricId>(id: Id, options: MetricOptions = {}) => defineMetric('gauge', id, options),
  /** A point-in-time mark (e.g. `feature.first-render`); value is the timestamp offset in ms. */
  mark: <const Id extends MetricId>(id: Id, options: MetricOptions = {}) =>
    defineMetric('mark', id, { unit: 'ms', ...options }),
} as const;

// ---------------------------------------------------------------- spans

export interface Span {
  /** Undefined for no-op spans. */
  readonly context: SpanContext | undefined;
  readonly recording: boolean;
  set(key: string, value: AttrValue): void;
  event(name: string, attrs?: Attrs): void;
  end(status?: SpanStatus, error?: SfError): void;
}

export interface SpanOptions {
  readonly subsystem: Subsystem;
  readonly level?: LevelName;
  readonly attrs?: Attrs;
  /** Parent span or remote context (e.g. parsed from a worker envelope's traceparent). */
  readonly parent?: Span | SpanContext | undefined;
}

export interface EventOptions {
  readonly subsystem: Subsystem;
  readonly level?: LevelName;
  readonly attrs?: Attrs;
  readonly parent?: Span | SpanContext | undefined;
}

export interface Telemetry {
  enabled(subsystem: Subsystem, level: LevelName): boolean;
  span(name: string, options: SpanOptions): Span;
  event(name: string, options: EventOptions): void;
  record(definition: MetricDefinition, value: number, attrs?: Attrs, parent?: Span | SpanContext): void;
  /** Change verbosity at runtime. `'*'` sets the default. */
  setLevel(subsystem: Subsystem | '*', level: LevelName): void;
  addSink(sink: TelemetrySink): () => void;
  now(): number;
}

export interface TelemetryOptions {
  readonly defaultLevel?: LevelName;
  readonly levels?: Readonly<Partial<Record<Subsystem, LevelName>>>;
  /** Probability [0,1] that a new trace records non-critical spans. Default 1. */
  readonly sampleRate?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  /** Records buffered before the first sink attaches. Default 1000. */
  readonly bufferLimit?: number;
}

const NOOP_SPAN: Span = Object.freeze({
  context: undefined,
  recording: false,
  set: () => undefined,
  event: () => undefined,
  end: () => undefined,
});

function randomHex(bytes: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < bytes; i += 1) out += Math.floor(random() * 256).toString(16).padStart(2, '0');
  return out;
}

function contextOf(parent: Span | SpanContext | undefined): SpanContext | undefined {
  if (parent === undefined) return undefined;
  if ('traceId' in parent) return parent;
  return parent.context;
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const levels = new Map<string, number>(
    Object.entries(options.levels ?? {}).map(([k, v]) => [k, Level[v as LevelName]]),
  );
  let defaultLevel: number = Level[options.defaultLevel ?? 'standard'];
  const sampleRate = options.sampleRate ?? 1;
  const now = options.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
  const random = options.random ?? Math.random;
  const bufferLimit = options.bufferLimit ?? 1000;
  const sinks = new Set<TelemetrySink>();
  const buffer: TelemetryRecord[] = [];

  const emit = (record: TelemetryRecord): void => {
    if (sinks.size === 0) {
      if (buffer.length < bufferLimit) buffer.push(record);
      return;
    }
    for (const sink of sinks) sink.receive(record);
  };

  const levelFor = (subsystem: string): number => {
    const exact = levels.get(subsystem);
    if (exact !== undefined) return exact;
    const prefix = levels.get(`${subsystem.split('/')[0] ?? ''}/*`);
    return prefix ?? defaultLevel;
  };

  const enabled = (subsystem: Subsystem, level: LevelName): boolean =>
    Level[level] !== Level.off && Level[level] <= levelFor(subsystem);

  const telemetry: Telemetry = {
    enabled,
    now,
    span(name, spanOptions) {
      const level = spanOptions.level ?? 'standard';
      if (!enabled(spanOptions.subsystem, level)) return NOOP_SPAN;
      const parent = contextOf(spanOptions.parent);
      const sampled = parent?.sampled ?? random() < sampleRate;
      if (!sampled && level !== 'critical') return NOOP_SPAN;
      const context: SpanContext = {
        traceId: parent?.traceId ?? randomHex(16, random),
        spanId: randomHex(8, random),
        sampled,
      };
      const start = now();
      const attrs: Record<string, AttrValue> = { ...spanOptions.attrs };
      let ended = false;
      emit({
        type: 'span-start',
        name,
        subsystem: spanOptions.subsystem,
        level,
        context,
        parentSpanId: parent?.spanId,
        start,
        attrs: { ...attrs },
      });
      return {
        context,
        recording: true,
        set(key, value) {
          attrs[key] = value;
        },
        event(eventName, eventAttrs = {}) {
          emit({
            type: 'event',
            name: eventName,
            subsystem: spanOptions.subsystem,
            level,
            time: now(),
            attrs: eventAttrs,
            traceId: context.traceId,
            spanId: context.spanId,
          });
        },
        end(status = 'ok', error) {
          if (ended) return;
          ended = true;
          const end = now();
          emit({
            type: 'span',
            name,
            subsystem: spanOptions.subsystem,
            level,
            context,
            parentSpanId: parent?.spanId,
            start,
            end,
            duration: end - start,
            attrs: { ...attrs },
            status,
            error: error?.toJSON(),
          });
        },
      };
    },
    event(name, eventOptions) {
      const level = eventOptions.level ?? 'standard';
      if (!enabled(eventOptions.subsystem, level)) return;
      const parent = contextOf(eventOptions.parent);
      emit({
        type: 'event',
        name,
        subsystem: eventOptions.subsystem,
        level,
        time: now(),
        attrs: eventOptions.attrs ?? {},
        traceId: parent?.traceId,
        spanId: parent?.spanId,
      });
    },
    record(definition, value, attrs = {}, parent) {
      emit({
        type: 'metric',
        metric: definition.id,
        kind: definition.metricKind,
        unit: definition.unit,
        value,
        time: now(),
        attrs,
        traceId: contextOf(parent)?.traceId,
      });
    },
    setLevel(subsystem, level) {
      if (subsystem === '*') defaultLevel = Level[level];
      else levels.set(subsystem, Level[level]);
    },
    addSink(sink) {
      sinks.add(sink);
      if (buffer.length > 0) {
        for (const record of buffer.splice(0)) sink.receive(record);
      }
      return () => {
        sinks.delete(sink);
      };
    },
  };
  return telemetry;
}

/** A telemetry instance that records nothing (default for tests and `off`). */
export function createNoopTelemetry(): Telemetry {
  return createTelemetry({ defaultLevel: 'off', bufferLimit: 0 });
}

/** W3C Trace Context `traceparent` header value. */
export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

export function parseTraceparent(value: string): SpanContext | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (match === null) return undefined;
  const [, traceId, spanId, flags] = match;
  if (traceId === undefined || spanId === undefined || flags === undefined) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** In-memory sink for tests and devtools. */
export function createMemorySink(): TelemetrySink & { readonly records: TelemetryRecord[]; clear(): void } {
  const records: TelemetryRecord[] = [];
  return {
    records,
    receive(record) {
      records.push(record);
    },
    clear() {
      records.length = 0;
    },
  };
}
