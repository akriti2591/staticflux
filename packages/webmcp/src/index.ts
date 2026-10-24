/**
 * @staticflux/webmcp — publishes capabilities as WebMCP tools; every tool call
 * goes through the capability pipeline as subject `agent` (gating,
 * confirmation, metering, tracing) — R19.16. Client gating is UX, not security.
 */
export * from './errors.js';
export * from './adapter.js';
export * from './publisher.js';
export * from './confirm.js';
export * from './units.js';
