/**
 * @staticflux/auth — identity providers, session lifecycle, multi-tab sync,
 * single-flight refresh, token broker.
 *
 * Client-side auth state is UX, not security (R6.7, R6.16): the backend validates
 * and re-checks every request.
 */
export * from './contract.js';
export * from './errors.js';
export * from './machine.js';
export * from './transport.js';
export * from './environment.js';
export * from './pkce.js';
export * from './guest.js';
export * from './session.js';
export * from './broker.js';
export * from './session-scope.js';
export * from './units.js';
export { bffCookieProvider, type BffCookieEndpoints, type BffCookieOptions } from './providers/bff-cookie.js';
export { defaultSessionParser, type CsrfOptions, type SessionInfo, type SessionParser } from './providers/cookie-session.js';
export { oidcPkceProvider, parseCallbackUrl, defaultPrincipalFromClaims, type OidcPkceOptions } from './providers/oidc-pkce.js';
export { customProvider, type CustomProviderDefinition } from './providers/custom.js';
export { embedHostProvider, type AuthHostBridge, type HostIdentity } from './providers/embed-host.js';
export {
  passkeyProvider,
  browserWebAuthn,
  isPasskeySupported,
  requestOptionsFromJson,
  creationOptionsFromJson,
  credentialToJson,
  type PasskeyEndpoints,
  type PasskeyOptions,
  type PasskeyProvider,
  type WebAuthnPort,
} from './providers/passkey.js';
