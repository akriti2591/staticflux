/**
 * Capabilities the editor specs name. `proposeSpecCapability` is the M2 seam for agents: an agent
 * proposes an editor spec through the capability pipeline (validated, gated as the agent, attributed)
 * and the proposals service takes it from there (`createSpecProposals().capability`).
 * `editDocumentCapability` marks surfaces that may edit the document (read-only specs omit it; B1–B3
 * edits run through their own capabilities and are gated again per call).
 */
import { defineCapability, s } from '@staticflux/capabilities';
import { EditorSpecSchema } from './schema.js';

export const PROPOSAL_STATES = ['proposed', 'validated', 'rejected', 'previewing', 'mounting', 'mounted', 'declined', 'superseded', 'failed'] as const;

export const proposeSpecCapability = defineCapability({
  id: 'instaflow/propose-spec',
  title: 'Propose an editor',
  description: 'Propose an editor spec (lens, scope, tools, panels, HUD actions) built only from registered contributions. In Ask it is shown as a preview the person opens; in Accept edits it mounts.',
  input: s.object({ spec: EditorSpecSchema, reason: s.optional(s.string({ maxLength: 280, description: 'Why this editor helps (shown with the preview)' })) }),
  output: s.object({ proposal: s.string({ description: 'Proposal id' }), state: s.enum(PROPOSAL_STATES) }),
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const editDocumentCapability = defineCapability({
  id: 'instaflow/edit-document',
  title: 'Edit the document',
  description: 'Marks an editor surface as able to edit the document; every edit is still its own gated capability call.',
  input: s.object({}),
  output: s.object({}),
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: false,
});
