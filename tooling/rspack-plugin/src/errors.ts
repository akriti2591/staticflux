/**
 * Error catalog of @staticflux/rspack-plugin. Codes are stable (`SF-RSPACK-NNN`); each has a
 * concrete fix. Loader errors (`SF-LOAD-*`) from the manifest builder are wrapped as `cause`.
 */
import { defineError } from '@staticflux/core';

export const RspackManifestBuildError = defineError(
  'SF-RSPACK-001',
  'validation',
  'The sf-manifest could not be built from the Rspack compilation.',
  'Read the wrapped SF-LOAD code: name each logical chunk\'s chunk group `chunkNameFor(id)` (entry name or `webpackChunkName`) or give it an `entry` matching the `import()` request, declare every `deps` id, and give eager chunks a `reason`.',
);

export const RspackBudgetExceededError = defineError(
  'SF-RSPACK-002',
  'quota',
  'A chunk, eager boot cost or per-profile boot JS exceeds its budget (R12.7).',
  'Split or lazy-load the offending chunk, drop `load: \'eager\'`, or raise the budget with a reviewed reason (R12.8). Use `budgets.onViolation: \'warn\'` to report without failing.',
);

export const RspackBootPlanError = defineError(
  'SF-RSPACK-003',
  'validation',
  'Per-profile preloads could not be computed from the boot plans.',
  'Every profile needs a matching boot plan (add a fallback plan without `match`), and every chunk a plan lists must be declared in `chunks`.',
);

export const RspackOptionsError = defineError(
  'SF-RSPACK-004',
  'validation',
  'The staticfluxRspack() plugin options are invalid.',
  'Check the options: chunk ids are unique `kind:name` ids, `bootPlans` need `profiles`, `html.profile` must be one of `profiles`.',
);

export const FederationSharedMismatchError = defineError(
  'SF-RSPACK-005',
  'conflict',
  'A Module Federation shared singleton/version declared by the host does not satisfy a requirement (host or remote).',
  'Align versions so one singleton version serves the app (P9): bump the host dependency, align the remote build, or widen `requiredVersion` with a reviewed reason. Remote singletons must also be shared as singletons by the host.',
);

export const FederationRemoteError = defineError(
  'SF-RSPACK-006',
  'validation',
  'A logical chunk maps to an unknown Module Federation remote or exposed module.',
  'Map each id to `"<remote>/<exposed>"` where `<remote>` is a key of the ModuleFederationPlugin `remotes` and `<exposed>` is listed in that remote\'s `exposes` (mf-manifest.json); declare the chunk with `chunk(id, …)`.',
);

export const FederationEntryError = defineError(
  'SF-RSPACK-007',
  'validation',
  'The remote entry URL for a federated chunk cannot be determined.',
  'Use `"name@https://…/remoteEntry.js"` in `remotes`, or pass the remote\'s mf-manifest.json content in `federation.manifests[name]` when `remotes` points at an mf-manifest.json URL.',
);
