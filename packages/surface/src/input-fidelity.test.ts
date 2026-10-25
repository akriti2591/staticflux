import { attachRecordRing, createRecordRing, type PipeMedium } from '@staticflux/worker/pipeline';
import { describe, expect, it } from 'vitest';
import { flushMicrotasks, hostElement, testEnv } from './fakes.test.js';
import { coalesceInput, type CompactInputEvent, createInputForwarder, InputCode, InputFlag, InputModifier, PointerKind } from './index.js';
import {
  decodeInputRecord,
  defineInputRing,
  drainInputRing,
  encodeInputRecord,
  INPUT_KEY_CODES,
  INPUT_KEY_NAMES,
  InputRecordLayout,
  inputRingSink,
} from './input-ring.js';

function event(type: string, init: Record<string, unknown>): Event {
  const e = new Event(type);
  for (const [key, value] of Object.entries(init)) Object.defineProperty(e, key, { value });
  return e;
}

const pen = (x: number, ts: number, pressure: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientX: 10 + x,
  clientY: 20,
  pointerId: 7,
  pointerType: 'pen',
  buttons: 1,
  timeStamp: ts,
  pressure,
  tangentialPressure: 0.1,
  tiltX: 30,
  tiltY: -15,
  twist: 90,
  width: 1,
  height: 1,
  isPrimary: true,
  ...extra,
});

/** A pen pointermove whose platform event carries coalesced and predicted samples. */
function penMove(): Event {
  const samples = [pen(1, 1, 0.2), pen(2, 2, 0.4), pen(3, 3, 0.6)];
  const predicted = [pen(4, 4, 0.6), pen(5, 5, 0.6)];
  return event('pointermove', {
    ...pen(3, 3, 0.6),
    getCoalescedEvents: () => samples.map((s) => event('pointermove', s)),
    getPredictedEvents: () => predicted.map((s) => event('pointermove', s)),
  });
}

describe('input forwarding fidelity (SF-Δ22)', () => {
  it('expands coalesced samples losslessly with pen pressure, tilt and twist', async () => {
    const target = hostElement();
    const lossless: CompactInputEvent[][] = [];
    const forwarder = createInputForwarder({ target, env: testEnv(), sinks: [{ deliver: (batch) => void lossless.push([...batch]) }] });
    target.dispatchEvent(penMove());
    await flushMicrotasks();
    expect(lossless).toHaveLength(1);
    const samples = lossless[0] as CompactInputEvent[];
    expect(samples.map((s) => [s.x, s.pr, s.f])).toEqual([
      [1, 0.2, InputFlag.coalesced | InputFlag.primary],
      [2, 0.4, InputFlag.coalesced | InputFlag.primary],
      [3, 0.6, InputFlag.primary],
    ]);
    expect(samples[2]).toEqual({
      t: InputCode.pointerMove,
      ts: 1003,
      x: 3,
      y: 0,
      b: 1,
      m: 0,
      p: 7,
      k: PointerKind.pen,
      pr: 0.6,
      tp: 0.1,
      tx: 30,
      ty: -15,
      tw: 90,
      w: 1,
      h: 1,
      f: InputFlag.primary,
    });
    expect(forwarder.forwarded).toBe(3); // predicted samples are not produced when no sink wants them
    forwarder.dispose();
  });

  it('delivers to several sinks with coalescing and prediction chosen per sink', async () => {
    const target = hostElement();
    const raw: CompactInputEvent[] = [];
    const overlay: CompactInputEvent[] = [];
    const preview: CompactInputEvent[] = [];
    const seqs: number[] = [];
    const forwarder = createInputForwarder({
      target,
      env: testEnv(),
      sinks: [
        { deliver: (batch, info) => (raw.push(...batch), seqs.push(info.seq)) },
        { deliver: (batch) => void overlay.push(...batch), coalesce: true },
        { deliver: (batch) => void preview.push(...batch), coalesce: true, predicted: true },
      ],
    });
    target.dispatchEvent(penMove());
    await flushMicrotasks();
    expect(raw).toHaveLength(3); // lossless, predicted filtered out
    expect(overlay).toEqual([{ ...raw[2], ts: 1001, n: 3 }]); // latest point, oldest ts
    expect(preview.map((e) => [e.x, e.f])).toEqual([
      [3, InputFlag.primary],
      [4, InputFlag.predicted | InputFlag.primary],
      [5, InputFlag.predicted | InputFlag.primary],
    ]); // predicted samples are never merged
    target.dispatchEvent(event('pointerup', { clientX: 15, clientY: 20, pointerId: 7, pointerType: 'pen' }));
    await flushMicrotasks();
    expect(seqs).toEqual([1, 2]);
    expect(forwarder.batches).toBe(2);
    forwarder.dispose();
  });

  it('can skip coalesced expansion', async () => {
    const target = hostElement();
    const batches: CompactInputEvent[][] = [];
    const forwarder = createInputForwarder({ target, env: testEnv(), coalescedEvents: false, sinks: [{ deliver: (b) => void batches.push([...b]) }] });
    target.dispatchEvent(penMove());
    await flushMicrotasks();
    expect(batches[0]?.map((e) => e.x)).toEqual([3]);
    forwarder.dispose();
  });

  it('coalesceInput merges runs of moves per pointer only', () => {
    const move = (p: number, x: number, ts: number, f = 0): CompactInputEvent => ({ t: InputCode.pointerMove, ts, x, y: 0, b: 1, m: 0, p, ...(f === 0 ? {} : { f }) });
    const down: CompactInputEvent = { t: InputCode.pointerDown, ts: 0, x: 0, y: 0, b: 1, m: 0, p: 1 };
    const merged = coalesceInput([down, move(1, 1, 1), move(1, 2, 2), move(2, 9, 3), move(2, 10, 4), move(1, 3, 5), move(1, 4, 6, InputFlag.predicted)]);
    expect(merged.map((e) => [e.t, e.p, e.x, e.ts, e.n])).toEqual([
      [InputCode.pointerDown, 1, 0, 0, undefined],
      [InputCode.pointerMove, 1, 2, 1, 2],
      [InputCode.pointerMove, 2, 10, 3, 2],
      [InputCode.pointerMove, 1, 3, 5, undefined],
    ]);
    expect(coalesceInput([move(1, 3, 5), move(1, 4, 6, InputFlag.predicted)], { predicted: true })).toHaveLength(2);
  });
});

describe('binary input ring', () => {
  it('describes an 80-byte record with Rust/C mirrors', () => {
    expect(InputRecordLayout.stride).toBe(80);
    expect(InputRecordLayout.field('ts').offset).toBe(0);
    expect(InputRecordLayout.source('rust')).toContain('pub struct InputRecord');
    expect(new Set(INPUT_KEY_CODES).size).toBe(INPUT_KEY_CODES.length);
    expect(new Set(INPUT_KEY_NAMES).size).toBe(INPUT_KEY_NAMES.length);
    expect(INPUT_KEY_CODES[0]).toBe('');
    const ring = defineInputRing({ id: 'test/input' });
    expect(ring).toMatchObject({ capacity: 4096, readers: 2, version: 1 });
  });

  it('encodes and decodes pointer, wheel and key samples', () => {
    const view = InputRecordLayout.allocate(1);
    const roundTrip = (e: CompactInputEvent, seq = 3) => {
      encodeInputRecord(view.at(0), e, seq);
      return decodeInputRecord(view.at(0));
    };
    const stroke: CompactInputEvent = { t: InputCode.pointerMove, ts: 1234.5, x: 10.25, y: -3.5, b: 1, m: InputModifier.shift, p: 7, k: PointerKind.pen, pr: 0.5, tp: 0, tx: 30, ty: -15, tw: 90, w: 2, h: 3, f: InputFlag.coalesced, n: 4 };
    expect(roundTrip(stroke)).toEqual({ event: stroke, seq: 3 });
    const wheel: CompactInputEvent = { t: InputCode.wheel, ts: 1, x: 1, y: 2, b: 0, m: InputModifier.ctrl, dx: 0, dy: -48 };
    expect(roundTrip(wheel, 9)).toEqual({ event: wheel, seq: 9 });
    const shortcut: CompactInputEvent = { t: InputCode.keyDown, ts: 2, x: 0, y: 0, b: 0, m: InputModifier.meta, key: 'z', code: 'KeyZ' };
    expect(roundTrip(shortcut).event).toEqual(shortcut);
    const named: CompactInputEvent = { t: InputCode.keyDown, ts: 2, x: 0, y: 0, b: 0, m: 0, key: 'ArrowLeft', code: 'ArrowLeft' };
    expect(roundTrip(named).event).toEqual(named);
    const emoji: CompactInputEvent = { t: InputCode.keyDown, ts: 2, x: 0, y: 0, b: 0, m: 0, key: '😀', code: 'Unknownish' };
    expect(roundTrip(emoji).event).toEqual({ ...emoji, code: undefined });
    const unknown: CompactInputEvent = { t: InputCode.keyUp, ts: 2, x: 0, y: 0, b: 0, m: 0, key: 'LaunchMail', code: 'LaunchMail' };
    expect(Object.keys(roundTrip(unknown).event)).not.toContain('key'); // outside the tables
  });

  it.each(['local', 'shared', 'message'] as const)('forwarder → ring → readers with their own coalescing (%s)', async (medium: PipeMedium) => {
    const InputRing = defineInputRing({ id: 'test/input', capacity: 64 });
    const created = createRecordRing(InputRing, { medium });
    if (!created.ok) throw created.error;
    const editorEndpoint = created.value.endpoint(0);
    const renderEndpoint = created.value.endpoint(1);
    if (!editorEndpoint.ok || !renderEndpoint.ok) throw new Error('endpoints');
    const editor = await attachRecordRing(InputRing, editorEndpoint.value);
    const render = await attachRecordRing(InputRing, renderEndpoint.value);
    if (!editor.ok || !render.ok) throw new Error('attach');
    const target = hostElement();
    const sink = inputRingSink(created.value);
    const forwarder = createInputForwarder({ target, env: testEnv(), sinks: [sink] });
    target.dispatchEvent(penMove());
    target.dispatchEvent(event('keydown', { key: 'Escape', code: 'Escape', timeStamp: 9 }));
    await flushMicrotasks();
    expect(sink.stats).toEqual({ written: 6, dropped: 0 }); // 3 samples + 2 predicted + key: the ring is lossless
    await editor.value.wait({ timeoutMs: 1000 });
    await render.value.wait({ timeoutMs: 1000 });
    const lossless = drainInputRing(editor.value);
    expect(lossless.events.map((e) => e.x)).toEqual([1, 2, 3, 0]);
    expect(lossless.seq).toBe(1);
    const fastPath = drainInputRing(render.value, { coalesce: true, predicted: true });
    expect(fastPath.events.map((e) => [e.x, e.n ?? 1, e.f])).toEqual([
      [3, 3, InputFlag.primary],
      [4, 1, InputFlag.predicted | InputFlag.primary],
      [5, 1, InputFlag.predicted | InputFlag.primary],
      [0, 1, undefined],
    ]);
    expect(fastPath.events[3]).toMatchObject({ t: InputCode.keyDown, key: 'Escape', code: 'Escape' });
    forwarder.dispose();
    created.value.close();
  });

  it('counts samples the ring refuses', () => {
    const InputRing = defineInputRing({ id: 'test/input', capacity: 64 });
    const created = createRecordRing(InputRing, { medium: 'local' });
    if (!created.ok) throw created.error;
    const dropped: CompactInputEvent[] = [];
    const sink = inputRingSink(created.value, { onDrop: (e) => dropped.push(e) });
    created.value.close();
    sink.deliver([{ t: InputCode.pointerDown, ts: 0, x: 0, y: 0, b: 1, m: 0 }], { seq: 1 });
    expect(sink.stats).toEqual({ written: 0, dropped: 1 });
    expect(dropped).toHaveLength(1);
  });
});
