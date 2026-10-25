/**
 * Clock cell (SF-Δ18, for the M3 media clock): a seqlock cell holding an f64
 * position, playback state and rate, anchored to an absolute time base so every
 * thread extrapolates the same position without messages:
 *
 *   position(now) = position + (state === playing ? rate * (now - anchor) / 1000 : 0)
 *
 * `anchor` is absolute milliseconds (`performance.timeOrigin + performance.now()`),
 * comparable across threads. Position units are the clock's (seconds by default).
 * The writer (audio master or wall clock) publishes on every state change and
 * periodically to correct drift; readers sample in their own frame loop.
 *
 * @example
 * export const PlayheadClock = defineClockCell({ id: 'instaflow/playhead' });
 * const clock = unwrap(createClockCell(PlayheadClock, { medium }));
 * clock.publish({ position: 12.5, state: 'playing', rate: 1, anchor: absNow() });
 * const playhead = unwrap(await attachClockCell(PlayheadClock, endpoint));
 * const { position } = playhead.sample(absNow());
 */
import { ok, type Result } from '@staticflux/core';
import type { ChannelId } from './envelope.js';
import { defineLayout, type Layout } from './layout.js';
import type { PipeMedium, RegionEndpoint, RegionWaitOptions } from './region.js';
import { type AttachCellOptions, attachCell, type CellDefinition, type CreateCellOptions, createCell, defineCell } from './seqlock-cell.js';

export const CLOCK_STATES = ['stopped', 'playing', 'paused', 'seeking'] as const;
export type ClockState = (typeof CLOCK_STATES)[number];

/** Binary layout of a clock cell (shared with Wasm/AudioWorklet readers via `ClockCellLayout.source()`). */
export const ClockCellLayout = /* @__PURE__ */ defineLayout({
  name: 'ClockCell',
  fields: { position: 'f64', rate: 'f64', anchor: 'f64', state: 'i32', epoch: 'i32' },
});

type ClockFields = typeof ClockCellLayout extends Layout<infer F> ? F : never;

export type ClockCellDefinition = CellDefinition<ClockFields>;

/** Declare a clock cell. Checksummed (cheap: 32 bytes). */
export function defineClockCell<const Id extends ChannelId>(declaration: { readonly id: Id; readonly version?: number }): ClockCellDefinition {
  return defineCell({ id: declaration.id, layout: ClockCellLayout, version: declaration.version ?? 1, checksum: true });
}

export interface ClockValue {
  readonly position: number;
  readonly state: ClockState;
  /** Playback rate (1 = real time, negative = reverse). */
  readonly rate: number;
  /** Absolute ms the position was measured at. */
  readonly anchor: number;
  /** Bumped by the writer on discontinuities (seek, source switch); readers reset smoothing. */
  readonly epoch: number;
}

export interface ClockSample extends ClockValue {
  /** Generation of the cell value this sample extrapolates. */
  readonly generation: number;
}

export interface ClockCellWriter {
  readonly id: ChannelId;
  readonly medium: PipeMedium;
  readonly generation: number;
  /** Publish a new clock value (omitted fields keep their previous value). */
  publish(value: Partial<ClockValue> & { readonly anchor: number }): Result<number>;
  endpoint(): Result<RegionEndpoint>;
  close(): void;
}

export interface ClockCellReader {
  readonly id: ChannelId;
  readonly medium: PipeMedium;
  /** Extrapolated clock at absolute time `now`; undefined before the first publish. */
  sample(now: number): ClockSample | undefined;
  wait(options?: RegionWaitOptions): Promise<Result<boolean>>;
  close(): void;
}

const stateCode = (state: ClockState): number => CLOCK_STATES.indexOf(state);
const stateOf = (code: number): ClockState => CLOCK_STATES[code] ?? 'stopped';

/** Extrapolate a clock value to `now` (pure; exported for tests and AudioWorklet ports). */
export function extrapolateClock(value: ClockValue, now: number): number {
  return value.state === 'playing' ? value.position + (value.rate * (now - value.anchor)) / 1000 : value.position;
}

export function createClockCell(definition: ClockCellDefinition, options: CreateCellOptions): Result<ClockCellWriter> {
  const created = createCell(definition, options);
  if (!created.ok) return created;
  const cell = created.value;
  let last: ClockValue = { position: 0, state: 'stopped', rate: 1, anchor: 0, epoch: 0 };
  return ok({
    id: cell.id,
    medium: cell.medium,
    get generation() {
      return cell.generation;
    },
    publish(value) {
      const next: ClockValue = { ...last, ...value };
      const written = cell.write(({ record }) => {
        record.position = next.position;
        record.rate = next.rate;
        record.anchor = next.anchor;
        record.state = stateCode(next.state);
        record.epoch = next.epoch;
      });
      if (written.ok) last = next;
      return written;
    },
    endpoint: () => cell.endpoint(),
    close: () => cell.close(),
  });
}

export async function attachClockCell(
  definition: ClockCellDefinition,
  endpoint: RegionEndpoint,
  options: AttachCellOptions = {},
): Promise<Result<ClockCellReader>> {
  const attached = await attachCell(definition, endpoint, options);
  if (!attached.ok) return attached;
  const cell = attached.value;
  return ok({
    id: cell.id,
    medium: cell.medium,
    sample(now) {
      const snapshot = cell.read();
      if (snapshot === undefined) return undefined;
      const { record } = snapshot;
      const value: ClockValue = {
        position: record.position,
        state: stateOf(record.state),
        rate: record.rate,
        anchor: record.anchor,
        epoch: record.epoch,
      };
      return { ...value, position: extrapolateClock(value, now), generation: snapshot.generation };
    },
    wait: (waitOptions) => cell.wait(waitOptions),
    close: () => cell.close(),
  });
}
