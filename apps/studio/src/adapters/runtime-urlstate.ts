/**
 * Adapter: @staticflux/runtime frame scheduler → @staticflux/urlstate frame port.
 * URL writes coalesce into the same per-frame `update` phase as store patches and
 * renders (R12.13): one history write per frame, paused with the app (I-1).
 */
import { unit } from '@staticflux/core';
import { FrameSchedulerToken as RuntimeFrameSchedulerToken } from '@staticflux/runtime';
import { type FrameScheduler, FrameSchedulerToken } from '@staticflux/urlstate';

export const runtimeUrlFrameSchedulerUnit = unit({
  id: 'studio/url-frame-scheduler-unit',
  provides: FrameSchedulerToken,
  scope: 'app',
  deps: { required: { frames: RuntimeFrameSchedulerToken } },
  create: ({ frames }): FrameScheduler => ({
    request(callback) {
      const controller = new AbortController();
      // A fresh closure per request: the runtime coalesces jobs by identity.
      frames.schedule(() => callback(), controller.signal);
      return () => controller.abort();
    },
  }),
  description: 'urlstate URL sync runs in the runtime frame flush.',
});
