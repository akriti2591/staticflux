/**
 * Instaflow render module, TypeScript side (M1 A6): the Vello GPU `RasterBackend`, the render Wasm
 * loader and the scene IR encoder. Policy (tiles, budgets, device lifecycle, headless tiling) comes
 * from `@staticflux/surface/raster`; see AGENTS.md in this folder.
 */
export * from './scene-ir.js';
export * from './render-module.js';
export * from './vello-backend.js';
