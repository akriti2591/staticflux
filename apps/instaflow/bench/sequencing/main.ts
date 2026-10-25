/**
 * Sequencing bench page (A7): the S2 latency + correctness run on the production modules.
 *
 * Real DOM events (synthetic, dispatched on the canvas inside main rAF like Chrome's rAF-aligned
 * input) → the real input forwarder → input ring → editor module → deltas + view frames → render
 * module → render port (`gfx=webgpu` instanced quads, or `none`). Every presented frame is checked
 * against the single-threaded oracle; latency is input → first presented frame (present = first
 * render tick at or after submit, the S2 estimate; a lower bound of photon latency).
 *
 * Query: topology=colocated|split · tick=worker-raf|main-raf · arrival=1|0 · coalesce=<ms> · latch=<ms> ·
 * gfx=webgpu|none · gestures=2000 · elements=10000 · pace=4 (ms between events) · seed=1
 *
 * Owner run (real GPU, see apps/instaflow/src/sequencing/AGENTS.md):
 *   pnpm build && pnpm --filter @instaflow/app bench:build
 *   pnpm gpu:run apps/instaflow/bench/sequencing/dist index.html --query='topology=split&tick=main-raf' --real-gpu --headed
 */
import { ok } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createInputForwarder, InputCode, InputModifier, type CompactInputEvent } from '@staticflux/surface';
import { inputRingSink } from '@staticflux/surface/input-ring';
import { checkPresentedFrames, generateSequencingScript, publishGpuResult } from '@staticflux/testkit';
import { fromWorker } from '@staticflux/worker';
import { bootSequencing } from '../../src/sequencing/boot.js';
import type { RenderPacing, TickDriver } from '../../src/sequencing/pacing.js';
import type { PresentedRecord } from '../../src/sequencing/render-module.js';
import { gridSceneSnapshot } from '../../src/sequencing/scene.js';
import { createSequencingReference, ORACLE_PEER, toPresentedFrame } from '../../src/sequencing/testing/oracle-subject.js';
import { DEFAULT_SEQUENCING_SETTINGS, type Topology } from '../../src/sequencing/topology.js';

const q = new URLSearchParams(location.search);
const tick = (q.get('tick') ?? 'worker-raf') as TickDriver;
const P = {
  topology: (q.get('topology') ?? 'colocated') as Topology,
  tick,
  arrival: q.get('arrival') !== '0',
  coalesce: Number(q.get('coalesce') ?? (tick === 'main-raf' ? 0 : 1)),
  latch: Number(q.get('latch') ?? (tick === 'main-raf' ? 4 : 0)),
  gfx: q.get('gfx') ?? 'webgpu',
  gestures: Number(q.get('gestures') ?? 2000),
  elements: Number(q.get('elements') ?? 10000),
  pace: Number(q.get('pace') ?? 4),
  seed: Number(q.get('seed') ?? 1),
};
const out = document.getElementById('out') as HTMLPreElement;
const say = (line: string): void => {
  out.textContent += `${line}\n`;
};
const absNow = (): number => performance.timeOrigin + performance.now();
const pct = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return Number((sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] as number).toFixed(2));
};
const stats = (values: readonly number[]) => ({ n: values.length, median: pct(values, 0.5), p95: pct(values, 0.95), p99: pct(values, 0.99), max: pct(values, 1) });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

async function run(): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const engine = createLoroEngine();
  const scene = gridSceneSnapshot(engine, { elements: P.elements }, ORACLE_PEER);
  if (!scene.ok) throw scene.error;
  const reference = createSequencingReference({ engine, scene: scene.value });
  const script = generateSequencingScript(reference as never, { gestures: P.gestures, seed: P.seed });
  reference.dispose();
  const M = script.events.length;
  say(`params ${JSON.stringify(P)}\nscript: ${P.gestures} gestures, ${M} inputs, ${script.remote.length} remote edits, oracle ${(performance.now() - t0).toFixed(0)} ms`);

  const canvas = document.getElementById('surface') as HTMLCanvasElement;
  const offscreen = P.gfx === 'webgpu' ? canvas.transferControlToOffscreen() : undefined;
  const pacing: RenderPacing = { arrival: P.arrival, coalesceMs: P.coalesce, tick: P.tick, latchMs: P.latch };
  const booted = await bootSequencing({
    settings: { ...DEFAULT_SEQUENCING_SETTINGS, topology: P.topology, pacing, renderPort: P.gfx },
    spawn: (plan) => () => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: plan.name });
      if (offscreen !== undefined && plan.roles.includes('render')) worker.postMessage({ benchCanvas: offscreen }, [offscreen]);
      return ok({ port: fromWorker(worker), terminate: () => worker.terminate() });
    },
    scene: scene.value,
    peer: ORACLE_PEER,
    isolation: { crossOriginIsolated: globalThis.crossOriginIsolated === true },
    remote: script.remote as never,
    record: true,
  });
  if (!booted.ok) throw booted.error;
  const session = booted.value;
  say(`booted: ${JSON.stringify(session.plan)}`);
  const forwarder = createInputForwarder({ target: canvas, env: { now: () => performance.now(), timeOrigin: performance.timeOrigin }, sinks: [inputRingSink(session.input)], captureWheel: true });
  await sleep(1500); // pipeline compile and first frames (S1: cold first frame ≈ 1 s)

  // Drive the script inside main rAF (Chrome rAF-aligns pointermove and wheel).
  const rect = canvas.getBoundingClientRect();
  const tIn = new Float64Array(M + 1);
  const mainRaf: number[] = [];
  const dispatch = (event: CompactInputEvent, index: number): void => {
    const init = { clientX: event.x + rect.left, clientY: event.y + rect.top, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, shiftKey: (event.m & InputModifier.shift) !== 0, altKey: (event.m & InputModifier.alt) !== 0, ctrlKey: (event.m & InputModifier.ctrl) !== 0 };
    tIn[index + 1] = absNow();
    switch (event.t) {
      case InputCode.pointerDown:
        canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
        return;
      case InputCode.pointerMove:
        canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 1 }));
        return;
      case InputCode.pointerUp:
        canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
        return;
      case InputCode.wheel:
        canvas.dispatchEvent(new WheelEvent('wheel', { ...init, deltaX: event.dx ?? 0, deltaY: event.dy ?? 0, deltaMode: 0 }));
        return;
      default:
        canvas.dispatchEvent(new KeyboardEvent('keydown', { key: event.key ?? '', code: event.code ?? '', bubbles: true, cancelable: true, shiftKey: init.shiftKey }));
    }
  };
  const start = performance.now();
  let i = 0;
  while (i < M) {
    const ts = await frame();
    mainRaf.push(performance.timeOrigin + ts);
    const now = performance.now();
    while (i < M && start + i * P.pace <= now) dispatch(script.events[i] as CompactInputEvent, i++);
    await Promise.resolve(); // the forwarder flushes on a microtask: tick after the input is in the ring
    session.tick.pulse(performance.timeOrigin + ts, forwarder.forwarded);
  }
  const driveMs = performance.now() - start;
  // Keep ticking until the last input is on screen.
  let presented: readonly PresentedRecord[] = [];
  let finals = await session.finish();
  for (let k = 0; k < 200; k++) {
    const ts = await frame();
    session.tick.pulse(performance.timeOrigin + ts, forwarder.forwarded);
    if (k % 10 !== 9) continue;
    finals = await session.finish();
    if (!finals.ok) break;
    presented = finals.value.workers.find((w) => w.presented !== undefined)?.presented ?? [];
    const last = presented[presented.length - 1];
    if (last !== undefined && last.inputSeq >= M && last.presented > 0) break;
  }
  if (!finals.ok) throw finals.error;
  const editor = finals.value.workers.find((w) => w.editor !== undefined)?.editor;
  const render = finals.value.workers.find((w) => w.render !== undefined)?.render;
  if (editor === undefined || render === undefined) throw new Error('missing module finals');
  const check = checkPresentedFrames(script, presented.map(toPresentedFrame) as never, {
    editor: { committedDigest: editor.committedDigest, docVersion: editor.docVersion, commits: editor.commits, cancels: editor.cancels, errors: editor.errors },
    render: { committedDigest: render.committedDigest, docVersion: render.docVersion, resnapshots: render.resnapshots, gaps: render.gaps, tornReads: render.tornReads, orderViolations: render.orderViolations },
    droppedDeltas: editor.stats.droppedDeltas,
  });

  // Latency: each input → first presented frame that consumed it.
  const all: number[] = [];
  const submit: number[] = [];
  const byKind: Record<string, number[]> = { pan: [], zoom: [], pointer: [], key: [] };
  let j = 0;
  for (let s = 1; s <= M; s++) {
    while (j < presented.length && (presented[j] as PresentedRecord).inputSeq < s) j++;
    const entry = presented[j];
    if (entry === undefined || entry.presented === 0) continue;
    const event = script.events[s - 1] as CompactInputEvent;
    const latency = entry.presented - (tIn[s] as number);
    all.push(latency);
    submit.push(entry.submitted - (tIn[s] as number));
    const kind = event.t === InputCode.wheel ? ((event.m & InputModifier.ctrl) !== 0 ? 'zoom' : 'pan') : event.t === InputCode.keyDown ? 'key' : 'pointer';
    (byKind[kind] as number[]).push(latency);
  }
  const intervals = mainRaf.slice(1).map((t, k) => t - (mainRaf[k] as number));
  const frameMs = pct(intervals, 0.5) ?? 16.67;
  const inputToPresent = stats(all);
  const result = {
    params: P,
    plan: session.plan,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    records: M,
    forwarded: forwarder.forwarded,
    gestures: script.gestures,
    scriptStats: script.stats,
    correctness: { ...check, editor: editor.stats, render: render.stats },
    latency: {
      mainRafIntervalMs: stats(intervals),
      budgetMs: Number((frameMs + 4).toFixed(2)),
      inputToPresentEst: inputToPresent,
      inputToPresentFrames: inputToPresent.median === null || inputToPresent.p95 === null ? null : { median: Number((inputToPresent.median / frameMs).toFixed(2)), p95: Number((inputToPresent.p95 / frameMs).toFixed(2)) },
      byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, stats(v)])),
      inputToSubmit: stats(submit),
      drawCpuMs: stats(presented.map((e) => e.submitted - e.drawStart)),
      p95WithinBudget: inputToPresent.p95 !== null && inputToPresent.p95 <= frameMs + 4,
    },
    driveMs,
    ua: navigator.userAgent,
  };
  forwarder.dispose();
  await session.stop();
  return result;
}

run().then(
  (result) => {
    const summary = { pass: (result['correctness'] as { pass: boolean }).pass, latency: result['latency'] };
    say(JSON.stringify(summary, null, 1));
    say(`\nfull result JSON:\n${JSON.stringify(result, null, 1)}`);
    publishGpuResult({ ok: true, data: result });
  },
  (error: unknown) => {
    say(`ERROR ${String((error as Error)?.stack ?? error)}`);
    publishGpuResult({ ok: false, error: { message: String((error as Error)?.message ?? error) } });
  },
);
