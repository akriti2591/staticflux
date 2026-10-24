/**
 * Adapter: @staticflux/runtime → @staticflux/data.
 *
 * - The data epoch follows the app epoch: `supervisor.refresh()` bumps it, so cached
 *   resources go stale, in-flight requests of the old epoch are discarded (I-10) and
 *   observed resources refetch (R4.3, R4.7).
 * - App pause/resume drives the data pause port: transports queue idempotent calls
 *   and reject mutations while paused (R4.6).
 */
import { contribution, unit } from '@staticflux/core';
import { createPauseControl, type EpochSource, EpochSourceToken, PauseControlToken } from '@staticflux/data';
import { defineSubsystem, SubsystemsToken, SupervisorToken } from '@staticflux/runtime';

export const supervisorEpochSourceUnit = unit({
  id: 'studio/supervisor-epoch-source-unit',
  provides: EpochSourceToken,
  scope: 'app',
  deps: { required: { supervisor: SupervisorToken } },
  create: ({ supervisor }): EpochSource => ({
    get current() {
      return supervisor.epoch; // reactive (supervisor epoch is observable)
    },
  }),
  description: 'Data epoch = app epoch (bumped by supervisor.refresh()).',
});

export const pauseControlUnit = unit({
  id: 'studio/pause-control-unit',
  provides: PauseControlToken,
  scope: 'app',
  create: () => createPauseControl(),
});

export const dataPauseSubsystemUnit = contribution({
  id: 'studio/data-pause-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { pause: PauseControlToken } },
  create: ({ pause }) =>
    defineSubsystem({
      id: 'data/transport',
      critical: false,
      start: () => undefined,
      pause: () => pause.pause(),
      resume: () => pause.resume(),
      description: 'Pauses data transports while the app is paused.',
    }),
});
