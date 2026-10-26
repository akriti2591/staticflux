/**
 * Text on Studio's canvas (B8 glue over B2): every text element of the open page laid out with B2's Parley engine
 * and drawn as B2's glyph scene nodes, published on the canvas pipeline's IR section (after the element batch).
 *
 * - **Dirty tracking** follows the repeat view's invalidations (the stage names created, changed and deleted nodes,
 *   B6's stage fix), so only edited text is laid out again.
 * - **Fonts** go to the render scene once per content hash (`createSceneFontTable`); a snapshot re-announces them.
 * - **Placement** (B12b P2, IF-37.27–37.28): the element projection draws each text element as a node of its own in
 *   the element tree (transform, opacity, blend, effects, mask, order, parent; `ELEMENT_PROJECTION_KINDS`). The text
 *   layer puts the glyph group **under that node** (`sceneParent`), in the element's local space, so text paints in
 *   tree order, inside its frames' clips and masks, with its parents' opacity and effects, exactly as shapes do. A text
 *   element the projection does not draw (hidden, a boolean operand) draws no glyphs either. When the element's node
 *   changes (a new slot after it was hidden and shown), its glyphs are drawn again under the new one.
 * - **Fixed boxes** (B12 T-1): the text wraps at the box width, keeps the box height and sits at its vertical alignment
 *   (`textBlockTransform`, `textLocalOffset`); text taller than the box overflows below it, never clipped by its own box.
 * - **Box size**: `textBoxOps` writes the laid-out width / height back to `spatial.w|h` in the same commit as a text
 *   edit, so B3's hit tests, snapping and the selection frame see the real text box.
 *
 * Scene ids are odd (B1's element ids are even, `sceneIdOf`), so text never collides with elements.
 */
import { err, ok, type Result, type Scope } from '@staticflux/core';
import type { RenderProjector } from '@staticflux/document/render-projection';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import { P } from '../elements/components.js';
import { pageTransform } from '../elements/layout.js';
import { sceneIdOf } from '../elements/scene.js';
import { createSceneWriter } from '../render/scene-ir.js';
import type { TextLayout } from '../text/layout-result.js';
import { encodeLayoutSpec } from '../text/layout-spec.js';
import { TEXT_KIND } from '../text/model.js';
import { readTextBlock, type TextBlockModel } from '../text/rich-text.js';
import type { TextLayoutEngine } from '../text/text-engine.js';
import { createSceneFontTable, textSceneNodes } from '../text/text-scene.js';
import { type BrandTokenSource, type FontFamilies, resolveTextLayout, type TextDefaults, verticalAlignOffset } from '../text/text-style.js';
import { type Affine, multiply } from '../elements/resolve.js';
import type { SceneIrSource } from './canvas-pipeline.js';
import type { StudioDocument } from './document.js';
import { NoOpenPageError } from './errors.js';

/** The text engine and the fonts it was given (loaded by the entry: bundled OFL fonts, uploads later). */
export interface StudioFonts {
  readonly engine: TextLayoutEngine;
  readonly defaults: TextDefaults;
  readonly families: FontFamilies;
  bytesOf(hash: string): Uint8Array | undefined;
}

export interface TextLayerOptions {
  readonly document: StudioDocument;
  readonly page: NodeId;
  readonly fonts: StudioFonts;
  readonly brand?: BrandTokenSource;
  readonly scope: Pick<Scope, 'defer'>;
  /**
   * Scene id of a text element's own node in the element scene (`projectedSceneId(projector)`), the parent of its
   * glyph group; undefined: the projection does not draw it, so neither does the text layer (B12b P2).
   */
  readonly sceneParent: (node: NodeId) => number | undefined;
}

/** `sceneParent` over the element projector: B1's scene id of the node's slot (B12b P2). */
export function projectedSceneId(projector: Pick<RenderProjector, 'slotOf'>): (node: NodeId) => number | undefined {
  return (node) => {
    const slot = projector.slotOf(node);
    return slot === undefined ? undefined : sceneIdOf(slot);
  };
}

export interface TextLayer extends SceneIrSource {
  /** Text elements on the page (as last seen). */
  readonly nodes: readonly NodeId[];
  /** The layout block id of a text element (stable while the layer lives). */
  blockId(node: NodeId): number;
  /** The scene id of a text element's group (C1: selection exports), once it was drawn. */
  sceneGroup(node: NodeId): number | undefined;
  /** Lay `model` out with `node`'s box and styles (the editing session's preview; also the default model). */
  layout(node: NodeId, model?: TextBlockModel): Result<TextLayout>;
  dispose(): void;
}

/** Block px → the element's local space: down by its vertical alignment in a fixed box (B12 T-1), else none. */
export function textLocalOffset(document: StudioDocument, node: NodeId, laid: Pick<TextLayout, 'height'>): number {
  const h = document.view.value(node, P.h);
  return verticalAlignOffset(document.view.value(node, 'text.box') as string | undefined, document.view.value(node, 'text.verticalAlign') as string | undefined, typeof h === 'number' ? h : 0, laid.height);
}

/** Block px → page of a laid-out text element: its page transform, moved down by its vertical alignment (B12 T-1). */
export function textBlockTransform(document: StudioDocument, node: NodeId, laid: Pick<TextLayout, 'height'>): Affine {
  const t = pageTransform(document.context(), node);
  const dy = textLocalOffset(document, node, laid);
  return dy === 0 ? t : multiply(t, [1, 0, 0, 1, 0, dy]);
}

/** Wrap width of a text element (≤ 0: auto width). */
function wrapWidth(document: StudioDocument, node: NodeId): number {
  const box = document.view.value(node, 'text.box');
  const w = document.view.value(node, P.w);
  return box === 'auto-width' || typeof w !== 'number' ? 0 : w;
}

export function createTextLayer(options: TextLayerOptions): TextLayer {
  const { document, page, fonts } = options;
  const table = createSceneFontTable();
  const ids = new Map<NodeId, number>();
  const sceneIds = new Map<NodeId, readonly number[]>();
  /** The element node each text element's glyphs were last drawn under (B12b P2). */
  const parents = new Map<NodeId, number>();
  const dirty = new Set<NodeId>();
  let known = new Set<NodeId>();
  let nextBlock = 1;
  let nextScene = 1;
  let disposed = false;

  const part = (): ReturnType<StudioDocument['part']> => document.part(page);
  const textNodes = (): NodeId[] => {
    const out: NodeId[] = [];
    const walk = (parent: NodeId): void => {
      for (const child of document.view.children(parent)) {
        const composed = document.view.read(child);
        if (composed?.values[P.hidden] === true) continue; // B12: hidden text (or a hidden container) is not drawn
        if (composed?.kind === TEXT_KIND && !document.view.isDerived(child)) out.push(child);
        walk(child);
      }
    };
    walk(page);
    return out;
  };
  const blockId = (node: NodeId): number => {
    let id = ids.get(node);
    if (id === undefined) ids.set(node, (id = nextBlock++));
    return id;
  };
  const layout = (node: NodeId, model?: TextBlockModel): Result<TextLayout> => {
    const source = part();
    const block = model === undefined ? (source === undefined ? undefined : readTextBlock(source, node)) : ok(model);
    if (block === undefined) return err(NoOpenPageError({ details: { page } }));
    if (!block.ok) return block;
    const resolved = resolveTextLayout(block.value, { width: wrapWidth(document, node), defaults: fonts.defaults, families: fonts.families, ...(options.brand === undefined ? {} : { brand: options.brand }) });
    return fonts.engine.layout(blockId(node), encodeLayoutSpec(resolved.spec), block.value.text);
  };
  const brushes = (node: NodeId): ReturnType<typeof resolveTextLayout>['brushes'] => {
    const source = part();
    const block = source === undefined ? undefined : readTextBlock(source, node);
    if (block === undefined || !block.ok) return [];
    return resolveTextLayout(block.value, { width: wrapWidth(document, node), defaults: fonts.defaults, families: fonts.families, ...(options.brand === undefined ? {} : { brand: options.brand }) }).brushes;
  };

  const stop = document.view.onInvalidate((nodes) => {
    for (const n of nodes) dirty.add(n);
  });

  const changes = (full: boolean): { readonly ir?: Uint8Array } | undefined => {
    if (disposed) return undefined;
    if (!full && dirty.size === 0) return undefined;
    const current = textNodes();
    const now = new Set(current);
    const w = createSceneWriter();
    let ops = 0;
    if (full) table.resnapshot();
    for (const gone of known) {
      if (now.has(gone)) continue;
      for (const id of sceneIds.get(gone) ?? []) w.remove(id);
      sceneIds.delete(gone);
      parents.delete(gone);
      ops += 1;
    }
    // Edited, new, or its element's node changed (glyphs sit in the element's local space: moving a parent needs nothing).
    const redraw = full ? current : current.filter((n) => dirty.has(n) || !known.has(n) || parents.get(n) !== options.sceneParent(n));
    for (const node of redraw) {
      if (!full) for (const id of sceneIds.get(node) ?? []) w.remove(id);
      const parent = options.sceneParent(node);
      const laid = layout(node);
      if (parent === undefined || !laid.ok) {
        sceneIds.delete(node);
        parents.delete(node);
        continue;
      }
      for (const run of laid.value.runs()) {
        const hash = fonts.engine.fontOf(run.font)?.hash;
        if (hash !== undefined) table.ensure(w, hash, () => fonts.bytesOf(hash));
      }
      const group = (nextScene += 2);
      const placed: number[] = [group];
      const source = part();
      const block = source === undefined ? undefined : readTextBlock(source, node);
      // Under the element's own node, which carries its transform and layer look (opacity, blend, effects, mask).
      const dy = textLocalOffset(document, node, laid.value);
      const nodes = textSceneNodes(laid.value, {
        ...(block?.ok === true ? { text: block.value.text } : {}),
        ...(dy === 0 ? {} : { transform: [1, 0, 0, 1, 0, dy] }),
        id: group,
        parent,
        brushes: brushes(node),
        fontId: (id) => {
          const hash = fonts.engine.fontOf(id)?.hash;
          return hash === undefined ? undefined : table.idFor(hash);
        },
        nextId: () => {
          nextScene += 2;
          placed.push(nextScene);
          return nextScene;
        },
      });
      for (const n of nodes) w.upsert(n);
      sceneIds.set(node, placed);
      parents.set(node, parent);
      ops += 1;
    }
    dirty.clear();
    known = now;
    return ops === 0 && !full ? undefined : { ir: w.finish() };
  };

  const layer: TextLayer = {
    get nodes() {
      return [...known];
    },
    blockId,
    sceneGroup: (node) => sceneIds.get(node)?.[0],
    layout,
    changes,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      for (const id of ids.values()) fonts.engine.drop(id);
    },
  };
  options.scope.defer(() => layer.dispose());
  return layer;
}

/** Ops that make a text element's box match its layout (auto width: both sides; auto height: the height). */
export function textBoxOps(document: StudioDocument, node: NodeId, laid: TextLayout): PartOp[] {
  const box = document.view.value(node, 'text.box');
  const want: Record<string, JsonValue> = { [P.h]: Math.ceil(laid.height) };
  if (box === 'auto-width') want[P.w] = Math.ceil(laid.width);
  if (box === 'fixed') return [];
  const props = Object.entries(want).filter(([path, value]) => document.view.value(node, path) !== value);
  return props.map(([path, value]) => ({ op: 'set', node, path, value }) as PartOp);
}
