/**
 * The Fill / Stroke / Effects inspector, headless (IF-20.23–20.24): the model the panel renders and the edits it sends
 * back. The panel (`panel.ts`) is a view over `AppearanceModel`; every change is an `AppearanceEdit` turned into part
 * ops by `appearanceEditOps` and committed as one undo step (`commitEdit`), so the panel needs no document access and
 * the same edits are available to keyboard paths, agents and tests.
 *
 * Stacks are shown top first (like layer lists) but stored bottom first; indices in edits are **storage** indices.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp, PropertyPath } from '@staticflux/document/v2';
import type { Stage } from '@staticflux/stage';
import { BLEND_MODE_NAMES, type BlendModeName, CORNER_PATHS, P } from './components.js';
import { type BrandKitView, tokenType } from './brand-kit.js';
import { ActionNotApplicableError } from './errors.js';
import { styleSource } from './styles.js';
import { checkElementValue, colorToRgba, type EffectValue, type FillValue, rgbaToHex, type StrokeValue, tokenName } from './values.js';

export type StackName = 'fills' | 'strokes' | 'effects';
const STACK_PATHS: Readonly<Record<StackName, PropertyPath>> = { fills: P.fills, strokes: P.strokes, effects: P.effects };

export interface ValueSource {
  /** `local` (set here), `inherit` (from a class), `variant`, `reference`, or `default`. */
  readonly arc: string;
  /** The brand token the value comes from, if any. */
  readonly token?: string;
}

export interface AppearanceModel {
  readonly node: NodeId;
  readonly fills: readonly FillValue[];
  readonly strokes: readonly StrokeValue[];
  /** Effects as items (a `@preset` list shows as its token in `effectsPreset`). */
  readonly effects: readonly (EffectValue | string)[];
  readonly effectsPreset?: string;
  readonly opacity: number;
  readonly blend: BlendModeName;
  readonly radius: JsonValue;
  readonly corners: readonly JsonValue[];
  /** One radius for every corner (no per-corner opinion): the link toggle is on. */
  readonly cornersLinked: boolean;
  readonly smoothing: number;
  readonly sources: Readonly<Record<'fills' | 'strokes' | 'effects' | 'radius', ValueSource>>;
  /** Brand tokens by type, for pickers. */
  readonly tokens: { readonly colors: readonly string[]; readonly sizes: readonly string[]; readonly effects: readonly string[] };
}

const asList = <T>(v: JsonValue | undefined): T[] => (Array.isArray(v) ? (v as unknown as T[]) : []);

/** The panel model of one element (raw opinions as written, tokens kept). */
export function appearanceModel(stage: Pick<Stage, 'read' | 'explain'>, node: NodeId, kit?: BrandKitView): AppearanceModel | undefined {
  const composed = stage.read(node);
  if (composed === undefined) return undefined;
  const raw = (path: PropertyPath): JsonValue | undefined => {
    const winner = stage.explain(node, path).winner;
    if (winner === undefined) return undefined;
    return winner.token !== undefined ? `@${winner.token.path.slice(`${P.tokens}.`.length)}` : winner.value;
  };
  const source = (path: PropertyPath): ValueSource => {
    const s = styleSource(stage, node, path);
    return { arc: s.arc, ...(s.token === undefined ? {} : { token: s.token }) };
  };
  const effects = raw(P.effects);
  const tokens = { colors: [] as string[], sizes: [] as string[], effects: [] as string[] };
  for (const [name, value] of kit?.tokens() ?? []) {
    const resolved = kit?.token(name) ?? value;
    const type = tokenType(resolved);
    if (type === 'color') tokens.colors.push(`@${name}`);
    else if (type === 'size') tokens.sizes.push(`@${name}`);
    else if (type === 'effect') tokens.effects.push(`@${name}`);
  }
  for (const list of Object.values(tokens)) list.sort();
  const opacity = composed.values[P.opacity];
  const blend = composed.values[P.blend];
  const smoothing = composed.values[P.smoothing];
  return {
    node,
    fills: asList<FillValue>(raw(P.fills)),
    strokes: asList<StrokeValue>(raw(P.strokes)),
    effects: typeof effects === 'string' ? [] : asList<EffectValue | string>(effects),
    ...(typeof effects === 'string' ? { effectsPreset: effects } : {}),
    opacity: typeof opacity === 'number' ? opacity : 1,
    blend: typeof blend === 'string' && (BLEND_MODE_NAMES as readonly string[]).includes(blend) ? (blend as BlendModeName) : 'normal',
    radius: raw(P.radius) ?? 0,
    corners: CORNER_PATHS.map((p) => raw(p) ?? null),
    cornersLinked: CORNER_PATHS.every((p) => raw(p) === undefined),
    smoothing: typeof smoothing === 'number' ? smoothing : 0,
    sources: { fills: source(P.fills), strokes: source(P.strokes), effects: source(P.effects), radius: source(P.radius) },
    tokens,
  };
}

export type AppearanceEdit =
  | { readonly op: 'add'; readonly stack: StackName; readonly item: FillValue | StrokeValue | EffectValue | string }
  | { readonly op: 'remove'; readonly stack: StackName; readonly index: number }
  | { readonly op: 'move'; readonly stack: StackName; readonly from: number; readonly to: number }
  | { readonly op: 'toggle'; readonly stack: StackName; readonly index: number }
  | { readonly op: 'update'; readonly stack: StackName; readonly index: number; readonly patch: Readonly<Record<string, JsonValue>> }
  | { readonly op: 'set'; readonly path: PropertyPath; readonly value: JsonValue }
  /** The corner link toggle: linked drops per-corner values; unlinked copies the shared radius to each corner. */
  | { readonly op: 'link-corners'; readonly linked: boolean };

/** Default items the "+" buttons add. */
export const NEW_ITEMS = {
  fills: { paint: '#d9dee5' } satisfies FillValue,
  strokes: { paint: '#16151a', width: 1, align: 'inside' } satisfies StrokeValue,
  effects: { kind: 'drop-shadow', x: 0, y: 4, blur: 12, spread: 0, color: '#16151a33' } satisfies EffectValue,
} as const;

/** Part ops for one panel edit (validated; one change set). */
export function appearanceEditOps(model: AppearanceModel, edit: AppearanceEdit): Result<PartOp[]> {
  const node = model.node;
  if (edit.op === 'set') {
    const checked = checkElementValue(edit.path, edit.value);
    return checked.ok ? ok([{ op: 'set', node, path: edit.path, value: edit.value }]) : checked;
  }
  if (edit.op === 'link-corners') {
    return ok(CORNER_PATHS.map((path, i) => ({ op: 'set', node, path, value: edit.linked ? null : (model.corners[i] ?? model.radius) })));
  }
  const current: JsonValue[] = [...(model[edit.stack] as unknown as JsonValue[])];
  const bad = (index: number): Result<never> => err(ActionNotApplicableError({ message: `No ${edit.stack} item ${index}.`, details: { needs: 'an existing item', index } }));
  switch (edit.op) {
    case 'add':
      current.push(edit.item as unknown as JsonValue);
      break;
    case 'remove':
      if (current[edit.index] === undefined) return bad(edit.index);
      current.splice(edit.index, 1);
      break;
    case 'move': {
      if (current[edit.from] === undefined || edit.to < 0 || edit.to >= current.length) return bad(edit.from);
      const [item] = current.splice(edit.from, 1);
      current.splice(edit.to, 0, item as JsonValue);
      break;
    }
    case 'toggle':
    case 'update': {
      const item = current[edit.index];
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return bad(edit.index);
      const o = item as Record<string, JsonValue>;
      current[edit.index] = edit.op === 'toggle' ? { ...o, visible: o['visible'] === false } : { ...o, ...edit.patch };
      break;
    }
  }
  const path = STACK_PATHS[edit.stack];
  const checked = checkElementValue(path, current);
  return checked.ok ? ok([{ op: 'set', node, path, value: current }]) : checked;
}

/** A paint's swatch colour for the panel (`#rrggbb[aa]`; tokens resolved through the kit; gradients use their first stop). */
export function swatchOf(paint: JsonValue | undefined, kit?: BrandKitView): string | undefined {
  if (typeof paint === 'string') {
    const name = tokenName(paint);
    const value = name === undefined ? paint : kit?.token(name);
    const rgba = typeof value === 'string' ? colorToRgba(value) : undefined;
    return rgba === undefined ? undefined : rgbaToHex(rgba);
  }
  if (typeof paint === 'object' && paint !== null && !Array.isArray(paint)) {
    const stops = (paint as Record<string, JsonValue>)['stops'];
    if (Array.isArray(stops) && typeof stops[0] === 'object' && stops[0] !== null && !Array.isArray(stops[0])) return swatchOf((stops[0] as Record<string, JsonValue>)['color'], kit);
  }
  return undefined;
}
