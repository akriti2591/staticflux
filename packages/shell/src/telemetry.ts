/**
 * Shell telemetry: subsystem and declared metrics.
 */
import { metric, type Subsystem } from '@staticflux/core';

export const SHELL_SUBSYSTEM = 'shell/layout' as const satisfies Subsystem;

export const shellMetrics = {
  /** attrs: command, outcome (ok | error) */
  commandRuns: /* @__PURE__ */ metric.counter('shell/command-runs', { description: 'Commands run (palette, shortcut, API).' }),
  /** attrs: region, code */
  boundaryErrors: /* @__PURE__ */ metric.counter('shell/boundary-errors', { description: 'Errors caught by region boundaries.' }),
  /** attrs: animated */
  viewTransitions: /* @__PURE__ */ metric.counter('shell/view-transitions', { description: 'View transitions run (or skipped).' }),
} as const;
