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
}

export interface HomeIndex {
  readonly schema: typeof HOME_INDEX_SCHEMA;
  /** Newest edit first. */
  readonly entries: readonly HomeEntry[];
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
  };
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
  return { schema: HOME_INDEX_SCHEMA, entries: entries.sort(byEdited) };
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
  };
}

/** A head carrying `index` (generation unchanged: the caller sets it). */
export function withHomeIndex<H extends Pick<DocumentHead, 'app'>>(head: H, index: HomeIndex): H {
  return { ...head, app: { ...(head.app ?? {}), [HOME_INDEX_APP_KEY]: { schema: HOME_INDEX_SCHEMA, entries: [...index.entries].sort(byEdited).map(entryJson) } } };
}

/** Same content (order-insensitive): an unchanged index is never rewritten. */
export function sameHomeIndex(a: HomeIndex, b: HomeIndex): boolean {
  if (a.entries.length !== b.entries.length) return false;
  const key = (e: HomeEntry): string => JSON.stringify(entryJson(e));
  const left = new Set(a.entries.map(key));
  return b.entries.every((e) => left.has(key(e)));
}

/** Designs to jump back into: compositions, newest edit first. */
export function recentDesigns(index: HomeIndex, limit = 8): readonly HomeEntry[] {
  return index.entries.filter((e) => e.kind === 'composition').slice(0, limit);
}

/** Every listed file (designs, templates, media), newest edit first. */
export function workspaceFiles(index: HomeIndex): readonly HomeEntry[] {
  return index.entries;
}

/** Templates (B5 tree assets of kind `template`), newest edit first. */
export function workspaceTemplates(index: HomeIndex): readonly HomeEntry[] {
  return index.entries.filter((e) => e.kind === 'template');
}
