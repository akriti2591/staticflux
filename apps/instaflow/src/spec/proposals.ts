/**
 * Spec proposals (D16, EDITOR-AS-PRIMITIVE.md "Lifecycle of a spec in a turn"): a spec comes from a
 * person, a preset or an agent and goes `proposed → validated → (previewing) → mounted`, or is
 * `rejected` (schema or vocabulary), `declined`, `superseded` (a newer proposal, or a later mounted
 * spec) or `failed` (the mount port failed for every slot it touched).
 *
 * Routing is data (`PROPOSAL_ROUTES[source][autonomy]`, D13): a person's or a preset's spec mounts; an
 * agent's spec is a preview in Plan and Ask (the person opens it), and mounts in Accept edits and
 * Autopilot. Agent specs are gated as the agent (`decideFor('agent')`). Agents arrive in M2: the seam is
 * the `SpecProposer` port (`pull(proposer)`) and `proposeSpecCapability` (`capability`), tested with a
 * scripted proposer.
 */
import { type CapabilityImplementation, implementCapability, type RunContext } from '@staticflux/capabilities';
import { box, createMachine, defineMachine, err, type Machine, ok, type Result, type SfError, token } from '@staticflux/core';
import type { SpecApplied, SpecPreview, SpecRuntime } from '@staticflux/shell/spec';
import type { DecidePort } from '@staticflux/ui';
import { proposeSpecCapability } from './capabilities.js';
import { ProposalStateError, ProposerFailedError } from './errors.js';
import { toShellSpec } from './registries.js';
import { type EditorSpec, parseEditorSpec } from './schema.js';

export const SpecProposalLifecycle = defineMachine({
  id: 'instaflow/spec-proposal',
  initial: 'proposed',
  states: ['proposed', 'validated', 'rejected', 'previewing', 'mounting', 'mounted', 'declined', 'superseded', 'failed'],
  transitions: {
    proposed: { validate: 'validated', reject: 'rejected' },
    validated: { preview: 'previewing', mount: 'mounting', reject: 'rejected' },
    previewing: { open: 'mounting', decline: 'declined', supersede: 'superseded' },
    mounting: { settle: 'mounted', fail: 'failed', reject: 'rejected' },
    mounted: { supersede: 'superseded' },
  },
  terminal: ['rejected', 'declined', 'superseded', 'failed'],
});
export type SpecProposalState = (typeof SpecProposalLifecycle.states)[number];
type ProposalEvent = 'validate' | 'reject' | 'preview' | 'mount' | 'open' | 'decline' | 'supersede' | 'settle' | 'fail';

export const PROPOSAL_SOURCE_KINDS = ['person', 'preset', 'agent'] as const;
export type ProposalSourceKind = (typeof PROPOSAL_SOURCE_KINDS)[number];

/** Agent autonomy modes (D13). */
export const AUTONOMY_MODES = ['plan', 'ask', 'accept-edits', 'autopilot'] as const;
export type Autonomy = (typeof AUTONOMY_MODES)[number];

export interface ProposalSource {
  readonly kind: ProposalSourceKind;
  readonly id: string;
  readonly displayName?: string;
}

export type ProposalRoute = 'preview' | 'mount';

/** What a valid proposal does, per source and autonomy. */
export const PROPOSAL_ROUTES: Readonly<Record<ProposalSourceKind, Readonly<Record<Autonomy, ProposalRoute>>>> = Object.freeze({
  person: { plan: 'mount', ask: 'mount', 'accept-edits': 'mount', autopilot: 'mount' },
  preset: { plan: 'mount', ask: 'mount', 'accept-edits': 'mount', autopilot: 'mount' },
  agent: { plan: 'preview', ask: 'preview', 'accept-edits': 'mount', autopilot: 'mount' },
});

/** Which gate subject a source is decided as. */
export const PROPOSAL_SUBJECTS: Readonly<Record<ProposalSourceKind, 'principal' | 'agent'>> = Object.freeze({ person: 'principal', preset: 'principal', agent: 'agent' });

export interface SpecProposal {
  readonly id: string;
  readonly source: ProposalSource;
  readonly reason: string | undefined;
  /** The parsed spec (undefined when the schema rejected it). */
  readonly spec: EditorSpec | undefined;
  /** Reactive. */
  readonly state: SpecProposalState;
  /** Validated spec and the diff it would apply (set from `validated` on). */
  readonly preview: SpecPreview | undefined;
  readonly applied: SpecApplied | undefined;
  readonly error: SfError | undefined;
  /** Mount a previewed proposal (the person opens it). */
  open(signal?: AbortSignal): Promise<Result<SpecApplied>>;
  /** Dismiss a previewed proposal. */
  decline(): Result<void>;
}

export interface ProposerContext {
  /** The mounted editor spec, if any. */
  readonly current: EditorSpec | undefined;
}

export interface ProposerTurn {
  /** Untrusted: parsed with `parseEditorSpec`. */
  readonly spec: unknown;
  readonly reason?: string;
}

/** Where agent specs come from (M2 binds the chat agent; tests bind `scriptedProposer`). */
export interface SpecProposer {
  readonly source: ProposalSource;
  /** The next proposal, or undefined when the proposer has nothing to propose. */
  next(context: ProposerContext, signal: AbortSignal): Promise<Result<ProposerTurn | undefined>>;
}

export const SpecProposerToken = /* @__PURE__ */ token('instaflow/spec-proposer').type<SpecProposer>();

export interface SpecProposalsOptions {
  readonly runtime: SpecRuntime;
  /** The gate's decide port per subject (`gateSpecDecide(gate, subject)`). */
  readonly decideFor: (subject: 'principal' | 'agent') => DecidePort;
  readonly autonomy?: Autonomy;
  readonly newId?: () => string;
}

export interface ProposeOptions {
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export interface SpecProposals {
  /** Run a spec through the lifecycle; resolves when it settles (rejected, previewing, mounted or failed). */
  propose(spec: unknown, source: ProposalSource, options?: ProposeOptions): Promise<SpecProposal>;
  /** Ask a proposer for its next turn and propose it (undefined when it has none). */
  pull(proposer: SpecProposer, signal?: AbortSignal): Promise<Result<SpecProposal | undefined>>;
  /** Reactive: the mounted editor spec. */
  readonly current: EditorSpec | undefined;
  /** Reactive: the proposal waiting in preview, if any. */
  readonly pending: SpecProposal | undefined;
  /** Reactive: every proposal, oldest first. */
  readonly history: readonly SpecProposal[];
  /** Reactive. */
  readonly autonomy: Autonomy;
  setAutonomy(mode: Autonomy): void;
  /** `proposeSpecCapability` implementation (agents call it through the capability pipeline). */
  readonly capability: CapabilityImplementation<unknown, unknown>;
}

interface MutableProposal extends SpecProposal {
  readonly machine: Machine<SpecProposalState, ProposalEvent>;
  setPreview(preview: SpecPreview): void;
  setApplied(applied: SpecApplied): void;
  setError(error: SfError): void;
}

let counter = 0;
const defaultId = (): string => `sp_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function createSpecProposals(options: SpecProposalsOptions): SpecProposals {
  const newId = options.newId ?? defaultId;
  const autonomy = box<Autonomy>(options.autonomy ?? 'ask');
  const history = box<readonly MutableProposal[]>([]);
  const pending = box<MutableProposal | undefined>(undefined);
  const mounted = box<MutableProposal | undefined>(undefined);
  const current = box<EditorSpec | undefined>(undefined);

  const send = (p: MutableProposal, event: ProposalEvent): void => {
    if (p.machine.can(event)) p.machine.send(event);
  };

  const mount = async (p: MutableProposal, signal: AbortSignal | undefined): Promise<Result<SpecApplied>> => {
    const spec = p.spec as EditorSpec;
    if (pending.get() === p) pending.set(undefined);
    const decide = options.decideFor(PROPOSAL_SUBJECTS[p.source.kind]);
    const applied = await options.runtime.apply(toShellSpec(spec), { decide, ...(signal === undefined ? {} : { signal }) });
    if (!applied.ok) {
      p.setError(applied.error);
      // Gating or the vocabulary changed since the preview: the spec is rejected now.
      send(p, 'reject');
      return applied;
    }
    p.setApplied(applied.value);
    const touched = applied.value.diff.mount.length + applied.value.diff.move.length;
    const failedAll = touched > 0 && applied.value.failures.length >= touched;
    if (failedAll) {
      p.setError(applied.value.failures[0] as SfError);
      send(p, 'fail');
      return applied;
    }
    const previous = mounted.get();
    if (previous !== undefined && previous !== p) send(previous, 'supersede');
    send(p, 'settle');
    mounted.set(p);
    current.set(spec);
    return applied;
  };

  const ROUTE_ACTIONS: Readonly<Record<ProposalRoute, (p: MutableProposal, signal: AbortSignal | undefined) => Promise<void>>> = {
    preview: async (p) => {
      const older = pending.get();
      if (older !== undefined && older !== p) send(older, 'supersede');
      send(p, 'preview');
      pending.set(p);
    },
    mount: async (p, signal) => {
      send(p, 'mount');
      await mount(p, signal);
    },
  };

  const create = (source: ProposalSource, spec: EditorSpec | undefined, reason: string | undefined): MutableProposal => {
    const machine = createMachine(SpecProposalLifecycle);
    const preview = box<SpecPreview | undefined>(undefined);
    const applied = box<SpecApplied | undefined>(undefined);
    const error = box<SfError | undefined>(undefined);
    const proposal: MutableProposal = {
      id: newId(),
      source,
      reason,
      spec,
      machine,
      get state() {
        return machine.state;
      },
      get preview() {
        return preview.get();
      },
      get applied() {
        return applied.get();
      },
      get error() {
        return error.get();
      },
      setPreview: (value) => preview.set(value),
      setApplied: (value) => applied.set(value),
      setError: (value) => error.set(value),
      async open(signal) {
        if (!machine.is('previewing')) return err(ProposalStateError({ details: { proposal: proposal.id, state: machine.state, action: 'open' } }));
        send(proposal, 'open');
        return mount(proposal, signal);
      },
      decline() {
        if (!machine.is('previewing')) return err(ProposalStateError({ details: { proposal: proposal.id, state: machine.state, action: 'decline' } }));
        send(proposal, 'decline');
        if (pending.get() === proposal) pending.set(undefined);
        return ok();
      },
    };
    history.set([...history.get(), proposal]);
    return proposal;
  };

  const propose = async (value: unknown, source: ProposalSource, o: ProposeOptions = {}): Promise<SpecProposal> => {
    const parsed = parseEditorSpec(value);
    const proposal = create(source, parsed.ok ? parsed.value : undefined, o.reason);
    if (!parsed.ok) {
      proposal.setError(parsed.error);
      send(proposal, 'reject');
      return proposal;
    }
    const decide = options.decideFor(PROPOSAL_SUBJECTS[source.kind]);
    const preview = await options.runtime.preview(toShellSpec(parsed.value), { decide, ...(o.signal === undefined ? {} : { signal: o.signal }) });
    if (!preview.ok) {
      proposal.setError(preview.error);
      send(proposal, 'reject');
      return proposal;
    }
    proposal.setPreview(preview.value);
    send(proposal, 'validate');
    await ROUTE_ACTIONS[PROPOSAL_ROUTES[source.kind][autonomy.get()]](proposal, o.signal);
    return proposal;
  };

  const SUBJECT_SOURCE: Readonly<Record<RunContext['subject'], ProposalSourceKind>> = { user: 'person', guest: 'person', system: 'preset', agent: 'agent', plugin: 'agent' };

  const capability = implementCapability(proposeSpecCapability, async (input, ctx) => {
    const source: ProposalSource = { kind: SUBJECT_SOURCE[ctx.subject], id: ctx.origin?.channel ?? ctx.subject };
    const proposal = await propose(input.spec, source, { signal: ctx.signal, ...(input.reason === undefined ? {} : { reason: input.reason }) });
    return proposal.state === 'rejected' && proposal.error !== undefined ? err(proposal.error) : ok({ proposal: proposal.id, state: proposal.state });
  }) as unknown as CapabilityImplementation<unknown, unknown>;

  return {
    propose,
    async pull(proposer, signal) {
      const controller = new AbortController();
      const turn = await proposer.next({ current: current.get() }, signal ?? controller.signal);
      if (!turn.ok) return err(ProposerFailedError({ cause: turn.error, details: { proposer: proposer.source.id } }));
      if (turn.value === undefined) return ok(undefined);
      return ok(await propose(turn.value.spec, proposer.source, { ...(turn.value.reason === undefined ? {} : { reason: turn.value.reason }), ...(signal === undefined ? {} : { signal }) }));
    },
    get current() {
      return current.get();
    },
    get pending() {
      return pending.get();
    },
    get history() {
      return history.get();
    },
    get autonomy() {
      return autonomy.get();
    },
    setAutonomy: (mode) => autonomy.set(mode),
    capability,
  };
}
