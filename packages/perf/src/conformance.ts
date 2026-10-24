/**
 * Conformance stream (R17.22). Every runtime rule violation is ONE typed telemetry
 * event named `violation` with a stable catalog code, attributed feature/unit, and fix.
 *
 * Contract for other packages (no perf dependency needed): emit
 *   telemetry.event('violation', { subsystem, level: 'critical',
 *     attrs: { code, fix, feature?, unit?, message?, severity?, details? (JSON string) } })
 * `reportViolation` does exactly this; the collector accepts it from any subsystem.
 *
 * Consumers: devtools overlay (dev), CI e2e/lab runs (`collector.check(baseline)` fails
 * on new violations), sampled reporting in production (`sampleRate`).
 */
import {
  type Attrs,
  type AttrValue,
  type ErrorCode,
  type ErrorDefinition,
  err,
  ok,
  type Result,
  type Telemetry,
  type TelemetryRecord,
  type TelemetrySink,
} from '@staticflux/core';
import { InvalidBaselineError, NewViolationsError } from './errors.js';
import { PERF_SUBSYSTEMS, perfMetrics } from './telemetry.js';

export const VIOLATION_EVENT = 'violation' as const;

export type ViolationSeverity = 'error' | 'warning';

export interface Violation {
  readonly code: ErrorCode;
  readonly fix: string;
  readonly feature?: string;
  readonly unit?: string;
  readonly message?: string;
  readonly severity?: ViolationSeverity;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Build a violation from a catalog definition (code + default fix + summary). */
export function violationOf(
  definition: ErrorDefinition,
  init: Omit<Violation, 'code' | 'fix'> & { readonly fix?: string } = {},
): Violation {
  return { ...init, code: definition.code, fix: init.fix ?? definition.fix, message: init.message ?? definition.summary };
}

export function violationAttrs(v: Violation): Attrs {
  const attrs: Record<string, AttrValue> = { code: v.code, fix: v.fix, severity: v.severity ?? 'error' };
  if (v.feature !== undefined) attrs['feature'] = v.feature;
  if (v.unit !== undefined) attrs['unit'] = v.unit;
  if (v.message !== undefined) attrs['message'] = v.message;
  if (v.details !== undefined) attrs['details'] = JSON.stringify(v.details);
  return attrs;
}

/** Emit one violation event (always generated; sinks decide what to keep). */
export function reportViolation(telemetry: Telemetry, violation: Violation, subsystem = PERF_SUBSYSTEMS.conformance): void {
  telemetry.event(VIOLATION_EVENT, { subsystem, level: 'critical', attrs: violationAttrs(violation) });
  telemetry.record(perfMetrics.violations, 1, { code: violation.code });
}

export interface Conformance {
  report(violation: Violation): void;
  /** Local listeners (devtools overlay in the same thread). */
  onViolation(listener: (violation: Violation) => void): () => void;
}

export interface ConformanceOptions {
  readonly telemetry: Telemetry;
  /** Production sampling [0,1] (default 1). */
  readonly sampleRate?: number;
  readonly random?: () => number;
}

export function createConformance(options: ConformanceOptions): Conformance {
  const listeners = new Set<(violation: Violation) => void>();
  const sampleRate = options.sampleRate ?? 1;
  const random = options.random ?? Math.random;
  return {
    report(violation) {
      for (const listener of [...listeners]) listener(violation);
      if (sampleRate < 1 && random() >= sampleRate) return;
      reportViolation(options.telemetry, violation);
    },
    onViolation(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface CollectedViolation extends Violation {
  readonly subsystem: string;
  readonly time: number;
}

export const BASELINE_FORMAT = 'sf-violations/1' as const;

export interface ViolationBaseline {
  readonly format: typeof BASELINE_FORMAT;
  /** `code|feature|unit` → count. */
  readonly entries: Readonly<Record<string, number>>;
}

export interface ViolationComparison {
  /** Keys with more occurrences than the baseline allows (or absent from it). */
  readonly added: readonly { readonly key: string; readonly count: number; readonly allowed: number; readonly sample: CollectedViolation }[];
  /** Baseline keys no longer seen (CI proposes tightening — R12.8 ratchet). */
  readonly fixed: readonly string[];
}

export interface ViolationCollector extends TelemetrySink {
  readonly violations: readonly CollectedViolation[];
  baseline(): ViolationBaseline;
  compare(baseline: ViolationBaseline): ViolationComparison;
  /** CI gate: error SF-PERF-006 listing new violations. */
  check(baseline: ViolationBaseline): Result<ViolationComparison>;
  clear(): void;
}

export function violationKey(v: Pick<Violation, 'code' | 'feature' | 'unit'>): string {
  return `${v.code}|${v.feature ?? ''}|${v.unit ?? ''}`;
}

export function parseBaseline(json: unknown): Result<ViolationBaseline> {
  if (typeof json !== 'object' || json === null) return err(InvalidBaselineError());
  const raw = json as Record<string, unknown>;
  if (raw['format'] !== BASELINE_FORMAT || typeof raw['entries'] !== 'object' || raw['entries'] === null) return err(InvalidBaselineError());
  for (const value of Object.values(raw['entries'] as Record<string, unknown>)) {
    if (typeof value !== 'number') return err(InvalidBaselineError());
  }
  return ok(json as ViolationBaseline);
}

function parseDetails(value: AttrValue | undefined): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Telemetry sink collecting `violation` events from every subsystem (devtools, CI). */
export function createViolationCollector(): ViolationCollector {
  const violations: CollectedViolation[] = [];
  const counts = (): Map<string, { count: number; sample: CollectedViolation }> => {
    const map = new Map<string, { count: number; sample: CollectedViolation }>();
    for (const v of violations) {
      const key = violationKey(v);
      const entry = map.get(key);
      if (entry === undefined) map.set(key, { count: 1, sample: v });
      else entry.count += 1;
    }
    return map;
  };
  const collector: ViolationCollector = {
    violations,
    receive(record: TelemetryRecord) {
      if (record.type !== 'event' || record.name !== VIOLATION_EVENT) return;
      const a = record.attrs;
      if (typeof a['code'] !== 'string') return;
      const details = parseDetails(a['details']);
      violations.push({
        code: a['code'] as ErrorCode,
        fix: typeof a['fix'] === 'string' ? a['fix'] : '',
        severity: a['severity'] === 'warning' ? 'warning' : 'error',
        subsystem: record.subsystem,
        time: record.time,
        ...(typeof a['feature'] === 'string' ? { feature: a['feature'] } : {}),
        ...(typeof a['unit'] === 'string' ? { unit: a['unit'] } : {}),
        ...(typeof a['message'] === 'string' ? { message: a['message'] } : {}),
        ...(details === undefined ? {} : { details }),
      });
    },
    baseline() {
      const entries: Record<string, number> = {};
      for (const [key, { count }] of [...counts()].sort(([a], [b]) => a.localeCompare(b))) entries[key] = count;
      return { format: BASELINE_FORMAT, entries };
    },
    compare(baseline) {
      const current = counts();
      const added: { key: string; count: number; allowed: number; sample: CollectedViolation }[] = [];
      for (const [key, { count, sample }] of current) {
        const allowed = baseline.entries[key] ?? 0;
        if (count > allowed) added.push({ key, count, allowed, sample });
      }
      const fixed = Object.keys(baseline.entries).filter((key) => !current.has(key));
      return { added, fixed };
    },
    check(baseline) {
      const comparison = collector.compare(baseline);
      if (comparison.added.length === 0) return ok(comparison);
      return err(
        NewViolationsError({
          message: `${comparison.added.length} new violation(s): ${comparison.added.map((a) => a.key).join(', ')}`,
          details: { added: comparison.added.map((a) => ({ key: a.key, count: a.count, allowed: a.allowed, fix: a.sample.fix })) },
        }),
      );
    },
    clear() {
      violations.length = 0;
    },
  };
  return collector;
}
