/**
 * Editor spec errors (`IF-SPEC-*`, M1b B0). Slot-level validation problems (unknown ids, scope
 * mismatches, gating denials, placements) are the framework's SF-SHELL-009…013 issues; these codes cover
 * what is Instaflow's: the `EditorSpec` schema, the contribution registries, proposals and the canvas.
 */
import { defineError } from '@staticflux/core';

export const EditorSpecSchemaError = defineError(
  'IF-SPEC-001',
  'validation',
  'The editor spec is not well-formed (a proposer sent a value that does not match the `EditorSpec` schema).',
  'Read `details.issues` (JSON paths). Agents get the schema from `proposeSpecCapability` (`toJsonSchema`); presets are type-checked with `defineEditorSpec`.',
);

export const ContributionRegistryError = defineError(
  'IF-SPEC-002',
  'invariant',
  'Two editor contributions share an id, or a contribution names a lens, placement or scope that does not exist.',
  'Contribution ids are app-unique (`instaflow/<name>`); a tool’s `lenses` must name registered lens contributions. The cause names the clash.',
);

export const ProposalStateError = defineError(
  'IF-SPEC-003',
  'conflict',
  'The spec proposal is not in a state that allows this action (it was rejected, declined, superseded or already mounted).',
  'Check `proposal.state` first; open or decline only proposals in `previewing`. A newer proposal supersedes older ones.',
);

export const ProposerFailedError = defineError(
  'IF-SPEC-004',
  'unavailable',
  'The spec proposer failed to answer (an agent turn errored or was cancelled).',
  'Nothing changed on screen. Retry the turn, or keep editing by hand: every Studio feature has a non-agent path.',
);

/** B11a2: the HUD / inspector control model (STUDIO-UX-SPEC §4.2.1). */
export const ControlModelError = defineError(
  'IF-POL-001',
  'invariant',
  'A selection kind declares its controls inconsistently: two controls share an id, two share a HUD rank, or more than six have a HUD rank.',
  'Give every control a unique id; ranks 1–6 at most once each (`details.problem` names which). Controls without a rank still show in the inspector and the More menu.',
);

export const CanvasStartError = defineError(
  'IF-SPEC-005',
  'unavailable',
  'The canvas region could not start the editor ↔ render pipeline.',
  'The cause is the sequencing boot error (IF-SEQ-001 names the step). The rest of the Studio shell stays usable; reload or retry the canvas.',
);
