// @vitest-environment node
import { ok } from '@staticflux/core';
import { inMemorySpawner } from '@staticflux/worker';
import { describe, expect, it } from 'vitest';
import { authoringBuilt } from '../app/test-helpers.js';
import type { ExportFile } from './formats.js';
import { hostExportWorker } from './host.js';
import { createExportService, type ExportStatus } from './service.js';
import { createExportFixture, exportBuilt } from './testing/test-helpers.js';

const ASSETS = { manifest: 'memory://manifest', fonts: [] };

async function setup() {
  const f = await createExportFixture();
  const delivered: ExportFile[][] = [];
  let spawned = 0;
  const service = createExportService({
    spawn: () =>
      inMemorySpawner((port) => {
        spawned += 1;
        hostExportWorker({ port, env: { load: async () => ok(f.env) } });
      }, { clone: false }),
    assets: ASSETS,
    store: { store: f.studio.workspace.store, blobs: f.blobs },
    target: async () => ok({ snapshot: await f.freeze(), page: 'p1', pages: ['p1', 'p2'], selection: ['star'] }),
    title: () => 'Spring Flyer',
    images: () => f.images,
    deliver: async (files) => {
      delivered.push([...files]);
      return ok();
    },
  });
  return { f, service, delivered, spawned: () => spawned };
}

// The whole main → export worker → main path over in-memory ports (the same host the browser runs), with the real
// composition and writers in Node.
describe.skipIf(!authoringBuilt || !exportBuilt)('export service (main side, in-process export worker)', () => {
  it('runs one job per worker, posts progress, delivers the files and reports them', { timeout: 60_000 }, async () => {
    const { service, delivered, spawned } = await setup();
    const statuses: ExportStatus['kind'][] = [];
    const off = service.onChange((s) => statuses.push(s.kind));
    const out = await service.run({ format: 'pdf', scale: 2, transparent: false, scope: 'pages' });
    if (!out.ok) throw out.error;
    expect(out.value.files.map((x) => x.name)).toEqual(['Spring Flyer.pdf']);
    expect(delivered).toHaveLength(1);
    expect(spawned()).toBe(1);
    expect(statuses[0]).toBe('running');
    expect(statuses).toContain('running');
    expect(statuses.at(-1)).toBe('done');
    const status = service.status;
    expect(status.kind === 'done' && status.files[0]?.name).toBe('Spring Flyer.pdf');
    off();
    // a second export spawns a fresh worker
    const png = await service.run({ format: 'png', scale: 1, transparent: true, scope: 'selection' });
    if (!png.ok) throw png.error;
    expect(spawned()).toBe(2);
  });

  it('refuses a second export while one runs, and cancels', { timeout: 60_000 }, async () => {
    const { service } = await setup();
    const first = service.run({ format: 'png', scale: 3, transparent: false, scope: 'pages' });
    const second = await service.run({ format: 'svg', scale: 1, transparent: false, scope: 'page' });
    expect(!second.ok && second.error.code).toBe('IF-EXP-007');
    service.cancel();
    const out = await first;
    expect(!out.ok && out.error.kind).toBe('aborted');
    expect(service.status.kind).toBe('cancelled');
    service.dispose();
    const after = await service.run({ format: 'svg', scale: 1, transparent: false, scope: 'page' });
    expect(!after.ok && after.error.code).toBe('IF-EXP-007');
  });

  it('an empty selection is IF-EXP-002 before any worker starts', { timeout: 60_000 }, async () => {
    const f = await createExportFixture();
    let spawned = 0;
    const service = createExportService({
      spawn: () => inMemorySpawner(() => void (spawned += 1)),
      assets: ASSETS,
      store: { store: f.studio.workspace.store, blobs: f.blobs },
      target: async () => ok({ snapshot: await f.freeze(), page: 'p1', pages: ['p1'], selection: [] }),
      title: () => 'x',
      images: () => [],
    });
    const out = await service.run({ format: 'png', scale: 1, transparent: false, scope: 'selection' });
    expect(!out.ok && out.error.code).toBe('IF-EXP-002');
    expect(spawned).toBe(0);
    expect(service.status.kind).toBe('failed');
  });
});
