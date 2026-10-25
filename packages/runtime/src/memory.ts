/**
 * `@staticflux/runtime/memory` (SF-Δ29): the cache memory ledger — GPU textures, decoded media and other
 * byte-heavy caches register bytes and eviction callbacks; budgets per kind tighten under memory pressure,
 * and caches are evicted before features are demoted. Used by render, media and export workers.
 */
export * from './memory-budgets.js';
export * from './memory-units.js';
export { MemoryBudgetsToken } from './tokens.js';
