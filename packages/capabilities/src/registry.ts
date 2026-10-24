/**
 * The capability registry and the ONE invoke pipeline (R3.3, R6.17, R6.18, R19.16).
 *
 *   validate input → authorize (decide port) → confirm (confirm port, when needed)
 *   → ensure owning feature active (activation port) → reserve cost (meter port)
 *   → run → validate output → commit | release → Result
 *
 * Every invocation is a `capabilities/invocation` machine and a
 * `capability.invoke` span (`capabilities/invoke`). UI buttons, the command
 * palette and agents (WebMCP) all call `invoke`, so gating, confirmation,
 * metering and tracing apply uniformly.
 *
 * Client gating is UX, not security (R6.16): the decide port is advisory and the
 * server re-checks every call the implementation makes.
 */
import {
  AbortedError,
  anySignal,
  box,
  createMachine,
  createNoopTelemetry,
  createScope,
  defineMachine,
  err,
  metric,
  ok,
  type Result,
  type Scope,
  type SfError,
  type Span,
  type Telemetry,
  TaskTimeoutError,
  toSfError,
} from '@staticflux/core';
import {
  type ActivationLease,
  type AnyCapability,
  type AnyCapabilityImplementation,
  type CapabilityConfirmPort,
  type CapabilityDecidePort,
  type CapabilityDecision,
  type CapabilityDescriptor,
  type CapabilityInput,
  type CapabilityMeterPort,
  type CapabilityOutput,
  type CapabilitySubject,
  type ConfirmationRequest,
  type CostEstimate,
  describeCapability,
  type FeatureActivationPort,
  type InvocationOrigin,
  type MeterLease,
  type RunContext,
} from './capability.js';
import {
  ActivationFailedError,
  CapabilityDeniedError,
  CapabilityLoginRequiredError,
  CapabilityQuotaError,
  CapabilityRateLimitedError,
  CapabilityUnavailableError,
  ConfirmationDeclinedError,
  DuplicateCapabilityError,
  ImplementationFailedError,
  InvalidOutputError,
  NotImplementedError,
  UnknownCapabilityError,
} from './errors.js';
import { validate } from './schema.js';

export const CAPABILITIES_SUBSYSTEM = 'capabilities/invoke' as const;

// ---------------------------------------------------------------- lifecycle

/** Invocation lifecycle (docs: packages/capabilities/AGENTS.md; mirror into LIFECYCLES.md §14). */
export const invocationMachine = defineMachine({
  id: 'capabilities/invocation',
  initial: 'received',
  states: [
    'received',
    'validating',
    'authorizing',
    'confirming',
    'activating',
    'reserving',
    'running',
    'verifying',
    'succeeded',
    'failed',
    'cancelled',
  ],
  transitions: {
    received: { validate: 'validating', fail: 'failed', cancel: 'cancelled' },
    validating: { authorize: 'authorizing', fail: 'failed', cancel: 'cancelled' },
    authorizing: { confirm: 'confirming', activate: 'activating', fail: 'failed', cancel: 'cancelled' },
    confirming: { activate: 'activating', fail: 'failed', cancel: 'cancelled' },
    activating: { reserve: 'reserving', run: 'running', fail: 'failed', cancel: 'cancelled' },
    reserving: { run: 'running', fail: 'failed', cancel: 'cancelled' },
    running: { verify: 'verifying', fail: 'failed', cancel: 'cancelled' },
    verifying: { succeed: 'succeeded', fail: 'failed' },
  },
  terminal: ['succeeded', 'failed', 'cancelled'],
});

export type InvocationState = (typeof invocationMachine.states)[number];

// ---------------------------------------------------------------- metrics

export const CapabilityMetrics = {
  invocations: /* @__PURE__ */ metric.counter('capabilities/invocations', {
    description: 'Capability invocations by capability, subject and outcome.',
  }),
  duration: /* @__PURE__ */ metric.histogram('capabilities/invoke-duration', { unit: 'ms', description: 'End-to-end invoke time.' }),
  denials: /* @__PURE__ */ metric.counter('capabilities/denials', { description: 'Policy denials by reason.' }),
  confirmations: /* @__PURE__ */ metric.counter('capabilities/confirmations', {
    description: 'Confirmation prompts by outcome (confirmed | declined | error).',
  }),
} as const;

// ---------------------------------------------------------------- public API

export interface InvokeOptions {
  readonly subject: CapabilitySubject;
  readonly signal?: AbortSignal;
  readonly origin?: InvocationOrigin;
  /** Parent span (e.g. a navigation or tool-call span). */
  readonly parent?: Span;
}

export type RegistryChange =
  | { readonly type: 'declared' | 'undeclared'; readonly capability: AnyCapability }
  | { readonly type: 'implemented' | 'unimplemented'; readonly capability: AnyCapability };

export interface RegistrationOptions {
  /** Unregister when this scope is disposed (feature/route/session lifetime). */
  readonly scope?: Scope;
}

export interface InvocationInfo {
  readonly invocationId: string;
  readonly capability: string;
  readonly subject: CapabilitySubject;
  readonly state: InvocationState;
}

export interface CapabilityRegistry {
  /** Declare a capability (idempotent for the same object). Returns an undeclare function. */
  declare(capability: AnyCapability, options?: RegistrationOptions): Result<() => void>;
  /** Register the implementation (one live implementation per id). Returns an unregister function. */
  provide(implementation: AnyCapabilityImplementation, options?: RegistrationOptions): Result<() => void>;
  get(id: string): AnyCapability | undefined;
  /** Declared capabilities, in declaration order. Reactive. */
  list(): readonly AnyCapability[];
  /** Machine-readable descriptors (R3.3). Reactive. */
  describe(): readonly CapabilityDescriptor[];
  isImplemented(id: string): boolean;
  onChange(listener: (change: RegistryChange) => void): () => void;
  /** Preview the policy decision (UI enable/disable, palette filtering). Does not run anything. */
  preview(capability: AnyCapability, input: unknown, subject: CapabilitySubject): Promise<CapabilityDecision>;
  invoke<C extends AnyCapability>(
    capability: C,
    input: CapabilityInput<C>,
    options: InvokeOptions,
  ): Promise<Result<CapabilityOutput<C>>>;
  /** Untyped entry (agents, WebMCP, deep links): the input is validated against the schema. */
  invoke(id: string, input: unknown, options: InvokeOptions): Promise<Result<unknown>>;
  /** In-flight invocations (devtools). */
  inFlight(): readonly InvocationInfo[];
  dispose(): Promise<void>;
}

export interface CapabilityRegistryOptions {
  readonly decide: CapabilityDecidePort;
  readonly confirm: CapabilityConfirmPort;
  readonly meter: CapabilityMeterPort;
  readonly activation: FeatureActivationPort;
  readonly declarations?: readonly AnyCapability[];
  readonly implementations?: readonly AnyCapabilityImplementation[];
  readonly telemetry?: Telemetry;
  /** Deterministic ids in tests. */
  readonly createId?: () => string;
}

const DENIAL_ERRORS = {
  login: CapabilityLoginRequiredError,
  upgrade: CapabilityDeniedError,
  forbidden: CapabilityDeniedError,
  unavailable: CapabilityUnavailableError,
  quota: CapabilityQuotaError,
  rate: CapabilityRateLimitedError,
} as const;

function confirmationReason(
  capability: AnyCapability,
  decision: CapabilityDecision & { effect: 'allow' },
  subject: CapabilitySubject,
): ConfirmationRequest['reason'] | undefined {
  if (capability.destructive && subject !== 'user') return 'destructive';
  if (capability.requiresConfirmation) return 'declared';
  if (decision.requiresConfirmation === true) return 'policy';
  return undefined;
}

export function createCapabilityRegistry(options: CapabilityRegistryOptions): CapabilityRegistry {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const scope = createScope('capabilities/registry');
  let counter = 0;
  const createId = options.createId ?? ((): string => `cap-${(counter += 1)}`);
  const declarations = new Map<string, { capability: AnyCapability; refs: number }>();
  const implementations = new Map<string, AnyCapabilityImplementation>();
  const listeners = new Set<(change: RegistryChange) => void>();
  const inFlight = new Map<string, { info: Omit<InvocationInfo, 'state'>; state: () => InvocationState }>();
  const version = box(0);

  const emit = (change: RegistryChange): void => {
    version.set(version.get() + 1);
    for (const listener of [...listeners]) listener(change);
  };

  function declare(capability: AnyCapability, registration: RegistrationOptions = {}): Result<() => void> {
    const existing = declarations.get(capability.id);
    if (existing !== undefined && existing.capability !== capability) {
      return err(
        DuplicateCapabilityError({
          message: `Capability "${capability.id}" is already declared by a different definition.`,
          details: { capability: capability.id },
        }),
      );
    }
    if (existing === undefined) {
      declarations.set(capability.id, { capability, refs: 1 });
      emit({ type: 'declared', capability });
    } else {
      existing.refs += 1;
    }
    let released = false;
    const undeclare = (): void => {
      if (released) return;
      released = true;
      const entry = declarations.get(capability.id);
      if (entry === undefined || entry.capability !== capability) return;
      entry.refs -= 1;
      if (entry.refs === 0) {
        declarations.delete(capability.id);
        emit({ type: 'undeclared', capability });
      }
    };
    registration.scope?.defer(undeclare);
    return ok(undeclare);
  }

  function provide(implementation: AnyCapabilityImplementation, registration: RegistrationOptions = {}): Result<() => void> {
    const { capability } = implementation;
    const declared = declarations.get(capability.id);
    if (declared !== undefined && declared.capability !== capability) {
      return err(
        DuplicateCapabilityError({
          message: `Implementation for "${capability.id}" uses a different declaration than the registered one.`,
          details: { capability: capability.id },
        }),
      );
    }
    if (implementations.has(capability.id)) {
      return err(
        DuplicateCapabilityError({
          message: `Capability "${capability.id}" already has a live implementation.`,
          details: { capability: capability.id },
        }),
      );
    }
    // Providing implies declaring (the declaration lives as long as the implementation, at least).
    const declaredResult = declare(capability);
    if (!declaredResult.ok) return declaredResult;
    implementations.set(capability.id, implementation);
    emit({ type: 'implemented', capability });
    let released = false;
    const unprovide = (): void => {
      if (released) return;
      released = true;
      if (implementations.get(capability.id) === implementation) {
        implementations.delete(capability.id);
        emit({ type: 'unimplemented', capability });
      }
      declaredResult.value();
    };
    registration.scope?.defer(unprovide);
    return ok(unprovide);
  }

  for (const capability of options.declarations ?? []) declare(capability);
  for (const implementation of options.implementations ?? []) provide(implementation);

  async function decideSafely(request: Parameters<CapabilityDecidePort['decide']>[0]): Promise<Result<CapabilityDecision>> {
    try {
      return ok(await options.decide.decide(request));
    } catch (error) {
      return err(toSfError(error));
    }
  }

  async function invokeImpl(target: AnyCapability | string, input: unknown, invokeOptions: InvokeOptions): Promise<Result<unknown>> {
    const id = typeof target === 'string' ? target : target.id;
    const capability = typeof target === 'string' ? declarations.get(target)?.capability : target;
    const start = telemetry.now();
    const invocationId = createId();
    const { subject } = invokeOptions;
    const channel = invokeOptions.origin?.channel ?? 'direct';
    const span = telemetry.span('capability.invoke', {
      subsystem: CAPABILITIES_SUBSYSTEM,
      attrs: { capability: id, subject, channel, invocation: invocationId },
      parent: invokeOptions.parent,
    });
    const machine = createMachine(invocationMachine);
    machine.onTransition((record) => {
      span.event(record.to);
      telemetry.event(`lifecycle.${invocationMachine.id}.${record.from}→${record.to}`, {
        subsystem: CAPABILITIES_SUBSYSTEM,
        level: 'verbose',
        parent: span,
        attrs: { capability: id, invocation: invocationId },
      });
    });
    inFlight.set(invocationId, { info: { invocationId, capability: id, subject }, state: () => machine.state });

    const controller = new AbortController();
    const signal = anySignal(invokeOptions.signal, scope.signal, controller.signal);
    let lease: MeterLease | undefined;
    let activation: ActivationLease | undefined;

    const finish = async (result: Result<unknown>, outcome: 'ok' | 'error' | 'cancelled'): Promise<Result<unknown>> => {
      if (outcome !== 'ok' && lease !== undefined) {
        const released = await lease.release();
        if (!released.ok) span.event('meter.release-failed', { code: released.error.code });
      }
      activation?.release();
      inFlight.delete(invocationId);
      const attrs = { capability: id, subject, outcome };
      telemetry.record(CapabilityMetrics.invocations, 1, attrs, span);
      telemetry.record(CapabilityMetrics.duration, telemetry.now() - start, attrs, span);
      if (result.ok) span.end('ok');
      else span.end(outcome === 'cancelled' ? 'cancelled' : 'error', result.error);
      return result;
    };
    const fail = (error: SfError): Promise<Result<unknown>> => {
      if (signal.aborted || error.kind === 'aborted') {
        machine.send('cancel');
        return finish(err(error.kind === 'aborted' ? error : AbortedError({ cause: signal.reason })), 'cancelled');
      }
      machine.send('fail');
      return finish(err(error), 'error');
    };
    const aborted = (): Promise<Result<unknown>> => fail(AbortedError({ cause: signal.reason }));

    if (capability === undefined) {
      return fail(UnknownCapabilityError({ message: `Unknown capability "${id}".`, details: { capability: id } }));
    }
    if (signal.aborted) return aborted();

    // 1. validate input
    machine.send('validate');
    const parsed = validate(capability.input, input, `input for "${id}"`);
    if (!parsed.ok) return fail(parsed.error);

    // 2. authorize
    machine.send('authorize');
    const decided = await decideSafely({ capability, input: parsed.value, subject, origin: invokeOptions.origin });
    if (!decided.ok) return fail(decided.error);
    if (signal.aborted) return aborted();
    const decision = decided.value;
    if (decision.effect === 'deny') {
      telemetry.record(CapabilityMetrics.denials, 1, { capability: id, subject, reason: decision.reason }, span);
      return fail(
        DENIAL_ERRORS[decision.reason]({
          message: `Capability "${id}" denied for ${subject}: ${decision.reason}.`,
          details: { capability: id, subject, reason: decision.reason, meta: decision.meta ?? {} },
        }),
      );
    }

    // 3. confirm (destructive non-user calls, declared, or policy-requested)
    const reason = confirmationReason(capability, decision, subject);
    if (reason !== undefined) {
      machine.send('confirm');
      const confirmed = await options.confirm.confirm(
        { capability, input: parsed.value, subject, origin: invokeOptions.origin, reason },
        signal,
      );
      const outcome = confirmed.ok ? (confirmed.value ? 'confirmed' : 'declined') : 'error';
      telemetry.record(CapabilityMetrics.confirmations, 1, { capability: id, subject, outcome }, span);
      if (signal.aborted) return aborted();
      if (!confirmed.ok) return fail(confirmed.error);
      if (!confirmed.value) {
        return fail(ConfirmationDeclinedError({ message: `Confirmation for "${id}" was declined.`, details: { capability: id, reason } }));
      }
    }

    // 4. ensure the owning feature is active (after authorize: denied chunks are never fetched, I-8)
    machine.send('activate');
    if (capability.feature !== undefined) {
      const activated = await options.activation.ensureActive(capability.feature.id, signal);
      if (signal.aborted) {
        if (activated.ok) activated.value?.release();
        return aborted();
      }
      if (!activated.ok) {
        return fail(
          ActivationFailedError({
            message: `Feature "${capability.feature.id}" for capability "${id}" could not be activated.`,
            cause: activated.error,
            details: { capability: id, feature: capability.feature.id, code: activated.error.code },
          }),
        );
      }
      activation = activated.value;
    }
    const implementation = implementations.get(id);
    if (implementation === undefined) {
      return fail(NotImplementedError({ message: `Capability "${id}" has no implementation.`, details: { capability: id } }));
    }

    // 5. reserve cost (reserve → commit | release, R6.18)
    let cost: CostEstimate | undefined;
    try {
      cost = decision.cost ?? capability.costEstimate?.(parsed.value);
    } catch (error) {
      return fail(toSfError(error));
    }
    if (cost !== undefined && cost.amount > 0) {
      machine.send('reserve');
      const reserved = await options.meter.reserve(cost, signal);
      if (!reserved.ok) return fail(reserved.error);
      lease = reserved.value;
      if (signal.aborted) return aborted();
    }

    // 6. run
    machine.send('run');
    let actualCost: number | undefined;
    const context: RunContext = {
      invocationId,
      subject,
      origin: invokeOptions.origin,
      signal,
      span,
      reserved: lease === undefined ? undefined : cost,
      reportCost: (amount) => {
        actualCost = amount;
      },
    };
    let ran: Result<unknown>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const running = Promise.resolve(implementation.run(parsed.value, context));
      running.catch(() => undefined); // a late rejection after a timeout must not go unhandled
      if (capability.timeoutMs === undefined) {
        ran = await running;
      } else {
        const limit = capability.timeoutMs;
        ran = await Promise.race([
          running,
          new Promise<Result<unknown>>((resolve) => {
            timer = setTimeout(() => {
              controller.abort(new DOMException('timeout', 'TimeoutError'));
              resolve(err(TaskTimeoutError({ details: { ms: limit, capability: id } })));
            }, limit);
          }),
        ]);
      }
    } catch (error) {
      ran = err(
        signal.aborted
          ? AbortedError({ cause: signal.reason })
          : ImplementationFailedError({ cause: error, message: `Capability "${id}" threw: ${toSfError(error).message}` }),
      );
    } finally {
      clearTimeout(timer);
    }
    if (!ran.ok) {
      // A timeout aborts the run but is reported as a failure, not a cancellation.
      if (ran.error.kind === 'timeout') {
        machine.send('fail');
        return finish(ran, 'error');
      }
      return fail(ran.error);
    }
    if (signal.aborted) return aborted();

    // 7. validate output
    machine.send('verify');
    const output = validate(capability.output, ran.value, `output of "${id}"`);
    if (!output.ok) {
      return fail(InvalidOutputError({ message: output.error.message, details: { capability: id, ...output.error.details } }));
    }
    if (lease !== undefined && cost !== undefined) {
      const committed = await lease.commit(actualCost ?? cost.amount);
      if (!committed.ok) span.event('meter.commit-failed', { code: committed.error.code });
      lease = undefined;
    }
    machine.send('succeed');
    return finish(ok(output.value), 'ok');
  }

  return {
    declare,
    provide,
    get: (id) => declarations.get(id)?.capability,
    list() {
      version.get();
      return [...declarations.values()].map((entry) => entry.capability);
    },
    describe() {
      version.get();
      return [...declarations.values()].map((entry) => describeCapability(entry.capability));
    },
    isImplemented(id) {
      version.get();
      return implementations.has(id);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async preview(capability, input, subject) {
      const decided = await decideSafely({ capability, input, subject, origin: undefined });
      return decided.ok ? decided.value : { effect: 'deny', reason: 'unavailable', meta: { code: decided.error.code } };
    },
    invoke: invokeImpl as CapabilityRegistry['invoke'],
    inFlight() {
      return [...inFlight.values()].map((entry) => ({ ...entry.info, state: entry.state() }));
    },
    async dispose() {
      await scope.dispose();
      listeners.clear();
      implementations.clear();
      declarations.clear();
      version.set(version.get() + 1);
    },
  };
}
