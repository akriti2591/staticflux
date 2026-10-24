/**
 * DI units of @staticflux/ui. Apps register `uiUnits` (defaults) and override
 * any port with `bind(unit, { precedence: 'app' })`:
 *
 * - `renderSchedulerUnit`     — RenderScheduler over the runtime FrameScheduler (one pass per frame).
 * - `visibilityObserverUnit`  — IntersectionObserver visibility (degrades to visible).
 * - `noIsolationPolicyUnit`   — IsolationPolicy no-op (bind `isolationPolicyUnitWith(...)` when isolated).
 * - `allowAllDecideUnit`      — DecidePort default (bind the gate adapter in apps).
 * - `uiEnvironmentUnit`       — the UiEnvironment carried by the root `<sf-scope>`.
 */
import { unit } from '@staticflux/core';
import { FrameSchedulerToken } from '@staticflux/runtime';
import {
  allowAllDecide,
  createIsolationPolicy,
  DecideToken,
  frameRenderScheduler,
  intersectionVisibility,
  type IsolationPolicyOptions,
  IsolationPolicyToken,
  noIsolationPolicy,
  RenderObserversToken,
  RenderSchedulerToken,
  UiEnvironmentToken,
  VisibilityObserverToken,
} from './ports.js';

export const renderSchedulerUnit = unit({
  id: 'ui/render-scheduler-unit',
  provides: RenderSchedulerToken,
  scope: 'app',
  deps: { required: { frames: FrameSchedulerToken } },
  create: ({ frames }) => frameRenderScheduler(frames),
  description: 'Component updates coalesce into the runtime frame flush (R12.13).',
});

export const visibilityObserverUnit = unit({
  id: 'ui/visibility-observer-unit',
  provides: VisibilityObserverToken,
  scope: 'app',
  create: () => intersectionVisibility(),
  description: 'on-visible init timing via IntersectionObserver (visible when unsupported).',
});

export const noIsolationPolicyUnit = unit({
  id: 'ui/no-isolation-policy-unit',
  provides: IsolationPolicyToken,
  scope: 'app',
  create: () => noIsolationPolicy,
  description: 'IsolationPolicy for isolation "off": never adds crossorigin.',
});

/** IsolationPolicy from the app isolation mode + platform facts (R11.16b). */
export function isolationPolicyUnitWith(options: IsolationPolicyOptions) {
  return unit({
    id: 'ui/isolation-policy-unit',
    provides: IsolationPolicyToken,
    scope: 'app',
    create: () => createIsolationPolicy(options),
    description: `IsolationPolicy (${options.mode}, isolated=${String(options.isolated)}).`,
  });
}

export const allowAllDecideUnit = unit({
  id: 'ui/allow-all-decide-unit',
  provides: DecideToken,
  scope: 'app',
  create: () => allowAllDecide,
  description: 'Default DecidePort: allow everything. Apps bind an adapter over @staticflux/gate.',
});

export const uiEnvironmentUnit = unit({
  id: 'ui/environment-unit',
  provides: UiEnvironmentToken,
  scope: 'app',
  deps: {
    required: {
      scheduler: RenderSchedulerToken,
      visibility: VisibilityObserverToken,
      isolation: IsolationPolicyToken,
      renderObservers: RenderObserversToken,
    },
  },
  create: ({ scheduler, visibility, isolation, renderObservers }, ctx) => ({
    scheduler,
    visibility,
    isolation,
    renderObservers,
    now: () => ctx.telemetry.now(),
  }),
  description: 'UiEnvironment for the root <sf-scope>: scheduler, visibility, isolation, render observers.',
});

/** Default UI units (requires the runtime frame scheduler unit). */
export const uiUnits = [
  renderSchedulerUnit,
  visibilityObserverUnit,
  noIsolationPolicyUnit,
  allowAllDecideUnit,
  uiEnvironmentUnit,
] as const;
