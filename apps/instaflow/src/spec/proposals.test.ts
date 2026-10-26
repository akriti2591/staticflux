import { allowAllDecidePort, alwaysActivePort, createCapabilityRegistry, failClosedConfirmPort, unmeteredPort } from '@staticflux/capabilities';
import { AbortedError } from '@staticflux/core';
import { createSpecRuntime } from '@staticflux/shell/spec';
import { recordingSpecPort } from '@staticflux/testkit';
import { describe, expect, it } from 'vitest';
import {
  createSpecProposals,
  gateSpecDecide,
  PROPOSAL_ROUTES,
  pixelTouchUpSpec,
  proposeSpecCapability,
  SpecProposalLifecycle,
  StudioIds,
  studioSpec,
  studioSpecFor,
} from './index.js';
import { editorGate, gatedStudioSpec, studioRegistries } from './testing/fixtures.js';
import { scriptedProposer } from './testing/scripted-proposer.js';

const person = { kind: 'person', id: 'ann' } as const;
const agent = { kind: 'agent', id: 'claude', displayName: 'Claude' } as const;

function setup(autonomy: 'plan' | 'ask' | 'accept-edits' | 'autopilot' = 'ask', plan = 'pro') {
  const { gate, setPlan } = editorGate(plan);
  const port = recordingSpecPort();
  const runtime = createSpecRuntime({ vocabulary: studioRegistries({ gated: true }).vocabulary, port });
  let n = 0;
  const proposals = createSpecProposals({ runtime, decideFor: (subject) => gateSpecDecide(gate, subject), autonomy, newId: () => `p${n++}` });
  return { gate, setPlan, port, runtime, proposals };
}

describe('spec proposals', () => {
  it('routes are data: people and presets mount; agents preview in Plan and Ask, mount in Accept edits and Autopilot', () => {
    expect(PROPOSAL_ROUTES.person).toEqual({ plan: 'mount', ask: 'mount', 'accept-edits': 'mount', autopilot: 'mount' });
    expect(PROPOSAL_ROUTES.agent).toEqual({ plan: 'preview', ask: 'preview', 'accept-edits': 'mount', autopilot: 'mount' });
    expect(SpecProposalLifecycle.transitions.previewing).toEqual({ open: 'mounting', decline: 'declined', supersede: 'superseded' });
  });

  it('a person’s spec goes proposed → validated → mounted', async () => {
    const { proposals, runtime } = setup();
    const p = await proposals.propose(studioSpec, person);
    expect(p.state).toBe('mounted');
    expect(p.preview?.diff.mount.length).toBeGreaterThan(10);
    expect(p.applied?.spec.spec.id).toBe('instaflow/studio');
    expect(proposals.current).toBe(p.spec);
    expect(runtime.state).toBe('mounted');
  });

  it('Ask: an agent proposal is a preview until the person opens it; a newer one supersedes it', async () => {
    const { proposals, port } = setup('ask');
    await proposals.propose(studioSpec, person);
    port.calls.length = 0;
    const proposer = scriptedProposer([{ spec: pixelTouchUpSpec(['img-1']), reason: 'Touch up the lantern photo' }, { spec: studioSpecFor(StudioIds.lens.pixel) }]);
    const first = await proposals.pull(proposer);
    expect(first.ok && first.value?.state).toBe('previewing');
    expect(first.ok && first.value?.reason).toBe('Touch up the lantern photo');
    expect(port.calls).toEqual([]);
    expect(proposals.pending).toBe(first.ok ? first.value : undefined);
    expect(proposer.asked[0]?.current?.id).toBe('instaflow/studio');
    const second = await proposals.pull(proposer);
    expect(first.ok && first.value?.state).toBe('superseded');
    if (!second.ok || second.value === undefined) throw new Error('no proposal');
    if (!first.ok || first.value === undefined) throw new Error('no first proposal');
    expect((await first.value.open()).ok).toBe(false);
    const opened = await second.value.open();
    expect(opened.ok).toBe(true);
    expect(second.value.state).toBe('mounted');
    expect(proposals.pending).toBeUndefined();
    expect(port.calls.some((c) => c.op === 'mount' && c.key === 'lens:instaflow/lens-pixel')).toBe(true);
    expect((await proposals.pull(proposer)).ok && proposer.remaining).toBe(0);
  });

  it('decline dismisses a preview; acting on a settled proposal is IF-SPEC-003', async () => {
    const { proposals } = setup('plan');
    const p = await proposals.propose(pixelTouchUpSpec(['img-1']), agent);
    expect(p.state).toBe('previewing');
    expect(p.decline().ok).toBe(true);
    expect(p.state).toBe('declined');
    const again = p.decline();
    expect(!again.ok && again.error.code).toBe('IF-SPEC-003');
    expect(proposals.pending).toBeUndefined();
  });

  it('Accept edits: an agent spec mounts directly and supersedes the mounted one', async () => {
    const { proposals } = setup('accept-edits');
    const studio = await proposals.propose(studioSpec, person);
    const mini = await proposals.propose(pixelTouchUpSpec(['img-1']), agent);
    expect(mini.state).toBe('mounted');
    expect(studio.state).toBe('superseded');
    proposals.setAutonomy('ask');
    expect(proposals.autonomy).toBe('ask');
  });

  it('rejects malformed specs (IF-SPEC-001), unknown ids and gating denials (SF-SHELL-009) without mounting', async () => {
    const { proposals, port, setPlan } = setup('accept-edits', 'free');
    const malformed = await proposals.propose({ id: 'nope' }, agent);
    expect([malformed.state, malformed.error?.code, malformed.spec]).toEqual(['rejected', 'IF-SPEC-001', undefined]);
    const unknown = await proposals.propose({ ...pixelTouchUpSpec(['img-1']), tools: ['instaflow/teleport'] }, agent);
    expect([unknown.state, unknown.error?.code]).toEqual(['rejected', 'SF-SHELL-009']);
    const gated = await proposals.propose(gatedStudioSpec, person);
    expect([gated.state, gated.error?.code]).toEqual(['rejected', 'SF-SHELL-009']);
    expect(port.calls).toEqual([]);
    setPlan('pro');
    expect((await proposals.propose(gatedStudioSpec, person)).state).toBe('mounted');
    expect(proposals.history.map((p) => p.state)).toEqual(['rejected', 'rejected', 'rejected', 'mounted']);
  });

  it('agents are gated as agents: a slot without agent delegation is rejected for the agent but not for the person', async () => {
    const { gate } = editorGate('pro', { delegateAsk: false });
    const runtime = createSpecRuntime({ vocabulary: studioRegistries({ gated: true }).vocabulary, port: recordingSpecPort() });
    const proposals = createSpecProposals({ runtime, decideFor: (subject) => gateSpecDecide(gate, subject), autonomy: 'accept-edits' });
    const asAgent = await proposals.propose(gatedStudioSpec, agent);
    expect(asAgent.state).toBe('rejected');
    expect((asAgent.error?.details as { issues: { slot: string; code: string }[] }).issues.map((i) => [i.code, i.slot])).toEqual([['SF-SHELL-012', 'hud:instaflow/ask']]);
    expect((await proposals.propose(gatedStudioSpec, person)).state).toBe('mounted');
  });

  it('a preview that is no longer allowed when opened is rejected', async () => {
    const { proposals, setPlan } = setup('ask', 'pro');
    const p = await proposals.propose(gatedStudioSpec, agent);
    expect(p.state).toBe('previewing');
    setPlan('free');
    const opened = await p.open();
    expect(!opened.ok && opened.error.code).toBe('SF-SHELL-009');
    expect(p.state).toBe('rejected');
  });

  it('a proposer error is IF-SPEC-004 and changes nothing; an aborted turn proposes nothing', async () => {
    const { proposals } = setup();
    const failed = await proposals.pull(scriptedProposer([AbortedError()]));
    expect(!failed.ok && failed.error.code).toBe('IF-SPEC-004');
    const controller = new AbortController();
    controller.abort();
    const aborted = await proposals.pull(scriptedProposer([{ spec: studioSpec }]), controller.signal);
    expect(aborted.ok && aborted.value).toBeUndefined();
    expect(proposals.history).toEqual([]);
  });

  it('a failed mount (every touched slot) is `failed`', async () => {
    const { gate } = editorGate('pro');
    const port = { ...recordingSpecPort(), mount: () => ({ ok: false as const, error: AbortedError() }) };
    const runtime = createSpecRuntime({ vocabulary: studioRegistries().vocabulary, port });
    const proposals = createSpecProposals({ runtime, decideFor: (s) => gateSpecDecide(gate, s) });
    const p = await proposals.propose(pixelTouchUpSpec(['img-1']), person);
    expect([p.state, p.error?.code]).toEqual(['failed', 'SF-SHELL-014']);
    expect(p.id).toMatch(/^sp_/);
  });

  it('agents propose through proposeSpecCapability (capability pipeline, subject agent)', async () => {
    const { proposals } = setup('ask');
    const registry = createCapabilityRegistry({ decide: allowAllDecidePort, confirm: failClosedConfirmPort, meter: unmeteredPort, activation: alwaysActivePort, implementations: [proposals.capability] });
    const invoked = await registry.invoke(proposeSpecCapability, { spec: pixelTouchUpSpec(['img-1']) as never, reason: 'Fix the photo' }, { subject: 'agent', origin: { channel: 'webmcp' } });
    expect(invoked.ok && invoked.value).toEqual({ proposal: 'p0', state: 'previewing' });
    expect(proposals.history[0]?.source).toEqual({ kind: 'agent', id: 'webmcp' });
    const bad = await registry.invoke(proposeSpecCapability, { spec: { ...pixelTouchUpSpec(['img-1']), lens: 'instaflow/none' } as never }, { subject: 'user' });
    expect(!bad.ok && bad.error.code).toBe('SF-SHELL-009');
  });
});
