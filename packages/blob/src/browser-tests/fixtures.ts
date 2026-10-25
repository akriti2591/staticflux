/**
 * Shared fixtures for the real-browser tests (page and worker). The document
 * is the S6 synthetic CRDT: a part's state is the set of commit ids applied to
 * it, so durability is checkable exactly.
 */
import { ok } from '@staticflux/core';
import {
  asDirectoryHandle,
  createLatestStore,
  createWorkspaceStore,
  type DirectoryHandleLike,
  encodeLatestRecord,
  frameRecord,
  fromUtf8,
  type JournalMode,
  type LatestStore,
  type LockManagerLike,
  segmentName,
  utf8,
  type WorkspaceStore,
} from '../index.js';

/** A fresh, empty OPFS directory `sf-browser-tests/<name>-<random>`. */
export async function freshOpfsDir(name: string): Promise<DirectoryHandleLike> {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle('sf-browser-tests', { create: true });
  return asDirectoryHandle(await base.getDirectoryHandle(`${name}-${crypto.randomUUID().slice(0, 8)}`, { create: true }));
}

/** An existing OPFS directory by path (creating it). */
export async function opfsDir(path: readonly string[]): Promise<DirectoryHandleLike> {
  let dir = await navigator.storage.getDirectory();
  for (const part of path) dir = await dir.getDirectoryHandle(part, { create: true });
  return asDirectoryHandle(dir);
}

export interface DocNode {
  readonly ws: WorkspaceStore;
  readonly latest: LatestStore;
  readonly ids: () => Set<string>;
  readonly recovery: Awaited<ReturnType<LatestStore['recover']>>;
  commit(batch: readonly { readonly id: string; readonly part: string }[]): Promise<void>;
}

export interface DocNodeOptions {
  readonly peer: string;
  readonly lockPrefix: string;
  readonly asset?: string;
  readonly journalMode?: JournalMode;
  readonly maxPartsPerSwap?: number;
  readonly locks?: LockManagerLike;
}

export async function openDocNode(root: DirectoryHandleLike, options: DocNodeOptions): Promise<DocNode> {
  const asset = options.asset ?? 'as_doc';
  const created = createWorkspaceStore(root, {
    lockPrefix: options.lockPrefix,
    peer: options.peer,
    ...(options.locks === undefined ? {} : { locks: options.locks }),
    ...(options.journalMode === undefined ? {} : { journalMode: options.journalMode }),
  });
  if (!created.ok) throw created.error;
  const ws = created.value;
  const state = new Map<string, Set<string>>();
  const apply = (id: string, part: string): void => {
    let set = state.get(part);
    if (set === undefined) state.set(part, (set = new Set()));
    set.add(id);
  };
  const latest = createLatestStore({
    blobs: ws.blobs,
    heads: ws.heads,
    journal: ws.journal(asset),
    name: asset,
    encoding: 'deflate-raw',
    mime: 'application/x-test-part',
    ...(options.maxPartsPerSwap === undefined ? {} : { maxPartsPerSwap: options.maxPartsPerSwap }),
    snapshot: (part) => ok(utf8(JSON.stringify([...(state.get(part) ?? [])].sort()))),
  });
  const recovery = await latest.recover();
  if (recovery.ok) {
    for (const [part, ref] of Object.entries(recovery.value.head?.parts ?? {})) {
      const bytes = await ws.blobs.get(ref);
      if (!bytes.ok) throw bytes.error;
      for (const id of JSON.parse(fromUtf8(bytes.value)) as string[]) apply(id, part);
    }
    for (const record of recovery.value.records) for (const part of record.parts) apply(record.id, part);
  }
  return {
    ws,
    latest,
    recovery,
    ids: () => new Set([...state.values()].flatMap((s) => [...s])),
    async commit(batch) {
      for (const c of batch) apply(c.id, c.part);
      const appended = await latest.append(batch.map((c) => ({ id: c.id, parts: [c.part], data: utf8(c.id) })));
      if (!appended.ok) throw appended.error;
    },
  };
}

export const batchOf = (peer: string, k: number, parts = 7): { id: string; part: string }[] =>
  Array.from({ length: 10 }, (_, i) => ({ id: `${peer}:${k}:${i}`, part: `page:${(k + i) % parts}` }));

/**
 * The S6 fault-injection suite against a real directory: crash after blobs,
 * before the head move, after the head; then a torn log tail. Throws on failure.
 */
export async function runFaultInjection(mode: JournalMode, failAt: 'afterBlobs' | 'beforeMove' | 'afterHead'): Promise<{ recovered: number; tempsLeft: number }> {
  const root = await freshOpfsDir(`fault-${mode}-${failAt}`);
  const lockPrefix = `fault-${crypto.randomUUID()}`;
  const a = await openDocNode(root, { peer: 'A', lockPrefix, journalMode: mode });
  const acked: string[] = [];
  for (let k = 0; k < 5; k++) {
    await a.commit(batchOf('A', k));
    acked.push(...batchOf('A', k).map((c) => c.id));
  }
  const first = await a.latest.compact();
  if (!first.ok) throw first.error;
  for (let k = 5; k < 10; k++) {
    await a.commit(batchOf('A', k));
    acked.push(...batchOf('A', k).map((c) => c.id));
  }
  const crash = (): never => {
    throw new Error('simulated crash');
  };
  const crashed = await a.latest.compact({ hooks: { [failAt]: crash } });
  if (crashed.ok) throw new Error(`compaction did not crash at ${failAt}`);
  await a.latest.close();
  const b = await openDocNode(root, { peer: 'B', lockPrefix, journalMode: mode });
  if (!b.recovery.ok) throw b.recovery.error;
  const missing = acked.filter((id) => !b.ids().has(id));
  if (missing.length > 0) throw new Error(`${missing.length} acknowledged commits lost after a crash ${failAt}`);
  let tempsLeft = 0;
  const heads = await root.getDirectoryHandle('heads');
  for await (const entry of heads.values()) if (entry.name.includes('.tmp-')) tempsLeft += 1;
  await b.latest.close();
  return { recovered: b.ids().size, tempsLeft };
}

/** Torn log tail on a real directory: 3 good batches, then half a record. */
export async function runTornLogTail(mode: JournalMode): Promise<{ tornTails: number; goodKept: boolean; tornDropped: boolean }> {
  const root = await freshOpfsDir(`torn-${mode}`);
  const lockPrefix = `torn-${crypto.randomUUID()}`;
  const b = await openDocNode(root, { peer: 'B', lockPrefix, journalMode: mode });
  const good = Array.from({ length: 30 }, (_, i) => ({ id: `B:${i}`, part: 'page:1' }));
  for (let i = 0; i < 3; i++) await b.commit(good.slice(i * 10, i * 10 + 10));
  await b.latest.close();
  const frame = frameRecord(encodeLatestRecord({ id: 'B:torn', parts: ['page:1'], data: utf8('x') }));
  const log = await (await root.getDirectoryHandle('log')).getDirectoryHandle('as_doc');
  const writable = await (await log.getFileHandle(segmentName(99_999, 'B'), { create: true })).createWritable();
  await writable.write(frame.subarray(0, frame.length - 5));
  await writable.close();
  const c = await openDocNode(root, { peer: 'C', lockPrefix, journalMode: mode });
  if (!c.recovery.ok) throw c.recovery.error;
  const result = {
    tornTails: c.recovery.value.report.tornTails,
    goodKept: good.every((g) => c.ids().has(g.id)),
    tornDropped: !c.ids().has('B:torn'),
  };
  await c.latest.close();
  return result;
}
