import { defineError } from '@staticflux/core';

export const ServiceWorkerUnsupportedError = defineError(
  'SF-PWA-001',
  'unavailable',
  'Service workers are not available here (unsupported browser, insecure context, or an embedded host mode).',
  'Expected in embedded/webview modes and on http://; the app keeps working without offline support. Gate PWA-only features on `updater.supported`.',
);

export const ServiceWorkerRegistrationError = defineError(
  'SF-PWA-002',
  'unavailable',
  'Registering the service worker failed.',
  'Check that the SW script URL is same-origin, served with a JavaScript MIME type, and inside the requested scope (or send `Service-Worker-Allowed`).',
);

export const PrecacheInstallError = defineError(
  'SF-PWA-003',
  'network',
  'Precaching the critical tier failed; the new service worker was not installed (the previous version stays active).',
  'Check that every critical-tier file in sf-manifest.json is deployed and returns 200; the browser retries the install on the next update check.',
);

export const UpdateActivationTimeoutError = defineError(
  'SF-PWA-004',
  'timeout',
  'The waiting service worker did not take control in time after skipWaiting.',
  'Make sure the SW runtime handles the `sf-pwa/skip-waiting` message (createServiceWorkerRuntime does); the update is retried on the next check.',
);

export const NoUpdateWaitingError = defineError(
  'SF-PWA-005',
  'invariant',
  'accept() was called but no updated service worker is waiting.',
  'Only call accept() while `updater.state === "available"` (after the update-available event).',
);

export const ReinitializeFailedError = defineError(
  'SF-PWA-006',
  'unavailable',
  'Reinitializing the app after a service worker update failed; the page was reloaded instead.',
  'Inspect the cause from the runtime supervisor; subsystems must tolerate `reinitialize` (stop → start).',
);

export const InvalidWebAppManifestError = defineError(
  'SF-PWA-007',
  'validation',
  'The web app manifest declaration is invalid.',
  'Fix the field named in `details.field` (see https://www.w3.org/TR/appmanifest/); URLs must stay within `scope`.',
);

export const NonIdempotentMutationError = defineError(
  'SF-PWA-008',
  'validation',
  'A non-idempotent mutation cannot be queued for background replay.',
  'Only declare `idempotent: true` for requests that are safe to repeat (PUT/DELETE with an idempotency key); other mutations must fail while offline (R4.6).',
);

export const IsolationReloadFailedError = defineError(
  'SF-PWA-009',
  'unavailable',
  'The page is still not cross-origin isolated after the COOP/COEP service worker reload.',
  'The host or a browser extension strips the headers, the page was hard-reloaded (bypasses the SW), or the page is embedded. Serve COOP/COEP from the host, or use `isolation: "preferred"`.',
);

export const SwMessageTimeoutError = defineError(
  'SF-PWA-010',
  'timeout',
  'The service worker did not answer a message in time.',
  'Check that the active SW was built with createServiceWorkerRuntime and the matching plugin; the caller falls back to the non-SW path.',
);

export const ShareTargetPayloadError = defineError(
  'SF-PWA-011',
  'not-found',
  'The shared payload referenced by the URL was not found (already consumed or expired).',
  'Share payloads are consume-once; re-share from the source app.',
);
