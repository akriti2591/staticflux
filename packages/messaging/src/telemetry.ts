/**
 * Messaging telemetry: subsystem and declared metrics (R13.10, R17.17).
 * Every surface informs shown / dismissed (with reason) / rejected / dwell.
 */
import { metric, type Subsystem } from '@staticflux/core';

export const MESSAGING_SUBSYSTEM = 'messaging/surfaces' as const satisfies Subsystem;

export const messagingMetrics = {
  /** attrs: surface, kind */
  shown: /* @__PURE__ */ metric.counter('messaging/surface-shown', { description: 'Surfaces that reached showing.' }),
  /** attrs: surface, kind, reason */
  dismissed: /* @__PURE__ */ metric.counter('messaging/surface-dismissed', { description: 'Surface dismissals by reason.' }),
  /** attrs: surface, kind, reason (gated | seen | scope | target-missing | load-failed) */
  rejected: /* @__PURE__ */ metric.counter('messaging/surface-rejected', { description: 'Surfaces rejected before showing.' }),
  /** Time on screen while showing (suspended time excluded). attrs: surface, kind, reason */
  dwell: /* @__PURE__ */ metric.histogram('messaging/surface-dwell', { unit: 'ms', description: 'Surface dwell time.' }),
  /** Requests answered by an existing surface (banner dedup). attrs: surface */
  deduped: /* @__PURE__ */ metric.counter('messaging/surface-deduped', { description: 'Deduplicated surface requests.' }),
} as const;
