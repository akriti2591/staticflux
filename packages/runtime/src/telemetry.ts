/**
 * Runtime telemetry: subsystem names, declared metrics and the machine tracer
 * that turns every lifecycle transition into `lifecycle.<machine>.<from>→<to>`.
 */
import { type Attrs, type Machine, metric, type Telemetry, type Subsystem as TelemetrySubsystem } from '@staticflux/core';

export const RUNTIME_SUBSYSTEMS = {
  app: 'runtime/app',
  feature: 'runtime/feature',
  resources: 'runtime/resources',
  scheduler: 'runtime/scheduler',
} as const satisfies Record<string, TelemetrySubsystem>;

export const runtimeMetrics = {
  /** Restarts of supervised subsystems (attrs: subsystem). */
  subsystemRestarts: /* @__PURE__ */ metric.counter('runtime/subsystem-restarts', { description: 'Subsystem restarts by the supervisor.' }),
  /** Time from boot start to core-ready. */
  coreReady: /* @__PURE__ */ metric.histogram('runtime/core-ready', { unit: 'ms', description: 'Boot start → core-ready.' }),
  /** Feature module load time (attrs: feature). */
  featureLoad: /* @__PURE__ */ metric.histogram('runtime/feature-load', { unit: 'ms', description: 'Feature module load duration.' }),
  /** Feature activation time (attrs: feature, activation: fresh|warm|archived). */
  featureActivation: /* @__PURE__ */ metric.histogram('runtime/feature-activation', { unit: 'ms', description: 'Feature activation duration.' }),
  /** Number of features whose logic is alive. */
  activeFeatures: /* @__PURE__ */ metric.gauge('runtime/active-features', { description: 'Features with live logic.' }),
  /** Demotions issued by the resource manager (attrs: feature, action, reason). */
  demotions: /* @__PURE__ */ metric.counter('runtime/feature-demotions', { description: 'Resource-manager demotions.' }),
  /** Duration of one coalesced frame flush. */
  frameFlush: /* @__PURE__ */ metric.histogram('runtime/frame-flush', { unit: 'ms', description: 'Coalesced frame flush duration.' }),
  /** Feature readiness marks (attrs: feature, mark). Value: ms since activation start. */
  featureReadiness: /* @__PURE__ */ metric.mark('runtime/feature-readiness', { description: 'feature.first-render / interactive / complete.' }),
} as const;

export interface TraceMachineOptions<S extends string> {
  readonly attrs?: Attrs;
  /** States whose entry is reported at `critical` instead of `verbose`. */
  readonly criticalStates?: readonly S[];
}

/** Emit a telemetry event for every transition of `machine`. Returns the unsubscribe function. */
export function traceMachine<S extends string, E extends string>(
  machine: Machine<S, E>,
  telemetry: Telemetry,
  subsystem: TelemetrySubsystem,
  options: TraceMachineOptions<S> = {},
): () => void {
  const critical = new Set<S>(options.criticalStates ?? []);
  return machine.onTransition((record) => {
    telemetry.event(`lifecycle.${record.machine}.${record.from}→${record.to}`, {
      subsystem,
      level: critical.has(record.to) ? 'critical' : 'verbose',
      attrs: { ...options.attrs, from: record.from, to: record.to, event: record.event },
    });
  });
}
