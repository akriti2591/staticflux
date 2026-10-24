/**
 * Deferred chunk: the runtime resource manager (demotion, budgets) and its memory-pressure
 * input. Nothing needs them for the first frame; they load on first resolution.
 */
import type { Registration } from '@staticflux/core';
import { nominalMemoryPressureUnit, resourceManagerUnit } from '@staticflux/runtime';

export const resourceUnits: readonly Registration[] = [nominalMemoryPressureUnit, resourceManagerUnit];
