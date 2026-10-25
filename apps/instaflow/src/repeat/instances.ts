/**
 * Instance placements (IF-26.6–26.9): where every instance of a repeat goes, in the repeat group's local space,
 * from the parameters and the source's content bounds. Pure math, no document access.
 *
 * A placement is a similarity (rotation, optional reflection, translation) written as the spatial values of the
 * instance's wrapper group (`x`, `y`, `rotation`, `flipY`, zero size, anchor 0): exactly what an expanded repeat
 * stores, so live and expanded instances draw from the same numbers. Instance 0 is always the identity.
 *
 * - radial: the circle's centre is `radius` from the content centre, opposite `startAngle` (clockwise from
 *   12 o'clock). Instance i sits `i · step` further round (`step` = sweep / count for a full circle, else
 *   sweep / (count − 1)); with `rotate` it turns with the circle, else it only moves.
 * - grid: instance `r · columns + c` moves by `c` cell widths and `r` cell heights (cell = content + gap), plus
 *   `r · rowOffset` along x, `c · columnOffset` along y, and the brick shift on odd rows or columns.
 * - mirror: instance 1 is the reflection across the axis through the point `offset` beyond the content edge along
 *   the axis normal.
 */
import type { Box } from '@staticflux/document/spatial-index';
import { type Affine, applyAffine, boxTransform } from '../elements/resolve.js';
import type { BrickAxis, MirrorAxis, RepeatKind } from './components.js';
import type { GridParams, MirrorParams, RadialParams, RepeatParams } from './params.js';

export interface Placement {
  readonly x: number;
  readonly y: number;
  /** Degrees, clockwise. */
  readonly rotation: number;
  readonly flipY: boolean;
}

export const IDENTITY_PLACEMENT: Placement = Object.freeze({ x: 0, y: 0, rotation: 0, flipY: false });

const RAD = Math.PI / 180;

/** The local → repeat affine of a placement (the wrapper group's `boxTransform`). */
export function placementTransform(p: Placement): Affine {
  return boxTransform({ x: p.x, y: p.y, w: 0, h: 0, rotation: p.rotation, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, flipX: false, flipY: p.flipY });
}

/** A placement that turns by `rotation` degrees (with an optional reflection) and maps `from` onto `to`. */
function about(rotation: number, flipY: boolean, from: readonly [number, number], to: readonly [number, number]): Placement {
  const linear = placementTransform({ x: 0, y: 0, rotation, flipY });
  const [mx, my] = applyAffine(linear, from[0], from[1]);
  return { x: to[0] - mx, y: to[1] - my, rotation, flipY };
}

const centerOf = (b: Box): readonly [number, number] => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
/** Unit vector at `deg` degrees clockwise from 12 o'clock (y down). */
const direction = (deg: number): readonly [number, number] => [Math.sin(deg * RAD), -Math.cos(deg * RAD)];

/** The radial step between neighbours (degrees). */
export function radialStep(p: RadialParams): number {
  if (p.sweep >= 360) return 360 / p.count;
  return p.count > 1 ? p.sweep / (p.count - 1) : 0;
}

/** The circle's centre in the repeat's local space. */
export function radialCenter(p: RadialParams, content: Box): readonly [number, number] {
  const [cx, cy] = centerOf(content);
  const [dx, dy] = direction(p.startAngle);
  return [cx - p.radius * dx, cy - p.radius * dy];
}

function radial(p: RadialParams, content: Box): Placement[] {
  const step = radialStep(p);
  const center = radialCenter(p, content);
  const source = centerOf(content);
  const out: Placement[] = [IDENTITY_PLACEMENT];
  for (let i = 1; i < p.count; i++) {
    const turn = i * step;
    const [dx, dy] = direction(p.startAngle + turn);
    const at: readonly [number, number] = [center[0] + p.radius * dx, center[1] + p.radius * dy];
    out.push(p.rotate ? about(turn, false, source, at) : { x: at[0] - source[0], y: at[1] - source[1], rotation: 0, flipY: false });
  }
  return out;
}

/** Brick shift multipliers `[odd rows → x, odd columns → y]` (a variant table, not a branch). */
const BRICK: Readonly<Record<BrickAxis, readonly [number, number]>> = { none: [0, 0], rows: [1, 0], columns: [0, 1] };

function grid(p: GridParams, content: Box): Placement[] {
  const cellW = content.maxX - content.minX + p.gapX;
  const cellH = content.maxY - content.minY + p.gapY;
  const [bx, by] = BRICK[p.brick];
  const out: Placement[] = [];
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.columns; c++) {
      const x = c * cellW + r * p.rowOffset + bx * (r % 2) * p.brickShift * cellW;
      const y = r * cellH + c * p.columnOffset + by * (c % 2) * p.brickShift * cellH;
      out.push(r === 0 && c === 0 ? IDENTITY_PLACEMENT : { x, y, rotation: 0, flipY: false });
    }
  }
  return out;
}

/** Axis direction angle per mirror axis (degrees from +x, y down); `angle` reads the parameter. */
const MIRROR_ANGLES: Readonly<Record<MirrorAxis, (p: MirrorParams) => number>> = { vertical: () => 90, horizontal: () => 180, angle: (p) => p.angle };

/** The mirror axis: a point on it and its direction angle (degrees from +x, y down). */
export function mirrorAxis(p: MirrorParams, content: Box): { readonly point: readonly [number, number]; readonly angle: number; readonly normal: readonly [number, number] } {
  const angle = MIRROR_ANGLES[p.axis](p);
  const normal: readonly [number, number] = [Math.sin(angle * RAD), -Math.cos(angle * RAD)];
  const [cx, cy] = centerOf(content);
  const reach = ((content.maxX - content.minX) / 2) * Math.abs(normal[0]) + ((content.maxY - content.minY) / 2) * Math.abs(normal[1]) + p.offset;
  return { point: [cx + normal[0] * reach, cy + normal[1] * reach], angle, normal };
}

function mirror(p: MirrorParams, content: Box): Placement[] {
  const axis = mirrorAxis(p, content);
  // Reflection across a line at angle φ = rotation by 2φ after a flip of y; it fixes the axis point.
  return [IDENTITY_PLACEMENT, about(2 * axis.angle, true, axis.point, axis.point)];
}

const GENERATORS: { readonly [K in RepeatKind]: (p: Extract<RepeatParams, { kind: K }>, content: Box) => Placement[] } = { radial, grid, mirror };

/** Every instance placement (instance 0 first, always the identity); `content` is the source's local bounds. */
export function instancePlacements(params: RepeatParams, content: Box): Placement[] {
  return (GENERATORS[params.kind] as (p: RepeatParams, c: Box) => Placement[])(params, content);
}
