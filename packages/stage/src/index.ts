/**
 * `@staticflux/stage` (SF-Δ7, Δ9, Δ10): the composed stage over document parts (session and local layers, a seam
 * for proposal layers, reference/inherit/variant arcs, final paths, provenance, locks), actor records for
 * attribution, and the per-actor undo service with conflict flagging.
 */
export * from './errors.js';
export * from './actor.js';
export * from './attribution.js';
export * from './source.js';
export * from './layers.js';
export * from './rules.js';
export * from './stage.js';
export * from './undo.js';
export * from './guard.js';
export * from './units.js';
