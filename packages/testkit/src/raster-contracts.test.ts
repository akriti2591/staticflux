import { createMemoryRasterBackend, type MemoryRasterDelta } from '@staticflux/surface/raster';
import { describe, it } from 'vitest';
import { type RasterContractScene, runRasterBackendContract } from './raster-backend-contract.js';

/** Box operations as memory-backend deltas. */
const memoryScene: RasterContractScene<MemoryRasterDelta> = {
  add: (id, rect, color) => ({ set: [{ id, rect, color }] }),
  set: (id, rect, color) => ({ set: [{ id, rect, color }] }),
  remove: (id) => ({ remove: [id] }),
};

// Reference CPU backend with 64 px tiles: the 128 px contract view needs four of them.
runRasterBackendContract('memory, 64 px tiles', () => ({ backend: createMemoryRasterBackend({ tileSize: 64, maxRegionSize: 256 }), scene: memoryScene, tolerance: 0 }), { describe, it });
// One tile larger than the view, the shape of the Vello backend (512 px tiles).
runRasterBackendContract('memory, 512 px tiles', () => ({ backend: createMemoryRasterBackend({ tileSize: 512, maxRegionSize: 1024 }), scene: memoryScene, tolerance: 0 }), { describe, it });
