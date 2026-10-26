/**
 * Page edits beyond moving (B11b, STUDIO-UX-SPEC §3.2): add a page (the current page's size, right after it), duplicate
 * a page (its elements copied into the new page's own part), delete a page (its stub leaves the story; its part stays,
 * so undo brings it back whole), rename a page. Pure op builders over the structure; the editor commits each as one
 * undo step across the root part and the page parts (D14: a page's content is its own part).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import { LastPageError, PageNameError, UnknownPageError } from './errors.js';
import { type CompositionStructure, PAGE_KIND, type PageStub, STRUCTURE_PATHS } from './structure.js';

/** Space between pages on the canvas (the New design layout). */
export const PAGE_GAP = 120;

export interface NewPage {
  readonly id: NodeId;
  /** The stub's ops in the root part and the page node's op in its own part. */
  readonly root: readonly PartOp[];
  readonly page: readonly PartOp[];
}

const stubOf = (structure: CompositionStructure, page: NodeId | undefined): PageStub | undefined => structure.pages.find((p) => p.id === page);

/** Where a new page goes on the canvas: right of every page placed so far. */
function nextCanvasX(structure: CompositionStructure): number {
  let x = 0;
  for (const p of structure.pages) x = Math.max(x, (p.canvas?.x ?? p.index * (p.width + PAGE_GAP)) + p.width + PAGE_GAP);
  return x;
}

/** A fresh page after `after` (at the end when undefined), sized like it (or the composition's format). */
export function addPageOps(structure: CompositionStructure, id: NodeId, options: { readonly after?: NodeId; readonly name?: string } = {}): NewPage {
  const after = stubOf(structure, options.after) ?? structure.pages.at(-1);
  const size = after === undefined ? structure.format : { width: after.width, height: after.height };
  const name = options.name ?? `Page ${structure.pages.length + 1}`;
  return {
    id,
    root: [
      {
        op: 'create',
        node: id,
        kind: PAGE_KIND,
        parent: structure.composition,
        position: after === undefined ? { index: 0 } : { after: after.id },
        props: { name, [STRUCTURE_PATHS.pageSize]: { width: size.width, height: size.height }, [STRUCTURE_PATHS.pageCanvas]: [nextCanvasX(structure), 0] },
      },
    ],
    page: [{ op: 'create', node: id, kind: PAGE_KIND, parent: null, props: { name: '', [STRUCTURE_PATHS.pageSize]: { width: size.width, height: size.height } } }],
  };
}

/**
 * Duplicate `page` as `id` right after it, named `<name> copy`: the copies' create ops (from B1's `duplicate`, whose
 * top-level parent is the source page) are re-parented under the new page; ops on the source nodes (match keys the
 * copies share) stay in the source part.
 */
export function duplicatePageOps(structure: CompositionStructure, page: NodeId, id: NodeId, copied: readonly PartOp[]): Result<NewPage & { readonly source: readonly PartOp[] }> {
  const stub = stubOf(structure, page);
  if (stub === undefined) return err(UnknownPageError({ details: { page } }));
  const fresh = addPageOps(structure, id, { after: page, name: `${stub.name ?? `Page ${stub.index + 1}`} copy` });
  const source: PartOp[] = [];
  const children: PartOp[] = [];
  let index = 0;
  for (const op of copied) {
    if (op.op !== 'create') {
      source.push(op);
      continue;
    }
    if (op.parent === page) {
      const { position: _ignored, ...rest } = op;
      void _ignored;
      children.push({ ...rest, parent: id, position: { index } });
      index += 1;
    } else children.push(op);
  }
  // A page's own size props are copied too (its Background stack included).
  return ok({ ...fresh, page: [...fresh.page, ...children], source });
}

/** Delete `page` from the story (never the last one). Its part keeps the content, so undo restores it. */
export function deletePageOps(structure: CompositionStructure, page: NodeId): Result<readonly PartOp[]> {
  if (stubOf(structure, page) === undefined) return err(UnknownPageError({ details: { page } }));
  if (structure.pages.length <= 1) return err(LastPageError({ details: { page } }));
  return ok([{ op: 'delete', node: page }]);
}

/** Rename `page` (trimmed; empty is refused). */
export function renamePageOps(structure: CompositionStructure, page: NodeId, name: string): Result<readonly PartOp[]> {
  const trimmed = name.trim();
  if (stubOf(structure, page) === undefined) return err(UnknownPageError({ details: { page } }));
  if (trimmed === '') return err(PageNameError({ details: { page } }));
  return ok([{ op: 'set', node: page, path: 'name', value: trimmed as JsonValue }]);
}

/** The page shown after `page` leaves the story: the next one, else the previous one. */
export function neighbourPage(structure: CompositionStructure, page: NodeId): NodeId | undefined {
  const order = structure.pages.map((p) => p.id);
  const at = order.indexOf(page);
  return order[at + 1] ?? order[at - 1];
}
