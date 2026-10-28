/**
 * Studio over the persistent workspace (C0; IF-28.28–28.29): what the Studio page boots between the URL and the
 * mounted editor. Store side on main.
 *
 * 1. The workspace (`openStudioWorkspace`) over the persistent store, wrapped by `observeStoreWrites` so every write
 *    of a design's document marks it edited in the Home index.
 * 2. `planStudioDocument` for the URL's intent (open, new from a format or a template, the dev demo).
 * 3. `createStudioApp` (workers, editor, chrome) with the Home link (`homeHref`, flush then leave) and "Save as
 *    template" (`saveAsTemplate` + a library entry).
 * 4. The design is listed in the library once the editor has it (`listDesign`), the Home index writer starts, and a
 *    new design's URL becomes `/s/:asset`.
 * 5. #64: the design's cover (Home's card preview, `design-cover.ts`) is rendered when missing, after edits go quiet
 *    and on leaving (before the index is flushed, so Home opens with it).
 *
 * B11c: before step 2, Home's journal is drained into the library (`home-journal-drain.ts`: renames, moves, trash,
 * duplicates and imports made on Home), so a design opens as Home showed it; it drains again whenever Home pings
 * `HOME_JOURNAL_CHANNEL` or the tab becomes visible, and pings Home after each index write.
 */
import type { BlobStore } from '@staticflux/blob';
import { ok, type Result, type Scope, watch } from '@staticflux/core';
import type { DocumentStore } from '@staticflux/document/v2';
import { openStudioWorkspace, type StudioWorkspace } from '../app/document.js';
import { createStudioApp, type StudioApp, type StudioAppOptions } from '../app/studio-app.js';
import { homeHref, type StudioIntent, studioHref } from '../home/routes.js';
import type { AssetId } from '../library/records.js';
import { HOME_JOURNAL_CHANNEL } from '../home/journal.js';
import { createLibrary } from '../library/library.js';
import { duplicateDesign } from './duplicate.js';
import { createHomeIndexWriter, type HomeIndexWriter, type HomeIndexWriterOptions, observeStoreWrites, projectHomeIndex, writeHomeIndex } from './home-index-writer.js';
import { createDesignCover, type DesignCover, type DesignCoverOptions } from './design-cover.js';
import { createHomeJournalDrain, type HomeJournalDrain } from './home-journal-drain.js';
import { listDesign, type PlannedDocument, planStudioDocument } from './studio-document.js';
import { saveAsTemplate } from './templates.js';

export interface StudioSessionOptions extends Omit<StudioAppOptions, 'workspace' | 'document' | 'templates' | 'leave' | 'homeHref' | 'scope'> {
  /** What the URL asks for (`readStudioIntent`). */
  readonly intent: StudioIntent;
  /** The workspace's persistent document store. */
  readonly documents: DocumentStore;
  readonly blobs?: BlobStore;
  /** Leave for Home (default `location.assign`), after Latest and the Home index are flushed. */
  readonly navigate?: (href: string) => void;
  /** Replace the page URL (a new design becomes `/s/:asset`; default `history.replaceState`). */
  readonly replaceUrl?: (href: string) => void;
  readonly newAssetId?: () => AssetId;
  readonly now?: () => number;
  /** Home index writer timing (tests). */
  readonly index?: Pick<HomeIndexWriterOptions, 'debounceMs' | 'timers'>;
  /** Cover timing (tests). */
  readonly cover?: Pick<DesignCoverOptions, 'idleMs' | 'leaveWaitMs' | 'timers'>;
  /** Where Home and Studio ping each other (default: a `BroadcastChannel` on `HOME_JOURNAL_CHANNEL` when the platform has one). */
  readonly channel?: HomeChannel | null;
  readonly scope: Scope;
}

/** Structurally a `BroadcastChannel` (only what the session uses). */
export interface HomeChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: () => void): void;
  close(): void;
}

/** The default channel, or undefined without `BroadcastChannel`. */
export function browserHomeChannel(): HomeChannel | undefined {
  const Channel = (globalThis as { BroadcastChannel?: new (name: string) => HomeChannel }).BroadcastChannel;
  return Channel === undefined ? undefined : new Channel(HOME_JOURNAL_CHANNEL);
}

export interface StudioSession {
  readonly app: StudioApp;
  readonly plan: PlannedDocument;
  readonly index: HomeIndexWriter;
  /** #64: the design's cover (undefined without an exporter). */
  readonly cover: DesignCover | undefined;
  readonly workspace: StudioWorkspace;
  /** Home's journal drain (run it to apply what Home wrote; the session runs it on pings and visibility). */
  readonly drain: HomeJournalDrain;
}

let ids = 0;
/** A fresh asset id (time + counter + random: unique across tabs and reloads). */
export const freshAssetId = (): AssetId => `as_${Date.now().toString(36)}${(ids += 1).toString(36)}${Math.random().toString(36).slice(2, 7)}` as AssetId;

/** Boot Studio for `intent` over the persistent workspace (see the module header). */
export async function openStudioSession(options: StudioSessionOptions): Promise<Result<StudioSession>> {
  const { scope, intent, documents, person } = options;
  const signal = scope.signal;
  const now = options.now ?? (() => Date.now());
  const newAssetId = options.newAssetId ?? freshAssetId;
  let edited: (asset: string) => void = () => undefined;
  const store = observeStoreWrites(documents, (asset) => edited(asset));
  const workspace = await openStudioWorkspace({ signal, store, ...(options.blobs === undefined ? {} : { blobs: options.blobs }) });
  if (!workspace.ok) return workspace;
  let index: HomeIndexWriter | undefined;
  let cover: DesignCover | undefined;
  // B11c: what Home changed while Studio was closed reaches the library first (one library over the same document).
  const lib = workspace.value.library;
  const homeLibrary = createLibrary({ source: { part: lib.part, commit: (meta, changes) => lib.doc.commit(meta, changes) }, actor: () => person, now });
  scope.defer(() => homeLibrary.dispose());
  const drain = createHomeJournalDrain({
    store: documents,
    library: homeLibrary,
    duplicate: (request, s) => duplicateDesign({ store, engine: workspace.value.engine, repo: workspace.value.repo, actor: person, now }, request, s),
    // Durable library first, then the index (Home must never see a change undone between the two).
    async flushIndex(s) {
      const durable = await lib.doc.flush(s);
      if (!durable.ok) return durable;
      if (index !== undefined) return index.flush(s);
      const written = await writeHomeIndex(documents, (current) => projectHomeIndex(homeLibrary.entries(), current), s);
      return written.ok ? ok() : written;
    },
    onProblem: (error, op) => console.warn(`[home journal] ${op.kind}: ${error.code} ${error.message}`),
  });
  const drained = await drain.run(signal);
  if (!drained.ok) console.warn(`[home journal] ${drained.error.code} ${drained.error.message}`);
  const plan = await planStudioDocument(intent, { store, engine: workspace.value.engine, library: workspace.value.library.part, actor: person, newAssetId, now }, signal);
  if (!plan.ok) return plan;

  let app: StudioApp | undefined;
  const home = homeHref();
  const { intent: _intent, documents: _documents, blobs: _blobs, navigate, replaceUrl, newAssetId: _newAssetId, now: _now, index: indexTiming, cover: coverTiming, channel: _channel, ...appOptions } = options;
  const created = await createStudioApp({
    ...appOptions,
    // B11c: where the URL points within the design (applied once the canvas shows, NAVIGATION §6).
    ...(intent.kind === 'open' && intent.link !== undefined ? { link: intent.link } : {}),
    workspace: workspace.value,
    document: plan.value.ref,
    homeHref: home.ok ? home.value : '/',
    leave: async (href) => {
      // #64: the cover lands in the library (durably) before the index Home opens with.
      if (cover !== undefined) {
        const covered = await cover.flush();
        if (covered.ok) await lib.doc.flush(signal);
      }
      await index?.flush();
      (navigate ?? ((h: string) => globalThis.location.assign(h)))(href);
    },
    templates: {
      async save({ milestone, title }, s) {
        const asset = newAssetId();
        const saved = await saveAsTemplate({ store, engine: workspace.value.engine, repo: workspace.value.repo, actor: person }, { source: { asset: plan.value.ref.asset, milestone }, asset, title }, s);
        if (!saved.ok) return saved;
        const listed = (app as StudioApp).library.add({ asset, kind: 'template', title, createdAt: new Date(now()).toISOString() });
        if (!listed.ok) return listed;
        if (plan.value.format !== undefined) index?.describe(asset, { format: plan.value.format });
        await index?.flush();
        return ok({ asset });
      },
    },
    scope,
  });
  if (!created.ok) return created;
  app = created.value;
  const listed = listDesign(app.library, plan.value);
  if (!listed.ok) return listed;
  const channel = options.channel === undefined ? browserHomeChannel() : (options.channel ?? undefined);
  if (channel !== undefined) scope.defer(() => channel.close());
  index = createHomeIndexWriter({
    store: documents,
    library: app.library,
    scope,
    now,
    ...(indexTiming ?? {}),
    onProblem: (error) => console.warn(`[home index] ${error.code} ${error.message}`),
    onWritten: () => channel?.postMessage({ kind: 'index' }),
  });
  if (plan.value.format !== undefined) index.describe(plan.value.ref.asset, { format: plan.value.format });
  const writer = index;
  const design = plan.value.ref.asset;
  const render = app.cover;
  if (render !== undefined) {
    cover = createDesignCover({ asset: design as AssetId, render, blobs: workspace.value.blobs, library: app.library, scope, ...(coverTiming ?? {}), onProblem: (error) => console.warn(`[cover] ${error.code} ${error.message}`) });
  }
  const covering = cover;
  edited = (asset) => {
    writer.touch(asset);
    if (asset === design) covering?.touch();
  };
  // B11c: Home's meta line shows the page count (`Edited 2 min ago · 3 pages`).
  const shown = app;
  watch(
    () => shown.scene.pages,
    (pages) => (pages > 0 ? writer.describe(plan.value.ref.asset, { pages }) : undefined),
    { scope, fireImmediately: true },
  );
  if (plan.value.created) {
    const href = studioHref(plan.value.ref.asset);
    if (href.ok) (replaceUrl ?? ((h: string) => globalThis.history.replaceState(null, '', h)))(href.value);
  }
  // Home wrote (another tab), or this tab came back: apply it now.
  const again = (): void => {
    void drain.run(signal);
  };
  channel?.addEventListener('message', again);
  const doc = (globalThis as { document?: Document }).document;
  doc?.addEventListener('visibilitychange', () => (doc.visibilityState === 'visible' ? again() : undefined), { signal });
  return ok({ app, plan: plan.value, index, cover, workspace: workspace.value, drain });
}
