/**
 * Guest identity: a stable anonymous id (persisted when storage allows, in memory
 * otherwise) and the `guest` provider for apps or modes without login (R6.3).
 */
import { type Result, err, ok } from '@staticflux/core';
import type { IdentityProvider } from './contract.js';
import type { AuthEnvironment } from './environment.js';
import { NotAuthenticatedError, ProviderUnsupportedError } from './errors.js';
import { base64UrlEncode } from './pkce.js';

export const GUEST_ID_STORAGE_KEY = 'sf-auth/guest-id';

/** Read the stable guest id, creating (and persisting, if possible) one on first use. */
export function stableGuestId(env: Pick<AuthEnvironment, 'persistentStorage' | 'randomBytes' | 'now'>): string {
  const existing = env.persistentStorage?.get(GUEST_ID_STORAGE_KEY);
  if (existing !== undefined && existing.length > 0) return existing;
  const entropy =
    env.randomBytes === undefined
      ? `${env.now().toString(36)}${Math.random().toString(36).slice(2)}`
      : base64UrlEncode(env.randomBytes(16));
  const id = `guest-${entropy}`;
  env.persistentStorage?.set(GUEST_ID_STORAGE_KEY, id);
  return id;
}

/** A provider that never authenticates: everyone is a guest. */
export function guestProvider(): IdentityProvider {
  return {
    kind: 'guest',
    id: 'auth/guest',
    capabilities: { refresh: false, interactive: false, embedded: false, redirect: false },
    restore: () => Promise.resolve(ok(undefined)),
    login: () =>
      Promise.resolve(
        err(ProviderUnsupportedError({ message: 'The guest provider cannot log in. Bind a real identity provider for this mode.' })),
      ),
    logout: () => Promise.resolve(ok()),
    grant: (): Promise<Result<never>> => Promise.resolve(err(NotAuthenticatedError())),
  };
}
