/**
 * `@staticflux/document/v2` — engine-independent document model v2 (SF-Δ3–Δ6):
 * `DocumentCRDTv2` (port), gestures, `DocumentRepo` over a `DocumentStore` port,
 * versioned components with JSON Schema, canonical parts (RFC 8785) and commit
 * records. No CRDT engine here: the Loro engine is `@staticflux/document/loro-crdt`
 * (worker only, its own Wasm budget). The v1 ECS engine stays at `@staticflux/document`.
 */
export * from './errors.js';
export * from './json.js';
export * from './crdt-v2.js';
export * from './gesture.js';
export * from './components.js';
export * from './canonical.js';
export * from './store.js';
export * from './commit-record.js';
export * from './repo.js';
