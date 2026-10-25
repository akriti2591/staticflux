/**
 * Flag bindings for the sequencing boot settings: the one place that reads the flags and turns
 * them into `SequencingSettings` (variant tables, no branches in module code).
 */
import type { FlagDefinition } from '@staticflux/config';
import { RenderTickFlag, SequencingTopologyFlag } from './flags.js';
import { DEFAULT_RENDER_PACING, MAIN_TICK_PACING, type RenderPacing, type TickDriver } from './pacing.js';
import { DEFAULT_SEQUENCING_SETTINGS, type SequencingSettings } from './topology.js';

const PACING: Readonly<Record<TickDriver, RenderPacing>> = { 'worker-raf': DEFAULT_RENDER_PACING, 'main-raf': MAIN_TICK_PACING };

/** Build settings from resolved flag values (`read` is the app's flag resolver). */
export function resolveSequencingSettings(read: <T>(flag: FlagDefinition<T>) => T, base: SequencingSettings = DEFAULT_SEQUENCING_SETTINGS): SequencingSettings {
  return { ...base, topology: read(SequencingTopologyFlag), pacing: PACING[read(RenderTickFlag)] };
}
