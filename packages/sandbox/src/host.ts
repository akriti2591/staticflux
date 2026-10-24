/**
 * Plugin host (R3.4): loads untrusted plugins into isolated realms, supervises
 * them, and is the ONLY way they reach the app — through capabilities they have
 * been granted, invoked via the capability registry (so gating, confirmation,
 * metering and tracing apply) with a non-user subject.
 *
 *   realm port ─▶ guard (rate · size · envelope · channel allowlist) ─▶ Link
 *     sandbox/hello   handshake (id must match the manifest)
 *     sandbox/invoke  grant check → concurrency → registry.invoke(subject, origin: plugin) with call timeout
 *     sandbox/resize  permission `resize`
 *   host ─▶ plugin: declared events, grant updates, heartbeats
 *
 * Every rejected message is a `violation` telemetry event (critical) and counts
 * toward the violation budget; exceeding it kills the plugin. Crashes (realm
 * closed, handshake timeout, missed heartbeats) restart with backoff until the
 * restart intensity is exceeded (→ failed). The kill switch stops everything.
 *
 * Client gating is UX, not security (R6.16): the server re-checks every request.
 */
import type { AnyCapability, CapabilityId, CapabilityRegistry, CapabilitySubject } from '@staticflux/capabilities';
import {
  anySignal,
  backoffDelay,
  box,
  createDeferred,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  type Machine,
  metric,
  ok,
  type Result,
  type SfError,
  type Telemetry,
  toSfError,
  type TransitionRecord,
  watch,
} from '@staticflux/core';
import {
  type Clock,
  createEnvelope,
  createLink,
  type Envelope,
  InvalidEnvelopeError,
  isEnvelope,
  type Link,
  NoHandlerError,
  type Port,
  PortClosedError,
  systemClock,
  toWireResult,
} from '@staticflux/worker';
import {
  CapabilityNotGrantedError,
  EventNotDeclaredError,
  ManifestInvalidError,
  PayloadTooLargeError,
  PluginCallTimeoutError,
  PluginFailedError,
  PluginHandshakeError,
  PluginKilledError,
  PluginNotRunningError,
  PluginPermissionError,
  PluginRateLimitedError,
  SandboxUnsupportedError,
} from './errors.js';
import { createRateLimiter, estimateBytes, type RateLimiter } from './limits.js';
import {
  DEFAULT_PLUGIN_LIMITS,
  effectiveLimits,
  PLUGIN_PERMISSIONS,
  type PluginEvent,
  type PluginEventPayload,
  type PluginLimits,
  type PluginManifest,
  type PluginPermission,
  validateManifest,
} from './manifest.js';
import {
  type HelloAck,
  isHelloPayload,
  isInvokePayload,
  isResizeMessage,
  PLUGIN_ALLOWED,
  SANDBOX_PROTOCOL_VERSION,
  SandboxChannels,
} from './protocol.js';
import type { PluginRealm, RealmFactories } from './realm.js';

const SUBSYSTEM = 'sandbox/host';

/** `invoke` origin channel for plugin calls; `origin.details` is the `PluginSubject`. */
export const PLUGIN_ORIGIN_CHANNEL = 'sandbox/plugin';

/** Who is calling: carried in `origin.details` of every capability invocation. */
export interface PluginSubject {
  readonly kind: 'plugin';
  readonly id: string;
  readonly version: string;
}

export function pluginSubjectOf(origin: { readonly channel: string; readonly details?: unknown } | undefined): PluginSubject | undefined {
  if (origin?.channel !== PLUGIN_ORIGIN_CHANNEL) return undefined;
  const d = origin.details as Partial<PluginSubject> | undefined;
  return d?.kind === 'plugin' && typeof d.id === 'string' && typeof d.version === 'string'
    ? { kind: 'plugin', id: d.id, version: d.version }
    : undefined;
}

// ---------------------------------------------------------------- lifecycle

export const PluginLifecycle = defineMachine({
  id: 'sandbox/plugin',
  initial: 'idle',
  states: ['idle', 'loading', 'handshaking', 'running', 'crashed', 'restarting', 'failed', 'killed', 'stopped'],
  transitions: {
    idle: { load: 'loading', kill: 'killed', stop: 'stopped' },
    loading: { loaded: 'handshaking', crash: 'crashed', kill: 'killed', stop: 'stopped' },
    handshaking: { ready: 'running', crash: 'crashed', kill: 'killed', stop: 'stopped' },
    running: { crash: 'crashed', kill: 'killed', stop: 'stopped' },
    crashed: { restart: 'restarting', 'give-up': 'failed', kill: 'killed', stop: 'stopped' },
    restarting: { load: 'loading', kill: 'killed', stop: 'stopped' },
    failed: { restart: 'restarting', kill: 'killed', stop: 'stopped' },
    killed: { restart: 'restarting', stop: 'stopped' },
  },
  terminal: ['stopped'],
});

export type PluginState = (typeof PluginLifecycle.states)[number];
type PluginLifecycleEvent = 'load' | 'loaded' | 'ready' | 'crash' | 'restart' | 'give-up' | 'kill' | 'stop';

export const SandboxMetrics = {
  calls: /* @__PURE__ */ metric.counter('sandbox/calls', { description: 'Plugin capability calls by plugin, capability and outcome.' }),
  callDuration: /* @__PURE__ */ metric.histogram('sandbox/call-duration', { unit: 'ms', description: 'Plugin capability call time.' }),
  violations: /* @__PURE__ */ metric.counter('sandbox/violations', { description: 'Plugin violations by plugin and kind.' }),
  crashes: /* @__PURE__ */ metric.counter('sandbox/crashes', { description: 'Plugin realm crashes.' }),
} as const;

export type ViolationKind =
  | 'rate'
  | 'payload'
  | 'malformed'
  | 'not-granted'
  | 'concurrency'
  | 'permission'
  | 'handshake'
  | 'unresponsive';

export interface PluginViolation {
  readonly plugin: string;
  readonly version: string;
  readonly kind: ViolationKind;
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly time: number;
}

// ---------------------------------------------------------------- options

export interface RestartPolicy {
  /** Restarts allowed within `periodMs` before giving up. Default 3. */
  readonly intensity?: number;
  readonly periodMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface PluginHostOptions {
  readonly registry: CapabilityRegistry;
  readonly realms: RealmFactories;
  /** Events the host offers to plugins (a plugin receives the intersection with its manifest). */
  readonly events?: readonly PluginEvent[];
  /** Ceiling for every plugin's limits. Default `DEFAULT_PLUGIN_LIMITS`. */
  readonly limits?: PluginLimits;
  /** Policy subject for plugin calls. Default `'plugin'` (non-user: destructive capabilities need confirmation). */
  readonly subject?: CapabilitySubject;
  /** Initial grants. Default: everything the manifest requests (`autoGrant`), or `[]` when `autoGrant: false`. */
  readonly grantPolicy?: (manifest: PluginManifest) => readonly CapabilityId[];
  readonly autoGrant?: boolean;
  /** Permissions plugins may hold. Default all. A manifest requesting others is refused (SF-SBX-012). */
  readonly allowedPermissions?: readonly PluginPermission[];
  readonly handshakeTimeoutMs?: number;
  /** Heartbeat interval; two misses = crash. `false` disables. Default 10 s. */
  readonly heartbeatMs?: number | false;
  readonly restart?: RestartPolicy;
  /** Violations within `violationWindowMs` before the plugin is killed. Default 20 per 60 s. */
  readonly maxViolations?: number;
  readonly violationWindowMs?: number;
  /** Reactive kill switch (e.g. a remote flag): engaged → every plugin is killed and loads are refused. */
  readonly killSwitch?: () => boolean;
  readonly clock?: Clock;
  readonly telemetry?: Telemetry;
}

export interface LoadOptions {
  /** Where the plugin renders (iframe realms with `render`). */
  readonly slot?: Element;
  /** Initial grants (clamped to the manifest). */
  readonly grants?: readonly CapabilityId[];
  readonly signal?: AbortSignal;
}

export interface PluginInspection {
  readonly id: string;
  readonly version: string;
  readonly state: PluginState;
  readonly grants: readonly string[];
  readonly events: readonly string[];
  readonly permissions: readonly PluginPermission[];
  readonly limits: PluginLimits;
  readonly attempt: number;
  readonly activeCalls: number;
  readonly violations: number;
}

export interface PluginInstance {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly limits: PluginLimits;
  /** Reactive. */
  readonly state: PluginState;
  /** Reactive. */
  readonly grants: readonly CapabilityId[];
  /** The realm's iframe, when running in one. */
  readonly element: HTMLIFrameElement | undefined;
  /** Start (idle) and wait until running. */
  start(signal?: AbortSignal): Promise<Result<void>>;
  whenRunning(signal?: AbortSignal): Promise<Result<void>>;
  /** Grant a capability the manifest requested. */
  grant(capability: AnyCapability | CapabilityId): Result<void>;
  /** Revoke; in-flight calls of it are aborted. */
  revoke(capability: AnyCapability | CapabilityId): void;
  emit<E extends PluginEvent>(event: E, payload: PluginEventPayload<E>): Result<void>;
  /** Supervised restart (from crashed/failed/killed); resolves when running again. */
  restart(signal?: AbortSignal): Promise<Result<void>>;
  /** Kill switch for this plugin: hard stop, no automatic restart. */
  kill(reason?: string): void;
  /** Unload (terminal). */
  stop(): void;
  onStateChange(listener: (record: TransitionRecord<PluginState, PluginLifecycleEvent>) => void): () => void;
  inspect(): PluginInspection;
}

export interface PluginHost {
  /** Validate the (untrusted) manifest and create the instance without starting it. */
  register(manifest: unknown, options?: LoadOptions): Result<PluginInstance>;
  /** register + start; resolves when the plugin is running (or failed/killed). */
  load(manifest: unknown, options?: LoadOptions): Promise<Result<PluginInstance>>;
  get(id: string): PluginInstance | undefined;
  list(): readonly PluginInstance[];
  /** Deliver an event to every running plugin that declared it. Returns the number of deliveries. */
  emit<E extends PluginEvent>(event: E, payload: PluginEventPayload<E>): number;
  onViolation(listener: (violation: PluginViolation) => void): () => void;
  killAll(reason?: string): void;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------- implementation

interface HostContext {
  readonly options: PluginHostOptions;
  readonly telemetry: Telemetry;
  readonly clock: Clock;
  readonly offered: ReadonlySet<string>;
  readonly ceiling: PluginLimits;
  readonly reportViolation: (violation: PluginViolation) => void;
  readonly killSwitchEngaged: () => boolean;
  readonly remove: (instance: PluginInstance) => void;
}

interface Run {
  readonly gen: number;
  readonly realm: PluginRealm;
  readonly link: Link;
  readonly controller: AbortController;
}

interface ActiveCall {
  readonly capability: string;
  readonly controller: AbortController;
}

type Verdict = { readonly reply?: Envelope } | undefined;

function idOf(capability: AnyCapability | CapabilityId): CapabilityId {
  return typeof capability === 'string' ? capability : (capability.id as CapabilityId);
}

function createInstance(manifest: PluginManifest, load: LoadOptions, host: HostContext): PluginInstance {
  const { options, telemetry, clock } = host;
  const limits = effectiveLimits(manifest, host.ceiling);
  const subject = options.subject ?? 'plugin';
  const pluginSubject: PluginSubject = Object.freeze({ kind: 'plugin', id: manifest.id, version: manifest.version });
  const events = manifest.events.filter((e) => host.offered.has(e));
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const intensity = options.restart?.intensity ?? 3;
  const periodMs = options.restart?.periodMs ?? 60_000;
  const baseDelayMs = options.restart?.baseDelayMs ?? 200;
  const maxDelayMs = options.restart?.maxDelayMs ?? 5_000;
  const maxViolations = options.maxViolations ?? 20;
  const violationWindowMs = options.violationWindowMs ?? 60_000;
  const baseAttrs = { plugin: manifest.id, version: manifest.version };

  const requested = new Set<string>(manifest.capabilities);
  const initialGrants = load.grants ?? options.grantPolicy?.(manifest) ?? (options.autoGrant === false ? [] : manifest.capabilities);
  const grants = box<readonly CapabilityId[]>([...new Set(initialGrants.filter((g) => requested.has(g)))]);

  const machine: Machine<PluginState, PluginLifecycleEvent> = createMachine(PluginLifecycle, {
    onInvalid: (state, event) => telemetry.event('plugin.invalid-transition', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { ...baseAttrs, state, event } }),
  });
  machine.onTransition((record) =>
    telemetry.event('plugin.state', { subsystem: SUBSYSTEM, level: 'standard', attrs: { ...baseAttrs, from: record.from, to: record.to, event: record.event } }),
  );

  let generation = 0;
  let attempt = 0;
  let current: Run | undefined;
  let handshakeTimer: unknown;
  let heartbeatTimer: unknown;
  let restartTimer: unknown;
  let misses = 0;
  let crashTimes: number[] = [];
  let violationTimes: number[] = [];
  let violationCount = 0;
  const active = new Set<ActiveCall>();
  let waiters: { resolve(result: Result<void>): void }[] = [];

  const settleWaiters = (result: Result<void>): void => {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter.resolve(result);
  };

  const terminalError = (): SfError | undefined => {
    if (machine.is('failed')) return PluginFailedError({ details: baseAttrs });
    if (machine.is('killed')) return PluginKilledError({ details: baseAttrs });
    if (machine.is('stopped')) return PluginNotRunningError({ details: { ...baseAttrs, state: 'stopped' } });
    return undefined;
  };

  const violation = (kind: ViolationKind, error: SfError, details: Readonly<Record<string, string | number | boolean>> = {}): void => {
    const time = clock.now();
    const record: PluginViolation = { plugin: manifest.id, version: manifest.version, kind, code: error.code, message: error.message, details, time };
    violationCount += 1;
    telemetry.event('violation', { subsystem: SUBSYSTEM, level: 'critical', attrs: { ...details, ...baseAttrs, kind, code: error.code } });
    telemetry.record(SandboxMetrics.violations, 1, { ...baseAttrs, kind });
    host.reportViolation(record);
    violationTimes = violationTimes.filter((t) => time - t < violationWindowMs);
    violationTimes.push(time);
    if (violationTimes.length > maxViolations) kill('violations');
  };

  const clearTimers = (): void => {
    clock.clearTimeout(handshakeTimer);
    clock.clearTimeout(heartbeatTimer);
    handshakeTimer = undefined;
    heartbeatTimer = undefined;
  };

  const teardown = (): void => {
    const run = current;
    current = undefined;
    clearTimers();
    for (const call of [...active]) call.controller.abort(new DOMException('plugin stopped', 'AbortError'));
    if (run === undefined) return;
    run.controller.abort(new DOMException('plugin stopped', 'AbortError'));
    run.link.close();
    run.realm.terminate();
  };

  // ---- message guard (before the Link sees anything)

  const reject = (data: unknown, error: SfError): Verdict => {
    if (!isEnvelope(data) || data.kind !== 'request') return {};
    return {
      reply: createEnvelope({ kind: 'response', channel: data.channel, id: data.id, epoch: 0, payload: toWireResult(err(error)) }),
    };
  };

  const inspectMessage = (data: unknown, limiter: RateLimiter): Verdict => {
    if (!limiter.take()) {
      const error = PluginRateLimitedError({ details: { ...baseAttrs, limit: limits.maxMessagesPerSecond } });
      violation('rate', error, { limit: limits.maxMessagesPerSecond });
      return reject(data, error);
    }
    const size = estimateBytes(data, limits.maxPayloadBytes);
    if (size > limits.maxPayloadBytes) {
      const error = PayloadTooLargeError({ details: { ...baseAttrs, limit: limits.maxPayloadBytes } });
      violation('payload', error, { limit: limits.maxPayloadBytes });
      return reject(data, error);
    }
    if (!isEnvelope(data)) {
      violation('malformed', InvalidEnvelopeError({ details: baseAttrs }), { received: typeof data });
      return {};
    }
    if (!PLUGIN_ALLOWED[data.kind].has(data.channel)) {
      const error = NoHandlerError({ message: `Plugins may not use channel "${data.channel}".`, details: { ...baseAttrs, channel: data.channel } });
      violation('malformed', error, { channel: data.channel, envelope: data.kind });
      return reject(data, error);
    }
    return undefined;
  };

  const guardPort = (inner: Port, gen: number): Port => {
    const limiter = createRateLimiter(limits.maxMessagesPerSecond, () => clock.now());
    return {
      postMessage: (message, transfer) => inner.postMessage(message, transfer),
      onMessage: (listener) =>
        inner.onMessage((data) => {
          if (current?.gen !== gen) return;
          const verdict = inspectMessage(data, limiter);
          if (verdict === undefined) listener(data);
          else if (verdict.reply !== undefined && current?.gen === gen) inner.postMessage(verdict.reply);
        }),
      onError: (listener) => inner.onError(listener),
      onClose: (listener) => inner.onClose(listener),
      close: () => inner.close(),
    };
  };

  // ---- handlers

  const helloAck = (): HelloAck => ({
    plugin: manifest.id,
    version: manifest.version,
    grants: grants.get(),
    events,
    permissions: manifest.permissions,
    limits,
  });

  const onHello = (gen: number) => (payload: unknown): Result<unknown> => {
    if (current?.gen !== gen) return err(PluginNotRunningError({ details: baseAttrs }));
    if (!machine.is('handshaking')) {
      const error = PluginHandshakeError({ message: 'Repeated handshake.', details: baseAttrs });
      violation('handshake', error, { reason: 'repeated' });
      return err(error);
    }
    if (!isHelloPayload(payload) || payload.plugin !== manifest.id || payload.protocol !== SANDBOX_PROTOCOL_VERSION) {
      const error = PluginHandshakeError({ message: 'The plugin identified itself with another id or protocol.', details: baseAttrs });
      violation('handshake', error, { reason: 'identity' });
      queueMicrotask(() => crash(error));
      return err(error);
    }
    clock.clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
    machine.send('ready');
    misses = 0;
    scheduleHeartbeat(gen);
    settleWaiters(ok());
    return ok(helloAck());
  };

  const onInvoke = async (payload: unknown, context: { readonly signal: AbortSignal; readonly parent: Parameters<Telemetry['span']>[1]['parent'] }): Promise<Result<unknown>> => {
    if (!machine.is('running')) return err(PluginNotRunningError({ details: baseAttrs }));
    if (!isInvokePayload(payload)) {
      const error = InvalidEnvelopeError({ message: 'Malformed invoke payload.', details: baseAttrs });
      violation('malformed', error, { channel: SandboxChannels.invoke });
      return err(error);
    }
    const capability = payload.capability;
    if (!grants.get().includes(capability as CapabilityId)) {
      const error = CapabilityNotGrantedError({ details: { ...baseAttrs, capability } });
      violation('not-granted', error, { capability });
      return err(error);
    }
    if (active.size >= limits.maxConcurrentCalls) {
      const error = PluginRateLimitedError({ message: 'Too many concurrent plugin calls.', details: { ...baseAttrs, limit: limits.maxConcurrentCalls } });
      violation('concurrency', error, { capability, limit: limits.maxConcurrentCalls });
      return err(error);
    }
    const call: ActiveCall = { capability, controller: new AbortController() };
    active.add(call);
    const timer = clock.setTimeout(
      () => call.controller.abort(new DOMException('plugin call timed out', 'TimeoutError')),
      limits.callTimeoutMs,
    );
    const span = telemetry.span('sandbox.call', {
      subsystem: SUBSYSTEM,
      level: 'standard',
      attrs: { ...baseAttrs, capability, subject },
      parent: context.parent,
    });
    const started = clock.now();
    let result: Result<unknown>;
    try {
      result = await options.registry.invoke(capability, payload.input, {
        subject,
        origin: { channel: PLUGIN_ORIGIN_CHANNEL, details: pluginSubject },
        signal: anySignal(context.signal, call.controller.signal),
        parent: span,
      });
    } catch (error) {
      result = err(toSfError(error));
    } finally {
      clock.clearTimeout(timer);
      active.delete(call);
    }
    const reason: unknown = call.controller.signal.reason;
    if (!result.ok && reason instanceof DOMException && reason.name === 'TimeoutError') {
      result = err(PluginCallTimeoutError({ cause: result.error, details: { ...baseAttrs, capability, timeoutMs: limits.callTimeoutMs } }));
    } else if (!result.ok && reason instanceof DOMException && reason.message === 'revoked') {
      result = err(CapabilityNotGrantedError({ message: 'The grant was revoked during the call.', cause: result.error, details: { ...baseAttrs, capability } }));
    }
    const outcome = result.ok ? 'ok' : result.error.code;
    span.set('outcome', outcome);
    span.end(result.ok ? 'ok' : result.error.kind === 'aborted' ? 'cancelled' : 'error', result.ok ? undefined : result.error);
    telemetry.record(SandboxMetrics.calls, 1, { ...baseAttrs, capability, outcome });
    telemetry.record(SandboxMetrics.callDuration, clock.now() - started, { ...baseAttrs, capability });
    return result;
  };

  const onResize = (payload: unknown): void => {
    if (!isResizeMessage(payload)) {
      violation('malformed', InvalidEnvelopeError({ message: 'Malformed resize message.', details: baseAttrs }), { channel: SandboxChannels.resize });
      return;
    }
    if (!manifest.permissions.includes('resize')) {
      violation('permission', PluginPermissionError({ details: { ...baseAttrs, permission: 'resize' } }), { permission: 'resize' });
      return;
    }
    current?.realm.resize?.(payload.height);
  };

  // ---- supervision

  const scheduleHeartbeat = (gen: number): void => {
    if (heartbeatMs === false) return;
    heartbeatTimer = clock.setTimeout(() => {
      const run = current;
      if (run?.gen !== gen || !machine.is('running')) return;
      void run.link.request(SandboxChannels.ping, null, { timeoutMs: heartbeatMs }).then((result) => {
        if (current?.gen !== gen) return;
        if (result.ok) misses = 0;
        else {
          misses += 1;
          if (misses >= 2) {
            const error = PluginCallTimeoutError({ message: 'The plugin missed two heartbeats.', details: baseAttrs });
            violation('unresponsive', error, { misses });
            crash(error);
            return;
          }
        }
        scheduleHeartbeat(gen);
      });
    }, heartbeatMs);
  };

  function crash(error: SfError): void {
    if (!machine.is('loading', 'handshaking', 'running')) return;
    teardown();
    machine.send('crash');
    telemetry.record(SandboxMetrics.crashes, 1, baseAttrs);
    telemetry.event('plugin.crashed', { subsystem: SUBSYSTEM, level: 'critical', attrs: { ...baseAttrs, code: error.code, message: error.message } });
    const now = clock.now();
    crashTimes = crashTimes.filter((t) => now - t < periodMs);
    crashTimes.push(now);
    if (crashTimes.length > intensity) {
      machine.send('give-up');
      settleWaiters(err(PluginFailedError({ cause: error, details: baseAttrs })));
      return;
    }
    machine.send('restart');
    const delay = backoffDelay(crashTimes.length, baseDelayMs, maxDelayMs, 'none');
    restartTimer = clock.setTimeout(() => {
      restartTimer = undefined;
      if (machine.is('restarting')) startRun();
    }, delay);
  }

  function kill(reason = 'kill'): void {
    if (machine.is('killed', 'stopped')) return;
    teardown();
    clock.clearTimeout(restartTimer);
    restartTimer = undefined;
    machine.send('kill');
    telemetry.event('plugin.killed', { subsystem: SUBSYSTEM, level: 'critical', attrs: { ...baseAttrs, reason } });
    settleWaiters(err(PluginKilledError({ details: { ...baseAttrs, reason } })));
  }

  function startRun(): void {
    if (host.killSwitchEngaged()) {
      kill('kill-switch');
      return;
    }
    if (!machine.can('load')) return;
    machine.send('load');
    attempt += 1;
    generation += 1;
    const gen = generation;
    const factory = options.realms[manifest.entry.kind];
    const controller = new AbortController();
    const realm =
      factory === undefined
        ? err(SandboxUnsupportedError({ details: { ...baseAttrs, entry: manifest.entry.kind } }))
        : factory({ manifest, slot: load.slot, visible: manifest.permissions.includes('render'), attempt, signal: controller.signal });
    if (!realm.ok) {
      crash(realm.error);
      return;
    }
    const link = createLink({
      port: guardPort(realm.value.port, gen),
      name: `sandbox:${manifest.id}`,
      telemetry,
      clock,
      defaultTimeoutMs: limits.callTimeoutMs,
    });
    current = { gen, realm: realm.value, link, controller };
    link.handle(SandboxChannels.hello, onHello(gen));
    link.handle(SandboxChannels.invoke, onInvoke);
    link.on(SandboxChannels.resize, onResize);
    link.onClose((reason) => {
      if (current?.gen === gen) crash(PortClosedError({ cause: reason, message: 'The plugin realm closed.', details: baseAttrs }));
    });
    realm.value.port.onError((error) => {
      if (current?.gen === gen) crash(error);
    });
    machine.send('loaded');
    handshakeTimer = clock.setTimeout(() => {
      if (current?.gen !== gen || !machine.is('handshaking')) return;
      const error = PluginHandshakeError({ details: { ...baseAttrs, timeoutMs: handshakeTimeoutMs } });
      violation('handshake', error, { reason: 'timeout' });
      crash(error);
    }, handshakeTimeoutMs);
  }

  const pushGrants = (): void => {
    if (machine.is('running')) current?.link.send(SandboxChannels.grants, { grants: grants.get() });
  };

  const whenRunning = (signal?: AbortSignal): Promise<Result<void>> => {
    if (machine.is('running')) return Promise.resolve(ok());
    const terminal = terminalError();
    if (terminal !== undefined) return Promise.resolve(err(terminal));
    if (signal?.aborted === true) return Promise.resolve(err(PluginNotRunningError({ cause: signal.reason, details: baseAttrs })));
    const deferred = createDeferred<Result<void>>();
    const detach = new AbortController();
    const waiter = {
      resolve: (result: Result<void>) => {
        detach.abort();
        deferred.resolve(result);
      },
    };
    waiters.push(waiter);
    signal?.addEventListener(
      'abort',
      () => {
        waiters = waiters.filter((w) => w !== waiter);
        deferred.resolve(err(PluginNotRunningError({ cause: signal.reason, details: { ...baseAttrs, state: machine.state } })));
      },
      { once: true, signal: detach.signal },
    );
    return deferred.promise;
  };

  const instance: PluginInstance = {
    id: manifest.id,
    manifest,
    limits,
    get state() {
      return machine.state;
    },
    get grants() {
      return grants.get();
    },
    get element() {
      return current?.realm.element;
    },
    start(signal) {
      if (machine.is('idle')) startRun();
      return whenRunning(signal);
    },
    whenRunning,
    grant(capability) {
      const id = idOf(capability);
      if (!requested.has(id)) {
        return err(CapabilityNotGrantedError({ message: 'Only capabilities requested in the manifest can be granted.', details: { ...baseAttrs, capability: id } }));
      }
      if (grants.get().includes(id)) return ok();
      grants.set([...grants.get(), id]);
      telemetry.event('plugin.grant', { subsystem: SUBSYSTEM, level: 'standard', attrs: { ...baseAttrs, capability: id } });
      pushGrants();
      return ok();
    },
    revoke(capability) {
      const id = idOf(capability);
      if (!grants.get().includes(id)) return;
      grants.set(grants.get().filter((g) => g !== id));
      for (const call of [...active]) if (call.capability === id) call.controller.abort(new DOMException('revoked', 'AbortError'));
      telemetry.event('plugin.revoke', { subsystem: SUBSYSTEM, level: 'standard', attrs: { ...baseAttrs, capability: id } });
      pushGrants();
    },
    emit(event, payload) {
      if (!events.includes(event.id)) return err(EventNotDeclaredError({ details: { ...baseAttrs, event: event.id } }));
      const run = current;
      if (!machine.is('running') || run === undefined) return err(PluginNotRunningError({ details: { ...baseAttrs, state: machine.state } }));
      run.link.send(SandboxChannels.event, { event: event.id, payload });
      telemetry.event('plugin.event', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { ...baseAttrs, event: event.id } });
      return ok();
    },
    restart(signal) {
      if (machine.is('running', 'loading', 'handshaking', 'restarting')) return whenRunning(signal);
      if (machine.is('stopped')) return Promise.resolve(err(PluginNotRunningError({ details: { ...baseAttrs, state: 'stopped' } })));
      if (host.killSwitchEngaged()) return Promise.resolve(err(PluginKilledError({ details: { ...baseAttrs, reason: 'kill-switch' } })));
      crashTimes = [];
      if (machine.is('idle')) startRun();
      else {
        clock.clearTimeout(restartTimer);
        machine.send('restart');
        startRun();
      }
      return whenRunning(signal);
    },
    kill,
    stop() {
      if (machine.is('stopped')) return;
      teardown();
      clock.clearTimeout(restartTimer);
      restartTimer = undefined;
      machine.send('stop');
      settleWaiters(err(PluginNotRunningError({ details: { ...baseAttrs, state: 'stopped' } })));
      host.remove(instance);
    },
    onStateChange: (listener) => machine.onTransition(listener),
    inspect: () => ({
      id: manifest.id,
      version: manifest.version,
      state: machine.state,
      grants: grants.get(),
      events,
      permissions: manifest.permissions,
      limits,
      attempt,
      activeCalls: active.size,
      violations: violationCount,
    }),
  };
  return instance;
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const clock = options.clock ?? systemClock;
  const instances = new Map<string, PluginInstance>();
  const violationListeners = new Set<(violation: PluginViolation) => void>();
  const allowed = new Set<PluginPermission>(options.allowedPermissions ?? PLUGIN_PERMISSIONS);
  const killSwitchEngaged = (): boolean => options.killSwitch?.() === true;

  const context: HostContext = {
    options,
    telemetry,
    clock,
    offered: new Set((options.events ?? []).map((e) => e.id)),
    ceiling: options.limits ?? DEFAULT_PLUGIN_LIMITS,
    reportViolation: (violation) => {
      for (const listener of [...violationListeners]) listener(violation);
    },
    killSwitchEngaged,
    remove: (instance) => {
      if (instances.get(instance.id) === instance) instances.delete(instance.id);
    },
  };

  const killAll = (reason = 'kill-switch'): void => {
    for (const instance of [...instances.values()]) instance.kill(reason);
  };

  const offKillSwitch =
    options.killSwitch === undefined
      ? undefined
      : watch(
          () => killSwitchEngaged(),
          (engaged) => {
            if (engaged) {
              telemetry.event('sandbox.kill-switch', { subsystem: SUBSYSTEM, level: 'critical', attrs: { plugins: instances.size } });
              killAll('kill-switch');
            }
          },
        );

  const register = (raw: unknown, load: LoadOptions = {}): Result<PluginInstance> => {
    const validated = validateManifest(raw);
    if (!validated.ok) {
      telemetry.event('plugin.rejected', { subsystem: SUBSYSTEM, level: 'critical', attrs: { code: validated.error.code } });
      return validated;
    }
    const manifest = validated.value;
    const denied = manifest.permissions.filter((p) => !allowed.has(p));
    if (denied.length > 0) return err(PluginPermissionError({ details: { plugin: manifest.id, permissions: denied.join(',') } }));
    if (options.realms[manifest.entry.kind] === undefined) {
      return err(SandboxUnsupportedError({ details: { plugin: manifest.id, entry: manifest.entry.kind } }));
    }
    if (killSwitchEngaged()) return err(PluginKilledError({ details: { plugin: manifest.id, reason: 'kill-switch' } }));
    const existing = instances.get(manifest.id);
    if (existing !== undefined) {
      if (existing.manifest.version === manifest.version) return ok(existing);
      return err(
        ManifestInvalidError({
          message: `Plugin "${manifest.id}" is already loaded with version ${existing.manifest.version}; stop it first.`,
          details: { plugin: manifest.id, loaded: existing.manifest.version, requested: manifest.version },
        }),
      );
    }
    const instance = createInstance(manifest, load, context);
    instances.set(manifest.id, instance);
    return ok(instance);
  };

  return {
    register,
    async load(raw, load = {}) {
      const registered = register(raw, load);
      if (!registered.ok) return registered;
      const running = await registered.value.start(load.signal);
      return running.ok ? registered : running;
    },
    get: (id) => instances.get(id),
    list: () => [...instances.values()],
    emit(event, payload) {
      let delivered = 0;
      for (const instance of instances.values()) {
        if (!instance.manifest.events.includes(event.id) || instance.state !== 'running') continue;
        if (instance.emit(event, payload).ok) delivered += 1;
      }
      return delivered;
    },
    onViolation(listener) {
      violationListeners.add(listener);
      return () => violationListeners.delete(listener);
    },
    killAll,
    async dispose() {
      offKillSwitch?.();
      for (const instance of [...instances.values()]) instance.stop();
      violationListeners.clear();
      await Promise.resolve();
    },
  };
}
