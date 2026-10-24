/**
 * UI telemetry: subsystem names and declared metrics (R17.17, R17.19, R12.20).
 */
import { metric, type Subsystem } from '@staticflux/core';

export const UI_SUBSYSTEMS = {
  component: 'ui/component',
  scope: 'ui/scope',
  render: 'ui/render',
} as const satisfies Record<string, Subsystem>;

export const uiMetrics = {
  /** Update passes per component (attrs: tag, outcome, reason). */
  renders: metric.counter('ui/renders', { description: 'Component update passes.' }),
  /** Synchronous update duration (attrs: tag). */
  renderDuration: metric.histogram('ui/render-duration', { unit: 'ms', description: 'Component update duration.' }),
  /** Connect → first real content (attrs: tag). */
  timeToContent: metric.histogram('ui/time-to-content', {
    unit: 'ms',
    description: 'Component connected → first content commit (placeholder time).',
  }),
} as const;
