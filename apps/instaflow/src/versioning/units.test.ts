import { createInjector, createScope, unit } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { ReleaseUnavailableError } from './errors.js';
import type { VersioningHost } from './panel-model.js';
import type { AssetId } from './records.js';
import { createCountingStore, editPages, engine, priya, registry, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';
import { LatestServiceToken, MilestonesPanelModelToken, ReleasePortToken, type VersioningContext, VersioningContextToken, VersioningServicesToken } from './tokens.js';
import { createVersioningServices, versioningServicesUnit, versioningUnits } from './units.js';

const host: VersioningHost = { showReadOnly: () => {}, showComparison: () => {}, openDocument: () => {} };

async function context(): Promise<VersioningContext> {
  const store = createCountingStore();
  const doc = await seedDocument(repoOn(store), 'as_1', 2);
  return { doc, store, engine, registry, host, actor: () => priya, newAssetId: () => 'as_new' as AssetId, title: () => 'Flyer' };
}

describe('createVersioningServices', () => {
  it('builds Latest, milestones, snapshots and the panel model on one document, disposed with the scope', async () => {
    const ctx = await context();
    const scope = createScope('test');
    const services = createVersioningServices(ctx, scope);
    unwrap(await services.panel.create('A'));
    expect(services.milestones.list()).toHaveLength(1);
    await editPages(ctx.doc, [0], 1);
    expect(services.latest.state().status).toBe('saved'); // transact waited for durability
    unwrap(await services.snapshots.freeze(signal));
    await scope.dispose();
    expect((await services.milestones.create({ name: 'B', actor: priya }, signal)).ok).toBe(false);
  });
});

describe('versioning units', () => {
  it('resolve from a VersioningContext in the injector', async () => {
    const ctx = await context();
    const app = createInjector({ units: [unit({ id: 'test/versioning-context', provides: VersioningContextToken, scope: 'app', create: () => ctx }), ...versioningUnits] });
    const injector = app.child('feature', 'document');
    const services = unwrap(await injector.get(VersioningServicesToken));
    expect(unwrap(await injector.get(LatestServiceToken))).toBe(services.latest);
    expect(unwrap(await injector.get(MilestonesPanelModelToken))).toBe(services.panel);
    const release = unwrap(await injector.get(ReleasePortToken));
    const frozen = unwrap(await services.snapshots.freeze(signal));
    expect(await release.createRelease({ snapshot: frozen, outputs: [], format: 'png', publishedFrom: { asset: 'as_1', title: 'x' } }, signal)).toMatchObject({ ok: false, error: { code: ReleaseUnavailableError.code } });
    expect(versioningServicesUnit.scope).toBe('feature');
    await app.dispose();
  });
});
