/**
 * The `repeat` component (M1b B7; IF-26.1–26.4): a **live, non-destructive repeat generator** on a `group` node.
 * The group's children are the **source**; its instances are derived when the stage is read through
 * `createRepeatStage` (never stored as elements). Three generators, Illustrator-style:
 *
 * - **radial** — `count` copies on a circle of `radius` around a centre; `startAngle` (degrees, clockwise from
 *   12 o'clock) is where the source sits on the circle, `sweep` the arc they spread over (360 = a full circle, no
 *   overlap at the end), `rotate` turns each copy with the circle (else copies keep the source's orientation).
 * - **grid** — `rows` × `columns` cells of the source's bounds plus `gapX` / `gapY`; `rowOffset` shifts each row
 *   along x and `columnOffset` each column along y (diagonal / skewed grids), `brick` shifts every odd row (`rows`)
 *   or column (`columns`) by `brickShift` cells (brick and hex patterns).
 * - **mirror** — the source and its reflection across an axis: `vertical`, `horizontal` or `angle` (degrees); the
 *   axis touches the source's bounds and moves out by `offset`.
 *
 * Instance 0 is always the source in place (identity), so the source is edited where it is drawn.
 * Every parameter is one LWW register: concurrent edits of different parameters merge.
 */
import { type ComponentDefinitionV2, defineComponent, field } from '@staticflux/document/v2';
import { ELEMENT_KIND_COMPONENTS } from '../elements/components.js';

export const REPEAT_KINDS = ['radial', 'grid', 'mirror'] as const;
export type RepeatKind = (typeof REPEAT_KINDS)[number];
export const BRICK_AXES = ['none', 'rows', 'columns'] as const;
export type BrickAxis = (typeof BRICK_AXES)[number];
export const MIRROR_AXES = ['vertical', 'horizontal', 'angle'] as const;
export type MirrorAxis = (typeof MIRROR_AXES)[number];

export const REPEAT_DEFAULTS = {
  count: 6,
  radius: 120,
  startAngle: 0,
  sweep: 360,
  rotate: true,
  rows: 3,
  columns: 3,
  gapX: 16,
  gapY: 16,
  rowOffset: 0,
  columnOffset: 0,
  brick: 'none',
  brickShift: 0.5,
  axis: 'vertical',
  angle: 90,
  offset: 0,
} as const;

export const Repeat = defineComponent(
  'repeat',
  {
    kind: field.enum(REPEAT_KINDS),
    count: 'i32',
    radius: 'f64',
    startAngle: 'f64',
    sweep: 'f64',
    rotate: 'bool',
    rows: 'i32',
    columns: 'i32',
    gapX: 'f64',
    gapY: 'f64',
    rowOffset: 'f64',
    columnOffset: 'f64',
    brick: field.enum(BRICK_AXES),
    brickShift: 'f64',
    axis: field.enum(MIRROR_AXES),
    angle: 'f64',
    offset: 'f64',
  },
  {
    defaults: REPEAT_DEFAULTS,
    description:
      'Live repeat of the group’s children (the source): `kind` radial (count, radius, startAngle, sweep, rotate), grid (rows, columns, gapX, gapY, rowOffset, columnOffset, brick, brickShift) or mirror (axis, angle, offset). Instances are derived, never stored; instance 0 is the source in place. Angles in degrees, clockwise.',
  },
);

export const REPEAT_COMPONENTS: readonly ComponentDefinitionV2[] = [Repeat];

/** Kind table addition: a `group` may carry `repeat` (merge into `createElementRegistry({ kinds })`). */
export const REPEAT_KIND_COMPONENTS: Readonly<Record<string, readonly string[]>> = {
  group: [...(ELEMENT_KIND_COMPONENTS['group'] ?? []), 'repeat'],
};

/** Repeat paths (typed values, rule 1). */
export const RP = {
  kind: 'repeat.kind',
  count: 'repeat.count',
  radius: 'repeat.radius',
  startAngle: 'repeat.startAngle',
  sweep: 'repeat.sweep',
  rotate: 'repeat.rotate',
  rows: 'repeat.rows',
  columns: 'repeat.columns',
  gapX: 'repeat.gapX',
  gapY: 'repeat.gapY',
  rowOffset: 'repeat.rowOffset',
  columnOffset: 'repeat.columnOffset',
  brick: 'repeat.brick',
  brickShift: 'repeat.brickShift',
  axis: 'repeat.axis',
  angle: 'repeat.angle',
  offset: 'repeat.offset',
} as const;
export type RepeatParamName = Exclude<keyof typeof RP, 'kind'>;

/** Every repeat path (release and expand clear them all). */
export const REPEAT_PATHS: readonly string[] = Object.values(RP);

/** The parameters each generator reads (the others keep their values when the kind switches). */
export const REPEAT_KIND_PARAMS: Readonly<Record<RepeatKind, readonly RepeatParamName[]>> = {
  radial: ['count', 'radius', 'startAngle', 'sweep', 'rotate'],
  grid: ['rows', 'columns', 'gapX', 'gapY', 'rowOffset', 'columnOffset', 'brick', 'brickShift'],
  mirror: ['axis', 'angle', 'offset'],
};

/**
 * View-id separators of derived nodes (`stage.ts`): an instance wrapper is `<repeat>~<index>`, a copy of view node
 * `<id>` inside instance wrapper `<repeat>~<index>` is `<repeat>~<index>^<id>`. Repeat group ids must not contain `^`.
 */
export const INSTANCE_SEPARATOR = '~';
export const COPY_SEPARATOR = '^';
