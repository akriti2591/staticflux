/**
 * Binary input ring (SF-Δ22, S2 channel 1): main → editor (and the render worker
 * for the camera fast path) as fixed 80-byte records described with
 * `defineLayout`, on a lossless SPMC record ring from `@staticflux/worker/pipeline`.
 * Same ring in one worker or two (local / shared / message medium).
 *
 * - The forwarder writes **every** sample (coalesced and predicted included) through
 *   `inputRingSink(ring)`; each reader chooses coalescing and prediction when it drains
 *   (`drainInputRing(reader, { coalesce, predicted })`) — coalescing opt-in per consumer.
 * - Keys travel as indices into `INPUT_KEY_CODES` (`KeyboardEvent.code`) and
 *   `INPUT_KEY_NAMES` (named `key` values) plus the code point of single-character
 *   keys. Codes outside the tables decode as `undefined` (shortcuts use `code`).
 * - Every record carries its batch's `inputSeq`, so a reader knows which input a
 *   view frame has consumed (E-4: one camera per hit test).
 *
 * @example
 * export const InputRing = defineInputRing({ id: 'instaflow/input', readers: 2 });
 * const ring = unwrap(createRecordRing(InputRing, { medium }));               // main
 * createInputForwarder({ target: canvas, env, sinks: [inputRingSink(ring)] });
 * const input = unwrap(await attachRecordRing(InputRing, endpoint));           // editor
 * const { events, seq } = drainInputRing(input, { coalesce: false });
 */
import { defineLayout, type Layout, type LayoutRecord } from '@staticflux/worker/channels';
import {
  defineRecordRing,
  type RecordRingDefinition,
  type RecordRingReader,
  type RecordRingWriter,
} from '@staticflux/worker/pipeline';
import type { ChannelId } from '@staticflux/worker';
import { type CompactInputEvent, coalesceInput, type InputCode, InputFlag, type InputSink } from './input.js';

/** One input sample (80 bytes, 8-aligned). Rust/C mirrors: `InputRecordLayout.source('rust')`. */
export const InputRecordLayout = /* @__PURE__ */ defineLayout({
  name: 'InputRecord',
  fields: {
    ts: 'f64',
    seq: 'u32',
    pointerId: 'i32',
    x: 'f32',
    y: 'f32',
    dx: 'f32',
    dy: 'f32',
    pressure: 'f32',
    tangentialPressure: 'f32',
    tiltX: 'f32',
    tiltY: 'f32',
    twist: 'f32',
    width: 'f32',
    height: 'f32',
    keyChar: 'u32',
    type: 'u8',
    pointerKind: 'u8',
    modifiers: 'u8',
    flags: 'u8',
    buttons: 'u16',
    keyCode: 'u16',
    keyName: 'u16',
    count: 'u16',
    /** Bit per optional field present (`pressure` … `height`, `dx`/`dy`, pointer). */
    present: 'u16',
  },
});

export type InputRecordFields = typeof InputRecordLayout extends Layout<infer F> ? F : never;

const letters = Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`);
const digits = Array.from({ length: 10 }, (_, i) => `Digit${i}`);
const functionKeys = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const numpad = [...Array.from({ length: 10 }, (_, i) => `Numpad${i}`), 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter'];

/** `KeyboardEvent.code` table (index 0 = not in the table). Append only: indices are wire format. */
export const INPUT_KEY_CODES: readonly string[] = Object.freeze([
  '',
  ...letters,
  ...digits,
  ...functionKeys,
  ...numpad,
  'Escape', 'Tab', 'CapsLock', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'Space', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ContextMenu',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'IntlBackslash',
]);

/** Named `KeyboardEvent.key` values (index 0 = a printable character or unknown). Append only. */
export const INPUT_KEY_NAMES: readonly string[] = Object.freeze([
  '',
  'Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'ContextMenu',
  'Dead', 'Process', 'Unidentified', 'AltGraph', 'Compose',
  ...functionKeys,
]);

const codeIndex = new Map(INPUT_KEY_CODES.map((code, i) => [code, i]));
const nameIndex = new Map(INPUT_KEY_NAMES.map((name, i) => [name, i]));

const PRESENT = {
  pointer: 1,
  wheel: 2,
  pr: 4,
  tp: 8,
  tx: 16,
  ty: 32,
  tw: 64,
  w: 128,
  h: 256,
  key: 512,
} as const;

const OPTIONAL = [
  ['pr', 'pressure'],
  ['tp', 'tangentialPressure'],
  ['tx', 'tiltX'],
  ['ty', 'tiltY'],
  ['tw', 'twist'],
  ['w', 'width'],
  ['h', 'height'],
] as const;

/** Declare the input ring (defaults: 4096 records, 2 readers — editor and render fast path). */
export function defineInputRing<const Id extends ChannelId>(declaration: {
  readonly id: Id;
  readonly capacity?: number;
  readonly readers?: number;
  readonly version?: number;
}): RecordRingDefinition<InputRecordFields> {
  return defineRecordRing({
    id: declaration.id,
    layout: InputRecordLayout,
    capacity: declaration.capacity ?? 4096,
    readers: declaration.readers ?? 2,
    version: declaration.version ?? 1,
  });
}

/** Write one compact event into a record (all fields; absent ones zeroed). */
export function encodeInputRecord(record: LayoutRecord<InputRecordFields>, event: CompactInputEvent, seq: number): void {
  let present = 0;
  record.ts = event.ts;
  record.seq = seq;
  record.type = event.t;
  record.x = event.x;
  record.y = event.y;
  record.buttons = event.b;
  record.modifiers = event.m;
  record.flags = event.f ?? 0;
  record.count = event.n ?? 1;
  if (event.p !== undefined || event.k !== undefined) present |= PRESENT.pointer;
  record.pointerId = event.p ?? 0;
  record.pointerKind = event.k ?? 0;
  if (event.dx !== undefined || event.dy !== undefined) present |= PRESENT.wheel;
  record.dx = event.dx ?? 0;
  record.dy = event.dy ?? 0;
  for (const [short, field] of OPTIONAL) {
    const value = event[short];
    if (value !== undefined) present |= PRESENT[short];
    record[field] = value ?? 0;
  }
  const keyed = event.key !== undefined || event.code !== undefined;
  if (keyed) present |= PRESENT.key;
  record.keyCode = event.code === undefined ? 0 : (codeIndex.get(event.code) ?? 0);
  const name = event.key === undefined ? 0 : (nameIndex.get(event.key) ?? 0);
  record.keyName = name;
  const point = event.key !== undefined && name === 0 && [...event.key].length === 1 ? (event.key.codePointAt(0) ?? 0) : 0;
  record.keyChar = point;
  record.present = present;
}

/** Read one record back into a compact event (and its batch `seq`). */
export function decodeInputRecord(record: LayoutRecord<InputRecordFields>): { readonly event: CompactInputEvent; readonly seq: number } {
  const present = record.present;
  const out: Record<string, unknown> = { t: record.type as InputCode, ts: record.ts, x: record.x, y: record.y, b: record.buttons, m: record.modifiers };
  if ((present & PRESENT.pointer) !== 0) {
    out['p'] = record.pointerId;
    out['k'] = record.pointerKind;
  }
  if ((present & PRESENT.wheel) !== 0) {
    out['dx'] = record.dx;
    out['dy'] = record.dy;
  }
  if ((present & PRESENT.key) !== 0) {
    const key = record.keyName !== 0 ? INPUT_KEY_NAMES[record.keyName] : record.keyChar !== 0 ? String.fromCodePoint(record.keyChar) : undefined;
    const code = record.keyCode !== 0 ? INPUT_KEY_CODES[record.keyCode] : undefined;
    if (key !== undefined) out['key'] = key;
    if (code !== undefined) out['code'] = code;
  }
  if (record.count > 1) out['n'] = record.count;
  if (record.flags !== 0) out['f'] = record.flags;
  for (const [short, field] of OPTIONAL) if ((present & PRESENT[short]) !== 0) out[short] = record[field];
  return { event: out as unknown as CompactInputEvent, seq: record.seq };
}

export interface InputRingSinkStats {
  readonly written: number;
  /** Samples the ring refused (queue overflow, closed ring). */
  readonly dropped: number;
}

/** A forwarder sink that writes every sample into the ring (lossless; readers coalesce if they want). */
export function inputRingSink(
  ring: RecordRingWriter<InputRecordFields>,
  options: { readonly onDrop?: (event: CompactInputEvent) => void } = {},
): InputSink & { readonly stats: InputRingSinkStats } {
  const stats = { written: 0, dropped: 0 };
  return {
    coalesce: false,
    predicted: true,
    deliver(batch, info) {
      for (const event of batch) {
        const pushed = ring.push((record) => encodeInputRecord(record, event, info.seq));
        if (pushed.ok) stats.written += 1;
        else {
          stats.dropped += 1;
          options.onDrop?.(event);
        }
      }
    },
    get stats() {
      return { ...stats };
    },
  };
}

export interface DrainInputOptions {
  /** Merge consecutive moves of one pointer (this consumer only). Default false: every sample. */
  readonly coalesce?: boolean;
  /** Keep predicted samples. Default false. */
  readonly predicted?: boolean;
  /** Records to drain at most. */
  readonly max?: number;
}

/** Drain the ring into compact events; `seq` is the newest batch drained (`inputSeq`). */
export function drainInputRing(
  reader: RecordRingReader<InputRecordFields>,
  options: DrainInputOptions = {},
): { readonly events: readonly CompactInputEvent[]; readonly seq: number | undefined } {
  const events: CompactInputEvent[] = [];
  let seq: number | undefined;
  reader.drain((record) => {
    const decoded = decodeInputRecord(record);
    events.push(decoded.event);
    seq = decoded.seq;
  }, options.max);
  const shaped =
    options.coalesce === true
      ? coalesceInput(events, options)
      : options.predicted === true
        ? events
        : events.filter((e) => ((e.f ?? 0) & InputFlag.predicted) === 0);
  return { events: shaped, seq };
}
