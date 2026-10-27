/**
 * Files' list state (B11c; HOME-FILES §2.2): the filter switcher (`All · Designs · Templates · Media · Favourites`), the
 * project filter, the sort (Last edited, Created, Name A–Z, Kind) and the Grid / List layout, as pure functions over the
 * Home index, plus their per-device memory (`instaflow/ui/files`; a convenience: it may come back empty). Range
 * selection (`Shift+click`) is `selectRange`.
 */
import type { LibraryAssetKind } from '../library/kinds.js';
import type { HomeEntry } from './index-record.js';
import { FILES_FILTERS, FILES_LAYOUTS, FILES_SORTS, type FilesFilter, type FilesLayout, type FilesSort } from './routes.js';

export const FILES_MEMORY_KEY = 'instaflow/ui/files';

export interface FilesPrefs {
  readonly filter: FilesFilter;
  readonly sort: FilesSort;
  readonly layout: FilesLayout;
}

export const DEFAULT_FILES_PREFS: FilesPrefs = Object.freeze({ filter: 'all', sort: 'edited', layout: 'grid' });

/** Which entries each filter keeps (data). */
export const FILES_FILTER_TESTS: Readonly<Record<FilesFilter, (e: HomeEntry) => boolean>> = Object.freeze({
  all: () => true,
  designs: (e) => e.kind === 'composition',
  templates: (e) => e.kind === 'template',
  media: (e) => e.kind !== 'composition' && e.kind !== 'template',
  favourites: (e) => e.favorite === true,
});

/** Kind order for "Kind" (designs, templates, then media by kind name). */
const KIND_RANK: Readonly<Partial<Record<LibraryAssetKind, number>>> = { composition: 0, template: 1 };
const rank = (e: HomeEntry): number => KIND_RANK[e.kind] ?? 2;
const edited = (a: HomeEntry, b: HomeEntry): number => Date.parse(b.editedAt) - Date.parse(a.editedAt) || (a.asset < b.asset ? -1 : 1);

/** Comparators per sort (data). */
export const FILES_SORT_ORDERS: Readonly<Record<FilesSort, (a: HomeEntry, b: HomeEntry) => number>> = Object.freeze({
  edited,
  created: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || edited(a, b),
  name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) || edited(a, b),
  kind: (a, b) => rank(a) - rank(b) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || edited(a, b),
});

/** The project filter: every project, one project, or the entries in none. */
export type ProjectFilter = { readonly kind: 'any' } | { readonly kind: 'none' } | { readonly kind: 'project'; readonly name: string };

/** What Files lists for this state (live entries only). */
export function filesList(entries: readonly HomeEntry[], prefs: Pick<FilesPrefs, 'filter' | 'sort'>, project: ProjectFilter = { kind: 'any' }): readonly HomeEntry[] {
  const inProject = (e: HomeEntry): boolean => (project.kind === 'any' ? true : project.kind === 'none' ? e.folder === undefined : e.folder === project.name);
  return entries.filter((e) => e.trashedAt === undefined && FILES_FILTER_TESTS[prefs.filter](e) && inProject(e)).sort(FILES_SORT_ORDERS[prefs.sort]);
}

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback);

/** This device's Files state (tolerant). */
export function readFilesPrefs(storage: Pick<Storage, 'getItem'> | undefined): FilesPrefs {
  try {
    const raw = storage?.getItem(FILES_MEMORY_KEY);
    const v = raw === null || raw === undefined ? {} : (JSON.parse(raw) as Partial<Record<keyof FilesPrefs, unknown>>);
    return { filter: pick(FILES_FILTERS, v.filter, 'all'), sort: pick(FILES_SORTS, v.sort, 'edited'), layout: pick(FILES_LAYOUTS, v.layout, 'grid') };
  } catch {
    return DEFAULT_FILES_PREFS;
  }
}

export function writeFilesPrefs(storage: Pick<Storage, 'setItem'> | undefined, prefs: FilesPrefs): void {
  try {
    storage?.setItem(FILES_MEMORY_KEY, JSON.stringify(prefs));
  } catch {
    // A convenience only (private windows, blocked storage).
  }
}

/** The assets from `anchor` to `to` in `order` (inclusive, either direction); just `to` when the anchor is gone. */
export function selectRange(order: readonly string[], anchor: string | undefined, to: string): readonly string[] {
  const a = anchor === undefined ? -1 : order.indexOf(anchor);
  const b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Trash rows grouped by day (newest first), each group labelled by its date (HOME-FILES §2.4). */
export function trashByDay(entries: readonly HomeEntry[], locale?: string): readonly { readonly day: string; readonly label: string; readonly entries: readonly HomeEntry[] }[] {
  const groups = new Map<string, { at: Date; list: HomeEntry[] }>();
  const pad = (n: number): string => String(n).padStart(2, '0');
  for (const e of entries) {
    if (e.trashedAt === undefined) continue;
    const at = new Date(e.trashedAt);
    const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`; // the viewer's calendar day
    const group = groups.get(day) ?? { at, list: [] };
    group.list.push(e);
    groups.set(day, group);
  }
  const format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  return [...groups].sort(([a], [b]) => (a < b ? 1 : -1)).map(([day, g]) => ({ day, label: format.format(g.at), entries: g.list }));
}
