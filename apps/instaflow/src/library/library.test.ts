import { effect } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { LIBRARY_FILTER_TESTS, LIBRARY_FILTERS, queryLibrary, TRASH_RETENTION_MS, validateFolder, validateTag, validateTitle } from './library.js';
import type { LibraryEntry } from './library-doc.js';
import { libraryFixture, unwrap } from './test-helpers.js';

const content = (n: string) => ({ digest: `sha256:${n.repeat(64)}` as const, size: 4, mime: 'image/png' });

async function seeded() {
  const fixture = await libraryFixture();
  const { library } = fixture;
  unwrap(library.add({ asset: 'as_a', kind: 'image', title: 'Hero lamps', createdAt: '2026-10-24T09:00:00.000Z', content: content('a'), tags: ['Night'] }));
  unwrap(library.add({ asset: 'as_b', kind: 'video', title: 'Teaser', createdAt: '2026-10-25T09:00:00.000Z', content: content('b') }));
  unwrap(library.add({ asset: 'as_c', kind: 'composition', title: 'Flyer', createdAt: '2026-10-23T09:00:00.000Z', folder: ' Campaigns / Fall ' }));
  return fixture;
}

describe('validators', () => {
  it('trim and bound titles, tags and folders (IF-LIB-007)', () => {
    expect(validateTitle('  Hero ')).toEqual({ ok: true, value: 'Hero' });
    expect(validateTitle('   ').ok).toBe(false);
    expect(validateTitle('x'.repeat(201)).ok).toBe(false);
    expect(validateTag(' Sale ')).toEqual({ ok: true, value: 'sale' });
    const comma = validateTag('a,b');
    expect(!comma.ok && comma.error.code).toBe('IF-LIB-007');
    expect(validateTag('x'.repeat(41)).ok).toBe(false);
    expect(validateFolder(' a // b ')).toEqual({ ok: true, value: 'a/b' });
    expect(validateFolder('')).toEqual({ ok: true, value: '' });
    expect(validateFolder('x'.repeat(61)).ok).toBe(false);
  });
});

describe('createLibrary', () => {
  it('lists entries newest first, normalized, and finds live content by digest', async () => {
    const { library } = await seeded();
    expect(library.entries().map((e) => e.asset)).toEqual(['as_b', 'as_a', 'as_c']);
    expect(library.entry('as_a')?.tags).toEqual(['night']);
    expect(library.entry('as_c')?.folder).toBe('Campaigns/Fall');
    expect(library.findByContent(content('a').digest)?.asset).toBe('as_a');
    expect(library.findByContent(content('z').digest)).toBeUndefined();
  });

  it('rejects duplicates, bad metadata and unknown assets with stable codes', async () => {
    const { library } = await seeded();
    const again = library.add({ asset: 'as_a', kind: 'image', title: 'x', createdAt: '' });
    expect(!again.ok && again.error.code).toBe('IF-LIB-008');
    const badTitle = library.add({ asset: 'as_new', kind: 'image', title: ' ', createdAt: '' });
    expect(!badTitle.ok && badTitle.error.code).toBe('IF-LIB-007');
    expect(library.add({ asset: 'as_new', kind: 'image', title: 'ok', createdAt: '', tags: ['a,b'] }).ok).toBe(false);
    expect(library.add({ asset: 'as_new', kind: 'image', title: 'ok', createdAt: '', folder: 'x'.repeat(61) }).ok).toBe(false);
    const unknown = library.rename('as_zzz', 'x');
    expect(!unknown.ok && unknown.error.code).toBe('IF-LIB-003');
  });

  it('renames, moves, favorites and tags (each one validated commit)', async () => {
    const { library, document } = await seeded();
    const commits: string[] = [];
    document.doc.onCommit((record) => commits.push(record.meta.label));
    unwrap(library.rename('as_a', '  Lamps  '));
    unwrap(library.setFolder('as_a', 'Brand'));
    unwrap(library.setFavorite('as_a', true));
    unwrap(library.addTag('as_a', 'Sale'));
    unwrap(library.addTag('as_a', 'sale'));
    unwrap(library.removeTag('as_a', 'NIGHT'));
    expect(library.entry('as_a')).toMatchObject({ title: 'Lamps', folder: 'Brand', favorite: true, tags: ['sale'] });
    expect(library.rename('as_a', '').ok).toBe(false);
    expect(library.setFolder('as_a', 'y'.repeat(61)).ok).toBe(false);
    expect(library.addTag('as_a', '').ok).toBe(false);
    expect(library.addTag('as_zz', 'x').ok).toBe(false);
    expect(library.removeTag('as_zz', 'x').ok).toBe(false);
    expect(commits).toEqual(['Rename Lamps', 'Move to folder', 'Favorite', 'Tag sale', 'Untag night']);
  });

  it('trash is a state with a time; restore clears it; GC roots keep trash for 30 days', async () => {
    const { library, clock } = await seeded();
    unwrap(library.trash(['as_a', 'as_b', 'as_a']));
    expect(library.entry('as_a')?.trashedAt).toBe('2026-10-25T09:00:00.000Z');
    expect(library.findByContent(content('a').digest)).toBeUndefined();
    unwrap(library.trash(['as_a'])); // already trashed: nothing to write
    expect(library.trash(['as_x']).ok).toBe(false);
    unwrap(library.restore(['as_b', 'as_c']));
    expect(library.entry('as_b')?.trashedAt).toBeUndefined();
    expect(library.restore(['as_x']).ok).toBe(false);
    expect([...library.gcRoots()].sort()).toEqual(['as_a', 'as_b', 'as_c']);
    clock.now += TRASH_RETENTION_MS + 1;
    expect([...library.gcRoots()].sort()).toEqual(['as_b', 'as_c']);
  });

  it('purge deletes entries forever in one commit; unknown assets are refused (B11c)', async () => {
    const { library, document } = await seeded();
    const commits: string[] = [];
    document.doc.onCommit((record) => commits.push(record.meta.label));
    unwrap(library.purge(['as_a', 'as_b', 'as_a']));
    expect(library.entries().map((e) => e.asset)).toEqual(['as_c']);
    expect(library.gcRoots()).toEqual(['as_c']);
    const unknown = library.purge(['as_a']);
    expect(!unknown.ok && unknown.error.code).toBe('IF-LIB-003');
    unwrap(library.purge(['as_c']));
    expect(commits).toEqual(['Delete 2 forever', 'Delete forever']);
  });

  it('records renditions and is reactive to every change', async () => {
    const { library } = await seeded();
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(library.entries().length);
      library.entry('as_a');
    });
    unwrap(library.setRendition('as_a', 'thumbnail', { blob: { digest: `sha256:${'d'.repeat(64)}`, size: 3, mime: 'image/png' }, params: { renderer: 'scale/1', edge: 256, source: content('a').digest } }));
    expect(library.entry('as_a')?.renditions.thumbnail?.params.renderer).toBe('scale/1');
    unwrap(library.add({ asset: 'as_d', kind: 'audio', title: 'Jingle', createdAt: '2026-10-26T09:00:00.000Z' }));
    stop();
    expect(seen).toEqual([3, 3, 4]);
  });

  it('refuses every write after dispose (IF-LIB-009)', async () => {
    const { library } = await seeded();
    library.dispose();
    library.dispose();
    const after = library.rename('as_a', 'x');
    expect(!after.ok && after.error.code).toBe('IF-LIB-009');
    expect(library.add({ asset: 'as_q', kind: 'image', title: 'q', createdAt: '' }).ok).toBe(false);
  });
});

describe('queryLibrary', () => {
  const entry = (asset: string, kind: LibraryEntry['kind'], extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ asset: asset as LibraryEntry['asset'], kind, title: asset, createdAt: '', folder: '', favorite: false, tags: [], renditions: {}, ...extra });
  const entries = [
    entry('as_img', 'image', { tags: ['sale'], folder: 'Brand' }),
    entry('as_svg', 'vector', { favorite: true }),
    entry('as_vid', 'video'),
    entry('as_aud', 'audio'),
    entry('as_doc', 'composition', { title: 'Night flyer' }),
    entry('as_old', 'image', { trashedAt: '2026-10-01T00:00:00.000Z' }),
  ];

  it('filters by a data table of predicates, text, tag and folder', () => {
    const ids = (q: Parameters<typeof queryLibrary>[1]) => queryLibrary(entries, q).map((e) => e.asset);
    expect(LIBRARY_FILTERS.every((f) => typeof LIBRARY_FILTER_TESTS[f] === 'function')).toBe(true);
    expect(ids({ filter: 'all' })).toEqual(['as_img', 'as_svg', 'as_vid', 'as_aud', 'as_doc']);
    expect(ids({ filter: 'images' })).toEqual(['as_img', 'as_svg']);
    expect(ids({ filter: 'video' })).toEqual(['as_vid']);
    expect(ids({ filter: 'audio' })).toEqual(['as_aud']);
    expect(ids({ filter: 'designs' })).toEqual(['as_doc']);
    expect(ids({ filter: 'favorites' })).toEqual(['as_svg']);
    expect(ids({ filter: 'trash' })).toEqual(['as_old']);
    expect(ids({ filter: 'all', text: ' NIGHT ' })).toEqual(['as_doc']);
    expect(ids({ filter: 'all', text: 'sal' })).toEqual(['as_img']);
    expect(ids({ filter: 'all', tag: 'sale' })).toEqual(['as_img']);
    expect(ids({ filter: 'all', folder: 'Brand' })).toEqual(['as_img']);
  });
});
