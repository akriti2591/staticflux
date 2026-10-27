/**
 * The Home model (C0; IF-28.12–28.16; B11c IF-36.35–36.40): headless state and actions behind `<if-home>`. It reads the
 * Home index from the workspace store with Home's journal applied on top (no document engine, D17), derives recents,
 * files, templates, projects and the trash, and runs Home's capabilities (D18) through one registry, the same pipeline
 * agents use.
 *
 * - **Opening** actions (new design, open, use template) resolve to a Studio href; the host navigates.
 * - **File operations** (rename, duplicate, move to project, favourite, trash, restore, delete forever, the project
 *   operations) append one op to Home's journal (`journal.ts`) and show at once (the op is applied to the index here);
 *   Studio applies them to the library the next time it opens or hears Home.
 * - **Import** (`importFiles`) stores each file's bytes and record in the blob store through the lazily loaded importer
 *   (`importer.ts`), then journals one `import` op per file.
 * - **Pages** (`view`): Home, Files (`/files?q=`), a project (`/p/:name`) and the trash (`/trash`) are one boot; `go`
 *   pushes history through the host, `show` follows Back and Forward.
 *
 * Lifecycle `instaflow/home` (LIFECYCLES §30): loading → ready | failed; ready | failed → loading (`refresh`: the page
 * came back from the back/forward cache, the tab became visible, Studio pinged, "Try again"); any → disposed.
 */
import { alwaysActivePort, allowAllDecidePort, type CapabilityRegistry, createCapabilityRegistry, failClosedConfirmPort, implementCapability, unmeteredPort } from '@staticflux/capabilities';
import { box, createMachine, defineMachine, err, ok, type Result, type SfError } from '@staticflux/core';
import type { DocumentStore } from '@staticflux/document/v2';
import { assetKindOf, type LibraryAssetKind, mediaTypeOf } from '../library/kinds.js';
import { LIBRARY_ASSET } from '../library/library-doc.js';
import {
  DeleteForeverCapability,
  DeleteProjectCapability,
  DuplicateDesignCapability,
  FavoriteCapability,
  HOME_CAPABILITIES,
  HOME_QUICK_ACTIONS,
  type HomeActionOutput,
  type HomeQuickAction,
  MoveToProjectCapability,
  NewDesignCapability,
  type NewDesignInput,
  NewProjectCapability,
  OpenDesignCapability,
  RenameDesignCapability,
  RenameProjectCapability,
  RestoreDesignsCapability,
  SearchFilesCapability,
  TrashDesignsCapability,
  UseTemplateCapability,
} from './capabilities.js';
import { CustomSizeError, HomeImportError, HomeIndexReadError, HomeNameError, HomeRouteError, UnknownDesignError, UnknownProjectError, UnknownTemplateError } from './errors.js';
import { CUSTOM_FORMAT, type DesignFormatId } from './formats.js';
import { EMPTY_HOME_INDEX, type HomeEntry, type HomeIndex, type ProjectSummary, readHomeIndex, recentDesigns, trashedFiles, workspaceFiles, workspaceProjects, workspaceTemplates } from './index-record.js';
import { appendHomeOps, HOME_JOURNAL_ASSET, homeOp, type HomeOp, type HomeOpBody, type ImportedMedia, overlayJournal, readHomeJournal } from './journal.js';
import { type HomeView, homeViewHref, newDesignHref, studioHref } from './routes.js';

export const HomeMachine = /* @__PURE__ */ defineMachine({
  id: 'instaflow/home',
  initial: 'loading',
  states: ['loading', 'ready', 'failed', 'disposed'],
  transitions: {
    loading: { loaded: 'ready', fail: 'failed', dispose: 'disposed' },
    ready: { refresh: 'loading', dispose: 'disposed' },
    failed: { refresh: 'loading', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type HomeState = (typeof HomeMachine.states)[number];

/** Where the Home index comes from (structurally the workspace `DocumentStore`'s head read). */
export interface HomeIndexSource {
  read(signal: AbortSignal): Promise<Result<HomeIndex>>;
}

/** Where Home's file operations go (the journal in the workspace store). */
export interface HomeJournalWriter {
  append(ops: readonly HomeOp[], signal: AbortSignal): Promise<Result<void>>;
}

/** The Home index stored in the library head of `store`, with Home's pending journal on top (no head: empty). */
export function storeIndexSource(store: Pick<DocumentStore, 'readHead'>): HomeIndexSource {
  return {
    async read(signal) {
      const head = await store.readHead(LIBRARY_ASSET, signal);
      if (!head.ok) return err(HomeIndexReadError({ cause: head.error }));
      const journal = await store.readHead(HOME_JOURNAL_ASSET, signal);
      if (!journal.ok) return err(HomeIndexReadError({ cause: journal.error }));
      return ok(overlayJournal(readHomeIndex(head.value), readHomeJournal(journal.value)));
    },
  };
}

/** The journal in `store`; `ping` tells Studio tabs to apply it (a `BroadcastChannel` post). */
export function storeJournalWriter(store: Pick<DocumentStore, 'readHead' | 'writeHead'>, ping?: () => void): HomeJournalWriter {
  return {
    async append(ops, signal) {
      const done = await appendHomeOps(store, ops, signal);
      if (!done.ok) return done;
      ping?.();
      return ok();
    },
  };
}

/** Stores one imported file's bytes and record (`importer.ts`), lazily loaded on the first import. */
export interface HomeImporter {
  /** Store `file` as asset `asset` (its record names the id). */
  importFile(file: File, asset: string, signal: AbortSignal): Promise<Result<Omit<ImportedMedia, 'folder'>>>;
}

/** What Home asks of the page. */
export interface HomeHost {
  /** Go to a Studio href (a full navigation: Studio is another boot). */
  navigate(href: string): void;
  /** Show another Home page (`history.pushState`); default: a full navigation. */
  push?(href: string): void;
}

export interface HomeModelOptions {
  readonly source: HomeIndexSource;
  readonly host: HomeHost;
  /** Everything stops with it (rule 5). */
  readonly signal: AbortSignal;
  /** Where file operations go (default: nowhere — the operations fail with the cause). */
  readonly journal?: HomeJournalWriter;
  /** The importer, loaded on first use. */
  readonly importer?: () => Promise<HomeImporter>;
  /** The page shown first (default Home). */
  readonly view?: HomeView;
  readonly now?: () => number;
  readonly newAssetId?: () => string;
  /** The registry Home's capabilities go in (default: a local one with the default ports). */
  readonly capabilities?: CapabilityRegistry;
}

/** One file an import could not take, and why (person-facing). */
export interface SkippedFile {
  readonly name: string;
  readonly reason: 'unsupported' | 'video' | 'failed';
  readonly error?: SfError;
}

export interface ImportSummary {
  /** Listed now (in order). */
  readonly imported: readonly HomeEntry[];
  /** Already in the workspace (same content): their entries. */
  readonly existing: readonly HomeEntry[];
  readonly skipped: readonly SkippedFile[];
}

export interface HomeModel {
  /** Reactive. */
  readonly state: HomeState;
  /** Why the last read failed (reactive). */
  readonly error: SfError | undefined;
  /** The last index read, with this page's own operations applied (reactive; empty until the first read). */
  readonly index: HomeIndex;
  /** The page shown (reactive). */
  readonly view: HomeView;
  recents(): readonly HomeEntry[];
  files(): readonly HomeEntry[];
  templates(): readonly HomeEntry[];
  projects(): readonly ProjectSummary[];
  trashed(): readonly HomeEntry[];
  /** Any entry, live or trashed. */
  entry(asset: string): HomeEntry | undefined;
  /** Live files whose title or project contains `query` (case-insensitive). */
  search(query: string): readonly HomeEntry[];
  readonly quickActions: readonly HomeQuickAction[];
  readonly capabilities: CapabilityRegistry;
  /** Studio href for an entry (designs open, templates start a new design); undefined for media. */
  hrefOf(entry: HomeEntry): string | undefined;
  /** Read the index again. */
  refresh(): Promise<Result<HomeIndex>>;
  /** Show a Home page and push it to history. */
  go(view: HomeView): void;
  /** Show a Home page (Back / Forward: history already moved). */
  show(view: HomeView): void;
  /** A format id, or the New design dialog's full choice (a custom size, pages, name, background). */
  newDesign(request?: DesignFormatId | NewDesignInput): Promise<Result<HomeActionOutput>>;
  open(asset: string): Promise<Result<HomeActionOutput>>;
  /** `name`: the new design's title (New design › Name). */
  useTemplate(template: string, name?: string): Promise<Result<HomeActionOutput>>;
  runQuickAction(action: HomeQuickAction): Promise<Result<HomeActionOutput>>;
  rename(asset: string, title: string): Promise<Result<void>>;
  /** The copy's id and title. */
  duplicate(asset: string): Promise<Result<{ readonly asset: string; readonly title: string }>>;
  /** `project: ''` = No project. */
  move(assets: readonly string[], project: string): Promise<Result<void>>;
  favorite(asset: string, favorite: boolean): Promise<Result<void>>;
  trash(assets: readonly string[]): Promise<Result<void>>;
  restore(assets: readonly string[]): Promise<Result<void>>;
  deleteForever(assets: readonly string[]): Promise<Result<void>>;
  newProject(name: string): Promise<Result<void>>;
  renameProject(name: string, to: string): Promise<Result<void>>;
  deleteProject(name: string): Promise<Result<void>>;
  /** Import files into the workspace (`project`: where they land; default No project). */
  importFiles(files: readonly File[], options?: { readonly project?: string; readonly signal?: AbortSignal }): Promise<Result<ImportSummary>>;
  dispose(): void;
}

/** Where each kind of entry leads (data, not a branch): designs open, templates start a design; media have no page yet. */
export const ENTRY_HREFS: Readonly<Partial<Record<LibraryAssetKind, (asset: string) => Result<string>>>> = Object.freeze({
  composition: (asset: string) => studioHref(asset),
  template: (asset: string) => newDesignHref({ template: asset }),
});

/** Design titles (`validateTitle`'s rule) and project names (one folder segment). */
export const HOME_NAME_LIMITS = Object.freeze({ title: 200, project: 60 });

/** A trimmed name within `max` characters (and no `/` for a project), or IF-POL-056. */
export function validateHomeName(name: string, max: number, project = false): Result<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > max || (project && trimmed.includes('/'))) return err(HomeNameError({ details: { max, project } }));
  return ok(trimmed);
}

/** The copy's title: `<title> copy` (within the title limit). */
export function copyTitle(title: string): string {
  const suffix = ' copy';
  return `${title.slice(0, HOME_NAME_LIMITS.title - suffix.length)}${suffix}`;
}

/** Live files whose title or project contains `query` (case-insensitive; empty query: none). */
export function searchEntries(entries: readonly HomeEntry[], query: string): readonly HomeEntry[] {
  const q = query.trim().toLocaleLowerCase();
  if (q.length === 0) return [];
  return entries.filter((e) => e.trashedAt === undefined && (e.title.toLocaleLowerCase().includes(q) || (e.folder?.toLocaleLowerCase().includes(q) ?? false)));
}

/** Why Home cannot import a file (undefined: it can). Video and audio have their own words (HOME-FILES §3.1). */
export function importRefusal(file: Pick<File, 'name' | 'type'>): SkippedFile['reason'] | undefined {
  const mime = mediaTypeOf(file.name, file.type);
  const kind = mime === undefined ? undefined : assetKindOf(mime);
  if (kind === 'video' || kind === 'audio') return 'video';
  return kind === 'image' || kind === 'vector' || kind === 'font' ? undefined : 'unsupported';
}

const built = (href: Result<string>): Result<string> => (href.ok ? href : err(HomeRouteError({ cause: href.error })));

let ids = 0;
/** A fresh asset id (time + counter + random: unique across tabs and reloads; Studio's `freshAssetId` shape). */
export const newHomeAssetId = (): string => `as_${Date.now().toString(36)}${(ids += 1).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Create the Home model and start the first read. */
export function createHomeModel(options: HomeModelOptions): HomeModel {
  const { source, host, signal } = options;
  const now = options.now ?? (() => Date.now());
  const newAssetId = options.newAssetId ?? newHomeAssetId;
  const machine = createMachine(HomeMachine);
  const index = box<HomeIndex>(EMPTY_HOME_INDEX);
  /** Ops this page wrote, in order: a read that started before a write is shown with the ops written since it started. */
  const mine: HomeOp[] = [];
  const error = box<SfError | undefined>(undefined);
  const view = box<HomeView>(options.view ?? { kind: 'home' });
  const live = (): HomeIndex => index.get();
  const find = (asset: string): HomeEntry | undefined => live().entries.find((e) => e.asset === asset);
  const design = (asset: string): HomeEntry | undefined => live().entries.find((e) => e.asset === asset && e.kind === 'composition' && e.trashedAt === undefined);
  const template = (asset: string): HomeEntry | undefined => live().entries.find((e) => e.asset === asset && e.kind === 'template' && e.trashedAt === undefined);

  const go = (href: Result<string>): Result<HomeActionOutput> => {
    const out = built(href);
    if (!out.ok) return out;
    host.navigate(out.value);
    return ok({ href: out.value });
  };

  /** Journal ops and show them now. */
  const write = async (bodies: readonly HomeOpBody[], s: AbortSignal = signal): Promise<Result<void>> => {
    if (options.journal === undefined) return err(HomeIndexReadError({ message: 'This Home has no workspace store to write to.' }));
    const ops = bodies.map((b) => homeOp(b, now()));
    const done = await options.journal.append(ops, s);
    if (!done.ok) return done;
    mine.push(...ops);
    index.set(overlayJournal(live(), ops));
    return ok();
  };
  const count = (n: number): Result<{ readonly count: number }> => ok({ count: n });
  const counted = async (r: Promise<Result<void>>, n: number): Promise<Result<{ readonly count: number }>> => {
    const done = await r;
    return done.ok ? count(n) : done;
  };
  /** Assets that exist (and are live, or trashed), else IF-HOME-002 naming the first unknown one. */
  const existing = (assets: readonly string[], state: 'live' | 'trashed' | 'any'): Result<readonly string[]> => {
    const unique = [...new Set(assets)];
    for (const asset of unique) {
      const e = find(asset);
      const fits = e !== undefined && (state === 'any' || (state === 'live') === (e.trashedAt === undefined));
      if (!fits) return err(UnknownDesignError({ details: { asset, state } }));
    }
    return ok(unique);
  };
  const projectNames = (): ReadonlySet<string> => new Set(workspaceProjects(live()).map((p) => p.name));

  const owned = options.capabilities === undefined;
  const capabilities =
    options.capabilities ??
    createCapabilityRegistry({ decide: allowAllDecidePort, confirm: failClosedConfirmPort, meter: unmeteredPort, activation: alwaysActivePort, declarations: [...HOME_CAPABILITIES] });
  const implementations = [
    implementCapability(NewDesignCapability, async (input) => {
      const custom = input.format === CUSTOM_FORMAT;
      if (custom && (input.width === undefined || input.height === undefined)) return err(CustomSizeError({ details: { width: input.width ?? null, height: input.height ?? null } }));
      return go(
        newDesignHref({
          ...(input.format === undefined ? {} : { format: input.format }),
          ...(custom && input.width !== undefined && input.height !== undefined ? { size: { width: input.width, height: input.height } } : {}),
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          ...(input.pages === undefined ? {} : { pages: input.pages }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.background === undefined ? {} : { background: input.background }),
        }),
      );
    }),
    implementCapability(OpenDesignCapability, async (input) => (design(input.asset) === undefined ? err(UnknownDesignError({ details: { asset: input.asset } })) : go(studioHref(input.asset)))),
    implementCapability(UseTemplateCapability, async (input) =>
      template(input.template) === undefined ? err(UnknownTemplateError({ details: { template: input.template } })) : go(newDesignHref({ template: input.template, ...(input.name === undefined ? {} : { name: input.name }) })),
    ),
    implementCapability(RenameDesignCapability, async (input, ctx) => {
      const title = validateHomeName(input.title, HOME_NAME_LIMITS.title);
      if (!title.ok) return title;
      const known = existing([input.asset], 'any');
      if (!known.ok) return known;
      if (find(input.asset)?.title === title.value) return count(0);
      return counted(write([{ kind: 'rename', asset: input.asset, title: title.value }], ctx.signal), 1);
    }),
    implementCapability(DuplicateDesignCapability, async (input, ctx) => {
      const source = find(input.asset);
      if (source === undefined || source.trashedAt !== undefined || (source.kind !== 'composition' && source.kind !== 'template')) return err(UnknownDesignError({ details: { asset: input.asset } }));
      const asset = newAssetId();
      const title = copyTitle(source.title);
      const done = await write([{ kind: 'duplicate', source: source.asset, asset, title, ...(source.folder === undefined ? {} : { folder: source.folder }) }], ctx.signal);
      return done.ok ? ok({ asset, title }) : done;
    }),
    implementCapability(MoveToProjectCapability, async (input, ctx) => {
      const project = input.project.trim();
      if (project.length > 0) {
        const valid = validateHomeName(project, HOME_NAME_LIMITS.project, true);
        if (!valid.ok) return valid;
      }
      const known = existing(input.assets, 'live');
      if (!known.ok) return known;
      const moving = known.value.filter((a) => (find(a)?.folder ?? '') !== project);
      if (moving.length === 0) return count(0);
      return counted(write([{ kind: 'move', assets: moving, folder: project }], ctx.signal), moving.length);
    }),
    implementCapability(FavoriteCapability, async (input, ctx) => {
      const known = existing([input.asset], 'live');
      if (!known.ok) return known;
      if ((find(input.asset)?.favorite === true) === input.favorite) return count(0);
      return counted(write([{ kind: 'favorite', asset: input.asset, favorite: input.favorite }], ctx.signal), 1);
    }),
    implementCapability(TrashDesignsCapability, async (input, ctx) => {
      const known = existing(input.assets, 'live');
      return known.ok ? counted(write([{ kind: 'trash', assets: known.value }], ctx.signal), known.value.length) : known;
    }),
    implementCapability(RestoreDesignsCapability, async (input, ctx) => {
      const known = existing(input.assets, 'trashed');
      return known.ok ? counted(write([{ kind: 'restore', assets: known.value }], ctx.signal), known.value.length) : known;
    }),
    implementCapability(DeleteForeverCapability, async (input, ctx) => {
      const known = existing(input.assets, 'trashed');
      return known.ok ? counted(write([{ kind: 'purge', assets: known.value }], ctx.signal), known.value.length) : known;
    }),
    implementCapability(NewProjectCapability, async (input, ctx) => {
      const name = validateHomeName(input.name, HOME_NAME_LIMITS.project, true);
      if (!name.ok) return name;
      if (projectNames().has(name.value)) return err(UnknownProjectError({ details: { name: name.value, reason: 'exists' } }));
      return counted(write([{ kind: 'project-add', name: name.value }], ctx.signal), 1);
    }),
    implementCapability(RenameProjectCapability, async (input, ctx) => {
      const to = validateHomeName(input.to, HOME_NAME_LIMITS.project, true);
      if (!to.ok) return to;
      const names = projectNames();
      if (!names.has(input.name)) return err(UnknownProjectError({ details: { name: input.name, reason: 'missing' } }));
      if (to.value === input.name) return count(0);
      if (names.has(to.value)) return err(UnknownProjectError({ details: { name: to.value, reason: 'exists' } }));
      return counted(write([{ kind: 'project-rename', from: input.name, to: to.value }], ctx.signal), 1);
    }),
    implementCapability(DeleteProjectCapability, async (input, ctx) => {
      if (!projectNames().has(input.name)) return err(UnknownProjectError({ details: { name: input.name, reason: 'missing' } }));
      return counted(write([{ kind: 'project-remove', name: input.name }], ctx.signal), 1);
    }),
    implementCapability(SearchFilesCapability, async (input) => ok({ assets: searchEntries(live().entries, input.query).map((e) => e.asset) })),
  ];
  const released = implementations.flatMap((impl) => {
    const provided = capabilities.provide(impl);
    return provided.ok ? [provided.value] : [];
  });

  let reads = 0;
  const refresh = async (): Promise<Result<HomeIndex>> => {
    if (machine.state === 'disposed') return ok(live());
    if (machine.state !== 'loading') machine.send('refresh');
    const read = (reads += 1);
    const written = mine.length;
    const result = await source.read(signal);
    if (read !== reads || machine.state !== 'loading') return result; // a newer read or dispose won
    if (result.ok) {
      // The read may predate writes made while it ran: show those on top (ops are idempotent on the index).
      index.set(overlayJournal(result.value, mine.slice(written)));
      mine.splice(0, written);
      error.set(undefined);
      machine.send('loaded');
    } else {
      error.set(result.error);
      machine.send('fail');
    }
    return result;
  };

  const invoke = <O>(capability: { readonly id: string }, input: unknown): Promise<Result<O>> =>
    capabilities.invoke(capability.id, input, { subject: 'user', signal, origin: { channel: 'ui/home' } }) as Promise<Result<O>>;
  const unit = async (r: Promise<Result<unknown>>): Promise<Result<void>> => {
    const done = await r;
    return done.ok ? ok() : done;
  };

  const importFiles: HomeModel['importFiles'] = async (files, importOptions = {}) => {
    const s = importOptions.signal ?? signal;
    const project = importOptions.project?.trim() ?? '';
    const skipped: SkippedFile[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      const refusal = importRefusal(file);
      if (refusal === undefined) accepted.push(file);
      else skipped.push({ name: file.name, reason: refusal, error: HomeImportError({ details: { name: file.name, type: file.type } }) });
    }
    if (accepted.length === 0) return ok({ imported: [], existing: [], skipped });
    if (options.importer === undefined) return err(HomeImportError({ message: 'This Home cannot store files.', details: { name: accepted[0]?.name ?? '' } }));
    const importer = await options.importer();
    const bodies: HomeOpBody[] = [];
    const existingEntries: HomeEntry[] = [];
    const assets: string[] = [];
    for (const file of accepted) {
      if (s.aborted) break;
      const asset = newAssetId();
      const stored = await importer.importFile(file, asset, s);
      if (!stored.ok) {
        skipped.push({ name: file.name, reason: 'failed', error: stored.error });
        continue;
      }
      const digest = stored.value.content.digest;
      const same = live().entries.find((e) => e.trashedAt === undefined && e.digest === digest);
      if (same !== undefined) {
        existingEntries.push(same);
        continue;
      }
      if (bodies.some((b) => b.kind === 'import' && b.media.content.digest === digest)) continue; // the same file twice in one drop
      assets.push(asset);
      bodies.push({ kind: 'import', media: { ...stored.value, ...(project.length === 0 ? {} : { folder: project }) } });
    }
    if (bodies.length > 0) {
      const done = await write(bodies, s);
      if (!done.ok) return done;
    }
    const imported = assets.map(find).filter((e): e is HomeEntry => e !== undefined);
    return ok({ imported, existing: existingEntries, skipped });
  };

  const lifetime = new AbortController();
  const dispose = (): void => {
    if (machine.state === 'disposed') return;
    machine.send('dispose');
    lifetime.abort();
    for (const release of released) release();
    if (owned) capabilities.dispose();
  };
  signal.addEventListener('abort', dispose, { once: true, signal: lifetime.signal });
  void refresh();

  return {
    get state() {
      return machine.state;
    },
    get error() {
      return error.get();
    },
    get index() {
      return live();
    },
    get view() {
      return view.get();
    },
    recents: () => recentDesigns(live()),
    files: () => workspaceFiles(live()),
    templates: () => workspaceTemplates(live()),
    projects: () => workspaceProjects(live()),
    trashed: () => trashedFiles(live()),
    entry: find,
    search: (query) => searchEntries(live().entries, query),
    quickActions: HOME_QUICK_ACTIONS,
    capabilities,
    hrefOf(entry) {
      const href = ENTRY_HREFS[entry.kind]?.(entry.asset);
      return href?.ok === true ? href.value : undefined;
    },
    refresh,
    go(next) {
      const href = homeViewHref(next);
      if (!href.ok) return;
      view.set(next);
      (host.push ?? host.navigate)(href.value);
    },
    show: (next) => view.set(next),
    newDesign: (request) => invoke(NewDesignCapability, request === undefined ? {} : typeof request === 'string' ? { format: request } : request),
    open: (asset) => invoke(OpenDesignCapability, { asset }),
    useTemplate: (t, name) => invoke(UseTemplateCapability, { template: t, ...(name === undefined ? {} : { name }) }),
    runQuickAction: (action) => invoke(action.capability, action.input),
    rename: (asset, title) => unit(invoke(RenameDesignCapability, { asset, title })),
    duplicate: (asset) => invoke(DuplicateDesignCapability, { asset }),
    move: (assets, project) => unit(invoke(MoveToProjectCapability, { assets, project })),
    favorite: (asset, favorite) => unit(invoke(FavoriteCapability, { asset, favorite })),
    trash: (assets) => unit(invoke(TrashDesignsCapability, { assets })),
    restore: (assets) => unit(invoke(RestoreDesignsCapability, { assets })),
    deleteForever: (assets) => unit(invoke(DeleteForeverCapability, { assets })),
    newProject: (name) => unit(invoke(NewProjectCapability, { name })),
    renameProject: (name, to) => unit(invoke(RenameProjectCapability, { name, to })),
    deleteProject: (name) => unit(invoke(DeleteProjectCapability, { name })),
    importFiles,
    dispose,
  };
}
