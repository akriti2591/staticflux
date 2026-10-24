/**
 * Router telemetry: subsystems, declared metrics (R17.17) and the navigation machine
 * (docs/LIFECYCLES.md §7).
 *
 * Spans (R17.5, R17.6, R17.9):
 *   nav.pipeline (router/navigation)        one per full navigation; `nav.view` / `nav.dialog` for light ones
 *     └ nav.stage (router/pipeline)          one per stage, attrs { stage }
 *         └ nav.step (router/pipeline, verbose) one per plugin / guard
 * Journey marks: `router/nav-start`, `router/nav-commit` (value = telemetry clock, ms).
 */
import { defineMachine, metric, type Subsystem } from '@staticflux/core';

export const ROUTER_SUBSYSTEMS = {
  navigation: 'router/navigation',
  pipeline: 'router/pipeline',
  history: 'router/history',
} as const satisfies Record<string, Subsystem>;

export const routerMetrics = {
  /** Navigation start mark (attrs: kind, trigger, start: cold|soft). */
  navStart: /* @__PURE__ */ metric.mark('router/nav-start', { description: 'Navigation pipeline started.' }),
  /** Navigation commit mark (attrs: kind, route, start). */
  navCommit: /* @__PURE__ */ metric.mark('router/nav-commit', { description: 'Navigation committed (URL + route state updated).' }),
  /** Pipeline duration (attrs: kind, outcome). */
  navDuration: /* @__PURE__ */ metric.histogram('router/nav-duration', { unit: 'ms', description: 'Navigation pipeline duration.' }),
  /** Stage duration (attrs: stage, kind). */
  stageDuration: /* @__PURE__ */ metric.histogram('router/stage-duration', { unit: 'ms', description: 'Navigation stage duration.' }),
  /** Finished navigations (attrs: kind, outcome). */
  navigations: /* @__PURE__ */ metric.counter('router/navigations', { description: 'Navigations by outcome.' }),
  /** Sub-route view transition duration (R12.7 ≤ 150 ms). */
  viewTransition: /* @__PURE__ */ metric.histogram('router/view-transition', { unit: 'ms', description: 'Light (view) pipeline duration.' }),
} as const;

export const NAVIGATION_STATES = ['idle', 'running', 'committed', 'cancelled', 'redirected', 'blocked', 'failed'] as const;
export type NavigationStatus = (typeof NAVIGATION_STATES)[number];
export type NavigationEvent = 'start' | 'commit' | 'cancel' | 'redirect' | 'block' | 'fail' | 'settle';

const restart = { start: 'running', settle: 'idle' } as const;

/**
 * Router-level navigation machine: idle → running(stage) → committed → idle;
 * running → cancelled | redirected | blocked | failed. An outcome is followed by `settle`
 * (→ idle) or directly by the next `start` (superseding / redirect target).
 * The current stage is tracked next to the machine (`router.stage`).
 */
export const navigationMachine = defineMachine<NavigationStatus, NavigationEvent>({
  id: 'router/navigation',
  initial: 'idle',
  states: NAVIGATION_STATES,
  transitions: {
    idle: { start: 'running' },
    running: { commit: 'committed', cancel: 'cancelled', redirect: 'redirected', block: 'blocked', fail: 'failed' },
    committed: restart,
    cancelled: restart,
    redirected: restart,
    blocked: restart,
    failed: restart,
  },
});
