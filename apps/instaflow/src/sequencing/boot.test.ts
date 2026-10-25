// @vitest-environment node
import { err, type SfError } from '@staticflux/core';
import { encodeInputRecord } from '@staticflux/surface/input-ring';
import { createLink, createPortPair, createProtocolClient, inMemorySpawner, SpawnFailedError } from '@staticflux/worker';
import { describe, expect, it } from 'vitest';
import { bootSequencing, type SequencingSession } from './boot.js';
import { SequencingControl, type StartArgs } from './control.js';
import { createDigestRenderer } from './digest-renderer.js';
import { hostSequencingWorker, type SequencingWorkerHost } from './host.js';
import { MAIN_TICK_PACING } from './pacing.js';
import { DEFAULT_SEQUENCING_SETTINGS, planSequencing, type SequencingSettings } from './topology.js';
import { down, engine, move, smallScene, up } from './test-helpers.js';

const scene = smallScene(100);
const settings: SequencingSettings = { ...DEFAULT_SEQUENCING_SETTINGS, renderPort: 'digest', pacing: { ...DEFAULT_SEQUENCING_SETTINGS.pacing, coalesceMs: 0 } };
const renderPorts = { digest: () => createDigestRenderer() };

async function boot(topology: 'colocated' | 'split', media: { input: 'shared' | 'message'; modules: 'local' | 'shared' | 'message' }) {
  const hosts: SequencingWorkerHost[] = [];
  const names: string[] = [];
  const booted = await bootSequencing({
    settings: { ...settings, topology },
    spawn: (worker) => {
      names.push(worker.name);
      return inMemorySpawner((port) => void hosts.push(hostSequencingWorker({ port, engine, renderPorts })), { clone: false });
    },
    scene,
    peer: '7',
    media: { ...media, tick: media.input },
    record: true,
  });
  if (!booted.ok) throw booted.error;
  return { session: booted.value, hosts, names };
}

async function drawAll(session: SequencingSession, hosts: readonly SequencingWorkerHost[], events: Parameters<typeof encodeInputRecord>[1][]): Promise<number> {
  for (const event of events) session.input.push((record) => encodeInputRecord(record, event, 1));
  const render = () => hosts.find((h) => h.render !== undefined)?.render;
  for (let i = 0; i < 200 && (render()?.presented.at(-1)?.inputSeq ?? -1) < events.length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  return render()?.presented.at(-1)?.inputSeq ?? -1;
}

describe('bootSequencing', () => {
  it('colocated (D15 default): one worker hosts both modules and frames reach the render port', async () => {
    const { session, hosts, names } = await boot('colocated', { input: 'shared', modules: 'local' });
    expect(names).toEqual(['pipeline']);
    expect(session.plan.media.modules).toBe('local');
    expect(hosts[0]?.editor).toBeDefined();
    expect(hosts[0]?.render).toBeDefined();
    expect(await drawAll(session, hosts, [down(50, 50), move(60, 60), up(60, 60)])).toBe(3);
    const finals = await session.finish();
    if (!finals.ok) throw finals.error;
    const [only] = finals.value.workers;
    expect(only?.name).toBe('pipeline');
    expect(only?.editor).toMatchObject({ commits: 1, docVersion: 1 });
    expect(only?.render).toMatchObject({ docVersion: 1, committedDigest: only?.editor?.committedDigest });
    expect(only?.presented?.length).toBeGreaterThan(0);
    await session.stop();
  });

  it.each([
    ['shared', 'shared'],
    ['message', 'message'],
  ] as const)('split: two workers, %s pipes relayed through main', async (input, modules) => {
    const { session, hosts, names } = await boot('split', { input, modules });
    expect(names).toEqual(['editor', 'render']);
    expect(hosts[0]?.render).toBeUndefined();
    expect(hosts[1]?.editor).toBeUndefined();
    expect(await drawAll(session, hosts, [down(50, 50), move(70, 50), up(70, 50)])).toBe(3);
    const finals = await session.finish();
    if (!finals.ok) throw finals.error;
    expect(finals.value.workers.map((w) => [w.name, w.editor !== undefined, w.render !== undefined])).toEqual([
      ['editor', true, false],
      ['render', false, true],
    ]);
    await session.stop();
  });

  it('fails with IF-SEQ-001 naming the step when a worker cannot spawn or start', async () => {
    const spawnFailed = await bootSequencing({ settings, spawn: () => () => err(SpawnFailedError()), scene, peer: '7' });
    expect(!spawnFailed.ok && [spawnFailed.error.code, spawnFailed.error.details['step']]).toEqual(['IF-SEQ-001', 'spawn pipeline']);
    const noPort = await bootSequencing({
      settings: { ...settings, renderPort: 'vello' },
      spawn: () => inMemorySpawner((port) => void hostSequencingWorker({ port, engine, renderPorts }), { clone: false }),
      scene,
      peer: '7',
      media: { input: 'shared', modules: 'local', tick: 'shared' },
    });
    expect(!noPort.ok && noPort.error.code).toBe('IF-SEQ-001');
    expect(!noPort.ok && (noPort.error.cause as { code?: string }).code).toBe('IF-SEQ-003');
    expect(!noPort.ok && noPort.error.message).toContain('IF-SEQ-003'); // the cause survives the link
    // A worker that never answers because its script failed: boot fails with the worker's error, not a timeout.
    const crashed = await bootSequencing({
      settings,
      spawn: () => () => {
        const pair = createPortPair({ clone: false });
        const port = { ...pair.a, onError: (listener: (error: SfError) => void) => (setTimeout(() => listener(SpawnFailedError({ message: 'worker script failed to load' })), 5), () => undefined) };
        return { ok: true, value: { port, terminate: () => pair.close() } } as const;
      },
      scene,
      peer: '7',
      media: { input: 'shared', modules: 'local', tick: 'shared' },
    });
    expect(!crashed.ok && crashed.error.message).toContain('worker script failed to load');
  });
});

describe('hostSequencingWorker', () => {
  function host() {
    const pair = createPortPair({ clone: false });
    const worker = hostSequencingWorker({ port: pair.b, engine, renderPorts });
    const client = createProtocolClient(createLink({ port: pair.a }), SequencingControl);
    const plan = planSequencing({ topology: 'colocated' }, { media: { input: 'shared', modules: 'local', tick: 'shared' } });
    const args = (extra: Partial<StartArgs> = {}): StartArgs => ({ roles: ['render'], settings, media: plan.media, scene, peer: '7', ...extra });
    return { worker, client, args };
  }

  it('rejects requests its roles or state do not allow (IF-SEQ-002)', async () => {
    const { worker, client, args } = host();
    const early = await client.request('attach', { frames: undefined as never, deltas: undefined as never });
    expect(!early.ok && early.error.code).toBe('IF-SEQ-002');
    expect((await client.request('start', args())).ok).toBe(true); // render-only: waits for attach
    const again = await client.request('start', args());
    expect(!again.ok && again.error.code).toBe('IF-SEQ-002');
    const finish = await client.request('finish', undefined);
    expect(finish.ok && finish.value).toEqual({});
    expect((await client.request('stop', undefined)).ok).toBe(true);
    worker.dispose();
  });

  it('reports a missing input ring, a broken scene and a missing main tick', async () => {
    const editor = host();
    const noInput = await editor.client.request('start', editor.args({ roles: ['editor'] }));
    expect(!noInput.ok && [noInput.error.code, noInput.error.details['step']]).toEqual(['IF-SEQ-001', 'input ring']);
    const broken = host();
    const badScene = await broken.client.request('start', broken.args({ scene: new Uint8Array([1, 2, 3]) }));
    expect(!badScene.ok && badScene.error.details['step']).toBe('open scene');
    const both = await bootSequencing({
      settings: { ...settings, pacing: MAIN_TICK_PACING },
      spawn: () => inMemorySpawner((port) => void hostSequencingWorker({ port, engine, renderPorts }), { clone: false }),
      scene,
      peer: '7',
      media: { input: 'shared', modules: 'local', tick: 'shared' },
    });
    expect(both.ok).toBe(true); // with the tick endpoint the main-rAF tick boots
    if (both.ok) await both.value.stop();
    const tickless = host();
    const missing = await tickless.client.request('start', tickless.args({ settings: { ...settings, pacing: MAIN_TICK_PACING }, roles: ['render'] }));
    expect(missing.ok).toBe(true); // render-only start defers to attach, where the tick is required
    editor.worker.dispose();
    broken.worker.dispose();
    tickless.worker.dispose();
  });
});
