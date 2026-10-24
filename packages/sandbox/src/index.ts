/**
 * @staticflux/sandbox — host untrusted third-party plugins in isolated realms
 * (sandboxed iframe / worker) that can only call capabilities granted to them,
 * receive declared events and render into a host slot (R3.4).
 *
 * Client gating is UX, not security (R6.16): the server re-checks everything.
 */
export * from './errors.js';
export * from './manifest.js';
export * from './protocol.js';
export * from './limits.js';
export * from './realm.js';
export * from './host.js';
export * from './sdk.js';
export * from './units.js';
