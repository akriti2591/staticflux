/**
 * Adapter: @staticflux/gate → @staticflux/loader. The chunk gate asks the gate before
 * any fetch, so a denied feature's code is never downloaded (I-8). UX, not security.
 */
import { unit } from '@staticflux/core';
import { GateToken } from '@staticflux/gate';
import { type ChunkGate, ChunkGateToken, type ChunkIdShape } from '@staticflux/loader';
import { Chunks } from '../app/contracts.js';
import { GateIds } from '../app/policies.js';

/** Chunks behind a feature-level gate resource. Ungated chunks are allowed. */
const GATED_CHUNKS: Readonly<Partial<Record<ChunkIdShape, string>>> = {
  [Chunks.studioDesktop]: GateIds.studioFeature,
  [Chunks.studioMobile]: GateIds.studioFeature,
};

export const gateChunkGateUnit = unit({
  id: 'studio/gate-chunk-gate-unit',
  provides: ChunkGateToken,
  scope: 'app',
  deps: { required: { gate: GateToken } },
  create: ({ gate }): ChunkGate => (id) => {
    const resource = GATED_CHUNKS[id];
    if (resource === undefined) return true;
    const decision = gate.decide('feature', resource);
    return decision.effect === 'allow' ? true : { allow: false, reason: decision.reason };
  },
  description: 'Chunk gate → gate decisions (denied chunks are never fetched, I-8).',
});
