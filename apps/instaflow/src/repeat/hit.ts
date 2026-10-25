/**
 * Instance-aware queries for tools (IF-26.12–26.13; B3 owns the hit-testing UI and smart guides):
 *
 * - `hitInstance(ctx, node, x, y)` — the top-most drawn leaf under a page point inside `node` (a candidate from the
 *   spatial index), with its `InstanceRef`: the editable source and the instance index (and the full path for
 *   nested repeats). Fill, stroke and masks count exactly as B1's `hitElement`; mask elements are not drawn and
 *   never hit; a boolean group is hit as one shape.
 * - `instanceBounds(ctx, repeat)` — page-space bounds per instance (guides and snapping to instances).
 */
import { ok, type Result } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { type ElementBounds, type ElementContext, elementBounds, hitElement, isElement } from '../elements/layout.js';
import { resolveElement } from '../elements/resolve.js';
import type { HitKind } from '../elements/geometry.js';
import type { InstanceRef, RepeatStage } from './stage.js';

export interface RepeatQueryContext extends ElementContext {
  readonly stage: RepeatStage;
}

export interface InstanceHit extends InstanceRef {
  /** Fill or stroke. */
  readonly hit: Exclude<HitKind, 'none'>;
}

/** The top-most leaf hit at a page point inside `node` (see the module header). */
export function hitInstance(ctx: RepeatQueryContext, node: NodeId, x: number, y: number, tolerance = 0): Result<InstanceHit | undefined> {
  const el = resolveElement(ctx.stage, node, ctx.kit);
  if (el === undefined || !isElement(el.kind) || el.mask !== undefined) return ok(undefined);
  if (el.geometry.kind === 'group') {
    for (const child of [...ctx.stage.children(node)].reverse()) {
      const r = hitInstance(ctx, child, x, y, tolerance);
      if (!r.ok || r.value !== undefined) return r;
    }
    return ok(undefined);
  }
  const r = hitElement(ctx, node, x, y, tolerance);
  if (!r.ok) return r;
  if (r.value === 'none') return ok(undefined);
  const ref = ctx.stage.resolveInstance(node);
  return ok(ref === undefined ? undefined : { ...ref, hit: r.value });
}

/** Page bounds of every instance of a repeat, instance 0 first (empty for anything else). */
export function instanceBounds(ctx: RepeatQueryContext, repeat: NodeId): readonly ElementBounds[] {
  if (ctx.stage.params(repeat) === undefined) return [];
  const out: ElementBounds[] = [];
  for (const wrapper of ctx.stage.children(repeat)) {
    const b = elementBounds(ctx, wrapper);
    if (b.ok) out.push(b.value);
  }
  return out;
}
