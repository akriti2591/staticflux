/**
 * The Repeat panel's headless model (IF-26.23–26.24): what `<if-repeat-inspector>` shows for the selected repeat,
 * and the edits it emits. `repeatEditOps` turns an edit into one batch of ops (one change set).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { expandRepeat, liveRepeat, releaseRepeat, type RepeatContext, setRepeat } from './actions.js';
import { REPEAT_KIND_PARAMS, REPEAT_KINDS, type RepeatKind, type RepeatParamName } from './components.js';
import { RepeatNotApplicableError } from './errors.js';
import { instanceCount, REPEAT_LIMITS, type RepeatParams, type RepeatPatch } from './params.js';

export interface RepeatModel {
  readonly node: NodeId;
  readonly params: RepeatParams;
  /** Instances drawn (the source included). */
  readonly instances: number;
  /** The parameters the current generator reads, in panel order. */
  readonly fields: readonly RepeatParamName[];
  readonly kinds: readonly RepeatKind[];
  readonly limits: typeof REPEAT_LIMITS;
}

export type RepeatEdit = { readonly op: 'set'; readonly patch: RepeatPatch } | { readonly op: 'expand' } | { readonly op: 'release' };

/** The model of a live repeat (undefined for anything else, e.g. a derived copy or a plain element). */
export function repeatModel(ctx: Pick<RepeatContext, 'stage'>, node: NodeId): RepeatModel | undefined {
  const live = liveRepeat(ctx, node);
  if (!live.ok) return undefined;
  const params = live.value.params;
  return { node, params, instances: instanceCount(params), fields: REPEAT_KIND_PARAMS[params.kind], kinds: REPEAT_KINDS, limits: REPEAT_LIMITS };
}

/** The ops of one panel edit (one change set). */
export function repeatEditOps(ctx: RepeatContext, node: NodeId, edit: RepeatEdit): Result<PartOp[]> {
  switch (edit.op) {
    case 'set':
      return setRepeat(ctx, node, edit.patch);
    case 'release':
      return releaseRepeat(ctx, node);
    case 'expand': {
      const r = expandRepeat(ctx, node);
      return r.ok ? ok(r.value.ops) : r;
    }
    default:
      return err(RepeatNotApplicableError({ details: { needs: 'a known edit' } }));
  }
}
