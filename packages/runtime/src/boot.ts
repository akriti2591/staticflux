/**
 * Boot sequence (docs/ARCHITECTURE.md §4.1, R2.1, R2.3, R17.6):
 *
 *   app.boot
 *   ├─ boot.core      create injector → supervisor (synchronous, < 1 ms target)
 *   └─ boot.critical  injector.resolveCritical → contributed policies + subsystems → critical subsystems
 *   → core-ready → running (non-critical subsystems start in the background)
 */
import {
  createInjector,
  createNoopTelemetry,
  err,
  type Injector,
  ok,
  type Registration,
  type Result,
  type Telemetry,
  toSfError,
  unit,
} from '@staticflux/core';
import { BootFailedError } from './errors.js';
import type { Sleep } from './hooks.js';
import type { Subsystem } from './subsystem.js';
import { createSupervisor, type Supervisor } from './supervisor.js';
import { RUNTIME_SUBSYSTEMS } from './telemetry.js';
import { AppInjectorToken, CommandPolicyToken, PausedRequestPolicyToken, SubsystemsToken, SupervisorToken } from './tokens.js';

const SUB = RUNTIME_SUBSYSTEMS.app;

export interface BootOptions {
  readonly units?: readonly Registration[];
  readonly telemetry?: Telemetry;
  /** Subsystems registered before boot (packages may also contribute `SubsystemsToken`). */
  readonly subsystems?: readonly Subsystem[];
  readonly injectorName?: string;
  /** Idle scheduler for the injector's `idle` init timing. */
  readonly idle?: (callback: () => void) => void;
  readonly now?: () => number;
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

export interface App {
  readonly injector: Injector;
  readonly supervisor: Supervisor;
  readonly telemetry: Telemetry;
  shutdown(): Promise<Result<void>>;
}

/** Boot an app: injector → supervisor → resolveCritical → core-ready → running. */
export async function bootApp(options: BootOptions = {}): Promise<Result<App>> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const bootSpan = telemetry.span('app.boot', { subsystem: SUB, level: 'critical' });
  const coreSpan = telemetry.span('boot.core', { subsystem: SUB, level: 'critical', parent: bootSpan });

  let injector: Injector;
  try {
    injector = createInjector({
      name: options.injectorName ?? 'app',
      units: options.units ?? [],
      telemetry,
      ...(options.idle === undefined ? {} : { idle: options.idle }),
    });
  } catch (error) {
    const failure = BootFailedError({ cause: error, message: `Injector creation failed: ${toSfError(error).message}` });
    coreSpan.end('error', failure);
    bootSpan.end('error', failure);
    return err(failure);
  }

  const supervisor: Supervisor = createSupervisor({
    telemetry,
    injector,
    subsystems: options.subsystems ?? [],
    parentSpan: bootSpan,
    onShutdown: () => injector.dispose(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.random === undefined ? {} : { random: options.random }),
    core: async ({ reason, signal }) => {
      const span = telemetry.span('boot.critical', { subsystem: SUB, level: 'critical', parent: bootSpan, attrs: { reason } });
      const critical = await injector.resolveCritical(signal, span);
      if (!critical.ok) {
        span.end('error', critical.error);
        return critical;
      }
      if (reason === 'boot') {
        const contributed = await registerContributions(injector, supervisor);
        if (!contributed.ok) {
          span.end('error', contributed.error);
          return contributed;
        }
      }
      span.end('ok');
      return ok();
    },
  });

  const supervisorValue = unit({ id: 'runtime/supervisor-value', provides: SupervisorToken, scope: 'app', create: () => supervisor });
  const injectorValue = unit({ id: 'runtime/app-injector-value', provides: AppInjectorToken, scope: 'app', create: () => injector });
  const provided = injector.register(supervisorValue, injectorValue);
  if (!provided.ok) {
    coreSpan.end('error', provided.error);
    bootSpan.end('error', provided.error);
    return err(provided.error);
  }
  coreSpan.end('ok');

  const started = await supervisor.start();
  if (!started.ok) {
    bootSpan.end('error', started.error);
    return err(started.error);
  }
  bootSpan.set('state', supervisor.state);
  bootSpan.end('ok');
  return ok({ injector, supervisor, telemetry, shutdown: () => supervisor.shutdown() });
}

/** Optional policies and contributed subsystems, resolved after critical units are ready. */
async function registerContributions(injector: Injector, supervisor: Supervisor): Promise<Result<void>> {
  const command = await injector.get(CommandPolicyToken);
  const paused = await injector.get(PausedRequestPolicyToken);
  supervisor.usePolicies({
    ...(command.ok ? { command: command.value } : {}),
    ...(paused.ok ? { pausedRequest: paused.value } : {}),
  });
  const subsystems = await injector.get(SubsystemsToken);
  if (!subsystems.ok) return err(subsystems.error);
  for (const subsystem of subsystems.value) {
    const registered = supervisor.register(subsystem);
    if (!registered.ok) return registered;
  }
  return ok();
}
