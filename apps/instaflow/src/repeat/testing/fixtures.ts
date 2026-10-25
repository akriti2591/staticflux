/**
 * Test-only fixtures for the repeat module (never imported by app code): B1's page fixture with the repeat view on
 * top, a repeat action context, and a canonical render tree (the element render projection over the view, with
 * resources resolved and ids dropped) to compare live and expanded repeats.
 */
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import type { BrandKitView } from '../../elements/brand-kit.js';
import type { GeometryService } from '../../elements/geometry.js';
import { createElementRenderSource } from '../../elements/projection.js';
import { createSceneResources } from '../../elements/scene.js';
import { createFixture, type Fixture, PAGE } from '../../elements/testing/fixtures.js';
import type { RepeatContext } from '../actions.js';
import { createRepeatStage, type RepeatStage } from '../stage.js';

export interface RepeatFixture extends Fixture {
  readonly view: RepeatStage;
  /** A repeat context with its own id counter (`prefix1`, `prefix2`, …). */
  rctx(prefix?: string): RepeatContext;
  readonly target: { readonly undo: Fixture['undo']; readonly stage: RepeatStage; readonly part: typeof PAGE };
}

export async function createRepeatFixture(geometry: GeometryService, ops: readonly PartOp[] = []): Promise<RepeatFixture> {
  const f = await createFixture(ops);
  const view = createRepeatStage({ stage: f.stage, geometry, kit: f.kit });
  return {
    ...f,
    view,
    rctx: (prefix = 'x') => {
      let ids = 0;
      return { stage: view, geometry, kit: f.kit, newId: () => `${prefix}${(ids += 1)}` };
    },
    target: { undo: f.undo, stage: view, part: PAGE },
  };
}

export interface RenderNode {
  readonly kind: string;
  readonly props: Readonly<Record<string, JsonValue>>;
  readonly look: unknown;
  readonly path: unknown;
  readonly children: readonly RenderNode[];
}

/** The projected render tree under `root` (ids dropped, resource ids replaced by their content). */
export function renderTree(view: RepeatStage, geometry: GeometryService, kit: BrandKitView | undefined, root: NodeId = 'p1'): RenderNode[] {
  const source = createElementRenderSource({ stage: view, geometry, root, ...(kit === undefined ? {} : { kit }) });
  const records: { id: NodeId; kind: string; parent: NodeId | null; order: string; props: Record<string, JsonValue> }[] = [];
  source.forEachNode((r) => {
    records.push({ id: r.id, kind: r.kind, parent: r.parent, order: r.order ?? '', props: { ...r.props } });
  });
  const resources = createSceneResources();
  resources.apply(source.resources.snapshot());
  const build = (parent: NodeId): RenderNode[] =>
    records
      .filter((r) => r.parent === parent)
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
      .map((r) => {
        const { 'render.look': look, 'render.path': path, ...props } = r.props;
        return { kind: r.kind, props, look: resources.look(Number(look)), path: Number(path) === 0 ? undefined : resources.path(Number(path)), children: build(r.id) };
      });
  const tree = build(root);
  source.dispose();
  return tree;
}

/** Match keys of a view subtree in paint order, as `depth:key` lines (structure-aligned). */
export function keyTree(view: RepeatStage, node: NodeId, depth = 0): string[] {
  const out: string[] = [];
  for (const child of view.children(node)) {
    const key = view.read(child)?.values['lineage.key'];
    out.push(`${depth}:${typeof key === 'string' ? key : '-'}`);
    out.push(...keyTree(view, child, depth + 1));
  }
  return out;
}
