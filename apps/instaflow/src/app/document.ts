/**
 * Studio's open document (B8): the workspace pieces every M1b service shares, built once per document.
 *
 * - **Workspace**: a document repo over a store (in-memory in the dev entry; OPFS lands with C0), the Loro engine
 *   with B2's `TEXT_MARK_EXPAND` (TXT-5), a blob store, the library document (B4).
 * - **Document** (D14): a root part with the composition node and its page stubs (what B4's lenses read), and one
 *   part per page holding the page node and its elements. Page parts are attached to **one stage** (B1's rules, the
 *   brand kit as an asset) with one session layer (B3 previews) and **one undo service** (one step per gesture
 *   across pages); **B7's repeat view** sits over the stage, so every reader below sees live repeat instances.
 *
 * Every element edit goes through `target` (B1's `EditTarget` over the repeat view: derived ids are refused).
 */
import { type BlobStore, createBlobStore, createMemoryObjectStore } from '@staticflux/blob';
import { err, ok, type Result, type Scope, type SfError } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { type CrdtEngine, createDocumentRepo, createMemoryDocumentStore, type DocumentCRDTv2, type DocumentRepo, type DocumentStore, type NodeId, type OpenDocument, type PartId, type PartOp, type PeerId, type RichTextValue } from '@staticflux/document/v2';
import { type Actor, createPartsDocument, createSessionLayer, createStage, createStaticAssets, createUndoService, type SessionLayer, type Stage, stageWriteGuard, type UndoService } from '@staticflux/stage';
import type { EditTarget } from '../elements/actions.js';
import { type BrandKitSpec, type BrandKitView, brandKitOps, brandRuleGuard, composeGuards, elementStageRules, readBrandKit, stageRuleContext } from '../elements/brand-kit.js';
import type { GeometryService } from '../elements/geometry.js';
import { type LibraryDocument, openLibraryDocument } from '../library/library-doc.js';
import { COMPOSITION_KIND, PAGE_KIND, STRUCTURE_PATHS } from '../lenses/structure.js';
import type { RepeatContext } from '../repeat/actions.js';
import { createRepeatStage, type RepeatStage } from '../repeat/stage.js';
import { TEXT_MARK_EXPAND } from '../text/model.js';
import { DocumentOpenError } from './errors.js';

export interface StudioWorkspace {
  readonly store: DocumentStore;
  readonly engine: CrdtEngine;
  readonly repo: DocumentRepo;
  readonly blobs: BlobStore;
  readonly library: LibraryDocument;
}

export interface WorkspaceOptions {
  readonly store?: DocumentStore;
  readonly blobs?: BlobStore;
  readonly signal: AbortSignal;
}

const failed = (step: string, cause: SfError): Result<never> => err(DocumentOpenError({ cause, details: { step } }));

let peers = 0;
const freshPeer = (): PeerId => `${Date.now() % 1_000_000_000}${(peers += 1)}` as PeerId;

/** Open the workspace (store, engine, repo, blobs, library document). */
export async function openStudioWorkspace(options: WorkspaceOptions): Promise<Result<StudioWorkspace>> {
  const store = options.store ?? createMemoryDocumentStore();
  const engine = createLoroEngine({ marks: TEXT_MARK_EXPAND });
  const repo = createDocumentRepo({ store, engine, peer: freshPeer });
  const library = await openLibraryDocument(repo, options.signal);
  if (!library.ok) return failed('library document', library.error);
  return ok({ store, engine, repo, blobs: options.blobs ?? createBlobStore(createMemoryObjectStore()), library: library.value });
}

/** The demo brand kit (Clean Pop's palette as brand tokens; the Brand panel arrives later). */
export const STUDIO_BRAND: BrandKitSpec = Object.freeze({
  tokens: { primary: '#ff5c39', ink: '#16151a', paper: '#fffaf3', accent: '#3b6cff', 'radius-md': 12 },
  classes: {},
  rules: [],
});

export const KIT_ASSET = 'as_brand';
export const ROOT_PART: PartId = 'root';
export const pagePart = (page: NodeId): PartId => `page:${page}`;

export interface StudioPageRef {
  readonly id: NodeId;
  readonly part: PartId;
}

export interface CreateStudioDocumentOptions {
  readonly asset: string;
  readonly title: string;
  readonly pages?: number;
  readonly size?: { readonly width: number; readonly height: number };
  readonly signal: AbortSignal;
}

const SEED = { actor: { kind: 'system', id: 'instaflow/studio' }, label: 'New design' } as const;

/** Create a new document: composition + `pages` page stubs in the root part, one part per page (D14). */
export async function createStudioDocument(workspace: StudioWorkspace, options: CreateStudioDocumentOptions): Promise<Result<OpenDocument>> {
  const pages = Array.from({ length: Math.max(1, options.pages ?? 1) }, (_, i) => `p${i + 1}`);
  const size = options.size ?? { width: 1080, height: 1350 };
  const created = await workspace.repo.create(options.asset, { treeSchema: 1, parts: [ROOT_PART, ...pages.map(pagePart)] }, options.signal);
  if (!created.ok) return failed('create document', created.error);
  const doc = created.value;
  for (const id of [ROOT_PART, ...pages.map(pagePart)]) {
    const part = await doc.part(id, options.signal);
    if (!part.ok) return failed(`load part ${id}`, part.error);
  }
  const gap = 120;
  const root: PartOp[] = [
    { op: 'create', node: 'composition', kind: COMPOSITION_KIND, parent: null, props: { name: options.title, [STRUCTURE_PATHS.format]: { width: size.width, height: size.height } } },
    ...pages.map((id, i): PartOp => ({ op: 'create', node: id, kind: PAGE_KIND, parent: 'composition', props: { name: `Page ${i + 1}`, [STRUCTURE_PATHS.pageSize]: { ...size }, [STRUCTURE_PATHS.pageCanvas]: [i * (size.width + gap), 0] } })),
  ];
  const changes: Record<PartId, PartOp[]> = { [ROOT_PART]: root };
  for (const id of pages) changes[pagePart(id)] = [{ op: 'create', node: id, kind: PAGE_KIND, parent: null, props: { name: '', [STRUCTURE_PATHS.pageSize]: { ...size } } }];
  const seeded = await doc.transact(SEED, changes, options.signal);
  if (!seeded.ok) return failed('seed document', seeded.error);
  return ok(doc);
}

export interface StudioDocumentOptions {
  readonly workspace: StudioWorkspace;
  readonly doc: OpenDocument;
  readonly geometry: GeometryService;
  readonly brand?: BrandKitSpec;
  readonly signal: AbortSignal;
  /** Everything is disposed with it (rule 5). */
  readonly scope: Scope;
}

export interface StudioDocument {
  readonly doc: OpenDocument;
  readonly root: DocumentCRDTv2;
  readonly pages: readonly StudioPageRef[];
  /** The composed stage (B1 rules, brand kit) and B7's repeat view over it. */
  readonly base: Stage;
  readonly view: RepeatStage;
  readonly session: SessionLayer;
  readonly undo: UndoService;
  readonly kit: BrandKitView;
  readonly geometry: GeometryService;
  /** The loaded part of a page. */
  part(page: NodeId): DocumentCRDTv2 | undefined;
  /** B1's commit target for a page (over the repeat view). */
  target(page: NodeId): EditTarget;
  /** B1/B7 action context (fresh ids from `newId`). */
  context(): RepeatContext;
  newId(): NodeId;
  /** Commit raw ops on a page as one undo step (text edits; element edits use `target`). Same `changeSet`: same step. */
  commitOps(page: NodeId, actor: Actor, label: string, ops: readonly PartOp[], options?: { readonly changeSet?: string }): Result<void>;
}

/** Open an existing Studio document: attach its page parts to one stage, repeat view and undo service. */
export async function openStudioDocument(options: StudioDocumentOptions): Promise<Result<StudioDocument>> {
  const { doc, geometry, signal, scope } = options;
  const root = await doc.part(ROOT_PART, signal);
  if (!root.ok) return failed('root part', root.error);
  const pages: StudioPageRef[] = root.value
    .children('composition')
    .filter((id) => root.value.node(id)?.kind === PAGE_KIND)
    .map((id) => ({ id, part: pagePart(id) }));
  const parts = createPartsDocument(doc.asset);
  const loaded = new Map<NodeId, DocumentCRDTv2>();
  for (const page of pages) {
    const part = await doc.part(page.part, signal);
    if (!part.ok) return failed(`page part ${page.part}`, part.error);
    loaded.set(page.id, part.value);
    scope.defer(parts.attach(part.value, { id: page.part }));
  }
  const kitPart = options.workspace.engine.create({ peer: freshPeer() });
  const seededKit = kitPart.transact(SEED, brandKitOps(options.brand ?? STUDIO_BRAND));
  if (!seededKit.ok) return failed('brand kit', seededKit.error);
  scope.defer(() => kitPart.dispose());
  const kitDoc = createPartsDocument(KIT_ASSET);
  kitDoc.attach(kitPart, { id: ROOT_PART });
  const kit = readBrandKit(kitDoc);
  const session = createSessionLayer();
  const base = createStage({ root: parts, session, assets: createStaticAssets({ [KIT_ASSET]: kitDoc }), rules: elementStageRules({ asset: KIT_ASSET }) });
  scope.defer(() => base.dispose());
  const undo = createUndoService({ doc, guard: composeGuards(stageWriteGuard(base), brandRuleGuard(() => stageRuleContext(base, kit))) });
  scope.defer(() => undo.dispose());
  const view = createRepeatStage({ stage: base, geometry, kit, scope });
  /** Rich texts of a node from its page part (B2 content; `duplicate` copies them). */
  const texts = (node: NodeId): Readonly<Record<string, RichTextValue>> | undefined => {
    const part = [...loaded.values()].find((p) => p.has(node));
    const record = part?.node(node);
    if (part === undefined || record === undefined || record.texts.length === 0) return undefined;
    const out: Record<string, RichTextValue> = {};
    for (const path of record.texts) {
      const value = part.text(node, path);
      if (value !== undefined) out[path] = value;
    }
    return out;
  };
  let ids = 0;
  const salt = doc.peer.slice(-4);
  const newId = (): NodeId => `n${salt}_${(ids += 1).toString(36)}`;
  const studio: StudioDocument = {
    doc,
    root: root.value,
    pages,
    base,
    view,
    session,
    undo,
    kit,
    geometry,
    part: (page) => loaded.get(page),
    target: (page) => ({ undo, stage: view, part: pagePart(page) }),
    context: () => ({ stage: view, geometry, kit, newId, texts }),
    newId,
    commitOps(page, actor, label, ops, options = {}) {
      if (ops.length === 0) return ok();
      const checked = view.checkWrite(ops, { actor });
      if (!checked.ok) return checked;
      const committed = undo.commit(actor, label, { [pagePart(page)]: ops }, options.changeSet === undefined ? {} : { changeSet: options.changeSet });
      return committed.ok ? ok() : committed;
    },
  };
  return ok(studio);
}


