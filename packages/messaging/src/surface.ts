/**
 * Surface declarations (R13.4) and the surface machine (docs/LIFECYCLES.md §8).
 *
 * Features declare surfaces as data and *request* them from the surface manager;
 * they never render overlays themselves.
 *
 * ```ts
 * export const shareDialog = defineSurface({
 *   id: 'studio/share-dialog', kind: 'dialog', scope: 'route', priority: 'normal',
 *   label: 'Share document',
 *   routable: { key: 'share', params: (raw) => ok({ docId: raw['doc'] ?? '' }) },
 *   render: ({ props, dismiss }) => html`<share-form .docId=${props.docId} @done=${() => dismiss('completed')}></share-form>`,
 * });
 * ```
 */
import { defineMachine, type Result, type ScopeLevel } from '@staticflux/core';
import type { GateResource } from '@staticflux/ui';

export const SURFACE_KINDS = [
  'dialog',
  'sheet',
  'popover',
  'tooltip',
  'toast',
  'banner',
  'coach-mark',
  'inline-alert',
] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** Modal kinds share one stack, focus trap and inert background. */
export const MODAL_KINDS: readonly SurfaceKind[] = ['dialog', 'sheet'];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SurfacePriority = (typeof PRIORITIES)[number];

export function priorityRank(priority: SurfacePriority): number {
  return PRIORITIES.indexOf(priority);
}

export type SurfaceId = `${string}/${string}`;

/** Why a surface left the screen (metrics + routable dismiss intents). */
export type DismissReason =
  | 'user' // close button / explicit user dismissal
  | 'escape'
  | 'backdrop'
  | 'action' // the surface's own primary action
  | 'completed' // task done (coach mark "got it", wizard finished)
  | 'timeout' // toast duration elapsed
  | 'replaced' // a newer surface of the same slot replaced it
  | 'scope-ended' // the owning scope was disposed (I-7)
  | 'navigation' // the router closed it (routable dialogs)
  | 'programmatic';

/** Reasons that count as "the user saw and handled it" (coach marks become seen). */
export const USER_REASONS: readonly DismissReason[] = ['user', 'escape', 'backdrop', 'action', 'completed'];

/** Typed coach-mark target: elements mark themselves with `coachTarget(target)`. */
export interface CoachTarget<Id extends SurfaceId = SurfaceId> {
  readonly kind: 'coach-target';
  readonly id: Id;
}

export function defineCoachTarget<const Id extends SurfaceId>(id: Id): CoachTarget<Id> {
  return Object.freeze({ kind: 'coach-target', id });
}

export interface SurfaceRenderContext<P, R> {
  readonly props: P;
  /** Dismiss this surface (optionally with a result for the requester). */
  dismiss(reason?: DismissReason, result?: R): void;
  /** Id for `aria-labelledby` on the surface's heading. */
  readonly titleId: string;
  /** Coach sequences: 1-based step and total (undefined otherwise). */
  readonly step?: { readonly index: number; readonly total: number };
}

export interface RoutableSpec<P> {
  /** Dialog key in the URL (`/d/<key>`, `<feature-path>/d/<key>`). App-unique. */
  readonly key: string;
  /** Parse URL params into props. Default: no params (props `undefined`). */
  readonly params?: (raw: Readonly<Record<string, string>>) => Result<P>;
  /** Lazy-load the dialog content (chunk) before entering (R7.17). */
  readonly load?: (signal: AbortSignal) => Promise<Result<void>>;
}

export interface SurfaceDefInit<P, R> {
  readonly id: SurfaceId;
  readonly kind: SurfaceKind;
  /** Declared owning scope level: requests from a longer-lived owner are rejected (I-7). */
  readonly scope: ScopeLevel;
  readonly priority?: SurfacePriority;
  /** Accessible name (aria-label) when no heading uses `titleId`. */
  readonly label?: string | ((props: P) => string);
  readonly render: (context: SurfaceRenderContext<P, R>) => unknown;
  /** Routable dialogs only (R7.16–R7.20). */
  readonly routable?: RoutableSpec<P>;
  /** Gate resource checked before showing (R13.9). */
  readonly gate?: GateResource;
  /** Shown instead when the gate denies (props are not forwarded). */
  readonly upsell?: SurfaceDef<void, unknown>;
  /** Escape/backdrop dismiss allowed (default true). */
  readonly dismissible?: boolean;
  /** Toasts: auto-dismiss after this long (default 5000 ms; `null` = sticky; urgent toasts default sticky). */
  readonly durationMs?: number | null;
  /** Deduplicate concurrent requests (default: true for banners). Key defaults to the surface id. */
  readonly dedupe?: boolean | ((props: P) => string);
  /** Coach marks: the element it points at. */
  readonly target?: CoachTarget;
  /** Coach marks: give up when the target is not available within this time (default: wait for scope end). */
  readonly targetTimeoutMs?: number;
  /** Coach marks: show at most once per user (default true). */
  readonly once?: boolean;
  /** Inline alerts: the outlet that renders them (`<sf-surface-outlet outlet="…">`). */
  readonly outlet?: SurfaceId;
  readonly description?: string;
}

export interface SurfaceDef<P = void, R = unknown> extends SurfaceDefInit<P, R> {
  readonly type: 'surface';
  readonly priority: SurfacePriority;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySurfaceDef = SurfaceDef<any, any>;

/** Declare a surface (data). Props/result types are inferred from `render`. */
export function defineSurface<P = void, R = unknown>(init: SurfaceDefInit<P, R>): SurfaceDef<P, R> {
  if (init.routable !== undefined && init.kind !== 'dialog' && init.kind !== 'sheet') {
    throw new Error(`defineSurface("${init.id}"): only dialogs and sheets can be routable.`);
  }
  if (init.kind === 'coach-mark' && init.target === undefined) {
    throw new Error(`defineSurface("${init.id}"): coach marks need a \`target\`.`);
  }
  return Object.freeze({ ...init, type: 'surface', priority: init.priority ?? 'normal' });
}

export interface CoachSequence {
  readonly kind: 'coach-sequence';
  readonly id: SurfaceId;
  readonly steps: readonly SurfaceDef<void, unknown>[];
}

/** An ordered coach-mark tour; already-seen steps are skipped. */
export function defineCoachSequence(init: { readonly id: SurfaceId; readonly steps: readonly SurfaceDef<void, unknown>[] }): CoachSequence {
  for (const step of init.steps) {
    if (step.kind !== 'coach-mark') throw new Error(`defineCoachSequence("${init.id}"): step "${step.id}" is not a coach mark.`);
  }
  return Object.freeze({ kind: 'coach-sequence', id: init.id, steps: init.steps });
}

// ---------------------------------------------------------------- machine

export const surfaceMachine = defineMachine({
  id: 'messaging/surface',
  initial: 'requested',
  states: ['requested', 'queued', 'showing', 'suspended', 'dismissing', 'dismissed', 'rejected'],
  transitions: {
    requested: { enqueue: 'queued', reject: 'rejected', dismiss: 'dismissing' },
    queued: { show: 'showing', dismiss: 'dismissing', reject: 'rejected' },
    showing: { suspend: 'suspended', dismiss: 'dismissing' },
    suspended: { resume: 'showing', dismiss: 'dismissing' },
    dismissing: { done: 'dismissed' },
  },
  terminal: ['dismissed', 'rejected'],
});

export type SurfaceState = (typeof surfaceMachine.states)[number];
export type SurfaceEvent = 'enqueue' | 'reject' | 'show' | 'suspend' | 'resume' | 'dismiss' | 'done';
