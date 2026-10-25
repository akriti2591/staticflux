// @vitest-environment node
// The editor environment loads B1's and B2's Wasm from the file system (suites skip when it is not built).
import { createBlobStore, createMemoryObjectStore } from '@staticflux/blob';
import { createScope, err } from '@staticflux/core';
import { createMemoryDocumentStore } from '@staticflux/document/v2';
import { InputCode } from '@staticflux/surface';
import { describe, expect, it } from 'vitest';
import { authoringBuilt, person, unwrap } from '../app/test-helpers.js';
import { DEFAULT_SEQUENCING_SETTINGS, type Topology } from '../sequencing/topology.js';
import { bootStudioWorkers } from './boot.js';
import { DOUBLE_CLICK } from './editor-module.js';
import { WorkerBootError } from './errors.js';
import { StudioWorkerLifecycle } from './host.js';
import { dragEvents, inProcessWorkers, inputWriter, until } from './test-helpers.js';

const boot = async (topology: Topology, workers = inProcessWorkers(), asset = `as_host_${topology}`) => {
  const scope = createScope('host-test');
  const booted = await bootStudioWorkers({
    settings: { ...DEFAULT_SEQUENCING_SETTINGS, topology },
    spawn: () => workers.spawn(),
    editor: { document: { asset, title: 'Test', create: { pages: 2 } }, person, isMac: false, textInput: 'hidden-textarea' },
    store: { store: createMemoryDocumentStore(), blobs: createBlobStore(createMemoryObjectStore()) },
    signal: scope.signal,
  });
  return { scope, workers, booted };
};

describe('Studio worker lifecycle (LIFECYCLES §35)', () => {
  it('is idle → starting → running | failed → stopped', () => {
    expect(StudioWorkerLifecycle.initial).toBe('idle');
    expect(StudioWorkerLifecycle.transitions.starting).toEqual({ run: 'running', fail: 'failed', stop: 'stopped' });
    expect(StudioWorkerLifecycle.terminal).toEqual(['stopped']);
  });
});

describe.skipIf(!authoringBuilt).each(['colocated', 'split'] as const)('Studio workers in process: %s', (topology) => {
  it('boots by the plan, routes requests to the module that owns them, and refuses the others (IF-WRK-002, 004, 006)', { timeout: 60_000 }, async () => {
    const { scope, workers, booted } = await boot(topology);
    const w = unwrap(booted);
    expect(w.plan.topology).toBe(topology);
    expect(workers.hosts.map((h) => h.state)).toEqual(topology === 'split' ? ['running', 'running'] : ['running']);
    expect(w.started.pages).toEqual(['p1', 'p2']);
    const inspect = async () => {
      const r = await w.editor.request('inspect', {});
      return r.ok ? r.value : undefined;
    };
    // The render module waits for the canvas; the editor opens a page.
    unwrap(await w.render.request('canvas', { canvas: {}, width: 800, height: 600, dpr: 1 }));
    await Promise.all(workers.hosts.filter((h) => h.render !== undefined || topology === 'colocated').map((h) => h.drawing));
    const again = await w.render.request('canvas', { canvas: {}, width: 800, height: 600, dpr: 1 });
    expect(!again.ok && again.error.code).toBe('IF-WRK-006');
    unwrap(await w.editor.request('open', { page: 'p1', viewport: { width: 800, height: 600 } }));

    // With the Shape tool picked, a drag through the input ring draws a rectangle.
    unwrap(await w.editor.request('tool', { tool: 'instaflow/shape' }));
    const push = inputWriter(w.input);
    push(dragEvents([100, 100], [220, 200]));
    const created = async () => (await inspect())?.elements.length === 1;
    await until(created, 'a rectangle from the ring');
    workers.draw();
    expect(workers.rasters[0]?.presents).toBeGreaterThan(0);

    // Keys from the ring reach the canvas shortcuts (Escape clears the selection).
    push([{ t: InputCode.keyDown, key: 'Escape', code: 'Escape' }]);
    await until(async () => (await inspect())?.view.selection.length === 0, 'Escape cleared the selection');
    // Two presses within the double-click time and distance edit text (the ring carries no click count).
    expect(DOUBLE_CLICK).toEqual({ ms: 500, px: 4 });

    const unknown = await w.editor.request('invoke', { capability: 'instaflow/nope', input: {}, subject: 'user', invocationId: 'i1' });
    expect(!unknown.ok && unknown.error.code).toBe('IF-WRK-004');
    const call = await w.editor.request('call', { id: 'instaflow/mirror/nope', action: 'x', args: [] });
    expect(!call.ok && call.error.code).toBe('IF-WRK-003');
    if (topology === 'split') {
      const misrouted = await w.render.request('open', { page: 'p1', viewport: { width: 1, height: 1 } });
      expect(!misrouted.ok && misrouted.error.code).toBe('IF-WRK-002');
      const reattach = await w.render.request('attach', { deltas: {} as never, frames: {} as never });
      expect(!reattach.ok && reattach.error.code).toBe('IF-WRK-002');
    }
    const restart = await w.editor.request('start', { roles: ['editor'], media: w.plan.media, pacing: DEFAULT_SEQUENCING_SETTINGS.pacing });
    expect(!restart.ok && restart.error.code).toBe('IF-WRK-002');
    const metrics = unwrap(await w.render.request('metrics', undefined));
    expect(metrics.render?.draws).toBeGreaterThan(0);
    expect(metrics.render?.presented).toBeGreaterThan(0);
    await w.stop();
    expect(workers.hosts.every((h) => h.state === 'stopped')).toBe(true);
    await scope.dispose();
  });
});

describe('Studio worker boot failures (IF-WRK-001)', () => {
  it('names the step: a worker that cannot spawn, or an editor whose environment fails', async () => {
    const scope = createScope('boot-fail');
    const spawnFailed = await bootStudioWorkers({
      settings: DEFAULT_SEQUENCING_SETTINGS,
      spawn: () => () => err(WorkerBootError({ message: 'no workers here' })),
      editor: { document: { asset: 'as_x', title: 'X' }, person, isMac: false },
      store: { store: createMemoryDocumentStore(), blobs: createBlobStore(createMemoryObjectStore()) },
      signal: scope.signal,
    });
    expect(!spawnFailed.ok && [spawnFailed.error.code, spawnFailed.error.details['step']]).toEqual(['IF-WRK-001', 'spawn pipeline']);
    const workers = inProcessWorkers({ editor: async () => err(WorkerBootError({ message: 'no Wasm' })) });
    const { booted } = await boot('colocated', workers, 'as_fail');
    expect(!booted.ok && booted.error.code).toBe('IF-WRK-001');
    expect(!booted.ok && String(booted.error.details['step'])).toContain('start pipeline');
    expect(workers.hosts[0]?.state).toBe('stopped');
    await scope.dispose();
  });
});
