/**
 * Which document Studio opens (C0; IF-28.28): Studio's URL (`readStudioIntent`) becomes a `StudioDocumentRef` for the
 * editor plus the library listing to add once the editor has the document. Store side (main), before the workers boot.
 *
 * | URL | Document | Listing |
 * |---|---|---|
 * | `/s/:asset` | the existing design (IF-HOME-002 when the workspace has no such document) | added if the library lacks it |
 * | `/new?format=…` | a new, empty design of that format, a fresh asset id | a new `composition` entry |
 * | `/new?template=…` | B5 New document from the template's newest milestone | a new `composition` entry |
 * | anything else (`/dev/studio/`) | the dev demo document (`as_demo`, two pages), created on first use | added if missing |
 *
 * A new design is listed only after the editor opened it (`listDesign`), so a failed boot never leaves an entry that
 * points at nothing.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { CrdtEngine, DocumentStore } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { DesignOpenError, UnknownDesignError, UnknownTemplateError } from '../home/errors.js';
import { CUSTOM_FORMAT, DEFAULT_DESIGN_FORMAT, designFormat } from '../home/formats.js';
import { type DesignSize, readHomeIndex } from '../home/index-record.js';
import type { StudioIntent } from '../home/routes.js';
import type { Library } from '../library/library.js';
import { LIBRARY_ASSET, type LibraryEntry, type LibraryPartReader, type NewLibraryEntry, readLibraryEntry } from '../library/library-doc.js';
import type { AssetId } from '../library/records.js';
import type { StudioDocumentRef } from '../workers/protocol.js';
import { newDocumentFromTemplate } from './templates.js';

/** The dev entry's demo document (B8's: two pages, created on first use). */
export const DEMO_DOCUMENT: StudioDocumentRef = Object.freeze({ asset: 'as_demo', title: 'Night Market Flyer', create: Object.freeze({ pages: 2 }) });
/** The title of a new design until the person renames it. */
export const UNTITLED_DESIGN = 'Untitled design';

export interface PlannedDocument {
  readonly ref: StudioDocumentRef;
  /** The library entry to add once the editor opened the document (undefined: already listed). */
  readonly listing: NewLibraryEntry | undefined;
  /** The page size, when known (Home's preview). */
  readonly format: DesignSize | undefined;
  /** True when Studio made a new asset (the URL becomes `/s/:asset`). */
  readonly created: boolean;
}

export interface PlanContext {
  readonly store: DocumentStore;
  readonly engine: CrdtEngine;
  /** The library document's part (reads only). */
  readonly library: LibraryPartReader;
  readonly actor: Actor;
  readonly newAssetId: () => AssetId;
  readonly now?: () => number;
}

const listingFor = (entry: LibraryEntry | undefined, asset: string, title: string, now: number): NewLibraryEntry | undefined =>
  entry === undefined ? { asset: asset as AssetId, kind: 'composition', title, createdAt: new Date(now).toISOString() } : undefined;

/** The Home index entry's format for an asset (templates and designs made earlier). */
async function knownFormat(store: DocumentStore, asset: string, signal: AbortSignal): Promise<DesignSize | undefined> {
  const head = await store.readHead(LIBRARY_ASSET, signal);
  return head.ok ? readHomeIndex(head.value).entries.find((e) => e.asset === asset)?.format : undefined;
}

type Planner = (intent: StudioIntent, context: PlanContext, signal: AbortSignal) => Promise<Result<PlannedDocument>>;

/** One planner per intent kind (data, not a branch). */
const PLANNERS: Readonly<Record<StudioIntent['kind'], Planner>> = {
  async open(intent, context, signal) {
    const asset = (intent as Extract<StudioIntent, { kind: 'open' }>).asset;
    const head = await context.store.readHead(asset, signal);
    if (!head.ok) return err(DesignOpenError({ cause: head.error, details: { step: 'read head', asset } }));
    const entry = readLibraryEntry(context.library, asset);
    // B11c: `trashed` tells the fallback page to offer Restore (NAVIGATION §4).
    if (head.value === undefined || entry?.trashedAt !== undefined) return err(UnknownDesignError({ details: { asset, trashed: head.value !== undefined && entry?.trashedAt !== undefined, title: entry?.title ?? null } }));
    const title = entry?.title ?? UNTITLED_DESIGN;
    return ok({ ref: { asset, title }, listing: listingFor(entry, asset, title, (context.now ?? Date.now)()), format: await knownFormat(context.store, asset, signal), created: false });
  },
  async new(intent, context, signal) {
    const { format, template, size, pages, name, background } = intent as Extract<StudioIntent, { kind: 'new' }>;
    const now = (context.now ?? Date.now)();
    const asset = context.newAssetId();
    if (template !== undefined) {
      const source = readLibraryEntry(context.library, template);
      if (source?.kind !== 'template' || source.trashedAt !== undefined) return err(UnknownTemplateError({ details: { template } }));
      const title = name ?? source.title;
      const made = await newDocumentFromTemplate({ store: context.store, engine: context.engine, actor: context.actor }, { template, asset, title }, signal);
      if (!made.ok) return made;
      return ok({ ref: { asset, title }, listing: listingFor(undefined, asset, title, now), format: await knownFormat(context.store, template, signal), created: true });
    }
    // B11b: a custom size from New design (the route already checked it), else the format's; pages, name, background.
    const chosen = designFormat(format === CUSTOM_FORMAT ? DEFAULT_DESIGN_FORMAT : (format ?? DEFAULT_DESIGN_FORMAT));
    const pageSize = format === CUSTOM_FORMAT && size !== undefined ? size : chosen.size;
    const title = name ?? UNTITLED_DESIGN;
    return ok({
      ref: { asset, title, create: { pages: pages ?? chosen.pages, size: { ...pageSize }, ...(background === undefined ? {} : { background }) } },
      listing: listingFor(undefined, asset, title, now),
      format: pageSize,
      created: true,
    });
  },
  async demo(_intent, context) {
    const entry = readLibraryEntry(context.library, DEMO_DOCUMENT.asset);
    return ok({ ref: DEMO_DOCUMENT, listing: listingFor(entry, DEMO_DOCUMENT.asset, DEMO_DOCUMENT.title, (context.now ?? Date.now)()), format: designFormat(DEFAULT_DESIGN_FORMAT).size, created: false });
  },
};

/** Plan the document for a Studio URL (see the module header). */
export function planStudioDocument(intent: StudioIntent, context: PlanContext, signal: AbortSignal): Promise<Result<PlannedDocument>> {
  return PLANNERS[intent.kind](intent, context, signal);
}

/** List the planned document in the library (after the editor opened it); a no-op when it is already listed. */
export function listDesign(library: Pick<Library, 'entry' | 'add'>, plan: Pick<PlannedDocument, 'listing'>): Result<void> {
  if (plan.listing === undefined || library.entry(plan.listing.asset) !== undefined) return ok();
  const added = library.add(plan.listing);
  return added.ok ? ok() : err(DesignOpenError({ cause: added.error, details: { step: 'list design', asset: plan.listing.asset } }));
}
