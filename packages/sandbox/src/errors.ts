/**
 * Error catalog for @staticflux/sandbox (`SF-SBX-*`). Every error has a stable
 * code and a concrete fix. Client gating is UX, not security (R6.16): the
 * server still re-checks every request a capability implementation makes.
 */
import { defineError } from '@staticflux/core';

export const ManifestInvalidError = defineError(
  'SF-SBX-001',
  'validation',
  'The plugin manifest is invalid (id, version, entry, capabilities, events, permissions or limits).',
  'Fix the field named in `details.issues`. Ids are namespaced (`vendor/name`), versions are semver, iframe entries are https/relative URLs or inline code.',
);

export const CapabilityNotGrantedError = defineError(
  'SF-SBX-002',
  'forbidden',
  'The plugin called a capability it has not been granted.',
  'Request the capability in the plugin manifest and have the host grant it (`plugin.grant(capability)`). Revoked grants fail immediately.',
);

export const PayloadTooLargeError = defineError(
  'SF-SBX-003',
  'validation',
  'A message from the plugin exceeded the payload size limit and was dropped.',
  'Send smaller messages (page or stream data through several calls), or raise `limits.maxPayloadBytes` in the manifest within the host ceiling.',
);

export const PluginRateLimitedError = defineError(
  'SF-SBX-004',
  'rate',
  'The plugin sent messages faster than its rate limit; the message was dropped.',
  'Batch work into fewer calls, or raise `limits.maxMessagesPerSecond` within the host ceiling.',
);

export const PluginCallTimeoutError = defineError(
  'SF-SBX-005',
  'timeout',
  'A plugin call did not finish within the call timeout and was cancelled.',
  'Make the capability cheaper, or raise `limits.callTimeoutMs` within the host ceiling.',
);

export const PluginNotRunningError = defineError(
  'SF-SBX-006',
  'unavailable',
  'The plugin is not running (loading, restarting, killed, failed or stopped).',
  'Wait for `plugin.whenRunning()`, or check `plugin.state` before emitting events to it.',
);

export const PluginFailedError = defineError(
  'SF-SBX-007',
  'unavailable',
  'The plugin crashed too often and was given up (restart intensity exceeded).',
  'Inspect the crash causes in `sandbox/host` telemetry; call `plugin.restart()` after fixing the plugin.',
);

export const PluginHandshakeError = defineError(
  'SF-SBX-008',
  'timeout',
  'The plugin did not complete the handshake in time (or identified itself with a different id).',
  'The plugin entry must call `connectToHost({ pluginId })` with the manifest id on load; check the entry URL and the CSP.',
);

export const EventNotDeclaredError = defineError(
  'SF-SBX-009',
  'forbidden',
  'The event is not declared in the plugin manifest (or not offered by the host).',
  'Add the event id to `manifest.events` and to the host `events` list; plugins only receive declared events.',
);

export const SandboxUnsupportedError = defineError(
  'SF-SBX-010',
  'unavailable',
  'The isolated realm for this plugin entry is not available here (no DOM/iframe, no Worker, or no realm registered for the entry kind).',
  'Register a realm for the entry kind (`realms: { iframe: iframeRealm(), worker: workerRealm(...) }`) or run the plugin where it is supported.',
);

export const PluginKilledError = defineError(
  'SF-SBX-011',
  'aborted',
  'The plugin was killed (kill switch, too many violations, or `plugin.kill()`).',
  'Expected after a kill. Call `plugin.restart()` once the cause is resolved; an engaged kill switch refuses every load.',
);

export const PluginPermissionError = defineError(
  'SF-SBX-012',
  'forbidden',
  'The plugin used a permission it does not hold (e.g. `resize` without the permission).',
  'Add the permission to `manifest.permissions`; the host decides whether to load plugins that request it.',
);
