/**
 * Confirmation for WebMCP tool calls. WebMCP clients may expose
 * `requestUserInteraction(cb)` so a page can show UI during a tool call.
 * This wraps the app's confirm port (e.g. a messaging dialog) so that, for
 * calls arriving through WebMCP, the dialog runs inside that interaction.
 * Other channels pass straight through.
 */
import { attemptAsync, type Result } from '@staticflux/core';
import type { CapabilityConfirmPort } from '@staticflux/capabilities';
import { WEBMCP_CHANNEL, type WebMcpOriginDetails } from './publisher.js';

export function webMcpConfirmPort(inner: CapabilityConfirmPort): CapabilityConfirmPort {
  return {
    async confirm(request, signal) {
      const details = request.origin?.channel === WEBMCP_CHANNEL ? (request.origin.details as WebMcpOriginDetails | undefined) : undefined;
      const interact = details?.client?.requestUserInteraction;
      if (details?.client === undefined || typeof interact !== 'function') return inner.confirm(request, signal);
      const outcome = await attemptAsync(() => interact.call(details.client, () => inner.confirm(request, signal)));
      return outcome.ok ? (outcome.value as Result<boolean>) : outcome;
    },
  };
}
