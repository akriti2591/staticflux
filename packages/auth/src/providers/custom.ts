/**
 * `custom` — a hand-rolled provider. Supply the operations you have; the rest get
 * safe defaults (no refresh, local logout, `none` grant scheme).
 */
import { ok } from '@staticflux/core';
import type { IdentityProvider, ProviderCapabilities } from '../contract.js';

export type CustomProviderDefinition = Pick<IdentityProvider, 'restore' | 'login'> &
  Partial<Omit<IdentityProvider, 'kind' | 'restore' | 'login' | 'capabilities'>> & {
    readonly capabilities?: Partial<ProviderCapabilities>;
  };

export function customProvider(definition: CustomProviderDefinition): IdentityProvider {
  const capabilities: ProviderCapabilities = {
    refresh: definition.refresh !== undefined,
    interactive: true,
    embedded: false,
    redirect: definition.handleCallback !== undefined,
    ...definition.capabilities,
  };
  return {
    ...definition,
    kind: 'custom',
    id: definition.id ?? 'auth/custom',
    capabilities,
    logout: definition.logout ?? (() => Promise.resolve(ok())),
    grant: definition.grant ?? (() => Promise.resolve(ok({ scheme: 'none', headers: {} }))),
  };
}
