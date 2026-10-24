/**
 * Reactive platform facts. Each fact group is its own observable so readers
 * re-run only for the group they read (e.g. `facts.network` changes do not
 * re-render a component that reads `facts.preferences`).
 *
 * Updates come from `matchMedia` change events, `resize`, `online`/`offline`
 * and Network Information `change`. Every listener is bound to the given
 * scope: disposing the scope removes them all.
 */
import {
  box,
  batch,
  type Box,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  type Machine,
  metric,
  ok,
  type Result,
  type Scope,
  type Telemetry,
  timeout,
  toSfError,
  untracked,
} from '@staticflux/core';
import type { ListenableLike, MediaQueryListLike, PlatformEnv } from './env.js';
import { AiProbeFailedError } from './errors.js';
import {
  AI_API_GLOBALS,
  AI_API_NAMES,
  type AiApiName,
  type AiAvailability,
  type AiFacts,
  type CapabilityFacts,
  type DeviceFacts,
  type DisplayFacts,
  type HostFacts,
  type InputFacts,
  type NetworkFacts,
  type PlatformFacts,
  type PreferenceFacts,
  readAiPresence,
  readCapabilities,
  readDevice,
  readDisplay,
  readHost,
  readInput,
  readNetwork,
  readPreferences,
} from './facts.js';

export const FACTS_SUBSYSTEM = 'platform/facts' as const;

/** Media queries whose `change` events refresh facts. */
export const WATCHED_MEDIA_QUERIES: readonly string[] = [
  '(pointer: coarse)',
  '(pointer: fine)',
  '(hover: hover)',
  '(any-pointer: fine)',
  '(prefers-reduced-motion: reduce)',
  '(prefers-reduced-data: reduce)',
  '(prefers-reduced-transparency: reduce)',
  '(prefers-contrast: more)',
  '(prefers-contrast: less)',
  '(prefers-color-scheme: dark)',
  '(forced-colors: active)',
  '(display-mode: standalone)',
  '(display-mode: fullscreen)',
  '(display-mode: minimal-ui)',
  '(display-mode: window-controls-overlay)',
  '(orientation: portrait)',
];

export const factChanges = metric.counter('platform/fact-changes', {
  description: 'Platform fact group changes (input, network, preferences, display, …).',
});
export const aiProbeDuration = metric.histogram('platform/ai-probe-duration', {
  unit: 'ms',
  description: 'Time to probe built-in AI availability.',
});

export const aiProbeMachine = defineMachine({
  id: 'platform/ai-probe',
  initial: 'idle',
  states: ['idle', 'probing', 'settled', 'failed', 'disposed'],
  transitions: {
    idle: { probe: 'probing', dispose: 'disposed' },
    probing: { settle: 'settled', fail: 'failed', dispose: 'disposed' },
    settled: { probe: 'probing', dispose: 'disposed' },
    failed: { probe: 'probing', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});
export type AiProbeState = (typeof aiProbeMachine.states)[number];

export const factsSourceMachine = defineMachine({
  id: 'platform/facts-source',
  initial: 'listening',
  states: ['listening', 'disposed'],
  transitions: { listening: { dispose: 'disposed' } },
  terminal: ['disposed'],
});

export type FactGroup = keyof PlatformFacts;

export interface PlatformFactsSource {
  /** Whole snapshot. Reactive (tracks every group). */
  readonly current: PlatformFacts;
  readonly input: InputFacts;
  readonly network: NetworkFacts;
  readonly device: DeviceFacts;
  readonly preferences: PreferenceFacts;
  readonly display: DisplayFacts;
  readonly host: HostFacts;
  readonly capabilities: CapabilityFacts;
  readonly ai: AiFacts;
  /** `listening` until disposed. Reactive. */
  readonly state: 'listening' | 'disposed';
  readonly aiProbeState: AiProbeState;
  /** Untracked plain copy (for worker replication / devtools). */
  snapshot(): PlatformFacts;
  /** Re-read every group now (e.g. after `visibilitychange`). */
  refresh(): void;
  /** Ask each present built-in AI API for `availability()`; updates `ai`. */
  probeAi(signal?: AbortSignal): Promise<Result<AiFacts>>;
  /** Listen to group changes (non-reactive consumers). Returns unsubscribe. */
  onChange(listener: (group: FactGroup, facts: PlatformFacts) => void): () => void;
}

export interface PlatformFactsOptions {
  readonly env: PlatformEnv;
  /** Owns every listener; dispose to stop updates. */
  readonly scope: Scope;
  readonly telemetry?: Telemetry;
  /** Timeout for each AI `availability()` call. Default 2000 ms. */
  readonly aiProbeTimeoutMs?: number;
  /** Start the AI probe right away (default false — do it on idle). */
  readonly probeAiOnStart?: boolean;
}

/** Structural equality for flat fact groups (values are primitives). */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Add a listener and remove it when `scope` is disposed (works with fakes and old Safari). */
export function listenOn(target: ListenableLike, type: string, listener: () => void, scope: Scope): void {
  target.addEventListener(type, listener);
  scope.defer(() => target.removeEventListener(type, listener));
}

/** Listen to a media query's `change` (falls back to legacy `addListener`). */
export function listenMedia(list: MediaQueryListLike, listener: () => void, scope: Scope): void {
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', listener);
    scope.defer(() => list.removeEventListener?.('change', listener));
  } else if (typeof list.addListener === 'function') {
    list.addListener(listener);
    scope.defer(() => list.removeListener?.(listener));
  }
}

type AvailabilityApi = { availability?: (options?: unknown) => Promise<string> };
const AI_STATES: readonly AiAvailability[] = ['unavailable', 'downloadable', 'downloading', 'available'];

export function createPlatformFacts(options: PlatformFactsOptions): PlatformFactsSource {
  const { env, scope } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const probeTimeout = options.aiProbeTimeoutMs ?? 2000;
  const lifecycle = createMachine(factsSourceMachine);
  const probe: Machine<AiProbeState, 'probe' | 'settle' | 'fail' | 'dispose'> = createMachine(aiProbeMachine);
  const listeners = new Set<(group: FactGroup, facts: PlatformFacts) => void>();

  const input0 = readInput(env);
  const display0 = readDisplay(env);
  const boxes: { readonly [K in FactGroup]: Box<PlatformFacts[K]> } = {
    input: box(input0, shallowEqual),
    network: box(readNetwork(env), shallowEqual),
    device: box(readDevice(env, input0, display0), shallowEqual),
    preferences: box(readPreferences(env), shallowEqual),
    display: box(display0, shallowEqual),
    host: box(readHost(env), shallowEqual),
    capabilities: box(readCapabilities(env), shallowEqual),
    ai: box(readAiPresence(env), shallowEqual),
  };

  const snapshot = (): PlatformFacts =>
    untracked(() => ({
      input: boxes.input.get(),
      network: boxes.network.get(),
      device: boxes.device.get(),
      preferences: boxes.preferences.get(),
      display: boxes.display.get(),
      host: boxes.host.get(),
      capabilities: boxes.capabilities.get(),
      ai: boxes.ai.get(),
    }));

  const update = <K extends FactGroup>(group: K, next: PlatformFacts[K]): void => {
    if (lifecycle.state === 'disposed') return;
    const previous = untracked(() => boxes[group].get());
    if (shallowEqual(previous as object, next as object)) return;
    boxes[group].set(next);
    telemetry.record(factChanges, 1, { group });
    telemetry.event('platform.facts-changed', { subsystem: FACTS_SUBSYSTEM, level: 'verbose', attrs: { group } });
    const facts = snapshot();
    for (const listener of [...listeners]) listener(group, facts);
  };

  const refreshLayout = (): void => {
    batch(() => {
      const input = readInput(env);
      const display = readDisplay(env);
      update('input', input);
      update('display', display);
      update('device', readDevice(env, input, display));
    });
  };

  const refreshMedia = (): void => {
    batch(() => {
      refreshLayout();
      update('preferences', readPreferences(env));
      update('host', readHost(env));
    });
  };

  const refreshNetwork = (): void => update('network', readNetwork(env));

  // ---------------------------------------------------------------- listeners (scope-bound)
  if (env.matchMedia !== undefined) {
    for (const query of WATCHED_MEDIA_QUERIES) {
      try {
        listenMedia(env.matchMedia(query), refreshMedia, scope);
      } catch {
        // Unsupported query syntax in this engine: nothing to watch.
      }
    }
  }
  if (env.window !== undefined) {
    listenOn(env.window, 'resize', refreshLayout, scope);
    listenOn(env.window, 'online', refreshNetwork, scope);
    listenOn(env.window, 'offline', refreshNetwork, scope);
  }
  const connection = env.navigator?.connection;
  if (connection?.addEventListener !== undefined && connection.removeEventListener !== undefined) {
    listenOn(connection as ListenableLike, 'change', refreshNetwork, scope);
  }

  const probeOne = async (name: AiApiName, signal: AbortSignal): Promise<AiAvailability> => {
    let api: AvailabilityApi | undefined;
    try {
      api = env.globals[AI_API_GLOBALS[name]] as AvailabilityApi | undefined;
    } catch {
      return 'unavailable';
    }
    if (api === undefined || api === null) return 'unavailable';
    if (typeof api.availability !== 'function') return 'unknown';
    const availability = api.availability.bind(api);
    const result = await timeout(async (inner: AbortSignal) => {
      if (inner.aborted) return err(toSfError(inner.reason));
      try {
        return ok(await availability());
      } catch (error) {
        return err(toSfError(error));
      }
    }, probeTimeout)(signal);
    if (!result.ok) return 'unknown';
    return AI_STATES.find((s) => s === result.value) ?? 'unknown';
  };

  const source: PlatformFactsSource = {
    get current() {
      return {
        input: boxes.input.get(),
        network: boxes.network.get(),
        device: boxes.device.get(),
        preferences: boxes.preferences.get(),
        display: boxes.display.get(),
        host: boxes.host.get(),
        capabilities: boxes.capabilities.get(),
        ai: boxes.ai.get(),
      };
    },
    get input() {
      return boxes.input.get();
    },
    get network() {
      return boxes.network.get();
    },
    get device() {
      return boxes.device.get();
    },
    get preferences() {
      return boxes.preferences.get();
    },
    get display() {
      return boxes.display.get();
    },
    get host() {
      return boxes.host.get();
    },
    get capabilities() {
      return boxes.capabilities.get();
    },
    get ai() {
      return boxes.ai.get();
    },
    get state() {
      return lifecycle.state;
    },
    get aiProbeState() {
      return probe.state;
    },
    snapshot,
    refresh() {
      batch(() => {
        refreshMedia();
        refreshNetwork();
        update('capabilities', readCapabilities(env));
      });
    },
    async probeAi(signal = scope.signal) {
      if (!probe.can('probe')) return err(AiProbeFailedError({ message: `AI probe not possible in state "${probe.state}".` }));
      probe.send('probe');
      const span = telemetry.span('platform.ai-probe', { subsystem: FACTS_SUBSYSTEM });
      const started = telemetry.now();
      try {
        const results = await Promise.all(AI_API_NAMES.map(async (name) => [name, await probeOne(name, signal)] as const));
        if (signal.aborted) {
          const error = AiProbeFailedError({ cause: signal.reason, message: 'AI probe aborted.' });
          if (probe.can('fail')) probe.send('fail');
          span.end('cancelled', error);
          return err(error);
        }
        const next = Object.fromEntries(results) as Record<AiApiName, AiAvailability>;
        update('ai', next);
        if (probe.can('settle')) probe.send('settle');
        for (const [name, value] of results) span.set(`ai.${name}`, value);
        span.end('ok');
        return ok(next as AiFacts);
      } catch (error) {
        const sf = AiProbeFailedError({ cause: error });
        if (probe.can('fail')) probe.send('fail');
        span.end('error', sf);
        return err(sf);
      } finally {
        telemetry.record(aiProbeDuration, telemetry.now() - started);
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  scope.defer(() => {
    lifecycle.send('dispose');
    if (probe.can('dispose')) probe.send('dispose');
    listeners.clear();
  });

  if (options.probeAiOnStart === true) void source.probeAi();
  return source;
}
