/**
 * @staticflux/gate — facts, declarative policies compiled to decision tables,
 * explainable reactive decisions, meters.
 *
 * CLIENT GATING IS UX, NOT SECURITY (R6.16). Every decision is advisory: it
 * decides what to render, load or attempt. The server re-checks everything.
 */
export * from './errors.js';
export * from './facts.js';
export * from './policy.js';
export * from './compiler.js';
export * from './meters.js';
export * from './engine.js';
export * from './units.js';
