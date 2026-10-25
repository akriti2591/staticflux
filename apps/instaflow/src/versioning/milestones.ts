/**
 * Milestones (D2, IF-5.4–5.6, 5.9, 5.11; DOCUMENT-FORMAT §6.1): named, immutable full snapshots
 * of Latest made of canonical parts that unchanged milestones share by digest. Never diff chains.
 *
 * - **Create** (`instaflow/milestone-create`): flush Latest → capture parts (only changed parts
 *   are encoded and written) → write the record (its digest is its id) → swap the head by CAS
 *   (prepend to `milestones`) → flush the folder mirror (milestones always reach the folder).
 *   One creation at a time per document; concurrent calls queue.
 * - **Costs** depend on the document's size only: a creation reads the newest milestone's record
 *   (for `parent` and its digests) and never walks older ones; open reads only the viewed parts.
 * - **Pin and rename** are head fields: the record is never rewritten.
 * - **Open** is read-only, from canonical parts (no CRDT).
 */
import { box, createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import type { BlobRef, ComponentRegistry, Digest, DocumentStore, PartId } from '@staticflux/document/v2';
import { type Actor, actorRecord } from '@staticflux/stage';
import { MilestoneDataError, MilestoneNameError, UnknownMilestoneError, VersioningDisposedError } from './errors.js';
import { type MilestoneHeadEntry, readVersioningState, updateVersioningState, type VersioningState } from './head-state.js';
import type { PartCapture, PartSource } from './parts.js';
import { MAX_MILESTONE_NAME, MAX_MILESTONE_NOTE } from './tokens.js';
import { openReadOnlyDocument, type ReadOnlyDocument } from './readonly.js';
import {
  type ActorJson,
  type AssetId,
  decodeMilestoneRecord,
  digestOfId,
  encodeRecord,
  MILESTONE_SCHEMA,
  type MilestoneId,
  milestoneIdOf,
  type MilestoneRecord,
} from './records.js';


export const MilestoneCreateMachine = /* @__PURE__ */ defineMachine({
  id: 'instaflow/milestone-create',
  initial: 'queued',
  states: ['queued', 'flushing', 'capturing', 'recording', 'swapping', 'created', 'failed'],
  transitions: {
    queued: { start: 'flushing', fail: 'failed' },
    flushing: { flushed: 'capturing', fail: 'failed' },
    capturing: { captured: 'recording', fail: 'failed' },
    recording: { recorded: 'swapping', fail: 'failed' },
    swapping: { swapped: 'created', fail: 'failed' },
  },
  terminal: ['created', 'failed'],
});

export type MilestoneCreateState = (typeof MilestoneCreateMachine.states)[number];

/** A milestone as the list shows it. */
export interface MilestoneEntry {
  readonly id: MilestoneId;
  /** The display name (a rename wins over the record's name). */
  readonly name: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly createdBy: ActorJson;
  readonly pinned: boolean;
  readonly parent?: MilestoneId;
  readonly partCount: number;
}

export interface CreateMilestoneInput {
  readonly name: string;
  readonly note?: string;
  readonly actor: Actor;
}

export interface CreatedMilestone {
  readonly entry: MilestoneEntry;
  readonly record: MilestoneRecord;
  /** Parts whose canonical bytes were new (everything else is shared by digest). */
  readonly written: readonly PartId[];
  readonly bytesWritten: number;
  /** False when the folder mirror flush failed (the milestone is still saved in the browser store). */
  readonly mirrored: boolean;
}

/** The open document a milestone service reads (structurally a `DocumentRepo` `OpenDocument`). */
export interface MilestoneSource extends PartSource {
  flush(signal: AbortSignal): Promise<Result<void>>;
}

/** Flushed after each creation when the workspace is mirrored to a folder (structurally `FolderMirror`). */
export interface MirrorFlush {
  flush(signal?: AbortSignal): Promise<Result<unknown>>;
}

export interface MilestoneServiceOptions {
  readonly doc: MilestoneSource;
  readonly store: DocumentStore;
  readonly capture: PartCapture;
  readonly registry?: ComponentRegistry;
  /** Default: the registry version, else 1. */
  readonly treeSchema?: number;
  readonly now?: () => number;
  readonly mirror?: MirrorFlush;
  /** Observe creation states (devtools, tests). */
  readonly onCreateState?: (state: MilestoneCreateState) => void;
}

export interface MilestoneService {
  readonly asset: AssetId;
  /** The current list, newest first (reactive). */
  list(): readonly MilestoneEntry[];
  /** Re-read the head and any records not seen yet. */
  refresh(signal: AbortSignal): Promise<Result<readonly MilestoneEntry[]>>;
  create(input: CreateMilestoneInput, signal: AbortSignal): Promise<Result<CreatedMilestone>>;
  record(id: MilestoneId, signal: AbortSignal): Promise<Result<MilestoneRecord>>;
  pin(id: MilestoneId, pinned: boolean, signal: AbortSignal): Promise<Result<void>>;
  rename(id: MilestoneId, name: string, signal: AbortSignal): Promise<Result<void>>;
  /** Read-only, from canonical parts. */
  open(id: MilestoneId, signal: AbortSignal): Promise<Result<ReadOnlyDocument>>;
  dispose(): void;
}

/** Trim and check a milestone name (IF-VER-001). */
export function validateMilestoneName(name: string): Result<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MILESTONE_NAME) return err(MilestoneNameError({ details: { length: trimmed.length } }));
  return ok(trimmed);
}

export function createMilestoneService(options: MilestoneServiceOptions): MilestoneService {
  const asset = options.doc.asset as AssetId;
  const now = options.now ?? Date.now;
  const treeSchema = options.treeSchema ?? options.registry?.version ?? 1;
  const records = new Map<MilestoneId, MilestoneRecord>();
  const entries = box<readonly MilestoneEntry[]>([]);
  let disposed = false;
  /** True once the list was loaded (`refresh`, pin, rename): creation then keeps it current. */
  let listed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const disposedError = (): Result<never> => err(VersioningDisposedError({ details: { asset } }));

  const entryOf = (id: MilestoneId, record: MilestoneRecord, state: VersioningState): MilestoneEntry => ({
    id,
    name: state.names[id] ?? record.name,
    ...(record.note === undefined ? {} : { note: record.note }),
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    pinned: state.pinned.includes(id),
    ...(record.parent === undefined ? {} : { parent: record.parent }),
    partCount: Object.keys(record.parts).length,
  });

  const loadRecord = async (entry: MilestoneHeadEntry, signal: AbortSignal): Promise<Result<MilestoneRecord>> => {
    const cached = records.get(entry.id);
    if (cached !== undefined) return ok(cached);
    const digest = digestOfId(entry.id);
    const bytes = await options.store.getBlob({ digest, size: entry.size }, signal);
    if (!bytes.ok) return err(MilestoneDataError({ message: 'A milestone record is missing from the store.', details: { milestone: entry.id, digest }, cause: bytes.error }));
    const record = decodeMilestoneRecord(bytes.value, digest);
    if (!record.ok) return record;
    records.set(entry.id, record.value);
    return record;
  };

  /** Rebuild the reactive list from a head state (loading records not seen yet). */
  const publish = async (state: VersioningState, signal: AbortSignal): Promise<Result<readonly MilestoneEntry[]>> => {
    const list: MilestoneEntry[] = [];
    for (const entry of state.milestones) {
      const record = await loadRecord(entry, signal);
      if (!record.ok) return record;
      list.push(entryOf(entry.id, record.value, state));
    }
    entries.set(list);
    listed = true;
    return ok(list);
  };

  const headEntry = (state: VersioningState, id: MilestoneId): MilestoneHeadEntry | undefined => state.milestones.find((e) => e.id === id);

  const runCreate = async (input: CreateMilestoneInput, name: string, note: string | undefined, signal: AbortSignal): Promise<Result<CreatedMilestone>> => {
    const machine = createMachine(MilestoneCreateMachine);
    const step = (event: Parameters<typeof machine.send>[0]): void => {
      machine.send(event);
      options.onCreateState?.(machine.state);
    };
    const fail = <T>(result: Result<T>): Result<T> => {
      if (!result.ok) step('fail');
      return result;
    };
    if (disposed) return fail(disposedError());
    step('start');
    const flushed = await options.doc.flush(signal);
    if (!flushed.ok) return fail(flushed);
    step('flushed');

    const head = await options.store.readHead(asset, signal);
    if (!head.ok) return fail(head);
    const before = readVersioningState(head.value);
    const newest = before.milestones[0];
    let known: ReadonlySet<Digest> = new Set();
    if (newest !== undefined) {
      const parentRecord = await loadRecord(newest, signal);
      if (!parentRecord.ok) return fail(parentRecord);
      known = new Set(Object.values(parentRecord.value.parts).map((ref: BlobRef) => ref.digest));
    }
    const captured = await options.capture.capture(options.doc, signal, { known });
    if (!captured.ok) return fail(captured);
    step('captured');

    const record: MilestoneRecord = {
      schema: MILESTONE_SCHEMA,
      asset,
      kind: 'named',
      name,
      ...(note === undefined ? {} : { note }),
      createdAt: new Date(now()).toISOString(),
      createdBy: actorRecord(input.actor) as unknown as ActorJson,
      ...(newest === undefined ? {} : { parent: newest.id }),
      treeSchema,
      parts: captured.value.parts,
      references: captured.value.references,
    };
    const bytes = encodeRecord(record);
    if (!bytes.ok) return fail(bytes);
    const stored = await options.store.putBlob(bytes.value, signal);
    if (!stored.ok) return fail(stored);
    const id = milestoneIdOf(stored.value.digest);
    records.set(id, record);
    step('recorded');

    const swapped = await updateVersioningState(
      options.store,
      asset,
      (state) => (headEntry(state, id) !== undefined ? ok(undefined) : ok({ ...state, milestones: [{ id, size: stored.value.size }, ...state.milestones] })),
      signal,
    );
    if (!swapped.ok) return fail(swapped);
    step('swapped');

    const mirrored = options.mirror === undefined ? true : (await options.mirror.flush(signal)).ok;
    // Keep a loaded list current; never load the whole list just to create (that would cost O(age)).
    if (listed || swapped.value.state.milestones.every((e) => records.has(e.id))) {
      const published = await publish(swapped.value.state, signal);
      if (!published.ok) return published;
    }
    return ok({
      entry: entryOf(id, record, swapped.value.state),
      record,
      written: captured.value.written,
      bytesWritten: captured.value.bytesWritten + stored.value.size,
      mirrored,
    });
  };

  const known = async (id: MilestoneId, signal: AbortSignal): Promise<Result<{ entry: MilestoneHeadEntry; record: MilestoneRecord }>> => {
    const head = await options.store.readHead(asset, signal);
    if (!head.ok) return head;
    const entry = headEntry(readVersioningState(head.value), id);
    if (entry === undefined) return err(UnknownMilestoneError({ details: { asset, milestone: id } }));
    const record = await loadRecord(entry, signal);
    return record.ok ? ok({ entry, record: record.value }) : record;
  };

  const updateEntry = async (id: MilestoneId, change: (state: VersioningState) => VersioningState | undefined, signal: AbortSignal): Promise<Result<void>> => {
    if (disposed) return disposedError();
    const updated = await updateVersioningState(
      options.store,
      asset,
      (state) => (headEntry(state, id) === undefined ? err(UnknownMilestoneError({ details: { asset, milestone: id } })) : ok(change(state))),
      signal,
    );
    if (!updated.ok) return updated;
    const published = await publish(updated.value.state, signal);
    return published.ok ? ok() : published;
  };

  return {
    asset,
    list: () => entries.get(),
    async refresh(signal) {
      if (disposed) return disposedError();
      const head = await options.store.readHead(asset, signal);
      if (!head.ok) return head;
      return publish(readVersioningState(head.value), signal);
    },
    create(input, signal) {
      const name = validateMilestoneName(input.name);
      if (!name.ok) return Promise.resolve(name);
      const note = input.note?.trim();
      if (note !== undefined && note.length > MAX_MILESTONE_NOTE) return Promise.resolve(err(MilestoneNameError({ message: `A milestone note is at most ${MAX_MILESTONE_NOTE} characters.`, details: { length: note.length } })));
      const run = queue.then(() => runCreate(input, name.value, note === undefined || note.length === 0 ? undefined : note, signal));
      queue = run.catch(() => undefined);
      return run;
    },
    async record(id, signal) {
      if (disposed) return disposedError();
      const found = await known(id, signal);
      return found.ok ? ok(found.value.record) : found;
    },
    pin(id, pinned, signal) {
      return updateEntry(
        id,
        (state) => {
          const has = state.pinned.includes(id);
          if (has === pinned) return undefined;
          return { ...state, pinned: pinned ? [id, ...state.pinned] : state.pinned.filter((p) => p !== id) };
        },
        signal,
      );
    },
    async rename(id, rawName, signal) {
      const name = validateMilestoneName(rawName);
      if (!name.ok) return name;
      return updateEntry(
        id,
        (state) => {
          if ((state.names[id] ?? records.get(id)?.name) === name.value) return undefined;
          return { ...state, names: { ...state.names, [id]: name.value } };
        },
        signal,
      );
    },
    async open(id, signal) {
      if (disposed) return disposedError();
      const found = await known(id, signal);
      if (!found.ok) return found;
      const { record } = found.value;
      const head = await options.store.readHead(asset, signal);
      const display = head.ok ? (readVersioningState(head.value).names[id] ?? record.name) : record.name;
      return ok(
        openReadOnlyDocument({
          store: options.store,
          asset,
          source: { kind: 'milestone', id, name: display, createdAt: record.createdAt },
          treeSchema: record.treeSchema,
          parts: record.parts,
          ...(options.registry === undefined ? {} : { registry: options.registry }),
        }),
      );
    },
    dispose() {
      disposed = true;
      options.capture.forget(asset);
    },
  };
}
