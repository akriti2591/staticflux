/**
 * Adapter: @staticflux/auth → @staticflux/gate. Session state and the advisory BFF
 * claims (plan, entitlements) become gate facts through the fact-source port —
 * gate never imports auth. Client gating is UX, not security (R6.16).
 */
import { contribution } from '@staticflux/core';
import { SessionToken, type SessionStore } from '@staticflux/auth';
import { FactSourcesToken, GateFacts, reactiveFactSource, sessionFactSource } from '@staticflux/gate';

function claim<T>(session: SessionStore, key: string, guard: (v: unknown) => v is T): T | undefined {
  const value = session.principal?.claims?.[key];
  return guard(value) ? value : undefined;
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isStringList = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export const sessionFactsUnit = contribution({
  id: 'studio/session-facts-unit',
  provides: FactSourcesToken,
  scope: 'app',
  deps: { required: { session: SessionToken } },
  create: ({ session }, ctx) =>
    sessionFactSource(
      () => ({ authenticated: session.isAuthenticated, userId: session.principal?.id, roles: session.principal?.roles }),
      ctx.scope,
    ),
  description: 'session/authenticated, session/user-id, session/roles, gate/subject-kind.',
});

export const claimFactsUnit = contribution({
  id: 'studio/claim-facts-unit',
  provides: FactSourcesToken,
  scope: 'app',
  deps: { required: { session: SessionToken } },
  create: ({ session }, ctx) =>
    reactiveFactSource(
      'studio/claim-facts',
      [
        { fact: GateFacts.plan, read: () => (session.isAuthenticated ? (claim(session, 'plan', isString) ?? 'free') : undefined) },
        { fact: GateFacts.entitlements, read: () => (session.isAuthenticated ? (claim(session, 'entitlements', isStringList) ?? []) : []) },
      ],
      ctx.scope,
    ),
  description: 'billing/plan and billing/entitlements from the BFF session claims (advisory).',
});
