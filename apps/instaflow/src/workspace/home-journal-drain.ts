/**
 * Drain Home's journal into the library (B11c; HOME-FILES §3, §5): the store side's half of `../home/journal.ts`. Studio
 * runs it when it opens (before it plans the document, so a design duplicated or renamed on Home opens as Home shows it),
 * when Home pings `HOME_JOURNAL_CHANNEL`, and when the tab becomes visible.
 *
 * Each op is applied to the library in order by its kind's applier (data, not a branch): rename, move, favourite, trash,
 * restore, purge (delete forever), duplicate (`duplicateDesign`, then listed), import (listed unless the same content is
 * already live), and the project ops (moves of every entry in the project; the project list itself lives in the Home
 * index). An op that no longer applies (its asset is gone) is dropped; a failed op is reported and dropped too, so one bad
 * op never blocks the rest. Then the Home index is rewritten (`flushIndex`) and only then the applied ops leave the
 * journal, so Home never sees a change undone in between. Runs are single-flight.
 */
import { ok, type Result, type SfError } from '@staticflux/core';
import type { DocumentStore } from '@staticflux/document/v2';
import { HOME_JOURNAL_ASSET, type HomeOp, type HomeOpKind, readHomeJournal, removeHomeOps } from '../home/journal.js';
import type { Library } from '../library/library.js';
import { ASSET_RECORD_MIME, type AssetId } from '../library/records.js';
import type { Digest } from '@staticflux/blob';

export interface DrainServices {
  readonly store: Pick<DocumentStore, 'readHead' | 'writeHead'>;
  readonly library: Pick<Library, 'entry' | 'entries' | 'findByContent' | 'add' | 'rename' | 'setFolder' | 'setFavorite' | 'trash' | 'restore' | 'purge'>;
  /** Make the copy's document (the engine's part; `duplicateDesign`). */
  readonly duplicate: (request: { readonly source: string; readonly asset: AssetId; readonly title: string }, signal: AbortSignal) => Promise<Result<unknown>>;
  /** Rewrite the Home index now (the index writer's `flush`). */
  readonly flushIndex?: (signal: AbortSignal) => Promise<Result<void>>;
  readonly onProblem?: (error: SfError, op: HomeOp) => void;
}

export interface DrainReport {
  /** Ops read from the journal and removed. */
  readonly drained: number;
  readonly problems: readonly SfError[];
}

type Applier = (op: HomeOp, services: DrainServices, signal: AbortSignal) => Promise<Result<void>> | Result<void>;

const known = (services: DrainServices, assets: readonly string[]): AssetId[] => assets.filter((a) => services.library.entry(a as AssetId) !== undefined) as AssetId[];
const inFolder = (services: DrainServices, folder: string): AssetId[] => services.library.entries().filter((e) => e.folder === folder).map((e) => e.asset);
const each = (assets: readonly AssetId[], fn: (asset: AssetId) => Result<void>): Result<void> => {
  for (const asset of assets) {
    const done = fn(asset);
    if (!done.ok) return done;
  }
  return ok();
};

/** One applier per op kind. */
const APPLIERS: Readonly<Record<HomeOpKind, Applier>> = {
  rename: (op, s) => {
    const o = op as Extract<HomeOp, { kind: 'rename' }>;
    return known(s, [o.asset]).length === 0 ? ok() : s.library.rename(o.asset as AssetId, o.title);
  },
  move: (op, s) => {
    const o = op as Extract<HomeOp, { kind: 'move' }>;
    return each(known(s, o.assets), (asset) => (s.library.entry(asset)?.folder === o.folder ? ok() : s.library.setFolder(asset, o.folder)));
  },
  favorite: (op, s) => {
    const o = op as Extract<HomeOp, { kind: 'favorite' }>;
    return known(s, [o.asset]).length === 0 ? ok() : s.library.setFavorite(o.asset as AssetId, o.favorite);
  },
  trash: (op, s) => {
    const assets = known(s, (op as Extract<HomeOp, { kind: 'trash' }>).assets);
    return assets.length === 0 ? ok() : s.library.trash(assets);
  },
  restore: (op, s) => {
    const assets = known(s, (op as Extract<HomeOp, { kind: 'restore' }>).assets);
    return assets.length === 0 ? ok() : s.library.restore(assets);
  },
  purge: (op, s) => {
    const assets = known(s, (op as Extract<HomeOp, { kind: 'purge' }>).assets);
    return assets.length === 0 ? ok() : s.library.purge(assets);
  },
  async duplicate(op, s, signal) {
    const o = op as Extract<HomeOp, { kind: 'duplicate' }>;
    const source = s.library.entry(o.source as AssetId);
    if (source === undefined || s.library.entry(o.asset as AssetId) !== undefined) return ok();
    const made = await s.duplicate({ source: o.source, asset: o.asset as AssetId, title: o.title }, signal);
    if (!made.ok) return made;
    const listed = s.library.add({ asset: o.asset as AssetId, kind: source.kind, title: o.title, createdAt: op.at, ...(o.folder === undefined ? {} : { folder: o.folder }) });
    return listed.ok ? ok() : listed;
  },
  import: (op, s) => {
    const m = (op as Extract<HomeOp, { kind: 'import' }>).media;
    if (s.library.entry(m.asset as AssetId) !== undefined || s.library.findByContent(m.content.digest as Digest) !== undefined) return ok();
    const listed = s.library.add({
      asset: m.asset as AssetId,
      kind: m.kind,
      title: m.title,
      createdAt: op.at,
      mime: m.mime,
      size: m.size,
      content: { ...m.content, digest: m.content.digest as Digest } as never,
      record: { ...m.record, digest: m.record.digest as Digest, mime: m.record.mime || ASSET_RECORD_MIME } as never,
      ...(m.width !== undefined && m.height !== undefined ? { media: { width: m.width, height: m.height } } : {}),
      ...(m.folder === undefined ? {} : { folder: m.folder }),
    });
    return listed.ok ? ok() : listed;
  },
  // The project list lives in the Home index (the index writer keeps it); the library only holds each entry's folder.
  'project-add': () => ok(),
  'project-rename': (op, s) => {
    const o = op as Extract<HomeOp, { kind: 'project-rename' }>;
    return each(inFolder(s, o.from), (asset) => s.library.setFolder(asset, o.to));
  },
  'project-remove': (op, s) => each(inFolder(s, (op as Extract<HomeOp, { kind: 'project-remove' }>).name), (asset) => s.library.setFolder(asset, '')),
};

export interface HomeJournalDrain {
  /** Apply what Home wrote since the last run (single-flight: a call during a run waits for one more run). */
  run(signal: AbortSignal): Promise<Result<DrainReport>>;
}

/** Apply every pending op once, then remove them (see the module header). */
export async function drainHomeJournal(services: DrainServices, signal: AbortSignal): Promise<Result<DrainReport>> {
  const head = await services.store.readHead(HOME_JOURNAL_ASSET, signal);
  if (!head.ok) return head;
  const ops = readHomeJournal(head.value);
  if (ops.length === 0) return ok({ drained: 0, problems: [] });
  const problems: SfError[] = [];
  for (const op of ops) {
    if (signal.aborted) break;
    const done = await APPLIERS[op.kind](op, services, signal);
    if (!done.ok) {
      problems.push(done.error);
      services.onProblem?.(done.error, op);
    }
  }
  const flushed = (await services.flushIndex?.(signal)) ?? ok();
  if (!flushed.ok) return flushed; // keep the ops: Home goes on showing them until the index catches up
  const removed = await removeHomeOps(services.store, new Set(ops.map((op) => op.id)), signal);
  if (!removed.ok) return removed;
  return ok({ drained: ops.length, problems });
}

/** A single-flight drain over `services`. */
export function createHomeJournalDrain(services: DrainServices): HomeJournalDrain {
  let running: Promise<Result<DrainReport>> | undefined;
  let again = false;
  const loop = async (signal: AbortSignal): Promise<Result<DrainReport>> => {
    let last: Result<DrainReport> = ok({ drained: 0, problems: [] });
    do {
      again = false;
      last = await drainHomeJournal(services, signal);
    } while (again && !signal.aborted);
    return last;
  };
  return {
    run(signal) {
      if (running !== undefined) {
        again = true;
        return running;
      }
      running = loop(signal).finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
