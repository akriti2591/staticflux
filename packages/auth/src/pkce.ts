/**
 * PKCE (RFC 7636) with WebCrypto only — no external libraries.
 * Also base64url helpers shared by the oidc and passkey providers.
 */
import { type Result, err, ok } from '@staticflux/core';
import { CryptoUnavailableError } from './errors.js';

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Random base64url string from `byteLength` random bytes. */
export function randomUrlSafe(randomBytes: ((n: number) => Uint8Array) | undefined, byteLength = 32): Result<string> {
  if (randomBytes === undefined) return err(CryptoUnavailableError({ message: 'crypto.getRandomValues is unavailable.' }));
  return ok(base64UrlEncode(randomBytes(byteLength)));
}

/** S256 code challenge for a verifier: base64url(SHA-256(ascii(verifier))). */
export async function pkceChallenge(
  verifier: string,
  subtle: Pick<SubtleCrypto, 'digest'> | undefined,
): Promise<Result<string>> {
  if (subtle === undefined) return err(CryptoUnavailableError({ message: 'crypto.subtle is unavailable (insecure context?).' }));
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return ok(base64UrlEncode(new Uint8Array(digest)));
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

/** A fresh verifier (43 chars from 32 random bytes) and its S256 challenge. */
export async function createPkcePair(
  randomBytes: ((n: number) => Uint8Array) | undefined,
  subtle: Pick<SubtleCrypto, 'digest'> | undefined,
): Promise<Result<PkcePair>> {
  const verifier = randomUrlSafe(randomBytes, 32);
  if (!verifier.ok) return verifier;
  const challenge = await pkceChallenge(verifier.value, subtle);
  if (!challenge.ok) return challenge;
  return ok({ verifier: verifier.value, challenge: challenge.value, method: 'S256' });
}

/**
 * Decode a JWT payload WITHOUT verifying it. Advisory only (R6.7): use it to show a
 * name in the UI, never to authorize. Returns undefined for malformed input.
 */
export function decodeJwtPayload(jwt: string): Readonly<Record<string, unknown>> | undefined {
  const part = jwt.split('.')[1];
  if (part === undefined) return undefined;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(part));
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
