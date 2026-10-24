/**
 * Stage runner: executes the steps of one stage (built-ins, plugins, route/dialog guards)
 * with serial/parallel grouping, cancellation, uninterruptible deferral and spans.
 * Router-internal; exported for tests and for custom routers.
 */
import { anySignal, type SfError, type Span, type Telemetry, toSfError } from '@staticflux/core';
import type { NavigationContext } from './context.js';
import { StageFailedError } from './errors.js';
import type { StageName, StageOutcome, StageReturn } from './stages.js';
import { ROUTER_SUBSYSTEMS } from './telemetry.js';

export type StepSource = 'builtin' | 'plugin' | 'route' | 'dialog' | 'dynamic';

export interface PipelineStep {
  readonly id: string;
  readonly source: StepSource;
  readonly order: number;
  readonly concurrency: 'serial' | 'parallel';
  readonly uninterruptible: boolean;
  run(context: NavigationContext, signal: AbortSignal): StageReturn;
}

export type PipelineOutcome = StageOutcome | { readonly kind: 'fail'; readonly error: SfError };

/**
 * Cancellation control of one navigation run.
 * `requestCancel()` aborts `signal` immediately, unless an uninterruptible step holds
 * cancellation — then the abort happens when the last hold is released (R7.2, R7.3).
 */
export interface RunControl {
  /** Soft signal: aborted when a newer navigation supersedes this run. */
  readonly signal: AbortSignal;
  /** Hard signal: aborted only when the router is disposed. Given to uninterruptible steps. */
  readonly hardSignal: AbortSignal;
  readonly cancelRequested: boolean;
  requestCancel(reason: string): void;
  /** Enter an uninterruptible section; returns the release function. */
  hold(): () => void;
  /** The run finished: later releases never abort. */
  finish(): void;
}

export function createRunControl(hardSignal: AbortSignal): RunControl {
  const controller = new AbortController();
  let holds = 0;
  let pending: string | undefined;
  let finished = false;
  const abort = (reason: string): void => {
    if (!controller.signal.aborted) controller.abort(new DOMException(reason, 'AbortError'));
  };
  if (hardSignal.aborted) abort('router-disposed');
  else hardSignal.addEventListener('abort', () => abort('router-disposed'), { once: true });
  return {
    signal: controller.signal,
    hardSignal,
    get cancelRequested() {
      return pending !== undefined || controller.signal.aborted;
    },
    requestCancel(reason) {
      if (finished) return;
      pending ??= reason;
      if (holds === 0) abort(reason);
    },
    hold() {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0 && pending !== undefined && !finished) abort(pending);
      };
    },
    finish() {
      finished = true;
    },
  };
}

const CONTINUE: PipelineOutcome = { kind: 'continue' };

/** Cancellation reason carried by an aborted run signal (`superseded`, `aborted`, `router-disposed`). */
export function cancelReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.message.length > 0 ? reason.message : 'superseded';
}

function cancelled(signal: AbortSignal): PipelineOutcome {
  return { kind: 'cancel', reason: cancelReason(signal) };
}

function abortedPromise(signal: AbortSignal): Promise<PipelineOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(cancelled(signal));
      return;
    }
    signal.addEventListener('abort', () => resolve(cancelled(signal)), { once: true });
  });
}

async function invoke(step: PipelineStep, context: NavigationContext, signal: AbortSignal): Promise<PipelineOutcome> {
  try {
    const result = await step.run(context, signal);
    if (result === undefined || result === null) return CONTINUE; // untyped callers
    if (result.ok) return result.value;
    if (signal.aborted && result.error.kind === 'aborted') return cancelled(signal);
    return { kind: 'fail', error: result.error };
  } catch (error) {
    if (signal.aborted) return cancelled(signal);
    return {
      kind: 'fail',
      error: StageFailedError({ message: `Step "${step.id}" threw: ${toSfError(error).message}`, cause: error, details: { step: step.id } }),
    };
  }
}

export interface StageRunOptions {
  readonly stage: StageName;
  readonly telemetry: Telemetry;
  readonly span: Span;
  /** Stage-level uninterruptible (custom stage flag or commit point). */
  readonly uninterruptible: boolean;
}

async function runStep(
  step: PipelineStep,
  context: NavigationContext,
  control: RunControl,
  softSignal: AbortSignal,
  options: StageRunOptions,
): Promise<PipelineOutcome> {
  const uninterruptible = options.uninterruptible || step.uninterruptible;
  const span = options.telemetry.span('nav.step', {
    subsystem: ROUTER_SUBSYSTEMS.pipeline,
    level: 'verbose',
    parent: options.span,
    attrs: { step: step.id, source: step.source, stage: options.stage, uninterruptible },
  });
  const release = uninterruptible ? control.hold() : undefined;
  let outcome: PipelineOutcome;
  try {
    if (uninterruptible) {
      outcome = await invoke(step, context, control.hardSignal);
    } else if (softSignal.aborted) {
      outcome = cancelled(softSignal);
    } else {
      outcome = await Promise.race([invoke(step, context, softSignal), abortedPromise(softSignal)]);
    }
  } finally {
    release?.();
  }
  span.set('outcome', outcome.kind);
  span.end(outcome.kind === 'fail' ? 'error' : outcome.kind === 'cancel' ? 'cancelled' : 'ok', outcome.kind === 'fail' ? outcome.error : undefined);
  return outcome;
}

/** Run one stage's steps (already sorted by `order`). */
export async function runStage(
  steps: readonly PipelineStep[],
  context: NavigationContext,
  control: RunControl,
  options: StageRunOptions,
): Promise<PipelineOutcome> {
  let i = 0;
  while (i < steps.length) {
    const step = steps[i] as PipelineStep;
    if (step.concurrency === 'serial') {
      const outcome = await runStep(step, context, control, control.signal, options);
      if (outcome.kind !== 'continue') return outcome;
      if (!options.uninterruptible && control.signal.aborted) return cancelled(control.signal);
      i += 1;
      continue;
    }
    // A group of consecutive parallel steps runs concurrently; the first non-continue wins.
    const group: PipelineStep[] = [];
    while (i < steps.length && (steps[i] as PipelineStep).concurrency === 'parallel') {
      group.push(steps[i] as PipelineStep);
      i += 1;
    }
    const groupController = new AbortController();
    const groupSignal = anySignal(control.signal, groupController.signal);
    let decided: PipelineOutcome | undefined;
    await Promise.all(
      group.map(async (member) => {
        const outcome = await runStep(member, context, control, groupSignal, options);
        if (outcome.kind !== 'continue' && decided === undefined) {
          decided = outcome;
          groupController.abort();
        }
      }),
    );
    if (decided !== undefined) return decided;
    if (!options.uninterruptible && control.signal.aborted) return cancelled(control.signal);
  }
  return CONTINUE;
}
