/**
 * Story edits of the Pages lens: moving a page in the story order is one `move` of its stub among the
 * composition's children in the root part, committed through the open document (one commit, undoable
 * per actor, D14). Page content never moves (it is its own part).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { Committed, NodeId, PartOp, TransactionMeta } from '@staticflux/document/v2';
import { actorRecord, type Actor } from '@staticflux/stage';
import { StoryMoveError, UnknownPageError } from './errors.js';
import type { CompositionStructure } from './structure.js';

export const ROOT_PART = 'root';

export interface StoryWriterOptions {
  readonly doc: { commit(meta: TransactionMeta, changes: Readonly<Record<string, readonly PartOp[]>>): Result<Committed> };
  /** The current structure (the lens controller's feed). */
  readonly structure: () => Result<CompositionStructure>;
  readonly actor: () => Actor;
  readonly part?: string;
}

export interface StoryWriter {
  /** Move `page` to story index `to` (0-based, clamped to nothing: out of range is IF-LIB-013). */
  movePage(page: NodeId, to: number): Result<void>;
  /** B11b: page edits a host that can create page parts offers (Studio's editor); absent elsewhere. */
  readonly pages?: PageEditor;
}

/** B11b (STUDIO-UX-SPEC §3.2): add, duplicate, delete and rename pages; each one undo step. */
export interface PageEditor {
  /** A new page after `after` (the end when undefined); resolves once the story shows it. */
  addPage(after?: NodeId): Promise<Result<NodeId>>;
  duplicatePage(page: NodeId): Promise<Result<NodeId>>;
  /** Never the last page (IF-POL-052). */
  deletePage(page: NodeId): Promise<Result<void>>;
  renamePage(page: NodeId, name: string): Promise<Result<void>>;
}

/** The `move` op that puts `page` at story index `to` (pure). */
export function storyMoveOp(structure: CompositionStructure, page: NodeId, to: number): Result<PartOp | undefined> {
  const order = structure.pages.map((p) => p.id);
  const from = order.indexOf(page);
  if (from < 0) return err(UnknownPageError({ details: { page } }));
  if (!Number.isInteger(to) || to < 0 || to >= order.length) return err(StoryMoveError({ details: { page, to, pages: order.length } }));
  if (from === to) return ok(undefined);
  const without = order.filter((id) => id !== page);
  const after = to === 0 ? null : (without[to - 1] as NodeId);
  return ok({ op: 'move', node: page, parent: structure.composition, position: { after } });
}

export function createStoryWriter(options: StoryWriterOptions): StoryWriter {
  const part = options.part ?? ROOT_PART;
  return {
    movePage(page, to) {
      const structure = options.structure();
      if (!structure.ok) return structure;
      const op = storyMoveOp(structure.value, page, to);
      if (!op.ok) return op;
      if (op.value === undefined) return ok();
      const committed = options.doc.commit({ actor: actorRecord(options.actor()), label: 'Reorder pages' }, { [part]: [op.value] });
      return committed.ok ? ok() : committed;
    },
  };
}
