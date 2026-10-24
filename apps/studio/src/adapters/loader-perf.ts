/**
 * Adapter: @staticflux/loader manifest → @staticflux/perf script attribution (R17.9):
 * long-animation-frame script URLs map to logical chunk ids, hence to features.
 */
import { unit } from '@staticflux/core';
import { ChunkManifestToken, chunkAttributor } from '@staticflux/loader';
import { ScriptAttributionToken } from '@staticflux/perf';

export const chunkScriptAttributionUnit = unit({
  id: 'studio/chunk-script-attribution-unit',
  provides: ScriptAttributionToken,
  scope: 'app',
  deps: { required: { manifest: ChunkManifestToken } },
  create: ({ manifest }) => chunkAttributor(manifest),
  description: 'LoAF script URL → chunk id.',
});
