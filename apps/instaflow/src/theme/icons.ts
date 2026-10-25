/**
 * Instaflow's icon tables (FOUNDATIONS §5.9, STUDIO-UX-SPEC §10.2): which kit icon marks each layer kind (Layers rows,
 * the inspector header), each Studio tool (tool picker, Help) and each repeat / boolean / mask mode. The icons
 * themselves are the kit's (`@staticflux/kit/icons/*`: Lucide plus the custom set); only the mapping is Instaflow's.
 *
 * Data only: imports per-icon modules, so a surface that uses one table ships only those icons. Render with
 * `<sf-icon .icon=${layerKindIcon(kind)}>` at 16 px in rows, 18 px in the tool picker (B11b).
 */
import type { IconDef } from '@staticflux/kit/icon';
import { booleanExcludeIcon } from '@staticflux/kit/icons/boolean-exclude';
import { booleanIntersectIcon } from '@staticflux/kit/icons/boolean-intersect';
import { booleanSubtractIcon } from '@staticflux/kit/icons/boolean-subtract';
import { booleanUnionIcon } from '@staticflux/kit/icons/boolean-union';
import { circleIcon } from '@staticflux/kit/icons/circle';
import { frameIcon } from '@staticflux/kit/icons/frame';
import { groupIcon } from '@staticflux/kit/icons/group';
import { handIcon } from '@staticflux/kit/icons/hand';
import { imageIcon } from '@staticflux/kit/icons/image';
import { maskIcon } from '@staticflux/kit/icons/mask';
import { minusIcon } from '@staticflux/kit/icons/minus';
import { mousePointer2Icon } from '@staticflux/kit/icons/mouse-pointer-2';
import { penToolIcon } from '@staticflux/kit/icons/pen-tool';
import { pentagonIcon } from '@staticflux/kit/icons/pentagon';
import { repeatGridIcon } from '@staticflux/kit/icons/repeat-grid';
import { repeatMirrorIcon } from '@staticflux/kit/icons/repeat-mirror';
import { repeatRadialIcon } from '@staticflux/kit/icons/repeat-radial';
import { splineIcon } from '@staticflux/kit/icons/spline';
import { squareIcon } from '@staticflux/kit/icons/square';
import { starIcon } from '@staticflux/kit/icons/star';
import { typeIcon } from '@staticflux/kit/icons/type';
import type { BooleanOpName } from '../elements/components.js';
import type { RepeatKind } from '../repeat/components.js';

/** Layer kinds as a person sees them in Layers (STUDIO-UX-SPEC §3.1), in that list's order. */
export const LAYER_KINDS = ['frame', 'group', 'rectangle', 'ellipse', 'polygon', 'star', 'line', 'path', 'image', 'text', 'repeat', 'boolean', 'mask'] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

const LAYER_ICONS: Readonly<Record<LayerKind, IconDef>> = {
  frame: frameIcon,
  group: groupIcon,
  rectangle: squareIcon,
  ellipse: circleIcon,
  polygon: pentagonIcon,
  star: starIcon,
  line: minusIcon,
  path: splineIcon,
  image: imageIcon,
  text: typeIcon,
  repeat: repeatRadialIcon,
  boolean: booleanUnionIcon,
  mask: maskIcon,
};

/** The icon of a layer kind (Layers rows, the inspector header). */
export function layerKindIcon(kind: LayerKind): IconDef {
  return LAYER_ICONS[kind];
}

/** Tool picker tools (STUDIO-UX-SPEC §4.1), in picker order. Pen renders only once its controller exists. */
export const TOOL_ICON_IDS = ['select', 'frame', 'shape', 'text', 'pen', 'hand'] as const;
export type ToolIconId = (typeof TOOL_ICON_IDS)[number];

const TOOL_ICONS: Readonly<Record<ToolIconId, IconDef>> = {
  select: mousePointer2Icon,
  frame: frameIcon,
  shape: squareIcon,
  text: typeIcon,
  pen: penToolIcon,
  hand: handIcon,
};

/** The icon of a tool picker button. */
export function toolIcon(tool: ToolIconId): IconDef {
  return TOOL_ICONS[tool];
}

/** Repeat kinds (B7) → icon (the pill's kind chip, More › Repeat). */
export const REPEAT_ICONS: Readonly<Record<RepeatKind, IconDef>> = { radial: repeatRadialIcon, grid: repeatGridIcon, mirror: repeatMirrorIcon };

/** Boolean operations (B1) → icon (pill Combine ▾). */
export const BOOLEAN_ICONS: Readonly<Record<BooleanOpName, IconDef>> = {
  union: booleanUnionIcon,
  subtract: booleanSubtractIcon,
  intersect: booleanIntersectIcon,
  exclude: booleanExcludeIcon,
};
