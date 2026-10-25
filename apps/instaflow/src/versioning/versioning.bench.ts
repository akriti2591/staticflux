/**
 * BENCH (wall clock; not part of `pnpm test`): versioning costs vs document age, the S6 shape —
 * a 200-page document, 60 nodes per page, 5 pages changed per milestone (S6: 254 ms median in
 * Chromium on OPFS, 56 KB written). Here on the in-memory store, so it measures canonicalization,
 * hashing and the record/head swap, not OPFS file creation. Age 1 and age 50 must be the same
 * (IF-5.9); the deterministic version of this check is `costs.test.ts`.
 *
 *   pnpm vitest bench --run apps/instaflow/src/versioning/versioning.bench.ts
 */
import type { OpenDocument } from '@staticflux/document/v2';
import { describe, test } from 'vitest';
import { createMilestoneService, type MilestoneService } from './milestones.js';
import { createDocumentFromMilestone } from './new-document.js';
import { createPartCapture } from './parts.js';
import type { AssetId } from './records.js';
import { createCountingStore, type CountingStore, editPages, engine, priya, registry, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';

const PAGES = 200;
const PER_PAGE = 60;
const CHANGED = 5;

interface Fixture {
  readonly store: CountingStore;
  readonly doc: OpenDocument;
  readonly milestones: MilestoneService;
  n: number;
}

async function fixture(asset: string, age: number): Promise<Fixture> {
  const store = createCountingStore();
  const doc = await seedDocument(repoOn(store), asset, PAGES, PER_PAGE);
  const milestones = createMilestoneService({ doc, store, capture: createPartCapture({ store, registry }), registry });
  const f: Fixture = { store, doc, milestones, n: 0 };
  for (let i = 0; i < age; i += 1) await step(f);
  return f;
}

async function step(f: Fixture): Promise<void> {
  f.n += 1;
  await editPages(f.doc, Array.from({ length: CHANGED }, (_, i) => (f.n * 7 + i * 31) % PAGES), 1000 + f.n);
  unwrap(await f.milestones.create({ name: `M-${f.n}`, actor: priya }, signal));
}

const young = await fixture('as_young', 1);
const old = await fixture('as_old', 50);

const openAll = async (f: Fixture, which: 'oldest' | 'newest'): Promise<void> => {
  const list = unwrap(await f.milestones.refresh(signal));
  const entry = which === 'oldest' ? list.at(-1) : list[0];
  if (entry === undefined) throw new Error('no milestone');
  const view = unwrap(await f.milestones.open(entry.id, signal));
  for (const id of view.partIds()) unwrap(await view.part(id, signal));
};

let seq = 0;
const branch = async (f: Fixture): Promise<void> => {
  const [entry] = unwrap(await f.milestones.refresh(signal));
  if (entry === undefined) throw new Error('no milestone');
  const record = unwrap(await f.milestones.record(entry.id, signal));
  seq += 1;
  unwrap(await createDocumentFromMilestone({ store: f.store, engine, registry }, { asset: `as_branch_${seq}` as AssetId, actor: priya, source: { milestone: entry.id, record, title: 'Branch' } }, signal));
};

describe(`versioning vs age (${PAGES} pages × ${PER_PAGE} nodes; IF-5.9)`, () => {
  test('milestone, 5 of 200 pages changed (S6: 254 ms median on OPFS)', async ({ bench }) => {
    await bench.compare(bench('age 1', () => step(young)), bench('age 50', () => step(old)), { iterations: 10, time: 0 });
  }, 600_000);
  test('open a milestone read-only (every part)', async ({ bench }) => {
    await bench.compare(bench('newest at age 50', () => openAll(old, 'newest')), bench('oldest at age 50', () => openAll(old, 'oldest')), { iterations: 5, time: 0 });
  }, 600_000);
  test('new document from milestone', async ({ bench }) => {
    await bench.compare(bench('at age 1', () => branch(young)), bench('at age 50', () => branch(old)), { iterations: 2, time: 0, warmupIterations: 0 });
  }, 600_000);
});
