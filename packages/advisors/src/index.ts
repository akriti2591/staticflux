/**
 * @staticflux/advisors — decision points and pluggable advisors (heuristic,
 * statistical, model, remote) behind one typed contract (R19.5–R19.14).
 *
 * Advisors suggest; the framework decides. Never used for authorization,
 * entitlement or security decisions (R19.9).
 */
export * from './errors.js';
export * from './decision.js';
export * from './advisor.js';
export * from './statistical.js';
export * from './model.js';
export * from './service.js';
export * from './units.js';
