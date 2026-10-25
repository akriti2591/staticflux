/**
 * Test-only fixtures for the elements module (never imported by app code): a page document and a brand kit composed
 * by a real `@staticflux/stage`, an undo service with the element write guards, and the real authoring Wasm loaded
 * in Node (tests skip when it is not built).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createDocumentRepo, createMemoryDocumentStore, type DocumentCRDTv2, type OpenDocument, type PartOp, type PeerId } from '@staticflux/document/v2';
import {
  type Actor,
  createPartsDocument,
  createSessionLayer,
  createStage,
  createStaticAssets,
  createUndoService,
  type PartsDocument,
  type Stage,
  stageWriteGuard,
  type UndoService,
} from '@staticflux/stage';
import type { ActionContext } from '../actions.js';
import { type BrandKitSpec, type BrandKitView, brandKitOps, brandRuleGuard, composeGuards, elementStageRules, readBrandKit, stageRuleContext } from '../brand-kit.js';
import { createGeometry, type GeometryService, loadAuthoringModule } from '../geometry.js';

export const engine = createLoroEngine();
export const signal = new AbortController().signal;
export const KIT = { asset: 'as_kit' } as const;
export const PAGE = 'page:p1';
export const human: Actor = { kind: 'human', id: 'g-ada', displayName: 'Ada', via: 'hud' };
export const agent: Actor = { kind: 'agent', id: 'ag-1', displayName: 'Helper', model: 'claude-test', via: 'chat', onBehalfOf: 'g-ada' };

let peer = 5000;
export const nextPeer = (): PeerId => `${(peer += 1)}` as PeerId;

export const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

const seed = { actor: { kind: 'human', id: 'seed' }, label: 'Seed', txn: 'seed' };

/** A brand kit used across tests. */
export const BRAND: BrandKitSpec = {
  tokens: {
    primary: '#ff5c39',
    ink: '#16151a',
    accent: '@primary',
    loopA: '@loopB',
    loopB: '@loopA',
    'radius-md': 12,
    display: { family: 'Bricolage Grotesque', weight: 800 },
    'shadow-md': [{ kind: 'drop-shadow', x: 0, y: 4, blur: 12, spread: 0, color: '@ink' }],
  },
  classes: {
    card: { name: 'Card', props: { 'style.fills': [{ paint: '@primary' }], 'style.radius': '@radius-md' }, final: ['style.radius'] },
    outline: { name: 'Outline', props: { 'style.strokes': [{ paint: '@ink', width: 2 }] } },
  },
  rules: [{ id: 'cta-primary', when: { role: 'cta' }, path: 'style.fills', allow: [[{ paint: '@primary' }]], message: 'Calls to action use @primary.' }],
};

export interface Fixture {
  readonly doc: OpenDocument;
  readonly part: DocumentCRDTv2;
  readonly page: PartsDocument;
  readonly kitDoc: PartsDocument;
  readonly kit: BrandKitView;
  readonly stage: Stage;
  readonly undo: UndoService;
  /** Commit raw ops as the seed actor (no guard). */
  seed(ops: readonly PartOp[]): void;
  ctx(geometry: GeometryService): ActionContext;
}

/** A page `p1` (1000 × 800) in part `page:p1`, with the brand kit attached as `as_kit`. */
export async function createFixture(ops: readonly PartOp[] = [], kitSpec: BrandKitSpec = BRAND): Promise<Fixture> {
  const repo = createDocumentRepo({ store: createMemoryDocumentStore(), engine, peer: nextPeer });
  const doc = unwrap(await repo.create('as_doc', { treeSchema: 1, parts: ['root', PAGE] }, signal));
  const part = unwrap(await doc.part(PAGE, signal));
  unwrap(await doc.transact(seed, { [PAGE]: [{ op: 'create', node: 'p1', kind: 'page', parent: null, props: { 'page.size': { width: 1000, height: 800 } } }, ...ops] }, signal));
  const page = createPartsDocument('as_doc');
  page.attach(part, { id: 'root' });
  const kitPart = engine.create({ peer: nextPeer() });
  unwrap(kitPart.transact(seed, brandKitOps(kitSpec)));
  const kitDoc = createPartsDocument(KIT.asset);
  kitDoc.attach(kitPart, { id: 'root' });
  const kit = readBrandKit(kitDoc);
  const stage = createStage({ root: page, session: createSessionLayer(), assets: createStaticAssets({ [KIT.asset]: kitDoc }), rules: elementStageRules(KIT) });
  const undo = createUndoService({ doc, guard: composeGuards(stageWriteGuard(stage), brandRuleGuard(() => stageRuleContext(stage, kit))) });
  let ids = 0;
  return {
    doc,
    part,
    page,
    kitDoc,
    kit,
    stage,
    undo,
    seed(more) {
      unwrap(doc.commit(seed, { [PAGE]: more }));
    },
    ctx: (geometry) => ({ stage, geometry, kit, newId: () => `n${(ids += 1)}` }),
  };
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const manifestPath = `${root}engine/dist/sf-wasm-manifest.json`;

/** True when the authoring Wasm is built (`pnpm build`). */
export const authoringBuilt = existsSync(manifestPath);

let cached: Promise<GeometryService> | undefined;

/** The real geometry service in Node (the loader with file-system fetch). */
export function loadGeometry(): Promise<GeometryService> {
  cached ??= (async () => {
    const wasm = unwrap(
      await loadAuthoringModule({
        manifestUrl: pathToFileURL(manifestPath),
        fetch: async (url) => {
          const text = readFileSync(fileURLToPath(url), 'utf8');
          return { ok: true, status: 200, json: async () => JSON.parse(text) as unknown };
        },
        wasmBytes: async (url) => new Uint8Array(readFileSync(fileURLToPath(url))),
      }),
    );
    return createGeometry(wasm);
  })();
  return cached;
}

/** A shape node's create op. */
export function shape(node: string, props: Readonly<Record<string, unknown>>, parent = 'p1', kind = 'shape'): PartOp {
  return { op: 'create', node, kind, parent, props: props as never };
}
