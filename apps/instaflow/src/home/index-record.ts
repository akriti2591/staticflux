/**
 * The **Home index** (C0; IF-28.4–28.7): a small, Loro-free projection of the workspace library that Home reads with
 * no document engine (D17). It lives in the library asset's head, `DocumentHead.app.home` (the repo carries `app`
 * through compaction), and is written only by the store side that holds the library (Studio's main thread today):
 * one entry per live library asset with what Home shows — title, kind, lens, when it was made and last edited, the
 * design's format.
 *
 * Reads are tolerant: malformed entries are dropped, never thrown, so an old or partly written index still opens Home.
 */
import type { DocumentHead, JsonObject } from '@staticflux/document/v2';
import { ASSET_KIND_LENS, LIBRARY_ASSET_KINDS, type LibraryAssetKind } from '../library/kinds.js';
import { LENS_IDS, type LensId } from '../theme/lenses.js';

/** The head `app` key of the Home index. */
export const HOME_INDEX_APP_KEY = 'home';
export const HOME_INDEX_SCHEMA = 'instaflow.home-index/1';

/** A design's page size in px. */
export interface DesignSize {
  readonly width: number;
  readonly height: number;
}

export interface HomeEntry {
  readonly asset: string;
  readonly kind: LibraryAssetKind;
  readonly title: string;
  /** ISO times. `editedAt` moves when the asset's document is written (designs) or listed (everything else). */
  readonly createdAt: string;
  readonly editedAt: string;
  readonly lens: LensId;
  readonly mime?: string;
  readonly size?: number;
  /** Designs and templates: the page size they were made with. */
  readonly format?: DesignSize;
  /** B11c (HOME-FILES §2.1): the project (one folder level in M1; absent = "No project"). */
  readonly folder?: string;
  readonly favorite?: true;
  /** In the trash since (ISO). Trashed entries show only on the Trash page. */
  readonly trashedAt?: string;
  /** Designs: the page count, when Studio knows it. */
  readonly pages?: number;
  /** Media: the content digest (Home's import dedupe). */
  readonly digest?: string;
}

/** A project made on Home before it holds a design (HOME-FILES §2.1: kept in the index until it gets one). */
export interface HomeProject {
  readonly name: string;
  readonly createdAt: string;
}

export interface HomeIndex {
  readonly schema: typeof HOME_INDEX_SCHEMA;
  /** Newest edit first. */
  readonly entries: readonly HomeEntry[];
  /** Projects made on Home (empty or not); a project also exists while any entry has its folder. */
  readonly projects?: readonly HomeProject[];
}

export const EMPTY_HOME_INDEX: HomeIndex = Object.freeze({ schema: HOME_INDEX_SCHEMA, entries: Object.freeze([]) as readonly HomeEntry[] });

const KINDS = new Set<string>(LIBRARY_ASSET_KINDS);
const LENSES = new Set<string>(LENS_IDS);
const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Order entries newest edit first (ties: newest created, then asset id). */
export function byEdited(a: HomeEntry, b: HomeEntry): number {
  return Date.parse(b.editedAt) - Date.parse(a.editedAt) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0);
}

/** One entry from JSON, or undefined when it is malformed. */
export function readHomeEntry(raw: unknown): HomeEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v['asset'] !== 'string' || v['asset'].length === 0 || typeof v['kind'] !== 'string' || !KINDS.has(v['kind'])) return undefined;
  if (typeof v['title'] !== 'string' || v['title'].trim().length === 0 || !isIso(v['createdAt']) || !isIso(v['editedAt'])) return undefined;
  const kind = v['kind'] as LibraryAssetKind;
  const lens = typeof v['lens'] === 'string' && LENSES.has(v['lens']) ? (v['lens'] as LensId) : ASSET_KIND_LENS[kind];
  const format = v['format'] as Partial<DesignSize> | undefined;
  return {
    asset: v['asset'],
    kind,
    title: v['title'],
    createdAt: v['createdAt'],
    editedAt: v['editedAt'],
    lens,
    ...(typeof v['mime'] === 'string' ? { mime: v['mime'] } : {}),
    ...(positive(v['size']) ? { size: v['size'] } : {}),
    ...(positive(format?.width) && positive(format?.height) ? { format: { width: format.width, height: format.height } } : {}),
    ...(typeof v['folder'] === 'string' && v['folder'].trim().length > 0 ? { folder: v['folder'].trim() } : {}),
    ...(v['favorite'] === true ? { favorite: true as const } : {}),
    ...(isIso(v['trashedAt']) ? { trashedAt: v['trashedAt'] } : {}),
    ...(positive(v['pages']) && Number.isInteger(v['pages']) ? { pages: v['pages'] } : {}),
    ...(typeof v['digest'] === 'string' && v['digest'].length > 0 ? { digest: v['digest'] } : {}),
  };
}

/** Projects from JSON (tolerant: malformed and repeated names are dropped). */
export function readHomeProjects(raw: unknown): readonly HomeProject[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: HomeProject[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const v = item as Record<string, unknown>;
    const name = typeof v['name'] === 'string' ? v['name'].trim() : '';
    if (name.length === 0 || seen.has(name) || !isIso(v['createdAt'])) continue;
    seen.add(name);
    out.push({ name, createdAt: v['createdAt'] });
  }
  return out;
}

/** The Home index of the library head (empty when there is no head or no index yet). */
export function readHomeIndex(head: Pick<DocumentHead, 'app'> | undefined): HomeIndex {
  const raw = head?.app?.[HOME_INDEX_APP_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_HOME_INDEX;
  const value = raw as Record<string, unknown>;
  if (value['schema'] !== HOME_INDEX_SCHEMA || !Array.isArray(value['entries'])) return EMPTY_HOME_INDEX;
  const seen = new Set<string>();
  const entries: HomeEntry[] = [];
  for (const item of value['entries'] as unknown[]) {
    const entry = readHomeEntry(item);
    if (entry === undefined || seen.has(entry.asset)) continue;
    seen.add(entry.asset);
    entries.push(entry);
  }
  const projects = readHomeProjects(value['projects']);
  return { schema: HOME_INDEX_SCHEMA, entries: entries.sort(byEdited), ...(projects.length === 0 ? {} : { projects }) };
}

function entryJson(entry: HomeEntry): JsonObject {
  return {
    asset: entry.asset,
    kind: entry.kind,
    title: entry.title,
    createdAt: entry.createdAt,
    editedAt: entry.editedAt,
    lens: entry.lens,
    ...(entry.mime === undefined ? {} : { mime: entry.mime }),
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.format === undefined ? {} : { format: { width: entry.format.width, height: entry.format.height } }),
    ...(entry.folder === undefined ? {} : { folder: entry.folder }),
    ...(entry.favorite === true ? { favorite: true } : {}),
    ...(entry.trashedAt === undefined ? {} : { trashedAt: entry.trashedAt }),
    ...(entry.pages === undefined ? {} : { pages: entry.pages }),
    ...(entry.digest === undefined ? {} : { digest: entry.digest }),
  };
}

const projectsJson = (projects: readonly HomeProject[] | undefined): JsonObject[] => [...(projects ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => ({ name: p.name, createdAt: p.createdAt }));

/** A head carrying `index` (generation unchanged: the caller sets it). */
export function withHomeIndex<H extends Pick<DocumentHead, 'app'>>(head: H, index: HomeIndex): H {
  const projects = projectsJson(index.projects);
  return {
    ...head,
    app: { ...(head.app ?? {}), [HOME_INDEX_APP_KEY]: { schema: HOME_INDEX_SCHEMA, entries: [...index.entries].sort(byEdited).map(entryJson), ...(projects.length === 0 ? {} : { projects }) } },
  };
}

/** Same content (order-insensitive): an unchanged index is never rewritten. */
export function sameHomeIndex(a: HomeIndex, b: HomeIndex): boolean {
  if (a.entries.length !== b.entries.length) return false;
  if (JSON.stringify(projectsJson(a.projects)) !== JSON.stringify(projectsJson(b.projects))) return false;
  const key = (e: HomeEntry): string => JSON.stringify(entryJson(e));
  const left = new Set(a.entries.map(key));
  return b.entries.every((e) => left.has(key(e)));
}

const live = (e: HomeEntry): boolean => e.trashedAt === undefined;

/** Designs to jump back into: live compositions, newest edit first. */
export function recentDesigns(index: HomeIndex, limit = 8): readonly HomeEntry[] {
  return index.entries.filter((e) => live(e) && e.kind === 'composition').slice(0, limit);
}

/** Every live file (designs, templates, media), newest edit first. */
export function workspaceFiles(index: HomeIndex): readonly HomeEntry[] {
  return index.entries.filter(live);
}

/** Live templates (B5 tree assets of kind `template`), newest edit first. */
export function workspaceTemplates(index: HomeIndex): readonly HomeEntry[] {
  return index.entries.filter((e) => live(e) && e.kind === 'template');
}

/** The trash, newest trashed first (HOME-FILES §2.4). */
export function trashedFiles(index: HomeIndex): readonly HomeEntry[] {
  return index.entries.filter((e) => e.trashedAt !== undefined).sort((a, b) => Date.parse(b.trashedAt as string) - Date.parse(a.trashedAt as string) || byEdited(a, b));
}

/** A project as Home shows it (HOME-FILES §1.2: name, count, last edited). */
export interface ProjectSummary {
  readonly name: string;
  /** Live entries in it. */
  readonly count: number;
  /** The newest edit of its entries (or when it was made, while empty). */
  readonly editedAt: string;
}

/** Every project: the folders of live entries and the projects made on Home, newest edit first, then by name. */
export function workspaceProjects(index: HomeIndex): readonly ProjectSummary[] {
  const byName = new Map<string, { count: number; editedAt: string }>();
  for (const p of index.projects ?? []) byName.set(p.name, { count: 0, editedAt: p.createdAt });
  for (const e of index.entries) {
    if (!live(e) || e.folder === undefined) continue;
    const found = byName.get(e.folder);
    if (found === undefined) byName.set(e.folder, { count: 1, editedAt: e.editedAt });
    else byName.set(e.folder, { count: found.count + 1, editedAt: found.count === 0 || Date.parse(e.editedAt) > Date.parse(found.editedAt) ? e.editedAt : found.editedAt });
  }
  return [...byName].map(([name, v]) => ({ name, ...v })).sort((a, b) => Date.parse(b.editedAt) - Date.parse(a.editedAt) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
