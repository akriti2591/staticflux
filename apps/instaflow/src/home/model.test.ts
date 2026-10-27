import { err, ok, type Result } from '@staticflux/core';
import { createMemoryDocumentStore, type DocumentHead, HeadConflictError } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { HOME_CAPABILITIES, HOME_QUICK_ACTIONS, OpenDesignCapability, RenameDesignCapability } from './capabilities.js';
import { HOME_INDEX_SCHEMA, type HomeEntry, type HomeIndex, withHomeIndex } from './index-record.js';
import { appendHomeOps, homeOp } from './journal.js';
import { copyTitle, createHomeModel, ENTRY_HREFS, type HomeImporter, type HomeIndexSource, importRefusal, searchEntries, storeIndexSource, storeJournalWriter, validateHomeName } from './model.js';

const entry = (asset: string, kind: HomeEntry['kind'], editedAt = '2026-10-02T00:00:00.000Z'): HomeEntry => ({ asset, kind, title: `T ${asset}`, createdAt: '2026-10-01T00:00:00.000Z', editedAt, lens: 'layout' });
const INDEX: HomeIndex = { schema: HOME_INDEX_SCHEMA, entries: [entry('as_d', 'composition'), entry('as_t', 'template'), entry('as_i', 'image')] };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(source: HomeIndexSource = { read: async () => ok(INDEX) }) {
  const went: string[] = [];
  const controller = new AbortController();
  const model = createHomeModel({ source, host: { navigate: (href) => went.push(href) }, signal: controller.signal });
  return { model, went, controller };
}

describe('Home model', () => {
  it('reads the index once at start: loading → ready, with recents, files and templates', async () => {
    const { model } = harness();
    expect(model.state).toBe('loading');
    await settle();
    expect(model.state).toBe('ready');
    expect(model.recents().map((e) => e.asset)).toEqual(['as_d']);
    expect(model.templates().map((e) => e.asset)).toEqual(['as_t']);
    expect(model.files()).toHaveLength(3);
    expect(model.quickActions).toBe(HOME_QUICK_ACTIONS);
  });

  it('runs every action as a capability and navigates to the Studio href it resolves', async () => {
    const { model, went } = harness();
    await settle();
    expect(await model.newDesign()).toEqual(ok({ href: '/new' }));
    expect(await model.newDesign('slides')).toEqual(ok({ href: '/new?format=slides' }));
    expect(await model.open('as_d')).toEqual(ok({ href: '/s/as_d' }));
    expect(await model.useTemplate('as_t')).toEqual(ok({ href: '/new?template=as_t' }));
    const story = HOME_QUICK_ACTIONS.find((a) => a.id === 'new-story');
    expect(story).toBeDefined();
    expect(await model.runQuickAction(story as (typeof HOME_QUICK_ACTIONS)[number])).toEqual(ok({ href: '/new?format=story' }));
    expect(went).toEqual(['/new', '/new?format=slides', '/s/as_d', '/new?template=as_t', '/new?format=story']);
    // B11b: the New design dialog's full choice, and a template with a name.
    expect(await model.newDesign({ format: 'custom', width: 640, height: 480, pages: 2, name: 'Menu', background: '#000000' })).toEqual(ok({ href: '/new?format=custom&w=640&h=480&pages=2&name=Menu&bg=%23000000' }));
    expect(await model.useTemplate('as_t', 'Spring')).toEqual(ok({ href: '/new?template=as_t&name=Spring' }));
  });

  it('refuses designs and templates the workspace does not have (and navigates nowhere)', async () => {
    const { model, went } = harness();
    await settle();
    const open = await model.open('as_nope');
    expect(!open.ok && open.error.code).toBe('IF-HOME-002');
    const media = await model.open('as_i');
    expect(!media.ok && media.error.code).toBe('IF-HOME-002');
    const template = await model.useTemplate('as_d');
    expect(!template.ok && template.error.code).toBe('IF-HOME-003');
    const invalid = await model.newDesign('banner' as never);
    expect(!invalid.ok && invalid.error.code).toBe('SF-CAP-002');
    const sizeless = await model.newDesign({ format: 'custom', width: 640 });
    expect(!sizeless.ok && sizeless.error.code).toBe('IF-POL-054');
    const huge = await model.newDesign({ format: 'custom', width: 20_000, height: 10 });
    expect(!huge.ok && huge.error.code).toBe('SF-CAP-002');
    expect(went).toEqual([]);
  });

  it('is the same pipeline for agents: described with typed input and callable by an agent subject', async () => {
    const { model, went } = harness();
    await settle();
    const described = model.capabilities.describe().map((d) => [d.id, d.exposeToAgents]);
    expect(described).toEqual(HOME_CAPABILITIES.map((c) => [c.id, true]));
    expect(described.map(([id]) => id)).toEqual([
      'instaflow/new-design',
      'instaflow/open-design',
      'instaflow/use-template',
      'instaflow/rename-design',
      'instaflow/duplicate-design',
      'instaflow/move-to-project',
      'instaflow/favorite',
      'instaflow/trash-designs',
      'instaflow/restore-designs',
      'instaflow/delete-forever',
      'instaflow/new-project',
      'instaflow/rename-project',
      'instaflow/delete-project',
      'instaflow/search-files',
    ]);
    const run = await model.capabilities.invoke(OpenDesignCapability, { asset: 'as_d' }, { subject: 'agent' });
    expect(run).toEqual(ok({ href: '/s/as_d' }));
    expect(went).toEqual(['/s/as_d']);
  });

  it('maps entry kinds to hrefs as data (designs open, templates start, media have none)', async () => {
    const { model } = harness();
    await settle();
    expect(model.hrefOf(entry('as_d', 'composition'))).toBe('/s/as_d');
    expect(model.hrefOf(entry('as_t', 'template'))).toBe('/new?template=as_t');
    expect(model.hrefOf(entry('as_i', 'image'))).toBeUndefined();
    expect(Object.keys(ENTRY_HREFS).sort()).toEqual(['composition', 'template']);
  });

  it('fails visibly and recovers on refresh: loading → failed → loading → ready', async () => {
    let calls = 0;
    const source: HomeIndexSource = { read: async (): Promise<Result<HomeIndex>> => ((calls += 1) === 1 ? err(HeadConflictError({ message: 'disk' })) : ok(INDEX)) };
    const { model } = harness(source);
    await settle();
    expect(model.state).toBe('failed');
    expect(model.error?.message).toBe('disk');
    const again = await model.refresh();
    expect(again.ok).toBe(true);
    expect(model.state).toBe('ready');
    expect(model.error).toBeUndefined();
    expect(model.recents()).toHaveLength(1);
  });

  it('keeps the newest read when reads overlap, and stops with its signal', async () => {
    const pending: ((r: Result<HomeIndex>) => void)[] = [];
    const source: HomeIndexSource = { read: () => new Promise((resolve) => pending.push(resolve)) };
    const { model, controller } = harness(source);
    const second = model.refresh(); // still loading: no transition, a newer read
    pending[1]?.(ok(INDEX));
    await second;
    pending[0]?.(ok({ schema: HOME_INDEX_SCHEMA, entries: [] }));
    await settle();
    expect(model.recents()).toHaveLength(1);
    controller.abort();
    expect(model.state).toBe('disposed');
    expect((await model.open('as_d')).ok).toBe(false); // its registry is gone
    expect((await model.refresh()).ok).toBe(true); // a no-op after dispose
  });

  it('reads the index from the library head of the workspace store (no head: an empty workspace)', async () => {
    const store = createMemoryDocumentStore();
    const source = storeIndexSource(store);
    const signal = new AbortController().signal;
    expect(await source.read(signal)).toEqual(ok({ schema: HOME_INDEX_SCHEMA, entries: [] }));
    const base: DocumentHead = { asset: 'library', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 };
    const head = withHomeIndex(base, INDEX);
    expect((await store.writeHead('library', head, null, signal)).ok).toBe(true);
    const read = await source.read(signal);
    expect(read.ok && read.value.entries.map((e) => e.asset)).toEqual(['as_d', 'as_i', 'as_t']); // same edit time: by id
    store.failNext('readHead', HeadConflictError());
    const failed = await source.read(signal);
    expect(!failed.ok && failed.error.code).toBe('IF-HOME-001');
  });

  it('reads Home’s pending journal on top of the stored index (a change shows before Studio applies it)', async () => {
    const store = createMemoryDocumentStore();
    const signal = new AbortController().signal;
    const base: DocumentHead = { asset: 'library', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 };
    expect((await store.writeHead('library', withHomeIndex(base, INDEX), null, signal)).ok).toBe(true);
    expect((await appendHomeOps(store, [homeOp({ kind: 'rename', asset: 'as_d', title: 'Renamed' }), homeOp({ kind: 'trash', assets: ['as_i'] })], signal)).ok).toBe(true);
    const read = await storeIndexSource(store).read(signal);
    expect(read.ok && read.value.entries.find((e) => e.asset === 'as_d')?.title).toBe('Renamed');
    expect(read.ok && read.value.entries.find((e) => e.asset === 'as_i')?.trashedAt).toBeDefined();
    store.failNext('readHead', HeadConflictError());
    expect((await storeIndexSource(store).read(signal)).ok).toBe(false);
  });
});

describe('Home file operations (B11c)', () => {
  const FILES: HomeIndex = {
    schema: HOME_INDEX_SCHEMA,
    entries: [entry('as_d', 'composition'), entry('as_t', 'template'), entry('as_i', 'image'), { ...entry('as_x', 'composition'), trashedAt: '2026-10-03T00:00:00.000Z' }, { ...entry('as_p', 'composition'), folder: 'Spring' }],
  };

  async function files(importer?: HomeImporter) {
    const store = createMemoryDocumentStore();
    const signal = new AbortController().signal;
    const base: DocumentHead = { asset: 'library', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 };
    expect((await store.writeHead('library', withHomeIndex(base, FILES), null, signal)).ok).toBe(true);
    const pings: number[] = [];
    let ids = 0;
    const pushed: string[] = [];
    const model = createHomeModel({
      source: storeIndexSource(store),
      journal: storeJournalWriter(store, () => pings.push(1)),
      ...(importer === undefined ? {} : { importer: async () => importer }),
      host: { navigate: () => undefined, push: (h) => pushed.push(h) },
      signal,
      now: () => Date.parse('2026-10-05T00:00:00.000Z'),
      newAssetId: () => `as_n${(ids += 1)}`,
    });
    await settle();
    const journal = async () => {
      const head = await store.readHead('home-journal', signal);
      return head.ok ? ((head.value?.app?.['journal'] as { ops?: { kind: string }[] } | undefined)?.ops ?? []).map((o) => o.kind) : [];
    };
    return { model, store, pings, journal, pushed };
  }

  it('rename, favourite, move, trash, restore and delete forever: one journal op each, shown at once, Studio pinged', async () => {
    const { model, journal, pings } = await files();
    expect((await model.rename('as_d', '  Spring sale ')).ok).toBe(true);
    expect(model.entry('as_d')?.title).toBe('Spring sale');
    expect((await model.rename('as_d', 'Spring sale')).ok).toBe(true); // unchanged: nothing written
    expect((await model.favorite('as_d', true)).ok).toBe(true);
    expect(model.entry('as_d')?.favorite).toBe(true);
    expect((await model.move(['as_d', 'as_i'], 'Autumn')).ok).toBe(true);
    expect(model.projects().map((p) => [p.name, p.count])).toEqual([
      ['Autumn', 2],
      ['Spring', 1],
    ]);
    expect((await model.trash(['as_d'])).ok).toBe(true);
    expect(model.files().map((e) => e.asset)).not.toContain('as_d');
    expect(model.trashed().map((e) => e.asset)).toEqual(['as_d', 'as_x']);
    expect((await model.restore(['as_d'])).ok).toBe(true);
    expect((await model.deleteForever(['as_x'])).ok).toBe(true);
    expect(model.entry('as_x')).toBeUndefined();
    expect(await journal()).toEqual(['rename', 'favorite', 'move', 'trash', 'restore', 'purge']);
    expect(pings).toHaveLength(6);
    await model.refresh(); // a read keeps every change (the journal is read on top of the stored index)
    expect(model.entry('as_d')).toMatchObject({ title: 'Spring sale', favorite: true, folder: 'Autumn' });
  });

  it('refuses what does not apply, with stable codes, and writes nothing', async () => {
    const { model, journal } = await files();
    const code = async (r: Promise<{ ok: boolean; error?: { code: string } }>) => {
      const done = await r;
      return done.ok ? 'ok' : done.error?.code;
    };
    expect(await code(model.rename('as_d', '   '))).toBe('IF-POL-056');
    expect(await code(model.rename('as_none', 'x'))).toBe('IF-HOME-002');
    expect(await code(model.trash(['as_x']))).toBe('IF-HOME-002'); // already in the trash
    expect(await code(model.restore(['as_d']))).toBe('IF-HOME-002'); // not in the trash
    expect(await code(model.deleteForever(['as_d']))).toBe('IF-HOME-002'); // only from the trash
    expect(await code(model.move(['as_d'], 'a/b'))).toBe('SF-CAP-002');
    expect(await code(model.duplicate('as_i'))).toBe('IF-HOME-002'); // media are not duplicated
    expect(await code(model.newProject('Spring'))).toBe('IF-POL-058');
    expect(await code(model.renameProject('Nope', 'x'))).toBe('IF-POL-058');
    expect(await code(model.deleteProject('Nope'))).toBe('IF-POL-058');
    expect(await journal()).toEqual([]);
  });

  it('duplicate: a "copy" next to the original (same project, size); its id is fresh', async () => {
    const { model, journal } = await files();
    const copy = await model.duplicate('as_p');
    expect(copy).toEqual(ok({ asset: 'as_n1', title: 'T as_p copy' }));
    expect(model.entry('as_n1')).toMatchObject({ kind: 'composition', title: 'T as_p copy', folder: 'Spring', editedAt: '2026-10-05T00:00:00.000Z' });
    expect(model.recents()[0]?.asset).toBe('as_n1');
    expect(await journal()).toEqual(['duplicate']);
    expect(copyTitle('x'.repeat(200))).toHaveLength(200);
  });

  it('projects: new (kept while empty), rename (designs follow), delete (designs go to No project)', async () => {
    const { model } = await files();
    expect((await model.newProject('  Brand ')).ok).toBe(true);
    expect(model.projects().find((p) => p.name === 'Brand')?.count).toBe(0);
    expect((await model.renameProject('Spring', 'Summer')).ok).toBe(true);
    expect(model.entry('as_p')?.folder).toBe('Summer');
    expect((await model.renameProject('Summer', 'Brand')).ok).toBe(false); // the name is taken
    expect((await model.deleteProject('Summer')).ok).toBe(true);
    expect(model.entry('as_p')?.folder).toBeUndefined();
    expect(model.entry('as_p')?.trashedAt).toBeUndefined();
    expect(model.projects().map((p) => p.name)).toEqual(['Brand']);
  });

  it('search finds titles and projects, case-insensitive, live only; the capability returns asset ids', async () => {
    const { model } = await files();
    expect(model.search('t AS_P').map((e) => e.asset)).toEqual(['as_p']);
    expect(model.search('spring').map((e) => e.asset)).toEqual(['as_p']);
    expect(model.search('as_x')).toEqual([]); // trashed
    expect(searchEntries(FILES.entries, '  ')).toEqual([]);
    expect(await model.capabilities.invoke('instaflow/search-files', { query: 'T as_' }, { subject: 'agent' })).toEqual(ok({ assets: ['as_d', 'as_i', 'as_p', 'as_t'] }));
  });

  it('import: images, SVG and fonts are stored and journalled into the project; same content is not imported twice; video and others are refused', async () => {
    const seen: string[] = [];
    const importer: HomeImporter = {
      async importFile(file, asset) {
        seen.push(`${file.name}:${asset}`);
        return ok({ asset, kind: 'image', title: file.name, mime: file.type, size: file.size, content: { digest: `sha256:${file.name === 'b.png' ? 'a.png' : file.name}`, size: 1, mime: file.type }, record: { digest: 'sha256:r', size: 1, mime: 'x' } });
      },
    };
    const { model, journal } = await files(importer);
    const file = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });
    const done = await model.importFiles([file('a.png', 'image/png'), file('b.png', 'image/png'), file('clip.mp4', 'video/mp4'), file('notes.txt', 'text/plain')], { project: 'Spring' });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.imported.map((e) => [e.asset, e.folder, e.digest])).toEqual([['as_n1', 'Spring', 'sha256:a.png']]);
    expect(done.value.skipped.map((s) => [s.name, s.reason])).toEqual([
      ['clip.mp4', 'video'],
      ['notes.txt', 'unsupported'],
    ]);
    expect(seen).toEqual(['a.png:as_n1', 'b.png:as_n2']); // b.png has the same bytes: stored, deduped, not listed
    const twice = await model.importFiles([file('a.png', 'image/png')]);
    expect(twice.ok && twice.value.existing.map((e) => e.asset)).toEqual(['as_n1']);
    expect(await journal()).toEqual(['import']);
    expect(importRefusal({ name: 'x.svg', type: '' })).toBeUndefined();
    expect(importRefusal({ name: 'x.woff2', type: '' })).toBeUndefined();
    expect(importRefusal({ name: 'x.mp3', type: 'audio/mpeg' })).toBe('video');
    expect(importRefusal({ name: 'x.pdf', type: 'application/pdf' })).toBe('unsupported');
  });

  it('pages: go pushes history and shows the page; show follows Back', async () => {
    const { model, pushed } = await files();
    model.go({ kind: 'files', query: 'flyer', sort: 'name' });
    expect(model.view).toEqual({ kind: 'files', query: 'flyer', sort: 'name' });
    model.go({ kind: 'project', name: 'Spring campaign' });
    expect(pushed).toEqual(['/files?q=flyer&sort=name', '/p/Spring%20campaign']);
    model.show({ kind: 'trash' });
    expect(model.view.kind).toBe('trash');
    expect(pushed).toHaveLength(2);
  });

  it('names: trimmed, 1–200 for designs, 1–60 and no "/" for projects (IF-POL-056)', () => {
    expect(validateHomeName('  a ', 200)).toEqual(ok('a'));
    const empty = validateHomeName(' ', 200);
    expect(!empty.ok && empty.error.code).toBe('IF-POL-056');
    expect(validateHomeName('a/b', 60, true).ok).toBe(false);
    expect(validateHomeName('x'.repeat(61), 60, true).ok).toBe(false);
  });

  it('a capability run by an agent is the same operation (rename through the registry)', async () => {
    const { model } = await files();
    expect(await model.capabilities.invoke(RenameDesignCapability, { asset: 'as_t', title: 'Promo' }, { subject: 'agent' })).toEqual(ok({ count: 1 }));
    expect(model.entry('as_t')?.title).toBe('Promo');
    expect(OpenDesignCapability.id).toBe('instaflow/open-design');
  });
});
