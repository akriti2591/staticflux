import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createDocumentRepo, createMemoryDocumentStore } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import {
  entryCreateOps,
  LIBRARY_ASSET,
  LIBRARY_ENTRY_KIND,
  LIBRARY_PART,
  LibraryPaths,
  libraryRegistry,
  openLibraryDocument,
  readLibraryEntries,
  readLibraryEntry,
  RENDITION_ROLES,
} from './library-doc.js';
import { priya, signal, unwrap } from './test-helpers.js';

const content = { digest: `sha256:${'c'.repeat(64)}` as const, size: 9, mime: 'image/png' };

describe('library document', () => {
  it('is created on first open as the `library` asset and reopened afterwards with its entries', async () => {
    const store = createMemoryDocumentStore();
    const engine = createLoroEngine();
    const first = createDocumentRepo({ store, engine, compactAfterBytes: Number.POSITIVE_INFINITY });
    const opened = unwrap(await openLibraryDocument(first, signal));
    expect(opened.doc.asset).toBe(LIBRARY_ASSET);
    expect(opened.doc.head().treeSchema).toBe(libraryRegistry.version);
    unwrap(await opened.doc.transact({ actor: { kind: 'human', id: priya.id }, label: 'Add' }, { [LIBRARY_PART]: entryCreateOps({ asset: 'as_1', kind: 'image', title: 'Hero', createdAt: '2026-10-25T09:00:00.000Z', content, mime: 'image/png', size: 9, media: { width: 4, height: 3 } }) }, signal));
    await first.dispose(signal);
    const second = createDocumentRepo({ store, engine, compactAfterBytes: Number.POSITIVE_INFINITY });
    const reopened = unwrap(await openLibraryDocument(second, signal));
    expect(readLibraryEntries(reopened.part).map((e) => [e.asset, e.title, e.media])).toEqual([['as_1', 'Hero', { width: 4, height: 3 }]]);
  });

  it('entryCreateOps validate against the registry and read back with defaults', async () => {
    const ops = entryCreateOps({ asset: 'as_2', kind: 'composition', title: 'Flyer', createdAt: '2026-10-25T09:00:00.000Z', tags: ['sale', 'sale', 'night'], folder: 'Campaigns' });
    expect(libraryRegistry.validateOps(ops).ok).toBe(true);
    const doc = unwrap(await openLibraryDocument(createDocumentRepo({ store: createMemoryDocumentStore(), engine: createLoroEngine() }), signal));
    unwrap(doc.doc.commit({ actor: { kind: 'human', id: 'x' }, label: 'Add' }, { [LIBRARY_PART]: ops }));
    const entry = readLibraryEntry(doc.part, 'as_2');
    expect(entry).toEqual({ asset: 'as_2', kind: 'composition', title: 'Flyer', createdAt: '2026-10-25T09:00:00.000Z', folder: 'Campaigns', favorite: false, tags: ['sale', 'night'], renditions: {} });
  });

  it('ignores nodes that are not library entries and malformed renditions', async () => {
    const doc = unwrap(await openLibraryDocument(createDocumentRepo({ store: createMemoryDocumentStore(), engine: createLoroEngine() }), signal));
    unwrap(
      doc.doc.commit({ actor: { kind: 'human', id: 'x' }, label: 'Seed' }, {
        [LIBRARY_PART]: [
          { op: 'create', node: 'other', kind: 'folder', parent: null },
          { op: 'create', node: 'as_3', kind: LIBRARY_ENTRY_KIND, parent: null, props: { [LibraryPaths.kind]: 'image' } },
          ...entryCreateOps({ asset: 'as_4', kind: 'image', title: 'Ok', createdAt: '' }),
          { op: 'set', node: 'as_4', path: LibraryPaths.rendition('thumbnail'), value: { blob: 'nope' } },
        ],
      }),
    );
    expect(readLibraryEntry(doc.part, 'other')).toBeUndefined();
    expect(readLibraryEntry(doc.part, 'as_3')).toBeUndefined();
    expect(readLibraryEntries(doc.part).map((e) => [e.asset, e.renditions])).toEqual([['as_4', {}]]);
    expect(RENDITION_ROLES).toContain('thumbnail');
  });
});
