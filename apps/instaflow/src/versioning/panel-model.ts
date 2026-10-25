/**
 * The Milestones panel's model: the headless operations behind every control, so the panel is a
 * thin view and every action has the same non-agent path (keyboard, pointer, command palette).
 * Showing read-only surfaces and opening documents is the editor's job (B0 mounts them), reached
 * through the `VersioningHost` port.
 */
import { box, ok, type Result } from '@staticflux/core';
import type { Actor } from '@staticflux/stage';
import { type CompareSession, type CompareSide, openComparison } from './compare.js';
import type { MilestoneEntry, MilestoneService } from './milestones.js';
import { createDocumentFromMilestone, type NewDocument, type NewDocumentServiceOptions } from './new-document.js';
import type { ReadOnlyDocument } from './readonly.js';
import type { AssetId, MilestoneId } from './records.js';
import type { ExportSnapshotService } from './snapshot.js';

/** What the editor shell does with versioning results (B0 / C3 implement it). */
export interface VersioningHost {
  /** Mount a read-only surface (same renderer, no editing capabilities, banner names the milestone). */
  showReadOnly(doc: ReadOnlyDocument): void;
  /** Mount two read-only surfaces side by side. */
  showComparison(session: CompareSession): void;
  /** Open another document (e.g. the one "New document from milestone" just made). */
  openDocument(asset: AssetId): void;
}

export type PanelBusy = 'idle' | 'creating' | 'working';

export interface MilestonesPanelModel {
  /** Newest first (reactive). */
  milestones(): readonly MilestoneEntry[];
  /** What the panel is waiting for (reactive). */
  busy(): PanelBusy;
  refresh(): Promise<Result<readonly MilestoneEntry[]>>;
  create(name: string, note?: string): Promise<Result<MilestoneEntry>>;
  pin(id: MilestoneId, pinned: boolean): Promise<Result<void>>;
  rename(id: MilestoneId, name: string): Promise<Result<void>>;
  open(id: MilestoneId): Promise<Result<ReadOnlyDocument>>;
  /** One milestone against Latest, or two milestones. */
  compare(left: CompareSide, right: CompareSide): Promise<Result<CompareSession>>;
  newDocument(id: MilestoneId): Promise<Result<NewDocument>>;
}

/**
 * What the Milestones panel element reads and calls: plain data and plain outcomes (it only checks whether `open`,
 * `compare` and `newDocument` worked; the host shows their results), so the model can live in another thread
 * (B9: the editor worker) behind a mirror. Every `MilestonesPanelModel` is one.
 */
export interface MilestonesPanelPort {
  milestones(): readonly MilestoneEntry[];
  busy(): PanelBusy;
  refresh(): Promise<Result<readonly MilestoneEntry[]>>;
  create(name: string, note?: string): Promise<Result<MilestoneEntry>>;
  pin(id: MilestoneId, pinned: boolean): Promise<Result<void>>;
  rename(id: MilestoneId, name: string): Promise<Result<void>>;
  open(id: MilestoneId): Promise<Result<unknown>>;
  compare(left: CompareSide, right: CompareSide): Promise<Result<unknown>>;
  newDocument(id: MilestoneId): Promise<Result<unknown>>;
}

export interface MilestonesPanelModelOptions {
  readonly milestones: MilestoneService;
  readonly snapshots: Pick<ExportSnapshotService, 'freeze' | 'open'>;
  readonly documents: NewDocumentServiceOptions;
  readonly host: VersioningHost;
  /** The person using the panel. */
  readonly actor: () => Actor;
  /** A fresh asset id for each new document (uuidv7). */
  readonly newAssetId: () => AssetId;
  /** The open document's title, for the new document's "created from" label. */
  readonly title: () => string;
  /** Aborted when the panel's scope ends. */
  readonly signal: AbortSignal;
}

export function createMilestonesPanelModel(options: MilestonesPanelModelOptions): MilestonesPanelModel {
  const busy = box<PanelBusy>('idle');
  const { milestones, signal } = options;
  const track = async <T>(state: PanelBusy, run: () => Promise<Result<T>>): Promise<Result<T>> => {
    busy.set(state);
    try {
      return await run();
    } finally {
      busy.set('idle');
    }
  };
  return {
    milestones: () => milestones.list(),
    busy: () => busy.get(),
    refresh: () => milestones.refresh(signal),
    create: (name, note) =>
      track('creating', async () => {
        const created = await milestones.create({ name, ...(note === undefined ? {} : { note }), actor: options.actor() }, signal);
        return created.ok ? ok(created.value.entry) : created;
      }),
    pin: (id, pinned) => track('working', () => milestones.pin(id, pinned, signal)),
    rename: (id, name) => track('working', () => milestones.rename(id, name, signal)),
    open: (id) =>
      track('working', async () => {
        const doc = await milestones.open(id, signal);
        if (doc.ok) options.host.showReadOnly(doc.value);
        return doc;
      }),
    compare: (left, right) =>
      track('working', async () => {
        const session = await openComparison({ milestones, snapshots: options.snapshots }, left, right, signal);
        if (session.ok) options.host.showComparison(session.value);
        return session;
      }),
    newDocument: (id) =>
      track('working', async () => {
        const record = await milestones.record(id, signal);
        if (!record.ok) return record;
        const name = milestones.list().find((m) => m.id === id)?.name ?? record.value.name;
        const made = await createDocumentFromMilestone(
          options.documents,
          { asset: options.newAssetId(), actor: options.actor(), source: { milestone: id, record: record.value, title: `${options.title()} · ${name}` } },
          signal,
        );
        if (made.ok) options.host.openDocument(made.value.asset);
        return made;
      }),
  };
}
