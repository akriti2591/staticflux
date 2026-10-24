/**
 * Error catalog for @staticflux/auth. Codes are stable (`SF-AUTH-NNN`); look them up
 * in docs/errors.json instead of guessing.
 */
import { defineError } from '@staticflux/core';

export const NotAuthenticatedError = defineError(
  'SF-AUTH-001',
  'auth',
  'The operation needs an authenticated session, but the session is not authenticated.',
  'Check `session.isAuthenticated` (or wait with `session.whenSettled()`) before calling; route through the login flow when the user is a guest.',
);

export const UnauthorizedResponseError = defineError(
  'SF-AUTH-002',
  'auth',
  'The backend answered 401 Unauthorized.',
  'The session or token is no longer valid. The session store refreshes once (single-flight); if that fails the session expires and the user must log in.',
);

export const ForbiddenResponseError = defineError(
  'SF-AUTH-003',
  'forbidden',
  'The backend answered 403 Forbidden.',
  'Feed the revocation into gate facts (R6.14). Do not retry; show the denied state.',
);

export const AuthNetworkError = defineError(
  'SF-AUTH-004',
  'network',
  'An auth request failed at the network level.',
  'Usually transient (offline, DNS, CORS). The session keeps its last known state; retry later.',
);

export const AuthServerUnavailableError = defineError(
  'SF-AUTH-005',
  'unavailable',
  'The auth backend answered with a 5xx status.',
  'Transient: retry with backoff. Do not log the user out because of a 5xx.',
);

export const InvalidAuthResponseError = defineError(
  'SF-AUTH-006',
  'validation',
  'An auth endpoint returned a body that does not match the expected shape.',
  'Check the endpoint contract (session JSON / token response) or pass a custom `parseSession` to the provider.',
);

export const CallbackStateMismatchError = defineError(
  'SF-AUTH-007',
  'validation',
  'The OAuth callback `state` does not match any pending login started by this browser.',
  'Possible CSRF or a stale/duplicated callback tab. Start a new login; never accept a callback without a matching state.',
);

export const CallbackError = defineError(
  'SF-AUTH-008',
  'auth',
  'The authorization server returned an error to the callback (e.g. access_denied).',
  'Show the error to the user and offer to retry login. `details.error` holds the OAuth error code.',
);

export const ProviderUnsupportedError = defineError(
  'SF-AUTH-009',
  'unavailable',
  'The identity provider cannot perform this operation in this environment.',
  'Feature-detect first (e.g. `isPasskeySupported()`), or bind a different provider for this platform/host mode.',
);

export const RefreshUnavailableError = defineError(
  'SF-AUTH-010',
  'auth',
  'The session cannot be refreshed (no refresh capability or no refresh token).',
  'The user must log in again. For oidc-pkce the refresh token lives only in memory and is lost on reload by design.',
);

export const SessionExpiredError = defineError(
  'SF-AUTH-011',
  'auth',
  'The session has expired.',
  'Call `session.login()` to re-authenticate; the deep-link intent is kept via `returnTo`.',
);

export const SessionRevokedError = defineError(
  'SF-AUTH-012',
  'auth',
  'The session was revoked (server push, 403, or another tab).',
  'Log in again. Revocation is final for this session; do not retry the failed call.',
);

export const CryptoUnavailableError = defineError(
  'SF-AUTH-013',
  'unavailable',
  'WebCrypto (crypto.subtle / getRandomValues) is not available.',
  'PKCE requires a secure context (https or localhost). Use the bff-cookie provider where WebCrypto is unavailable.',
);

export const HostBridgeError = defineError(
  'SF-AUTH-014',
  'unavailable',
  'The embedding host bridge failed or is not present.',
  'Check host detection (window.openai / MCP Apps bridge). In embedded mode the host owns OAuth; the widget never holds tokens.',
);

export const AuthRateLimitedError = defineError(
  'SF-AUTH-015',
  'rate',
  'The auth backend answered 429 Too Many Requests.',
  'Back off; the single-flight refresh should prevent bursts — check for refresh loops.',
);

export const PasskeyCancelledError = defineError(
  'SF-AUTH-016',
  'aborted',
  'The passkey ceremony was cancelled or not allowed by the user agent.',
  'Expected when the user dismisses the prompt. Offer another login method; do not retry automatically.',
);

export const LoginInProgressError = defineError(
  'SF-AUTH-017',
  'conflict',
  'A login is already in progress.',
  'Await the pending login (or `session.whenSettled()`) instead of starting another.',
);
