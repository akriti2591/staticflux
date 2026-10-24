/**
 * @staticflux/ai — one model provider port over browser built-in AI,
 * on-device and decision models (Jev-like) and remote LLMs (R19.15, R19.17).
 * AI is never on the critical path: every call is async, cancellable and
 * fallible, and availability is a reactive fact features gate on.
 */
export * from './errors.js';
export * from './provider.js';
export * from './decision-model.js';
export * from './browser.js';
export * from './remote.js';
export * from './mock.js';
export * from './router.js';
export * from './units.js';
