/**
 * Adapter: @staticflux/runtime app lifecycle → @staticflux/messaging. While the app
 * is paused (e.g. connection lost) a non-dismissible "Reconnecting" dialog shows;
 * it closes on resume (FEATURE-NEEDS runtime: pause while "reconnecting" shows).
 * The surface manager is a functional dep: the surfaces chunk loads on the first pause
 * (or earlier, after first paint), never on the boot path.
 */
import { contribution } from '@staticflux/core';
import { defineSurface, type SurfaceHandle, SurfaceManagerToken } from '@staticflux/messaging';
import { defineSubsystem, SubsystemsToken } from '@staticflux/runtime';
import { html } from 'lit';

/**
 * Boot names this surface, so it is declared here (a plain `defineSurface` rendering the kit
 * dialog frame) instead of in `app/surfaces.ts`, which would pull every surface into boot.
 */
export const ReconnectingDialog = defineSurface({
  id: 'studio/reconnecting',
  kind: 'dialog',
  scope: 'app',
  priority: 'urgent',
  dismissible: false,
  label: 'Reconnecting',
  render: () => html`<sf-dialog heading="Reconnecting" .dismissible=${false}><p role="status">Reconnecting… your changes are kept.</p></sf-dialog>`,
});

export const reconnectingSurfaceSubsystemUnit = contribution({
  id: 'studio/reconnecting-surface-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { functional: { surfaces: SurfaceManagerToken } },
  create: ({ surfaces }) => {
    let handle: SurfaceHandle | undefined;
    let paused = false;
    return defineSubsystem({
      id: 'messaging/reconnecting',
      start: () => undefined,
      pause: (ctx) => {
        paused = true;
        // Not awaited: pausing never waits for the surfaces chunk.
        void surfaces.get(ctx.signal).then((manager) => {
          if (manager.ok && paused) handle = manager.value.request(ReconnectingDialog, { owner: { scope: ctx.scope, level: 'app' } });
        });
      },
      resume: () => {
        paused = false;
        handle?.dismiss('programmatic');
        handle = undefined;
      },
      description: 'Shows "Reconnecting…" while the app is paused.',
    });
  },
});
