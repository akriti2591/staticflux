/**
 * Sequencing oracle contract (IF-7.3, D15; the S2 spike's oracle as a shared suite).
 *
 * An editor ↔ render pipeline is correct when **every frame it presents equals what a
 * single-threaded reference shows after consuming exactly the same inputs**. The suite:
 *
 * 1. drives the subject's **reference** (the same editor reducer, no threads, no pipes)
 *    with scripted gestures G-1…G-6 — pan, zoom, drag one, drag a group of 100, marquee,
 *    nudge — plus simulated remote edits (moves and deletes, some on a target mid-drag)
 *    and Esc cancels, recording the display digest and camera after every input;
 * 2. boots the **pipeline under test** for each configuration (topology × pipe medium),
 *    pushes the same inputs through its input ring in random bursts with display vsyncs in
 *    between, and collects every frame the render module presented;
 * 3. checks: each presented frame equals the reference at the input it consumed (no
 *    snap-back, no double draw, no torn read), the camera equals the reference camera,
 *    generations are monotonic (`viewSeq` strictly, `inputSeq` and `docVersion` never
 *    back), the last frame shows the final display, and the final editor and render
 *    states equal the reference (commits, cancels, typed errors, docVersion).
 *
 * Remote edits are scheduled "after input n": the pipeline applies them right after its
 * editor consumed input n and before input n + 1, so the expected display stays a pure
 * function of `inputSeq`. Element keys and remote update payloads are opaque to the suite.
 *
 * @example
 * runSequencingOracleContract(subject, { describe, it: (n, fn) => it(n, fn, 120_000) }, {
 *   gestures: 2_000,
 *   configs: [{ name: 'one worker', topology: 'colocated', medium: 'local', inputMedium: 'shared' }],
 * });
 */
import { InputCode, InputModifier, type CompactInputEvent } from '@staticflux/surface';
import type { PipeMedium } from '@staticflux/worker/pipeline';
import { assertEqual, assertTrue, type ContractRunner, within } from './contract-runner.js';

export const SEQUENCING_GESTURES = ['G1-pan', 'G2-zoom', 'G3-drag-one', 'G4-drag-100', 'G5-marquee', 'G6-nudge'] as const;
export type SequencingGesture = (typeof SEQUENCING_GESTURES)[number];
/** Gesture mix of the S2 runs (sums to 1). */
export const SEQUENCING_GESTURE_MIX: Readonly<Record<SequencingGesture, number>> = {
  'G1-pan': 0.18,
  'G2-zoom': 0.14,
  'G3-drag-one': 0.26,
  'G4-drag-100': 0.1,
  'G5-marquee': 0.12,
  'G6-nudge': 0.2,
};

/** What a display shows: a digest of the drawn scene (committed + overlay + selection + marquee) and the camera. */
export interface OracleDisplay {
  readonly digest: number;
  /** `[tx, ty, zoom]`: screen = document × zoom + t. */
  readonly camera: readonly [number, number, number];
}

export interface SequencingFinal {
  /** Digest of the committed scene (no overlays, no view state). */
  readonly committedDigest: number;
  readonly docVersion: number;
  /** Local transactions (one per gesture or nudge). */
  readonly commits: number;
  /** Gestures cancelled (Esc or a remote delete of a target). */
  readonly cancels: number;
  /** Typed errors raised (IF-ENG-001 for a target deleted mid-gesture). */
  readonly errors: number;
}

export interface RemoteEditRequest {
  readonly kind: 'move' | 'delete';
  /** Element key to edit (an active drag target); omitted = a random live element. */
  readonly target?: number;
  readonly dx: number;
  readonly dy: number;
  readonly random: () => number;
}

/** The single-threaded reference: the subject's editor reducer applied in order, no threads. */
export interface SequencingReference {
  input(event: CompactInputEvent): void;
  /** Apply a remote update made by `makeRemote`. */
  remote(update: unknown): void;
  display(): OracleDisplay;
  /** True when the screen point hits an element with the current camera. */
  probe(x: number, y: number): boolean;
  /** Element keys of the active drag gesture (empty when no drag is active). */
  dragTargets(): readonly number[];
  /** A remote update against the committed state, structured-cloneable; undefined when impossible. */
  makeRemote(request: RemoteEditRequest): unknown;
  zoom(): number;
  /** Centre of the content in document units (pans drift towards it so gestures keep finding elements). */
  contentCenter(): readonly [number, number];
  final(): SequencingFinal;
  dispose(): void;
}

export interface RemoteScheduleEntry {
  /** Apply after this many input records were consumed (0 = before the first). */
  readonly after: number;
  readonly update: unknown;
}

export interface SequencingScript {
  readonly events: readonly CompactInputEvent[];
  readonly remote: readonly RemoteScheduleEntry[];
  /** `displays[n]` = what must be shown after consuming exactly n inputs (and their scheduled remotes). */
  readonly displays: readonly OracleDisplay[];
  readonly gestures: Readonly<Record<SequencingGesture, number>>;
  readonly stats: { readonly remoteMoves: number; readonly remoteDeletes: number; readonly remoteMidDrag: number; readonly escCancels: number; readonly missedTargets: number };
  readonly final: SequencingFinal;
}

export interface SequencingScriptOptions {
  readonly gestures: number;
  readonly seed?: number;
  /** Surface size in CSS px. Default 1280 × 720 (S2). */
  readonly view?: { readonly width: number; readonly height: number };
}

/** xorshift32 in [0, 1) (S2's generator; deterministic per seed). */
export function sequencingRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Generate G-1…G-6 against a reference, recording what every input must display. The reference ends in the final state. */
export function generateSequencingScript(reference: SequencingReference, options: SequencingScriptOptions): SequencingScript {
  const random = sequencingRandom(options.seed ?? 1);
  const ri = (a: number, b: number): number => a + Math.floor(random() * (b - a + 1));
  const sign = (): number => (random() < 0.5 ? -1 : 1);
  const width = options.view?.width ?? 1280;
  const height = options.view?.height ?? 720;
  const events: CompactInputEvent[] = [];
  const remote: RemoteScheduleEntry[] = [];
  const displays: OracleDisplay[] = [reference.display()];
  const gestures = Object.fromEntries(SEQUENCING_GESTURES.map((g) => [g, 0])) as Record<SequencingGesture, number>;
  const stats = { remoteMoves: 0, remoteDeletes: 0, remoteMidDrag: 0, escCancels: 0, missedTargets: 0 };
  let ts = 0;
  const push = (event: Omit<CompactInputEvent, 'ts'>): void => {
    ts += 4; // S2 pace: one event every 4 ms
    const full = { ...event, ts } as CompactInputEvent;
    reference.input(full);
    events.push(full);
    displays.push(reference.display());
  };
  const pushRemote = (request: Omit<RemoteEditRequest, 'random'>): boolean => {
    const update = reference.makeRemote({ ...request, random });
    if (update === undefined) return false;
    reference.remote(update);
    remote.push({ after: events.length, update });
    displays[events.length] = reference.display();
    return true;
  };
  const pointer = (t: InputCode, x: number, y: number, m: number): void => push({ t, x, y, b: t === InputCode.pointerUp ? 0 : 1, m, p: 1, k: 0 });
  const wheel = (x: number, y: number, dx: number, dy: number, m: number): void => push({ t: InputCode.wheel, x, y, b: 0, m, dx, dy });
  const key = (name: string, m = 0): void => push({ t: InputCode.keyDown, x: 0, y: 0, b: 0, m, key: name, code: name });
  const screenPoint = (): [number, number] => [ri(20, width - 20), ri(20, height - 20)];
  const find = (hit: boolean): [number, number] | undefined => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const [x, y] = screenPoint();
      if (reference.probe(x, y) === hit) return [x, y];
    }
    return undefined;
  };
  const [centerX, centerY] = reference.contentCenter();
  const pan = (n: number): void => {
    for (let i = 0; i < n; i++) {
      // S2: 70% of pans move the view centre towards the content centre.
      const [tx, ty, zoom] = reference.display().camera;
      const bx = (width / 2 - tx) / zoom < centerX ? 1 : -1;
      const by = (height / 2 - ty) / zoom < centerY ? 1 : -1;
      wheel(ri(0, width), ri(0, height), (random() < 0.7 ? bx : -bx) * ri(10, 120), (random() < 0.7 ? by : -by) * ri(10, 120), 0);
    }
  };
  const mix = SEQUENCING_GESTURES.map((g) => SEQUENCING_GESTURE_MIX[g]);
  for (let g = 0; g < options.gestures; g++) {
    let kind = 0;
    for (let u = random(), acc = 0; kind < mix.length - 1; kind++) {
      acc += mix[kind] as number;
      if (u < acc) break;
    }
    gestures[SEQUENCING_GESTURES[kind] as SequencingGesture] += 1;
    // A simulated CRDT peer between gestures.
    if (random() < 0.25 && pushRemote({ kind: 'move', dx: sign() * ri(1, 30), dy: sign() * ri(1, 30) })) stats.remoteMoves += 1;
    if (random() < 0.01 && pushRemote({ kind: 'delete', dx: 0, dy: 0 })) stats.remoteDeletes += 1;
    switch (kind) {
      case 0:
        pan(ri(3, 6));
        break;
      case 1: {
        const n = ri(2, 4);
        const x = ri(100, width - 100);
        const y = ri(100, height - 100);
        const z = reference.zoom();
        const direction = z > 2 ? 1 : z < 0.4 ? -1 : sign();
        for (let i = 0; i < n; i++) wheel(x, y, 0, direction * ri(20, 90), InputModifier.ctrl);
        break;
      }
      case 2:
      case 3: {
        const start = find(true);
        if (start === undefined) {
          stats.missedTargets += 1;
          pan(2);
          break;
        }
        let [x, y] = start;
        const m = kind === 3 ? InputModifier.alt : 0;
        pointer(InputCode.pointerDown, x, y, m);
        const n = ri(3, 8);
        for (let i = 0; i < n; i++) {
          x += ri(-40, 40);
          y += ri(-40, 40);
          pointer(InputCode.pointerMove, x, y, m);
          const targets = reference.dragTargets();
          if (targets.length > 0 && random() < 0.04) {
            const target = targets[ri(0, targets.length - 1)] as number;
            if (pushRemote({ kind: 'move', target, dx: sign() * ri(1, 20), dy: sign() * ri(1, 20) })) {
              stats.remoteMoves += 1;
              stats.remoteMidDrag += 1;
            }
          }
          const still = reference.dragTargets();
          if (still.length > 0 && random() < 0.004) {
            const target = still[ri(0, still.length - 1)] as number;
            if (pushRemote({ kind: 'delete', target, dx: 0, dy: 0 })) {
              stats.remoteDeletes += 1;
              stats.remoteMidDrag += 1;
            }
          }
        }
        if (reference.dragTargets().length > 0 && random() < 0.05) {
          key('Escape');
          stats.escCancels += 1;
        }
        pointer(InputCode.pointerUp, x, y, m);
        break;
      }
      case 4: {
        const start = find(false);
        if (start === undefined) {
          stats.missedTargets += 1;
          pan(2);
          break;
        }
        const [x0, y0] = start;
        pointer(InputCode.pointerDown, x0, y0, 0);
        const n = ri(3, 6);
        const reach = Math.min(240 * reference.zoom(), 300);
        const sx = sign();
        const sy = sign();
        let x = x0;
        let y = y0;
        for (let i = 1; i <= n; i++) {
          x = Math.round(x0 + (sx * reach * i) / n);
          y = Math.round(y0 + (sy * reach * 0.7 * i) / n);
          pointer(InputCode.pointerMove, x, y, 0);
        }
        pointer(InputCode.pointerUp, x, y, 0);
        break;
      }
      default: {
        const n = ri(1, 3);
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        for (let i = 0; i < n; i++) key(keys[ri(0, 3)] as string, random() < 0.3 ? InputModifier.shift : 0);
      }
    }
  }
  return { events, remote, displays, gestures, stats, final: reference.final() };
}

// ---------------------------------------------------------------- pipeline under test

export interface SequencingConfig {
  readonly name: string;
  /** D15 boot setting: both modules in one worker, or one worker each. */
  readonly topology: 'colocated' | 'split';
  /** Medium of the editor → render pipes (deltas, view frames). */
  readonly medium: PipeMedium;
  /** Medium of the main → editor input ring. */
  readonly inputMedium: PipeMedium;
  /** Fault injection: the editor loses every Nth delta (E-1: the render must resync from a snapshot). */
  readonly dropDeltaEvery?: number;
  /** Subject-specific settings (render pacing …), passed through. */
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface PresentedFrame {
  readonly viewSeq: number;
  /** Input records the frame's editor state consumed. */
  readonly inputSeq: number;
  /** Committed version the render module had applied when it drew. */
  readonly docVersion: number;
  /** The view frame's own docVersion. */
  readonly frameDocVersion: number;
  readonly gestureId: number;
  /** Digest of exactly what was drawn, computed on the render side. */
  readonly digest: number;
  readonly camera: readonly [number, number, number];
  /** The frame drew the overlay of a gesture whose commit was already applied (E-2 double-draw signature). */
  readonly overlayAfterCommit: boolean;
}

export interface SequencingRunFinal {
  readonly editor: SequencingFinal;
  readonly render: {
    readonly committedDigest: number;
    readonly docVersion: number;
    readonly resnapshots: number;
    readonly gaps: number;
    /** Seqlock torn reads accepted (must be 0). */
    readonly tornReads: number;
    /** Deltas applied out of order (must be 0). */
    readonly orderViolations: number;
  };
  /** Deltas the editor dropped by fault injection. */
  readonly droppedDeltas: number;
}

export interface SequencingPipelineUnderTest {
  /** Push one forwarder batch into the input ring. */
  push(batch: readonly CompactInputEvent[]): void;
  /** One display vsync (drives rAF-paced work and the main-thread tick). */
  vsync(): void;
  /** Resolve true once a presented frame consumed `inputs` records; false on timeout. */
  settled(inputs: number, timeoutMs: number): Promise<boolean>;
  presented(): readonly PresentedFrame[];
  finish(): Promise<SequencingRunFinal>;
  dispose(): Promise<void>;
}

export interface SequencingBootOptions {
  readonly config: SequencingConfig;
  readonly remote: readonly RemoteScheduleEntry[];
}

export interface SequencingSubject {
  /** A fresh reference (the same initial scene as `boot`). */
  reference(): SequencingReference;
  boot(options: SequencingBootOptions): Promise<SequencingPipelineUnderTest>;
}

// ---------------------------------------------------------------- checker

export interface SequencingCheck {
  readonly frames: number;
  readonly framesNotEqualOracle: number;
  readonly snapBackFrames: number;
  readonly doubleDrawFrames: number;
  readonly otherMismatch: number;
  readonly cameraMismatchFrames: number;
  readonly generationNonMonotonic: number;
  readonly overlayAfterCommit: number;
  readonly tornReads: number;
  readonly orderViolations: number;
  readonly lastFrameEqualsFinalDisplay: boolean;
  readonly finalEditorEqualsOracle: boolean;
  readonly finalRenderEqualsOracle: boolean;
  readonly firstBad: readonly { readonly frame: number; readonly inputSeq: number; readonly reason: string }[];
  readonly pass: boolean;
}

const sameCamera = (a: readonly number[], b: readonly number[]): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Check presented frames and final states against the script (pure; see the module header for the rules). */
export function checkPresentedFrames(script: SequencingScript, frames: readonly PresentedFrame[], final: SequencingRunFinal): SequencingCheck {
  let notEqual = 0;
  let snapBack = 0;
  let doubleDraw = 0;
  let other = 0;
  let camera = 0;
  let mono = 0;
  let overlay = 0;
  const firstBad: { frame: number; inputSeq: number; reason: string }[] = [];
  const bad = (frame: number, inputSeq: number, reason: string): void => {
    if (firstBad.length < 5) firstBad.push({ frame, inputSeq, reason });
  };
  frames.forEach((f, j) => {
    const prev = frames[j - 1];
    if (prev !== undefined && (f.viewSeq <= prev.viewSeq || f.inputSeq < prev.inputSeq || f.docVersion < prev.docVersion)) {
      mono += 1;
      bad(j, f.inputSeq, 'generation not monotonic (or a frame drawn twice)');
    }
    if (f.overlayAfterCommit) overlay += 1;
    const expected = script.displays[f.inputSeq];
    if (expected === undefined) {
      notEqual += 1;
      other += 1;
      bad(j, f.inputSeq, 'inputSeq outside the script');
      return;
    }
    if (f.digest !== expected.digest) {
      notEqual += 1;
      if (f.docVersion > f.frameDocVersion || f.overlayAfterCommit) doubleDraw += 1;
      else if (f.docVersion < f.frameDocVersion) snapBack += 1;
      else other += 1;
      bad(j, f.inputSeq, `digest ${f.digest} ≠ oracle ${expected.digest} (docVersion ${f.docVersion}, frame ${f.frameDocVersion})`);
    }
    if (!sameCamera(f.camera, expected.camera)) {
      camera += 1;
      bad(j, f.inputSeq, `camera ${f.camera.join(',')} ≠ oracle ${expected.camera.join(',')}`);
    }
  });
  const last = frames[frames.length - 1];
  const finalDisplay = script.displays[script.events.length] as OracleDisplay;
  const lastFrameEqualsFinalDisplay = last !== undefined && last.inputSeq === script.events.length && last.digest === finalDisplay.digest && sameCamera(last.camera, finalDisplay.camera);
  const o = script.final;
  const e = final.editor;
  const finalEditorEqualsOracle = e.committedDigest === o.committedDigest && e.docVersion === o.docVersion && e.commits === o.commits && e.cancels === o.cancels && e.errors === o.errors;
  const finalRenderEqualsOracle = final.render.committedDigest === o.committedDigest && final.render.docVersion === o.docVersion;
  const pass =
    frames.length > 0 &&
    notEqual === 0 &&
    camera === 0 &&
    mono === 0 &&
    overlay === 0 &&
    final.render.tornReads === 0 &&
    final.render.orderViolations === 0 &&
    lastFrameEqualsFinalDisplay &&
    finalEditorEqualsOracle &&
    finalRenderEqualsOracle;
  return {
    frames: frames.length,
    framesNotEqualOracle: notEqual,
    snapBackFrames: snapBack,
    doubleDrawFrames: doubleDraw,
    otherMismatch: other,
    cameraMismatchFrames: camera,
    generationNonMonotonic: mono,
    overlayAfterCommit: overlay,
    tornReads: final.render.tornReads,
    orderViolations: final.render.orderViolations,
    lastFrameEqualsFinalDisplay,
    finalEditorEqualsOracle,
    finalRenderEqualsOracle,
    firstBad,
    pass,
  };
}

// ---------------------------------------------------------------- driving

export interface DriveOptions {
  readonly seed?: number;
  /** Largest burst pushed between yields (S2: about 4 events per frame). Default 6. */
  readonly maxBurst?: number;
  /** Probability of a vsync after a burst. Default 0.5. */
  readonly vsyncEvery?: number;
  readonly timeoutMs?: number;
}

/** Yield to the event loop (setImmediate where available: setTimeout(0) is clamped to 1 ms). */
const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown }).setImmediate;
    if (immediate === undefined) setTimeout(resolve, 0);
    else immediate(() => resolve());
  });

/** Push a script through a pipeline in random bursts with vsyncs between, then wait for the last frame. */
export async function driveSequencingScript(pipeline: SequencingPipelineUnderTest, script: SequencingScript, options: DriveOptions = {}): Promise<boolean> {
  const random = sequencingRandom((options.seed ?? 1) * 7919 + 13);
  const maxBurst = options.maxBurst ?? 6;
  const vsyncEvery = options.vsyncEvery ?? 0.5;
  let i = 0;
  while (i < script.events.length) {
    const n = 1 + Math.floor(random() * maxBurst);
    pipeline.push(script.events.slice(i, i + n));
    i += n;
    if (random() < vsyncEvery) pipeline.vsync();
    await macrotask();
  }
  const deadline = options.timeoutMs ?? 30_000;
  const total = script.events.length;
  // Keep vsyncs coming so rAF-paced renders present the final frame.
  let settled = false;
  for (const started = Date.now(); !settled && Date.now() - started < deadline; ) {
    pipeline.vsync();
    settled = await pipeline.settled(total, 50);
  }
  return settled;
}

// ---------------------------------------------------------------- the suite

export interface SequencingOracleOptions {
  /** Scripted gestures per configuration (S2 used 10 000; CI 2 000). */
  readonly gestures?: number;
  readonly seed?: number;
  readonly configs: readonly SequencingConfig[];
  /** Configurations run with `dropDeltaEvery` (E-1 fault injection). Default: the first config, every 25th delta. */
  readonly faultConfigs?: readonly SequencingConfig[];
  readonly view?: { readonly width: number; readonly height: number };
  readonly timeoutMs?: number;
  readonly skip?: readonly string[];
}

export interface SequencingOracleCase {
  readonly name: string;
  run(subject: SequencingSubject): Promise<void>;
}

function describeCheck(check: SequencingCheck): string {
  const { firstBad, ...counts } = check;
  return `${JSON.stringify(counts)} first: ${JSON.stringify(firstBad)}`;
}

// Scripts are deterministic per (subject, gestures, seed, view): generate once per subject and reuse across configurations.
const scripts = new WeakMap<SequencingSubject, Map<string, SequencingScript>>();

function scriptFor(subject: SequencingSubject, options: SequencingOracleOptions, gestures: number): SequencingScript {
  const key = `${gestures}:${options.seed ?? 1}:${options.view?.width ?? 0}x${options.view?.height ?? 0}`;
  const cache = scripts.get(subject) ?? new Map<string, SequencingScript>();
  scripts.set(subject, cache);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const reference = subject.reference();
  try {
    const script = generateSequencingScript(reference, { gestures, seed: options.seed ?? 1, ...(options.view === undefined ? {} : { view: options.view }) });
    cache.set(key, script);
    return script;
  } finally {
    reference.dispose();
  }
}

async function replay(subject: SequencingSubject, config: SequencingConfig, options: SequencingOracleOptions, expectResync: boolean): Promise<void> {
  const script = scriptFor(subject, options, options.gestures ?? 2_000);
  for (const g of SEQUENCING_GESTURES) assertTrue(script.gestures[g] > 0, `the script exercises ${g}`);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pipeline = await within(subject.boot({ config, remote: script.remote }), timeoutMs, `boot ${config.name}`);
  try {
    const settled = await within(driveSequencingScript(pipeline, script, { seed: options.seed ?? 1, timeoutMs }), timeoutMs * 2, `replay on ${config.name}`);
    const final = await within(pipeline.finish(), timeoutMs, `finish ${config.name}`);
    const check = checkPresentedFrames(script, pipeline.presented(), final);
    assertTrue(settled, `the last input reached the screen on ${config.name}: ${describeCheck(check)}`);
    assertTrue(check.pass, `presented frames equal the oracle on ${config.name}: ${describeCheck(check)}`);
    if (expectResync) {
      assertTrue(final.droppedDeltas > 0 && final.render.resnapshots > 0, `lost deltas were detected and resynced (dropped ${final.droppedDeltas}, resnapshots ${final.render.resnapshots})`);
    } else {
      assertEqual(final.render.gaps, 0, `no gaps on ${config.name}`);
    }
  } finally {
    await pipeline.dispose();
  }
}

/** A small hand-made script for the checker cases. */
function syntheticScript(): SequencingScript {
  const displays: OracleDisplay[] = [
    { digest: 1, camera: [0, 0, 1] },
    { digest: 2, camera: [0, 0, 1] },
    { digest: 3, camera: [5, 0, 1] },
  ];
  const event: CompactInputEvent = { t: InputCode.wheel, ts: 0, x: 0, y: 0, b: 0, m: 0, dx: 5, dy: 0 };
  return {
    events: [event, event],
    remote: [],
    displays,
    gestures: Object.fromEntries(SEQUENCING_GESTURES.map((g) => [g, 0])) as Record<SequencingGesture, number>,
    stats: { remoteMoves: 0, remoteDeletes: 0, remoteMidDrag: 0, escCancels: 0, missedTargets: 0 },
    final: { committedDigest: 9, docVersion: 1, commits: 1, cancels: 0, errors: 0 },
  };
}

const goodFinal: SequencingRunFinal = {
  editor: { committedDigest: 9, docVersion: 1, commits: 1, cancels: 0, errors: 0 },
  render: { committedDigest: 9, docVersion: 1, resnapshots: 0, gaps: 0, tornReads: 0, orderViolations: 0 },
  droppedDeltas: 0,
};

const frame = (viewSeq: number, inputSeq: number, digest: number, camera: readonly [number, number, number], extra: Partial<PresentedFrame> = {}): PresentedFrame => ({
  viewSeq,
  inputSeq,
  docVersion: 1,
  frameDocVersion: 1,
  gestureId: 0,
  digest,
  camera,
  overlayAfterCommit: false,
  ...extra,
});

export function sequencingOracleCases(options: SequencingOracleOptions): readonly SequencingOracleCase[] {
  const cases: SequencingOracleCase[] = [
    {
      name: 'the checker passes a correct run and flags snap-back, double draw, camera, monotonicity and torn reads (detectors are not vacuous)',
      async run() {
        const script = syntheticScript();
        const good = [frame(1, 0, 1, [0, 0, 1]), frame(2, 1, 2, [0, 0, 1]), frame(3, 2, 3, [5, 0, 1])];
        assertTrue(checkPresentedFrames(script, good, goodFinal).pass, 'a correct run passes');
        const snap = checkPresentedFrames(script, [good[0] as PresentedFrame, frame(2, 1, 7, [0, 0, 1], { docVersion: 0 }), good[2] as PresentedFrame], goodFinal);
        assertEqual([snap.pass, snap.snapBackFrames], [false, 1], 'snap-back (committed state behind the frame) is caught');
        const double = checkPresentedFrames(script, [good[0] as PresentedFrame, frame(2, 1, 7, [0, 0, 1], { docVersion: 2, overlayAfterCommit: true }), good[2] as PresentedFrame], goodFinal);
        assertEqual([double.pass, double.doubleDrawFrames, double.overlayAfterCommit], [false, 1, 1], 'double draw (overlay after its commit) is caught');
        const cam = checkPresentedFrames(script, [good[0] as PresentedFrame, good[1] as PresentedFrame, frame(3, 2, 3, [4, 0, 1])], goodFinal);
        assertEqual([cam.pass, cam.cameraMismatchFrames], [false, 1], 'a stale camera is caught');
        const mono = checkPresentedFrames(script, [good[1] as PresentedFrame, good[0] as PresentedFrame, good[2] as PresentedFrame], goodFinal);
        assertTrue(!mono.pass && mono.generationNonMonotonic > 0, 'non-monotonic generations are caught');
        const torn = checkPresentedFrames(script, good, { ...goodFinal, render: { ...goodFinal.render, tornReads: 1 } });
        assertTrue(!torn.pass, 'a torn read fails the run');
        const lost = checkPresentedFrames(script, good.slice(0, 2), goodFinal);
        assertTrue(!lost.pass && !lost.lastFrameEqualsFinalDisplay, 'a run whose last input never reached the screen fails');
        const diverged = checkPresentedFrames(script, good, { ...goodFinal, render: { ...goodFinal.render, committedDigest: 8 } });
        assertTrue(!diverged.pass && !diverged.finalRenderEqualsOracle, 'a diverged final render state fails');
      },
    },
  ];
  for (const config of options.configs) {
    cases.push({
      name: `G-1…G-6 replay equals the single-threaded oracle — ${config.name}`,
      run: (subject) => replay(subject, config, options, false),
    });
  }
  const first = options.configs[0];
  const faults = options.faultConfigs ?? (first === undefined ? [] : [{ ...first, name: `${first.name}, every 25th delta lost`, dropDeltaEvery: 25 }]);
  for (const config of faults) {
    cases.push({
      name: `E-1: lost deltas resync from a snapshot and the replay still equals the oracle — ${config.name}`,
      run: (subject) => replay(subject, config, { ...options, gestures: Math.min(options.gestures ?? 2_000, 500) }, true),
    });
  }
  return cases;
}

/** Run the sequencing oracle suite against a subject (one `it` per case). */
export function runSequencingOracleContract(name: string, subject: SequencingSubject, runner: ContractRunner, options: SequencingOracleOptions): void {
  runner.describe(`sequencing oracle contract: ${name}`, () => {
    for (const c of sequencingOracleCases(options)) {
      if (options.skip?.includes(c.name) === true) continue;
      runner.it(c.name, () => c.run(subject));
    }
  });
}
