/**
 * Page-side SW registration + update flow (R18.11, R4.8).
 *
 * register (feature-detected; embedded / disabled → `SF-PWA-001`, no SW) → watch for a
 * waiting worker → ask it for its version → emit a typed `update available` event and,
 * when an `UpdatePromptPort` is bound (messaging), offer it → on accept: `skipWaiting`
 * → `controllerchange` → `reinitialize` through the injected runtime port (no reload)
 * — or reload when the framework major changes / the version is unknown / no
 * reinitialize port is bound / reinitialize fails.
 *
 * Machine `pwa/update`:
 *   idle → checking → available → activating → activated | failed
 *   checking → idle (no update) | failed; idle|activated|failed → available (found by the browser)
 *   available → available (a newer worker replaced the waiting one)
 *   idle|available|activated|failed → activating (`takeover`: another tab activated the update)
 *   activated|failed → checking
 */
import {
  createMachine,
  createNoopTelemetry,
  createScope,
  defineMachine,
  err,
  type Machine,
  ok,
  type Result,
  type Scope,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import {
  NoUpdateWaitingError,
  ReinitializeFailedError,
  ServiceWorkerRegistrationError,
  ServiceWorkerUnsupportedError,
  UpdateActivationTimeoutError,
} from './errors.js';
import { listenTo, type PwaPageEnv, type ServiceWorkerLike, type ServiceWorkerRegistrationLike } from './page-env.js';
import { nextMessageId, PWA_MESSAGE } from './protocol.js';
import { askServiceWorker } from './sw-client.js';
import { pwaMetrics, PWA_SUBSYSTEMS } from './telemetry.js';

export const pwaUpdateMachine = defineMachine({
  id: 'pwa/update',
  initial: 'idle',
  states: ['idle', 'checking', 'available', 'activating', 'activated', 'failed'],
  transitions: {
    idle: { check: 'checking', found: 'available', takeover: 'activating' },
    checking: { found: 'available', none: 'idle', fail: 'failed' },
    available: { found: 'available', accept: 'activating', takeover: 'activating' },
    activating: { activated: 'activated', fail: 'failed' },
    activated: { check: 'checking', found: 'available', takeover: 'activating' },
    failed: { check: 'checking', found: 'available', takeover: 'activating' },
  },
});

export type PwaUpdateState = (typeof pwaUpdateMachine.states)[number];
export type PwaUpdateEvent = 'check' | 'found' | 'none' | 'fail' | 'accept' | 'takeover' | 'activated';

export interface UpdateInfo {
  /** Build id of the waiting SW (undefined when it did not answer). */
  readonly version: string | undefined;
  readonly frameworkMajor: number | undefined;
  /** The running page's framework major. */
  readonly currentFrameworkMajor: number;
  /** True when applying the update needs a full reload (major change or unknown version). */
  readonly reloadRequired: boolean;
}

export type UpdateOutcome = 'reinitialized' | 'reloaded';

export interface ReinitializeReason {
  readonly kind: 'sw-update';
  readonly version: string | undefined;
}

/** Runtime supervisor port: `reinitialize` the app (teardown to core, re-boot) without a reload. */
export interface ReinitializePort {
  reinitialize(reason: ReinitializeReason, signal?: AbortSignal): Promise<Result<void>>;
}

/** Messaging port: show "update available" and resolve with the user's choice. */
export interface UpdatePromptPort {
  offer(info: UpdateInfo, signal: AbortSignal): Promise<'accept' | 'dismiss'>;
}

export interface PwaUpdaterOptions {
  readonly env: Pick<PwaPageEnv, 'serviceWorker' | 'embedded' | 'reload'>;
  /** SW script URL (same-origin). */
  readonly scriptUrl: string;
  readonly scope?: string;
  readonly type?: 'classic' | 'module';
  /** Host-mode capability (e.g. `profile.has('serviceWorker')`). Default true. */
  readonly enabled?: boolean;
  /** Framework major of the running page. */
  readonly frameworkMajor: number;
  readonly reinitialize?: ReinitializePort;
  readonly prompt?: UpdatePromptPort;
  readonly telemetry?: Telemetry;
  readonly activationTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  /** Max wait for an installing worker during `check()` (default 30 s). */
  readonly installTimeoutMs?: number;
}

export interface PwaUpdater {
  readonly supported: boolean;
  readonly state: PwaUpdateState;
  readonly machine: Machine<PwaUpdateState, PwaUpdateEvent>;
  readonly info: UpdateInfo | undefined;
  readonly registration: ServiceWorkerRegistrationLike | undefined;
  register(signal?: AbortSignal): Promise<Result<ServiceWorkerRegistrationLike>>;
  /** Ask the browser for an update; resolves true when an update is now available. */
  check(signal?: AbortSignal): Promise<Result<boolean>>;
  accept(signal?: AbortSignal): Promise<Result<UpdateOutcome>>;
  /** Keep the waiting update for later (state stays `available`; not offered again). */
  dismiss(): void;
  onUpdateAvailable(listener: (info: UpdateInfo) => void): () => void;
  dispose(): Promise<void>;
}

export function createPwaUpdater(options: PwaUpdaterOptions): PwaUpdater {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const container = options.env.serviceWorker;
  const supported = options.enabled !== false && !options.env.embedded && container !== undefined;
  const scope: Scope = createScope('pwa/updater');
  const machine = createMachine<PwaUpdateState, PwaUpdateEvent>(pwaUpdateMachine, {
    onInvalid: (state, event) =>
      telemetry.event('pwa.update.invalid-transition', { subsystem: PWA_SUBSYSTEMS.update, level: 'critical', attrs: { state, event } }),
  });
  scope.defer(
    machine.onTransition((r) =>
      telemetry.event(`lifecycle.${r.machine}.${r.from}→${r.to}`, { subsystem: PWA_SUBSYSTEMS.update, level: 'verbose' }),
    ),
  );
  const listeners = new Set<(info: UpdateInfo) => void>();
  let registration: ServiceWorkerRegistrationLike | undefined;
  let info: UpdateInfo | undefined;
  let offered: ServiceWorkerLike | undefined;
  let hadController = container?.controller !== null && container?.controller !== undefined;
  let applying: Promise<Result<UpdateOutcome>> | undefined;

  const infoFor = async (worker: ServiceWorkerLike): Promise<UpdateInfo> => {
    if (container === undefined) return { version: undefined, frameworkMajor: undefined, currentFrameworkMajor: options.frameworkMajor, reloadRequired: true };
    const answer = await askServiceWorker({
      container,
      worker,
      message: { type: PWA_MESSAGE.getVersion, id: nextMessageId('ver') },
      reply: PWA_MESSAGE.version,
      timeoutMs: options.versionTimeoutMs ?? 3000,
      signal: scope.signal,
    });
    const version = answer.ok ? answer.value.version : undefined;
    const frameworkMajor = answer.ok ? answer.value.frameworkMajor : undefined;
    return {
      version,
      frameworkMajor,
      currentFrameworkMajor: options.frameworkMajor,
      // Unknown version → be conservative and reload (never mix framework majors).
      reloadRequired: frameworkMajor === undefined || frameworkMajor !== options.frameworkMajor,
    };
  };

  const offer = async (worker: ServiceWorkerLike, next: UpdateInfo, prompt: UpdatePromptPort): Promise<void> => {
    const choice = await prompt.offer(next, scope.signal).catch(() => 'dismiss' as const);
    if (scope.disposed || offered !== worker || !machine.is('available')) return;
    if (choice === 'accept') void accept();
    else dismiss();
  };

  let foundPromise: Promise<void> = Promise.resolve();
  const found = (worker: ServiceWorkerLike): Promise<void> => {
    if (offered === worker) return foundPromise;
    offered = worker;
    foundPromise = (async () => {
      const next = await infoFor(worker);
      if (scope.disposed || registration?.waiting !== worker || offered !== worker) return;
      if (!machine.send('found').ok) return;
      info = next;
      telemetry.event('pwa.update.available', {
        subsystem: PWA_SUBSYSTEMS.update,
        level: 'standard',
        attrs: { version: next.version ?? 'unknown', reloadRequired: next.reloadRequired },
      });
      for (const listener of [...listeners]) listener(next);
      // The prompt is not awaited: check() resolves as soon as the update is available.
      if (options.prompt !== undefined) void offer(worker, next, options.prompt);
    })();
    return foundPromise;
  };

  const watchInstalling = (worker: ServiceWorkerLike): void => {
    const onState = (): void => {
      if (worker.state === 'installed' && hadController && registration?.waiting === worker) void found(worker);
      if (worker.state !== 'installing') remove();
    };
    const remove = listenTo(worker, 'statechange', onState);
    scope.defer(remove);
  };

  const apply = async (signal?: AbortSignal): Promise<Result<UpdateOutcome>> => {
    const current = info;
    const span = telemetry.span('pwa.update.apply', {
      subsystem: PWA_SUBSYSTEMS.update,
      attrs: { version: current?.version ?? 'unknown', reloadRequired: current?.reloadRequired ?? true },
    });
    const reload = (outcomeAttrs: Record<string, string>): Result<UpdateOutcome> => {
      machine.send('activated');
      telemetry.record(pwaMetrics.update, 1, { outcome: 'reloaded', ...outcomeAttrs });
      span.set('outcome', 'reloaded');
      span.end('ok');
      info = undefined;
      offered = undefined;
      options.env.reload();
      return ok('reloaded');
    };
    if (current === undefined || current.reloadRequired || options.reinitialize === undefined) {
      return reload({ reason: current === undefined ? 'unknown-version' : current.reloadRequired ? 'framework-major' : 'no-reinitialize-port' });
    }
    const result = await options.reinitialize
      .reinitialize({ kind: 'sw-update', version: current.version }, signal)
      .catch((cause: unknown) => err(toSfError(cause)));
    if (!result.ok) {
      const error = ReinitializeFailedError({ cause: result.error });
      telemetry.event('pwa.update.reinitialize-failed', { subsystem: PWA_SUBSYSTEMS.update, level: 'critical', attrs: { code: error.code, cause: result.error.code } });
      return reload({ reason: 'reinitialize-failed' });
    }
    machine.send('activated');
    telemetry.record(pwaMetrics.update, 1, { outcome: 'reinitialized' });
    span.set('outcome', 'reinitialized');
    span.end('ok');
    info = undefined;
    offered = undefined;
    return ok('reinitialized');
  };

  const onControllerChange = (): void => {
    const previously = hadController;
    hadController = true;
    if (!previously || machine.is('activating')) return; // first claim, or our own accept() handles it
    // Another tab accepted the update: this tab now runs under the new SW too.
    if (!machine.send('takeover').ok) return;
    applying = apply();
  };

  const register = async (signal?: AbortSignal): Promise<Result<ServiceWorkerRegistrationLike>> => {
    if (!supported || container === undefined) {
      return err(
        ServiceWorkerUnsupportedError({
          details: { reason: options.env.embedded ? 'embedded' : options.enabled === false ? 'disabled' : 'no-service-worker' },
        }),
      );
    }
    if (registration !== undefined) return ok(registration);
    const span = telemetry.span('pwa.sw.register', { subsystem: PWA_SUBSYSTEMS.update, attrs: { script: options.scriptUrl } });
    try {
      const reg = await container.register(options.scriptUrl, {
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.type === undefined ? {} : { type: options.type }),
        updateViaCache: 'none',
      });
      if (signal?.aborted === true || scope.disposed) {
        span.end('cancelled');
        return err(toSfError(signal?.reason ?? new DOMException('aborted', 'AbortError')));
      }
      registration = reg;
      scope.defer(listenTo(container, 'controllerchange', onControllerChange));
      scope.defer(
        listenTo(reg, 'updatefound', () => {
          if (reg.installing !== null) watchInstalling(reg.installing);
        }),
      );
      if (reg.installing !== null) watchInstalling(reg.installing);
      if (reg.waiting !== null && hadController) void found(reg.waiting);
      span.end('ok');
      return ok(reg);
    } catch (cause) {
      const error = ServiceWorkerRegistrationError({ cause: toSfError(cause), details: { script: options.scriptUrl } });
      span.end('error', error);
      return err(error);
    }
  };

  const waitInstalled = (worker: ServiceWorkerLike): Promise<boolean> =>
    new Promise((resolve) => {
      if (worker.state !== 'installing') {
        resolve(worker.state === 'installed');
        return;
      }
      const timer = setTimeout(() => done(false), options.installTimeoutMs ?? 30_000);
      const remove = listenTo(worker, 'statechange', () => {
        if (worker.state !== 'installing') done(worker.state === 'installed');
      });
      function done(value: boolean): void {
        clearTimeout(timer);
        remove();
        resolve(value);
      }
    });

  const check = async (_signal?: AbortSignal): Promise<Result<boolean>> => {
    if (registration === undefined) {
      const registered = await register(_signal);
      if (!registered.ok) return err(registered.error);
    }
    const reg = registration;
    if (reg === undefined) return ok(false);
    if (machine.is('available')) return ok(true);
    if (!machine.send('check').ok) return ok(false);
    const span = telemetry.span('pwa.update.check', { subsystem: PWA_SUBSYSTEMS.update });
    try {
      await reg.update();
    } catch (cause) {
      const error = ServiceWorkerRegistrationError({ message: 'Checking for a service worker update failed.', cause: toSfError(cause) });
      machine.send('fail');
      span.end('error', error);
      return err(error);
    }
    if (reg.installing !== null) await waitInstalled(reg.installing);
    const waiting = reg.waiting;
    if (waiting === null || !hadController) {
      machine.send('none');
      span.set('available', false);
      span.end('ok');
      return ok(false);
    }
    // `found` transitions checking → available (joins a run already started by `statechange`).
    await found(waiting);
    if (machine.is('checking')) machine.send('none');
    span.set('available', machine.is('available'));
    span.end('ok');
    return ok(machine.is('available'));
  };

  const accept = async (signal?: AbortSignal): Promise<Result<UpdateOutcome>> => {
    if (applying !== undefined && machine.is('activating')) return applying;
    const waiting = registration?.waiting ?? null;
    if (!machine.is('available') || waiting === null || container === undefined) return err(NoUpdateWaitingError());
    machine.send('accept');
    const run = async (): Promise<Result<UpdateOutcome>> => {
      const changed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => finish(false), options.activationTimeoutMs ?? 10_000);
        const remove = listenTo(container, 'controllerchange', () => finish(true));
        function finish(value: boolean): void {
          clearTimeout(timer);
          remove();
          resolve(value);
        }
        waiting.postMessage({ type: PWA_MESSAGE.skipWaiting });
      });
      if (!changed) {
        const error = UpdateActivationTimeoutError();
        machine.send('fail');
        telemetry.record(pwaMetrics.update, 1, { outcome: 'failed', code: error.code });
        return err(error);
      }
      return apply(signal);
    };
    applying = run();
    const result = await applying;
    applying = undefined;
    return result;
  };

  const dismiss = (): void => {
    if (!machine.is('available')) return;
    telemetry.record(pwaMetrics.update, 1, { outcome: 'dismissed' });
  };

  return {
    supported,
    get state() {
      return machine.state;
    },
    machine,
    get info() {
      return info;
    },
    get registration() {
      return registration;
    },
    register,
    check,
    accept,
    dismiss,
    onUpdateAvailable(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      listeners.clear();
      await scope.dispose();
    },
  };
}
