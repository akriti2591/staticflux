/**
 * Instaflow tools (M1b B3): hit testing (rbush broad phase → exact B1 geometry), select, Shift / Mod multi-select,
 * marquee, round transform handles (move, resize, rotate), nudge, smart guides and snapping (edges, centres,
 * container, layout grids, equal spacing with distance labels), per-tab view state, keyboard paths and the B0
 * contributions. Editor worker (headless); see AGENTS.md in this folder.
 */
export * from './errors.js';
export * from './view-state.js';
export * from './hit-test.js';
export * from './snapping.js';
export * from './transform.js';
export * from './overlay.js';
export * from './gesture.js';
export * from './keyboard.js';
export * from './contributions.js';
