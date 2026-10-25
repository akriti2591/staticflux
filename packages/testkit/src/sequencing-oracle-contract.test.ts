// @vitest-environment node
/**
 * The sequencing oracle suite against a toy subject (no app code): a tiny reducer over dots on a grid
 * as the reference, and a "pipeline" that replays it asynchronously and presents frames at random.
 * A faulty pipeline (stale frames) must fail the suite.
 */
import { InputCode, InputModifier, type CompactInputEvent } from '@staticflux/surface';
import { describe, expect, it } from 'vitest';
import {
  checkPresentedFrames,
  driveSequencingScript,
  generateSequencingScript,
  type PresentedFrame,
  runSequencingOracleContract,
  SEQUENCING_GESTURE_MIX,
  SEQUENCING_GESTURES,
  type SequencingConfig,
  sequencingOracleCases,
  type SequencingPipelineUnderTest,
  sequencingRandom,
  type SequencingReference,
  type SequencingSubject,
} from './sequencing-oracle-contract.js';

const N = 400;
const SIZE = 40;
const PITCH = 60;
const mix = (a: number, b: number, c: number): number => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  return Math.imul(h, 0x2c1b3c6d) >>> 0;
};

type Remote = { readonly kind: 'move' | 'delete'; readonly slot: number; readonly dx: number; readonly dy: number };

/** Toy editor: dots on a 20-column grid; groups of 100; same gesture semantics the suite scripts. */
function toyReference(): SequencingReference & { docVersion: number } {
  const x = Int32Array.from({ length: N }, (_, i) => (i % 20) * PITCH);
  const y = Int32Array.from({ length: N }, (_, i) => Math.floor(i / 20) * PITCH);
  const alive = new Uint8Array(N).fill(1);
  const cam = { tx: 40, ty: 40, z: 1 };
  let selection: number[] = [];
  let gesture: { targets: number[]; ox: number; oy: number; dx: number; dy: number } | { marquee: number[]; ox: number; oy: number } | undefined;
  let gid = 0;
  const final = { docVersion: 0, commits: 0, cancels: 0, errors: 0 };
  const hit = (sx: number, sy: number): number => {
    const px = (sx - cam.tx) / cam.z;
    const py = (sy - cam.ty) / cam.z;
    for (let i = N - 1; i >= 0; i--) if (alive[i] === 1 && px >= (x[i] as number) && px < (x[i] as number) + SIZE && py >= (y[i] as number) && py < (y[i] as number) + SIZE) return i;
    return -1;
  };
  const commit = (ids: readonly number[], dx: number, dy: number): void => {
    for (const i of ids) {
      x[i] = (x[i] as number) + dx;
      y[i] = (y[i] as number) + dy;
    }
    final.commits += 1;
    final.docVersion += 1;
  };
  const committed = (): number => {
    let h = 0;
    for (let i = 0; i < N; i++) if (alive[i] === 1) h = (h + mix(i, x[i] as number, y[i] as number)) >>> 0;
    return h;
  };
  return {
    get docVersion() {
      return final.docVersion;
    },
    input(e: CompactInputEvent) {
      const px = (e.x - cam.tx) / cam.z;
      const py = (e.y - cam.ty) / cam.z;
      if (e.t === InputCode.wheel) {
        if ((e.m & InputModifier.ctrl) !== 0) {
          const z1 = Math.min(4, Math.max(0.25, cam.z * Math.exp(-(e.dy ?? 0) * 0.01)));
          cam.tx = e.x - (e.x - cam.tx) * (z1 / cam.z);
          cam.ty = e.y - (e.y - cam.ty) * (z1 / cam.z);
          cam.z = z1;
        } else {
          cam.tx -= e.dx ?? 0;
          cam.ty -= e.dy ?? 0;
        }
      } else if (e.t === InputCode.pointerDown) {
        gid += 1;
        const h = hit(e.x, e.y);
        if (h < 0) {
          gesture = { marquee: [px, py, px, py].map(Math.round), ox: px, oy: py };
          selection = [];
        } else {
          const targets = (e.m & InputModifier.alt) !== 0 ? Array.from({ length: 100 }, (_, k) => Math.floor(h / 100) * 100 + k).filter((i) => alive[i] === 1) : [h];
          selection = targets.slice();
          gesture = { targets, ox: px, oy: py, dx: 0, dy: 0 };
        }
      } else if (e.t === InputCode.pointerMove && gesture !== undefined) {
        if ('targets' in gesture) {
          gesture.dx = Math.round(px - gesture.ox);
          gesture.dy = Math.round(py - gesture.oy);
        } else {
          gesture.marquee = [Math.min(gesture.ox, px), Math.min(gesture.oy, py), Math.max(gesture.ox, px), Math.max(gesture.oy, py)].map(Math.round);
          const [x0, y0, x1, y1] = gesture.marquee as [number, number, number, number];
          selection = [];
          for (let i = 0; i < N; i++) if (alive[i] === 1 && (x[i] as number) < x1 && (x[i] as number) + SIZE > x0 && (y[i] as number) < y1 && (y[i] as number) + SIZE > y0) selection.push(i);
        }
      } else if (e.t === InputCode.pointerUp && gesture !== undefined) {
        const g = gesture;
        gesture = undefined;
        if ('targets' in g && (g.dx !== 0 || g.dy !== 0)) commit(g.targets, g.dx, g.dy);
      } else if (e.t === InputCode.keyDown) {
        if (e.key === 'Escape') {
          if (gesture !== undefined) final.cancels += 1;
          gesture = undefined;
          return;
        }
        const s = (e.m & InputModifier.shift) !== 0 ? 10 : 1;
        const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key ?? ''];
        if (d !== undefined && gesture === undefined && selection.length > 0) commit(selection, d[0] as number, d[1] as number);
      }
    },
    remote(update) {
      const r = update as Remote;
      final.docVersion += 1;
      if (r.kind === 'move') {
        x[r.slot] = (x[r.slot] as number) + r.dx;
        y[r.slot] = (y[r.slot] as number) + r.dy;
        return;
      }
      alive[r.slot] = 0;
      selection = selection.filter((s) => s !== r.slot);
      if (gesture !== undefined && 'targets' in gesture && gesture.targets.includes(r.slot)) {
        gesture = undefined;
        final.cancels += 1;
        final.errors += 1;
      }
    },
    display() {
      let h = committed();
      if (gesture !== undefined && 'targets' in gesture) for (const i of gesture.targets) h = (h - mix(i, x[i] as number, y[i] as number) + mix(i, (x[i] as number) + gesture.dx, (y[i] as number) + gesture.dy)) >>> 0;
      for (const s of selection) h = (h + mix(s, 7, 7)) >>> 0;
      if (gesture !== undefined && 'marquee' in gesture) h = (h + mix(gesture.marquee[0] as number, gesture.marquee[1] as number, (gesture.marquee[2] as number) ^ (gesture.marquee[3] as number))) >>> 0;
      return { digest: h, camera: [cam.tx, cam.ty, cam.z] };
    },
    probe: (sx, sy) => hit(sx, sy) >= 0,
    dragTargets: () => (gesture !== undefined && 'targets' in gesture ? gesture.targets : []),
    makeRemote({ kind, target, dx, dy, random }) {
      const slot = target ?? Math.floor(random() * N);
      return alive[slot] === 1 ? ({ kind, slot, dx, dy } satisfies Remote) : undefined;
    },
    zoom: () => cam.z,
    contentCenter: () => [600, 600],
    final: () => ({ committedDigest: committed(), ...final }),
    dispose: () => undefined,
  };
}

/** A toy pipeline: replays the reference asynchronously; `stale` presents the previous display sometimes. */
function toyPipeline(remote: readonly { after: number; update: unknown }[], fault: 'none' | 'stale'): SequencingPipelineUnderTest {
  const editor = toyReference();
  const frames: PresentedFrame[] = [];
  const queue: CompactInputEvent[] = [];
  let consumed = 0;
  let viewSeq = 0;
  let next = 0;
  const applyRemotes = (): void => {
    while (next < remote.length && (remote[next] as { after: number }).after <= consumed) editor.remote((remote[next++] as { update: unknown }).update);
  };
  applyRemotes();
  let previous = editor.display();
  const present = (): void => {
    const shown = editor.display();
    const bad = fault === 'stale' && viewSeq % 7 === 3;
    viewSeq += 1;
    frames.push({ viewSeq, inputSeq: consumed, docVersion: editor.docVersion, frameDocVersion: editor.docVersion, gestureId: 0, digest: (bad ? previous : shown).digest, camera: shown.camera, overlayAfterCommit: false });
    previous = shown;
  };
  present();
  const pump = (): void => {
    const n = Math.min(queue.length, 3);
    for (const event of queue.splice(0, n)) {
      editor.input(event);
      consumed += 1;
      applyRemotes();
    }
    if (n > 0) present();
    if (queue.length > 0) setImmediate(pump);
  };
  return {
    push(batch) {
      queue.push(...batch);
      setImmediate(pump);
    },
    vsync: () => undefined,
    async settled(inputs, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while ((frames.at(-1)?.inputSeq ?? -1) < inputs && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
      return (frames.at(-1)?.inputSeq ?? -1) >= inputs;
    },
    presented: () => frames,
    async finish() {
      const f = editor.final();
      return { editor: f, render: { committedDigest: f.committedDigest, docVersion: f.docVersion, resnapshots: 0, gaps: 0, tornReads: 0, orderViolations: 0 }, droppedDeltas: 0 };
    },
    dispose: async () => undefined,
  };
}

const subject = (fault: 'none' | 'stale'): SequencingSubject => ({
  reference: toyReference,
  boot: async ({ remote }) => toyPipeline(remote, fault),
});

const config: SequencingConfig = { name: 'toy', topology: 'colocated', medium: 'local', inputMedium: 'local' };

describe('sequencingRandom / generateSequencingScript', () => {
  it('is deterministic per seed and records one display per input (plus the initial one)', () => {
    const a = sequencingRandom(5);
    const b = sequencingRandom(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(sequencingRandom(0)()).toBe(sequencingRandom(1)()); // seed 0 is coerced to 1
    const s1 = generateSequencingScript(toyReference(), { gestures: 300, seed: 3 });
    const s2 = generateSequencingScript(toyReference(), { gestures: 300, seed: 3 });
    expect(s1.events).toEqual(s2.events);
    expect(s1.displays).toHaveLength(s1.events.length + 1);
    expect(SEQUENCING_GESTURES.every((g) => s1.gestures[g] > 0)).toBe(true);
    expect(Object.values(SEQUENCING_GESTURE_MIX).reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    expect(s1.stats.remoteMoves).toBeGreaterThan(0);
    expect(s1.remote.every((r, i) => i === 0 || r.after >= (s1.remote[i - 1] as { after: number }).after)).toBe(true);
  });
});

describe('driveSequencingScript / checkPresentedFrames', () => {
  it('a correct pipeline passes, a stale one is caught', async () => {
    const script = generateSequencingScript(toyReference(), { gestures: 200, seed: 9 });
    for (const [fault, pass] of [
      ['none', true],
      ['stale', false],
    ] as const) {
      const pipeline = toyPipeline(script.remote, fault);
      expect(await driveSequencingScript(pipeline, script, { seed: 9, timeoutMs: 10_000 })).toBe(true);
      const check = checkPresentedFrames(script, pipeline.presented(), await pipeline.finish());
      expect(check.pass).toBe(pass);
      if (!pass) expect(check.framesNotEqualOracle).toBeGreaterThan(0);
    }
  });
});

describe('sequencingOracleCases', () => {
  it('builds the checker case, one replay per config and the fault cases', () => {
    const cases = sequencingOracleCases({ configs: [config, { ...config, name: 'two' }] });
    expect(cases.map((c) => c.name)).toEqual([
      expect.stringContaining('checker'),
      expect.stringContaining('toy'),
      expect.stringContaining('two'),
      expect.stringContaining('every 25th delta lost'),
    ]);
    expect(sequencingOracleCases({ configs: [config], faultConfigs: [] })).toHaveLength(2);
  });
  it('a faulty subject fails the replay case', async () => {
    const [, replay] = sequencingOracleCases({ configs: [config], faultConfigs: [], gestures: 150 });
    await expect(replay?.run(subject('stale'))).rejects.toThrow(/equal the oracle/);
  });
});

runSequencingOracleContract('toy subject', subject('none'), { describe, it: (name, fn) => it(name, fn, 60_000) }, { gestures: 300, configs: [config], faultConfigs: [], skip: [] });
