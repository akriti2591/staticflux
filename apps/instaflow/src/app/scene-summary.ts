/**
 * What Studio's chrome reads about the open page (B11b, IF-36.1–36.3): the **layers tree** (Layers panel, the inspector
 * header, the canvas name labels) and the **selection summary** (the selection kind that picks the HUD pill's and the
 * inspector's control set, STUDIO-UX-SPEC §4.2.4 and §5.1, plus the values the pill shows). Pure functions over the
 * editor's stage, Lit-free and DOM-free: the editor module serves them through `SceneMirror` (`../workers/mirrors.ts`).
 *
 * Kinds (data, rule 4: the chrome looks the control set up by kind, never branches on it):
 * `none` · `shape` · `text` · `image` · `frame` · `group` · `multi` (same kind) · `mixed` · `locked` (every selected
 * element locked) · `repeat` (a live repeat source) · `boolean` (a live boolean group) · `mask` (a mask group).
 */
import type { JsonValue, NodeId } from '@staticflux/document/v2';
import type { BrandKitView } from '../elements/brand-kit.js';
import { P, type ShapeName } from '../elements/components.js';
import { isElement } from '../elements/layout.js';
import { colorToRgba, rgbaToHex, tokenName } from '../elements/values.js';
import { TEXT_KIND } from '../text/model.js';

export const SELECTION_KINDS = ['none', 'shape', 'text', 'image', 'frame', 'group', 'multi', 'mixed', 'locked', 'repeat', 'boolean', 'mask'] as const;
export type SelectionKind = (typeof SELECTION_KINDS)[number];

/** Layer kinds as Layers shows them (the icon table in `../theme/icons.ts` has the same names). */
export type LayerKindName = 'frame' | 'group' | 'rectangle' | 'ellipse' | 'polygon' | 'star' | 'line' | 'path' | 'image' | 'text' | 'repeat' | 'boolean' | 'mask';

export interface LayerRow {
  readonly id: NodeId;
  /** The element's name, or a name from its kind or text (`Rectangle`, the first words of a text). */
  readonly name: string;
  readonly kind: LayerKindName;
  readonly hidden: boolean;
  readonly locked: boolean;
  /** Mono tag (a repeat's `Radial · 8`, a token). */
  readonly meta?: string;
  /** Children, top-most first (paint order reversed, Figma). */
  readonly children: readonly LayerRow[];
}

export interface PageSummary {
  readonly id: NodeId;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** A paint as the pill's swatch shows it. */
export interface PaintSummary {
  readonly kind: 'none' | 'solid' | 'gradient' | 'image' | 'mixed';
  /** Resolved `#rrggbb[aa]` (solids; a gradient's first stop). */
  readonly color?: string;
  /** The brand token it is bound to (`@primary`). */
  readonly token?: string;
  /** A token that does not resolve (hatched swatch). */
  readonly unresolved?: boolean;
}

export interface SelectionSummary {
  readonly kind: SelectionKind;
  readonly nodes: readonly NodeId[];
  /** Inspector header: the first element's name, or `3 selected`. */
  readonly label: string;
  /** Inspector header tag: `Rectangle`, `Text`, `3 selected`. */
  readonly typeLabel: string;
  /** Every selected element is locked. */
  readonly locked: boolean;
  /** Some selected element is locked. */
  readonly anyLocked: boolean;
  /** Every selected element is hidden. */
  readonly hidden: boolean;
  /** The kind every element shares (`multi`), or the single element's kind. */
  readonly common?: LayerKindName;
  readonly fill?: PaintSummary;
  readonly stroke?: PaintSummary & { readonly width?: number | 'mixed' };
  /** Linked radius (rects, frames, images). */
  readonly radius?: number | 'mixed';
  /** Polygon sides / star points. */
  readonly points?: number;
  /** Image elements: the top image fill's fit and asset (B12 A-3 crop state). */
  readonly fit?: string;
  readonly asset?: string;
  readonly cropped?: boolean;
  /** The picture inside the image (B12 A-3): offset 0…1 of the free space, scale × the fit, quarter turns. */
  readonly crop?: { readonly x: number; readonly y: number; readonly scale: number; readonly rotation: number };
  readonly clip?: boolean;
  /** Layer opacity (0…1) and blend of every selected element (mixed when they differ). */
  readonly opacity?: number | 'mixed';
  readonly blend?: string | 'mixed';
  readonly booleanOp?: string;
  readonly mask?: { readonly node: NodeId; readonly mode: string; readonly invert: boolean };
  readonly repeat?: { readonly kind: string; readonly count: number };
  /** Capability ids the selection can run (the More menu and the context menu list only these, STUDIO §4.2.3). */
  readonly actions: readonly string[];
}

export const EMPTY_SELECTION: SelectionSummary = Object.freeze({ kind: 'none', nodes: [], label: '', typeLabel: '', locked: false, anyLocked: false, hidden: false, actions: [] });

/** What the summaries read (the editor's repeat view stage and the brand kit). */
export interface SceneReader {
  readonly stage: {
    read(node: NodeId): { readonly kind: string; readonly parent: NodeId | null } | undefined;
    value(node: NodeId, path: string): JsonValue | undefined;
    children(parent: NodeId | null): readonly NodeId[];
    isDerived(node: NodeId): boolean;
    lockOf(node: NodeId): { readonly position: boolean; readonly content: boolean };
    explain(node: NodeId, path: string): { readonly winner?: unknown };
  };
  readonly kit: BrandKitView;
  /** A text element's plain text (for its default name). */
  text(node: NodeId): string | undefined;
  /** A live repeat's kind and instance count (undefined: not a repeat source). */
  repeat(node: NodeId): { readonly kind: string; readonly count: number } | undefined;
  /** Capability ids that apply to these nodes. */
  applicable(nodes: readonly NodeId[]): readonly string[];
}

const SHAPE_KINDS: Readonly<Record<ShapeName, LayerKindName>> = { rect: 'rectangle', ellipse: 'ellipse', polygon: 'polygon', star: 'star', line: 'line' };

/** Default names per layer kind (UI text, sentence case). */
export const LAYER_KIND_NAMES: Readonly<Record<LayerKindName, string>> = Object.freeze({
  frame: 'Frame',
  group: 'Group',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  polygon: 'Polygon',
  star: 'Star',
  line: 'Line',
  path: 'Path',
  image: 'Image',
  text: 'Text',
  repeat: 'Repeat',
  boolean: 'Boolean',
  mask: 'Mask group',
});

const REPEAT_LABELS: Readonly<Record<string, string>> = { radial: 'Radial', grid: 'Grid', mirror: 'Mirror' };

const isMaskGroup = (r: SceneReader, node: NodeId): boolean => {
  if (r.stage.read(node)?.kind !== 'group') return false;
  const first = r.stage.children(node)[0];
  return first !== undefined && typeof r.stage.value(first, P.maskMode) === 'string';
};

/** The layer kind of one node (undefined: not an element). */
export function layerKindOf(r: SceneReader, node: NodeId): LayerKindName | undefined {
  const kind = r.stage.read(node)?.kind;
  if (kind === TEXT_KIND) return 'text';
  if (!isElement(kind)) return undefined;
  if (r.repeat(node) !== undefined) return 'repeat';
  switch (kind) {
    case 'frame':
      return 'frame';
    case 'image':
      return 'image';
    case 'vector':
      return 'path';
    case 'group':
      if (typeof r.stage.value(node, P.boolean) === 'string') return 'boolean';
      return isMaskGroup(r, node) ? 'mask' : 'group';
    case 'shape': {
      const shape = r.stage.value(node, P.shape);
      return SHAPE_KINDS[(typeof shape === 'string' ? shape : 'rect') as ShapeName] ?? 'rectangle';
    }
    default:
      return undefined;
  }
}

const isLocked = (r: SceneReader, node: NodeId): boolean => {
  const lock = r.stage.lockOf(node);
  return lock.position && lock.content;
};

/** A node's display name (its own name, else its text's first words, else its kind's name). */
export function displayName(r: SceneReader, node: NodeId, kind: LayerKindName): string {
  const own = r.stage.value(node, 'name');
  if (typeof own === 'string' && own.trim() !== '') return own.trim();
  if (kind === 'text') {
    const text = r.text(node)?.replace(/\s+/g, ' ').trim();
    if (text !== undefined && text !== '') return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  }
  return LAYER_KIND_NAMES[kind];
}

/** The page's layers, top-most first (derived repeat instances are not rows). */
export function layerTree(r: SceneReader, page: NodeId): readonly LayerRow[] {
  const rows = (parent: NodeId): LayerRow[] =>
    r.stage
      .children(parent)
      .filter((n) => !r.stage.isDerived(n))
      .flatMap((node): LayerRow[] => {
        const kind = layerKindOf(r, node);
        if (kind === undefined) return [];
        const repeat = r.repeat(node);
        const children = kind === 'frame' || kind === 'group' || kind === 'boolean' || kind === 'mask' ? rows(node) : [];
        return [
          {
            id: node,
            name: displayName(r, node, kind),
            kind,
            hidden: r.stage.value(node, P.hidden) === true,
            locked: isLocked(r, node),
            ...(repeat === undefined ? {} : { meta: `${REPEAT_LABELS[repeat.kind] ?? repeat.kind} · ${repeat.count}` }),
            children,
          },
        ];
      })
      .reverse();
  return rows(page);
}

/** The colours used on the page (fills and strokes, resolved), most used first (the colour popover's Document row). */
export function documentColors(r: SceneReader, page: NodeId): readonly { readonly hex: string; readonly uses: number }[] {
  const uses = new Map<string, number>();
  const walk = (parent: NodeId): void => {
    for (const node of r.stage.children(parent)) {
      if (r.stage.isDerived(node)) continue;
      for (const path of [P.fills, P.strokes]) {
        const raw = r.stage.value(node, path);
        if (!Array.isArray(raw)) continue;
        for (const item of raw) {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
          const color = paintSummary((item as Record<string, JsonValue>)['paint'], r.kit).color;
          if (color !== undefined) uses.set(color.toUpperCase(), (uses.get(color.toUpperCase()) ?? 0) + 1);
        }
      }
      walk(node);
    }
  };
  walk(page);
  return [...uses].map(([hex, n]) => ({ hex, uses: n })).sort((a, b) => b.uses - a.uses).slice(0, 12);
}

/** A paint value (`style.fills` item's `paint`) as a swatch summary. */
export function paintSummary(paint: JsonValue | undefined, kit: BrandKitView): PaintSummary {
  if (paint === undefined || paint === null) return { kind: 'none' };
  if (typeof paint === 'string') {
    const token = tokenName(paint);
    const value = token === undefined ? paint : kit.token(token);
    const rgba = typeof value === 'string' ? colorToRgba(value) : undefined;
    return { kind: 'solid', ...(rgba === undefined ? {} : { color: rgbaToHex(rgba) }), ...(token === undefined ? {} : { token: `@${token}` }), ...(token !== undefined && rgba === undefined ? { unresolved: true } : {}) };
  }
  if (typeof paint === 'object' && !Array.isArray(paint)) {
    const o = paint as Record<string, JsonValue>;
    if (o['kind'] === 'image') return { kind: 'image' };
    const stops = o['stops'];
    const first = Array.isArray(stops) ? (stops[0] as Record<string, JsonValue> | undefined) : undefined;
    const color = first === undefined ? undefined : paintSummary(first['color'], kit).color;
    return { kind: 'gradient', ...(color === undefined ? {} : { color }) };
  }
  return { kind: 'none' };
}

/** The top visible image paint of an element's fills (an image element's picture). */
function imagePaintOf(r: SceneReader, node: NodeId): Record<string, JsonValue> | undefined {
  const raw = r.stage.value(node, P.fills);
  if (!Array.isArray(raw)) return undefined;
  for (let i = raw.length - 1; i >= 0; i--) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item) || (item as Record<string, JsonValue>)['visible'] === false) continue;
    const paint = (item as Record<string, JsonValue>)['paint'];
    if (typeof paint === 'object' && paint !== null && !Array.isArray(paint) && (paint as Record<string, JsonValue>)['kind'] === 'image') return paint as Record<string, JsonValue>;
  }
  return undefined;
}

const cropOf = (paint: Record<string, JsonValue> | undefined): { x: number; y: number; scale: number; rotation: number } => {
  const offset = paint?.['offset'];
  const pair = Array.isArray(offset) && typeof offset[0] === 'number' && typeof offset[1] === 'number' ? [offset[0], offset[1]] : [0.5, 0.5];
  const scale = paint?.['scale'];
  const rotation = paint?.['rotation'];
  return { x: pair[0] as number, y: pair[1] as number, scale: typeof scale === 'number' ? scale : 1, rotation: typeof rotation === 'number' ? rotation : 0 };
};

const assetOf = (paint: Record<string, JsonValue> | undefined): string | undefined => {
  const a = paint?.['asset'];
  return typeof a === 'object' && a !== null && !Array.isArray(a) && typeof (a as Record<string, JsonValue>)['asset'] === 'string' ? ((a as Record<string, JsonValue>)['asset'] as string) : undefined;
};

/** Opacity and blend shared by the nodes (`mixed` when they differ). */
function layerValues(r: SceneReader, nodes: readonly NodeId[]): { opacity?: number | 'mixed'; blend?: string | 'mixed' } {
  const opacity = same(nodes.map((n) => r.stage.value(n, P.opacity)).map((v) => (typeof v === 'number' ? v : 1)));
  const blend = same(nodes.map((n) => r.stage.value(n, P.blend)).map((v) => (typeof v === 'string' ? v : 'normal')));
  return { ...(opacity === undefined ? {} : { opacity }), ...(blend === undefined ? {} : { blend }) };
}

/** The top visible item of a stack (`style.fills` / `style.strokes`) as written. */
function topItem(r: SceneReader, node: NodeId, path: string): Record<string, JsonValue> | undefined {
  const raw = r.stage.value(node, path);
  if (!Array.isArray(raw)) return undefined;
  for (let i = raw.length - 1; i >= 0; i--) {
    const item = raw[i];
    if (typeof item === 'object' && item !== null && !Array.isArray(item) && (item as Record<string, JsonValue>)['visible'] !== false) return item as Record<string, JsonValue>;
  }
  return undefined;
}

const same = <T>(values: readonly T[]): T | 'mixed' | undefined => {
  if (values.length === 0) return undefined;
  const first = JSON.stringify(values[0]);
  return values.every((v) => JSON.stringify(v) === first) ? values[0] : 'mixed';
};

const KIND_TYPE_LABELS: Readonly<Record<LayerKindName, string>> = LAYER_KIND_NAMES;

/** The selection kind and the values its pill shows (see the module header). */
export function selectionSummary(r: SceneReader, selection: readonly NodeId[]): SelectionSummary {
  const nodes = selection.filter((n) => layerKindOf(r, n) !== undefined);
  if (nodes.length === 0) return EMPTY_SELECTION;
  const kinds = nodes.map((n) => layerKindOf(r, n) as LayerKindName);
  const locks = nodes.map((n) => isLocked(r, n));
  const locked = locks.every(Boolean);
  const single = nodes.length === 1;
  const first = nodes[0] as NodeId;
  const firstKind = kinds[0] as LayerKindName;
  const common = kinds.every((k) => k === firstKind) ? firstKind : undefined;
  const kind: SelectionKind = locked
    ? 'locked'
    : !single
      ? common === undefined
        ? 'mixed'
        : 'multi'
      : (
          {
            frame: 'frame',
            group: 'group',
            rectangle: 'shape',
            ellipse: 'shape',
            polygon: 'shape',
            star: 'shape',
            line: 'shape',
            path: 'shape',
            image: 'image',
            text: 'text',
            repeat: 'repeat',
            boolean: 'boolean',
            mask: 'mask',
          } as const
        )[firstKind];
  const fills = nodes.map((n) => topItem(r, n, P.fills)?.['paint']);
  const hasFill = kinds.every((k) => k !== 'group' && k !== 'mask' && k !== 'image');
  const fillSummaries = fills.map((p) => paintSummary(p, r.kit));
  const fillSame = same(fillSummaries);
  const strokes = nodes.map((n) => topItem(r, n, P.strokes));
  const strokeSame = same(strokes.map((s) => paintSummary(s?.['paint'], r.kit)));
  const strokeWidth = same(strokes.flatMap((s) => (typeof s?.['width'] === 'number' ? [s['width']] : [])));
  const radius = same(nodes.map((n) => r.stage.value(n, P.radius) ?? 0).map((v) => (typeof v === 'number' ? v : 0)));
  const sides = r.stage.value(first, P.sides);
  const image = imagePaintOf(r, first);
  const clip = r.stage.value(first, P.clip);
  const op = r.stage.value(first, P.boolean);
  const maskNode = firstKind === 'mask' ? r.stage.children(first)[0] : undefined;
  const repeat = single ? r.repeat(first) : undefined;
  return {
    kind,
    nodes,
    label: single ? displayName(r, first, firstKind) : `${nodes.length} selected`,
    typeLabel: single ? KIND_TYPE_LABELS[firstKind] : `${nodes.length} selected`,
    locked,
    anyLocked: locks.some(Boolean),
    hidden: nodes.every((n) => r.stage.value(n, P.hidden) === true),
    ...(common === undefined ? {} : { common }),
    ...(hasFill ? { fill: fillSame === 'mixed' ? { kind: 'mixed' } : (fillSame ?? { kind: 'none' }) } : {}),
    ...(hasFill ? { stroke: { ...(strokeSame === 'mixed' ? { kind: 'mixed' as const } : (strokeSame ?? { kind: 'none' as const })), ...(strokeWidth === undefined ? {} : { width: strokeWidth }) } } : {}),
    ...(radius === undefined ? {} : { radius }),
    ...(firstKind === 'polygon' || firstKind === 'star' ? { points: typeof sides === 'number' ? sides : firstKind === 'star' ? 5 : 3 } : {}),
    ...(firstKind === 'image' ? { fit: typeof image?.['fit'] === 'string' ? image['fit'] : 'cover', ...(typeof assetOf(image) === 'string' ? { asset: assetOf(image) as string } : {}), cropped: image?.['offset'] !== undefined || image?.['scale'] !== undefined || image?.['rotation'] !== undefined, crop: cropOf(image) } : {}),
    ...layerValues(r, nodes),
    ...(firstKind === 'frame' ? { clip: clip !== false } : {}),
    ...(typeof op === 'string' ? { booleanOp: op } : {}),
    ...(maskNode === undefined ? {} : { mask: { node: maskNode, mode: String(r.stage.value(maskNode, P.maskMode) ?? 'clip'), invert: r.stage.value(maskNode, P.maskInvert) === true } }),
    ...(repeat === undefined ? {} : { repeat }),
    actions: r.applicable(nodes),
  };
}
