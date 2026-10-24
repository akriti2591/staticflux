/**
 * Navigation stages and the stage-plugin contract (R7.1, R7.6).
 *
 * Fixed named stages, in order:
 *   resolve → exit → availability → transient → pre-auth → auth-boundary → post-auth →
 *   authorize → load → prefetch → enter → render → commit
 *
 * - Plugins attach to a named stage (contributed with core `contribution()` to
 *   `StagePluginsToken`). Packages define custom stages with `defineStage({ position:
 *   'before:authorize' | 'after:load' | … })`.
 * - Every step returns `Result<StageOutcome>`: `continue | redirect | block | cancel`.
 *   `err()` (or a throw) means the navigation failed.
 * - Inside a stage, serial steps (guards) run one after another; consecutive `parallel`
 *   steps (loaders, prefetch) run concurrently.
 * - Steps marked `uninterruptible` defer cancellation by a newer navigation until they
 *   settle (R7.2, R7.3). `render` and `commit` are the commit point and always uninterruptible.
 *
 * Pipelines (which stages run):
 * - `full`   — every stage.
 * - `view`   — sub-route view state (R7.7): exit → enter → commit; no feature reactivation.
 * - `dialog` — routable dialog open/close (R7.17): exit → availability → authorize → load → enter → commit.
 *   (`exit` runs the leaving dialog's guards; R7.17's four stages plus exit/commit bookkeeping.)
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { NavigationContext } from './context.js';
import { NavigationBlockedError, RouteDefinitionError } from './errors.js';
import type { NavigationTarget } from './routes.js';

export const STAGES = [
  'resolve',
  'exit',
  'availability',
  'transient',
  'pre-auth',
  'auth-boundary',
  'post-auth',
  'authorize',
  'load',
  'prefetch',
  'enter',
  'render',
  'commit',
] as const;
export type BuiltinStageId = (typeof STAGES)[number];

export const PIPELINE_KINDS = ['full', 'view', 'dialog'] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];

export const PIPELINE_STAGES: { readonly [K in PipelineKind]: readonly BuiltinStageId[] } = {
  full: STAGES,
  view: ['exit', 'enter', 'commit'],
  dialog: ['exit', 'availability', 'authorize', 'load', 'enter', 'commit'],
};

/** Stages that form the commit point: once entered, the navigation completes (cancellation is ignored). */
export const COMMIT_POINT_STAGES: readonly BuiltinStageId[] = ['render', 'commit'];

// ---------------------------------------------------------------- custom stages

export type StagePosition = `before:${BuiltinStageId}` | `after:${BuiltinStageId}`;
/** Custom stage ids are namespaced, so they never collide with built-in names. */
export type CustomStageId = `${string}/${string}`;

export interface CustomStage<Id extends CustomStageId = CustomStageId> {
  readonly kind: 'stage';
  readonly id: Id;
  readonly position: StagePosition;
  /** Among custom stages at the same position (ascending). */
  readonly order?: number;
  /** Pipelines that include this stage (default `['full']`; the anchor must be part of the pipeline). */
  readonly pipelines?: readonly PipelineKind[];
  /** All steps of this stage defer cancellation until settled. */
  readonly uninterruptible?: boolean;
  readonly description?: string;
}

export function defineStage<const Id extends CustomStageId>(stage: Omit<CustomStage<Id>, 'kind'>): CustomStage<Id> {
  return Object.freeze({ ...stage, kind: 'stage' as const });
}

export type StageRef = BuiltinStageId | CustomStage;
export type StageName = BuiltinStageId | CustomStageId;

export function stageName(ref: StageRef): StageName {
  return typeof ref === 'string' ? ref : ref.id;
}

// ---------------------------------------------------------------- outcomes

export interface RedirectOptions {
  /** Replace the current history entry instead of inheriting the navigation's mode. */
  readonly replace?: boolean;
  /** History state for the redirect target (e.g. the pending intent for a login redirect). */
  readonly state?: unknown;
  readonly reason?: string;
}

export type StageOutcome =
  | { readonly kind: 'continue' }
  | ({ readonly kind: 'redirect'; readonly target: NavigationTarget } & RedirectOptions)
  | { readonly kind: 'block'; readonly error: SfError }
  | { readonly kind: 'cancel'; readonly reason: string };

export type StageResult = Result<StageOutcome>;
export type StageReturn = StageResult | Promise<StageResult>;

const CONTINUE: StageOutcome = Object.freeze({ kind: 'continue' as const });

/** Continue with the next step. */
export function proceed(): StageResult {
  return ok(CONTINUE);
}

/** Stop this navigation and navigate to `target` instead (typed route target or `{ href }`). */
export function redirect(target: NavigationTarget, options: RedirectOptions = {}): StageResult {
  return ok({ kind: 'redirect', target, ...options });
}

/** Stop this navigation; the current location stays. */
export function block(error: SfError = NavigationBlockedError()): StageResult {
  return ok({ kind: 'block', error });
}

/** Silently drop this navigation (no error). */
export function cancel(reason = 'cancelled-by-step'): StageResult {
  return ok({ kind: 'cancel', reason });
}

// ---------------------------------------------------------------- plugins

export type StepId = `${string}/${string}`;

export interface StagePlugin {
  readonly id: StepId;
  readonly stage: StageRef;
  /** Position inside the stage (ascending; built-in steps run at -1000, route guards from 1000). */
  readonly order?: number;
  /** `serial` (guards, default) or `parallel` (loaders, prefetch): consecutive parallel steps run together. */
  readonly concurrency?: 'serial' | 'parallel';
  /** Defer cancellation by a newer navigation until this step settles (R7.2). */
  readonly uninterruptible?: boolean;
  /** Pipelines this plugin runs in (default `['full']`). */
  readonly pipelines?: readonly PipelineKind[];
  /** Skip the plugin for navigations it does not care about (e.g. routes without `requires.auth`). */
  applies?(context: NavigationContext): boolean;
  run(context: NavigationContext, signal: AbortSignal): StageReturn;
  readonly description?: string;
}

/** Declare a stage plugin (typed identity). */
export function stagePlugin<const P extends StagePlugin>(plugin: P): P {
  return plugin;
}

// ---------------------------------------------------------------- stage plans

export interface PlannedStage {
  readonly name: StageName;
  readonly builtin: BuiltinStageId | undefined;
  readonly custom: CustomStage | undefined;
  readonly uninterruptible: boolean;
  /** Inside the commit point (render, commit, and custom stages between/after them). */
  readonly commitPoint: boolean;
  /** Runs after the history entry was committed (outcomes other than redirect are ignored). */
  readonly postCommit: boolean;
}

export function validateStages(stages: readonly CustomStage[]): Result<void> {
  const seen = new Set<string>();
  for (const stage of stages) {
    const [where, anchor] = stage.position.split(':') as [string, string];
    if ((where !== 'before' && where !== 'after') || !(STAGES as readonly string[]).includes(anchor)) {
      return err(RouteDefinitionError({ message: `Stage "${stage.id}" has an invalid position "${stage.position}".`, details: { stage: stage.id } }));
    }
    if (seen.has(stage.id)) {
      return err(RouteDefinitionError({ message: `Stage "${stage.id}" is registered twice.`, details: { stage: stage.id } }));
    }
    seen.add(stage.id);
  }
  return ok();
}

/** Ordered stages of one pipeline kind, with custom stages spliced in at their positions. */
export function planStages(kind: PipelineKind, custom: readonly CustomStage[]): readonly PlannedStage[] {
  const anchors = PIPELINE_STAGES[kind];
  const sorted = [...custom]
    .filter((s) => (s.pipelines ?? ['full']).includes(kind))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const plan: PlannedStage[] = [];
  let commitPoint = false;
  let postCommit = false;
  const push = (name: StageName, builtin: BuiltinStageId | undefined, stage: CustomStage | undefined): void => {
    plan.push({
      name,
      builtin,
      custom: stage,
      uninterruptible: commitPoint || stage?.uninterruptible === true,
      commitPoint,
      postCommit,
    });
  };
  for (const anchor of anchors) {
    if (COMMIT_POINT_STAGES.includes(anchor)) commitPoint = true;
    for (const stage of sorted) if (stage.position === `before:${anchor}`) push(stage.id, undefined, stage);
    push(anchor, anchor, undefined);
    if (anchor === 'commit') postCommit = true;
    for (const stage of sorted) if (stage.position === `after:${anchor}`) push(stage.id, undefined, stage);
  }
  return plan;
}
