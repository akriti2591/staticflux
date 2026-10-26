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
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { duplicate } from '../elements/actions.js';
import { CORNER_PATHS, P } from '../elements/components.js';
import { readTextBlock } from '../text/rich-text.js';
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

/** B11b slice 4 (APPEARANCE §2.9, STUDIO §9): style clipboard, Select same, opacity steps. */
export const STYLE_PARTS = ['fill', 'stroke', 'effects', 'corners', 'layer'] as const;
export type StylePart = (typeof STYLE_PARTS)[number];
export const SELECT_SAME_BY = ['fill', 'stroke', 'effects', 'font', 'kind'] as const;
export type SelectSameBy = (typeof SELECT_SAME_BY)[number];
export const CopyStyleCapability = defineCapability({
  id: 'instaflow/copy-style',
  title: 'Copy style',
  description: 'Remember the first element’s appearance (fills, strokes, effects, corners, opacity and blend) for Paste style; writes nothing.',
  input: s.object({ nodes }),
  destructive: false,
  ...flags,
});
export const PasteStyleCapability = defineCapability({
  id: 'instaflow/paste-style',
  title: 'Paste style',
  description: 'Apply the copied appearance to every element (one undo step); `only` limits it to fill, stroke, effects, corners or layer.',
  input: s.object({ nodes, only: s.optional(s.enum(STYLE_PARTS)) }),
  destructive: false,
  ...flags,
});
export const SelectSameCapability = defineCapability({
  id: 'instaflow/select-same',
  title: 'Select same',
  description: 'Select every element on the page with the same top fill, top stroke, effects, font or kind as the first element.',
  input: s.object({ nodes, by: s.enum(SELECT_SAME_BY) }),
  destructive: false,
  ...flags,
});
export const OpacityStepCapability = defineCapability({
  id: 'instaflow/opacity-step',
  title: 'Change opacity',
  description: 'Add `delta` (−1…1) to every element’s layer opacity, clamped to 0…1 (one undo step).',
  input: s.object({ nodes, delta: s.number({ min: -1, max: 1 }) }),
  destructive: false,
  ...flags,
});

export const STUDIO_COMMAND_CAPABILITIES = Object.freeze([
  DeleteCapability,
  DuplicateCapability,
  LockCapability,
  UndoCapability,
  RedoCapability,
  CopyStyleCapability,
  PasteStyleCapability,
  SelectSameCapability,
  OpacityStepCapability,
]);

/** The paths each style part copies (corners only reach elements with corners). */
export const STYLE_PATHS: Readonly<Record<StylePart, readonly string[]>> = Object.freeze({
  fill: [P.fills],
  stroke: [P.strokes],
  effects: [P.effects],
  corners: [P.radius, ...CORNER_PATHS, P.smoothing],
  layer: [P.opacity, P.blend],
});

/**
 * Capabilities every element selection can run (besides the element and repeat actions, which check their facts):
 * delete, duplicate, lock, and B3's / B10a's rotate and flip.
 */
export const STUDIO_SELECTION_COMMANDS: readonly string[] = Object.freeze([
  DeleteCapability.id,
  DuplicateCapability.id,
  LockCapability.id,
  CopyStyleCapability.id,
  PasteStyleCapability.id,
  SelectSameCapability.id,
  OpacityStepCapability.id,
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

/** Elements that have corners (rectangles, frames, images). */
function hasCorners(document: StudioDocument, node: NodeId): boolean {
  const kind = document.base.read(node)?.kind;
  if (kind === 'frame' || kind === 'image') return true;
  return kind === 'shape' && (document.base.value(node, P.shape) ?? 'rect') === 'rect';
}

/** The comparison key of Select same (resolved values as written; text: the first run's font). */
function sameKey(document: StudioDocument, page: NodeId, node: NodeId, by: SelectSameBy): string {
  const v = (path: string): string => JSON.stringify(document.base.value(node, path) ?? null);
  const top = (path: string): string => {
    const raw = document.base.value(node, path);
    const list = Array.isArray(raw) ? raw.filter((x) => typeof x === 'object' && x !== null && !Array.isArray(x) && (x as Record<string, JsonValue>)['visible'] !== false) : [];
    const item = list.at(-1) as Record<string, JsonValue> | undefined;
    return JSON.stringify(item?.['paint'] ?? null);
  };
  const kind = document.base.read(node)?.kind ?? '';
  switch (by) {
    case 'fill':
      return top(P.fills);
    case 'stroke':
      return top(P.strokes);
    case 'effects':
      return v(P.effects);
    case 'kind':
      return kind === 'shape' ? `shape:${String(document.base.value(node, P.shape) ?? 'rect')}` : kind;
    case 'font': {
      if (kind !== 'text') return 'not-text';
      const part = document.part(page);
      const block = part === undefined ? undefined : readTextBlock(part, node);
      return JSON.stringify(block?.ok === true ? (block.value.paragraphs[0]?.runs[0]?.style.font ?? null) : null);
    }
  }
}

/** The implementations over the editor's open tab. */
export function implementStudioCommands(env: StudioCommandEnv): readonly AnyCapabilityImplementation[] {
  type Out = { readonly ops: number; readonly select?: readonly string[] };
  /** Copy style's memory (per editor: the style clipboard is not the system clipboard). */
  let copiedStyle: { readonly node: NodeId; readonly values: Readonly<Record<string, JsonValue | undefined>> } | undefined;
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
        // The base stage: copies are of document nodes (a repeat's instances are derived again from the copy).
        const copied = duplicate({ ...env.document.context(), stage: env.document.base }, list, DUPLICATE_STEP);
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
    implementCapability(CopyStyleCapability, (input, run) =>
      withTab(run, () => {
        const first = editable(env.document, input.nodes)[0];
        if (first === undefined) return notApplicable('an element');
        const style: Record<string, JsonValue | undefined> = {};
        for (const paths of Object.values(STYLE_PATHS)) for (const path of paths) style[path] = env.document.base.value(first, path);
        copiedStyle = { node: first, values: style };
        return ok({ ops: 0 });
      }),
    ),
    implementCapability(PasteStyleCapability, (input, run) =>
      withTab(run, (tab, actor) => {
        const style = copiedStyle;
        if (style === undefined) return notApplicable('a copied style (Copy style first)');
        const list = editable(env.document, input.nodes).filter((n) => n !== style.node);
        if (list.length === 0) return notApplicable('an element');
        const parts: readonly StylePart[] = input.only === undefined ? STYLE_PARTS : [input.only];
        const ops: PartOp[] = [];
        for (const node of list) {
          const corners = hasCorners(env.document, node);
          for (const part of parts) {
            if (part === 'corners' && !corners) continue;
            for (const path of STYLE_PATHS[part]) {
              const value = style.values[path] ?? null;
              if (JSON.stringify(env.document.base.value(node, path) ?? null) !== JSON.stringify(value)) ops.push({ op: 'set', node, path, value });
            }
          }
        }
        return commit(tab, actor, 'Paste style', ops);
      }),
    ),
    implementCapability(SelectSameCapability, (input, run) =>
      withTab(run, (tab) => {
        const first = editable(env.document, input.nodes)[0];
        if (first === undefined) return notApplicable('an element');
        const key = (n: NodeId): string => sameKey(env.document, tab.page, n, input.by);
        const want = key(first);
        const all: NodeId[] = [];
        const walk = (parent: NodeId): void => {
          for (const child of env.document.base.children(parent)) {
            all.push(child);
            walk(child);
          }
        };
        walk(tab.page);
        return ok({ ops: 0, select: all.filter((n) => env.document.base.read(n) !== undefined && key(n) === want) });
      }),
    ),
    implementCapability(OpacityStepCapability, (input, run) =>
      withTab(run, (tab, actor) => {
        const list = editable(env.document, input.nodes);
        if (list.length === 0) return notApplicable('an element');
        const ops = list.flatMap((node): PartOp[] => {
          const now = env.document.base.value(node, P.opacity);
          const current = typeof now === 'number' ? now : 1;
          const next = Math.round(Math.max(0, Math.min(1, current + input.delta)) * 100) / 100;
          return next === current ? [] : [{ op: 'set', node, path: P.opacity, value: next }];
        });
        return commit(tab, actor, 'Opacity', ops);
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
  readonly group: 'Edit' | 'Arrange' | 'Style';
  /** Runs with nothing selected (undo, redo). */
  readonly empty?: boolean;
  /** Extra input for the selection (B11b: an align key on one element aligns it to the page). */
  readonly extra?: (count: number) => Readonly<Record<string, JsonValue>>;
}

const key = (
  id: `instaflow/${string}`,
  keys: readonly KeyCombo[],
  description: string,
  capability: `instaflow/${string}`,
  group: KeyCommand['group'],
  empty = false,
  extra?: KeyCommand['extra'],
): KeyCommand => ({
  def: defineShortcut({ id, keys, scope: CanvasToolsShortcutScope, description, allowInInputs: false }),
  capability,
  group,
  ...(empty ? { empty: true } : {}),
  ...(extra === undefined ? {} : { extra }),
});

/** One element aligns to the page, several to their selection (STUDIO §4.2.7). */
const alignTarget = (count: number): Readonly<Record<string, JsonValue>> => (count === 1 ? { target: 'page' } : {});

/** The input a key command sends for `nodes` (the selection, plus the command's extra). */
export function keyCommandInput(command: KeyCommand, nodes: readonly string[]): Readonly<Record<string, unknown>> {
  return { ...(nodes.length === 0 ? {} : { nodes: [...nodes] }), ...(command.extra?.(nodes.length) ?? {}) };
}

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
  // B11b slice 4 (STUDIO §7): style, structure and alignment keys.
  key('instaflow/copy-style-key', ['Mod+Alt+C'], 'Copy style', CopyStyleCapability.id, 'Style'),
  key('instaflow/paste-style-key', ['Mod+Alt+V'], 'Paste style', PasteStyleCapability.id, 'Style'),
  key('instaflow/opacity-up-key', ['Alt+Shift+ArrowUp'], 'Opacity +10 %', OpacityStepCapability.id, 'Style', false, () => ({ delta: 0.1 })),
  key('instaflow/opacity-down-key', ['Alt+Shift+ArrowDown'], 'Opacity −10 %', OpacityStepCapability.id, 'Style', false, () => ({ delta: -0.1 })),
  key('instaflow/flatten-key', ['Mod+E'], 'Flatten', 'instaflow/flatten', 'Arrange'),
  key('instaflow/outline-stroke-key', ['Mod+Shift+O'], 'Outline stroke', 'instaflow/outline-stroke', 'Arrange'),
  key('instaflow/align-left-key', ['Alt+A'], 'Align left', 'instaflow/align-left', 'Arrange', false, alignTarget),
  key('instaflow/align-center-x-key', ['Alt+H'], 'Align horizontal centres', 'instaflow/align-center-x', 'Arrange', false, alignTarget),
  key('instaflow/align-right-key', ['Alt+D'], 'Align right', 'instaflow/align-right', 'Arrange', false, alignTarget),
  key('instaflow/align-top-key', ['Alt+W'], 'Align top', 'instaflow/align-top', 'Arrange', false, alignTarget),
  key('instaflow/align-center-y-key', ['Alt+V'], 'Align vertical centres', 'instaflow/align-center-y', 'Arrange', false, alignTarget),
  key('instaflow/align-bottom-key', ['Alt+S'], 'Align bottom', 'instaflow/align-bottom', 'Arrange', false, alignTarget),
  key('instaflow/distribute-h-key', ['Ctrl+Alt+Shift+H'], 'Distribute horizontal spacing', 'instaflow/distribute-h-spacing', 'Arrange'),
  key('instaflow/distribute-v-key', ['Ctrl+Alt+Shift+V'], 'Distribute vertical spacing', 'instaflow/distribute-v-spacing', 'Arrange'),
  key('instaflow/tidy-up-key', ['Ctrl+Alt+Shift+T'], 'Tidy up', 'instaflow/tidy-up', 'Arrange'),
]);
