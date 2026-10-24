/**
 * Adapter: @staticflux/runtime app lifecycle → @staticflux/messaging. While the app
 * is paused (e.g. connection lost) a non-dismissible "Reconnecting" dialog shows;
 * it closes on resume (FEATURE-NEEDS runtime: pause while "reconnecting" shows).
 */
import { contribution } from '@staticflux/core';
import { type SurfaceHandle, SurfaceManagerToken } from '@staticflux/messaging';
import { defineSubsystem, SubsystemsToken } from '@staticflux/runtime';
import { ReconnectingDialog } from '../app/surfaces.js';

export const reconnectingSurfaceSubsystemUnit = contribution({
  id: 'studio/reconnecting-surface-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { surfaces: SurfaceManagerToken } },
  create: ({ surfaces }) => {
    let handle: SurfaceHandle | undefined;
    return defineSubsystem({
      id: 'messaging/reconnecting',
      start: () => undefined,
      pause: (ctx) => {
        handle = surfaces.request(ReconnectingDialog, { owner: { scope: ctx.scope, level: 'app' } });
      },
      resume: () => {
        handle?.dismiss('programmatic');
        handle = undefined;
      },
      description: 'Shows "Reconnecting…" while the app is paused.',
    });
  },
});
