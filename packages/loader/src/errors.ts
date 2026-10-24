/**
 * Error catalog of @staticflux/loader. Codes are stable (`SF-LOAD-NNN`); agents
 * look them up instead of guessing. Every error carries a concrete `fix`.
 */
import { defineError } from '@staticflux/core';

export const UnknownChunkError = defineError(
  'SF-LOAD-001',
  'not-found',
  'The logical chunk id is not in the build manifest.',
  'Declare the chunk with `chunk(id, …)`, list it in the build plugin declarations and rebuild; check for a stale `sf-manifest.json`.',
);

/** I-8: a gated-out chunk is never fetched. */
export const ChunkDeniedError = defineError(
  'SF-LOAD-002',
  'forbidden',
  'The chunk gate denied this chunk; nothing was fetched (I-8).',
  'Expected for gated-out features: render the upsell/unavailable surface instead. The gate (`canLoad`) decides; do not bypass it.',
);

export const ChunkFetchError = defineError(
  'SF-LOAD-003',
  'network',
  'A chunk failed to load after retries.',
  'Inspect `cause` (404 after deploy → reload with the new manifest; CORS/CORP → check the isolation policy `crossorigin`).',
);

export const SharedVersionMismatchError = defineError(
  'SF-LOAD-004',
  'conflict',
  'A federated remote requires a shared singleton version the host does not provide.',
  'Align the remote build with the host singleton versions (P9: one version per app), or widen the remote `requiredVersion` range with a reason.',
);

export const RemoteContainerError = defineError(
  'SF-LOAD-005',
  'unavailable',
  'A federated remote container could not be loaded or does not expose the module.',
  'Check the remote entry URL in the manifest (`remote.entry`) and the exposed module name (`remote.module`).',
);

export const EagerWithoutReasonError = defineError(
  'SF-LOAD-006',
  'validation',
  "A chunk declared `load: 'eager'` without a reason (R12.12).",
  "Add `reason: '…'` to the declaration, or drop `load: 'eager'` (everything is lazy by default).",
);

export const InvalidManifestError = defineError(
  'SF-LOAD-007',
  'validation',
  'The build manifest is malformed or has an unsupported format version.',
  'Regenerate `sf-manifest.json` with `createManifest()` from the same @staticflux/loader version the app runs.',
);

export const ProfileExcludedError = defineError(
  'SF-LOAD-008',
  'unavailable',
  "The chunk is scoped to other app profiles; code for other modes is never fetched (R12.10).",
  'Bind a per-mode variant feature for this profile (R18.5) instead of loading the other mode\'s chunk.',
);

export const NoBootPlanError = defineError(
  'SF-LOAD-009',
  'invariant',
  'No boot plan matches the current app profile.',
  'Add a fallback boot plan without a `match` (it matches every profile), or a plan whose `match` covers this profile.',
);

export const ManifestBuildError = defineError(
  'SF-LOAD-010',
  'validation',
  'The bundler output does not contain an entry for a declared chunk, or a declared dependency is unknown.',
  'Make sure each declaration\'s `entry` matches a bundler entry/dynamic-import module (or chunk name), and every `deps` id is declared.',
);

export const ImportMapUnsupportedError = defineError(
  'SF-LOAD-011',
  'unavailable',
  'Import maps are unsupported here, or a module script ran before the import map was installed.',
  'Use the dynamic-import strategy as fallback (the default), or install the import map before any module script.',
);
