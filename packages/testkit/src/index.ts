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
export * from './blob-store-contract.js';

export * from './theme-contract.js';
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
export * from './undo-service-contract.js';

// Pipeline contract suites (Instaflow M1 A5: SF-Δ17–Δ19).
export * from './pipe-contract-support.js';
export * from './seqlock-cell-contract.js';
export * from './clock-cell-contract.js';
export * from './record-ring-contract.js';
export * from './delta-stream-contract.js';
export * from './blob-side-channel-contract.js';
export * from './handle-channel-contract.js';
export * from './peer-channel-contract.js';
export * from './windowed-replica-contract.js';

// Sequencing oracle (Instaflow M1 A7: IF-7.3, D15; the S2 oracle as a shared suite).
export * from './sequencing-oracle-contract.js';

// Render contract suite (Instaflow M1 A6: IF-7.4, SF-Δ23, Δ24).
export * from './raster-backend-contract.js';

// Spec runtime and mount port suites (Instaflow M1b B0: D16, R13.25–R13.29).
export * from './spec-runtime-contract.js';
export * from './spec-mount-port-contract.js';

// TextInput contract suite (Instaflow M1b B2: SF-Δ27, R16.31).
export * from './text-input-contract.js';
