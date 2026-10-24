/**
 * DI tokens and units for @staticflux/webmcp.
 *
 *   createInjector({ units: [...capabilityUnits, ...webMcpUnits] })
 *
 * The publisher registers tools in `init` (after the capability registry is
 * ready) and unregisters them when the app scope is disposed. Wrap the app's
 * confirm port with `webMcpConfirmPort(...)` to confirm inside the agent
 * client's user interaction.
 */
import { ok, token, unit } from '@staticflux/core';
import { CapabilityRegistryToken } from '@staticflux/capabilities';
import { detectModelContext, type ModelContextAdapter } from './adapter.js';
import { createWebMcpPublisher, WebMcpMetrics, type WebMcpPublisher } from './publisher.js';

export const ModelContextAdapterToken = token('webmcp/model-context').type<ModelContextAdapter>();
export const WebMcpPublisherToken = token('webmcp/publisher').type<WebMcpPublisher>();

export const modelContextAdapterUnit = unit({
  id: 'webmcp/model-context-unit',
  provides: ModelContextAdapterToken,
  scope: 'app',
  create: () => detectModelContext(),
  description: 'Feature-detected navigator/document modelContext (a no-op adapter where WebMCP is missing).',
});

export const webMcpPublisherUnit = unit({
  id: 'webmcp/publisher-unit',
  provides: WebMcpPublisherToken,
  scope: 'app',
  deps: { required: { registry: CapabilityRegistryToken, adapter: ModelContextAdapterToken } },
  informs: Object.values(WebMcpMetrics),
  create: ({ registry, adapter }, ctx) => createWebMcpPublisher({ registry, adapter, telemetry: ctx.telemetry, scope: ctx.scope }),
  init: (publisher) => {
    publisher.start();
    return ok();
  },
  description: 'Publishes agent-exposed capabilities as WebMCP tools; every call runs the capability pipeline as subject "agent".',
});

/** One-line opt-in (requires the capability registry, e.g. `capabilityUnits`). */
export const webMcpUnits = [modelContextAdapterUnit, webMcpPublisherUnit] as const;
