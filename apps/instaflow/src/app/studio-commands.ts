/**
 * Studio's own commands as capabilities (B11b, IF-36.4–36.6): the edits every surface reaches the same way — the HUD
 * pill, the More menu, the context menu, Layers, the keyboard and the command palette (STUDIO-UX-SPEC §4.2.1: an
 * action absent from one is absent from all). Delete, duplicate, lock / unlock, undo and redo; each is one undo step
 * (undo and redo move one). Lit-free: the editor worker implements them over its open tab (`implementStudioCommands`).
 *
 * Their keys (and the B12 structure actions' keys) are one table, `STUDIO_KEY_COMMANDS`: the editor runs them on keys
 * from the input ring while the canvas has focus; main runs the same capability on the selection when the focus is on
 * the chrome (STUDIO §12: "Delete works with focus on chrome"), never while a text field has it.
 */
import { defineShortcut, type KeyCombo, type ShortcutDef } from '@staticflux/a11y';
import { defineCapability, implementCapability, type AnyCapabilityImplementation, type RunContext, s } from '@staticflux/capabilities';
import { err, ok, type Result } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { duplicate } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { ActionNotApplicableError } from '../elements/errors.js';
import { CanvasToolsShortcutScope } from '../tools/keyboard.js';
import type { CanvasTab } from './canvas-tab.js';
import type { StudioDocument } from './document.js';

const nodes = s.array(s.string({ minLength: 1 }), { minItems: 1, maxItems: 10_000 });
const output = s.object({
  ops: s.number({ integer: true, min: 0, description: 'Ops written in the one change set' }),
  select: s.optional(s.array(s.string({ minLength: 1 }), { description: 'Nodes to select afterwards' })),
});

const flags = { output, requiresConfirmation: false, exposeToAgents: true } as const;
export const DeleteCapability = defineCapability({ id: 'instaflow/delete', title: 'Delete', description: 'Delete the elements (one undo step).', input: s.object({ nodes }), destructive: true, ...flags });
export const DuplicateCapability = defineCapability({ id: 'instaflow/duplicate', title: 'Duplicate', description: 'Duplicate the elements 24 px down and right and select the copies (one undo step).', input: s.object({ nodes }), destructive: false, ...flags });
export const LockCapability = defineCapability({
  id: 'instaflow/lock',
  title: 'Lock / unlock',
  description: 'Lock the elements (no handles, clicks pass through, nothing edits them) or unlock them; `locked` omitted toggles.',
  input: s.object({ nodes, locked: s.optional(s.boolean({ description: 'true locks, false unlocks, omitted toggles' })) }),
  destructive: false,
  ...flags,
});
export const UndoCapability = defineCapability({ id: 'instaflow/undo', title: 'Undo', description: 'Undo the last change.', input: s.object({}), destructive: false, ...flags });
export const RedoCapability = defineCapability({ id: 'instaflow/redo', title: 'Redo', description: 'Redo the last undone change.', input: s.object({}), destructive: false, ...flags });

export const STUDIO_COMMAND_CAPABILITIES = Object.freeze([DeleteCapability, DuplicateCapability, LockCapability, UndoCapability, RedoCapability]);

/**
 * Capabilities every element selection can run (besides the element and repeat actions, which check their facts):
 * delete, duplicate, lock, and B3's / B10a's rotate and flip.
 */
export const STUDIO_SELECTION_COMMANDS: readonly string[] = Object.freeze([
  DeleteCapability.id,
  DuplicateCapability.id,
  LockCapability.id,
  'instaflow/rotate-90-cw',
  'instaflow/rotate-90-ccw',
  'instaflow/flip-horizontal',
  'instaflow/flip-vertical',
]);

/** Where a duplicate lands (STUDIO §7: 24, 24). */
export const DUPLICATE_STEP: readonly [number, number] = [24, 24];

export interface StudioCommandEnv {
  readonly tab: () => CanvasTab | undefined;
  readonly document: StudioDocument;
  actorFor(run: RunContext): Result<Actor>;
}

const notApplicable = (needs: string): Result<never> => err(ActionNotApplicableError({ details: { needs } }));

/** Element nodes the edit may touch (no derived repeat instances). */
const editable = (document: StudioDocument, list: readonly string[]): NodeId[] => list.filter((n) => document.view.read(n) !== undefined && !document.view.isDerived(n));

/** Lock ops: `lock.scope` `all` or removed; omitted `locked` toggles (any unlocked → lock all). */
export function lockOps(document: Pick<StudioDocument, 'view'>, list: readonly NodeId[], locked?: boolean): PartOp[] {
  const isLocked = (n: NodeId): boolean => document.view.value(n, P.lockScope) === 'all';
  const want = locked ?? list.some((n) => !isLocked(n));
  return list.filter((n) => isLocked(n) !== want).map((node): PartOp => ({ op: 'set', node, path: P.lockScope, value: want ? 'all' : null }));
}

/** The implementations over the editor's open tab. */
export function implementStudioCommands(env: StudioCommandEnv): readonly AnyCapabilityImplementation[] {
  type Out = { readonly ops: number; readonly select?: readonly string[] };
  const withTab = (run: RunContext, fn: (tab: CanvasTab, actor: Actor) => Result<Out> | Promise<Result<Out>>): Result<Out> | Promise<Result<Out>> => {
    const tab = env.tab();
    if (tab === undefined) return notApplicable('an open page');
    const actor = env.actorFor(run);
    return actor.ok ? fn(tab, actor.value) : actor;
  };
  const commit = (tab: CanvasTab, actor: Actor, label: string, ops: readonly PartOp[], select?: readonly NodeId[]): Result<Out> => {
    if (ops.length === 0) return ok({ ops: 0 });
    const done = env.document.commitOps(tab.page, actor, label, ops);
    return done.ok ? ok({ ops: ops.length, ...(select === undefined ? {} : { select: [...select] }) }) : done;
  };
  return [
    implementCapability(DeleteCapability, (input, run) =>
      withTab(run, (tab, actor) => {
        const list = editable(env.document, input.nodes);
        if (list.length === 0) return notApplicable('an element');
        return commit(tab, actor, list.length === 1 ? 'Delete' : `Delete ${list.length} elements`, list.map((node): PartOp => ({ op: 'delete', node })), []);
      }),
    ),
    implementCapability(DuplicateCapability, (input, run) =>
      withTab(run, (tab, actor) => {
        const list = editable(env.document, input.nodes);
        if (list.length === 0) return notApplicable('an element');
        const copied = duplicate(env.document.context(), list, DUPLICATE_STEP);
        if (!copied.ok) return copied;
        return commit(tab, actor, 'Duplicate', copied.value.ops, list.flatMap((n) => copied.value.copies.get(n) ?? []));
      }),
    ),
    implementCapability(LockCapability, (input, run) =>
      withTab(run, (tab, actor) => {
        const list = editable(env.document, input.nodes);
        if (list.length === 0) return notApplicable('an element');
        const ops = lockOps(env.document, list, input.locked);
        const locking = ops.some((op) => op.op === 'set' && op.value === 'all');
        return commit(tab, actor, locking ? 'Lock' : 'Unlock', ops);
      }),
    ),
    implementCapability(UndoCapability, (_input, run) =>
      withTab(run, async (tab) => {
        const r = await tab.undo();
        return r.ok ? ok({ ops: 0 }) : r;
      }),
    ),
    implementCapability(RedoCapability, (_input, run) =>
      withTab(run, async (tab) => {
        const r = await tab.redo();
        return r.ok ? ok({ ops: 0 }) : r;
      }),
    ),
  ];
}

/** One key command: its shortcut (cheat sheet group, description) and the capability it runs on the selection. */
export interface KeyCommand {
  readonly def: ShortcutDef;
  readonly capability: `instaflow/${string}`;
  /** Cheat sheet card (STUDIO §2.3.1). */
  readonly group: 'Edit' | 'Arrange';
  /** Runs with nothing selected (undo, redo). */
  readonly empty?: boolean;
}

const key = (id: `instaflow/${string}`, keys: readonly KeyCombo[], description: string, capability: `instaflow/${string}`, group: KeyCommand['group'], empty = false): KeyCommand => ({
  def: defineShortcut({ id, keys, scope: CanvasToolsShortcutScope, description, allowInInputs: false }),
  capability,
  group,
  ...(empty ? { empty: true } : {}),
});

/**
 * Keys that run a capability on the selection (STUDIO-UX-SPEC §7). Undo, redo, delete and duplicate keep the ids B8
 * gave them (`canvas-shortcuts.ts` re-exports these definitions).
 */
export const STUDIO_KEY_COMMANDS: readonly KeyCommand[] = Object.freeze([
  key('instaflow/undo', ['Mod+Z'], 'Undo', UndoCapability.id, 'Edit', true),
  key('instaflow/redo', ['Mod+Shift+Z', 'Ctrl+Y'], 'Redo', RedoCapability.id, 'Edit', true),
  key('instaflow/delete', ['Delete', 'Backspace'], 'Delete the selection', DeleteCapability.id, 'Edit'),
  key('instaflow/duplicate', ['Mod+D'], 'Duplicate the selection', DuplicateCapability.id, 'Edit'),
  key('instaflow/group-key', ['Mod+G'], 'Group', 'instaflow/group', 'Arrange'),
  key('instaflow/ungroup-key', ['Mod+Shift+G'], 'Ungroup', 'instaflow/ungroup', 'Arrange'),
  key('instaflow/frame-selection-key', ['Mod+Alt+G'], 'Frame selection', 'instaflow/frame-selection', 'Arrange'),
  key('instaflow/bring-forward-key', ['Mod+]'], 'Bring forward', 'instaflow/bring-forward', 'Arrange'),
  key('instaflow/send-backward-key', ['Mod+['], 'Send backward', 'instaflow/send-backward', 'Arrange'),
  key('instaflow/bring-to-front-key', ['Mod+Alt+]'], 'Bring to front', 'instaflow/bring-to-front', 'Arrange'),
  key('instaflow/send-to-back-key', ['Mod+Alt+['], 'Send to back', 'instaflow/send-to-back', 'Arrange'),
  key('instaflow/lock-key', ['Mod+Shift+L'], 'Lock or unlock', LockCapability.id, 'Edit'),
  key('instaflow/hide-key', ['Mod+Shift+H'], 'Hide or show', 'instaflow/hide', 'Edit'),
]);
