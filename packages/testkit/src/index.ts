/**
 * @staticflux/testkit — test injector, deterministic time, fake session, shared
 * contract suites and the fakes other packages ship (R16.1–R16.4).
 * Test-only: never import from app code.
 */
export * from './errors.js';
export * from './telemetry.js';
export * from './injector.js';
export * from './time.js';
export * from './session.js';
export * from './contract-runner.js';
export * from './transport-contract.js';
export * from './history-contract.js';
export * from './app.js';
export * from './fakes.js';
// Render, GPU and media testing (environment-free; Node-only helpers are in `@staticflux/testkit/node`).
export * from './image.js';
export * from './ssim.js';
export * from './compare.js';
export * from './gpu-readback.js';
export * from './gpu-fake.js';
export * from './media-fake.js';

export * from './document-store-contract.js';
export * from './document-repo-contract.js';
export * from './document-crdt-contract.js';
