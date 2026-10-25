// @vitest-environment node
import { createScope, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { openStudioWorkspace } from '../app/document.js';
import { person, unwrap } from '../app/test-helpers.js';
import { createLibrary } from '../library/library.js';
import { DEMO_DOCUMENT, listDesign, planStudioDocument, UNTITLED_DESIGN } from './studio-document.js';
import { readMilestone } from './templates.js';

async function setup() {
  const scope = createScope('plan-test');
  const workspace = unwrap(await openStudioWorkspace({ signal: scope.signal }));
  const library = createLibrary({ source: { part: workspace.library.part, commit: (meta, changes) => workspace.library.doc.commit(meta, changes) }, actor: () => person });
  let ids = 0;
  const context = { store: workspace.store, engine: workspace.engine, library: workspace.library.part, actor: person, newAssetId: () => `as_p${(ids += 1)}` as never, now: () => Date.parse('2026-10-25T10:00:00.000Z') };
  return { scope, workspace, library, context };
}

describe('planStudioDocument', () => {
  it('new design: a fresh asset of the format, listed after boot', async () => {
    const { scope, context, library } = await setup();
    const plan = unwrap(await planStudioDocument({ kind: 'new', format: 'slides', template: undefined }, context, scope.signal));
    expect(plan).toEqual({
      ref: { asset: 'as_p1', title: UNTITLED_DESIGN, create: { pages: 5, size: { width: 1920, height: 1080 } } },
      listing: { asset: 'as_p1', kind: 'composition', title: UNTITLED_DESIGN, createdAt: '2026-10-25T10:00:00.000Z' },
      format: { width: 1920, height: 1080 },
      created: true,
    });
    expect(listDesign(library, plan)).toEqual(ok());
    expect(library.entry('as_p1' as never)?.title).toBe(UNTITLED_DESIGN);
    expect(listDesign(library, plan)).toEqual(ok()); // already listed: no second entry
    expect(library.entries()).toHaveLength(1);
    expect((await planStudioDocument({ kind: 'new', format: undefined, template: undefined }, context, scope.signal)).ok && true).toBe(true);
    scope.dispose();
  });

  it('demo: the B8 demo document, listed when missing', async () => {
    const { scope, context, library } = await setup();
    const plan = unwrap(await planStudioDocument({ kind: 'demo' }, context, scope.signal));
    expect(plan.ref).toBe(DEMO_DOCUMENT);
    expect(plan.listing?.asset).toBe('as_demo');
    expect(plan.created).toBe(false);
    unwrap(listDesign(library, plan));
    const again = unwrap(await planStudioDocument({ kind: 'demo' }, context, scope.signal));
    expect(again.listing).toBeUndefined();
    scope.dispose();
  });

  it('open: refuses an asset with no document, and a design in the trash', async () => {
    const { scope, context, library, workspace } = await setup();
    const missing = await planStudioDocument({ kind: 'open', asset: 'as_none' }, context, scope.signal);
    expect(!missing.ok && missing.error.code).toBe('IF-HOME-002');
    // A document with a head that the library does not list yet: opened and listed.
    unwrap(await workspace.store.writeHead('as_bare', { asset: 'as_bare', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 }, null, scope.signal));
    const bare = unwrap(await planStudioDocument({ kind: 'open', asset: 'as_bare' }, context, scope.signal));
    expect(bare.listing?.asset).toBe('as_bare');
    unwrap(listDesign(library, bare));
    unwrap(library.trash(['as_bare' as never]));
    const trashed = await planStudioDocument({ kind: 'open', asset: 'as_bare' }, context, scope.signal);
    expect(!trashed.ok && trashed.error.code).toBe('IF-HOME-002');
    scope.dispose();
  });

  it('template: refuses unknown templates; a template without a milestone is IF-HOME-006', async () => {
    const { scope, context, library, workspace } = await setup();
    const unknown = await planStudioDocument({ kind: 'new', format: undefined, template: 'as_t' }, context, scope.signal);
    expect(!unknown.ok && unknown.error.code).toBe('IF-HOME-003');
    unwrap(library.add({ asset: 'as_t' as never, kind: 'template', title: 'Empty template', createdAt: '2026-10-01T00:00:00.000Z' }));
    const noHead = await planStudioDocument({ kind: 'new', format: undefined, template: 'as_t' }, context, scope.signal);
    expect(!noHead.ok && noHead.error.code).toBe('IF-HOME-006');
    unwrap(await workspace.store.writeHead('as_t', { asset: 'as_t', generation: 1, engine: 'loro/1', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200, app: { versioning: { milestones: [{ id: `ms_${'a'.repeat(64)}`, size: 10 }], pinned: [], names: {} } } }, null, scope.signal));
    const missingRecord = await readMilestone(workspace.store, 'as_t', undefined, scope.signal);
    expect(!missingRecord.ok && missingRecord.error.code).toBe('IF-HOME-006');
    scope.dispose();
  });
});
