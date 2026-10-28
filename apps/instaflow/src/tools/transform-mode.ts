/**
 * Transform mode (Instaflow M1c B10a; IF-34.13–34.17; LIFECYCLES §36): Photoshop's Free Transform session. Mod+T
 * enters it on the selection; every gesture, key command and numeric-bar edit made while it is active is a
 * **session-layer preview** that the next one builds on; Enter commits all of them as **one change set = one undo
 * step**, Escape cancels the whole session (nothing was written). While active the pivot handle is shown and a press
 * outside the frame rotates (B3's `PRESS_GESTURES.transform`).
 *
 * - `createPreview(session)` — session-layer previews of spatial values (also B3's per-gesture previews).
 * - `createTransformMode(host, scope?)` — one per tab: `enter`, `stage` (values a step produced), `restore` (a step
 *   was cancelled: show what was staged before it), `commit`, `cancel`, reactive `state`. The session commits by itself
 *   when the selected set changes and cancels when its scope ends (page switch, tab closed).
 * - `applyTransform(host, label, values)` — run a transform now: committed at once when no session is active, staged
 *   into the session when one is (`APPLY`, a table over the session state; rule 4).
 *
 * Machine: `TransformSessionLifecycle` (`instaflow/transform-session`).
 */
import { createMachine, defineMachine, err, ok, type Result, type Scope, watch } from '@staticflux/core';
import type { NodeId, PropertyPath } from '@staticflux/document/v2';
import type { Actor, SessionLayer, Stage } from '@staticflux/stage';
import { commitEdit, type EditTarget } from '../elements/actions.js';
import type { ElementContext } from '../elements/layout.js';
import { TargetGoneError, TransformModeStateError } from './errors.js';
import type { ToolOutcome } from './gesture.js';
import { captureTransform, SPATIAL_VALUE_KEYS, type SpatialValues, type TransformStart, transformWrites, valuesToOps } from './transform.js';
import type { ViewState } from './view-state.js';

/** Session-layer previews of spatial values (with the paths and children that follow them, #54 #66). */
export interface Preview {
  /** Show new values of a start's elements (what `valuesToOps(start, values)` would commit). */
  show(start: TransformStart, values: readonly SpatialValues[]): void;
  clear(): void;
}

/** Previews in the stage's session layer (never persisted; drawn like any composed value). */
export function createPreview(session: Pick<SessionLayer, 'set' | 'clear'>): Preview {
  const touched = new Map<NodeId, Set<PropertyPath>>();
  return {
    show(start, values) {
      for (const w of transformWrites(start, values, 'shown')) {
        const paths = touched.get(w.node) ?? new Set<PropertyPath>();
        touched.set(w.node, paths.add(w.path));
        session.set(w.node, w.path, w.value);
      }
    },
    clear() {
      for (const [node, paths] of touched) for (const path of paths) session.clear(node, path);
      touched.clear();
    },
  };
}

export const TransformSessionLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/transform-session',
  initial: 'idle',
  states: ['idle', 'active'],
  transitions: {
    idle: { enter: 'active' },
    active: { stage: 'active', commit: 'idle', cancel: 'idle' },
  },
});
export type TransformModeState = (typeof TransformSessionLifecycle.states)[number];

/** What a session needs from the tab (a subset of B3's `ToolSession`). */
export interface TransformHost {
  readonly ctx: ElementContext & { readonly stage: Pick<Stage, 'read' | 'children' | 'value' | 'lockOf'> };
  readonly target: EditTarget;
  readonly session: Pick<SessionLayer, 'set' | 'clear'>;
  readonly view: Pick<ViewState, 'selection'>;
  readonly actor: () => Actor;
  readonly mode?: TransformMode;
}

export interface TransformMode {
  /** Reactive. */
  readonly state: TransformModeState;
  /** The elements the session transforms (empty when idle). */
  readonly nodes: readonly NodeId[];
  /** Where a running step previews while the session is active (shows nothing when idle). */
  readonly preview: Preview;
  /** Start a session on the selection (IF-TOOL-002 when nothing can move; a no-op when one is active). */
  enter(): Result<ToolOutcome>;
  /** A step finished with these values (already shown in `preview`): they join the session. */
  stage(values: readonly SpatialValues[], label: string): void;
  /** A step was cancelled: show what the session had staged before it. */
  restore(): void;
  /** Commit every staged value as one change set (IF-XF-002 when idle; IF-TOOL-004 when every target vanished). */
  commit(): Result<ToolOutcome>;
  /** Drop the session: nothing is written (IF-XF-002 when idle). */
  cancel(): Result<ToolOutcome>;
}

const NONE: ToolOutcome = Object.freeze({ kind: 'none' });

const unchanged = (a: unknown, b: unknown): boolean => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);
/** The undo label of a session whose steps had different labels. */
export const TRANSFORM_LABEL = 'Transform';

/** One tab's transform session (see the module header). */
export function createTransformMode(host: Omit<TransformHost, 'mode'>, scope?: Scope): TransformMode {
  const machine = createMachine(TransformSessionLifecycle);
  const shown = createPreview(host.session);
  let base: TransformStart | undefined;
  /** The selected set the session started on (locked members included). */
  let entered: readonly NodeId[] = [];
  let staged = new Map<NodeId, SpatialValues>();
  let labels = new Set<string>();

  const reset = (): void => {
    shown.clear();
    base = undefined;
    staged = new Map();
    labels = new Set();
  };
  const preview: Preview = {
    show(start, values) {
      if (machine.is('active')) shown.show(start, values);
    },
    clear() {
      shown.clear();
    },
  };

  const mode: TransformMode = {
    get state() {
      return machine.state;
    },
    get nodes() {
      return base?.elements.map((e) => e.node) ?? [];
    },
    preview,
    enter() {
      if (machine.is('active')) return ok({ kind: 'mode', state: 'active' });
      const start = captureTransform(host.ctx, host.view.selection);
      if (!start.ok) return start;
      base = start.value;
      entered = [...host.view.selection];
      machine.send('enter');
      return ok({ kind: 'mode', state: 'active' });
    },
    stage(values, label) {
      if (!machine.is('active')) return;
      // Only the fields that differ from the base are staged, so restoring the session's previews never hides a
      // value someone else (an agent, a collaborator) changed meanwhile.
      const boxes = new Map(base?.elements.map((e) => [e.node, e.box]));
      for (const v of values) {
        const merged: Record<string, unknown> = { ...staged.get(v.node), ...v };
        const box = boxes.get(v.node) as Readonly<Record<string, unknown>> | undefined;
        for (const key of SPATIAL_VALUE_KEYS) if (box !== undefined && unchanged(box[key], merged[key])) delete merged[key];
        staged.set(v.node, merged as unknown as SpatialValues);
      }
      labels.add(label);
      machine.send('stage');
    },
    restore() {
      shown.clear();
      if (machine.is('active') && base !== undefined) shown.show(base, [...staged.values()]);
    },
    commit() {
      if (!machine.is('active') || base === undefined) return err(TransformModeStateError({ details: { state: machine.state } }));
      const start = base;
      const values = [...staged.values()];
      const label = labels.size === 1 ? ([...labels][0] as string) : TRANSFORM_LABEL;
      reset();
      machine.send('commit');
      const alive = values.filter((v) => host.ctx.stage.read(v.node) !== undefined);
      if (values.length > 0 && alive.length === 0) return err(TargetGoneError({ details: { nodes: values.map((v) => v.node) } }));
      const ops = valuesToOps(start, alive);
      if (ops.length === 0) return ok(NONE);
      const committed = commitEdit(host.target, host.actor(), label, ok(ops));
      return committed.ok ? ok({ kind: 'committed', label, ops: ops.length }) : committed;
    },
    cancel() {
      if (!machine.is('active')) return err(TransformModeStateError({ details: { state: machine.state } }));
      reset();
      machine.send('cancel');
      return ok({ kind: 'cancelled' });
    },
  };

  if (scope !== undefined) {
    // A new selected set (click elsewhere, Tab, an agent) applies the session, like Photoshop picking another layer.
    watch(
      () => host.view.selection,
      (selection) => {
        if (machine.is('active') && (selection.length !== entered.length || selection.some((n) => !entered.includes(n)))) void mode.commit();
      },
      { scope },
    );
    scope.defer(() => {
      if (machine.is('active')) void mode.cancel();
    });
  }
  return mode;
}

/** How a finished transform is applied per session state (rule 4: a table, not a branch on the mode). */
const APPLY: Readonly<Record<TransformModeState, (host: TransformHost, start: TransformStart, values: readonly SpatialValues[], label: string) => Result<ToolOutcome>>> = Object.freeze({
  idle(host, start, values, label) {
    const ops = valuesToOps(start, values);
    if (ops.length === 0) return ok(NONE);
    const committed = commitEdit(host.target, host.actor(), label, ok(ops));
    return committed.ok ? ok({ kind: 'committed', label, ops: ops.length }) : committed;
  },
  active(host, start, values, label) {
    const mode = host.mode as TransformMode;
    mode.preview.show(start, values);
    mode.stage(values, label);
    return ok({ kind: 'staged', label });
  },
});

/**
 * Run a transform on the selection now (keyboard, numeric bar): captured from what is shown (staged values included),
 * then committed as one change set, or staged into the active session.
 */
export function applyTransform(host: TransformHost, label: string, compute: (start: TransformStart) => Result<readonly SpatialValues[]> | readonly SpatialValues[]): Result<ToolOutcome> {
  const start = captureTransform(host.ctx, host.view.selection);
  if (!start.ok) return start;
  const computed = compute(start.value);
  const values = 'ok' in computed ? computed : ok(computed);
  if (!values.ok) return values;
  return APPLY[host.mode?.state ?? 'idle'](host, start.value, values.value, label);
}
