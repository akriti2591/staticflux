/**
 * Adapter: @staticflux/capabilities confirm port → @staticflux/messaging dialog.
 * Destructive agent actions (and policy-flagged ones) ask the user first (R6.17);
 * a dismissed or declined dialog is `ok(false)`. Stacks above any open modal.
 */
import { ok, unit } from '@staticflux/core';
import { type CapabilityConfirmPort, CapabilityConfirmPortToken } from '@staticflux/capabilities';
import { SurfaceManagerToken } from '@staticflux/messaging';
import { ConfirmDialog } from '../app/surfaces.js';

export const confirmPortUnit = unit({
  id: 'studio/confirm-port-unit',
  provides: CapabilityConfirmPortToken,
  scope: 'app',
  deps: { required: { surfaces: SurfaceManagerToken } },
  create: ({ surfaces }, ctx): CapabilityConfirmPort => ({
    async confirm(request, signal) {
      const who = request.subject === 'agent' ? 'The assistant wants to' : 'You are about to';
      const handle = surfaces.request(ConfirmDialog, {
        owner: { scope: ctx.scope, level: 'app' },
        props: { title: request.capability.title, message: `${who} run “${request.capability.title}”. ${request.capability.description}` },
        stack: true,
        signal,
      });
      const outcome = await handle.closed;
      return ok(outcome.state === 'dismissed' && outcome.result === true);
    },
  }),
  description: 'Capability confirmations as a stacked messaging dialog.',
});
