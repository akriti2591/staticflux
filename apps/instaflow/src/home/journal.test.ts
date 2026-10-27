import { createMemoryDocumentStore, HeadConflictError } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { HOME_INDEX_SCHEMA, type HomeEntry, type HomeIndex } from './index-record.js';
import { appendHomeOps, HOME_JOURNAL_ASSET, homeOp, homeOpId, type HomeOp, journalHead, overlayJournal, readHomeJournal, readHomeOp, removeHomeOps, updateHomeJournal } from './journal.js';

const signal = (): AbortSignal => new AbortController().signal;
const entry = (asset: string, extra: Partial<HomeEntry> = {}): HomeEntry => ({ asset, kind: 'composition', title: `T ${asset}`, createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-02T00:00:00.000Z', lens: 'layout', ...extra });
const INDEX: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [entry('as_a', { format: { width: 10, height: 20 }, pages: 2, folder: 'Spring' }), entry('as_b')] };
const at = Date.parse('2026-10-05T00:00:00.000Z');
const op = (body: Parameters<typeof homeOp>[0]): HomeOp => homeOp(body, at);

describe('Home journal: applying ops to the index (pure, idempotent)', () => {
  it('rename, move, favourite, trash, restore, purge', () => {
    let index = overlayJournal(INDEX, [op({ kind: 'rename', asset: 'as_a', title: 'New' }), op({ kind: 'move', assets: ['as_b'], folder: 'Spring' }), op({ kind: 'favorite', asset: 'as_b', favorite: true }), op({ kind: 'trash', assets: ['as_a'] })]);
    expect(index.entries.find((e) => e.asset === 'as_a')).toMatchObject({ title: 'New', trashedAt: '2026-10-05T00:00:00.000Z' });
    expect(index.entries.find((e) => e.asset === 'as_b')).toMatchObject({ folder: 'Spring', favorite: true });
    index = overlayJournal(index, [op({ kind: 'restore', assets: ['as_a'] }), op({ kind: 'move', assets: ['as_a'], folder: '' }), op({ kind: 'favorite', asset: 'as_b', favorite: false })]);
    expect(index.entries.find((e) => e.asset === 'as_a')?.trashedAt).toBeUndefined();
    expect(index.entries.find((e) => e.asset === 'as_a')?.folder).toBeUndefined();
    expect(index.entries.find((e) => e.asset === 'as_b')?.favorite).toBeUndefined();
    expect(overlayJournal(index, [op({ kind: 'purge', assets: ['as_b', 'as_none'] })]).entries.map((e) => e.asset)).toEqual(['as_a']);
    const trash = op({ kind: 'trash', assets: ['as_b'] });
    expect(overlayJournal(overlayJournal(INDEX, [trash]), [trash])).toEqual(overlayJournal(INDEX, [trash])); // idempotent
    expect(overlayJournal(INDEX, [])).toBe(INDEX);
  });

  it('duplicate and import add an entry once (a later duplicate of the same id or content changes nothing)', () => {
    const dup = op({ kind: 'duplicate', source: 'as_a', asset: 'as_c', title: 'T as_a copy', folder: 'Spring' });
    const copied = overlayJournal(INDEX, [dup, dup, op({ kind: 'duplicate', source: 'as_missing', asset: 'as_d', title: 'x' })]);
    expect(copied.entries.map((e) => e.asset)).toEqual(['as_c', 'as_a', 'as_b']);
    expect(copied.entries[0]).toMatchObject({ title: 'T as_a copy', format: { width: 10, height: 20 }, pages: 2, folder: 'Spring', editedAt: '2026-10-05T00:00:00.000Z' });
    const media = { asset: 'as_i', kind: 'image' as const, title: 'Lamp', mime: 'image/png', size: 3, content: { digest: 'sha256:x', size: 3, mime: 'image/png' }, record: { digest: 'sha256:r', size: 1, mime: 'r' }, width: 4, height: 5 };
    const imported = overlayJournal(INDEX, [op({ kind: 'import', media }), op({ kind: 'import', media: { ...media, asset: 'as_j' } })]);
    expect(imported.entries.filter((e) => e.kind === 'image').map((e) => [e.asset, e.lens, e.digest, e.format])).toEqual([['as_i', 'pixel', 'sha256:x', { width: 4, height: 5 }]]);
  });

  it('projects: add (once), rename (entries follow), remove (entries go to No project)', () => {
    let index = overlayJournal(INDEX, [op({ kind: 'project-add', name: 'Brand' }), op({ kind: 'project-add', name: 'Brand' })]);
    expect(index.projects?.map((p) => p.name)).toEqual(['Brand']);
    index = overlayJournal(index, [op({ kind: 'project-rename', from: 'Spring', to: 'Summer' })]);
    expect(index.entries.find((e) => e.asset === 'as_a')?.folder).toBe('Summer');
    index = overlayJournal(index, [op({ kind: 'project-rename', from: 'Brand', to: 'Brand kit' }), op({ kind: 'project-remove', name: 'Summer' })]);
    expect(index.projects?.map((p) => p.name)).toEqual(['Brand kit']);
    expect(index.entries.find((e) => e.asset === 'as_a')?.folder).toBeUndefined();
  });
});

describe('Home journal: reading and writing', () => {
  it('round-trips through its head and drops malformed ops (tolerant)', () => {
    const ops = [op({ kind: 'rename', asset: 'as_a', title: 'x' }), op({ kind: 'trash', assets: ['as_b'] })];
    const head = journalHead(ops, 3);
    expect(head).toMatchObject({ asset: HOME_JOURNAL_ASSET, generation: 3, engine: 'none' });
    expect(readHomeJournal(head)).toEqual(ops);
    const raw = (head.app?.['journal'] as { ops: unknown[] }).ops;
    const bad = { app: { journal: { schema: 'instaflow.home-journal/1', ops: [...raw, raw[0], { id: 'op_1', at: 'nope', kind: 'trash', assets: ['a'] }, { id: 'op_2', at: ops[0]?.at, kind: 'fly' }, { id: 'op_3', at: ops[0]?.at, kind: 'move', assets: [] }, 7] } } };
    expect(readHomeJournal(bad as never)).toEqual(ops);
    expect(readHomeJournal(undefined)).toEqual([]);
    expect(readHomeJournal({ app: { journal: { schema: 'other', ops: [] } } })).toEqual([]);
    expect(readHomeOp({ id: 'op_x', at: ops[0]?.at, kind: 'import', media: { asset: 'as_i' } })).toBeUndefined();
    expect(homeOpId()).toMatch(/^op_/);
    expect(homeOpId()).not.toBe(homeOpId());
  });

  it('appends and removes by compare-and-swap, retrying a lost race, and gives up with IF-POL-055', async () => {
    const store = createMemoryDocumentStore();
    const a = op({ kind: 'rename', asset: 'as_a', title: 'x' });
    const b = op({ kind: 'trash', assets: ['as_b'] });
    expect((await appendHomeOps(store, [a], signal())).ok).toBe(true);
    store.failNext('writeHead', HeadConflictError());
    expect((await appendHomeOps(store, [b], signal())).ok).toBe(true);
    const read = async () => {
      const h = await store.readHead(HOME_JOURNAL_ASSET, signal());
      return h.ok ? readHomeJournal(h.value).map((o) => o.id) : [];
    };
    expect(await read()).toEqual([a.id, b.id]);
    expect((await removeHomeOps(store, new Set([a.id]), signal())).ok).toBe(true);
    expect(await read()).toEqual([b.id]);
    const head = await store.readHead(HOME_JOURNAL_ASSET, signal());
    expect((await removeHomeOps(store, new Set(['op_none']), signal())).ok).toBe(true); // nothing to remove: no write
    expect((await store.readHead(HOME_JOURNAL_ASSET, signal())).ok && head.ok && head.value?.generation).toBe(3);
    const racing = { readHead: store.readHead.bind(store), writeHead: async () => ({ ok: false as const, error: HeadConflictError() }) };
    const lost = await updateHomeJournal(racing, (ops) => [...ops, a], signal(), 2);
    expect(!lost.ok && lost.error.code).toBe('IF-POL-055');
    store.failNext('readHead', HeadConflictError({ message: 'io' }));
    expect((await appendHomeOps(store, [a], signal())).ok).toBe(false);
  });
});
