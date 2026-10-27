import { describe, expect, it } from 'vitest';
import { DEFAULT_FILES_PREFS, FILES_MEMORY_KEY, filesList, readFilesPrefs, selectRange, trashByDay, writeFilesPrefs } from './files-view.js';
import { fallbackText } from './messages.js';
import type { HomeEntry } from './index-record.js';

const first: HomeEntry = { asset: 'as_0', kind: 'composition', title: 'x', createdAt: '2026-10-01T00:00:00.000Z', editedAt: '2026-10-01T00:00:00.000Z', lens: 'layout' };
const memory = (): Storage => {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k), clear: () => map.clear(), key: () => null, length: 0 } as Storage;
};
const e = (asset: string, kind: HomeEntry['kind'], title: string, editedAt: string, extra: Partial<HomeEntry> = {}): HomeEntry => ({ ...first, asset, kind, title, editedAt, ...extra });
const ENTRIES = [
  e('as_d1', 'composition', 'b flyer', '2026-10-05T00:00:00.000Z', { favorite: true, folder: 'Spring' }),
  e('as_t', 'template', 'Promo', '2026-10-04T00:00:00.000Z', { createdAt: '2026-10-03T00:00:00.000Z' }),
  e('as_i', 'image', 'Lamp 10', '2026-10-03T00:00:00.000Z'),
  e('as_i2', 'image', 'lamp 9', '2026-10-02T00:00:00.000Z'),
  e('as_x', 'composition', 'Gone', '2026-10-06T00:00:00.000Z', { trashedAt: '2026-10-06T00:00:00.000Z' }),
];

describe('Files list (HOME-FILES §2.2)', () => {
  it('filters by kind and favourites, never lists the trash', () => {
    const ids = (filter: Parameters<typeof filesList>[1]['filter']) => filesList(ENTRIES, { filter, sort: 'edited' }).map((x) => x.asset);
    expect(ids('all')).toEqual(['as_d1', 'as_t', 'as_i', 'as_i2']);
    expect(ids('designs')).toEqual(['as_d1']);
    expect(ids('templates')).toEqual(['as_t']);
    expect(ids('media')).toEqual(['as_i', 'as_i2']);
    expect(ids('favourites')).toEqual(['as_d1']);
  });

  it('sorts by last edited, created, name (numeric, case-insensitive) and kind; filters by project', () => {
    const ids = (sort: Parameters<typeof filesList>[1]['sort']) => filesList(ENTRIES, { filter: 'all', sort }).map((x) => x.asset);
    expect(ids('created')).toEqual(['as_t', 'as_d1', 'as_i', 'as_i2']);
    expect(ids('name')).toEqual(['as_d1', 'as_i2', 'as_i', 'as_t']);
    expect(ids('kind')).toEqual(['as_d1', 'as_t', 'as_i', 'as_i2']);
    expect(filesList(ENTRIES, DEFAULT_FILES_PREFS, { kind: 'project', name: 'Spring' }).map((x) => x.asset)).toEqual(['as_d1']);
    expect(filesList(ENTRIES, DEFAULT_FILES_PREFS, { kind: 'none' }).map((x) => x.asset)).toEqual(['as_t', 'as_i', 'as_i2']);
  });

  it('remembers filter, sort and layout per device (tolerant)', () => {
    const storage = memory();
    expect(readFilesPrefs(storage)).toEqual(DEFAULT_FILES_PREFS);
    writeFilesPrefs(storage, { filter: 'media', sort: 'name', layout: 'list' });
    expect(readFilesPrefs(storage)).toEqual({ filter: 'media', sort: 'name', layout: 'list' });
    storage.setItem(FILES_MEMORY_KEY, '{"filter":"nope","sort":3}');
    expect(readFilesPrefs(storage)).toEqual(DEFAULT_FILES_PREFS);
    storage.setItem(FILES_MEMORY_KEY, 'not json');
    expect(readFilesPrefs(storage)).toEqual(DEFAULT_FILES_PREFS);
    expect(readFilesPrefs(undefined)).toEqual(DEFAULT_FILES_PREFS);
    writeFilesPrefs({ setItem: () => { throw new Error('blocked'); } }, DEFAULT_FILES_PREFS); // never throws
  });

  it('selects ranges either way from the anchor', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(selectRange(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(selectRange(order, 'd', 'a')).toEqual(['a', 'b', 'c', 'd']);
    expect(selectRange(order, undefined, 'c')).toEqual(['c']);
    expect(selectRange(order, 'gone', 'c')).toEqual(['c']);
    expect(selectRange(order, 'a', 'zz')).toEqual([]);
  });

  it('groups the trash by the viewer’s day, newest first', () => {
    const groups = trashByDay([e('a', 'composition', 'A', first.editedAt, { trashedAt: '2026-10-06T10:00:00.000Z' }), e('b', 'composition', 'B', first.editedAt, { trashedAt: '2026-10-04T10:00:00.000Z' }), e('c', 'composition', 'C', first.editedAt, { trashedAt: '2026-10-06T11:00:00.000Z' }), e('d', 'composition', 'D', first.editedAt)], 'en-GB');
    expect(groups.map((g) => [g.label, g.entries.map((x) => x.asset)])).toEqual([
      ['6 October 2026', ['a', 'c']],
      ['4 October 2026', ['b']],
    ]);
  });
});

describe('message fallback (English plurals without the i18n service)', () => {
  it('fills names and picks plural cases, exact matches first, # as the number', () => {
    expect(fallbackText('{count, plural, =0 {Empty} one {# design} other {# designs}} · edited {when}', { count: 0, when: 'now' })).toBe('Empty · edited now');
    expect(fallbackText('{count, plural, one {# design} other {# designs}}', { count: 1 })).toBe('1 design');
    expect(fallbackText('{count, plural, one {Moved to {project}} other {Moved # files to {project}}}', { count: 1200, project: 'Spring' })).toBe('Moved 1,200 files to Spring');
    expect(fallbackText('Hello {name}', {})).toBe('Hello ');
  });
});
