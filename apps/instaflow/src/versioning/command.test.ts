import { allowAllDecidePort, alwaysActivePort, createCapabilityRegistry, describeCapability, failClosedConfirmPort, unmeteredPort } from '@staticflux/capabilities';
import { err, ok } from '@staticflux/core';
import { isPaletteRunnable } from '@staticflux/kit/command-palette';
import { describe, expect, it } from 'vitest';
import { CREATE_MILESTONE_SHORTCUT, CreateMilestoneCapability, implementCreateMilestone } from './command.js';
import { MilestoneNameError } from './errors.js';
import { createMilestoneService } from './milestones.js';
import { createPartCapture } from './parts.js';
import { createCountingStore, priya, registry as components, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';

async function setup() {
  const store = createCountingStore();
  const doc = await seedDocument(repoOn(store), 'as_1', 1);
  const milestones = createMilestoneService({ doc, store, capture: createPartCapture({ store, registry: components }), registry: components });
  let prompts = 0;
  const implementation = implementCreateMilestone({ milestones, actorFor: (run) => (run.subject === 'guest' ? err(MilestoneNameError({ message: 'no actor' })) : ok(priya)), prompt: () => (prompts += 1) });
  const registry = createCapabilityRegistry({ decide: allowAllDecidePort, confirm: failClosedConfirmPort, meter: unmeteredPort, activation: alwaysActivePort, implementations: [implementation] });
  return { milestones, registry, prompts: () => prompts };
}

describe('the "Milestone" command', () => {
  it('is one capability with a shortcut, palette-runnable without input, described for agents', () => {
    expect(CreateMilestoneCapability).toMatchObject({ id: 'instaflow/create-milestone', title: 'Milestone', destructive: false, requiresConfirmation: false, exposeToAgents: true });
    expect(CREATE_MILESTONE_SHORTCUT).toBe('Mod+Alt+S');
    expect(isPaletteRunnable(CreateMilestoneCapability, () => true)).toBe(true);
    expect(describeCapability(CreateMilestoneCapability).inputSchema).toMatchObject({ type: 'object', properties: { name: { type: 'string', maxLength: 120 } } });
  });

  it('without a name, opens the inline form (a person names it)', async () => {
    const { registry, prompts, milestones } = await setup();
    expect(unwrap(await registry.invoke(CreateMilestoneCapability.id, {}, { subject: 'user', signal }))).toEqual({ status: 'prompted' });
    expect(unwrap(await registry.invoke(CreateMilestoneCapability.id, { name: '  ' }, { subject: 'user', signal }))).toEqual({ status: 'prompted' });
    expect(prompts()).toBe(2);
    expect(unwrap(await milestones.refresh(signal))).toEqual([]);
  });

  it('with a name, creates the milestone as the invoking actor', async () => {
    const { registry, milestones } = await setup();
    const out = unwrap(await registry.invoke(CreateMilestoneCapability.id, { name: 'Client v2', note: 'sent' }, { subject: 'user', signal })) as { status: string; id: string; name: string };
    expect(out).toMatchObject({ status: 'created', name: 'Client v2' });
    const record = unwrap(await milestones.record(out.id as never, signal));
    expect(record).toMatchObject({ note: 'sent', createdBy: { id: priya.id } });
  });

  it('returns attribution and validation failures as values', async () => {
    const { registry } = await setup();
    expect((await registry.invoke(CreateMilestoneCapability.id, { name: 'X' }, { subject: 'guest', signal })).ok).toBe(false);
    expect((await registry.invoke(CreateMilestoneCapability.id, { name: 'x'.repeat(121) }, { subject: 'user', signal })).ok).toBe(false);
  });
});
