/**
 * Telemetry fabric for the app: one core `Telemetry`, a memory sink (devtools /
 * tests), an optional console sink (`?sf-debug`), and the perf sinks (journey
 * tracker + violation collector) attached *before* boot so the boot waterfall and
 * every conformance violation are captured from the first span (R17.5, R17.22).
 */
import { createMemorySink, createTelemetry, type LevelName, type Telemetry, type TelemetryRecord, type TelemetrySink } from '@staticflux/core';
import { createJourneyTracker, createViolationCollector, type JourneyTracker, type ViolationCollector } from '@staticflux/perf';

export interface StudioTelemetry {
  readonly telemetry: Telemetry;
  readonly memory: TelemetrySink & { readonly records: TelemetryRecord[]; clear(): void };
  readonly journeys: JourneyTracker;
  readonly violations: ViolationCollector;
}

export function createStudioTelemetry(options: { readonly console?: boolean; readonly level?: LevelName; readonly now?: () => number } = {}): StudioTelemetry {
  const telemetry = createTelemetry({ defaultLevel: options.level ?? 'standard', ...(options.now === undefined ? {} : { now: options.now }) });
  const memory = createMemorySink();
  const journeys = createJourneyTracker({ telemetry });
  const violations = createViolationCollector();
  telemetry.addSink(memory);
  telemetry.addSink(journeys);
  telemetry.addSink(violations);
  if (options.console === true) {
    telemetry.addSink({
      receive(record) {
        if (record.type === 'span') console.debug(`[sf] ${record.subsystem} ${record.name} ${record.duration.toFixed(1)}ms ${record.status}`);
        else if (record.type === 'event' && (record.level === 'critical' || record.name === 'violation')) console.warn(`[sf] ${record.subsystem} ${record.name}`, record.attrs);
      },
    });
  }
  return { telemetry, memory, journeys, violations };
}
