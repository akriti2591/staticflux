import { box, createScope, ok } from '@staticflux/core';
import { createMemoryDocumentStore, type DocumentHead, HeadConflictError } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { HOME_INDEX_SCHEMA, type HomeIndex, readHomeIndex, withHomeIndex } from '../home/index-record.js';
import { appendHomeOps, homeOp } from '../home/journal.js';
import type { LibraryEntry } from '../library/library-doc.js';
import { createHomeIndexWriter, observeStoreWrites, projectHomeIndex, writeHomeIndex } from './home-index-writer.js';

const signal = (): AbortSignal => new AbortController().signal;
const libEntry = (asset: string, kind: LibraryEntry['kind'], createdAt: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  asset: asset as LibraryEntry['asset'],
  kind,
  title: `T ${asset}`,
  createdAt,
  folder: '',
  favorite: false,
  tags: [],
  renditions: {},
  ...extra,
});
const libraryHead = (generation = 1, app?: DocumentHead['app']): DocumentHead => ({ asset: 'library', generation, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200, ...(app === undefined ? {} : { app }) });
const EMPTY: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [] };

/** Manual timers: `run()` fires what is due. */
function timers() {
  const due = new Map<number, () => void>();
  let id = 0;
  return {
    set: (fn: () => void) => (due.set((id += 1), fn), id),
    clear: (h: unknown) => void due.delete(h as number),
    run: () => {
      const fns = [...due.values()];
      due.clear();
      for (const fn of fns) fn();
    },
    get pending() {
      return due.size;
    },
  };
}

describe('projectHomeIndex', () => {
  it('lists entries with the kind lens, format and newest edit; trash carries its time (B11c)', () => {
    const entries = [
      libEntry('as_d', 'composition', '2026-10-01T00:00:00.000Z'),
      libEntry('as_img', 'image', '2026-10-02T00:00:00.000Z', { mime: 'image/png', size: 9, media: { width: 40, height: 20 } as never }),
      libEntry('as_old', 'composition', '2026-10-01T00:00:00.000Z', { trashedAt: '2026-10-03T00:00:00.000Z' }),
    ];
    const previous: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [{ asset: 'as_d', kind: 'composition', title: 'old', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-04T00:00:00.000Z', lens: 'layout', format: { width: 1080, height: 1920 } }] };
    const index = projectHomeIndex(entries, previous, new Map([['as_img', { editedAt: '2026-10-05T00:00:00.000Z' }]]));
    expect(index.entries.map((e) => [e.asset, e.lens, e.editedAt, e.format])).toEqual([
      ['as_img', 'pixel', '2026-10-05T00:00:00.000Z', { width: 40, height: 20 }],
      ['as_d', 'layout', '2026-10-04T00:00:00.000Z', { width: 1080, height: 1920 }],
      ['as_old', 'layout', '2026-10-01T00:00:00.000Z', undefined],
    ]);
    expect(index.entries[1]?.title).toBe('T as_d'); // the library's title wins over the stored one
    expect(index.entries[0]?.mime).toBe('image/png');
    expect(index.entries[2]?.trashedAt).toBe('2026-10-03T00:00:00.000Z');
  });

  it('carries project, favourite, page count, digest and the projects made on Home (B11c)', () => {
    const content = { digest: `sha256:${'a'.repeat(64)}` as const, size: 3, mime: 'image/png' };
    const previous: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [], projects: [{ name: 'Empty', createdAt: '2026-10-01T00:00:00.000Z' }] };
    const index = projectHomeIndex(
      [libEntry('as_d', 'composition', '2026-10-01T00:00:00.000Z', { folder: 'Spring', favorite: true }), libEntry('as_i', 'image', '2026-10-01T00:00:00.000Z', { content })],
      previous,
      new Map([['as_d', { pages: 3 }]]),
    );
    expect(index.entries.find((e) => e.asset === 'as_d')).toMatchObject({ folder: 'Spring', favorite: true, pages: 3 });
    expect(index.entries.find((e) => e.asset === 'as_i')?.digest).toBe(content.digest);
    expect(index.projects).toEqual(previous.projects);
  });

  it('never moves an edit time backwards (a stale touch loses to the stored index)', () => {
    const previous: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [{ asset: 'as_d', kind: 'composition', title: 'x', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-09T00:00:00.000Z', lens: 'layout' }] };
    const index = projectHomeIndex([libEntry('as_d', 'composition', '2026-10-01T00:00:00.000Z')], previous, new Map([['as_d', { editedAt: '2026-10-02T00:00:00.000Z' }]]));
    expect(index.entries[0]?.editedAt).toBe('2026-10-09T00:00:00.000Z');
  });
});

describe('writeHomeIndex', () => {
  it('swaps the library head by CAS, keeps its other fields, and skips an unchanged index', async () => {
    const store = createMemoryDocumentStore();
    expect(await writeHomeIndex(store, () => EMPTY, signal())).toEqual(ok({ written: false, index: EMPTY })); // no library yet
    expect((await store.writeHead('library', libraryHead(1, { versioning: { milestones: [] } }), null, signal())).ok).toBe(true);
    const next: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [{ asset: 'as_d', kind: 'composition', title: 'D', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-01T00:00:00.000Z', lens: 'layout' }] };
    const first = await writeHomeIndex(store, () => next, signal());
    expect(first.ok && first.value.written).toBe(true);
    const head = await store.readHead('library', signal());
    expect(head.ok && head.value?.generation).toBe(2);
    expect(head.ok && head.value?.app?.['versioning']).toEqual({ milestones: [] });
    expect(head.ok && readHomeIndex(head.value).entries.map((e) => e.asset)).toEqual(['as_d']);
    const again = await writeHomeIndex(store, () => next, signal());
    expect(again.ok && again.value.written).toBe(false);
  });

  it('applies Home’s pending journal ops on top, so a write never undoes what Home shows (B11c)', async () => {
    const store = createMemoryDocumentStore();
    expect((await store.writeHead('library', libraryHead(1), null, signal())).ok).toBe(true);
    const projected: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [{ asset: 'as_d', kind: 'composition', title: 'D', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-01T00:00:00.000Z', lens: 'layout' }] };
    expect((await appendHomeOps(store, [homeOp({ kind: 'rename', asset: 'as_d', title: 'Renamed on Home' }), homeOp({ kind: 'project-add', name: 'Spring' })], signal())).ok).toBe(true);
    const written = await writeHomeIndex(store, () => projected, signal());
    expect(written.ok && written.value.index.entries[0]?.title).toBe('Renamed on Home');
    const head = await store.readHead('library', signal());
    expect(head.ok && readHomeIndex(head.value).projects?.map((p) => p.name)).toEqual(['Spring']);
  });

  it('retries a lost race against another writer and gives up with IF-HOME-005', async () => {
    const store = createMemoryDocumentStore();
    expect((await store.writeHead('library', libraryHead(1), null, signal())).ok).toBe(true);
    const index: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [{ asset: 'as_d', kind: 'composition', title: 'D', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-01T00:00:00.000Z', lens: 'layout' }] };
    store.failNext('writeHead', HeadConflictError());
    const won = await writeHomeIndex(store, () => index, signal());
    expect(won.ok && won.value.written).toBe(true);
    const racing = { ...store, writeHead: async () => ({ ok: false as const, error: HeadConflictError() }) };
    const lost = await writeHomeIndex(racing, () => ({ ...index, entries: [] }), signal(), 3);
    expect(!lost.ok && lost.error.code).toBe('IF-HOME-005');
  });
});

describe('createHomeIndexWriter', () => {
  it('reconciles at start, follows library changes and touches, debounced, and flushes on demand', async () => {
    const store = createMemoryDocumentStore();
    expect((await store.writeHead('library', libraryHead(1), null, signal())).ok).toBe(true);
    const entries = box<readonly LibraryEntry[]>([libEntry('as_a', 'composition', '2026-10-01T00:00:00.000Z')]);
    const t = timers();
    let clock = Date.parse('2026-10-10T00:00:00.000Z');
    const scope = createScope('writer-test');
    const writer = createHomeIndexWriter({ store, library: { entries: () => entries.get() }, scope, now: () => clock, timers: t });
    expect(t.pending).toBe(1); // the first reconcile is scheduled
    t.run();
    await writer.flush();
    const read = async () => {
      const h = await store.readHead('library', signal());
      return h.ok ? readHomeIndex(h.value) : EMPTY;
    };
    expect((await read()).entries.map((e) => e.asset)).toEqual(['as_a']);
    expect(writer.writes).toBe(1);

    entries.set([...entries.get(), libEntry('as_b', 'composition', '2026-10-02T00:00:00.000Z')]);
    writer.touch('as_a');
    writer.describe('as_b', { format: { width: 1920, height: 1080 } });
    expect(t.pending).toBe(1); // coalesced into one write
    await writer.flush();
    const after = await read();
    expect(after.entries.map((e) => [e.asset, e.editedAt])).toEqual([
      ['as_a', '2026-10-10T00:00:00.000Z'],
      ['as_b', '2026-10-02T00:00:00.000Z'],
    ]);
    expect(after.entries[1]?.format).toEqual({ width: 1920, height: 1080 });
    expect(writer.writes).toBe(2);
    expect(t.pending).toBe(0);

    clock += 60_000;
    await writer.flush(); // nothing pending: no write
    expect(writer.writes).toBe(2);
    scope.dispose();
    writer.touch('as_a');
    expect(t.pending).toBe(1);
    t.run();
    await writer.flush();
    expect(writer.writes).toBe(2); // disposed: nothing written
  });

  it('reports a failed write and writes again on the next trigger', async () => {
    const store = createMemoryDocumentStore();
    expect((await store.writeHead('library', libraryHead(1), null, signal())).ok).toBe(true);
    const problems: string[] = [];
    const scope = createScope('writer-fail');
    const writer = createHomeIndexWriter({ store, library: { entries: () => [libEntry('as_a', 'composition', '2026-10-01T00:00:00.000Z')] }, scope, timers: timers(), onProblem: (e) => problems.push(e.code) });
    store.failNext('readHead', HeadConflictError({ message: 'io' }));
    const failed = await writer.flush();
    expect(failed.ok).toBe(false);
    expect(problems).toEqual(['SF-DOC-011']);
    expect((await writer.flush()).ok).toBe(true);
    expect(writer.writes).toBe(1);
    scope.dispose();
  });
});

describe('observeStoreWrites', () => {
  it('reports each design written (log appends, head swaps), never the library, and passes everything through', async () => {
    const inner = createMemoryDocumentStore();
    const seen: string[] = [];
    const store = observeStoreWrites(inner, (asset) => seen.push(asset));
    expect((await store.appendLog('as_1', new Uint8Array([1]), signal())).ok).toBe(true);
    expect((await store.appendLog('library', new Uint8Array([1]), signal())).ok).toBe(true);
    expect((await store.writeHead('as_2', { ...libraryHead(1), asset: 'as_2' }, null, signal())).ok).toBe(true);
    expect((await store.writeHead('as_2', { ...libraryHead(1), asset: 'as_2' }, null, signal())).ok).toBe(false); // a failed swap is no edit
    const ref = await store.putBlob(new Uint8Array([3]), signal());
    expect(ref.ok && (await store.getBlob(ref.value, signal())).ok).toBe(true);
    expect((await store.readLog('as_1', 0, signal())).ok).toBe(true);
    expect((await store.truncateLog('as_1', 1, signal())).ok).toBe(true);
    expect((await store.readHead('as_2', signal())).ok).toBe(true);
    expect((await store.writeHead('home-journal', { ...libraryHead(1), asset: 'home-journal' }, null, signal())).ok).toBe(true);
    expect(seen).toEqual(['as_1', 'as_2']); // the library and Home's journal are not designs
  });
});

describe('the index read by Home', () => {
  it('is the same projection Home renders (withHomeIndex ∘ project ∘ read)', () => {
    const index = projectHomeIndex([libEntry('as_t', 'template', '2026-10-01T00:00:00.000Z')], EMPTY);
    expect(readHomeIndex(withHomeIndex(libraryHead(), index))).toEqual(index);
  });
});
