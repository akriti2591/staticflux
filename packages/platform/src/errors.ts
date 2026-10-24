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

export const IsolationRequiredError = defineError(
  'SF-PLAT-006',
  'unavailable',
  'The app declares `isolation: "required"` but the page is not cross-origin isolated.',
  'Serve every document with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`); on static hosts add the @staticflux/pwa COOP/COEP service worker plugin (one reload on first visit); or declare `isolation: "preferred"` so shared-memory paths fall back to transfer.',
);

export const CoepViolationError = defineError(
  'SF-PLAT-007',
  'forbidden',
  'A subresource was blocked (or would be) by Cross-Origin-Embedder-Policy.',
  'Load it through the IsolationPolicy (adds `crossorigin` / `mode: "cors"`) and make the server send CORS headers, or serve it with `Cross-Origin-Resource-Policy: cross-origin`; for third-party iframes use the `credentialless` attribute (`policy.iframeAttrs(url)`).',
);

export const CoopViolationError = defineError(
  'SF-PLAT-008',
  'forbidden',
  'Cross-Origin-Opener-Policy severed (or would sever) an opener relationship.',
  'Popups that need `window.opener` (OAuth, payments) must use `postMessage` via a same-origin relay or `BroadcastChannel`; or serve the popup flow with `Cross-Origin-Opener-Policy: same-origin-allow-popups` (not isolated).',
);
