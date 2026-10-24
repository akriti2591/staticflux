/**
 * Declarative policy IR (data, not code). Cedar-like semantics:
 * permit/forbid over subject × action × resource with conditions over facts;
 * forbid overrides permit; decisions name their determining policies.
 *
 * The IR is JSON-serializable so remote overrides (R6.13) ship as data. Typed
 * builders (`definePolicy`, `fact(...)`, `covers(...)`) produce the IR.
 *
 * CLIENT GATING IS UX, NOT SECURITY (R6.16). The server re-checks everything.
 */
import { type Result, err, ok } from '@staticflux/core';
import { InvalidPolicyError } from './errors.js';
import type { FactDef, FactId, FactPrimitive, FactValue } from './facts.js';

export const GATE_LEVELS = ['app', 'workspace', 'route', 'feature', 'capability', 'ui-slot'] as const;
export type GateLevel = (typeof GATE_LEVELS)[number];

export const SUBJECT_KINDS = ['user', 'agent', 'guest'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const DENY_REASONS = ['login', 'upgrade', 'forbidden', 'unavailable', 'quota', 'rate'] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** Which reason wins when several permits fail (most actionable first). */
export const DENY_PRECEDENCE: readonly DenyReason[] = ['unavailable', 'login', 'upgrade', 'quota', 'rate', 'forbidden'];

export type DenyMeta = Readonly<Record<string, FactPrimitive | readonly FactPrimitive[]>>;

export interface Because {
  readonly reason: DenyReason;
  readonly meta?: DenyMeta;
}

export type ActionId = `${string}/${string}`;
export type MeterId = `${string}/${string}`;
export type PolicyId = `${string}/${string}`;

export interface GateAction<Id extends ActionId = ActionId> {
  readonly kind: 'action';
  readonly id: Id;
  /** Destructive actions require user confirmation when performed by an agent (R6.17). */
  readonly destructive: boolean;
}

export function defineAction<const Id extends ActionId>(id: Id, options: { readonly destructive?: boolean } = {}): GateAction<Id> {
  return Object.freeze({ kind: 'action', id, destructive: options.destructive ?? false });
}

/** The action used when `decide()` is called without one. */
export const AccessAction = defineAction('gate/access');

export interface GateResource {
  readonly kind: 'resource';
  readonly level: GateLevel;
  readonly id: string;
}

/** A typed resource reference, e.g. `gateResource('capability', 'agent/insert-image')`. */
export function gateResource(level: GateLevel, id: string): GateResource {
  return Object.freeze({ kind: 'resource', level, id });
}

// ---------------------------------------------------------------- conditions (IR)

export type Condition =
  | { readonly op: 'const'; readonly value: boolean; readonly because?: Because }
  | { readonly op: 'eq' | 'neq'; readonly fact: FactId; readonly value: FactPrimitive; readonly because?: Because }
  | { readonly op: 'in'; readonly fact: FactId; readonly values: readonly FactPrimitive[]; readonly because?: Because }
  | { readonly op: 'gt' | 'gte' | 'lt' | 'lte'; readonly fact: FactId; readonly value: number; readonly because?: Because }
  | { readonly op: 'truthy'; readonly fact: FactId; readonly because?: Because }
  /** Array fact contains `value`. */
  | { readonly op: 'has'; readonly fact: FactId; readonly value: FactPrimitive; readonly because?: Because }
  /** Meter's optimistic available balance ≥ amount. Default reason: quota (balance) / rate (rate meter). */
  | { readonly op: 'covers'; readonly meter: MeterId; readonly amount: number; readonly because?: Because }
  | { readonly op: 'all' | 'any'; readonly of: readonly Condition[]; readonly because?: Because }
  | { readonly op: 'not'; readonly of: Condition; readonly because?: Because };

/** Fact id holding a meter's available balance (published by the meter registry). */
export function meterFactId(meter: MeterId): FactId {
  return `meter:${meter}`;
}

/** Attach a deny reason to a condition (reported when it fails). */
export function because<C extends Condition>(condition: C, reason: DenyReason, meta?: DenyMeta): C {
  return { ...condition, because: meta === undefined ? { reason } : { reason, meta } };
}

type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

export interface FactConditions<T extends FactValue> {
  eq(value: T & FactPrimitive): Condition;
  neq(value: T & FactPrimitive): Condition;
  in(values: readonly (T & FactPrimitive)[]): Condition;
  gt(value: number): Condition;
  gte(value: number): Condition;
  lt(value: number): Condition;
  lte(value: number): Condition;
  truthy(): Condition;
  has(value: ElementOf<T>): Condition;
}

/** Typed condition builder over a fact: `fact(GateFacts.plan).eq('pro')`. */
export function fact<T extends FactValue>(definition: FactDef<T>): FactConditions<T> {
  const id = definition.id;
  return {
    eq: (value) => ({ op: 'eq', fact: id, value }),
    neq: (value) => ({ op: 'neq', fact: id, value }),
    in: (values) => ({ op: 'in', fact: id, values }),
    gt: (value) => ({ op: 'gt', fact: id, value }),
    gte: (value) => ({ op: 'gte', fact: id, value }),
    lt: (value) => ({ op: 'lt', fact: id, value }),
    lte: (value) => ({ op: 'lte', fact: id, value }),
    truthy: () => ({ op: 'truthy', fact: id }),
    has: (value) => ({ op: 'has', fact: id, value: value as FactPrimitive }),
  };
}

export const all = (...of: readonly Condition[]): Condition => ({ op: 'all', of });
export const any = (...of: readonly Condition[]): Condition => ({ op: 'any', of });
export const not = (of: Condition): Condition => ({ op: 'not', of });
export const always: Condition = { op: 'const', value: true };
export const never: Condition = { op: 'const', value: false };
export function covers(meter: { readonly id: MeterId }, amount: number): Condition {
  return { op: 'covers', meter: meter.id, amount };
}

// ---------------------------------------------------------------- policies (IR)

export interface PolicyIR {
  readonly id: PolicyId;
  readonly effect: 'permit' | 'forbid';
  readonly description?: string;
  /** Default: `user` and `guest`. Agents match only policies that list `agent` (narrower delegation, R6.17). */
  readonly subjects?: readonly SubjectKind[];
  readonly resource: { readonly level: GateLevel; readonly ids?: readonly string[] };
  /** Default: every action. */
  readonly actions?: readonly ActionId[];
  readonly when?: Condition;
  /** permit: reported when it does not apply; forbid: the reason reported. Overrides condition reasons. */
  readonly deny?: Because;
  /** Allow-with-cost (R6.18). Implies `covers(meter, amount)`. */
  readonly cost?: { readonly meter: MeterId; readonly amount: number };
  readonly requiresConfirmation?: boolean;
  /** Remote overrides: disable the default policy with this id. */
  readonly disabled?: boolean;
}

export interface PolicyInput {
  readonly id: PolicyId;
  readonly effect?: 'permit' | 'forbid';
  readonly description?: string;
  readonly subjects?: readonly SubjectKind[];
  readonly resource: GateResource | { readonly level: GateLevel; readonly ids?: readonly string[] };
  readonly actions?: readonly GateAction[];
  readonly when?: Condition;
  readonly deny?: Because;
  readonly cost?: { readonly meter: { readonly id: MeterId }; readonly amount: number };
  readonly requiresConfirmation?: boolean;
}

/**
 * Typed policy builder → IR. Agent policies over destructive actions get
 * `requiresConfirmation: true` automatically (R6.17).
 */
export function definePolicy(input: PolicyInput): PolicyIR {
  const resource = 'kind' in input.resource ? { level: input.resource.level, ids: [input.resource.id] } : input.resource;
  const destructiveForAgent = input.subjects?.includes('agent') === true && input.actions?.some((a) => a.destructive) === true;
  const requiresConfirmation = input.requiresConfirmation === true || destructiveForAgent;
  return {
    id: input.id,
    effect: input.effect ?? 'permit',
    resource,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.subjects === undefined ? {} : { subjects: input.subjects }),
    ...(input.actions === undefined ? {} : { actions: input.actions.map((a) => a.id) }),
    ...(input.when === undefined ? {} : { when: input.when }),
    ...(input.deny === undefined ? {} : { deny: input.deny }),
    ...(input.cost === undefined ? {} : { cost: { meter: input.cost.meter.id, amount: input.cost.amount } }),
    ...(requiresConfirmation ? { requiresConfirmation } : {}),
  };
}

export type PolicyLayer = 'default' | 'remote';

export interface PolicySet {
  readonly id: `${string}/${string}`;
  readonly layer: PolicyLayer;
  readonly policies: readonly PolicyIR[];
}

/** Package defaults: `definePolicySet('studio/policies', [...])`. */
export function definePolicySet(id: `${string}/${string}`, policies: readonly PolicyIR[]): PolicySet {
  return { id, layer: 'default', policies };
}

// ---------------------------------------------------------------- validation (remote JSON)

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown): v is FactPrimitive => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isNamespaced = (v: unknown): v is `${string}/${string}` => typeof v === 'string' && /^[^/\s]+\/\S+$/.test(v);
const isFactId = (v: unknown): v is FactId => typeof v === 'string' && /^[^\s]+[/:]\S+$/.test(v);

function validateBecause(value: unknown, path: string): Result<Because | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isObject(value) || !DENY_REASONS.includes(value['reason'] as DenyReason)) {
    return err(InvalidPolicyError({ details: { path }, message: `${path}: reason must be one of ${DENY_REASONS.join(', ')}.` }));
  }
  if (value['meta'] !== undefined && !isObject(value['meta'])) return err(InvalidPolicyError({ details: { path: `${path}.meta` } }));
  return ok(value as unknown as Because);
}

export function validateCondition(value: unknown, path = 'when'): Result<Condition> {
  const fail = (message: string): Result<never> => err(InvalidPolicyError({ details: { path }, message: `${path}: ${message}` }));
  if (!isObject(value)) return fail('condition must be an object.');
  const b = validateBecause(value['because'], `${path}.because`);
  if (!b.ok) return b;
  const op = value['op'];
  switch (op) {
    case 'const':
      return typeof value['value'] === 'boolean' ? ok(value as unknown as Condition) : fail('const needs a boolean value.');
    case 'eq':
    case 'neq':
    case 'has':
      return isFactId(value['fact']) && isPrimitive(value['value']) ? ok(value as unknown as Condition) : fail(`${op} needs fact + primitive value.`);
    case 'in':
      return isFactId(value['fact']) && Array.isArray(value['values']) && value['values'].every(isPrimitive)
        ? ok(value as unknown as Condition)
        : fail('in needs fact + values[].');
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return isFactId(value['fact']) && typeof value['value'] === 'number' ? ok(value as unknown as Condition) : fail(`${op} needs fact + number.`);
    case 'truthy':
      return isFactId(value['fact']) ? ok(value as unknown as Condition) : fail('truthy needs fact.');
    case 'covers':
      return isNamespaced(value['meter']) && typeof value['amount'] === 'number' && value['amount'] >= 0
        ? ok(value as unknown as Condition)
        : fail('covers needs meter + non-negative amount.');
    case 'all':
    case 'any': {
      const of = value['of'];
      if (!Array.isArray(of)) return fail(`${op} needs of[].`);
      for (let i = 0; i < of.length; i += 1) {
        const child = validateCondition(of[i], `${path}.of[${i}]`);
        if (!child.ok) return child;
      }
      return ok(value as unknown as Condition);
    }
    case 'not': {
      const child = validateCondition(value['of'], `${path}.of`);
      return child.ok ? ok(value as unknown as Condition) : child;
    }
    default:
      return fail(`unknown op "${String(op)}".`);
  }
}

/** Validate untrusted policy JSON (remote overrides). All-or-nothing. */
export function validatePolicies(value: unknown): Result<readonly PolicyIR[]> {
  if (!Array.isArray(value)) return err(InvalidPolicyError({ details: { path: '$' }, message: 'Policies must be an array.' }));
  const out: PolicyIR[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const path = `[${i}]`;
    const p: unknown = value[i];
    const fail = (field: string, message: string): Result<never> =>
      err(InvalidPolicyError({ details: { path: `${path}.${field}` }, message: `${path}.${field}: ${message}` }));
    if (!isObject(p)) return fail('$', 'policy must be an object.');
    if (!isNamespaced(p['id'])) return fail('id', 'must be a namespaced id (pkg/name).');
    if (p['disabled'] === true) {
      out.push({ id: p['id'], effect: 'permit', resource: { level: 'app' }, disabled: true });
      continue;
    }
    if (p['effect'] !== 'permit' && p['effect'] !== 'forbid') return fail('effect', 'must be permit | forbid.');
    const resource = p['resource'];
    if (!isObject(resource) || !GATE_LEVELS.includes(resource['level'] as GateLevel)) return fail('resource', `level must be one of ${GATE_LEVELS.join(', ')}.`);
    if (resource['ids'] !== undefined && !(Array.isArray(resource['ids']) && resource['ids'].every((x) => typeof x === 'string'))) {
      return fail('resource.ids', 'must be string[].');
    }
    if (p['subjects'] !== undefined && !(Array.isArray(p['subjects']) && p['subjects'].every((s) => SUBJECT_KINDS.includes(s as SubjectKind)))) {
      return fail('subjects', `must be a subset of ${SUBJECT_KINDS.join(', ')}.`);
    }
    if (p['actions'] !== undefined && !(Array.isArray(p['actions']) && p['actions'].every(isNamespaced))) return fail('actions', 'must be action ids.');
    if (p['when'] !== undefined) {
      const when = validateCondition(p['when'], `${path}.when`);
      if (!when.ok) return when;
    }
    const deny = validateBecause(p['deny'], `${path}.deny`);
    if (!deny.ok) return deny;
    const cost = p['cost'];
    if (cost !== undefined && !(isObject(cost) && isNamespaced(cost['meter']) && typeof cost['amount'] === 'number' && cost['amount'] >= 0)) {
      return fail('cost', 'must be { meter, amount ≥ 0 }.');
    }
    out.push(p as unknown as PolicyIR);
  }
  return ok(out);
}
