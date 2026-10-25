/**
 * `@instaflow/app/lenses` — the Pages and Canvas lenses as per-mode features (IF-1.3, D4, D19;
 * Instaflow M1b B4): the composition structure reader, the `LensFeature` interface with its Pages and
 * Canvas implementations, the feature registry, the lens controller (arrangement, page navigation,
 * camera requests, shortcuts) and story edits. Headless; the Pages panel is in `@instaflow/app/lenses/ui`.
 */
export * from './errors.js';
export * from './structure.js';
export * from './lens-feature.js';
export * from './pages-lens.js';
export * from './canvas-lens.js';
export * from './lens-features.js';
export * from './controller.js';
export * from './story.js';
export * from './tokens.js';
export * from './units.js';
