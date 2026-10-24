/**
 * `passkey` — WebAuthn login behind feature detection. The server issues options,
 * the browser signs, the server verifies and sets a session cookie; afterwards the
 * session behaves like `bff-cookie` (no tokens in the client).
 *
 * Not for embedded iframes: cross-origin WebAuthn needs a host permission policy
 * that hosts like ChatGPT are unlikely to grant — bind `embed-host` there instead.
 */
import { type Result, err, ok } from '@staticflux/core';
import type { IdentityProvider, LoginOutcome, ProviderGrant } from '../contract.js';
import { PasskeyCancelledError, ProviderUnsupportedError, RefreshUnavailableError } from '../errors.js';
import { base64UrlDecode, base64UrlEncode } from '../pkce.js';
import { type AuthTransport, isRecord, requestJson } from '../transport.js';
import { type CsrfOptions, type SessionParser, csrfHeaders, defaultSessionParser, fetchSession, toCredentials } from './cookie-session.js';

/** WebAuthn port: JSON in, JSON out. `browserWebAuthn()` adapts `navigator.credentials`. */
export interface WebAuthnPort {
  readonly supported: boolean;
  conditionalMediationAvailable(): Promise<boolean>;
  /** `options` = server JSON (PublicKeyCredentialRequestOptionsJSON). Returns the assertion as JSON. */
  get(options: Readonly<Record<string, unknown>>, init: { signal: AbortSignal; mediation?: 'conditional' | 'optional' }): Promise<Result<unknown>>;
  /** `options` = server JSON (PublicKeyCredentialCreationOptionsJSON). Returns the attestation as JSON. */
  create(options: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Result<unknown>>;
}

export interface PasskeyEndpoints {
  /** POST → request options JSON (challenge, allowCredentials, …). */
  readonly options: string;
  /** POST assertion JSON → session JSON (sets cookie). */
  readonly verify: string;
  readonly session: string;
  readonly logout: string;
  readonly registerOptions?: string;
  readonly registerVerify?: string;
}

export interface PasskeyOptions {
  readonly transport: AuthTransport;
  readonly webauthn: WebAuthnPort;
  readonly endpoints: PasskeyEndpoints;
  readonly csrf?: CsrfOptions;
  readonly parseSession?: SessionParser;
}

// ---------------------------------------------------------------- JSON <-> binary (fallback when native helpers are missing)

type Json = Readonly<Record<string, unknown>>;

const toBuffer = (value: unknown): ArrayBuffer => {
  const bytes = base64UrlDecode(typeof value === 'string' ? value : '');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const mapDescriptors = (list: unknown): PublicKeyCredentialDescriptor[] | undefined =>
  Array.isArray(list)
    ? list.filter(isRecord).map((d) => ({ ...(d as object), type: 'public-key', id: toBuffer(d['id']) }) as PublicKeyCredentialDescriptor)
    : undefined;

/** PublicKeyCredentialRequestOptionsJSON → PublicKeyCredentialRequestOptions. */
export function requestOptionsFromJson(json: Json): PublicKeyCredentialRequestOptions {
  const allow = mapDescriptors(json['allowCredentials']);
  return {
    ...(json as object),
    challenge: toBuffer(json['challenge']),
    ...(allow === undefined ? {} : { allowCredentials: allow }),
  } as PublicKeyCredentialRequestOptions;
}

/** PublicKeyCredentialCreationOptionsJSON → PublicKeyCredentialCreationOptions. */
export function creationOptionsFromJson(json: Json): PublicKeyCredentialCreationOptions {
  const user = isRecord(json['user']) ? json['user'] : {};
  const exclude = mapDescriptors(json['excludeCredentials']);
  return {
    ...(json as object),
    challenge: toBuffer(json['challenge']),
    user: { ...(user as object), id: toBuffer(user['id']) },
    ...(exclude === undefined ? {} : { excludeCredentials: exclude }),
  } as PublicKeyCredentialCreationOptions;
}

const encode = (value: unknown): string | undefined =>
  value instanceof ArrayBuffer ? base64UrlEncode(new Uint8Array(value)) : ArrayBuffer.isView(value) ? base64UrlEncode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) : undefined;

/** Serialize a PublicKeyCredential (fallback for `credential.toJSON()`). */
export function credentialToJson(credential: {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  readonly response: Readonly<Record<string, unknown>>;
  readonly authenticatorAttachment?: string | null;
}): Json {
  const response: Record<string, unknown> = {};
  for (const key of ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle', 'attestationObject']) {
    const encoded = encode(credential.response[key]);
    if (encoded !== undefined) response[key] = encoded;
  }
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: credential.type,
    response,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    clientExtensionResults: {},
  };
}

interface PkcStatic {
  parseRequestOptionsFromJSON?(json: unknown): PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?(json: unknown): PublicKeyCredentialCreationOptions;
  isConditionalMediationAvailable?(): Promise<boolean>;
}

/** Feature detection for passkeys (PublicKeyCredential + navigator.credentials). */
export function isPasskeySupported(
  scope: { PublicKeyCredential?: unknown; navigator?: { credentials?: unknown } } = globalThis as never,
): boolean {
  return typeof scope.PublicKeyCredential === 'function' && typeof scope.navigator?.credentials === 'object' && scope.navigator.credentials !== null;
}

const mapCeremonyError = (cause: unknown): Result<never> => {
  const name = isRecord(cause) || cause instanceof Error ? (cause as { name?: unknown }).name : undefined;
  if (name === 'NotAllowedError' || name === 'AbortError') return err(PasskeyCancelledError({ cause }));
  return err(ProviderUnsupportedError({ cause, message: 'The WebAuthn ceremony failed.' }));
};

/** Adapt the browser WebAuthn API. Uses native JSON helpers when present (WebAuthn L3), else manual conversion. */
export function browserWebAuthn(
  scope: { PublicKeyCredential?: unknown; navigator?: { credentials?: CredentialsContainer } } = globalThis as never,
): WebAuthnPort {
  const supported = isPasskeySupported(scope);
  const pkc = scope.PublicKeyCredential as PkcStatic | undefined;
  const container = scope.navigator?.credentials;
  const serialize = (credential: Credential | null): unknown => {
    if (credential === null) return undefined;
    const withJson = credential as Credential & { toJSON?: () => unknown };
    return typeof withJson.toJSON === 'function' ? withJson.toJSON() : credentialToJson(credential as never);
  };
  return {
    supported,
    async conditionalMediationAvailable() {
      try {
        return supported && (await pkc?.isConditionalMediationAvailable?.()) === true;
      } catch {
        return false;
      }
    },
    async get(options, init) {
      if (!supported || container === undefined) return err(ProviderUnsupportedError({ message: 'Passkeys are not supported here.' }));
      try {
        const publicKey = pkc?.parseRequestOptionsFromJSON?.(options) ?? requestOptionsFromJson(options);
        const credential = await container.get({ publicKey, signal: init.signal, ...(init.mediation === undefined ? {} : { mediation: init.mediation }) });
        const json = serialize(credential);
        return json === undefined ? err(PasskeyCancelledError()) : ok(json);
      } catch (cause) {
        return mapCeremonyError(cause);
      }
    },
    async create(options, signal) {
      if (!supported || container === undefined) return err(ProviderUnsupportedError({ message: 'Passkeys are not supported here.' }));
      try {
        const publicKey = pkc?.parseCreationOptionsFromJSON?.(options) ?? creationOptionsFromJson(options);
        const json = serialize(await container.create({ publicKey, signal }));
        return json === undefined ? err(PasskeyCancelledError()) : ok(json);
      } catch (cause) {
        return mapCeremonyError(cause);
      }
    },
  };
}

export interface PasskeyProvider extends IdentityProvider {
  /** Register a new passkey for the current (or new) account. */
  register(signal: AbortSignal): Promise<Result<void>>;
}

export function passkeyProvider(options: PasskeyOptions): PasskeyProvider {
  const { transport, endpoints, webauthn } = options;
  const parse = options.parseSession ?? defaultSessionParser;
  let csrfToken: string | undefined;
  const unsupported = (): Result<never> =>
    err(ProviderUnsupportedError({ message: 'Passkeys are not supported in this browser/host. Offer another provider.' }));

  return {
    kind: 'passkey',
    id: 'auth/passkey',
    capabilities: { refresh: true, interactive: true, embedded: false, redirect: false },
    async restore(signal) {
      const info = await fetchSession(transport, endpoints.session, parse, signal);
      if (!info.ok) return info;
      csrfToken = info.value?.csrfToken ?? csrfToken;
      return ok(info.value === undefined ? undefined : toCredentials(info.value));
    },
    async login(request, signal): Promise<Result<LoginOutcome>> {
      if (!webauthn.supported) return unsupported();
      const challenge = await requestJson(transport, { url: endpoints.options, method: 'POST', credentials: 'include', signal });
      if (!challenge.ok) return challenge;
      if (!isRecord(challenge.value)) return err(ProviderUnsupportedError({ message: 'Passkey options endpoint returned no options.' }));
      const assertion = await webauthn.get(challenge.value, { signal, ...(request.mediation === undefined ? {} : { mediation: request.mediation }) });
      if (!assertion.ok) return assertion;
      const verified = await requestJson(transport, {
        url: endpoints.verify,
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assertion.value),
        signal,
      });
      if (!verified.ok) return verified;
      const info = parse(verified.value);
      if (!info.ok) return info;
      if (info.value === undefined) return err(PasskeyCancelledError({ message: 'The server rejected the passkey assertion.' }));
      csrfToken = info.value.csrfToken ?? csrfToken;
      return ok({ kind: 'authenticated', credentials: toCredentials(info.value) });
    },
    async register(signal) {
      if (!webauthn.supported || endpoints.registerOptions === undefined || endpoints.registerVerify === undefined) return unsupported();
      const creation = await requestJson(transport, { url: endpoints.registerOptions, method: 'POST', credentials: 'include', headers: csrfHeaders(options.csrf, csrfToken), signal });
      if (!creation.ok) return creation;
      if (!isRecord(creation.value)) return unsupported();
      const attestation = await webauthn.create(creation.value, signal);
      if (!attestation.ok) return attestation;
      const verified = await requestJson(transport, {
        url: endpoints.registerVerify,
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders(options.csrf, csrfToken) },
        body: JSON.stringify(attestation.value),
        signal,
      });
      return verified.ok ? ok() : verified;
    },
    async refresh(_current, signal) {
      const info = await fetchSession(transport, endpoints.session, parse, signal);
      if (!info.ok) return info;
      if (info.value === undefined) return err(RefreshUnavailableError({ message: 'The passkey session ended.' }));
      csrfToken = info.value.csrfToken ?? csrfToken;
      return ok(toCredentials(info.value));
    },
    async logout(_current, signal) {
      const result = await requestJson(transport, { url: endpoints.logout, method: 'POST', credentials: 'include', headers: csrfHeaders(options.csrf, csrfToken), signal });
      csrfToken = undefined;
      return result.ok ? ok() : result;
    },
    clear() {
      csrfToken = undefined;
    },
    grant(): Promise<Result<ProviderGrant>> {
      return Promise.resolve(ok({ scheme: 'cookie', headers: csrfHeaders(options.csrf, csrfToken) }));
    },
  };
}
