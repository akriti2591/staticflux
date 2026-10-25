/**
 * Instaflow repeat (M1b B7): live, non-destructive radial, grid and mirror repeats. The `repeat` component, the
 * repeat view over the stage (derived instances for the render projection, bounds, booleans, masks and hit tests),
 * instance placements, actions (make, edit, release, expand), on-canvas handles, the panel model and the B0
 * contributions. Editor worker; the panel element is a separate entry (`@instaflow/app/repeat/panel`). See AGENTS.md.
 */
export * from './errors.js';
export * from './components.js';
export * from './params.js';
export * from './instances.js';
export * from './stage.js';
export * from './actions.js';
export * from './hit.js';
export * from './handles.js';
export * from './inspector.js';
export * from './contributions.js';
