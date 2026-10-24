/**
 * Capability declarations (R3.1–R3.3, R6.17, R19.18).
 *
 * A capability is a typed, schema-described action that the UI, the command
 * palette and AI agents (WebMCP) all call through ONE pipeline
 * (`registry.invoke`). The declaration is data and lives in the feature's
 * manifest/contract file; the implementation registers separately when the
 * owning feature activates.
 *
 * @example
 * export const InsertImage = defineCapability({
 *   id: 'agent/insert-image',
 *   title: 'Insert image',
 *   description: 'Insert an image block into the open document.',
 *   input: s.object({ src: s.string({ format: 'uri' }), alt: s.optional(s.string()) }),
 *   output: s.object({ blockId: s.string() }),
 *   policy: { resource: 'agent/insert-image' },
 *   feature: { id: 'studio/desktop' },
 *   destructive: false,
 *   requiresConfirmation: false,
 *   costEstimate: () => ({ meter: 'credits', amount: 1 }),
 * });
 */
import type { Result, Span } from '@staticflux/core';
import type { AnySchema, Infer, JsonSchema, Schema } from './schema.js';
import { toJsonSchema } from './schema.js';

/** Namespaced capability id, e.g. `agent/insert-image`. */
export type CapabilityId = `${string}/${string}`;

/** Policy subjects (R6.17). Agents are distinct, narrower subjects. */
export type CapabilitySubject = 'user' | 'agent' | 'guest' | 'system';

/** Reference to the owning feature (structurally compatible with runtime `featureRef`). */
export interface CapabilityFeatureRef {
  readonly id: `${string}/${string}`;
}

/** Policy coordinates handed to the decide port (gate: level `capability`). */
export interface CapabilityPolicyRef {
  /** Gate resource id. Defaults to the capability id. */
  readonly resource: string;
  /** Gate action id, if the policy distinguishes actions. */
  readonly action?: string;
}

/** Amount to reserve on a meter before running (R6.18). */
export interface CostEstimate {
  readonly meter: string;
  readonly amount: number;
}

export interface CapabilityOptions<I, O, Id extends CapabilityId> {
  readonly id: Id;
  /** Short human title (command palette, tool listing). Defaults to the id. */
  readonly title?: string;
  /** What it does — written for humans AND agents (it becomes the tool description). */
  readonly description: string;
  readonly input: Schema<I, false>;
  readonly output: Schema<O, false>;
  readonly policy?: CapabilityPolicyRef;
  /** Owning feature; invoking while it is not active goes through the activation port. */
  readonly feature?: CapabilityFeatureRef;
  /** Always ask the user before running (any subject). */
  readonly requiresConfirmation: boolean;
  /** Irreversible / data-destroying. Non-user subjects (agents) always need confirmation. */
  readonly destructive: boolean;
  /** Estimated cost for actions of unknown cost (reserve → commit | release). */
  readonly costEstimate?: (input: I) => CostEstimate | undefined;
  /** Publish to agents (WebMCP). Default true; gating still applies. */
  readonly exposeToAgents?: boolean;
  /** Abort the run after this many ms (SF-ASYNC-001). */
  readonly timeoutMs?: number;
}

export interface Capability<I = unknown, O = unknown, Id extends CapabilityId = CapabilityId> {
  readonly kind: 'capability';
  readonly id: Id;
  readonly title: string;
  readonly description: string;
  readonly input: Schema<I, false>;
  readonly output: Schema<O, false>;
  readonly policy: CapabilityPolicyRef;
  readonly feature: CapabilityFeatureRef | undefined;
  readonly requiresConfirmation: boolean;
  readonly destructive: boolean;
  readonly costEstimate: ((input: I) => CostEstimate | undefined) | undefined;
  readonly exposeToAgents: boolean;
  readonly timeoutMs: number | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapability = Capability<any, any, CapabilityId>;

export type CapabilityInput<C> = C extends Capability<infer I, unknown, CapabilityId> ? I : never;
export type CapabilityOutput<C> = C extends Capability<unknown, infer O, CapabilityId> ? O : never;

/** Declare a capability (typed, frozen data). */
export function defineCapability<I, O, const Id extends CapabilityId>(
  options: CapabilityOptions<I, O, Id>,
): Capability<I, O, Id> {
  return Object.freeze({
    kind: 'capability',
    id: options.id,
    title: options.title ?? options.id,
    description: options.description,
    input: options.input,
    output: options.output,
    policy: options.policy ?? { resource: options.id },
    feature: options.feature,
    requiresConfirmation: options.requiresConfirmation,
    destructive: options.destructive,
    costEstimate: options.costEstimate,
    exposeToAgents: options.exposeToAgents ?? true,
    timeoutMs: options.timeoutMs,
  });
}

/** Machine-readable description (R3.3): what agents, palettes and devtools read. */
export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly policy: CapabilityPolicyRef;
  readonly feature: string | undefined;
  readonly destructive: boolean;
  readonly requiresConfirmation: boolean;
  readonly metered: boolean;
  readonly exposeToAgents: boolean;
}

export function describeCapability(capability: AnyCapability): CapabilityDescriptor {
  return {
    id: capability.id,
    title: capability.title,
    description: capability.description,
    inputSchema: toJsonSchema(capability.input as AnySchema),
    outputSchema: toJsonSchema(capability.output as AnySchema),
    policy: capability.policy,
    feature: capability.feature?.id,
    destructive: capability.destructive,
    requiresConfirmation: capability.requiresConfirmation,
    metered: capability.costEstimate !== undefined,
    exposeToAgents: capability.exposeToAgents,
  };
}

// ---------------------------------------------------------------- implementations

/** Where a call came from (e.g. `webmcp` with the agent client). Passed to every port. */
export interface InvocationOrigin {
  /** Channel id, e.g. `ui/button`, `shell/palette`, `webmcp`. */
  readonly channel: string;
  /** Channel-specific data (e.g. the WebMCP client for `requestUserInteraction`). */
  readonly details?: unknown;
}

export interface RunContext {
  readonly invocationId: string;
  readonly subject: CapabilitySubject;
  readonly origin: InvocationOrigin | undefined;
  /** Aborted on caller abort, timeout or registry disposal. */
  readonly signal: AbortSignal;
  /** Span of this invocation (parent for child spans). */
  readonly span: Span;
  /** Reserved amount, if metered. */
  readonly reserved: CostEstimate | undefined;
  /** Report the actual cost (committed instead of the estimate). */
  reportCost(amount: number): void;
}

export type CapabilityRun<I, O> = (input: I, context: RunContext) => Promise<Result<O>> | Result<O>;

export interface CapabilityImplementation<I = unknown, O = unknown> {
  readonly kind: 'capability-implementation';
  readonly capability: Capability<I, O>;
  readonly run: CapabilityRun<I, O>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapabilityImplementation = CapabilityImplementation<any, any>;

/** Pair a declaration with its implementation (typed against the schemas). */
export function implementCapability<C extends AnyCapability>(
  capability: C,
  run: CapabilityRun<CapabilityInput<C>, CapabilityOutput<C>>,
): CapabilityImplementation<CapabilityInput<C>, CapabilityOutput<C>> {
  return Object.freeze({ kind: 'capability-implementation', capability, run });
}

// ---------------------------------------------------------------- ports (gate, messaging, meters, runtime plug in)

export interface DecisionRequest {
  readonly capability: AnyCapability;
  readonly input: unknown;
  readonly subject: CapabilitySubject;
  readonly origin: InvocationOrigin | undefined;
}

export type DenyReason = 'login' | 'upgrade' | 'forbidden' | 'unavailable' | 'quota' | 'rate';

export type CapabilityDecision =
  | {
      readonly effect: 'allow';
      /** The policy asks for confirmation (e.g. gate agent policies). */
      readonly requiresConfirmation?: boolean;
      /** Policy cost; overrides `costEstimate`. */
      readonly cost?: CostEstimate;
    }
  | {
      readonly effect: 'deny';
      readonly reason: DenyReason;
      readonly meta?: Readonly<Record<string, unknown>>;
    };

/**
 * Authorization port (gate plugs in: `gate.decide('capability', policy.resource, action, { subject })`).
 * Client gating is UX, not security (R6.16) — the server re-checks.
 */
export interface CapabilityDecidePort {
  decide(request: DecisionRequest): CapabilityDecision | Promise<CapabilityDecision>;
}

export interface ConfirmationRequest {
  readonly capability: AnyCapability;
  readonly input: unknown;
  readonly subject: CapabilitySubject;
  readonly origin: InvocationOrigin | undefined;
  readonly reason: 'destructive' | 'declared' | 'policy';
}

/** Confirmation port (messaging plugs in a confirm dialog). `ok(false)` = declined. */
export interface CapabilityConfirmPort {
  confirm(request: ConfirmationRequest, signal: AbortSignal): Promise<Result<boolean>>;
}

export interface MeterLease {
  commit(actual: number, signal?: AbortSignal): Promise<Result<void>>;
  release(signal?: AbortSignal): Promise<Result<void>>;
}

/** Meter port (gate meters plug in: `meters.get(id).reserve(amount)`). Denials use kind `quota` / `rate`. */
export interface CapabilityMeterPort {
  reserve(cost: CostEstimate, signal: AbortSignal): Promise<Result<MeterLease>>;
}

export interface ActivationLease {
  /** Drop the ref-count taken for this invocation (R5.6). */
  release(): void;
}

/** Feature-activation port (runtime feature host plugs in). Resolves once the feature's logic is active. */
export interface FeatureActivationPort {
  ensureActive(featureId: string, signal: AbortSignal): Promise<Result<ActivationLease | undefined>>;
}

