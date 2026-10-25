/**
 * Seqlock cells (SF-Δ18): one "latest wins" value between threads — the view-state
 * frame (editor → render) and, through `clock-cell.ts`, the media clock. Readers
 * never block the writer and never see a half-written value:
 *
 *   writer: seq += 1 (odd) → write data (+ checksum) → seq += 1 (even) → publish
 *   reader: s1 = seq (retry while odd) → copy data → s2 = seq (retry if s1 ≠ s2)
 *
 * S2 caught 325 torn reads without the seqlock and 0 with it; the optional
 * checksum is the detector that proved it (keep it on in tests and dev builds).
 * A writer that dies mid-write leaves `seq` odd: readers give up after
 * `maxRetries` and return the last good copy marked `stale` (the last good frame
 * stays on screen).
 *
 * Region format (little-endian, format 1): Int32 words
 *   [0] seq [1] magic 'SFCL' [2] format [3] schema version [4] data bytes [5] checksum [6] closed [7] id hash
 *   data at byte 32 (16-aligned; layout views bind here).
 *
 * @example
 * export const ViewFrame = defineCell({ id: 'instaflow/view-frame', layout: ViewFrameLayout, checksum: true });
 * const cell = unwrap(createCell(ViewFrame, { medium }));          // editor
 * cell.write(({ record }) => { record.viewSeq = seq; record.docVersion = v; });
 * const frames = unwrap(await attachCell(ViewFrame, endpoint));     // render
 * const frame = frames.read(); if (frame !== undefined) draw(frame.record);
 */
import { err, ok, type Result } from '@staticflux/core';
import type { ChannelId } from './envelope.js';
import { fnv1aString, fnv1aWords } from './hash.js';
import type { Layout, LayoutFields, LayoutRecord } from './layout.js';
import { PipeClosedError, PipeMismatchError } from './pipeline-errors.js';
import {
  attachRegion,
  type AttachRegionOptions,
  createRegion,
  type CreateRegionOptions,
  type PipeMedium,
  type RegionEndpoint,
  type RegionSide,
  type RegionWaitOptions,
} from './region.js';

export const CELL_MAGIC = 0x5346434c; // 'SFCL'
export const CELL_FORMAT = 1;
export const CELL_HEADER_BYTES = 32;

const W_SEQ = 0;
const W_MAGIC = 1;
const W_FORMAT = 2;
const W_SCHEMA = 3;
const W_BYTES = 4;
const W_CHECKSUM = 5;
const W_CLOSED = 6;
const W_ID = 7;

const roundUp8 = (n: number): number => Math.ceil(n / 8) * 8;

export interface CellDefinition<F extends LayoutFields = LayoutFields> {
  readonly kind: 'cell';
  readonly id: ChannelId;
  /** Data bytes (the layout's stride when declared with a layout). */
  readonly bytes: number;
  readonly layout: Layout<F> | undefined;
  /** Schema version: bump on breaking layout changes (attach fails across versions). */
  readonly version: number;
  /** Store an FNV-1a checksum with every write and verify it on read (torn-read detector). */
  readonly checksum: boolean;
}

interface CellDeclarationBase<Id extends ChannelId> {
  readonly id: Id;
  readonly version?: number;
  readonly checksum?: boolean;
}

/** Declare a cell over a layout (typed `record` cursors) or over raw bytes. */
export function defineCell<const Id extends ChannelId, F extends LayoutFields>(
  declaration: CellDeclarationBase<Id> & { readonly layout: Layout<F> },
): CellDefinition<F>;
export function defineCell<const Id extends ChannelId>(
  declaration: CellDeclarationBase<Id> & { readonly bytes: number },
): CellDefinition<Record<never, never>>;
export function defineCell(
  declaration: CellDeclarationBase<ChannelId> & ({ readonly layout: Layout } | { readonly bytes: number }),
): CellDefinition {
  const layout = 'layout' in declaration ? declaration.layout : undefined;
  const bytes = layout === undefined ? (declaration as { bytes: number }).bytes : layout.stride;
  if (!Number.isInteger(bytes) || bytes <= 0) throw PipeMismatchError({ message: `Cell "${declaration.id}" needs bytes > 0.`, details: { bytes } });
  return Object.freeze({
    kind: 'cell',
    id: declaration.id,
    bytes,
    layout,
    version: declaration.version ?? 1,
    checksum: declaration.checksum ?? false,
  });
}

/** Region bytes a cell needs. */
export function cellByteLength(definition: CellDefinition): number {
  return CELL_HEADER_BYTES + roundUp8(definition.bytes);
}

export interface CellWriteSlot<F extends LayoutFields> {
  /** The data area in place (exactly `definition.bytes` long). */
  readonly bytes: Uint8Array;
  /** Layout cursor over the data area (cells declared with a layout). */
  readonly record: LayoutRecord<F>;
  /** Generation this write will publish. */
  readonly generation: number;
}

export interface CellWriter<F extends LayoutFields = LayoutFields> {
  readonly id: ChannelId;
  readonly medium: PipeMedium;
  /** Completed writes. */
  readonly generation: number;
  readonly closed: boolean;
  /** Write the value in place and publish it. Returns the new generation. */
  write(fill: (slot: CellWriteSlot<F>) => void): Result<number>;
  /** Endpoint for a reader (post it with `regionTransferList`). */
  endpoint(): Result<RegionEndpoint>;
  close(): void;
}

export interface CellSnapshot<F extends LayoutFields = LayoutFields> {
  readonly generation: number;
  /** Private copy of the data, valid until the next `read()`. */
  readonly bytes: Uint8Array;
  readonly record: LayoutRecord<F>;
  /** The checksum did not match (only possible with `seqlock: false`, the S2 validation mode). */
  readonly torn: boolean;
  /** The writer was mid-write for `maxRetries` spins: this is the previous good copy. */
  readonly stale: boolean;
}

export interface CellReadStats {
  readonly reads: number;
  /** Seqlock retries (odd sequence or sequence changed during the copy). */
  readonly retries: number;
  /** Checksum mismatches seen. Must stay 0 with the seqlock on. */
  readonly torn: number;
  /** Reads that gave up spinning and returned the last good copy. */
  readonly contended: number;
}

export interface CellReader<F extends LayoutFields = LayoutFields> {
  readonly id: ChannelId;
  readonly medium: PipeMedium;
  /** Generation of the last snapshot returned (0 before the first). */
  readonly generation: number;
  /** Generation currently published by the writer (no copy). */
  readonly latest: number;
  readonly closed: boolean;
  /** Latest stable value, or undefined when nothing was written yet. */
  read(): CellSnapshot<F> | undefined;
  /** Resolve `ok(true)` when a generation newer than the last read is published. */
  wait(options?: RegionWaitOptions): Promise<Result<boolean>>;
  /** Blocking wait (shared medium, workers only). */
  waitSync(timeoutMs: number): 'ok' | 'timed-out' | 'unsupported';
  readonly stats: CellReadStats;
  close(): void;
}

export type CreateCellOptions = Omit<CreateRegionOptions, 'byteLength'>;

/** Create a cell (writer side) on the given medium. */
export function createCell<F extends LayoutFields>(definition: CellDefinition<F>, options: CreateCellOptions): Result<CellWriter<F>> {
  const regionResult = createRegion({ ...options, byteLength: cellByteLength(definition) });
  if (!regionResult.ok) return regionResult;
  const region = regionResult.value;
  const { words } = region;
  words[W_MAGIC] = CELL_MAGIC;
  words[W_FORMAT] = CELL_FORMAT;
  words[W_SCHEMA] = definition.version;
  words[W_BYTES] = definition.bytes;
  words[W_ID] = fnv1aString(definition.id);
  region.publish([W_MAGIC, W_FORMAT, W_SCHEMA, W_BYTES, W_ID], [[0, CELL_HEADER_BYTES]]);

  const data = region.bytes.subarray(CELL_HEADER_BYTES, CELL_HEADER_BYTES + definition.bytes);
  const record = recordOver(definition, region.buffer, CELL_HEADER_BYTES);
  const dataWords = new Int32Array(region.buffer, CELL_HEADER_BYTES, roundUp8(definition.bytes) / 4);
  const range = [[CELL_HEADER_BYTES, CELL_HEADER_BYTES + roundUp8(definition.bytes)] as const];
  const slot = { bytes: data, record, generation: 0 };
  let closed = false;

  return ok({
    id: definition.id,
    medium: region.medium,
    get generation() {
      return Atomics.load(words, W_SEQ) >>> 1;
    },
    get closed() {
      return closed;
    },
    write(fill) {
      if (closed) return err(PipeClosedError({ details: { pipe: definition.id } }));
      const seq = Atomics.load(words, W_SEQ);
      Atomics.store(words, W_SEQ, (seq + 1) | 0); // odd: writing
      slot.generation = ((seq + 2) | 0) >>> 1;
      try {
        fill(slot);
        if (definition.checksum) words[W_CHECKSUM] = fnv1aWords(dataWords);
      } finally {
        Atomics.store(words, W_SEQ, (seq + 2) | 0); // even: stable
      }
      region.publish([W_CHECKSUM, W_SEQ], range);
      return ok(slot.generation);
    },
    endpoint: () => (closed ? err(PipeClosedError({ details: { pipe: definition.id } })) : region.endpoint()),
    close() {
      if (closed) return;
      closed = true;
      Atomics.store(words, W_CLOSED, 1);
      region.publish([W_CLOSED]);
      region.close();
    },
  });
}

function recordOver<F extends LayoutFields>(definition: CellDefinition<F>, buffer: ArrayBufferLike, byteOffset: number): LayoutRecord<F> {
  if (definition.layout === undefined) return {} as LayoutRecord<F>;
  const view = definition.layout.view(buffer, { byteOffset, count: 1 });
  if (!view.ok) throw view.error;
  return view.value.at(0);
}

/** Check a region's header against a pipe definition (shared by every pipe kind). */
export function checkPipeHeader(
  region: RegionSide,
  expected: { readonly id: ChannelId; readonly magic: number; readonly format: number; readonly schema: number },
  words: { readonly magic: number; readonly format: number; readonly schema: number; readonly id: number },
): Result<void> {
  const w = region.words;
  const got = {
    magic: Atomics.load(w, words.magic),
    format: Atomics.load(w, words.format),
    schema: Atomics.load(w, words.schema),
    id: Atomics.load(w, words.id),
  };
  if (got.magic !== expected.magic || got.format !== expected.format) {
    return err(PipeMismatchError({ message: 'Not a pipe of this kind, or an unknown format version.', details: { pipe: expected.id, ...got } }));
  }
  if (got.id !== fnv1aString(expected.id)) return err(PipeMismatchError({ message: `The endpoint belongs to another pipe than "${expected.id}".`, details: { pipe: expected.id } }));
  if (got.schema !== expected.schema) {
    return err(PipeMismatchError({ details: { pipe: expected.id, expectedVersion: expected.schema, version: got.schema } }));
  }
  return ok();
}

export interface AttachCellOptions extends AttachRegionOptions {
  /** Spins while the writer is mid-write before returning the last good copy. Default 10 000. */
  readonly maxRetries?: number;
  /**
   * Validation only (S2 `seqlock=0`): copy without the sequence check so the checksum
   * detector can prove torn reads happen. Never disable in production.
   */
  readonly seqlock?: boolean;
}

/** Attach a reader to a cell endpoint. */
export async function attachCell<F extends LayoutFields>(
  definition: CellDefinition<F>,
  endpoint: RegionEndpoint,
  options: AttachCellOptions = {},
): Promise<Result<CellReader<F>>> {
  if (endpoint.byteLength !== cellByteLength(definition)) {
    return err(PipeMismatchError({ details: { pipe: definition.id, byteLength: endpoint.byteLength, expected: cellByteLength(definition) } }));
  }
  const attached = await attachRegion(endpoint, options);
  if (!attached.ok) return attached;
  const region = attached.value;
  const header = checkPipeHeader(
    region,
    { id: definition.id, magic: CELL_MAGIC, format: CELL_FORMAT, schema: definition.version },
    { magic: W_MAGIC, format: W_FORMAT, schema: W_SCHEMA, id: W_ID },
  );
  if (!header.ok || Atomics.load(region.words, W_BYTES) !== definition.bytes) {
    region.close();
    return header.ok ? err(PipeMismatchError({ details: { pipe: definition.id } })) : header;
  }
  const { words } = region;
  const padded = roundUp8(definition.bytes);
  const source = region.bytes.subarray(CELL_HEADER_BYTES, CELL_HEADER_BYTES + padded);
  const copyBuffer = new ArrayBuffer(padded);
  const copy = new Uint8Array(copyBuffer);
  const copyWords = new Int32Array(copyBuffer);
  const record = recordOver(definition, copyBuffer, 0);
  const maxRetries = options.maxRetries ?? 10_000;
  const seqlock = options.seqlock ?? true;
  const stats = { reads: 0, retries: 0, torn: 0, contended: 0 };
  let generation = 0;
  let hasCopy = false;
  let closed = false;
  const snapshot = { generation: 0, bytes: copy.subarray(0, definition.bytes), record, torn: false, stale: false };

  const read = (): CellSnapshot<F> | undefined => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const s1 = Atomics.load(words, W_SEQ);
      if (s1 === 0) return undefined; // nothing published yet
      if (seqlock && (s1 & 1) !== 0) {
        stats.retries += 1;
        continue;
      }
      copy.set(source);
      const checksum = words[W_CHECKSUM] as number;
      const s2 = Atomics.load(words, W_SEQ);
      if (seqlock && s1 !== s2) {
        stats.retries += 1;
        continue;
      }
      const torn = definition.checksum && fnv1aWords(copyWords) !== checksum;
      if (torn) {
        stats.torn += 1;
        if (seqlock) continue; // detector only: with the seqlock this never happens
      }
      stats.reads += 1;
      hasCopy = true;
      generation = s1 >>> 1;
      snapshot.generation = generation;
      snapshot.torn = torn;
      snapshot.stale = false;
      return snapshot;
    }
    stats.contended += 1;
    if (!hasCopy) return undefined;
    snapshot.stale = true;
    return snapshot;
  };

  return ok({
    id: definition.id,
    medium: region.medium,
    get generation() {
      return generation;
    },
    get latest() {
      return Atomics.load(words, W_SEQ) >>> 1;
    },
    get closed() {
      return closed || Atomics.load(words, W_CLOSED) === 1;
    },
    read,
    async wait(waitOptions = {}) {
      const seq = Atomics.load(words, W_SEQ);
      if (seq >>> 1 !== generation && (seq & 1) === 0) return ok(true);
      if (closed || Atomics.load(words, W_CLOSED) === 1) return err(PipeClosedError({ details: { pipe: definition.id } }));
      return region.wait(W_SEQ, seq, waitOptions);
    },
    waitSync(timeoutMs) {
      const seq = Atomics.load(words, W_SEQ);
      if (seq >>> 1 !== generation && (seq & 1) === 0) return 'ok';
      return region.waitSync(W_SEQ, seq, timeoutMs);
    },
    get stats() {
      return { ...stats };
    },
    close() {
      if (closed) return;
      closed = true;
      region.close();
    },
  });
}
