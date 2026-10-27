/**
 * The **Home journal** (B11c; HOME-FILES §3, §5): how Home changes files without a document engine (D17). The library is
 * a Loro document that only Studio's store side opens, so Home never edits it. Instead every file operation on Home
 * (rename, move to project, favourite, trash, restore, delete forever, duplicate, import, the project operations) is
 * appended as one **op** to a small journal kept in its own head (`HOME_JOURNAL_ASSET`, compare-and-swap like every
 * head), and:
 *
 * - **Home** reads the Home index with the journal applied on top (`overlayJournal`), so a change shows at once;
 * - **Studio's store side** drains the journal into the library whenever it opens or hears Home (`../workspace/
 *   home-journal-drain.ts`): it applies each op to the library, rewrites the Home index, then removes the ops it
 *   applied. The index writer applies pending ops too, so the stored index never undoes a change Home already shows.
 *
 * Ops are idempotent on the index (applying one twice changes nothing more) and are applied in order. Reads are
 * tolerant: a malformed op is dropped, never thrown.
 */
import { err, ok, type Result } from '@staticflux/core';
import { type DocumentHead, type DocumentStore, HeadConflictError, type JsonObject, type JsonValue } from '@staticflux/document/v2';
import { ASSET_KIND_LENS, LIBRARY_ASSET_KINDS, type LibraryAssetKind } from '../library/kinds.js';
import { HomeJournalWriteError } from './errors.js';
import { byEdited, type HomeEntry, type HomeIndex, type HomeProject } from './index-record.js';

/** The journal's head (a head of its own: Home's writes never race the library's compaction). */
export const HOME_JOURNAL_ASSET = 'home-journal';
export const HOME_JOURNAL_SCHEMA = 'instaflow.home-journal/1';
/** The head `app` key the ops live under. */
export const HOME_JOURNAL_APP_KEY = 'journal';
/** The channel Home and Studio ping each other on after a write (BroadcastChannel name). */
export const HOME_JOURNAL_CHANNEL = 'instaflow/home-journal';

/** A content-addressed blob as JSON (structurally `@staticflux/blob` `BlobRef`). */
export interface BlobRefJson {
  readonly digest: string;
  readonly size: number;
  readonly mime: string;
  readonly chunked?: true;
  readonly encoding?: string;
}

/** A media file Home imported: its bytes and record are already in the blob store; Studio lists it. */
export interface ImportedMedia {
  readonly asset: string;
  readonly kind: LibraryAssetKind;
  readonly title: string;
  readonly mime: string;
  readonly size: number;
  readonly content: BlobRefJson;
  readonly record: BlobRefJson;
  readonly width?: number;
  readonly height?: number;
  readonly folder?: string;
}

export type HomeOpBody =
  | { readonly kind: 'rename'; readonly asset: string; readonly title: string }
  | { readonly kind: 'move'; readonly assets: readonly string[]; readonly folder: string }
  | { readonly kind: 'favorite'; readonly asset: string; readonly favorite: boolean }
  | { readonly kind: 'trash'; readonly assets: readonly string[] }
  | { readonly kind: 'restore'; readonly assets: readonly string[] }
  | { readonly kind: 'purge'; readonly assets: readonly string[] }
  | { readonly kind: 'duplicate'; readonly source: string; readonly asset: string; readonly title: string; readonly folder?: string }
  | { readonly kind: 'import'; readonly media: ImportedMedia }
  | { readonly kind: 'project-add'; readonly name: string }
  | { readonly kind: 'project-rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'project-remove'; readonly name: string };

export type HomeOpKind = HomeOpBody['kind'];

/** One journal op: what to do, plus a unique id and when (ISO). */
export type HomeOp = HomeOpBody & { readonly id: string; readonly at: string };

let opSeq = 0;
/** A fresh op id (time + counter + random: unique across tabs). */
export function homeOpId(now: number = Date.now()): string {
  return `op_${now.toString(36)}${(opSeq += 1).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Stamp a body with an id and time. */
export function homeOp(body: HomeOpBody, now: number = Date.now()): HomeOp {
  return { ...body, id: homeOpId(now), at: new Date(now).toISOString() };
}

// ---------------------------------------------------------------- reading (tolerant)

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strs = (v: unknown): v is readonly string[] => Array.isArray(v) && v.length > 0 && v.every(str);
const iso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const pos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const KINDS = new Set<string>(LIBRARY_ASSET_KINDS);
const ref = (v: unknown): BlobRefJson | undefined => {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (!str(r['digest']) || typeof r['size'] !== 'number' || r['size'] < 0 || typeof r['mime'] !== 'string') return undefined;
  return { digest: r['digest'], size: r['size'], mime: r['mime'], ...(r['chunked'] === true ? { chunked: true as const } : {}), ...(str(r['encoding']) ? { encoding: r['encoding'] } : {}) };
};

function readMedia(v: unknown): ImportedMedia | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const m = v as Record<string, unknown>;
  const content = ref(m['content']);
  const record = ref(m['record']);
  if (!str(m['asset']) || !str(m['kind']) || !KINDS.has(m['kind']) || !str(m['title']) || !str(m['mime']) || typeof m['size'] !== 'number' || content === undefined || record === undefined) return undefined;
  return {
    asset: m['asset'],
    kind: m['kind'] as LibraryAssetKind,
    title: m['title'],
    mime: m['mime'],
    size: m['size'],
    content,
    record,
    ...(pos(m['width']) && pos(m['height']) ? { width: m['width'], height: m['height'] } : {}),
    ...(str(m['folder']) ? { folder: m['folder'] } : {}),
  };
}

/** Body readers per kind (data, not a branch). */
const BODY_READERS: Readonly<Record<HomeOpKind, (v: Record<string, unknown>) => HomeOpBody | undefined>> = {
  rename: (v) => (str(v['asset']) && str(v['title']) ? { kind: 'rename', asset: v['asset'], title: v['title'] } : undefined),
  move: (v) => (strs(v['assets']) && typeof v['folder'] === 'string' ? { kind: 'move', assets: v['assets'], folder: v['folder'] } : undefined),
  favorite: (v) => (str(v['asset']) && typeof v['favorite'] === 'boolean' ? { kind: 'favorite', asset: v['asset'], favorite: v['favorite'] } : undefined),
  trash: (v) => (strs(v['assets']) ? { kind: 'trash', assets: v['assets'] } : undefined),
  restore: (v) => (strs(v['assets']) ? { kind: 'restore', assets: v['assets'] } : undefined),
  purge: (v) => (strs(v['assets']) ? { kind: 'purge', assets: v['assets'] } : undefined),
  duplicate: (v) => (str(v['source']) && str(v['asset']) && str(v['title']) ? { kind: 'duplicate', source: v['source'], asset: v['asset'], title: v['title'], ...(str(v['folder']) ? { folder: v['folder'] } : {}) } : undefined),
  import: (v) => {
    const media = readMedia(v['media']);
    return media === undefined ? undefined : { kind: 'import', media };
  },
  'project-add': (v) => (str(v['name']) ? { kind: 'project-add', name: v['name'] } : undefined),
  'project-rename': (v) => (str(v['from']) && str(v['to']) ? { kind: 'project-rename', from: v['from'], to: v['to'] } : undefined),
  'project-remove': (v) => (str(v['name']) ? { kind: 'project-remove', name: v['name'] } : undefined),
};

/** One op from JSON, or undefined when it is malformed. */
export function readHomeOp(raw: unknown): HomeOp | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (!str(v['id']) || !iso(v['at']) || !str(v['kind']) || !(v['kind'] in BODY_READERS)) return undefined;
  const body = BODY_READERS[v['kind'] as HomeOpKind](v);
  return body === undefined ? undefined : { ...body, id: v['id'], at: v['at'] };
}

/** The ops in a journal head, oldest first (empty without a head). */
export function readHomeJournal(head: Pick<DocumentHead, 'app'> | undefined): readonly HomeOp[] {
  const raw = head?.app?.[HOME_JOURNAL_APP_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  if (value['schema'] !== HOME_JOURNAL_SCHEMA || !Array.isArray(value['ops'])) return [];
  const seen = new Set<string>();
  const out: HomeOp[] = [];
  for (const item of value['ops'] as unknown[]) {
    const op = readHomeOp(item);
    if (op === undefined || seen.has(op.id)) continue;
    seen.add(op.id);
    out.push(op);
  }
  return out;
}

/** The journal head carrying `ops` (generation `generation`). */
export function journalHead(ops: readonly HomeOp[], generation: number): DocumentHead {
  return {
    asset: HOME_JOURNAL_ASSET,
    generation,
    engine: 'none',
    treeSchema: 0,
    parts: {},
    logFrom: 0,
    undoHorizon: 0,
    app: { [HOME_JOURNAL_APP_KEY]: { schema: HOME_JOURNAL_SCHEMA, ops: ops.map((op) => JSON.parse(JSON.stringify(op)) as JsonObject) as JsonValue[] } },
  };
}

// ---------------------------------------------------------------- applying to the index (pure, idempotent)

type Entries = HomeEntry[];
const strip = <K extends keyof HomeEntry>(e: HomeEntry, key: K): HomeEntry => {
  const { [key]: _drop, ...rest } = e;
  return rest as HomeEntry;
};
const map = (entries: Entries, assets: ReadonlySet<string>, fn: (e: HomeEntry) => HomeEntry): Entries => entries.map((e) => (assets.has(e.asset) ? fn(e) : e));
const withFolder = (e: HomeEntry, folder: string): HomeEntry => (folder.length === 0 ? strip(e, 'folder') : { ...e, folder });

/** Index appliers per op kind (data, not a branch). Each returns the next entries and projects. */
const APPLIERS: Readonly<Record<HomeOpKind, (op: HomeOp, entries: Entries, projects: HomeProject[]) => readonly [Entries, HomeProject[]]>> = {
  rename: (op, entries, projects) => [map(entries, new Set([(op as Extract<HomeOp, { kind: 'rename' }>).asset]), (e) => ({ ...e, title: (op as Extract<HomeOp, { kind: 'rename' }>).title })), projects],
  move: (op, entries, projects) => {
    const o = op as Extract<HomeOp, { kind: 'move' }>;
    return [map(entries, new Set(o.assets), (e) => withFolder(e, o.folder)), projects];
  },
  favorite: (op, entries, projects) => {
    const o = op as Extract<HomeOp, { kind: 'favorite' }>;
    return [map(entries, new Set([o.asset]), (e) => (o.favorite ? { ...e, favorite: true } : strip(e, 'favorite'))), projects];
  },
  trash: (op, entries, projects) => [map(entries, new Set((op as Extract<HomeOp, { kind: 'trash' }>).assets), (e) => (e.trashedAt === undefined ? { ...e, trashedAt: op.at } : e)), projects],
  restore: (op, entries, projects) => [map(entries, new Set((op as Extract<HomeOp, { kind: 'restore' }>).assets), (e) => strip(e, 'trashedAt')), projects],
  purge: (op, entries, projects) => {
    const gone = new Set((op as Extract<HomeOp, { kind: 'purge' }>).assets);
    return [entries.filter((e) => !gone.has(e.asset)), projects];
  },
  duplicate: (op, entries, projects) => {
    const o = op as Extract<HomeOp, { kind: 'duplicate' }>;
    const source = entries.find((e) => e.asset === o.source);
    if (source === undefined || entries.some((e) => e.asset === o.asset)) return [entries, projects];
    const copy: HomeEntry = {
      asset: o.asset,
      kind: source.kind,
      title: o.title,
      createdAt: op.at,
      editedAt: op.at,
      lens: source.lens,
      ...(source.format === undefined ? {} : { format: source.format }),
      ...(source.pages === undefined ? {} : { pages: source.pages }),
      ...(o.folder === undefined ? {} : { folder: o.folder }),
    };
    return [[...entries, copy], projects];
  },
  import: (op, entries, projects) => {
    const m = (op as Extract<HomeOp, { kind: 'import' }>).media;
    if (entries.some((e) => e.asset === m.asset || (e.digest !== undefined && e.digest === m.content.digest && e.trashedAt === undefined))) return [entries, projects];
    const entry: HomeEntry = {
      asset: m.asset,
      kind: m.kind,
      title: m.title,
      createdAt: op.at,
      editedAt: op.at,
      lens: ASSET_KIND_LENS[m.kind],
      mime: m.mime,
      size: m.size,
      digest: m.content.digest,
      ...(m.width !== undefined && m.height !== undefined ? { format: { width: m.width, height: m.height } } : {}),
      ...(m.folder === undefined ? {} : { folder: m.folder }),
    };
    return [[...entries, entry], projects];
  },
  'project-add': (op, entries, projects) => {
    const name = (op as Extract<HomeOp, { kind: 'project-add' }>).name;
    return [entries, projects.some((p) => p.name === name) ? projects : [...projects, { name, createdAt: op.at }]];
  },
  'project-rename': (op, entries, projects) => {
    const { from, to } = op as Extract<HomeOp, { kind: 'project-rename' }>;
    const renamed = projects.filter((p) => p.name !== to).map((p) => (p.name === from ? { ...p, name: to } : p));
    return [entries.map((e) => (e.folder === from ? { ...e, folder: to } : e)), renamed];
  },
  'project-remove': (op, entries, projects) => {
    const name = (op as Extract<HomeOp, { kind: 'project-remove' }>).name;
    return [entries.map((e) => (e.folder === name ? strip(e, 'folder') : e)), projects.filter((p) => p.name !== name)];
  },
};

/** The index with `ops` applied in order (pure; ops that no longer apply change nothing). */
export function overlayJournal(index: HomeIndex, ops: readonly HomeOp[]): HomeIndex {
  if (ops.length === 0) return index;
  let entries: Entries = [...index.entries];
  let projects: HomeProject[] = [...(index.projects ?? [])];
  for (const op of ops) [entries, projects] = APPLIERS[op.kind](op, entries, projects);
  return { schema: index.schema, entries: entries.sort(byEdited), ...(projects.length === 0 ? {} : { projects }) };
}

// ---------------------------------------------------------------- writing (compare-and-swap)

type JournalStore = Pick<DocumentStore, 'readHead' | 'writeHead'>;

/** Swap the journal by CAS: `next(current ops)` (retries on a conflict). */
export async function updateHomeJournal(store: JournalStore, next: (ops: readonly HomeOp[]) => readonly HomeOp[], signal: AbortSignal, attempts = 6): Promise<Result<readonly HomeOp[]>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = await store.readHead(HOME_JOURNAL_ASSET, signal);
    if (!read.ok) return read;
    const current = readHomeJournal(read.value);
    const ops = next(current);
    if (ops === current) return ok(current);
    const generation = read.value?.generation ?? 0;
    const written = await store.writeHead(HOME_JOURNAL_ASSET, journalHead(ops, generation + 1), read.value === undefined ? null : generation, signal);
    if (written.ok) return ok(ops);
    if (written.error.code !== HeadConflictError.code) return written;
  }
  return err(HomeJournalWriteError({ details: { attempts } }));
}

/** Append ops to the journal. */
export function appendHomeOps(store: JournalStore, ops: readonly HomeOp[], signal: AbortSignal): Promise<Result<readonly HomeOp[]>> {
  return updateHomeJournal(store, (current) => [...current, ...ops], signal);
}

/** Remove the ops with these ids (Studio, once applied). */
export function removeHomeOps(store: JournalStore, ids: ReadonlySet<string>, signal: AbortSignal): Promise<Result<readonly HomeOp[]>> {
  return updateHomeJournal(store, (current) => (current.some((op) => ids.has(op.id)) ? current.filter((op) => !ids.has(op.id)) : current), signal);
}
