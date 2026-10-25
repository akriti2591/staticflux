/**
 * Text on Studio's canvas (B8 glue over B2): every text element of the open page laid out with B2's Parley engine
 * and drawn as B2's glyph scene nodes, published on the canvas pipeline's IR section (after the element batch).
 *
 * - **Dirty tracking** follows the repeat view's invalidations (the stage names created, changed and deleted nodes,
 *   B6's stage fix), so only edited text is laid out again.
 * - **Fonts** go to the render scene once per content hash (`createSceneFontTable`); a snapshot re-announces them.
 * - **Placement**: each text element is a top-level scene group with its page transform (B1 `pageTransform`), drawn
 *   above the page's other elements. Text inside a moved group re-lays out when the group's subtree is invalidated.
 *   One paint order with the element projection is a follow-up (text as a projection kind).
 * - **Box size**: `textBoxOps` writes the laid-out width / height back to `spatial.w|h` in the same commit as a text
 *   edit, so B3's hit tests, snapping and the selection frame see the real text box.
 *
 * Scene ids are odd (B1's element ids are even, `sceneIdOf`), so text never collides with elements.
 */
import { err, ok, type Result, type Scope } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import { P } from '../elements/components.js';
import { pageTransform } from '../elements/layout.js';
import { createSceneWriter, type SceneTransform } from '../render/scene-ir.js';
import type { TextLayout } from '../text/layout-result.js';
import { encodeLayoutSpec } from '../text/layout-spec.js';
import { TEXT_KIND } from '../text/model.js';
import { readTextBlock, type TextBlockModel } from '../text/rich-text.js';
import type { TextLayoutEngine } from '../text/text-engine.js';
import { createSceneFontTable, textSceneNodes } from '../text/text-scene.js';
import { type BrandTokenSource, type FontFamilies, resolveTextLayout, type TextDefaults } from '../text/text-style.js';
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
}

export interface TextLayer extends SceneIrSource {
  /** Text elements on the page (as last seen). */
  readonly nodes: readonly NodeId[];
  /** The layout block id of a text element (stable while the layer lives). */
  blockId(node: NodeId): number;
  /** Lay `model` out with `node`'s box and styles (the editing session's preview; also the default model). */
  layout(node: NodeId, model?: TextBlockModel): Result<TextLayout>;
  dispose(): void;
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
        if (document.view.read(child)?.kind === TEXT_KIND && !document.view.isDerived(child)) out.push(child);
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
      ops += 1;
    }
    const redraw = full ? current : current.filter((n) => dirty.has(n) || !known.has(n) || [...dirty].some((d) => isAncestor(d, n)));
    for (const node of redraw) {
      if (!full) for (const id of sceneIds.get(node) ?? []) w.remove(id);
      const laid = layout(node);
      if (!laid.ok) {
        sceneIds.delete(node);
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
      const nodes = textSceneNodes(laid.value, {
        ...(block?.ok === true ? { text: block.value.text } : {}),
        id: group,
        transform: [...pageTransform(document.context(), node)] as unknown as SceneTransform,
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
      ops += 1;
    }
    dirty.clear();
    known = now;
    return ops === 0 && !full ? undefined : { ir: w.finish() };
  };

  /** True when `ancestor` is above `node` in the view. */
  function isAncestor(ancestor: NodeId, node: NodeId): boolean {
    for (let at = document.view.read(node)?.parent ?? null; at !== null; at = document.view.read(at)?.parent ?? null) if (at === ancestor) return true;
    return false;
  }

  const layer: TextLayer = {
    get nodes() {
      return [...known];
    },
    blockId,
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
