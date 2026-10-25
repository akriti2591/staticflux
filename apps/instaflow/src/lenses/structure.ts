/**
 * The composition's structure as the lenses see it (DOCUMENT-FORMAT §3.1–3.2): the root part's
 * `composition` node, its page stubs in story `order` (with `page.size` and `page.canvas`), and the
 * loose canvas elements (direct children with a `spatial` box). Reading it is per node and touches only
 * the root part, which holds page stubs, not page content (D14), so it is cheap to re-read on change.
 *
 * Paths follow DOCUMENT-FORMAT §3.2 (`page.size`, `page.canvas` as `vec2`, `composition.format.width` /
 * `.height`, `spatial.x|y|w|h`); they live in `STRUCTURE_PATHS` only, so B1's component registry and
 * this reader agree in one place.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { DocumentCRDTv2, JsonValue, NodeId, PartChange } from '@staticflux/document/v2';
import { NoCompositionError } from './errors.js';

export const COMPOSITION_KIND = 'composition';
export const PAGE_KIND = 'page';

export const STRUCTURE_PATHS = Object.freeze({
  format: 'composition.format',
  pageSize: 'page.size',
  pageCanvas: 'page.canvas',
  x: 'spatial.x',
  y: 'spatial.y',
  w: 'spatial.w',
  h: 'spatial.h',
});

/** A page's size when neither it nor the composition says (portrait post, 4:5). */
export const DEFAULT_PAGE_SIZE = Object.freeze({ width: 1080, height: 1350 });

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PageStub {
  readonly id: NodeId;
  readonly name?: string;
  /** Position in the story (0-based). */
  readonly index: number;
  readonly width: number;
  readonly height: number;
  /** Where the page sits on the canvas; undefined until the person places it. */
  readonly canvas?: { readonly x: number; readonly y: number };
}

export interface LooseElement {
  readonly id: NodeId;
  readonly kind: string;
  readonly box: Rect;
}

export interface CompositionStructure {
  readonly composition: NodeId;
  readonly format: { readonly width: number; readonly height: number };
  /** In story order. */
  readonly pages: readonly PageStub[];
  readonly loose: readonly LooseElement[];
}

/** The reads the structure needs (structurally `DocumentCRDTv2`). */
export type StructureSource = Pick<DocumentCRDTv2, 'children' | 'node' | 'prop'>;

const finite = (value: JsonValue | undefined): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const vec2 = (value: JsonValue | undefined): readonly [number, number] | undefined =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (value as unknown as readonly [number, number]) : undefined;

function formatOf(part: StructureSource, composition: NodeId): { width: number; height: number } {
  const format = part.prop(composition, STRUCTURE_PATHS.format);
  const record: Readonly<Record<string, JsonValue>> = typeof format === 'object' && format !== null && !Array.isArray(format) ? (format as Readonly<Record<string, JsonValue>>) : {};
  const width = finite(record['width']);
  const height = finite(record['height']);
  return width !== undefined && height !== undefined && width > 0 && height > 0 ? { width, height } : { ...DEFAULT_PAGE_SIZE };
}

/** Read the structure of the composition (the first top-level `composition` node unless named). */
export function readCompositionStructure(part: StructureSource, composition?: NodeId): Result<CompositionStructure> {
  const root = composition ?? part.children(null).find((id) => part.node(id)?.kind === COMPOSITION_KIND);
  if (root === undefined || part.node(root)?.kind !== COMPOSITION_KIND) return err(NoCompositionError({ details: { composition: root ?? null } }));
  const format = formatOf(part, root);
  const pages: PageStub[] = [];
  const loose: LooseElement[] = [];
  for (const id of part.children(root)) {
    const node = part.node(id);
    if (node === undefined) continue;
    if (node.kind === PAGE_KIND) {
      const declared = vec2(part.prop(id, STRUCTURE_PATHS.pageSize));
      const size = declared !== undefined && declared[0] > 0 && declared[1] > 0 ? declared : undefined;
      const canvas = vec2(part.prop(id, STRUCTURE_PATHS.pageCanvas));
      const name = part.prop(id, 'name');
      pages.push({
        id,
        index: pages.length,
        width: size?.[0] ?? format.width,
        height: size?.[1] ?? format.height,
        ...(typeof name === 'string' ? { name } : {}),
        ...(canvas === undefined ? {} : { canvas: { x: canvas[0], y: canvas[1] } }),
      });
      continue;
    }
    const x = finite(part.prop(id, STRUCTURE_PATHS.x));
    const y = finite(part.prop(id, STRUCTURE_PATHS.y));
    if (x === undefined || y === undefined) continue;
    loose.push({ id, kind: node.kind, box: { x, y, w: Math.max(0, finite(part.prop(id, STRUCTURE_PATHS.w)) ?? 0), h: Math.max(0, finite(part.prop(id, STRUCTURE_PATHS.h)) ?? 0) } });
  }
  return ok({ composition: root, format, pages, loose });
}

/** A structure that follows its part: `read()` re-reads, `observe` fires on every part change. */
export interface StructureFeed {
  read(): Result<CompositionStructure>;
  observe(listener: () => void): () => void;
}

/** The feed over a loaded root part. */
export function structureFeed(part: StructureSource & { observe(listener: (change: PartChange) => void): () => void }, composition?: NodeId): StructureFeed {
  return {
    read: () => readCompositionStructure(part, composition),
    observe: (listener) => part.observe(() => listener()),
  };
}
