/**
 * Editor ↔ render pipeline plumbing (SF-Δ17–Δ19, D15). Topology-neutral ports:
 * every pipe runs with both ends in one worker (`local` medium) or across
 * workers (`shared` SharedArrayBuffer + Atomics, or `message` postMessage), so
 * one worker or two is a boot-time setting. Separate entry point so apps that
 * do not run a pipeline pay nothing.
 *
 * - regions and media (`region.ts`): `selectMedium`, `createRegion`, `attachRegion`
 * - seqlock cells (`seqlock-cell.ts`) and the clock cell (`clock-cell.ts`)
 * - lossless SPMC record rings (`record-ring.ts`) — the binary input ring
 * - sequenced delta streams with gap → resnapshot (`delta-stream.ts`)
 * - the content-addressed blob side channel (`side-channel.ts`)
 * - handle channels with ownership and close accounting (`handle-channel.ts`)
 * - brokered peer channels that re-wire on respawn (`peer-channel.ts`)
 * - optimistic intents with supersede-on-ack (`optimistic.ts`)
 * - query / windowed replicas (`windowed-replica.ts`)
 */
export * from './pipeline-errors.js';
export * from './hash.js';
export * from './region.js';
export * from './seqlock-cell.js';
export * from './clock-cell.js';
export * from './record-ring.js';
export * from './delta-stream.js';
export * from './side-channel.js';
export * from './handle-channel.js';
export * from './peer-channel.js';
export * from './optimistic.js';
export * from './windowed-replica.js';
