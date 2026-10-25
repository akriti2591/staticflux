/**
 * The unsupported preset (SF-Δ26, R18.16): when the required baseline fails, the app boots
 * ONE screen instead of itself. It reuses the existing profile → boot plan machinery, so
 * nothing branches on "supported?" in app code:
 *
 * 1. `unsupportedHostMode(verdict)` — a host mode plugin (priority 1000) whose detector is
 *    the verdict. Its profile key is `unsupported:<form>`; every capability is forbidden.
 * 2. `unsupportedBootPlan({ chunk })` — the input for the loader's `defineBootPlan`, matching
 *    only `unsupported` profiles (both axes, so it out-ranks any form-factor-only plan):
 *    the unsupported screen chunk is the only critical chunk; no eager or preload chunks.
 * 3. `BaselineVerdictToken` — the verdict, for the screen (`unsupported-screen.ts`).
 *
 * See AGENTS.md "Unsupported boot" for the whole flow and `unsupported.example.test.ts`
 * for the Instaflow baseline (IF-2.2–2.4).
 */
import { type AnyUnit, token, unit } from '@staticflux/core';
import type { BaselineVerdict } from './baseline.js';
import type { CapabilityName } from './facts.js';
import { BUILT_IN_FORM_FACTORS, type FormFactorId } from './form-factor.js';
import { defineHostMode, type HostModeDefinition } from './host-mode.js';
import { hostModeUnit } from './units.js';

export const UNSUPPORTED_HOST_MODE = 'unsupported' as const;
/** Above every built-in host mode (webview-android is 90). */
export const UNSUPPORTED_PRIORITY = 1000;

/** Nothing optional runs on the unsupported screen. */
const NO_CAPABILITIES = {
  localStorage: false,
  indexedDB: false,
  serviceWorker: false,
  sharedWorker: false,
  webAuthn: false,
  notifications: false,
  share: false,
  clipboard: false,
  webGpu: false,
  viewTransitions: false,
  navigationApi: false,
  popups: false,
  install: false,
} as const satisfies { readonly [K in CapabilityName]: false };

/** Host mode plugin selected exactly when `verdict.status === 'unsupported'`. */
export function unsupportedHostMode(verdict: BaselineVerdict): HostModeDefinition<typeof UNSUPPORTED_HOST_MODE> {
  return defineHostMode({
    id: UNSUPPORTED_HOST_MODE,
    priority: UNSUPPORTED_PRIORITY,
    detect: () => verdict.status === 'unsupported',
    capabilities: NO_CAPABILITIES,
    historyStrategy: 'memory',
    shellPreset: 'unsupported',
    description: `Required platform baseline "${verdict.baseline}" failed: ${verdict.codes.join(', ') || 'none'}.`,
  });
}

/** Structural input for `@staticflux/loader` `defineBootPlan` (platform does not import the loader). */
export interface UnsupportedBootPlanInit<Chunk extends `${string}:${string}`> {
  readonly id: typeof UNSUPPORTED_HOST_MODE;
  readonly match: { readonly hostModes: readonly [typeof UNSUPPORTED_HOST_MODE]; readonly formFactors: readonly FormFactorId[] };
  readonly critical: readonly Chunk[];
  readonly eager: readonly [];
  readonly preload: readonly [];
  readonly historyStrategy: 'memory';
  readonly shellPreset: 'unsupported';
  readonly description: string;
}

/**
 * `defineBootPlan(unsupportedBootPlan({ chunk: 'feature:unsupported' }))`. Omit `chunk` when the
 * screen is part of the boot code. Pass `formFactors` when the app registers its own.
 */
export function unsupportedBootPlan<const Chunk extends `${string}:${string}` = never>(
  options: { readonly chunk?: Chunk; readonly formFactors?: readonly FormFactorId[] } = {},
): UnsupportedBootPlanInit<Chunk> {
  return Object.freeze<UnsupportedBootPlanInit<Chunk>>({
    id: UNSUPPORTED_HOST_MODE,
    match: { hostModes: [UNSUPPORTED_HOST_MODE], formFactors: options.formFactors ?? BUILT_IN_FORM_FACTORS.map((f) => f.id) },
    critical: options.chunk === undefined ? [] : [options.chunk],
    eager: [],
    preload: [],
    historyStrategy: 'memory',
    shellPreset: 'unsupported',
    description: 'Required platform baseline failed: one screen naming what is missing; nothing else loads.',
  });
}

export const BaselineVerdictToken = /* @__PURE__ */ token('platform/baseline-verdict').type<BaselineVerdict>();

export function baselineVerdictUnit(verdict: BaselineVerdict): AnyUnit {
  const contribution = unit({
    id: 'platform/baseline-verdict-unit',
    provides: BaselineVerdictToken,
    scope: 'app',
    description: `Baseline "${verdict.baseline}" verdict: ${verdict.status}.`,
    create: () => verdict,
  });
  return contribution;
}

/** The preset's units: the verdict and the `unsupported` host mode (add next to `platformUnits()`). */
export function unsupportedUnits(verdict: BaselineVerdict): readonly AnyUnit[] {
  return [baselineVerdictUnit(verdict), hostModeUnit(unsupportedHostMode(verdict))];
}
