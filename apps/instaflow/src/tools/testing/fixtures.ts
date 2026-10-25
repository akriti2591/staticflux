/**
 * Test-only fixtures for the tools (never imported by app code): B1's page, brand kit, stage and undo service with
 * the session layer kept (gesture previews), the real authoring Wasm, an element index, a tab view state and the
 * `ToolSession` that controllers and commands run on.
 */
import { createScope, type Scope } from '@staticflux/core';
import { createDocumentRepo, createMemoryDocumentStore, type DocumentCRDTv2, type OpenDocument, type PartOp } from '@staticflux/document/v2';
import { createPartsDocument, createSessionLayer, createStage, createStaticAssets, createUndoService, type SessionLayer, type Stage, stageWriteGuard, type UndoService } from '@staticflux/stage';
import { BRAND, engine, human, KIT, loadGeometry, nextPeer, PAGE, signal, unwrap } from '../../elements/testing/fixtures.js';
import { brandKitOps, brandRuleGuard, composeGuards, elementStageRules, readBrandKit, stageRuleContext } from '../../elements/brand-kit.js';
import type { GeometryService } from '../../elements/geometry.js';
import type { ToolSession } from '../gesture.js';
import { createElementIndex, type ElementIndex, type ToolContext } from '../hit-test.js';
import { createTransformMode } from '../transform-mode.js';
import { createViewState, type ViewState } from '../view-state.js';

export { authoringBuilt, human, agent, PAGE, shape, unwrap } from '../../elements/testing/fixtures.js';

const seedMeta = { actor: { kind: 'human', id: 'seed' }, label: 'Seed', txn: 'seed' };

export interface ToolFixture {
  readonly doc: OpenDocument;
  readonly part: DocumentCRDTv2;
  readonly stage: Stage;
  readonly session: SessionLayer;
  readonly undo: UndoService;
  readonly geometry: GeometryService;
  readonly ctx: ToolContext & { readonly stage: Stage };
  readonly index: ElementIndex;
  readonly view: ViewState;
  readonly tools: ToolSession;
  readonly scope: Scope;
  /** Commit raw ops as the seed actor (no guard, no undo step). */
  seed(ops: readonly PartOp[]): void;
}

/** Page `p1` (1000 × 800) in part `page:p1` with `ops` seeded, B1's brand kit, and a tab `t1` at zoom 1. */
export async function createToolFixture(ops: readonly PartOp[] = []): Promise<ToolFixture> {
  const geometry = await loadGeometry();
  const repo = createDocumentRepo({ store: createMemoryDocumentStore(), engine, peer: nextPeer });
  const doc = unwrap(await repo.create('as_doc', { treeSchema: 1, parts: ['root', PAGE] }, signal));
  const part = unwrap(await doc.part(PAGE, signal));
  unwrap(await doc.transact(seedMeta, { [PAGE]: [{ op: 'create', node: 'p1', kind: 'page', parent: null, props: { 'page.size': { width: 1000, height: 800 } } }, ...ops] }, signal));
  const page = createPartsDocument('as_doc');
  page.attach(part, { id: 'root' });
  const kitPart = engine.create({ peer: nextPeer() });
  unwrap(kitPart.transact(seedMeta, brandKitOps(BRAND)));
  const kitDoc = createPartsDocument(KIT.asset);
  kitDoc.attach(kitPart, { id: 'root' });
  const kit = readBrandKit(kitDoc);
  const session = createSessionLayer();
  const stage = createStage({ root: page, session, assets: createStaticAssets({ [KIT.asset]: kitDoc }), rules: elementStageRules(KIT) });
  const undo = createUndoService({ doc, guard: composeGuards(stageWriteGuard(stage), brandRuleGuard(() => stageRuleContext(stage, kit))) });
  const scope = createScope('tools-test');
  const ctx = { stage, geometry, kit };
  const index = createElementIndex(ctx, 'p1', scope);
  const view = createViewState({ tab: 't1', root: 'p1', viewport: { width: 1000, height: 800 } });
  const base = { ctx, target: { undo, stage, part: PAGE }, session, index, view, actor: () => human };
  const tools: ToolSession = { ...base, mode: createTransformMode(base, scope) };
  return {
    doc,
    part,
    stage,
    session,
    undo,
    geometry,
    ctx,
    index,
    view,
    tools,
    scope,
    seed(more) {
      unwrap(doc.commit(seedMeta, { [PAGE]: more }));
    },
  };
}
