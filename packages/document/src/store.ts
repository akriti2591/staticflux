/**
 * `DocumentStore` (SF-Δ3): the persistence port `DocumentRepo` writes through.
 * Three kinds of state, matching the workspace store layout (DOCUMENT-FORMAT §5):
 *
 * - **heads** — one small mutable record per asset, replaced only by
 *   compare-and-swap on `generation` (`SF-DOC-011` on mismatch);
 * - **blobs** — immutable, content-addressed bytes (part snapshots, undo history);
 * - **log** — an append-only, per-asset sequence of commit records; the store
 *   assigns `seq`; compaction truncates entries below the head's `logFrom`.
 *
 * The workspace store (`@staticflux/blob`, OPFS / folder backends) implements
 * this port; `createMemoryDocumentStore()` is the in-memory reference used by
 * tests and the contract suite (`runDocumentStoreContract` in testkit).
 */
import { AbortedError, err, ok, type Result, type SfError } from '@staticflux/core';
import { HeadConflictError, MissingBlobError } from './errors.js';
import { type JsonObject, sha256Digest } from './json.js';

export type Digest = `sha256:${string}`;
/** Part of a tree asset: the document-level part (`root`) or one page / flow (`page:<id>`). */
export type PartId = string;

export interface BlobRef {
  readonly digest: Digest;
  readonly size: number;
}

export interface DocumentHead {
  readonly asset: string;
  /** CAS counter: 1 for the first head, +1 per replacement. */
  readonly generation: number;
  /** CRDT engine of the part snapshots (`loro/1`). */
  readonly engine: string;
  /** Component registry version. */
  readonly treeSchema: number;
  /** One snapshot per part. */
  readonly parts: Readonly<Record<PartId, BlobRef>>;
  /** First live log seq (everything below is folded into the snapshots). */
  readonly logFrom: number;
  /** Undo steps kept per actor at compaction. */
  readonly undoHorizon: number;
  /** Inverse ops older than the live log, within the horizon. */
  readonly undo?: BlobRef;
  /** App-owned fields (milestones, pinned, read-only flag…), carried unchanged by the repo. */
  readonly app?: JsonObject;
}

export interface LogEntry {
  readonly seq: number;
  readonly bytes: Uint8Array;
}

export interface DocumentStore {
  readHead(asset: string, signal: AbortSignal): Promise<Result<DocumentHead | undefined>>;
  /**
   * Replace the head iff the stored generation equals `expected` (`null`: no head may exist yet).
   * `head.generation` must be `expected + 1` (or 1). Mismatch → `SF-DOC-011`.
   */
  writeHead(asset: string, head: DocumentHead, expected: number | null, signal: AbortSignal): Promise<Result<void>>;
  /** Store immutable bytes; idempotent (same bytes → same ref). */
  putBlob(bytes: Uint8Array, signal: AbortSignal): Promise<Result<BlobRef>>;
  /** Missing → `SF-DOC-012`. */
  getBlob(ref: BlobRef, signal: AbortSignal): Promise<Result<Uint8Array>>;
  /** Append one record; resolves with its seq (strictly increasing per asset, never reused). */
  appendLog(asset: string, bytes: Uint8Array, signal: AbortSignal): Promise<Result<number>>;
  /** Entries with `seq >= from`, in seq order. */
  readLog(asset: string, from: number, signal: AbortSignal): Promise<Result<readonly LogEntry[]>>;
  /** Drop entries with `seq < before`. */
  truncateLog(asset: string, before: number, signal: AbortSignal): Promise<Result<void>>;
}

export interface MemoryDocumentStore extends DocumentStore {
  /** Inspection for tests. */
  stats(): { readonly heads: number; readonly blobs: number; readonly blobBytes: number; readonly logEntries: number };
  /** The next call of `operation` fails with `error` (fault injection for tests). */
  failNext(operation: keyof DocumentStore, error: SfError): void;
}

const aborted = (signal: AbortSignal): Result<never> | undefined => (signal.aborted ? err(AbortedError({ cause: signal.reason })) : undefined);

function cloneHead(head: DocumentHead): DocumentHead {
  return structuredClone(head);
}

export function createMemoryDocumentStore(): MemoryDocumentStore {
  const heads = new Map<string, DocumentHead>();
  const blobs = new Map<Digest, Uint8Array>();
  const logs = new Map<string, { next: number; entries: LogEntry[] }>();
  const faults = new Map<keyof DocumentStore, SfError>();

  const fault = (operation: keyof DocumentStore): Result<never> | undefined => {
    const error = faults.get(operation);
    if (error === undefined) return undefined;
    faults.delete(operation);
    return err(error);
  };
  const logOf = (asset: string): { next: number; entries: LogEntry[] } => {
    let log = logs.get(asset);
    if (log === undefined) logs.set(asset, (log = { next: 1, entries: [] }));
    return log;
  };

  return {
    async readHead(asset, signal) {
      const stop = aborted(signal) ?? fault('readHead');
      if (stop !== undefined) return stop;
      const head = heads.get(asset);
      return ok(head === undefined ? undefined : cloneHead(head));
    },
    async writeHead(asset, head, expected, signal) {
      const stop = aborted(signal) ?? fault('writeHead');
      if (stop !== undefined) return stop;
      const current = heads.get(asset);
      const currentGeneration = current?.generation ?? null;
      if (currentGeneration !== expected || head.generation !== (expected ?? 0) + 1 || head.asset !== asset) {
        return err(HeadConflictError({ details: { asset, expected, current: currentGeneration, proposed: head.generation } }));
      }
      heads.set(asset, cloneHead(head));
      return ok();
    },
    async putBlob(bytes, signal) {
      const stop = aborted(signal) ?? fault('putBlob');
      if (stop !== undefined) return stop;
      const digest = await sha256Digest(bytes);
      if (!blobs.has(digest)) blobs.set(digest, bytes.slice());
      return ok({ digest, size: bytes.byteLength });
    },
    async getBlob(ref, signal) {
      const stop = aborted(signal) ?? fault('getBlob');
      if (stop !== undefined) return stop;
      const bytes = blobs.get(ref.digest);
      return bytes === undefined ? err(MissingBlobError({ details: { digest: ref.digest } })) : ok(bytes.slice());
    },
    async appendLog(asset, bytes, signal) {
      const stop = aborted(signal) ?? fault('appendLog');
      if (stop !== undefined) return stop;
      const log = logOf(asset);
      const seq = log.next;
      log.next += 1;
      log.entries.push({ seq, bytes: bytes.slice() });
      return ok(seq);
    },
    async readLog(asset, from, signal) {
      const stop = aborted(signal) ?? fault('readLog');
      if (stop !== undefined) return stop;
      return ok(logOf(asset).entries.filter((e) => e.seq >= from).map((e) => ({ seq: e.seq, bytes: e.bytes.slice() })));
    },
    async truncateLog(asset, before, signal) {
      const stop = aborted(signal) ?? fault('truncateLog');
      if (stop !== undefined) return stop;
      const log = logOf(asset);
      log.entries = log.entries.filter((e) => e.seq >= before);
      return ok();
    },
    stats: () => ({
      heads: heads.size,
      blobs: blobs.size,
      blobBytes: [...blobs.values()].reduce((n, b) => n + b.byteLength, 0),
      logEntries: [...logs.values()].reduce((n, l) => n + l.entries.length, 0),
    }),
    failNext(operation, error) {
      faults.set(operation, error);
    },
  };
}
