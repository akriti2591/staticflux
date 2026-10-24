/**
 * App profile = host mode × form factor (R18.4), reactive (R18.6).
 *
 * - Host mode: detected once (or forced by config / `?sf-mode=` / devtools);
 *   re-detected only when host facts change and nothing forces it.
 * - Form factor: follows the viewport width with hysteresis unless forced.
 * - Effective capabilities = detected capability AND not forbidden by the host mode (R18.10).
 */
import {
  box,
  createNoopTelemetry,
  createSingleFlight,
  err,
  metric,
  ok,
  type Result,
  type Scope,
  type Telemetry,
  untracked,
  watch,
} from '@staticflux/core';
import { type DetectedMode, detectHostMode, detectMode, type HostModeId, type ModeOverride, type ModeSource } from './detect-mode.js';
import type { PlatformEnv } from './env.js';
import { DuplicateHostModeError, HostBridgeLoadError, NoHostBridgeError, UnknownModeOverrideError } from './errors.js';
import type { CapabilityFacts, CapabilityName } from './facts.js';
import {
  BUILT_IN_FORM_FACTORS,
  computeFormFactor,
  DEFAULT_HYSTERESIS_PX,
  type FormFactorDefinition,
  type FormFactorId,
} from './form-factor.js';
import { BUILT_IN_HOST_MODES, type HostBridge, type HostModeDefinition } from './host-mode.js';
import type { PlatformFactsSource } from './platform-facts.js';
import { shallowEqual } from './platform-facts.js';

export const PROFILE_SUBSYSTEM = 'platform/profile' as const;

export const profileChanges = /* @__PURE__ */ metric.counter('platform/profile-changes', {
  description: 'App profile changes (host mode or form factor) at runtime.',
});

export type ProfileKey = `${HostModeId}:${FormFactorId}`;

export interface AppProfile {
  readonly hostMode: HostModeId;
  readonly formFactor: FormFactorId;
  /** `host:form`, e.g. `web:expanded` — key for per-profile boot plans (R12.10). */
  readonly key: ProfileKey;
  readonly hostModeSource: ModeSource;
  readonly formFactorSource: ModeSource;
}

/** Which profiles something (feature, route binding, boot plan) applies to. Omitted axis = any. */
export interface ProfileMatcher {
  readonly hostModes?: readonly HostModeId[];
  readonly formFactors?: readonly FormFactorId[];
}

export function profileKey(hostMode: HostModeId, formFactor: FormFactorId): ProfileKey {
  return `${hostMode}:${formFactor}`;
}

export function matchesProfile(profile: Pick<AppProfile, 'hostMode' | 'formFactor'>, matcher: ProfileMatcher): boolean {
  return (
    (matcher.hostModes === undefined || matcher.hostModes.includes(profile.hostMode)) &&
    (matcher.formFactors === undefined || matcher.formFactors.includes(profile.formFactor))
  );
}

export interface AppProfileSource {
  /** Reactive. */
  readonly current: AppProfile;
  /** Definition of the current host mode. Reactive. */
  readonly hostMode: HostModeDefinition;
  /** Effective capabilities (detected ∧ allowed by host mode). Reactive. */
  readonly capabilities: CapabilityFacts;
  readonly hostModes: readonly HostModeId[];
  readonly formFactors: readonly FormFactorId[];
  has(capability: CapabilityName): boolean;
  /**
   * Force one or both axes (`devtools`/`config`), or pass `undefined` to return
   * to detection. Unknown ids → `SF-PLAT-001` and nothing changes.
   */
  force(override: ModeOverride | undefined, source?: Extract<ModeSource, 'devtools' | 'config'>): Result<AppProfile>;
  /** Load (single-flight, cached) the current host mode's bridge. */
  loadBridge(signal?: AbortSignal): Promise<Result<HostBridge>>;
  /** Non-reactive listener for profile changes. Returns unsubscribe. */
  onChange(listener: (next: AppProfile, previous: AppProfile) => void): () => void;
}

export interface AppProfileOptions {
  readonly env: PlatformEnv;
  readonly facts: PlatformFactsSource;
  readonly scope: Scope;
  readonly hostModes?: readonly HostModeDefinition[];
  readonly formFactors?: readonly FormFactorDefinition[];
  /** App config override (R12.11). */
  readonly override?: ModeOverride;
  /** Dev URL flag; `false` disables. Default `sf-mode`. */
  readonly urlParam?: string | false;
  readonly hysteresis?: number;
  /** Result of the inline detector, so boot and runtime agree. */
  readonly initial?: DetectedMode;
  readonly telemetry?: Telemetry;
}

/** Applies a host profile's restrictions to detected capabilities. */
export function effectiveCapabilities(detected: CapabilityFacts, mode: HostModeDefinition): CapabilityFacts {
  const out = { ...detected } as Record<CapabilityName, boolean>;
  for (const name of Object.keys(detected) as CapabilityName[]) {
    if (mode.capabilities[name] === false) out[name] = false;
  }
  return out;
}

export function createAppProfile(options: AppProfileOptions): Result<AppProfileSource> {
  const { env, facts, scope } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const hostModes = options.hostModes ?? BUILT_IN_HOST_MODES;
  const formFactors = options.formFactors ?? BUILT_IN_FORM_FACTORS;
  const hysteresis = options.hysteresis ?? DEFAULT_HYSTERESIS_PX;

  const byId = new Map<HostModeId, HostModeDefinition>();
  for (const mode of hostModes) {
    if (byId.has(mode.id)) return err(DuplicateHostModeError({ details: { id: mode.id } }));
    byId.set(mode.id, mode);
  }
  const hostIds = [...byId.keys()];
  const formIds = formFactors.map((f) => f.id);

  const validate = (override: ModeOverride): Result<void> => {
    if (override.hostMode !== undefined && !byId.has(override.hostMode)) {
      return err(UnknownModeOverrideError({ details: { hostMode: override.hostMode, known: hostIds } }));
    }
    if (override.formFactor !== undefined && !formIds.includes(override.formFactor)) {
      return err(UnknownModeOverrideError({ details: { formFactor: override.formFactor, known: formIds } }));
    }
    return ok();
  };

  if (options.override !== undefined) {
    const valid = validate(options.override);
    if (!valid.ok) return valid;
  }
  const initial =
    options.initial ??
    detectMode(env, {
      detectors: hostModes,
      formFactors,
      ...(options.override === undefined ? {} : { override: options.override }),
      ...(options.urlParam === undefined ? {} : { urlParam: options.urlParam }),
    });
  const initialValid = validate(initial);
  if (!initialValid.ok) return initialValid;
  for (const ignored of initial.ignored) {
    telemetry.event('platform.mode-override-ignored', {
      subsystem: PROFILE_SUBSYSTEM,
      level: 'critical',
      attrs: { value: ignored, code: UnknownModeOverrideError.code },
    });
  }

  const toProfile = (d: Omit<AppProfile, 'key'>): AppProfile => ({ ...d, key: profileKey(d.hostMode, d.formFactor) });
  const state = box<AppProfile>(
    toProfile({
      hostMode: initial.hostMode,
      formFactor: initial.formFactor,
      hostModeSource: initial.hostModeSource,
      formFactorSource: initial.formFactorSource,
    }),
    shallowEqual,
  );
  const listeners = new Set<(next: AppProfile, previous: AppProfile) => void>();

  const commit = (next: Omit<AppProfile, 'key'>): AppProfile => {
    const previous = untracked(() => state.get());
    const profile = toProfile(next);
    if (shallowEqual(previous, profile)) return previous;
    state.set(profile);
    telemetry.record(profileChanges, 1, { from: previous.key, to: profile.key });
    telemetry.event('platform.profile-changed', {
      subsystem: PROFILE_SUBSYSTEM,
      attrs: { from: previous.key, to: profile.key, hostModeSource: profile.hostModeSource, formFactorSource: profile.formFactorSource },
    });
    for (const listener of [...listeners]) listener(profile, previous);
    return profile;
  };

  // Form factor follows the viewport (with hysteresis) unless forced.
  watch(
    () => facts.display.width,
    (width) => {
      const current = untracked(() => state.get());
      if (current.formFactorSource !== 'detected') return;
      commit({ ...current, formFactor: computeFormFactor(width, formFactors, current.formFactor, hysteresis) });
    },
    { scope },
  );
  // Host mode re-detects when host facts change (e.g. PWA display mode) unless forced.
  watch(
    () => facts.host,
    () => {
      const current = untracked(() => state.get());
      if (current.hostModeSource !== 'detected') return;
      commit({ ...current, hostMode: detectHostMode(env, hostModes) });
    },
    { scope },
  );

  const bridges = new Map<HostModeId, HostBridge>();
  const bridgeFlight = createSingleFlight<HostModeId, HostBridge>();
  scope.defer(() => {
    for (const bridge of bridges.values()) bridge.dispose();
    bridges.clear();
    listeners.clear();
  });

  const definitionOf = (id: HostModeId): HostModeDefinition => byId.get(id) ?? (byId.get('web') as HostModeDefinition);

  const source: AppProfileSource = {
    get current() {
      return state.get();
    },
    get hostMode() {
      return definitionOf(state.get().hostMode);
    },
    get capabilities() {
      return effectiveCapabilities(facts.capabilities, definitionOf(state.get().hostMode));
    },
    hostModes: hostIds,
    formFactors: formIds,
    has(capability) {
      return source.capabilities[capability];
    },
    force(override, forcedBy = 'devtools') {
      const current = untracked(() => state.get());
      if (override === undefined) {
        return ok(
          commit({
            hostMode: detectHostMode(env, hostModes),
            formFactor: computeFormFactor(untracked(() => facts.display.width), formFactors),
            hostModeSource: 'detected',
            formFactorSource: 'detected',
          }),
        );
      }
      const valid = validate(override);
      if (!valid.ok) return valid;
      return ok(
        commit({
          hostMode: override.hostMode ?? current.hostMode,
          formFactor: override.formFactor ?? current.formFactor,
          hostModeSource: override.hostMode === undefined ? current.hostModeSource : forcedBy,
          formFactorSource: override.formFactor === undefined ? current.formFactorSource : forcedBy,
        }),
      );
    },
    async loadBridge(signal = scope.signal) {
      const mode = untracked(() => source.hostMode);
      const cached = bridges.get(mode.id);
      if (cached !== undefined) return ok(cached);
      const loader = mode.bridge;
      if (loader === undefined) return err(NoHostBridgeError({ details: { hostMode: mode.id } }));
      const span = telemetry.span('platform.bridge-load', { subsystem: PROFILE_SUBSYSTEM, attrs: { hostMode: mode.id } });
      const result = await bridgeFlight.run(
        mode.id,
        async (inner) => {
          try {
            return await loader(inner);
          } catch (error) {
            return err(HostBridgeLoadError({ cause: error, details: { hostMode: mode.id } }));
          }
        },
        signal,
      );
      if (!result.ok) {
        span.end(result.error.kind === 'aborted' ? 'cancelled' : 'error', result.error);
        return result;
      }
      if (scope.disposed) {
        result.value.dispose();
        span.end('cancelled');
        return err(HostBridgeLoadError({ message: 'Profile scope disposed while the bridge loaded.' }));
      }
      bridges.set(mode.id, result.value);
      span.end('ok');
      return result;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return ok(source);
}
