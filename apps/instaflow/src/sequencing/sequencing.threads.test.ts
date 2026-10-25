// @vitest-environment node
/**
 * The oracle with real concurrency (Node worker_threads, SharedArrayBuffer + Atomics, MessagePorts):
 * the same boot code spawns one worker (colocated) or two (split); main pushes scripted input into
 * the input ring while the workers run free. No wall-clock assertions, only oracle equality.
 */
import { type SfError, toSfError, ok } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { encodeInputRecord } from '@staticflux/surface/input-ring';
import { runSequencingOracleContract, type SequencingPipelineUnderTest } from '@staticflux/testkit';
import type { Port } from '@staticflux/worker';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, it } from 'vitest';
import { bootSequencing } from './boot.js';
import type { ScheduledRemoteUpdate } from './control.js';
import { MAIN_TICK_PACING, type RenderPacing } from './pacing.js';
import type { PresentedRecord } from './render-module.js';
import { gridSceneSnapshot } from './scene.js';
import { createSequencingReference, ORACLE_PEER, type SubjectConfig, toPresentedFrame } from './testing/oracle-subject.js';
import { DEFAULT_SEQUENCING_SETTINGS } from './topology.js';

// Built with node:path: Vite rewrites the literal `new URL('…', import.meta.url)` pattern as an asset.
const fixture = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'threads', 'sequencing-worker.mjs'));

function nodeWorkerPort(worker: Worker): Port {
  const messages = new Set<(data: unknown) => void>();
  const errors = new Set<(error: SfError) => void>();
  const closes = new Set<() => void>();
  let closed = false;
  worker.on('message', (data: unknown) => {
    for (const listener of [...messages]) listener(data);
  });
  worker.on('error', (error: unknown) => {
    for (const listener of [...errors]) listener(toSfError(error));
  });
  const port: Port = {
    postMessage: (message, transfer = []) => {
      if (!closed) worker.postMessage(message, [...transfer] as never);
    },
    onMessage: (listener) => {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onError: (listener) => {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    onClose: (listener) => {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const listener of [...closes]) listener();
    },
  };
  worker.on('exit', () => port.close());
  return port;
}

const engine = createLoroEngine();
const scene = gridSceneSnapshot(engine, { elements: 2_000 }, ORACLE_PEER);
if (!scene.ok) throw scene.error;
const sceneBytes = scene.value;

async function bootThreads(config: SubjectConfig, remote: readonly ScheduledRemoteUpdate[]): Promise<SequencingPipelineUnderTest> {
  const workers: Worker[] = [];
  const pacing = (config.options?.['pacing'] as RenderPacing | undefined) ?? DEFAULT_SEQUENCING_SETTINGS.pacing;
  const booted = await bootSequencing({
    settings: { ...DEFAULT_SEQUENCING_SETTINGS, topology: config.topology, pacing, renderPort: 'oracle' },
    spawn: () => () => {
      const worker = new Worker(fixture);
      workers.push(worker);
      return ok({ port: nodeWorkerPort(worker), terminate: () => void worker.terminate() });
    },
    scene: sceneBytes,
    peer: ORACLE_PEER,
    media: { input: config.inputMedium, modules: config.medium, tick: config.inputMedium },
    remote,
    ...(config.dropDeltaEvery === undefined ? {} : { dropDeltaEvery: config.dropDeltaEvery }),
    record: true,
  });
  if (!booted.ok) throw booted.error;
  const session = booted.value;
  let batch = 0;
  let pushed = 0;
  let time = 0;
  let presented: PresentedRecord[] = [];
  const final = async () => {
    const finals = await session.finish();
    if (!finals.ok) throw finals.error;
    presented = [...(finals.value.workers.find((w) => w.presented !== undefined)?.presented ?? [])];
    return finals.value;
  };
  return {
    push(events) {
      batch += 1;
      for (const event of events) {
        const written = session.input.push((record) => encodeInputRecord(record, event, batch));
        if (!written.ok) throw written.error;
      }
      pushed += events.length;
    },
    vsync() {
      time += 16;
      session.tick.pulse(time, pushed);
    },
    async settled(inputs, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      do {
        await final();
        if ((presented[presented.length - 1]?.inputSeq ?? -1) >= inputs) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      return false;
    },
    presented: () => presented.map(toPresentedFrame),
    async finish() {
      const finals = await final();
      const editor = finals.workers.find((w) => w.editor !== undefined)?.editor;
      const render = finals.workers.find((w) => w.render !== undefined)?.render;
      if (editor === undefined || render === undefined) throw new Error('missing module finals');
      return {
        editor: { committedDigest: editor.committedDigest, docVersion: editor.docVersion, commits: editor.commits, cancels: editor.cancels, errors: editor.errors },
        render: { committedDigest: render.committedDigest, docVersion: render.docVersion, resnapshots: render.resnapshots, gaps: render.gaps, tornReads: render.tornReads, orderViolations: render.orderViolations },
        droppedDeltas: editor.stats.droppedDeltas,
      };
    },
    async dispose() {
      await session.stop();
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}

const subject = {
  reference: () => createSequencingReference({ engine, scene: sceneBytes }),
  boot: ({ config, remote }: { config: SubjectConfig; remote: readonly { after: number; update: unknown }[] }) => bootThreads(config, remote as readonly ScheduledRemoteUpdate[]),
};

runSequencingOracleContract('worker_threads', subject as never, { describe, it: (name, fn) => it(name, fn, 240_000) }, {
  gestures: 1_000,
  seed: 2,
  configs: [
    { name: 'one real worker, shared input ring', topology: 'colocated', medium: 'local', inputMedium: 'shared' },
    { name: 'two real workers, shared pipes', topology: 'split', medium: 'shared', inputMedium: 'shared' },
    { name: 'two real workers, message pipes', topology: 'split', medium: 'message', inputMedium: 'message' },
    { name: 'two real workers, shared pipes, main-rAF tick', topology: 'split', medium: 'shared', inputMedium: 'shared', options: { pacing: MAIN_TICK_PACING } },
  ],
  faultConfigs: [{ name: 'two real workers (shared), every 25th delta lost', topology: 'split', medium: 'shared', inputMedium: 'shared', dropDeltaEvery: 25 }],
});
