import { defineError } from '@staticflux/core';

export const UnknownModeOverrideError = defineError(
  'SF-PLAT-001',
  'validation',
  'A forced host mode or form factor is not registered.',
  'Use one of the registered ids (see `profile.hostModes` / `profile.formFactors`), or register the host mode / form factor plugin first.',
);

export const DuplicateHostModeError = defineError(
  'SF-PLAT-002',
  'invariant',
  'Two host mode definitions use the same id.',
  'Give each `defineHostMode({ id })` a unique id; to replace a built-in, leave the built-in out of the host mode list.',
);

export const AiProbeFailedError = defineError(
  'SF-PLAT-003',
  'unavailable',
  'Probing built-in AI availability failed or timed out.',
  'Treat AI as unavailable for now; call `facts.probeAi()` again later (e.g. after the model download finishes).',
);

export const NoHostBridgeError = defineError(
  'SF-PLAT-004',
  'unavailable',
  'The current host mode does not provide a host bridge.',
  'Only embedded/webview host modes have bridges. Gate the feature on `profile.hostMode.bridge !== undefined`, or add `bridge` to the host mode definition.',
);

export const HostBridgeLoadError = defineError(
  'SF-PLAT-005',
  'unavailable',
  'The host bridge failed to load.',
  'Check the bridge chunk and the host handshake; the app should continue in degraded mode without host features.',
);
