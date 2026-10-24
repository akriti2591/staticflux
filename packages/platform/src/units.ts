/**
 * DI surface of @staticflux/platform. Apps register `platformUnits()` (or pick
 * units individually); host modes and form factors are multi-token
 * contributions so plugin packages add modes without touching this package.
 */
import { token, unit, type AnyUnit, type TokenId } from '@staticflux/core';
import type { DetectedMode, ModeOverride } from './detect-mode.js';
import { browserEnv, type PlatformEnv } from './env.js';
import { BUILT_IN_FORM_FACTORS, type FormFactorDefinition } from './form-factor.js';
import { BUILT_IN_HOST_MODES, type HostModeDefinition } from './host-mode.js';
import { createPlatformFacts, type PlatformFactsSource } from './platform-facts.js';
import { type AppProfileSource, createAppProfile } from './profile.js';

export interface PlatformOptions {
  /** App-config mode override (R12.11). */
  readonly override?: ModeOverride;
  /** Dev URL flag name; `false` disables (production). Default `sf-mode`. */
  readonly urlParam?: string | false;
  readonly hysteresis?: number;
  /** Pass the inline detector's result so boot and runtime agree. */
  readonly initial?: DetectedMode;
  readonly aiProbeTimeoutMs?: number;
  readonly probeAiOnStart?: boolean;
}

export const PlatformEnvToken = token('platform/env').type<PlatformEnv>();
export const PlatformOptionsToken = token('platform/options').type<PlatformOptions>();
/** Host mode plugin bundles. Zero contributions = the built-ins. */
export const HostModesToken = token('platform/host-modes').multi<HostModeDefinition>();
/** Form factor definitions. Zero contributions = the built-ins. */
export const FormFactorsToken = token('platform/form-factors').multi<FormFactorDefinition>();
export const PlatformFactsToken = token('platform/facts').type<PlatformFactsSource>();
export const AppProfileToken = token('platform/app-profile').type<AppProfileSource>();

export const browserEnvUnit = unit({
  id: 'platform/browser-env-unit',
  provides: PlatformEnvToken,
  scope: 'app',
  description: 'The real browser globals behind the PlatformEnv port.',
  create: () => browserEnv(),
});

/** Provide a specific environment (tests, workers, custom hosts). */
export function platformEnvUnit(env: PlatformEnv): AnyUnit {
  const contribution = unit({
    id: 'platform/env-unit',
    provides: PlatformEnvToken,
    scope: 'app',
    create: () => env,
  });
  return contribution;
}

export function platformOptionsUnit(options: PlatformOptions = {}): AnyUnit {
  const contribution = unit({
    id: 'platform/options-unit',
    provides: PlatformOptionsToken,
    scope: 'app',
    create: () => options,
  });
  return contribution;
}

/** Contribute one host mode plugin. */
export function hostModeUnit(definition: HostModeDefinition): AnyUnit {
  const contribution = unit({
    id: `platform/host-mode:${definition.id}` as TokenId,
    provides: HostModesToken,
    scope: 'app',
    order: -definition.priority,
    // Multi-token contributions return one item; the injector collects the list.
    create: () => definition as never,
  });
  return contribution;
}

/** Contribute one form factor definition. */
export function formFactorUnit(definition: FormFactorDefinition): AnyUnit {
  const contribution = unit({
    id: `platform/form-factor:${definition.id}` as TokenId,
    provides: FormFactorsToken,
    scope: 'app',
    order: definition.minWidth,
    create: () => definition as never,
  });
  return contribution;
}

export const builtInHostModeUnits: readonly AnyUnit[] = BUILT_IN_HOST_MODES.map(hostModeUnit);
export const builtInFormFactorUnits: readonly AnyUnit[] = BUILT_IN_FORM_FACTORS.map(formFactorUnit);

export const platformFactsUnit = unit({
  id: 'platform/facts-unit',
  provides: PlatformFactsToken,
  scope: 'app',
  critical: true,
  deps: { required: { env: PlatformEnvToken, options: PlatformOptionsToken } },
  description: 'Reactive platform facts; listeners live in the unit scope.',
  create: ({ env, options }, context) =>
    createPlatformFacts({
      env,
      scope: context.scope,
      telemetry: context.telemetry,
      ...(options.aiProbeTimeoutMs === undefined ? {} : { aiProbeTimeoutMs: options.aiProbeTimeoutMs }),
      ...(options.probeAiOnStart === undefined ? {} : { probeAiOnStart: options.probeAiOnStart }),
    }),
});

export const appProfileUnit = unit({
  id: 'platform/app-profile-unit',
  provides: AppProfileToken,
  scope: 'app',
  critical: true,
  deps: {
    required: {
      env: PlatformEnvToken,
      facts: PlatformFactsToken,
      options: PlatformOptionsToken,
      hostModes: HostModesToken,
      formFactors: FormFactorsToken,
    },
  },
  description: 'Host mode × form factor; reactive with hysteresis; forceable (config, ?sf-mode, devtools).',
  create: ({ env, facts, options, hostModes, formFactors }, context) => {
    const result = createAppProfile({
      env,
      facts,
      scope: context.scope,
      telemetry: context.telemetry,
      hostModes: hostModes.length > 0 ? hostModes : BUILT_IN_HOST_MODES,
      formFactors: formFactors.length > 0 ? formFactors : BUILT_IN_FORM_FACTORS,
      ...(options.override === undefined ? {} : { override: options.override }),
      ...(options.urlParam === undefined ? {} : { urlParam: options.urlParam }),
      ...(options.hysteresis === undefined ? {} : { hysteresis: options.hysteresis }),
      ...(options.initial === undefined ? {} : { initial: options.initial }),
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});

/**
 * Everything needed for platform facts + app profile with the built-in modes.
 * Pass `env` for tests; omit for the real browser.
 */
export function platformUnits(options: PlatformOptions = {}, env?: PlatformEnv): readonly AnyUnit[] {
  return [
    env === undefined ? browserEnvUnit : platformEnvUnit(env),
    platformOptionsUnit(options),
    platformFactsUnit,
    appProfileUnit,
    ...builtInHostModeUnits,
    ...builtInFormFactorUnits,
  ];
}
