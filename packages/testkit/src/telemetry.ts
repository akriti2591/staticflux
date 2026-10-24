/**
 * Recording telemetry for tests: a real `createTelemetry` (default level `debug`,
 * deterministic span ids) with an attached memory sink, plus query helpers for
 * spans, events, metrics and conformance violations, and span-tree assertions.
 */
import {
  type AttrValue,
  type EventRecord,
  type LevelName,
  type MetricDefinition,
  type MetricRecord,
  type SpanEndRecord,
  type SpanStartRecord,
  type Subsystem,
  type Telemetry,
  type TelemetryRecord,
  type TelemetrySink,
  createMemorySink,
  createTelemetry,
} from '@staticflux/core';
import { SpanAssertionError, UnexpectedViolationsError } from './errors.js';

/** The conformance event name (R17.22); mirrors `@staticflux/perf` `VIOLATION_EVENT` without depending on it. */
export const VIOLATION_EVENT = 'violation' as const;

/** Deterministic PRNG (mulberry32). Same seed → same sequence. */
export function createSeededRandom(seed = 0x5f_37_59_df): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Filter for spans / events. A string matches the name. */
export interface RecordQuery {
  readonly name?: string | RegExp;
  readonly subsystem?: Subsystem | RegExp;
  /** Spans only. */
  readonly status?: SpanEndRecord['status'];
  /** Every listed attribute must be equal. */
  readonly attrs?: Readonly<Record<string, AttrValue>>;
}

export interface CollectedViolation {
  readonly code: string;
  readonly fix: string | undefined;
  readonly subsystem: Subsystem;
  readonly unit: string | undefined;
  readonly feature: string | undefined;
  readonly message: string | undefined;
  readonly attrs: EventRecord['attrs'];
}

export interface SpanNode {
  readonly name: string;
  readonly subsystem: Subsystem;
  /** `open` = started but never ended (a leak, or still running). */
  readonly status: SpanEndRecord['status'] | 'open';
  readonly attrs: SpanEndRecord['attrs'];
  readonly spanId: string;
  readonly children: readonly SpanNode[];
}

export interface TestTelemetry {
  readonly telemetry: Telemetry;
  readonly sink: TelemetrySink & { readonly records: TelemetryRecord[]; clear(): void };
  readonly records: readonly TelemetryRecord[];
  /** Ended spans, in end order. */
  spans(query?: string | RecordQuery): readonly SpanEndRecord[];
  /** Spans that started but never ended. */
  openSpans(query?: string | RecordQuery): readonly SpanStartRecord[];
  events(query?: string | RecordQuery): readonly EventRecord[];
  metrics(definition?: MetricDefinition): readonly MetricRecord[];
  violations(): readonly CollectedViolation[];
  /** Throws `SF-TEST-003` listing every violation. */
  expectNoViolations(): void;
  /** Forest of spans by parent id (open spans included), in start order. */
  spanTree(query?: string | RecordQuery): readonly SpanNode[];
  /** Indented `name [status]` lines — handy in failure messages and inline snapshots. */
  formatSpanTree(nodes?: readonly SpanNode[]): string;
  /** Assert that a `child` span ended with a `parent` span as its direct (or, with `deep`, any) ancestor. */
  expectChildSpan(parent: string | RecordQuery, child: string | RecordQuery, options?: { readonly deep?: boolean }): void;
  clear(): void;
  dispose(): void;
}

export interface TestTelemetryOptions {
  /** Default level for every subsystem (default `debug`). */
  readonly level?: LevelName;
  readonly levels?: Readonly<Partial<Record<Subsystem, LevelName>>>;
  readonly now?: () => number;
  readonly random?: () => number;
}

function normalize(query: string | RecordQuery | undefined): RecordQuery {
  if (query === undefined) return {};
  return typeof query === 'string' ? { name: query } : query;
}

function matchText(value: string, pattern: string | RegExp | undefined): boolean {
  if (pattern === undefined) return true;
  return typeof pattern === 'string' ? value === pattern : pattern.test(value);
}

function attrEqual(a: AttrValue | undefined, b: AttrValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

function matches(
  record: { readonly name: string; readonly subsystem: Subsystem; readonly attrs: Readonly<Record<string, AttrValue>>; readonly status?: string },
  query: RecordQuery,
): boolean {
  if (!matchText(record.name, query.name)) return false;
  if (!matchText(record.subsystem, query.subsystem)) return false;
  if (query.status !== undefined && record.status !== query.status) return false;
  for (const [key, value] of Object.entries(query.attrs ?? {})) if (!attrEqual(record.attrs[key], value)) return false;
  return true;
}

function describeQuery(query: string | RecordQuery): string {
  return typeof query === 'string' ? query : JSON.stringify({ ...query, name: query.name?.toString(), subsystem: query.subsystem?.toString() });
}

function str(value: AttrValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function createTestTelemetry(options: TestTelemetryOptions = {}): TestTelemetry {
  const telemetry = createTelemetry({
    defaultLevel: options.level ?? 'debug',
    random: options.random ?? createSeededRandom(),
    ...(options.levels === undefined ? {} : { levels: options.levels }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const sink = createMemorySink();
  const detach = telemetry.addSink(sink);

  const ended = (): SpanEndRecord[] => sink.records.filter((r): r is SpanEndRecord => r.type === 'span');
  const started = (): SpanStartRecord[] => sink.records.filter((r): r is SpanStartRecord => r.type === 'span-start');

  const buildTree = (): SpanNode[] => {
    const endById = new Map(ended().map((r) => [r.context.spanId, r]));
    const nodes = new Map<string, { node: SpanNode; children: SpanNode[]; parent: string | undefined }>();
    for (const start of started()) {
      const end = endById.get(start.context.spanId);
      const children: SpanNode[] = [];
      const node: SpanNode = {
        name: start.name,
        subsystem: start.subsystem,
        status: end?.status ?? 'open',
        attrs: end?.attrs ?? start.attrs,
        spanId: start.context.spanId,
        children,
      };
      nodes.set(start.context.spanId, { node, children, parent: start.parentSpanId });
    }
    const roots: SpanNode[] = [];
    for (const entry of nodes.values()) {
      const parent = entry.parent === undefined ? undefined : nodes.get(entry.parent);
      if (parent === undefined) roots.push(entry.node);
      else parent.children.push(entry.node);
    }
    return roots;
  };

  const flatten = (nodes: readonly SpanNode[], out: SpanNode[] = []): SpanNode[] => {
    for (const node of nodes) {
      out.push(node);
      flatten(node.children, out);
    }
    return out;
  };

  const nodeMatches = (node: SpanNode, query: RecordQuery): boolean =>
    matches({ name: node.name, subsystem: node.subsystem, attrs: node.attrs, status: node.status }, query);

  const format = (nodes: readonly SpanNode[], depth = 0): string =>
    nodes
      .map((node) => {
        const line = `${'  '.repeat(depth)}${node.name} [${node.status}]`;
        return node.children.length === 0 ? line : `${line}\n${format(node.children, depth + 1)}`;
      })
      .join('\n');

  const api: TestTelemetry = {
    telemetry,
    sink,
    get records() {
      return sink.records;
    },
    spans(query) {
      const q = normalize(query);
      return ended().filter((r) => matches(r, q));
    },
    openSpans(query) {
      const q = normalize(query);
      const done = new Set(ended().map((r) => r.context.spanId));
      return started().filter((r) => !done.has(r.context.spanId) && matches(r, q));
    },
    events(query) {
      const q = normalize(query);
      return sink.records.filter((r): r is EventRecord => r.type === 'event' && matches(r, q));
    },
    metrics(definition) {
      return sink.records.filter((r): r is MetricRecord => r.type === 'metric' && (definition === undefined || r.metric === definition.id));
    },
    violations() {
      return api.events(VIOLATION_EVENT).map((event) => ({
        code: str(event.attrs['code']) ?? 'unknown',
        fix: str(event.attrs['fix']),
        subsystem: event.subsystem,
        unit: str(event.attrs['unit']),
        feature: str(event.attrs['feature']),
        message: str(event.attrs['message']),
        attrs: event.attrs,
      }));
    },
    expectNoViolations() {
      const found = api.violations();
      if (found.length === 0) return;
      const lines = found.map((v) => `  ${v.code} (${v.subsystem}${v.unit === undefined ? '' : `, unit ${v.unit}`}): ${v.message ?? ''} — fix: ${v.fix ?? '?'}`);
      throw UnexpectedViolationsError({
        message: `Expected no violations, got ${found.length}:\n${lines.join('\n')}`,
        details: { violations: found.map((v) => v.code) },
      });
    },
    spanTree(query) {
      const roots = buildTree();
      if (query === undefined) return roots;
      const q = normalize(query);
      return flatten(roots).filter((node) => nodeMatches(node, q));
    },
    formatSpanTree(nodes) {
      return format(nodes ?? buildTree());
    },
    expectChildSpan(parent, child, assertOptions = {}) {
      const all = flatten(buildTree());
      const parentQuery = normalize(parent);
      const childQuery = normalize(child);
      const parents = all.filter((node) => nodeMatches(node, parentQuery));
      if (parents.length === 0) {
        throw SpanAssertionError({ message: `No span matches parent ${describeQuery(parent)}.\n${format(buildTree())}` });
      }
      const found = parents.some((node) =>
        (assertOptions.deep === true ? flatten(node.children) : node.children).some((c) => nodeMatches(c, childQuery)),
      );
      if (!found) {
        throw SpanAssertionError({
          message: `No span matching ${describeQuery(child)} is a ${assertOptions.deep === true ? 'descendant' : 'child'} of ${describeQuery(parent)}.\n${format(buildTree())}`,
        });
      }
    },
    clear() {
      sink.clear();
    },
    dispose() {
      detach();
    },
  };
  return api;
}
