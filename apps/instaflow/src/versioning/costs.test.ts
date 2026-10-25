/**
 * Costs scale with document size, never with age (D2, IF-5.9). Measured in store operations and
 * bytes — deterministic, so this is a unit test; the wall-clock version is `versioning.bench.ts`.
 *
 * A 12-page document gets 60 milestones with two pages edited between each. A **cold** session
 * (fresh repo, fresh services: no caches) then creates a milestone, opens the oldest and the newest
 * one, and makes a new document from each, at age 3, 20 and 60. Every count must be identical.
 */
import { describe, expect, it } from 'vitest';
import type { CountingStore } from './test-helpers.js';
import { createMilestoneService } from './milestones.js';
import { createDocumentFromMilestone } from './new-document.js';
import { createPartCapture } from './parts.js';
import type { AssetId, MilestoneId } from './records.js';
import { createCountingStore, editPages, engine, priya, registry, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';

/** Counts and equality only, never wall-clock: the timeout just keeps a loaded CI runner from failing it. */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

const PAGES = 12;
const PER_PAGE = 30;

interface Cost {
  readonly gets: number;
  readonly getBytes: number;
  readonly puts: number;
  readonly putBytes: number;
}

const cost = (store: CountingStore): Cost => {
  const { gets, getBytes, puts, putBytes } = store.counts();
  return { gets, getBytes, puts, putBytes };
};

async function age(store: CountingStore, asset: string, milestones: number, startAt: number): Promise<MilestoneId[]> {
  const repo = repoOn(store);
  const doc = unwrap(await repo.open(asset, signal));
  for (const id of doc.partIds()) unwrap(await doc.part(id, signal));
  const service = createMilestoneService({ doc, store, capture: createPartCapture({ store, registry }), registry, now: () => Date.UTC(2026, 0, 1) });
  const ids: MilestoneId[] = [];
  for (let i = 0; i < milestones; i += 1) {
    const n = startAt + i;
    await editPages(doc, [n % PAGES, (n + 5) % PAGES], 1000 + n);
    ids.push(unwrap(await service.create({ name: `M-${String(n).padStart(3, '0')}`, actor: priya }, signal)).entry.id);
  }
  unwrap(await doc.close(signal)); // compacts Latest (size-bound, never history-bound)
  return ids;
}

/** One cold session: create a milestone, open the oldest and newest, new document from each. */
async function coldSession(store: CountingStore, asset: string, n: number, oldest: MilestoneId): Promise<{ create: Cost; createdBlobs: number; openOldest: Cost; openNewest: Cost; fromOldest: Cost; fromNewest: Cost; headBytes: number }> {
  const repo = repoOn(store);
  const doc = unwrap(await repo.open(asset, signal));
  for (const id of doc.partIds()) unwrap(await doc.part(id, signal));
  await editPages(doc, [n % PAGES, (n + 5) % PAGES], 1000 + n);
  const service = createMilestoneService({ doc, store, capture: createPartCapture({ store, registry }), registry, now: () => Date.UTC(2026, 0, 1) });

  store.reset();
  const created = unwrap(await service.create({ name: `M-${String(n).padStart(3, '0')}`, actor: priya }, signal));
  const create = cost(store);
  const { headBytes, newBlobs: createdBlobs } = store.counts();

  const readAll = async (id: MilestoneId): Promise<Cost> => {
    const fresh = createMilestoneService({ doc, store, capture: createPartCapture({ store, registry }), registry });
    store.reset();
    const view = unwrap(await fresh.open(id, signal));
    for (const part of view.partIds()) unwrap(await view.part(part, signal));
    return cost(store);
  };
  const openOldest = await readAll(oldest);
  const openNewest = await readAll(created.entry.id);

  const fromMilestone = async (id: MilestoneId, target: AssetId): Promise<Cost> => {
    const record = unwrap(await createMilestoneService({ doc, store, capture: createPartCapture({ store, registry }), registry }).record(id, signal));
    store.reset();
    unwrap(await createDocumentFromMilestone({ store, engine, registry, now: () => 0, peer: () => '4242' }, { asset: target, actor: priya, source: { milestone: id, record, title: 'x' } }, signal));
    return cost(store);
  };
  const fromOldest = await fromMilestone(oldest, `as_old_${String(n).padStart(3, '0')}` as AssetId);
  const fromNewest = await fromMilestone(created.entry.id, `as_new_${String(n).padStart(3, '0')}` as AssetId);
  unwrap(await doc.close(signal));
  return { create, createdBlobs, openOldest, openNewest, fromOldest, fromNewest, headBytes };
}

describe('versioning costs vs age (IF-5.9)', () => {
  // Heavy by design (60 milestones over a 12-page document; ~2.2 s alone): its own timeout so a busy machine can't fail it.
  it('creating, opening and branching from milestones costs the same at age 3, 20 and 60', { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const store = createCountingStore();
    const asset = 'as_aging';
    const seed = await seedDocument(repoOn(store), asset, PAGES, PER_PAGE);
    await editPages(seed, Array.from({ length: PAGES }, (_, i) => i), 1000); // later edits are size-neutral (4 digits)
    unwrap(await seed.close(signal));

    const [first] = await age(store, asset, 2, 0);
    const at1 = await coldSession(store, asset, 2, first as MilestoneId);
    await age(store, asset, 16, 3);
    const at20 = await coldSession(store, asset, 20, first as MilestoneId);
    await age(store, asset, 39, 21);
    const at60 = await coldSession(store, asset, 60, first as MilestoneId);

    // Creation reads only the newest milestone's record and writes the two changed parts + one record.
    expect(at1.create).toEqual(at20.create);
    expect(at20.create).toEqual(at60.create);
    expect(at60.createdBlobs).toBe(3);
    expect(at1.createdBlobs).toBe(3);
    expect(at60.create.gets).toBe(1);
    // Opening any milestone reads its record and its parts — the oldest costs what the newest does.
    expect(at60.openOldest.gets).toBe(at60.openNewest.gets);
    expect(at1.openNewest).toEqual(at60.openNewest);
    expect(at1.openOldest).toEqual(at60.openOldest);
    // New document from milestone: one read per part, PAGES + 1 snapshots + one record written.
    expect(at1.fromNewest).toEqual(at60.fromNewest);
    expect(at1.fromOldest).toEqual(at60.fromOldest);
    expect(at60.fromNewest.gets).toBe(PAGES + 1);
    expect(at60.fromNewest.puts).toBe(PAGES + 2);
    // The head lists milestone ids (GC roots, DOCUMENT-FORMAT §5.2): ~85 bytes per entry, nothing else grows.
    expect((at60.headBytes - at20.headBytes) / 40).toBeLessThan(100);
  });
});
