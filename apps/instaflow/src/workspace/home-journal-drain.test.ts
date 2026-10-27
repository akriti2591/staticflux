// @vitest-environment node
import { createScope, err, ok } from '@staticflux/core';
import { HeadConflictError } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { createStudioDocument, openStudioWorkspace } from '../app/document.js';
import { person, unwrap } from '../app/test-helpers.js';
import { P } from '../elements/components.js';
import { HOME_INDEX_SCHEMA, readHomeIndex } from '../home/index-record.js';
import { appendHomeOps, HOME_JOURNAL_ASSET, homeOp, readHomeJournal } from '../home/journal.js';
import { storeIndexSource } from '../home/model.js';
import { createLibrary } from '../library/library.js';
import { LIBRARY_ASSET } from '../library/library-doc.js';
import { duplicateDesign } from './duplicate.js';
import { projectHomeIndex, writeHomeIndex } from './home-index-writer.js';
import { createHomeJournalDrain, drainHomeJournal } from './home-journal-drain.js';

async function setup() {
  const scope = createScope('drain-test');
  const workspace = unwrap(await openStudioWorkspace({ signal: scope.signal }));
  const library = createLibrary({ source: { part: workspace.library.part, commit: (meta, changes) => workspace.library.doc.commit(meta, changes) }, actor: () => person });
  const at = '2026-10-01T00:00:00.000Z';
  unwrap(library.add({ asset: 'as_d' as never, kind: 'composition', title: 'Flyer', createdAt: at }));
  unwrap(library.add({ asset: 'as_e' as never, kind: 'composition', title: 'Menu', createdAt: at, folder: 'Spring' }));
  unwrap(library.add({ asset: 'as_i' as never, kind: 'image', title: 'Lamp', createdAt: at, content: { digest: `sha256:${'a'.repeat(64)}`, size: 3, mime: 'image/png' } as never }));
  const duplicated: string[] = [];
  const flushed: number[] = [];
  const services = {
    store: workspace.store,
    library,
    duplicate: async (r: { source: string; asset: string }) => (duplicated.push(`${r.source}→${r.asset}`), ok(undefined)),
    flushIndex: async () => {
      flushed.push(1);
      const done = await writeHomeIndex(workspace.store, (current) => projectHomeIndex(library.entries(), current), scope.signal);
      return done.ok ? ok() : done;
    },
  };
  const journal = async () => {
    const head = await workspace.store.readHead(HOME_JOURNAL_ASSET, scope.signal);
    return head.ok ? readHomeJournal(head.value) : [];
  };
  return { scope, workspace, library, services, duplicated, flushed, journal };
}

describe('drainHomeJournal (Studio applies what Home wrote)', () => {
  it('applies every op kind to the library in order, rewrites the index, then empties the journal', async () => {
    const { scope, workspace, library, services, duplicated, flushed, journal } = await setup();
    const media = { asset: 'as_new', kind: 'image' as const, title: 'Poster photo', mime: 'image/png', size: 9, content: { digest: `sha256:${'b'.repeat(64)}`, size: 9, mime: 'image/png' }, record: { digest: `sha256:${'c'.repeat(64)}`, size: 2, mime: 'application/vnd.instaflow.asset+json' }, width: 4, height: 5, folder: 'Spring' };
    const ops = [
      homeOp({ kind: 'rename', asset: 'as_d', title: 'Spring flyer' }),
      homeOp({ kind: 'favorite', asset: 'as_d', favorite: true }),
      homeOp({ kind: 'move', assets: ['as_d'], folder: 'Spring' }),
      homeOp({ kind: 'duplicate', source: 'as_d', asset: 'as_copy', title: 'Spring flyer copy', folder: 'Spring' }),
      homeOp({ kind: 'import', media }),
      homeOp({ kind: 'import', media: { ...media, asset: 'as_dupe', content: { digest: `sha256:${'a'.repeat(64)}`, size: 3, mime: 'image/png' } } }), // same bytes as as_i
      homeOp({ kind: 'trash', assets: ['as_i'] }),
      homeOp({ kind: 'project-rename', from: 'Spring', to: 'Summer' }),
      homeOp({ kind: 'project-add', name: 'Brand' }),
      homeOp({ kind: 'rename', asset: 'as_gone', title: 'never there' }), // no longer applies: dropped
    ];
    unwrap(await appendHomeOps(workspace.store, ops, scope.signal));
    const report = unwrap(await drainHomeJournal(services, scope.signal));
    expect(report).toEqual({ drained: 10, problems: [] });
    expect(library.entry('as_d' as never)).toMatchObject({ title: 'Spring flyer', favorite: true, folder: 'Summer' });
    expect(library.entry('as_e' as never)?.folder).toBe('Summer');
    expect(library.entry('as_copy' as never)).toMatchObject({ kind: 'composition', title: 'Spring flyer copy', folder: 'Summer' });
    expect(library.entry('as_new' as never)).toMatchObject({ kind: 'image', title: 'Poster photo', folder: 'Summer', media: { width: 4, height: 5 } });
    expect(library.entry('as_dupe' as never)).toBeUndefined();
    expect(library.entry('as_i' as never)?.trashedAt).toBeDefined();
    expect(duplicated).toEqual(['as_d→as_copy']);
    expect(flushed).toEqual([1]);
    expect(await journal()).toEqual([]);
    // The index Home reads now holds it all without the journal (and keeps the project made on Home).
    const home = unwrap(await storeIndexSource(workspace.store).read(scope.signal));
    expect(home.entries.find((e) => e.asset === 'as_copy')?.title).toBe('Spring flyer copy');
    const stored = await workspace.store.readHead(LIBRARY_ASSET, scope.signal);
    expect(stored.ok && readHomeIndex(stored.value).projects?.map((p) => p.name)).toEqual(['Brand']);
    expect(unwrap(await drainHomeJournal(services, scope.signal))).toEqual({ drained: 0, problems: [] });
    scope.dispose();
  });

  it('restore and purge (delete forever); a failed op is reported and dropped, the rest still apply', async () => {
    const { scope, workspace, library, services, journal } = await setup();
    unwrap(library.trash(['as_d' as never, 'as_e' as never]));
    const problems: string[] = [];
    unwrap(await appendHomeOps(workspace.store, [homeOp({ kind: 'restore', assets: ['as_d'] }), homeOp({ kind: 'purge', assets: ['as_e'] }), homeOp({ kind: 'duplicate', source: 'as_d', asset: 'as_x', title: 'x copy' }), homeOp({ kind: 'project-remove', name: 'Spring' })], scope.signal));
    const failing = { ...services, duplicate: async () => err(HeadConflictError({ message: 'disk' })), onProblem: (e: { code: string }) => void problems.push(e.code) };
    const report = unwrap(await drainHomeJournal(failing, scope.signal));
    expect(report.problems.map((p) => p.code)).toEqual(['SF-DOC-011']);
    expect(problems).toEqual(['SF-DOC-011']);
    expect(library.entry('as_d' as never)?.trashedAt).toBeUndefined();
    expect(library.entry('as_e' as never)).toBeUndefined();
    expect(library.entry('as_x' as never)).toBeUndefined();
    expect(await journal()).toEqual([]);
    scope.dispose();
  });

  it('keeps the journal when the index cannot be rewritten (Home goes on showing the ops)', async () => {
    const { scope, workspace, services, journal } = await setup();
    unwrap(await appendHomeOps(workspace.store, [homeOp({ kind: 'rename', asset: 'as_d', title: 'x' })], scope.signal));
    const done = await drainHomeJournal({ ...services, flushIndex: async () => err(HeadConflictError()) }, scope.signal);
    expect(done.ok).toBe(false);
    expect(await journal()).toHaveLength(1);
    scope.dispose();
  });

  it('is single-flight: a run during a run waits for one more pass', async () => {
    const { scope, workspace, services, library } = await setup();
    const drain = createHomeJournalDrain(services);
    unwrap(await appendHomeOps(workspace.store, [homeOp({ kind: 'rename', asset: 'as_d', title: 'One' })], scope.signal));
    const first = drain.run(scope.signal);
    const second = drain.run(scope.signal);
    unwrap(await appendHomeOps(workspace.store, [homeOp({ kind: 'rename', asset: 'as_d', title: 'Two' })], scope.signal));
    await first;
    await second;
    await drain.run(scope.signal);
    expect(library.entry('as_d' as never)?.title).toBe('Two');
    expect(HOME_INDEX_SCHEMA).toBe('instaflow.home-index/1');
    scope.dispose();
  });
});

describe('duplicateDesign', () => {
  it('makes a detached copy of Latest under a new id (no history), whether or not the source is open', async () => {
    const scope = createScope('duplicate-test');
    const workspace = unwrap(await openStudioWorkspace({ signal: scope.signal }));
    const source = unwrap(await createStudioDocument(workspace, { asset: 'as_src', title: 'Source', pages: 2, size: { width: 300, height: 200 }, background: '#ffeedd', signal: scope.signal }));
    unwrap(await source.flush(scope.signal));
    unwrap(await source.close(scope.signal));
    const made = unwrap(await duplicateDesign({ store: workspace.store, engine: workspace.engine, repo: workspace.repo, actor: person }, { source: 'as_src', asset: 'as_copy' as never, title: 'Source copy' }, scope.signal));
    expect(made.asset).toBe('as_copy');
    expect(made.record.createdFrom?.title).toBe('Source copy');
    const copy = unwrap(await workspace.repo.open('as_copy', scope.signal));
    const page = unwrap(await copy.part('page:p2', scope.signal));
    expect(page.prop('p2', P.fills)).toEqual([{ paint: '#ffeedd' }]);
    expect(workspace.repo.get('as_src')).toBeUndefined(); // the source was opened for the copy and closed again
    const again = await duplicateDesign({ store: workspace.store, engine: workspace.engine, repo: workspace.repo, actor: person }, { source: 'as_src', asset: 'as_copy' as never, title: 'x' }, scope.signal);
    expect(!again.ok && again.error.code).toBe('IF-VER-008'); // the id is taken
    scope.dispose();
  });
});
