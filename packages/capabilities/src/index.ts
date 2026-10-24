/**
 * @staticflux/capabilities — typed, schema-described actions callable by the UI,
 * the command palette and AI agents through one gated, confirmed, metered,
 * traced pipeline (R3.1–R3.4, R6.17, R19.18).
 *
 * Client gating is UX, not security (R6.16): the server re-checks everything.
 */
export * from './errors.js';
export * from './schema.js';
export * from './capability.js';
export * from './ports.js';
export * from './registry.js';
export * from './units.js';
