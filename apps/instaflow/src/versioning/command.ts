/**
 * The "Milestone" command (UX §7): one capability, so the top bar button, the command palette,
 * the `Mod+Alt+S` shortcut and agents (WebMCP, after approval) all go through the same pipeline.
 *
 * - With a `name`, it creates the milestone as the invoking actor (agents act for their human).
 * - Without one (palette, shortcut, the top bar button), it asks the host to open the inline
 *   "Create milestone" form (name, note) and reports `prompted`: a person always names it.
 */
import { type CapabilityImplementation, type CapabilityInput, type CapabilityOutput, defineCapability, implementCapability, type RunContext, s } from '@staticflux/capabilities';
import { err, ok, type Result } from '@staticflux/core';
import type { KeyCombo } from '@staticflux/a11y';
import type { Actor } from '@staticflux/stage';
import type { MilestoneService } from './milestones.js';
import { MAX_MILESTONE_NAME, MAX_MILESTONE_NOTE } from './tokens.js';

export const CreateMilestoneCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/create-milestone',
  title: 'Milestone',
  description:
    'Create a named, immutable milestone (a full snapshot) of the open document. Latest is saved continuously, so this is never needed to save. Without a name, the "Create milestone" form opens for the person to name it.',
  input: s.object({
    name: s.optional(s.string({ maxLength: MAX_MILESTONE_NAME, description: 'Milestone name, e.g. "Client v2"' })),
    note: s.optional(s.string({ maxLength: MAX_MILESTONE_NOTE, description: 'Optional note' })),
  }),
  output: s.object({
    status: s.enum(['created', 'prompted'] as const),
    id: s.optional(s.string()),
    name: s.optional(s.string()),
  }),
  requiresConfirmation: false,
  destructive: false,
});

/** `Mod+Alt+S` opens "Create milestone" (UX §7). */
export const CREATE_MILESTONE_SHORTCUT: KeyCombo = 'Mod+Alt+S';

export interface CreateMilestoneCommandOptions {
  readonly milestones: Pick<MilestoneService, 'create'>;
  /** The actor of an invocation (the stage attribution port's `actorFor`). */
  readonly actorFor: (run: RunContext) => Result<Actor>;
  /** Open the inline "Create milestone" form (the panel contribution's `promptCreate`). */
  readonly prompt: () => void;
}

export type MilestoneCommandInput = CapabilityInput<typeof CreateMilestoneCapability>;
export type MilestoneCommandOutput = CapabilityOutput<typeof CreateMilestoneCapability>;

export function implementCreateMilestone(options: CreateMilestoneCommandOptions): CapabilityImplementation<MilestoneCommandInput, MilestoneCommandOutput> {
  return implementCapability(CreateMilestoneCapability, async (input, run): Promise<Result<MilestoneCommandOutput>> => {
    if (input.name === undefined || input.name.trim().length === 0) {
      options.prompt();
      return ok({ status: 'prompted' });
    }
    const actor = options.actorFor(run);
    if (!actor.ok) return actor;
    const created = await options.milestones.create({ name: input.name, ...(input.note === undefined ? {} : { note: input.note }), actor: actor.value }, run.signal);
    if (!created.ok) return err(created.error);
    return ok({ status: 'created', id: created.value.entry.id, name: created.value.entry.name });
  });
}
