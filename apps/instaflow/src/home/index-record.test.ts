import type { DocumentHead } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { byEdited, EMPTY_HOME_INDEX, HOME_INDEX_APP_KEY, HOME_INDEX_SCHEMA, type HomeEntry, type HomeIndex, readHomeEntry, readHomeIndex, readHomeProjects, recentDesigns, sameHomeIndex, trashedFiles, withHomeIndex, workspaceFiles, workspaceProjects, workspaceTemplates } from './index-record.js';

const entry = (asset: string, kind: HomeEntry['kind'], editedAt: string, extra: Partial<HomeEntry> = {}): HomeEntry => ({
  asset,
  kind,
  title: `Title ${asset}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  editedAt,
  lens: 'layout',
  ...extra,
});
const index = (...entries: HomeEntry[]): HomeIndex => ({ schema: HOME_INDEX_SCHEMA, entries });

describe('Home index record', () => {
  it('round-trips through the head app field and sorts newest edit first', () => {
    const head: DocumentHead = { asset: 'library', generation: 3, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200, app: { versioning: { milestones: [] } } };
    const written = withHomeIndex(head, index(entry('as_a', 'composition', '2026-10-02T00:00:00.000Z'), entry('as_b', 'template', '2026-10-05T00:00:00.000Z', { format: { width: 1080, height: 1920 } })));
    expect(written.generation).toBe(3);
    expect(written.app?.['versioning']).toEqual({ milestones: [] }); // other app fields are kept
    expect((written.app?.[HOME_INDEX_APP_KEY] as { schema: string }).schema).toBe(HOME_INDEX_SCHEMA);
    const read = readHomeIndex(written);
    expect(read.entries.map((e) => e.asset)).toEqual(['as_b', 'as_a']);
    expect(read.entries[0]?.format).toEqual({ width: 1080, height: 1920 });
  });

  it('is empty without a head, without an index or with another schema', () => {
    expect(readHomeIndex(undefined)).toBe(EMPTY_HOME_INDEX);
    expect(readHomeIndex({ app: {} })).toBe(EMPTY_HOME_INDEX);
    expect(readHomeIndex({ app: { home: [] } })).toBe(EMPTY_HOME_INDEX);
    expect(readHomeIndex({ app: { home: { schema: 'instaflow.home-index/9', entries: [] } } })).toBe(EMPTY_HOME_INDEX);
  });

  it('drops malformed and duplicate entries instead of failing (tolerant read)', () => {
    const good = { asset: 'as_1', kind: 'composition', title: 'Flyer', createdAt: '2026-10-01T00:00:00Z', editedAt: '2026-10-02T00:00:00Z', lens: 'layout' };
    const read = readHomeIndex({
      app: {
        home: {
          schema: HOME_INDEX_SCHEMA,
          entries: [good, { ...good, title: 'Duplicate' }, { ...good, asset: 'as_2', kind: 'spaceship' }, { ...good, asset: 'as_3', title: '  ' }, { ...good, asset: 'as_4', editedAt: 'yesterday' }, 7, null],
        },
      },
    });
    expect(read.entries.map((e) => [e.asset, e.title])).toEqual([['as_1', 'Flyer']]);
  });

  it('reads optional fields only when valid and falls back to the kind lens', () => {
    const raw = { asset: 'as_i', kind: 'image', title: 'Hero', createdAt: '2026-10-01T00:00:00Z', editedAt: '2026-10-01T00:00:00Z', lens: 'nope', mime: 'image/png', size: 12, format: { width: 0, height: 10 } };
    expect(readHomeEntry(raw)).toEqual({ asset: 'as_i', kind: 'image', title: 'Hero', createdAt: raw.createdAt, editedAt: raw.editedAt, lens: 'pixel', mime: 'image/png', size: 12 });
    expect(readHomeEntry([])).toBeUndefined();
  });

  it('derives recents (designs only, limited), files (everything) and templates', () => {
    const all = index(entry('as_d1', 'composition', '2026-10-03T00:00:00Z'), entry('as_t', 'template', '2026-10-04T00:00:00Z'), entry('as_img', 'image', '2026-10-05T00:00:00Z'), entry('as_d2', 'composition', '2026-10-02T00:00:00Z'));
    expect(recentDesigns(all).map((e) => e.asset)).toEqual(['as_d1', 'as_d2']);
    expect(recentDesigns(all, 1).map((e) => e.asset)).toEqual(['as_d1']);
    expect(workspaceFiles(all)).toHaveLength(4);
    expect(workspaceTemplates(all).map((e) => e.asset)).toEqual(['as_t']);
  });

  it('compares content regardless of order, and orders ties by creation then id', () => {
    const a = entry('as_a', 'composition', '2026-10-02T00:00:00Z');
    const b = entry('as_b', 'composition', '2026-10-02T00:00:00Z');
    expect(sameHomeIndex(index(a, b), index(b, a))).toBe(true);
    expect(sameHomeIndex(index(a), index(a, b))).toBe(false);
    expect(sameHomeIndex(index(a), index({ ...a, title: 'Renamed' }))).toBe(false);
    expect([b, a].sort(byEdited).map((e) => e.asset)).toEqual(['as_a', 'as_b']);
    const newer = { ...b, createdAt: '2026-10-02T00:00:00Z' };
    expect([a, newer].sort(byEdited)[0]?.asset).toBe('as_b');
  });

  it('B11c: carries project, favourite, trash time, pages, digest and the projects made on Home', () => {
    const head: DocumentHead = { asset: 'library', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 };
    const full = entry('as_f', 'composition', '2026-10-02T00:00:00.000Z', { folder: 'Spring', favorite: true, trashedAt: '2026-10-03T00:00:00.000Z', pages: 3, digest: 'sha256:x' });
    const index: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [full], projects: [{ name: 'Empty', createdAt: '2026-10-01T00:00:00.000Z' }] };
    const read = readHomeIndex(withHomeIndex(head, index));
    expect(read).toEqual(index);
    expect(sameHomeIndex(read, { ...index, projects: [] })).toBe(false);
    expect(readHomeEntry({ ...full, folder: ' ', favorite: 'yes', trashedAt: 'soon', pages: 1.5, digest: '' })).toEqual(entry('as_f', 'composition', '2026-10-02T00:00:00.000Z'));
    expect(readHomeProjects([{ name: 'A', createdAt: '2026-10-01T00:00:00Z' }, { name: 'A', createdAt: '2026-10-01T00:00:00Z' }, { name: ' ', createdAt: '2026-10-01T00:00:00Z' }, { name: 'B' }, 3])).toEqual([{ name: 'A', createdAt: '2026-10-01T00:00:00Z' }]);
    expect(readHomeProjects('x')).toEqual([]);
  });

  it('#64: carries a design’s cover (its preview blob) and changes when the cover does', () => {
    const head: DocumentHead = { asset: 'library', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 };
    const design = entry('as_d', 'composition', '2026-10-02T00:00:00.000Z', { cover: 'sha256:c1' });
    const read = readHomeIndex(withHomeIndex(head, index(design)));
    expect(read.entries[0]?.cover).toBe('sha256:c1');
    expect(sameHomeIndex(read, index({ ...design, cover: 'sha256:c2' }))).toBe(false);
    expect(readHomeEntry({ ...design, cover: '' })?.cover).toBeUndefined();
    expect(readHomeEntry({ ...design, cover: 7 })?.cover).toBeUndefined();
  });

  it('B11c: the trash and projects are derived; trashed entries are nowhere else', () => {
    const all = index(
      entry('as_a', 'composition', '2026-10-05T00:00:00Z', { folder: 'Spring' }),
      entry('as_b', 'composition', '2026-10-03T00:00:00Z', { folder: 'Spring' }),
      entry('as_t', 'template', '2026-10-04T00:00:00Z', { trashedAt: '2026-10-06T00:00:00Z', folder: 'Old' }),
      entry('as_c', 'composition', '2026-10-02T00:00:00Z', { trashedAt: '2026-10-07T00:00:00Z' }),
    );
    const withEmpty: HomeIndex = { ...all, projects: [{ name: 'Brand', createdAt: '2026-10-08T00:00:00Z' }] };
    expect(recentDesigns(all).map((e) => e.asset)).toEqual(['as_a', 'as_b']);
    expect(workspaceFiles(all).map((e) => e.asset)).toEqual(['as_a', 'as_b']);
    expect(workspaceTemplates(all)).toEqual([]);
    expect(trashedFiles(all).map((e) => e.asset)).toEqual(['as_c', 'as_t']);
    expect(workspaceProjects(withEmpty)).toEqual([
      { name: 'Brand', count: 0, editedAt: '2026-10-08T00:00:00Z' },
      { name: 'Spring', count: 2, editedAt: '2026-10-05T00:00:00Z' },
    ]);
  });
});
