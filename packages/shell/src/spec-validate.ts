/**
 * Spec validation (R13.26): a spec is checked against the closed vocabulary and gated like a change
 * set. Every problem is collected (not only the first), so a proposer — a person, a preset or an agent —
 * gets the whole list with a code and a fix per slot. Nothing is mounted unless the spec is clean.
 *
 * Checks, per slot: the section and contribution exist (SF-SHELL-010), the slot is named once and its
 * placement is offered (SF-SHELL-013), its `when` holds under the spec context (SF-SHELL-011), and the
 * gate allows it (SF-SHELL-012, through the `DecidePort`; UX, not security). Per spec: one-slot
 * sections have exactly one slot, and pins name pinnable slots of the spec (SF-SHELL-013).
 */
import { AbortedError, type ErrorDefinition, err, ok, type Result, type SfError } from '@staticflux/core';
import { allowAllDecide, type DecidePort } from '@staticflux/ui';
import { SpecContextMismatchError, SpecContributionDeniedError, SpecInvalidError, SpecSlotError, UnknownSpecContributionError } from './spec-errors.js';
import { groupKey, type ResolvedSlot, type ShellSpec, slotKey, type SpecContribution, type SpecSlotKey, type SpecVocabulary } from './spec-model.js';

/** One problem of a spec (plain data: it crosses to agents and devtools). */
export interface SpecIssue {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly fix: string;
  readonly slot?: SpecSlotKey;
  readonly section?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A spec that passed validation: resolved slots in display order, per-group indices, pins. */
export interface ValidatedSpec {
  readonly kind: 'validated-spec';
  readonly spec: ShellSpec;
  readonly context: Readonly<Record<string, string>>;
  readonly slots: readonly ResolvedSlot[];
  readonly pinned: readonly SpecSlotKey[];
}

export interface ValidateSpecOptions {
  /** Gating port (bind the `@staticflux/gate` adapter). Default: allow everything. */
  readonly decide?: DecidePort;
  readonly signal?: AbortSignal;
}

const issue = (definition: ErrorDefinition, message: string, extra: Omit<SpecIssue, 'code' | 'kind' | 'message' | 'fix'> = {}): SpecIssue => ({
  code: definition.code,
  kind: definition.kind,
  message,
  fix: definition.fix,
  ...extra,
});

/** Does `contribution` apply under `context`? Every key of `when` must hold one of its values. */
export function appliesIn(contribution: Pick<SpecContribution, 'when'>, context: Readonly<Record<string, string>>): boolean {
  for (const [key, values] of Object.entries(contribution.when ?? {})) {
    const value = context[key];
    if (value === undefined || !values.includes(value)) return false;
  }
  return true;
}

/** The issues carried by a SF-SHELL-009 error (empty for any other error). */
export function specIssues(error: SfError): readonly SpecIssue[] {
  if (error.code !== SpecInvalidError.code) return [];
  const issues = (error.details as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as SpecIssue[]) : [];
}

/** Validate and gate `spec` against `vocabulary` (see the module header). */
export async function validateSpec(spec: ShellSpec, vocabulary: SpecVocabulary, options: ValidateSpecOptions = {}): Promise<Result<ValidatedSpec>> {
  const decide = options.decide ?? allowAllDecide;
  const issues: SpecIssue[] = [];
  const accepted: { key: SpecSlotKey; contribution: SpecContribution; placement: string }[] = [];
  const seen = new Set<SpecSlotKey>();

  for (const request of spec.slots) {
    const key = slotKey(request.section, request.id);
    const section = vocabulary.section(request.section);
    if (section === undefined) {
      issues.push(issue(UnknownSpecContributionError, `Unknown section "${request.section}".`, { slot: key, section: request.section }));
      continue;
    }
    const contribution = vocabulary.contribution(request.section, request.id);
    if (contribution === undefined) {
      issues.push(issue(UnknownSpecContributionError, `No ${section.label} contribution "${request.id}" is registered.`, { slot: key, section: section.id }));
      continue;
    }
    if (seen.has(key)) {
      issues.push(issue(SpecSlotError, `${contribution.label} is named twice.`, { slot: key, section: section.id }));
      continue;
    }
    seen.add(key);
    const offered = contribution.placements ?? section.placements;
    const placement = request.placement ?? offered[0] ?? section.placements[0] ?? 'default';
    if (!offered.includes(placement) || !section.placements.includes(placement)) {
      issues.push(issue(SpecSlotError, `${contribution.label} cannot be placed in "${placement}" (offered: ${offered.join(', ')}).`, { slot: key, section: section.id, details: { placement, offered } }));
      continue;
    }
    if (!appliesIn(contribution, spec.context)) {
      issues.push(issue(SpecContextMismatchError, `${contribution.label} does not apply here.`, { slot: key, section: section.id, details: { when: contribution.when ?? {}, context: spec.context } }));
      continue;
    }
    accepted.push({ key, contribution, placement });
  }

  for (const section of vocabulary.sections) {
    if (section.cardinality !== 'one') continue;
    const count = spec.slots.filter((s) => s.section === section.id).length;
    if (count !== 1) issues.push(issue(SpecSlotError, `A spec names exactly one ${section.label} (found ${count}).`, { section: section.id, details: { count } }));
  }

  const pinned: SpecSlotKey[] = [];
  for (const key of spec.pinned ?? []) {
    const slot = accepted.find((a) => a.key === key);
    const pinnable = slot !== undefined && vocabulary.section(slot.contribution.section)?.pinnable === true;
    if (!pinnable) {
      // A pin of a slot that already failed above is not reported twice.
      if (!issues.some((i) => i.slot === key)) issues.push(issue(SpecSlotError, `Cannot pin "${key}": pin only pinnable slots of the spec.`, { slot: key }));
      continue;
    }
    if (!pinned.includes(key)) pinned.push(key);
  }

  const verdicts = await Promise.all(accepted.map(async (a) => (a.contribution.gate === undefined ? ({ effect: 'allow' } as const) : decide.decide(a.contribution.gate, options.signal))));
  if (options.signal?.aborted === true) return err(AbortedError({ cause: options.signal.reason }));
  verdicts.forEach((verdict, i) => {
    const a = accepted[i];
    if (a === undefined || verdict.effect === 'allow') return;
    issues.push(issue(SpecContributionDeniedError, `${a.contribution.label} is not available (${verdict.reason}).`, { slot: a.key, section: a.contribution.section, details: { reason: verdict.reason } }));
  });

  if (issues.length > 0) {
    const first = issues[0];
    return err(SpecInvalidError({ message: `Spec "${spec.id}" was rejected: ${issues.length} issue(s)${first === undefined ? '' : `, first: ${first.message}`}`, details: { spec: spec.id, issues } }));
  }

  const counters = new Map<string, number>();
  const slots: ResolvedSlot[] = accepted.map((a) => {
    const group = groupKey({ section: a.contribution.section, placement: a.placement });
    const index = counters.get(group) ?? 0;
    counters.set(group, index + 1);
    return Object.freeze({ key: a.key, section: a.contribution.section, id: a.contribution.id, placement: a.placement, index, contribution: a.contribution });
  });
  return ok(Object.freeze({ kind: 'validated-spec', spec, context: spec.context, slots: Object.freeze(slots), pinned: Object.freeze(pinned) }));
}
